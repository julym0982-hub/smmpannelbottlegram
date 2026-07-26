require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const { Platform, User, Category, Service, Order, Coupon } = require('./models');
const providers = require('./providers');
const texts = require('./texts');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI;
const KPAY_NUMBER = process.env.KPAY_NUMBER || '09xxxxxxxxx';
const KPAY_NAME = process.env.KPAY_NAME || 'Your Name';
const WAVE_NUMBER = process.env.WAVE_NUMBER || '09xxxxxxxxx';
const WAVE_NAME = process.env.WAVE_NAME || 'Your Name';

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }
if (!MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(1); }

// Don't let one unexpected rejected promise (e.g. a transient Telegram API
// blip) crash the entire bot process - just log it and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (bot keeps running):', reason && reason.message || reason);
});

const bot = new Telegraf(BOT_TOKEN);

// ---------------------------------------------------------------------
// in-memory per-user conversation state (NOT persisted - orders/users/
// services all live in MongoDB, this is just "where is this chat right now")
// ---------------------------------------------------------------------
const state = {};
function st(id) { if (!state[id]) state[id] = { level: 'root' }; return state[id]; }
function resetState(id) { state[id] = { level: 'root' }; }

function isAdmin(id) { return ADMIN_IDS.includes(String(id)); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------
// keyboards
// ---------------------------------------------------------------------
const BTN_SERVICES = '❤️ရရှိနိုင်သောservice များ❤️';
const BTN_BALANCE = '💰လက်ကျန်ငွေ💰';
const BTN_TOPUP = '💰ငွေဖြည့်ရန်💰';
const BTN_HISTORY = '📜Order History📜';
const BTN_COUPON = 'Cupon⁉️';
const BTN_BACK = '◀️ နောက်ပြန်ဆုတ်ရန်';

function mainMenuKeyboard() {
  return Markup.keyboard([[BTN_SERVICES], [BTN_BALANCE], [BTN_TOPUP], [BTN_HISTORY], [BTN_COUPON]]).resize();
}
function topupMethodKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Kpay ဖြင့်ငွေသွင်းရန်', 'topup_kpay')],
    [Markup.button.callback('Wave ဖြင့်ငွေသွင်းရန်', 'topup_wave')]
  ]);
}

async function safeSend(chatId, text, extra) {
  try { await bot.telegram.sendMessage(chatId, text, extra); return true; }
  catch (err) {
    const desc = err && err.response && err.response.description;
    if (desc && /blocked|chat not found|deactivated/i.test(desc)) return false;
    console.error('safeSend error:', desc || err.message);
    return false;
  }
}

async function getOrCreateUser(from) {
  let u = await User.findById(String(from.id));
  if (!u) {
    u = await User.create({ _id: String(from.id), username: from.username || '', firstName: from.first_name || '' });
  } else {
    let changed = false;
    if (from.username && u.username !== from.username) { u.username = from.username; changed = true; }
    if (from.first_name && u.firstName !== from.first_name) { u.firstName = from.first_name; changed = true; }
    if (changed) await u.save();
  }
  return u;
}

// ---------------------------------------------------------------------
// middleware: load user, block banned, never crash on tg errors
// ---------------------------------------------------------------------
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      const u = await getOrCreateUser(ctx.from);
      if (u.banned && !isAdmin(ctx.from.id)) return ctx.reply(texts.t('banned'));
      ctx.dbUser = u;
    }
    await next();
  } catch (err) {
    console.error('Handler error:', err && err.stack || err);
  }
});

// =======================================================================
// /start
// =======================================================================
const ADMIN_HELP_TEXT = () => `👑 Admin Commands

--- Home button (Telegram Service/Tiktok Service/...) ---
/addhomebutton <key> <label...> - home button အသစ် ထည့်မည်
  ဥပမာ: /addhomebutton telegram Telegram Service
/removehomebutton <key> - home button ဖျက်မည် (category/service အားလုံးပါ ပါ ဖျက်မည်)
  ဥပမာ: /removehomebutton telegram

--- Service (category ထဲက emoji/button) ---
/addbutton <platform>|<category>|<button_label>|<provider>|<provider_service_id>
  တစ်ကြောင်းတည်းနဲ့ ချက်ချင်းထည့်ခြင်း (home button/category မရှိသေးရင် အလိုအလျောက် ဆောက်ပေးမည်)
  ဥပမာ: /addbutton telegram|Reaction တိုးရန်❤️|♥️|shweboost|1234
  ဥပမာ (category ထဲ service တစ်ခုတည်းရှိရင် sub-menu ကျော်၍ link တန်းမေးမည်):
        /addbutton telegram|Views တိုးရန်👀|-|shweboost|5678
/addid - အဆင့်ဆင့် မေးမြန်းပြီး ထည့်ချင်ရင် (wizard) - /addbutton ရေးနည်းမရင် သုံးပါ
/services - home button/category/service အားလုံး (id များပါ) ကြည့်မည် - debug
/removeid <serviceMongoId> - service တစ်ခု ဖျက်မည်
/removecategory <categoryMongoId> - category (service အားလုံးအပါအဝင်) ဖျက်မည်
/syncservices - provider API မှ rate/min/max အားလုံး ပြန် sync မည်
/testcost <serviceMongoId> <quantity> - ကုန်ကျငွေ တွက်ချက်ပုံ debug လုပ်မည်
/setduration <serviceMongoId> <text> - ကြာချိန် manual သတ်မှတ်မည် (ShweBoost API မှာ ကြာချိန် data လုံးဝမပါလာပါ)

--- User စီမံခန့်ခွဲမှု ---
/ban <id> | /unban <id>
/addmoney <id> <amount> | /decreasemoney <id> <amount>
/users [page] - user list (10/page), balance/spent/profile link ပါ
/userinfo <id> - user တစ်ဦးချင်း အသေးစိတ် + အော်ဒါမှတ်တမ်း
/totaluser

--- Order စီမံခန့်ခွဲမှု ---
/checkorders - အော်ဒါအားလုံး (နောက်ဆုံး 30)
/removeorder <orderMongoId> - အော်ဒါ မှတ်တမ်းမှ ဖျက်မည် (provider ဆီ ဖျက်ခြင်း မဟုတ်)
/providerbalance - Shweboost/Secsers ကျန်ရှိငွေ စစ်မည်

--- Message / Coupon ---
/sendmessage <id> [message]
/allsendmessage [message]
/cuponcode <amount> <count> [code]

--- Text အယ်ဒစ်လုပ်ရန် ---
/texts - ပြင်လို့ရသော message key များ ကြည့်မည်
/edittext <key> <new text with \${placeholders}>`;

bot.start(async (ctx) => {
  resetState(ctx.from.id);
  const name = ctx.from.first_name || ctx.from.username || 'User';
  await ctx.reply(texts.t('welcome', { name }), mainMenuKeyboard());
  if (isAdmin(ctx.from.id)) await ctx.reply(ADMIN_HELP_TEXT());
});

// =======================================================================
// Back button - context-aware based on state.level
// =======================================================================
bot.hears(BTN_BACK, async (ctx) => {
  const s = st(ctx.from.id);
  if (s.level === 'platform') {
    resetState(ctx.from.id);
    return ctx.reply('🏠 မူလ menu သို့ ပြန်သွားပါပြီရှင့်', mainMenuKeyboard());
  }
  if (s.level === 'category') {
    s.level = 'platform';
    return showPlatformMenu(ctx);
  }
  if (s.level === 'service') {
    s.level = 'category';
    return showCategoryMenu(ctx, s.platform);
  }
  // link / quantity / topup / coupon / anything else -> just cancel back to main menu
  resetState(ctx.from.id);
  return ctx.reply('🏠 မူလ menu သို့ ပြန်သွားပါပြီရှင့်', mainMenuKeyboard());
});

// =======================================================================
// Main menu buttons
// =======================================================================
bot.hears(BTN_SERVICES, async (ctx) => { resetState(ctx.from.id); st(ctx.from.id).level = 'platform'; await showPlatformMenu(ctx); });

bot.hears(BTN_BALANCE, async (ctx) => {
  const name = ctx.from.first_name || ctx.from.username || 'User';
  await ctx.reply(
    texts.t('balance_msg', { name, balance: ctx.dbUser.balance }),
    Markup.inlineKeyboard([[Markup.button.callback('ငွေထည့်ရန်', 'go_topup')]])
  );
});

bot.hears(BTN_TOPUP, async (ctx) => { resetState(ctx.from.id); await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard()); });

bot.hears(BTN_HISTORY, async (ctx) => {
  const orders = await Order.find({ userId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(10);
  if (!orders.length) return ctx.reply('📜 Order မှတ်တမ်း မရှိသေးပါရှင့်။');
  await refreshOrderStatuses(orders).catch(err => console.error('refresh error', err.message));
  for (const o of orders) {
    const lines = [
      `#${o._id.toString().slice(-6)} | ${o.categoryLabel || ''} ${o.serviceLabel || ''}`,
      `Link: ${o.link}`,
      `တိုးမည့်အရေအတွက်: ${o.quantity}`,
      `မတိုးခင် count: ${o.startCount != null ? o.startCount : '-'}`,
      `တိုးရန်ကျန်ရှိ: ${o.remains != null ? o.remains : '-'}`,
      `ကုန်ကျငွေ: ${o.cost} ကျပ်`,
      `Status: ${o.status}`
    ];
    const cancellable = ['pending', 'in progress', 'processing'].includes(String(o.status).toLowerCase());
    const kb = cancellable ? Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Order', `cancel_order_${o._id}`)]]) : undefined;
    await ctx.reply(lines.join('\n'), kb);
  }
});

bot.hears(BTN_COUPON, async (ctx) => { st(ctx.from.id).level = 'coupon'; await ctx.reply('🎁 Cupon code ကို ရိုက်ထည့်ပေးပါရှင့်'); });

// =======================================================================
// Platform -> Category -> Service navigation (bottom keyboard, scrollable)
// =======================================================================
async function showPlatformMenu(ctx) {
  const platforms = await Platform.find({}).sort({ _id: 1 });
  if (!platforms.length) {
    return ctx.reply(isAdmin(ctx.from.id)
      ? '😔 Home button တစ်ခုမှ မထည့်ရသေးပါ။ Admin က /addhomebutton ဖြင့် စထည့်နိုင်ပါတယ်။'
      : '😔 Service များ မကြာမီ ထည့်ပေးပါမယ်ရှင့်။'
    );
  }
  const rows = chunk(platforms.map(p => p.label), 2);
  rows.push([BTN_BACK]);
  await ctx.reply(texts.t('choose_platform'), Markup.keyboard(rows).resize());
}

async function showCategoryMenu(ctx, platform) {
  const cats = await Category.find({ platform });
  if (!cats.length) {
    return ctx.reply(isAdmin(ctx.from.id)
      ? `😔 "${platform}" အတွက် category မထည့်ရသေးပါ။ Admin က /addid (သို့) /addbutton ဖြင့် ထည့်နိုင်ပါတယ်။`
      : '😔 ဒီ Service အတွက် ခဏနေမှ ထည့်ပေးပါမယ်ရှင့်။'
    );
  }
  const rows = chunk(cats.map(c => c.label), 3);
  rows.push([BTN_BACK]);
  const s = st(ctx.from.id);
  s.level = 'category'; s.platform = platform;
  await ctx.reply(texts.t('choose_category'), Markup.keyboard(rows).resize());
}

async function enterCategory(ctx, category) {
  const services = await Service.find({ categoryId: category._id });
  if (!services.length) {
    return ctx.reply(isAdmin(ctx.from.id)
      ? '😔 ဒီ category အတွက် service များ မရှိသေးပါ။ /addbutton (သို့) /addid ဖြင့် ထည့်ပါ။'
      : '😔 ခဏနေမှ ထည့်ပေးပါမယ်ရှင့်။'
    );
  }
  if (services.length === 1) return startLinkFlow(ctx, services[0], category);
  const rows = chunk(services.map(s => s.label), 4);
  rows.push([BTN_BACK]);
  const s = st(ctx.from.id);
  s.level = 'service'; s.categoryId = String(category._id); s.platform = category.platform;
  await ctx.reply(texts.t('choose_service'), Markup.keyboard(rows).resize());
}

async function startLinkFlow(ctx, service, category) {
  const s = st(ctx.from.id);
  s.level = 'link';
  s.serviceId = String(service._id);
  s.platform = category.platform;
  s.categoryLabel = category.label;
  s.serviceLabel = service.label;
  const formatted = service.manualDuration || providers.formatDuration(service.avgTime);
  const duration = formatted || 'Provider ပေါ်တွင် မူတည်ပါသည်';
  await ctx.reply(texts.t('ask_link', { duration }));
}

// =======================================================================
// Text handler for the whole state machine (order flow, topup flow,
// coupon redemption, and every admin text-based wizard step)
// =======================================================================
const MYANMAR_DIGITS = /[၀-၉]/;

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const s = st(ctx.from.id);

  // any real command (starts with "/") must always reach the command
  // handlers below - never let leftover menu/wizard state swallow it
  if (text.startsWith('/')) return next();

  // ---- platform/category/service picked from the bottom keyboard ----
  if (s.level === 'platform') {
    const platform = await Platform.findOne({ label: text });
    if (!platform) return ctx.reply(`❌ "${text}" ဆိုတဲ့ home button မတွေ့ပါ။ Menu ထဲက button ကိုပဲ နှိပ်ပေးပါ။`);
    return showCategoryMenu(ctx, platform._id);
  }
  if (s.level === 'category') {
    const category = await Category.findOne({ platform: s.platform, label: text });
    if (!category) return ctx.reply(`❌ "${text}" ဆိုတဲ့ category မတွေ့ပါ။ Menu ထဲက button ကိုပဲ နှိပ်ပေးပါ။`);
    return enterCategory(ctx, category);
  }
  if (s.level === 'service') {
    const service = await Service.findOne({ categoryId: s.categoryId, label: text });
    if (!service) return ctx.reply(`❌ "${text}" ဆိုတဲ့ service မတွေ့ပါ။ Menu ထဲက button ကိုပဲ နှိပ်ပေးပါ။`);
    const category = await Category.findById(s.categoryId);
    return startLinkFlow(ctx, service, category);
  }

  // ---- order: link then quantity ----
  if (s.level === 'link') {
    if (!/^https?:\/\//i.test(text) && !text.includes('.')) {
      return ctx.reply('⚠️ Link အမှန် ပို့ပေးပါရှင့် (http/https ဖြင့် စရပါမယ်)');
    }
    s.link = text;
    s.level = 'quantity';
    await ctx.reply(texts.t('ask_quantity'), { parse_mode: 'Markdown' });
    return;
  }
  if (s.level === 'quantity') {
    if (MYANMAR_DIGITS.test(text) || !/^[0-9]+$/.test(text)) {
      return ctx.reply(texts.t('ask_quantity_number_hint'));
    }
    const quantity = parseInt(text, 10);
    const service = await Service.findById(s.serviceId);
    if (!service) { resetState(ctx.from.id); return ctx.reply('❌ Service မတွေ့ပါ၊ ပြန်လည် ရွေးပေးပါ။', mainMenuKeyboard()); }
    if (quantity < service.min || quantity > service.max) {
      return ctx.reply(`⚠️ quantity သည် ${service.min} နှင့် ${service.max} ကြားဖြစ်ရပါမည်။`);
    }
    let cost;
    try {
      cost = providers.calcSaleCost(service.provider, service.rate, quantity);
    } catch (err) {
      return ctx.reply('❌ ' + err.message);
    }
    s.quantity = quantity;
    s.cost = cost;
    s.level = 'confirm';
    await ctx.reply(
      texts.t('order_confirm', { cost }),
      Markup.inlineKeyboard([[Markup.button.callback('✅ ဝယ်ယူမည်', 'place_order')]])
    );
    return;
  }

  // ---- coupon redeem ----
  if (s.level === 'coupon') {
    resetState(ctx.from.id);
    const code = text.toUpperCase();
    const coupon = await Coupon.findById(code);
    if (!coupon || coupon.remaining <= 0) return ctx.reply('❌ Cupon code မှားနေပါသည် သို့မဟုတ် ကုန်သွားပါပြီရှင့်။');
    coupon.remaining -= 1; await coupon.save();
    ctx.dbUser.balance += coupon.amount; await ctx.dbUser.save();
    return ctx.reply(`🎉 Cupon code အောင်မြင်ပါသည်! သင့်အကောင့်ထဲသို့ ${coupon.amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့်။`);
  }

  // ---- topup: amount typed after sending screenshot ----
  if (s.level === 'topup_amount') {
    if (MYANMAR_DIGITS.test(text)) return ctx.reply('မြန်မာလို ၁၂၃၄၅၆၇၈၉၀ ဂဏန်းတွေ ရေးရင်လည်း English လိုဘဲ ရေးပေးပါရှင့် 😊');
    if (!/^[0-9]+$/.test(text)) return ctx.reply('ငွေလွှဲထားတဲ့ ဂဏန်းနံပါတ်လေးကို English လိုဘဲ ရေးပေးပါရှင့် 😊');
    const amount = parseInt(text, 10);
    s.amount = amount; s.level = 'root';
    const caption = `🧾 ငွေဖြည့်တောင်းဆိုမှု\nUser: ${ctx.from.first_name || ''} (@${ctx.from.username || '-'})\nUser ID: ${ctx.from.id}\nနည်းလမ်း: ${s.method || '-'}\nပမာဏ: ${amount} ကျပ်`;
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendPhoto(adminId, s.screenshotFileId, {
          caption,
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', `confirm_topup_${ctx.from.id}_${amount}`)],
            [Markup.button.callback('✏️ Edit Amount', `editamt_${ctx.from.id}_${amount}`)]
          ]).reply_markup
        });
      } catch (err) { console.error('notify admin failed', err.message); }
    }
    await ctx.reply(texts.t('topup_submitted'), mainMenuKeyboard());
    return;
  }

  // ---- admin: edit top-up amount before crediting ----
  if (s.level === 'admin_edit_amount' && isAdmin(ctx.from.id)) {
    if (!/^[0-9]+$/.test(text)) return ctx.reply('ဂဏန်းသက်သက်ဖြင့်သာ ရေးပေးပါ။');
    const newAmount = parseInt(text, 10);
    const targetUserId = s.editTargetUserId;
    resetState(ctx.from.id);
    const u = await User.findById(targetUserId);
    if (u) { u.balance += newAmount; await u.save(); }
    await ctx.reply(`✅ ${targetUserId} အတွက် ${newAmount} ကျပ် ထည့်ပေးလိုက်ပါပြီ။`);
    await safeSend(targetUserId, `သင်ဖြည့်ထားသောငွေပမာဏမှာ ${newAmount} ဖြစ်သောကြောင့် သင့်အကောင့်ထဲသို့ ${newAmount} ကျပ် ထည့်ပေးထားပါတယ်ရှင့် ❤️`);
    return;
  }

  // ---- admin: send message to one user / all users ----
  if (s.level === 'admin_send_one' && isAdmin(ctx.from.id)) {
    const target = s.sendMessageTarget; resetState(ctx.from.id);
    const ok = await safeSend(target, text);
    return ctx.reply(ok ? '✅ ပို့ပြီးပါပြီ။' : '❌ ပို့မရပါ (block ထားနိုင်သည်)။');
  }
  if (s.level === 'admin_send_all' && isAdmin(ctx.from.id)) {
    resetState(ctx.from.id);
    const users = await User.find({});
    let sent = 0;
    for (const u of users) { if (await safeSend(u._id, text)) sent++; }
    return ctx.reply(`✅ User ${sent}/${users.length} ဆီကို ပို့ပြီးပါပြီ။`);
  }

  // ---- admin: /addid wizard ----
  if (s.level === 'admin_addid_platform' && isAdmin(ctx.from.id)) {
    s.newPlatform = text.toLowerCase();
    s.level = 'admin_addid_category';
    const existing = await Category.find({ platform: s.newPlatform });
    const list = existing.length ? ('\n\nရှိပြီးသား categories:\n' + existing.map(c => '- ' + c.label).join('\n')) : '';
    await ctx.reply(`Category label ရေးပါ (ရှိပြီးသားကို ကူးရေးရင် အဲဒီ category ထဲ ထည့်မှာပါ၊ အသစ်ရေးရင် category အသစ် ဖြစ်မှာပါ)${list}`);
    return;
  }
  if (s.level === 'admin_addid_category' && isAdmin(ctx.from.id)) {
    s.newCategoryLabel = text;
    s.level = 'admin_addid_provider';
    await ctx.reply('Provider ကို ရေးပါ: shweboost သို့မဟုတ် secsers');
    return;
  }
  if (s.level === 'admin_addid_provider' && isAdmin(ctx.from.id)) {
    const provider = text.toLowerCase();
    if (!['shweboost', 'secsers'].includes(provider)) return ctx.reply('shweboost သို့မဟုတ် secsers ဟုသာ ရေးပါ။');
    s.newProvider = provider;
    s.level = 'admin_addid_serviceid';
    await ctx.reply(`${provider} ဝဘ်ဆိုက်ထဲက ဝယ်လိုသော service ရဲ့ provider service id ကို ရေးပါ`);
    return;
  }
  if (s.level === 'admin_addid_serviceid' && isAdmin(ctx.from.id)) {
    const providerServiceId = text.trim();
    let info;
    try {
      info = await providers.fetchServiceInfo(s.newProvider, providerServiceId);
    } catch (err) {
      return ctx.reply('❌ ' + err.message);
    }
    s.newProviderServiceId = providerServiceId;
    s.newServiceInfo = info;
    s.level = 'admin_addid_label';
    await ctx.reply(
      `✅ Provider ကနေ ရရှိသော အချက်အလက်:\nအမည်: ${info.providerName}\nနှုန်း/1000: ${info.rate}\nMin: ${info.min} / Max: ${info.max}\n\n` +
      `User မြင်ရမယ့် button label ရေးပါ (ဥပမာ ♥️ or 👍♥️🔥😁🎉 +Views)။ Provider အမည်ကိုပဲ သုံးချင်ရင် "-" ရေးပါ`
    );
    return;
  }
  if (s.level === 'admin_addid_label' && isAdmin(ctx.from.id)) {
    const label = text === '-' ? s.newServiceInfo.providerName : text;
    let platform = await Platform.findById(s.newPlatform);
    if (!platform) {
      platform = await Platform.create({
        _id: s.newPlatform,
        label: s.newPlatform.charAt(0).toUpperCase() + s.newPlatform.slice(1) + ' Service'
      });
    }
    let category = await Category.findOne({ platform: s.newPlatform, label: s.newCategoryLabel });
    if (!category) category = await Category.create({ platform: s.newPlatform, label: s.newCategoryLabel });
    const service = await Service.create({
      categoryId: category._id,
      label,
      provider: s.newProvider,
      providerServiceId: s.newProviderServiceId,
      providerName: s.newServiceInfo.providerName,
      rate: s.newServiceInfo.rate,
      min: s.newServiceInfo.min,
      max: s.newServiceInfo.max,
      avgTime: s.newServiceInfo.avgTime,
      lastSynced: new Date()
    });
    resetState(ctx.from.id);
    await ctx.reply(
      `✅ Service ထည့်ပြီးပါပြီ။\nHome button: ${platform.label} (key: ${platform._id})\nCategory: ${category.label}\nButton label: ${label}\nService mongo id (ဖျက်ရန် /removeid သုံးမည့် id): ${service._id}`
    );
    return;
  }

  return next();
});

// =======================================================================
// Top-up flow
// =======================================================================
bot.action('go_topup', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard()); });

bot.action('topup_kpay', async (ctx) => {
  await ctx.answerCbQuery();
  const s = st(ctx.from.id); s.method = 'KPay'; s.level = 'topup_screenshot';
  await ctx.reply(`${texts.t('topup_min')}\n\nkpay - ${KPAY_NUMBER}\nname - ${KPAY_NAME}\n\n${texts.t('topup_ask_screenshot')}`);
});
bot.action('topup_wave', async (ctx) => {
  await ctx.answerCbQuery();
  const s = st(ctx.from.id); s.method = 'Wave'; s.level = 'topup_screenshot';
  await ctx.reply(`${texts.t('topup_min')}\n\nWave - ${WAVE_NUMBER}\nName - ${WAVE_NAME}\n\n${texts.t('topup_ask_screenshot')}`);
});

bot.on('photo', async (ctx) => {
  const s = st(ctx.from.id);
  if (s.level !== 'topup_screenshot') return;
  const photos = ctx.message.photo;
  s.screenshotFileId = photos[photos.length - 1].file_id;
  s.level = 'topup_amount';
  await ctx.reply(texts.t('topup_ask_amount'));
});

bot.action(/^confirm_topup_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.match[1], amount = parseInt(ctx.match[2], 10);
  const u = await User.findById(userId);
  if (u) { u.balance += amount; await u.save(); }
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(`✅ User ${userId} အတွက် ${amount} ကျပ် အောင်မြင်စွာ ထည့်ပြီးပါပြီ။`);
  await safeSend(userId, texts.t('topup_success', { amount }));
});

bot.action(/^editamt_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const s = st(ctx.from.id);
  s.level = 'admin_edit_amount';
  s.editTargetUserId = ctx.match[1];
  await ctx.reply('ပြောင်းလဲလိုသော amount အားရိုက်ထည့်ပါ');
});

// =======================================================================
// Order placement confirmation
// =======================================================================
bot.action('place_order', async (ctx) => {
  await ctx.answerCbQuery();
  const s = st(ctx.from.id);
  if (s.level !== 'confirm') return;
  const service = await Service.findById(s.serviceId);
  const user = await User.findById(String(ctx.from.id));
  if (!service || !user) { resetState(ctx.from.id); return ctx.reply('❌ Error, ပြန်စမ်းကြည့်ပါ။', mainMenuKeyboard()); }

  if (user.balance < s.cost) {
    resetState(ctx.from.id);
    const name = ctx.from.first_name || ctx.from.username || 'User';
    return ctx.reply(
      texts.t('insufficient_balance', { name }),
      Markup.inlineKeyboard([[Markup.button.callback('💰ငွေဖြည့်ရန်💰', 'go_topup')]])
    );
  }

  let providerOrderId;
  try {
    providerOrderId = await providers.placeOrder(service.provider, service.providerServiceId, s.link, s.quantity);
  } catch (err) {
    resetState(ctx.from.id);
    return ctx.reply('❌ Order တင်၍ မရပါ: ' + err.message, mainMenuKeyboard());
  }

  user.balance -= s.cost;
  user.totalSpent = (user.totalSpent || 0) + s.cost;
  await user.save();

  await Order.create({
    userId: String(ctx.from.id),
    serviceId: service._id,
    platform: s.platform,
    categoryLabel: s.categoryLabel,
    serviceLabel: s.serviceLabel,
    provider: service.provider,
    providerOrderId: String(providerOrderId),
    link: s.link,
    quantity: s.quantity,
    cost: s.cost,
    status: 'pending'
  });

  resetState(ctx.from.id);
  await ctx.reply(texts.t('order_success', { cost: s.cost }), mainMenuKeyboard());
});

// =======================================================================
// Order status refresh + cancel
// =======================================================================
async function refreshOrderStatuses(orders) {
  const active = orders.filter(o => !['completed', 'cancelled', 'error'].includes(String(o.status).toLowerCase()));
  const byProvider = {};
  for (const o of active) (byProvider[o.provider] = byProvider[o.provider] || []).push(o);

  for (const provider of Object.keys(byProvider)) {
    const list = byProvider[provider];
    try {
      const ids = list.map(o => o.providerOrderId);
      const result = await providers.orderStatusBulk(provider, ids);
      const map = Array.isArray(result)
        ? Object.fromEntries(result.map(r => [String(r.order), r]))
        : result;
      for (const o of list) {
        const info = map[o.providerOrderId];
        if (!info || info.error) continue;
        const wasCompleted = String(o.status).toLowerCase() === 'completed';
        if (info.status) o.status = info.status;
        if (info.start_count !== undefined) o.startCount = Number(info.start_count);
        if (info.remains !== undefined) o.remains = Number(info.remains);
        o.updatedAt = new Date();
        await o.save();
        if (!wasCompleted && String(o.status).toLowerCase() === 'completed') {
          await safeSend(o.userId, texts.t('order_complete', { link: o.link, service: o.serviceLabel || o.categoryLabel }));
        }
      }
    } catch (err) {
      console.error(`status refresh failed for ${provider}:`, err.message);
    }
  }
}

bot.action(/^cancel_order_([0-9a-fA-F]{24})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const order = await Order.findById(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id)) return ctx.reply('❌ Order မတွေ့ပါ။');
  if (!['pending', 'in progress', 'processing'].includes(String(order.status).toLowerCase())) {
    return ctx.reply('ℹ️ ဒီ order ကို cancel လုပ်၍ မရတော့ပါ။');
  }
  try {
    const ok = await providers.cancelOrder(order.provider, order.providerOrderId);
    if (ok) {
      order.status = 'cancelled'; await order.save();
      const user = await User.findById(order.userId);
      if (user) { user.balance += order.cost; user.totalSpent = Math.max(0, (user.totalSpent || 0) - order.cost); await user.save(); }
      await ctx.reply(texts.t('order_cancel_success', { cost: order.cost }));
    } else {
      await ctx.reply(texts.t('order_cancel_fail'));
    }
  } catch (err) {
    await ctx.reply('❌ Cancel checking အတွင်း error တက်သည်: ' + err.message);
  }
});

// background job: periodically refresh all still-active orders so users get
// the "completed" notification even if they never reopen Order History.
// Runs in small batches with delays so a large number of orders can never
// crash the bot or hammer the provider API.
async function backgroundStatusSweep() {
  try {
    const active = await Order.find({ status: { $nin: ['completed', 'cancelled', 'error'] } }).limit(200);
    for (const batch of chunk(active, 40)) {
      await refreshOrderStatuses(batch);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('backgroundStatusSweep error:', err.message);
  }
}
setInterval(() => { backgroundStatusSweep(); }, 5 * 60 * 1000);

// =======================================================================
// Admin: user/ban/money commands
// =======================================================================
function requireAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) { ctx.reply('❌ ဒီ command ကို Admin သာ အသုံးပြုနိုင်ပါသည်။'); return false; }
  return true;
}

bot.command('ban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1]; if (!id) return ctx.reply('ပုံစံ: /ban <user_id>');
  const u = await User.findByIdAndUpdate(id, { banned: true });
  await ctx.reply(u ? `🚫 User ${id} ကို ပိတ်လိုက်ပါပြီ။` : 'User မတွေ့ပါ။');
});
bot.command('unban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1]; if (!id) return ctx.reply('ပုံစံ: /unban <user_id>');
  const u = await User.findByIdAndUpdate(id, { banned: false });
  await ctx.reply(u ? `✅ User ${id} ကို ပြန်ဖွင့်ပေးလိုက်ပါပြီ။` : 'User မတွေ့ပါ။');
});
bot.command('addmoney', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1], amount = parseFloat(parts[2]);
  if (!id || isNaN(amount)) return ctx.reply('ပုံစံ: /addmoney <user_id> <amount>');
  const u = await User.findById(id); if (!u) return ctx.reply('User မတွေ့ပါ။');
  u.balance += amount; await u.save();
  await ctx.reply(`✅ User ${id} လက်ကျန်ငွေ: ${u.balance} ကျပ်`);
  await safeSend(id, `Admin မှ သင့်အကောင့်ထဲသို့ ${amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့် ❤️`);
});
bot.command('decreasemoney', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1], amount = parseFloat(parts[2]);
  if (!id || isNaN(amount)) return ctx.reply('ပုံစံ: /decreasemoney <user_id> <amount>');
  const u = await User.findById(id); if (!u) return ctx.reply('User မတွေ့ပါ။');
  u.balance -= amount; await u.save();
  await ctx.reply(`✅ User ${id} လက်ကျန်ငွေ: ${u.balance} ကျပ်`);
  await safeSend(id, `Admin မှ သင့်အကောင့်ထဲမှ ${amount} ကျပ် နှုတ်ယူလိုက်ပါပြီရှင့်။`);
});

bot.command('totaluser', async (ctx) => { if (!requireAdmin(ctx)) return; await ctx.reply(`👥 Total users: ${await User.countDocuments()}`); });

bot.command('users', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const page = Math.max(1, parseInt(ctx.message.text.split(' ')[1], 10) || 1);
  const perPage = 10;
  const total = await User.countDocuments();
  const users = await User.find({}).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage);
  if (!users.length) return ctx.reply('User မရှိပါ။');
  const lines = users.map(u =>
    `👤 [${u.firstName || u.username || u._id}](tg://user?id=${u._id})\nID: ${u._id} | Balance: ${u.balance} | Spent: ${u.totalSpent || 0}${u.banned ? ' | 🚫banned' : ''}`
  );
  const totalPages = Math.ceil(total / perPage);
  await ctx.replyWithMarkdown(`👥 Users - page ${page}/${totalPages}\n\n` + lines.join('\n\n'));
});

bot.command('userinfo', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /userinfo <user_id>');
  const u = await User.findById(id);
  if (!u) return ctx.reply('User မတွေ့ပါ။');
  const orders = await Order.find({ userId: id }).sort({ createdAt: -1 }).limit(5);
  const orderLines = orders.length
    ? orders.map(o => `- #${o._id.toString().slice(-6)} ${o.link} (${o.status})`).join('\n')
    : 'Order မရှိသေးပါ';
  await ctx.replyWithMarkdown(
    `👤 [${u.firstName || u.username || u._id}](tg://user?id=${u._id})\n` +
    `ID: ${u._id}\nUsername: @${u.username || '-'}\nBalance: ${u.balance}\nTotal spent: ${u.totalSpent || 0}\nBanned: ${u.banned}\n\n` +
    `Recent orders:\n${orderLines}`
  );
});

// =======================================================================
// Admin: service management
// =======================================================================
// Telegram keyboard buttons (reply AND inline) cannot render Markdown bold -
// this converts plain Latin letters/digits to Unicode "Mathematical Bold"
// look-alikes so button labels still LOOK bold. Non-Latin characters
// (Burmese, emoji, etc.) pass through unchanged.
function toBoldUnicode(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) out.push(String.fromCodePoint(0x1D400 + (code - 65)));       // A-Z
    else if (code >= 97 && code <= 122) out.push(String.fromCodePoint(0x1D41A + (code - 97)));  // a-z
    else if (code >= 48 && code <= 57) out.push(String.fromCodePoint(0x1D7CE + (code - 48)));   // 0-9
    else out.push(ch);
  }
  return out.join('');
}

// "Home buttons" = the platform buttons shown first (Telegram Service,
// Tiktok Service, Facebook Service, ...). These can be created BEFORE any
// category/service exists under them.
bot.command('addhomebutton', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const key = parts[1];
  const rawLabel = parts.slice(2).join(' ');
  if (!key || !rawLabel) {
    return ctx.reply(
      'ပုံစံ: /addhomebutton <key> <label...>\n\n' +
      'ဥပမာ: /addhomebutton telegram Telegram Service\n' +
      '("key" က internal name - lowercase, space မပါရ။ "label" ကတော့ user မြင်ရမယ့် button စာသား - Latin စာလုံးများကို bold ပုံစံအဖြစ် အလိုအလျောက် ပြောင်းပေးမည်)'
    );
  }
  const label = toBoldUnicode(rawLabel);
  await Platform.findByIdAndUpdate(key.toLowerCase(), { _id: key.toLowerCase(), label }, { upsert: true });
  await ctx.reply(`✅ Home button "${label}" (key: ${key.toLowerCase()}) ထည့်ပြီးပါပြီ။`);
});

bot.command(['removehomebutton', 'decreasehomebutton'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const key = ctx.message.text.split(' ')[1];
  if (!key) return ctx.reply('ပုံစံ: /removehomebutton <key>\nဥပမာ: /removehomebutton telegram');
  const removed = await Platform.findByIdAndDelete(key.toLowerCase());
  if (!removed) return ctx.reply('❌ ဒီ key နဲ့ home button မတွေ့ပါ။ /services ဖြင့် key များ စစ်ကြည့်ပါ။');
  const cats = await Category.find({ platform: key.toLowerCase() });
  const catIds = cats.map(c => c._id);
  const { deletedCount: svcDeleted } = await Service.deleteMany({ categoryId: { $in: catIds } });
  const { deletedCount: catDeleted } = await Category.deleteMany({ platform: key.toLowerCase() });
  await ctx.reply(`✅ Home button "${removed.label}" ဖျက်ပြီးပါပြီ (category ${catDeleted} ခု, service ${svcDeleted} ခု အပါအဝင်)။`);
});

// Fast one-line service add (alternative to the /addid step-by-step wizard) -
// creates the home button + category automatically if they don't exist yet.
async function addServiceQuick(platformKey, categoryLabel, buttonLabel, provider, providerServiceId) {
  let platform = await Platform.findById(platformKey);
  if (!platform) platform = await Platform.create({ _id: platformKey, label: categoryLabel ? `${platformKey.charAt(0).toUpperCase() + platformKey.slice(1)} Service` : platformKey });
  let category = await Category.findOne({ platform: platformKey, label: categoryLabel });
  if (!category) category = await Category.create({ platform: platformKey, label: categoryLabel });
  const info = await providers.fetchServiceInfo(provider, providerServiceId);
  const label = buttonLabel === '-' ? info.providerName : buttonLabel;
  const service = await Service.create({
    categoryId: category._id, label, provider, providerServiceId,
    providerName: info.providerName, rate: info.rate, min: info.min, max: info.max,
    avgTime: info.avgTime, lastSynced: new Date()
  });
  return { platform, category, service };
}

bot.command(['addbutton', 'addservice'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const raw = ctx.message.text.split(' ').slice(1).join(' ');
  const parts = raw.split('|').map(s => s.trim());
  if (parts.length !== 5) {
    return ctx.reply(
      'ပုံစံ: /addbutton <platform_key>|<category_label>|<button_label>|<provider>|<provider_service_id>\n\n' +
      'ဥပမာ (Telegram Reaction ထဲ ♥️ ထည့်ခြင်း):\n' +
      '/addbutton telegram|Reaction တိုးရန်❤️|♥️|shweboost|1234\n\n' +
      'ဥပမာ (Views - category တစ်ခုတည်းမှာ service တစ်ခုတည်း):\n' +
      '/addbutton telegram|Views တိုးရန်👀|-|shweboost|5678\n\n' +
      '(button_label နေရာမှာ "-" ရေးရင် provider ရဲ့ service name ကိုပဲ အလိုအလျောက် သုံးပါမယ်)'
    );
  }
  const [platformKey, categoryLabel, buttonLabel, provider, providerServiceId] = parts;
  if (!['shweboost', 'secsers'].includes(provider.toLowerCase())) {
    return ctx.reply('❌ provider ကို shweboost သို့မဟုတ် secsers ဟုသာ ရေးပါ။');
  }
  try {
    const { service, category, platform } = await addServiceQuick(
      platformKey.toLowerCase(), categoryLabel, buttonLabel, provider.toLowerCase(), providerServiceId
    );
    await ctx.reply(
      `✅ ထည့်ပြီးပါပြီ။\nHome button: ${platform.label} (key: ${platform._id})\nCategory: ${category.label}\nButton label: ${service.label}\nService id (ဖျက်ရန်): ${service._id}`
    );
  } catch (err) {
    await ctx.reply('❌ ' + err.message);
  }
});

bot.command(['+id', 'addid'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  st(ctx.from.id).level = 'admin_addid_platform';
  const platforms = await Platform.find({});
  const list = platforms.length ? ('\n\nရှိပြီးသား home button keys: ' + platforms.map(p => p._id).join(', ')) : '';
  await ctx.reply(`Platform key ကို ရေးပါ (ဥပမာ telegram/tiktok/facebook)${list}`);
});

bot.command(['services', 'listservices'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const platforms = await Platform.find({}).sort({ _id: 1 });
  const categories = await Category.find({}).sort({ platform: 1 });
  if (!platforms.length && !categories.length) {
    return ctx.reply('😔 Home button / Category / Service ဘာမှ မရှိသေးပါ။ /addhomebutton (သို့) /addid ဖြင့် စထည့်ပါ။');
  }
  const lines = ['🏠 Home buttons:'];
  if (!platforms.length) lines.push('  (မရှိသေးပါ)');
  for (const p of platforms) lines.push(`  • ${p.label}  (key: ${p._id})`);
  for (const c of categories) {
    const services = await Service.find({ categoryId: c._id });
    lines.push(`\n📁 [${c.platform}] ${c.label}  (categoryId: ${c._id})`);
    if (!services.length) {
      lines.push('   (service မရှိသေးပါ)');
    } else {
      for (const s of services) {
        lines.push(`   • ${s.label} — ${s.provider}#${s.providerServiceId} — rate:${s.rate} min:${s.min} max:${s.max} — id:${s._id}`);
      }
    }
  }
  // Telegram messages cap at 4096 chars - split into chunks if needed
  const full = lines.join('\n');
  for (let i = 0; i < full.length; i += 3500) {
    await ctx.reply(full.slice(i, i + 3500));
  }
});

bot.command(['-category', 'removecategory'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /removecategory <categoryMongoId>\n(category ဖျက်ရင် အောက်က service အားလုံးပါ ပါ ဖျက်ပါမည်)');
  const cat = await Category.findByIdAndDelete(id).catch(() => null);
  if (!cat) return ctx.reply('❌ Category မတွေ့ပါ။');
  const { deletedCount } = await Service.deleteMany({ categoryId: id });
  await ctx.reply(`✅ Category "${cat.label}" နှင့် service ${deletedCount} ခု ဖျက်ပြီးပါပြီ။`);
});

bot.command(['-id', 'removeid'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /removeid <serviceMongoId>');
  const res = await Service.findByIdAndDelete(id).catch(() => null);
  await ctx.reply(res ? '✅ Service ဖျက်ပြီးပါပြီ။' : '❌ Service မတွေ့ပါ။');
});

// debug helper: shows exactly how a cost was derived, so if a price looks
// wrong you can immediately see whether the raw provider rate is the
// problem or the markup math is the problem.
// ShweBoost's API has NO duration field at all - so admin can set one
// manually per service (Secsers might supply avgTime automatically, but a
// manual override always wins if set).
bot.command('setduration', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const serviceId = parts[1];
  const duration = parts.slice(2).join(' ');
  if (!serviceId || !duration) {
    return ctx.reply('ပုံစံ: /setduration <serviceMongoId> <duration text>\nဥပမာ: /setduration 66a2f3d2... 18 မိနစ်\nဥပမာ: /setduration 66a2f3d2... 30 မိနစ် - 1 နာရီ');
  }
  const service = await Service.findByIdAndUpdate(serviceId, { manualDuration: duration });
  if (!service) return ctx.reply('❌ Service မတွေ့ပါ။');
  await ctx.reply(`✅ "${service.label}" ရဲ့ ကြာချိန်ကို "${duration}" အဖြစ် သတ်မှတ်ပြီးပါပြီ။`);
});

bot.command('testcost', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const serviceId = parts[1], quantity = parseInt(parts[2], 10);
  if (!serviceId || !quantity) return ctx.reply('ပုံစံ: /testcost <serviceMongoId> <quantity>');
  const service = await Service.findById(serviceId).catch(() => null);
  if (!service) return ctx.reply('❌ Service မတွေ့ပါ။');
  try {
    const cost = providers.calcSaleCost(service.provider, service.rate, quantity);
    const providerCost = (service.rate / 1000) * quantity;
    await ctx.reply(
      `🧮 Cost breakdown\n` +
      `Service: ${service.label} (${service.provider}#${service.providerServiceId})\n` +
      `Stored rate (per 1000, provider's own currency): ${service.rate}\n` +
      `Quantity: ${quantity}\n` +
      `Provider cost for this quantity: ${providerCost.toFixed(4)} ${providers.CONFIG[service.provider].currency}\n` +
      `Markup formula applied: x${process.env[service.provider === 'shweboost' ? 'SHWEBOOST_USD_TO_MMK' : 'SECSERS_USD_TO_MMK'] || 4400} (USD→MMK) x${process.env[service.provider === 'shweboost' ? 'SHWEBOOST_MARKUP_MULTIPLIER' : 'SECSERS_MARKUP_MULTIPLIER'] || (service.provider === 'shweboost' ? 2.3 : 1)}\n` +
      `Final sale cost: ${cost} ကျပ်\n\n` +
      `⚠️ ဒီအရေအတွက် မှားနေရင် "Stored rate" ကို ${service.provider} dashboard ထဲက service ရဲ့ rate နှင့် တိုက်စစ်ပါ - /syncservices ဖြင့် ပြန် sync လုပ်နိုင်ပါတယ်။`
    );
  } catch (err) {
    await ctx.reply('❌ ' + err.message);
  }
});

bot.command('syncservices', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const services = await Service.find({});
  await ctx.reply(`🔄 Service ${services.length} ခု sync လုပ်နေပါသည်...`);
  let ok = 0, fail = 0;
  for (const svc of services) {
    try {
      const info = await providers.fetchServiceInfo(svc.provider, svc.providerServiceId);
      svc.rate = info.rate; svc.min = info.min; svc.max = info.max;
      svc.avgTime = info.avgTime; svc.lastSynced = new Date();
      await svc.save(); ok++;
    } catch (err) { fail++; }
  }
  await ctx.reply(`✅ Sync ပြီးပါပြီ - success ${ok}, fail ${fail}`);
});

bot.command('providerbalance', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const lines = [];
  for (const provider of ['shweboost', 'secsers']) {
    try {
      const res = await providers.getBalance(provider);
      lines.push(`${provider}: ${res.balance} ${res.currency || ''}`);
    } catch (err) {
      lines.push(`${provider}: ❌ ${err.message}`);
    }
  }
  await ctx.reply('💳 Provider balances:\n\n' + lines.join('\n'));
});

// =======================================================================
// Admin: orders
// =======================================================================
bot.command('checkorders', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const orders = await Order.find({}).sort({ createdAt: -1 }).limit(30);
  if (!orders.length) return ctx.reply('Order များ မရှိသေးပါ။');
  const lines = await Promise.all(orders.map(async o => {
    const u = await User.findById(o.userId);
    const name = u ? (u.firstName || u.username || o.userId) : o.userId;
    return `#${o._id.toString().slice(-6)} | ${name} | ${o.categoryLabel || ''} ${o.serviceLabel || ''} | ${o.cost} ကျပ် | ${o.status}`;
  }));
  await ctx.reply('📋 Orders (နောက်ဆုံး 30):\n\n' + lines.join('\n'));
});

bot.command(['-order', 'removeorder'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /removeorder <orderMongoId>');
  const res = await Order.findByIdAndDelete(id).catch(() => null);
  await ctx.reply(res ? '✅ Order ဖျက်ပြီးပါပြီ။' : '❌ Order မတွေ့ပါ။');
});

// =======================================================================
// Admin: messaging + coupons
// =======================================================================
bot.command('sendmessage', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1]; const rest = parts.slice(2).join(' ');
  if (!id) return ctx.reply('ပုံစံ: /sendmessage <user_id> [message]');
  if (rest) { const ok = await safeSend(id, rest); return ctx.reply(ok ? '✅ ပို့ပြီးပါပြီ။' : '❌ ပို့မရပါ။'); }
  const s = st(ctx.from.id); s.level = 'admin_send_one'; s.sendMessageTarget = id;
  await ctx.reply('ပို့လိုသော message ကို ရိုက်ထည့်ပါ');
});
bot.command('allsendmessage', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const rest = ctx.message.text.split(' ').slice(1).join(' ');
  if (rest) {
    const users = await User.find({}); let sent = 0;
    for (const u of users) { if (await safeSend(u._id, rest)) sent++; }
    return ctx.reply(`✅ User ${sent}/${users.length} ဆီကို ပို့ပြီးပါပြီ။`);
  }
  st(ctx.from.id).level = 'admin_send_all';
  await ctx.reply('User အားလုံးသို့ ပို့လိုသော message ကို ရိုက်ထည့်ပါ');
});
bot.command('cuponcode', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const amount = parseFloat(parts[1]); const count = parseInt(parts[2], 10); let code = parts[3];
  if (!amount || !count) return ctx.reply('ပုံစံ: /cuponcode <amount> <count> [custom_code]');
  code = code ? code.toUpperCase() : 'SMM' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await Coupon.findByIdAndUpdate(code, { _id: code, amount, remaining: count }, { upsert: true });
  await ctx.reply(`🎁 Cupon code ထုတ်ပြီးပါပြီ။\n\nCode: ${code}\nတန်ဖိုး: ${amount} ကျပ်\nအသုံးပြုနိုင်သူ: ${count} ယောက်`);
});

// =======================================================================
// Admin: editable texts
// =======================================================================
bot.command('texts', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const lines = texts.allKeys().map(k => `• ${k}`);
  await ctx.reply('ပြင်လို့ရသော text keys:\n\n' + lines.join('\n') + '\n\n/edittext <key> <new text> ဖြင့် ပြင်ပါ');
});
bot.command('edittext', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const key = parts[1]; const value = parts.slice(2).join(' ');
  if (!key || !value) return ctx.reply('ပုံစံ: /edittext <key> <new text with ${placeholders}>');
  if (!texts.allKeys().includes(key)) return ctx.reply('❌ ဒီ key မရှိပါ။ /texts နှိပ်ပြီး key များ ကြည့်ပါ။');
  await texts.setText(key, value);
  await ctx.reply(`✅ "${key}" ကို ပြင်ပြီးပါပြီ။`);
});

// =======================================================================
// error handling, health server, launch
// =======================================================================
bot.catch((err, ctx) => console.error(`Bot error for update ${ctx.updateType}:`, err));

const app = express();
app.get('/', (req, res) => res.send('SMM Telegram bot is running.'));
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('MongoDB connected');
  await texts.preload();
  app.listen(PORT, () => console.log(`Health-check server listening on port ${PORT}`));
  bot.launch()
    .then(() => console.log('Bot launched (long polling).'))
    .catch(err => {
      // This commonly happens for a few seconds during a Render redeploy,
      // while the OLD instance is still shutting down and also polling.
      // Render will restart this process anyway - just log instead of an
      // unhandled-rejection crash with a confusing stack trace.
      console.error('Bot launch error (often transient during redeploy):', err.message);
    });
}).catch(err => { console.error('MongoDB connection error:', err.message); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

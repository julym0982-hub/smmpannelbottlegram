require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const KPAY_NUMBER = process.env.KPAY_NUMBER || '09xxxxxxxxx';
const KPAY_NAME = process.env.KPAY_NAME || 'Your Name';
const WAVE_NUMBER = process.env.WAVE_NUMBER || '09xxxxxxxxx';
const WAVE_NAME = process.env.WAVE_NAME || 'Your Name';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing in environment variables. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- in-memory conversation state (per telegram user id) ----------
// state.step values: null, 'awaiting_topup_screenshot', 'awaiting_topup_amount',
// 'awaiting_coupon_code', 'awaiting_send_message_target', 'awaiting_send_message_text',
// 'awaiting_all_message_text', 'admin_awaiting_edit_amount', 'admin_awaiting_add_service_*'
const state = {};
function getState(id) {
  if (!state[id]) state[id] = {};
  return state[id];
}
function clearState(id) {
  state[id] = {};
}

function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

// ---------- text constants ----------
const WELCOME_QUOTE = (name) =>
  `မဂ္ဂလာပါ ${name} ရေ ❤️\nlike/views တိုး bot မှ ကြိုဆိုပါတယ်ရှင့် 😊`;

const BTN_SERVICES = '❤️ရရှိနိုင်သောservice များ❤️';
const BTN_BALANCE = '💰လက်ကျန်ငွေ💰';
const BTN_TOPUP = '💰ငွေဖြည့်ရန်💰';
const BTN_HISTORY = '📜Order History📜';
const BTN_COUPON = 'Cupon⁉️';
const BTN_BACK = '◀️ နောက်ပြန်ဆုတ်ရန်';

// Unicode "bold" versions used only inside inline button labels
// (Telegram buttons cannot render Markdown, so real bold characters are used instead)
const BOLD_TELEGRAM = '𝐓𝐞𝐥𝐞𝐠𝐫𝐚𝐦';
const BOLD_TIKTOK = '𝐓𝐢𝐤𝐭𝐨𝐤';
const BOLD_FACEBOOK = '𝐅𝐚𝐜𝐞𝐛𝐨𝐨𝐤';

function mainMenuKeyboard() {
  return Markup.keyboard([
    [BTN_SERVICES],
    [BTN_BALANCE],
    [BTN_TOPUP],
    [BTN_HISTORY],
    [BTN_COUPON]
  ]).resize();
}

function backOnlyKeyboard() {
  return Markup.keyboard([[BTN_BACK]]).resize();
}

function platformInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(BOLD_TELEGRAM, 'platform_telegram')],
    [Markup.button.callback(BOLD_TIKTOK, 'platform_tiktok')],
    [Markup.button.callback(BOLD_FACEBOOK, 'platform_facebook')]
  ]);
}

function topupMethodKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Kpay ဖြင့်ငွေသွင်းရန်', 'topup_kpay')],
    [Markup.button.callback('Wave ဖြင့်ငွေသွင်းရန်', 'topup_wave')]
  ]);
}

// ---------- middleware: block banned users, and never crash on blocked-bot errors ----------
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      const u = db.getUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
      if (u.banned && !isAdmin(ctx.from.id)) {
        return ctx.reply('သင့်အကောင့်ကို ယာယီ ပိတ်ထားပါသည်ရှင့်။ Admin ကို ဆက်သွယ်ပါ။');
      }
    }
    await next();
  } catch (err) {
    console.error('Handler error:', err && err.message);
  }
});

// safe-send helper: swallow "bot was blocked by the user" (403) errors so one
// blocked user can never crash the whole broadcast / bot process
async function safeSend(chatId, text, extra) {
  try {
    await bot.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch (err) {
    const desc = err && err.response && err.response.description;
    if (desc && (desc.includes('blocked') || desc.includes('chat not found') || desc.includes('deactivated'))) {
      // user blocked the bot / deleted account - ignore silently
      return false;
    }
    console.error('safeSend error:', desc || (err && err.message));
    return false;
  }
}

// =====================================================================
// /start
// =====================================================================
bot.start(async (ctx) => {
  clearState(ctx.from.id);
  const name = ctx.from.first_name || ctx.from.username || 'User';
  const quoted = WELCOME_QUOTE(name)
    .split('\n')
    .map(line => '> ' + line)
    .join('\n');

  await ctx.replyWithMarkdownV2(escapeMdV2(quoted), mainMenuKeyboard());

  if (isAdmin(ctx.from.id)) {
    await ctx.reply(ADMIN_HELP_TEXT);
  }
});

const ADMIN_HELP_TEXT =
`👑 Admin Commands\n\n` +
`/ban <id> - user ကို ပိတ်မည်\n` +
`/unban <id> - user ပိတ်ထားခြင်းကို ဖြေမည်\n` +
`/addmoney <id> <amount> - user ငွေဖြည့်ပေးမည်\n` +
`/decreasemoney <id> <amount> - user ငွေလျှော့မည်\n` +
`/+id - service id အသစ်ထည့်မည်\n` +
`/-id <platform> <serviceId> - service id ဖျက်မည်\n` +
`/checkorders - order များအားလုံးကြည့်မည်\n` +
`/-order <orderId> - order ဖျက်မည်\n` +
`/totaluser - user စုစုပေါင်းကြည့်မည်\n` +
`/sendmessage <id> <message> - user တစ်ယောက်ကို စာပို့မည်\n` +
`/allsendmessage <message> - user အားလုံးကို စာပို့မည်\n` +
`/cuponcode <amount> <count> [code] - cupon code ထုတ်မည်`;

// helper to escape MarkdownV2 special chars except the ">" quote marker we add ourselves
function escapeMdV2(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (m) => (m === '>' ? '>' : '\\' + m));
}

// =====================================================================
// Main menu button handlers
// =====================================================================
bot.hears(BTN_SERVICES, async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply('မိမိတိုးချင်တဲ့ social media တစ်ခုခု ရွေးပါရှင့် ❤️', platformInlineKeyboard());
  await ctx.reply('⬇️ အောက်ကနေ ပြန်ဆုတ်လိုပါက အောက်ပါ ခလုတ်ကို နှိပ်ပါ', backOnlyKeyboard());
});

bot.hears(BTN_BACK, async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply('🏠 မူလ menu သို့ ပြန်သွားပါပြီရှင့်', mainMenuKeyboard());
});

bot.hears(BTN_BALANCE, async (ctx) => {
  const u = db.getUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const name = ctx.from.first_name || ctx.from.username || 'User';
  await ctx.reply(
    `မဂ္ဂလာပါ ${name} လက်ကျန်ငွေ (${u.balance}) ကျန်ရှိပါသေးတယ်ရှင့် ❤️`,
    Markup.inlineKeyboard([[Markup.button.callback('ငွေထည့်ရန်', 'go_topup')]])
  );
});

bot.hears(BTN_TOPUP, async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard());
});

bot.hears(BTN_HISTORY, async (ctx) => {
  const orders = db.ordersForUser(ctx.from.id);
  if (!orders.length) {
    return ctx.reply('📜 Order မှတ်တမ်း မရှိသေးပါရှင့်။');
  }
  const lines = orders.slice(-15).reverse().map(o =>
    `#${o.orderId} | ${o.service || '-'} | ${o.amount || '-'} ကျပ် | ${o.status}`
  );
  await ctx.reply('📜 Order History (နောက်ဆုံး 15)\n\n' + lines.join('\n'));
});

bot.hears(BTN_COUPON, async (ctx) => {
  getState(ctx.from.id).step = 'awaiting_coupon_code';
  await ctx.reply('🎁 Cupon code ကို ရိုက်ထည့်ပေးပါရှင့်');
});

// =====================================================================
// Platform selection -> show services (placeholder until admin adds services)
// =====================================================================
bot.action(/^platform_(telegram|tiktok|facebook)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const platform = ctx.match[1];
  const services = db.getServices(platform);
  if (!services.length) {
    return ctx.reply('😔 ဒီ platform အတွက် service များ မထည့်ရသေးပါ။ မကြာမီ ထည့်ပေးပါမယ်ရှင့်။');
  }
  const lines = services.map(s => `#${s.id} - ${s.name} - ${s.price} ကျပ် (min ${s.min}/max ${s.max})`);
  await ctx.reply(`${platform.toUpperCase()} services:\n\n` + lines.join('\n') +
    `\n\nဝယ်ယူရန် service id ကို "/order <id> <quantity> <link>" ပုံစံဖြင့် ပို့ပါရှင့်။`);
});

// =====================================================================
// Top-up flow
// =====================================================================
bot.action('go_topup', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard());
});

bot.action('topup_kpay', async (ctx) => {
  await ctx.answerCbQuery();
  getState(ctx.from.id).method = 'KPay';
  getState(ctx.from.id).step = 'awaiting_topup_screenshot';
  await ctx.reply(
    `အနည်းဆုံး 1000 ကျပ်မှ စဖြည့်ပါရှင့် ❤️\n\n` +
    `kpay - ${KPAY_NUMBER}\n` +
    `name - ${KPAY_NAME}\n\n` +
    `ဆီသို့ ငွေလွှဲပြီး screenshot ပို့ပေးပါရှင့်`
  );
});

bot.action('topup_wave', async (ctx) => {
  await ctx.answerCbQuery();
  getState(ctx.from.id).method = 'Wave';
  getState(ctx.from.id).step = 'awaiting_topup_screenshot';
  await ctx.reply(
    `အနည်းဆုံး 1000 ကျပ်မှ စဖြည့်ပါရှင့် ❤️\n\n` +
    `Wave - ${WAVE_NUMBER}\n` +
    `Name - ${WAVE_NAME}\n\n` +
    `ဆီသို့ ငွေလွှဲပြီး screenshot ပို့ပေးပါရှင့်`
  );
});

// user sends screenshot photo
bot.on('photo', async (ctx) => {
  const st = getState(ctx.from.id);
  if (st.step !== 'awaiting_topup_screenshot') return; // ignore unrelated photos
  const photos = ctx.message.photo;
  st.screenshotFileId = photos[photos.length - 1].file_id;
  st.step = 'awaiting_topup_amount';
  await ctx.reply('ငွေထည့်ထားတဲ့ ပမာဏလေး ရေးပေးပါရှင့် ❤️');
});

// Myanmar-digit detector (၀-၉)
const MYANMAR_DIGITS = /[၀-၉]/;

bot.on('text', async (ctx, next) => {
  const st = getState(ctx.from.id);
  const text = ctx.message.text.trim();

  if (st.step === 'awaiting_topup_amount') {
    if (MYANMAR_DIGITS.test(text)) {
      return ctx.reply('မြန်မာလို ၁၂၃၄၅၆၇၈၉၀ ဂဏန်းတွေ ရေးရင်လည်း English လိုဘဲ ရေးပေးပါရှင့် 😊');
    }
    if (!/^[0-9]+$/.test(text)) {
      return ctx.reply('ငွေလွှဲထားတဲ့ ဂဏန်းနံပါတ်လေးကို English လိုဘဲ ရေးပေးပါရှင့် 😊');
    }
    const amount = parseInt(text, 10);
    st.amount = amount;
    st.step = null;

    // notify admins with photo + Confirm / Edit Amount buttons
    const caption =
      `🧾 ငွေဖြည့်တောင်းဆိုမှု\n` +
      `User: ${ctx.from.first_name || ''} (@${ctx.from.username || '-'})\n` +
      `User ID: ${ctx.from.id}\n` +
      `နည်းလမ်း: ${st.method || '-'}\n` +
      `ပမာဏ: ${amount} ကျပ်`;

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendPhoto(adminId, st.screenshotFileId, {
          caption,
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', `confirm_${ctx.from.id}_${amount}`)],
            [Markup.button.callback('✏️ Edit Amount', `editamt_${ctx.from.id}_${amount}`)]
          ]).reply_markup
        });
      } catch (err) {
        console.error('Failed to notify admin', adminId, err.message);
      }
    }

    await ctx.reply('Admin သို့ ငွေလွှဲထားကြောင်း တင်ပြပေးထားပါတယ်ရှင့် 😊\nခေတ္တခဏ စောင့်ပေးပါနော်', mainMenuKeyboard());
    return;
  }

  if (st.step === 'awaiting_coupon_code') {
    st.step = null;
    const code = text.toUpperCase();
    const coupon = db.getCoupon(code);
    if (!coupon || coupon.remaining <= 0) {
      return ctx.reply('❌ Cupon code မှားနေပါသည် သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီရှင့်။');
    }
    db.useCoupon(code);
    db.addBalance(ctx.from.id, coupon.amount);
    return ctx.reply(`🎉 Cupon code အောင်မြင်ပါသည်! သင့်အကောင့်ထဲသို့ ${coupon.amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့်။`);
  }

  // admin: typing new amount after pressing "Edit Amount"
  if (st.step === 'admin_awaiting_edit_amount' && isAdmin(ctx.from.id)) {
    if (!/^[0-9]+$/.test(text)) {
      return ctx.reply('ဂဏန်းသက်သက်ဖြင့်သာ ရေးပေးပါ။');
    }
    const newAmount = parseInt(text, 10);
    const targetUserId = st.editTargetUserId;
    const oldAmount = st.editOldAmount;
    st.step = null;
    db.addBalance(targetUserId, newAmount);
    await ctx.reply(`✅ ${targetUserId} အတွက် ${newAmount} ကျပ် ထည့်ပေးလိုက်ပါပြီ။`);
    await safeSend(targetUserId,
      `သင်ဖြည့်ထားသောငွေပမာဏမှာ ${newAmount} ဖြစ်သောကြောင့် သင့်အကောင့်ထဲသို့ ${newAmount} ကျပ် ထည့်ပေးထားပါတယ်ရှင့် ❤️`
    );
    return;
  }

  // admin: broadcasting to one user
  if (st.step === 'admin_awaiting_send_message_text' && isAdmin(ctx.from.id)) {
    const target = st.sendMessageTarget;
    st.step = null;
    const ok = await safeSend(target, text);
    return ctx.reply(ok ? '✅ ပို့ပြီးပါပြီ။' : '❌ ပို့မရပါ (user က bot ကို block ထားနိုင်သည်)။');
  }

  if (st.step === 'admin_awaiting_all_message_text' && isAdmin(ctx.from.id)) {
    st.step = null;
    const users = db.allUsers();
    let sent = 0;
    for (const u of users) {
      const ok = await safeSend(u.id, text);
      if (ok) sent++;
    }
    return ctx.reply(`✅ User ${sent}/${users.length} ဆီကို ပို့ပြီးပါပြီ။`);
  }

  return next();
});

// admin confirms a top-up
bot.action(/^confirm_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.match[1];
  const amount = parseInt(ctx.match[2], 10);
  db.addBalance(userId, amount);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(`✅ User ${userId} အတွက် ${amount} ကျပ် အောင်မြင်စွာ ထည့်ပြီးပါပြီ။`);
  await safeSend(userId, `ငွေ (${amount} ကျပ်) ထည့်ခြင်း အောင်မြင်ပါသည်ရှင့် ❤️`, mainMenuKeyboard());
});

// admin wants to edit the amount before crediting
bot.action(/^editamt_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.match[1];
  const oldAmount = parseInt(ctx.match[2], 10);
  const st = getState(ctx.from.id);
  st.step = 'admin_awaiting_edit_amount';
  st.editTargetUserId = userId;
  st.editOldAmount = oldAmount;
  await ctx.reply('ပြောင်းလဲလိုသော amount အားရိုက်ထည့်ပါ');
});

// =====================================================================
// Admin text commands
// =====================================================================
function requireAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) {
    ctx.reply('❌ ဒီ command ကို Admin သာ အသုံးပြုနိုင်ပါသည်။');
    return false;
  }
  return true;
}

bot.command('ban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /ban <user_id>');
  const u = db.setBanned(id, true);
  if (!u) return ctx.reply('User မတွေ့ပါ။');
  await ctx.reply(`🚫 User ${id} ကို ပိတ်လိုက်ပါပြီ။`);
});

bot.command('unban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('ပုံစံ: /unban <user_id>');
  const u = db.setBanned(id, false);
  if (!u) return ctx.reply('User မတွေ့ပါ။');
  await ctx.reply(`✅ User ${id} ကို ပြန်ဖွင့်ပေးလိုက်ပါပြီ။`);
});

bot.command('addmoney', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1], amount = parseFloat(parts[2]);
  if (!id || isNaN(amount)) return ctx.reply('ပုံစံ: /addmoney <user_id> <amount>');
  const u = db.addBalance(id, amount);
  if (!u) return ctx.reply('User မတွေ့ပါ။');
  await ctx.reply(`✅ User ${id} လက်ကျန်ငွေ: ${u.balance} ကျပ်`);
  await safeSend(id, `Admin မှ သင့်အကောင့်ထဲသို့ ${amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့် ❤️`);
});

bot.command('decreasemoney', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1], amount = parseFloat(parts[2]);
  if (!id || isNaN(amount)) return ctx.reply('ပုံစံ: /decreasemoney <user_id> <amount>');
  const u = db.addBalance(id, -amount);
  if (!u) return ctx.reply('User မတွေ့ပါ။');
  await ctx.reply(`✅ User ${id} လက်ကျန်ငွေ: ${u.balance} ကျပ်`);
  await safeSend(id, `Admin မှ သင့်အကောင့်ထဲမှ ${amount} ကျပ် နှုတ်ယူလိုက်ပါပြီရှင့်။`);
});

// /+id -> start "add service" wizard
bot.command(['+id', 'addid'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const st = getState(ctx.from.id);
  st.step = 'admin_add_service_platform';
  await ctx.reply(
    'Service ထည့်မည့် platform ကို ရွေးပါ',
    Markup.inlineKeyboard([
      [Markup.button.callback('Telegram', 'addsvc_platform_telegram')],
      [Markup.button.callback('Tiktok', 'addsvc_platform_tiktok')],
      [Markup.button.callback('Facebook', 'addsvc_platform_facebook')]
    ])
  );
});

bot.action(/^addsvc_platform_(telegram|tiktok|facebook)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const st = getState(ctx.from.id);
  st.step = 'admin_add_service_details';
  st.newServicePlatform = ctx.match[1];
  await ctx.reply(
    'Service အချက်အလက်ကို အောက်ပုံစံအတိုင်း တစ်ကြောင်းတည်း ပို့ပါ:\n\n' +
    'id|name|price|min|max\n\n' +
    'ဥပမာ: 1234|Telegram Members|50|100|10000'
  );
});

bot.on('text', async (ctx, next) => {
  const st = getState(ctx.from.id);
  if (st.step === 'admin_add_service_details' && isAdmin(ctx.from.id)) {
    const parts = ctx.message.text.split('|').map(s => s.trim());
    if (parts.length !== 5) {
      return ctx.reply('ပုံစံမှားနေပါသည်။ id|name|price|min|max အတိုင်း ပို့ပါ။');
    }
    const [id, name, price, min, max] = parts;
    db.addService(st.newServicePlatform, { id, name, price: Number(price), min: Number(min), max: Number(max) });
    st.step = null;
    return ctx.reply(`✅ ${st.newServicePlatform} platform ထဲသို့ service "${name}" ထည့်ပြီးပါပြီ။`);
  }
  return next();
});

// /-id <platform> <serviceId>
bot.command(['-id', 'removeid'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const platform = parts[1], serviceId = parts[2];
  if (!platform || !serviceId) return ctx.reply('ပုံစံ: /-id <platform> <serviceId>');
  const ok = db.removeService(platform.toLowerCase(), serviceId);
  await ctx.reply(ok ? '✅ Service ဖျက်ပြီးပါပြီ။' : '❌ Service မတွေ့ပါ။');
});

bot.command('checkorders', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const orders = db.allOrders();
  if (!orders.length) return ctx.reply('Order များ မရှိသေးပါ။');
  const lines = orders.slice(-30).reverse().map(o =>
    `#${o.orderId} | user:${o.userId} | ${o.service || '-'} | ${o.amount || '-'} | ${o.status}`
  );
  await ctx.reply('📋 Orders (နောက်ဆုံး 30):\n\n' + lines.join('\n'));
});

// /-order <orderId>
bot.command(['-order', 'removeorder'], async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const orderId = ctx.message.text.split(' ')[1];
  if (!orderId) return ctx.reply('ပုံစံ: /-order <orderId>');
  const ok = db.removeOrder(orderId);
  await ctx.reply(ok ? '✅ Order ဖျက်ပြီးပါပြီ။' : '❌ Order မတွေ့ပါ။');
});

bot.command('totaluser', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply(`👥 Total users: ${db.allUsers().length}`);
});

bot.command('sendmessage', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  const rest = ctx.message.text.split(' ').slice(2).join(' ');
  if (!id) return ctx.reply('ပုံစံ: /sendmessage <user_id> [message]\n(message ကို မထည့်ရင် နောက်စာကြောင်းမှာ ရေးလို့ရပါတယ်)');
  if (rest) {
    const ok = await safeSend(id, rest);
    return ctx.reply(ok ? '✅ ပို့ပြီးပါပြီ။' : '❌ ပို့မရပါ။');
  }
  const st = getState(ctx.from.id);
  st.step = 'admin_awaiting_send_message_text';
  st.sendMessageTarget = id;
  await ctx.reply('ပို့လိုသော message ကို ရိုက်ထည့်ပါ');
});

bot.command('allsendmessage', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const rest = ctx.message.text.split(' ').slice(1).join(' ');
  if (rest) {
    const users = db.allUsers();
    let sent = 0;
    for (const u of users) {
      if (await safeSend(u.id, rest)) sent++;
    }
    return ctx.reply(`✅ User ${sent}/${users.length} ဆီကို ပို့ပြီးပါပြီ။`);
  }
  const st = getState(ctx.from.id);
  st.step = 'admin_awaiting_all_message_text';
  await ctx.reply('User အားလုံးသို့ ပို့လိုသော message ကို ရိုက်ထည့်ပါ');
});

// /cuponcode <amount> <count> [code]
bot.command('cuponcode', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const amount = parseFloat(parts[1]);
  const count = parseInt(parts[2], 10);
  let code = parts[3];
  if (!amount || !count) return ctx.reply('ပုံစံ: /cuponcode <amount> <count> [custom_code]');
  if (!code) {
    code = 'SMM' + Math.random().toString(36).slice(2, 8).toUpperCase();
  } else {
    code = code.toUpperCase();
  }
  db.addCoupon(code, amount, count);
  await ctx.reply(`🎁 Cupon code ထုတ်ပြီးပါပြီ။\n\nCode: ${code}\nတန်ဖိုး: ${amount} ကျပ်\nအသုံးပြုနိုင်သူ: ${count} ယောက်`);
});

// =====================================================================
// Placeholder for placing an order against the SMM API (ShweBoost etc.)
// Fill in SHWEBOOST_API_URL / SHWEBOOST_API_KEY in .env once service IDs
// are added with /+id. This function is not wired to a button yet because
// no service IDs exist yet, per your request.
// =====================================================================
async function placeExternalOrder(serviceId, link, quantity) {
  const url = process.env.SHWEBOOST_API_URL;
  const key = process.env.SHWEBOOST_API_KEY;
  if (!url || !key) throw new Error('SHWEBOOST_API_URL / SHWEBOOST_API_KEY not configured yet.');
  const resp = await axios.post(url, {
    key,
    action: 'add',
    service: serviceId,
    link,
    quantity
  });
  return resp.data;
}

bot.command('order', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const serviceId = parts[1], quantity = parts[2], link = parts[3];
  if (!serviceId || !quantity || !link) {
    return ctx.reply('ပုံစံ: /order <service_id> <quantity> <link>');
  }
  await ctx.reply('⚠️ Service ID များကို admin မှ မထည့်ရသေးပါ။ မကြာမီ order တင်နိုင်ပါမယ်ရှင့်။');
  // Once services + SHWEBOOST_API_KEY are configured, uncomment below:
  // try {
  //   const result = await placeExternalOrder(serviceId, link, quantity);
  //   const order = db.addOrder({ userId: ctx.from.id, service: serviceId, amount: quantity, status: 'pending' });
  //   await ctx.reply(`✅ Order #${order.orderId} တင်ပြီးပါပြီ။`);
  // } catch (err) {
  //   await ctx.reply('❌ Order တင်၍ မရပါ: ' + err.message);
  // }
});

// =====================================================================
// global error catcher - keeps the whole bot process alive
// =====================================================================
bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.updateType}:`, err);
});

// =====================================================================
// launch: tiny express server (for Render Web Service health checks) + polling
// =====================================================================
const app = express();
app.get('/', (req, res) => res.send('SMM Telegram bot is running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health-check server listening on port ${PORT}`));

bot.launch().then(() => console.log('Bot launched (long polling).'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

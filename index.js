require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');
const { MenuButton, Platform, User, Category, Service, Order, Coupon, Deposit, AdminLog, HelpRequest, Counter } = require('./models');
const providers = require('./providers');
const texts = require('./texts');
const mountAdminPanel = require('./admin');
const retention = require('./retention');
const ai = require('./ai');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI;
// KPay/Wave numbers are editable at runtime via /setkpay and /setwave
// (stored through texts.js so they persist in MongoDB) - the .env values
// above are only the first-time defaults.

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
let panel = null; // set once the web admin panel is mounted (see bottom of file)
const state = {};
function st(id) { if (!state[id]) state[id] = { level: 'root' }; return state[id]; }
function resetState(id) { state[id] = { level: 'root' }; }

function isAdmin(id) { return ADMIN_IDS.includes(String(id)); }

// Never expose upstream provider names, API URLs, HTTP status codes, or raw
// provider responses to customers. Detailed errors remain in server logs.
function customerError(fallback = 'ဆောင်ရွက်ရာတွင် ခေတ္တအခက်အခဲ ဖြစ်နေပါသည်။ ခဏနေပြီး ပြန်ကြိုးစားပေးပါရှင့်။') {
  return `❌ ${fallback}`;
}

// Logs use only a neutral category; raw upstream messages can reveal the
// supplier name, endpoint, or response body.
function failureCode(err) {
  const message = String(err && err.message || err).toLowerCase();
  if (/cloudflare|challenge|403|blocked/.test(message)) return 'UPSTREAM_ACCESS_BLOCKED';
  if (/timeout|timed out|econn|network|redirect/.test(message)) return 'UPSTREAM_CONNECTION_FAILED';
  if (/balance|insufficient/.test(message)) return 'UPSTREAM_BALANCE_OR_LIMIT';
  if (/service|unknown|not found/.test(message)) return 'SERVICE_CONFIGURATION_ERROR';
  return 'UPSTREAM_REQUEST_FAILED';
}

function logFailure(label, err) {
  console.error(`${label}: ${failureCode(err)}`);
}

// sale price for one order, including the user's personal reseller discount
// (set from the admin panel). Always rounded UP so we never sell below cost.
function priceFor(user, service, quantity) {
  const base = providers.calcSaleCost(service.provider, service.rate, quantity);
  const d = Math.min(100, Math.max(0, Number(user && user.discount) || 0));
  return d ? Math.max(1, Math.ceil(base * (1 - d / 100))) : base;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Telegram first_name/username come from the USER and are never trusted:
// they can contain control characters, huge repeated emoji spam, markdown
// special characters, zero-width characters, or thousands of characters.
// This keeps every place we display "the user's name" safe and short.
function sanitizeName(raw) {
  if (!raw) return 'User';
  let s = String(raw)
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '') // control/invisible/RTL-override chars
    .trim();
  if (!s) return 'User';
  if (s.length > 40) s = s.slice(0, 40) + '…'; // hard cap - blocks "spam wall of text" names
  return s;
}
function displayName(from) {
  return sanitizeName(from.first_name || from.username || 'User');
}
// escapes legacy-Markdown special characters so a hostile name can never
// break formatting (or worse, inject fake markdown/links) in admin views
// that use parse_mode: 'Markdown' (e.g. /users, /userinfo)
function escapeMarkdown(text) {
  return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

// ---------------------------------------------------------------------
// basic per-user flood control - a burst of messages (script/spam attack)
// gets silently throttled instead of hammering MongoDB/Telegram/provider
// APIs on every single keystroke
// ---------------------------------------------------------------------
const lastMsgTimes = {};
function isFlooding(userId) {
  const now = Date.now();
  const arr = (lastMsgTimes[userId] = lastMsgTimes[userId] || []).filter(t => now - t < 3000);
  arr.push(now);
  lastMsgTimes[userId] = arr;
  return arr.length > 8; // more than 8 messages in 3 seconds = flooding
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
const BTN_HELP = '🆘 Order အကူအညီ';

// HTML-safe text for messages that contain user-provided strings (links, names)
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const helpOn = () => texts.t('help_enabled') !== '0';
const shorten = (t, n = 48) => (String(t).length > n ? String(t).slice(0, n) + '…' : String(t));
const STATUS_ICON = { completed: '🟢', pending: '🟡', processing: '🟡', 'in progress': '🟡', partial: '🟠', canceled: '🔴', cancelled: '🔴', error: '🔴' };
const statusIcon = (st) => STATUS_ICON[String(st || '').toLowerCase()] || '⚪';
// customer-facing order number (tap to copy in Telegram thanks to <code>)
const orderRef = (o) => (o.orderNo ? String(o.orderNo) : String(o._id).slice(-6));

// next sequential order number (10001, 10002, ...) - atomic
async function nextOrderNo() {
  const c = await Counter.findOneAndUpdate({ _id: 'orderNo' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return 10000 + c.seq;
}
// orders created before order numbers existed get one (oldest first)
async function migrateOrderNos() {
  for (let i = 0; i < 20; i++) {
    const old = await Order.find({ orderNo: { $exists: false } }).sort({ createdAt: 1 }).limit(500);
    if (!old.length) return;
    for (const o of old) { o.orderNo = await nextOrderNo(); await o.save(); }
  }
}

async function mainMenuKeyboard() {
  const extras = await MenuButton.find({});
  const rows = [[BTN_SERVICES], [BTN_BALANCE], [BTN_TOPUP], [BTN_HISTORY]];
  if (helpOn()) rows.push([BTN_HELP]);
  rows.push([BTN_COUPON]);
  for (const b of extras) rows.push([b._id]);
  return Markup.keyboard(rows).resize();
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

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Run broadcasts outside the Telegram update handler so mass messaging does
// not delay replies to other users. The delay helps avoid rate-limit bursts.
function startBroadcast(adminId, recipients, text) {
  setImmediate(async () => {
    let sent = 0;
    for (const recipientId of recipients) {
      if (await safeSend(recipientId, text)) sent++;
      await delay(75);
    }
    await safeSend(adminId, `✅ Broadcast ပြီးပါပြီ။ User ${sent}/${recipients.length} ဆီ ပို့နိုင်ပါတယ်။`);
  });
}

async function getOrCreateUser(from) {
  const safeUsername = sanitizeName(from.username || '');
  const safeFirstName = sanitizeName(from.first_name || '');
  let u = await User.findById(String(from.id));
  if (!u) {
    u = await User.create({ _id: String(from.id), username: from.username ? safeUsername : '', firstName: from.first_name ? safeFirstName : '' });
  } else {
    let changed = false;
    if (from.username && u.username !== safeUsername) { u.username = safeUsername; changed = true; }
    if (from.first_name && u.firstName !== safeFirstName) { u.firstName = safeFirstName; changed = true; }
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
      // flood/spam protection - a burst of rapid messages (bot/script
      // attack, or accidental double-tapping) gets silently dropped instead
      // of hammering MongoDB and the provider APIs on every message
      if (!isAdmin(ctx.from.id) && isFlooding(ctx.from.id)) return;

      // hard cap on incoming text length - defends against someone pasting
      // megabytes of text/code (attempted injection, log-spam, or just an
      // accidental huge paste) into any text field the bot reads
      if (ctx.message && typeof ctx.message.text === 'string' && ctx.message.text.length > 2000) {
        return ctx.reply('⚠️ Message အရမ်းရှည်နေပါတယ်၊ ပိုတိုတိုလေး ပို့ပေးပါရှင့်။');
      }

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
const ADMIN_GUIDE = [
`👑 Admin Guide (၁/၇) — မိတ်ဆက်

မင်္ဂလာပါ Admin ရေ! ဒီ guide ကို အဆင့်ဆင့် ဖတ်ပြီး လိုက်လုပ်ရုံပါပဲ။ Command တစ်ခုချင်းစီကို ဘယ်လိုသုံးရမလဲ ဥပမာနဲ့ တကွ ရှင်းပြထားပါတယ်။

**ပထမဆုံး လုပ်ရမည့် အဆင့် ၃ ဆင့်**:
1️⃣ Home button ဆောက်ပါ (Telegram Service/Tiktok Service/...)
2️⃣ ဒီ home button တွေထဲကို category + service (emoji button) တွေ ထည့်ပါ
3️⃣ Kpay/Wave payment number ထည့်ပါ

🌐 **Admin Panel (website)**: /adminlogin ကို ပို့ရင် panel ဝင်ရန် button link ပို့ပေးမည် (Admin မဟုတ်သူများဆီ ဘာမှ မပြန်ပါ)။ Panel ထဲမှာ ငွေဖြည့်ခြင်း၊ order၊ user၊ service၊ coupon၊ broadcast အားလုံး စီမံနိုင်သည်။

အောက်က message တွေမှာ တစ်ခုချင်းစီကို အသေးစိတ် ဆက်ပြောပေးပါမယ်။`,

`👑 Admin Guide (၂/၇) — Home button ဆောက်ခြင်း

Home button ဆိုတာက user တွေ ❤️ရရှိနိုင်သောservice များ❤️ နှိပ်တာနဲ့ အရင်ဆုံး မြင်ရမယ့် ခလုတ်တွေပါ (ဥပမာ - "Telegram Service", "Tiktok Service")

**Command**: /addhomebutton <key> <label...>
- key = internal name (English small letter, space မပါရ) ဥပမာ telegram
- label = user မြင်ရမယ့် စာသား

**လက်တွေ့ ဥပမာ** (ဒီအတိုင်း တစ်ကြောင်းစီ ကူးပို့ပါ):
/addhomebutton telegram Telegram Service
/addhomebutton tiktok Tiktok Service
/addhomebutton facebook Facebook Service

ဒါဆို user ❤️ရရှိနိုင်သောservice များ❤️ နှိပ်တာနဲ့ Telegram/Tiktok/Facebook ဆိုတဲ့ button ၃ ခု (bold) မြင်ရပါပြီ။

ဖျက်ရန်: /removehomebutton telegram (category/service အားလုံးပါ ပါ ဖျက်မည်)`,

`👑 Admin Guide (၃/၇) — Service (emoji button) ထည့်ခြင်း

Home button ထဲကို service (ဥပမာ ♥️,👍 reaction emoji, သို့ Views) ထည့်ဖို့ command ၂ မျိုး ရှိပါတယ်:

**A) တစ်ကြောင်းတည်းနဲ့ ချက်ချင်းထည့်ခြင်း (ကျွမ်းကျင်သွားရင် ပိုမြန်ပါတယ်):**
/addbutton <platform_key>|<category_label>|<button_label>|<provider>|<provider_service_id>

ဥပမာများ (ShweBoost/Secsers ဝဘ်ဆိုက်ထဲက Services page ကနေ service id ကို ကူးယူပါ):
/addbutton telegram|Reaction တိုးရန်❤️|♥️|shweboost|1234
/addbutton telegram|Reaction တိုးရန်❤️|👍|shweboost|1235
/addbutton telegram|Views တိုးရန်👀|-|shweboost|5678
/addbutton tiktok|Tiktok like👍|-|secsers|9001
/addbutton telegram|Reaction တိုးရန်❤️|🔥|hiroshi|42

- category_label တူတူ ထပ်ရေးရင် category တစ်ခုထဲကို service အများကြီး ပေါင်းထည့်ပေးမည် (ဥပမာ ♥️,👍,🔥 အားလုံး "Reaction တိုးရန်❤️" ထဲ ရောက်မည်)
- category ထဲ service **တစ်ခုတည်း** ရှိရင် (ဥပမာ Views) user က category ကို နှိပ်တာနဲ့ တန်းပြီး link တောင်းမည်
- button_label နေရာမှာ "-" ရေးရင် provider ပေးထားတဲ့ service name ကိုပဲ အလိုအလျောက် သုံးမည်
- rate/min/max ကို command ထဲ ရေးစရာ မလိုပါ - provider API ကနေ အလိုအလျောက် ဆွဲပေးမည်

**B) အဆင့်ဆင့် မေးမြန်းစနစ် (command ရေးနည်း မကျွမ်းကျင်သေးရင်):**
/addid ကို ပို့လိုက်ရင် bot က Platform → Category → Provider → Service id → Button label အစဉ်လိုက် မေးပေးပါလိမ့်မယ်`,

`👑 Admin Guide (၄/၇) — Service စစ်ဆေးခြင်း/ပြင်ဆင်ခြင်း

/services - Home button/Category/Service အားလုံးကို id များနှင့်တကွ ပြပေးမည်။ ဘာမှ မြင်ရရင် ဒီ command ကို အမြဲသုံးပြီး sanity check လုပ်ပါ

/removeid <serviceMongoId> - service (emoji button) တစ်ခုတည်း ဖျက်ရန်
   ဥပမာ: /removeid 66a2f3d2c1a9b0012e4f5678
/removecategory <categoryMongoId> - category တစ်ခုလုံး (service အားလုံးပါ) ဖျက်ရန်

/syncservices - service အားလုံးရဲ့ rate/min/max ကို provider API မှ ပြန်ဆွဲ update လုပ်မည် (provider ဘက်က ဈေးနှုန်း ပြောင်းနိုင်လို့ ရံဖန်ရံခါ run ပေးရင် ကောင်းပါတယ်)

**ဈေးနှုန်း formula ကို bot ထဲကနေ ချက်ချင်း ပြောင်းရန်** (Render env var ပြင်စရာ၊ redeploy လုပ်စရာ မလိုပါ):
/setrate <shweboost|secsers|hiroshi> <USD→MMK rate> <markup>
ဥပမာ: /setrate shweboost 2100 2.3
   (ShweBoost က $1 ကို 2100 ကျပ်နှုန်းဖြင့် တွက်ပြီး 2.3 ဆ ထပ်မြှောက်မည် — ဆိုလိုသည်မှာ user ဆီ ပြမည့် ကျသင့်ငွေ = USD ကုန်ကျစရိတ် × 2100 × 2.3)
ဥပမာ: /setrate secsers 4400 1

/testcost <serviceMongoId> <quantity> - user ဆီ ပြမည့် ဈေးနှုန်း တွက်ချက်ပုံ (rate, USD→MMK conversion, markup) အသေးစိတ် ပြပေးမည် - ဈေးနှုန်း မှန်မမှန် စစ်ဖို့ အသုံးဝင်ပါတယ်

/setduration <serviceMongoId> <text> - ကြာချိန် manual ရေးထည့်ရန်
   ဥပမာ: /setduration 66a2f3d2c1a9b0012e4f5678 18 မိနစ်
   (ShweBoost API မှာ ကြာချိန် data လုံးဝ မပါလာတာကြောင့် ဒါကို ရေးမထားရင် "အနည်းငယ်ကြာနိုင်ပါတယ်ရှင့်" လို့ပဲ user ဆီ ပြသွားမည်)`,

`👑 Admin Guide (၅/၇) — ငွေဖြည့်ခြင်း/User/Order

**Kpay/Wave number ပြောင်းရန်** (redeploy မလိုပါ, ချက်ချင်း update ဖြစ်မည်):
/setkpay 09123456789 Nan Su
/setwave 09123456789 Nan Su

**ငွေဖြည့်ရန် အနည်းဆုံးပမာဏ ပြောင်းရန်** (default 1000 ကျပ်):
/settopupmin 1500
(ဒါလုပ်ရင် user မလုံလောက်တဲ့ ပမာဏ ရေးရင် "အနည်းဆုံး 1500ကျပ်မှ ငွေစသွင်းပါရှင့်" လို့ ငြင်းပယ်ပြီး ပြန်ရေးခိုင်းမည်)

**User management**:
/ban 123456789 - user ကို ပိတ်မည်
/unban 123456789 - ပြန်ဖွင့်မည်
/addmoney 123456789 5000 - balance ထဲ ၅၀၀၀ ကျပ် ထည့်မည်
/decreasemoney 123456789 5000 - balance ထဲက ၅၀၀၀ ကျပ် နှုတ်မည်
/users - user list (10 ယောက်/page)၊ /users 2 လို့ ရေးရင် page ၂ ကို ကြည့်ရမည်
/userinfo 123456789 - user တစ်ဦးချင်း အသေးစိတ် (balance, order history)
/totaluser - user စုစုပေါင်း

**Order management**:
/checkorders - order အားလုံး (နောက်ဆုံး ၃၀ခု)
/removeorder <orderMongoId> - order မှတ်တမ်းမှ ဖျက်ရန် (provider ဘက်က order ကို မထိပါ၊ database မှတ်တမ်းကိုပဲ ဖျက်တာပါ)
/providerbalance - ShweBoost/Secsers account ထဲ ကျန်ရှိငွေ စစ်ရန်`,

`👑 Admin Guide (၆/၇) — Message/Coupon/Custom menu button

**User ဆီ message ပို့ရန်**:
/sendmessage 123456789 မင်္ဂလာပါရှင့် - user တစ်ယောက်ထဲကို ပို့မည်
/sendmessage 123456789 - message မရေးဘဲ ID တစ်ခုတည်း ပို့ရင် bot က "ဘာစာပို့ချင်လဲ" ပြန်မေးမည်
/allsendmessage သတင်းအသစ်ရှိပါတယ်ရှင့် - user အားလုံးဆီ တစ်ချိန်တည်း ပို့မည်

**Coupon ထုတ်ရန်**:
/cuponcode <amount> <count> [code]
ဥပမာ: /cuponcode 100 5 (100 ကျပ်တန်း coupon ကို ၅ ယောက်စာ အသုံးပြုနိုင်အောင် random code ထုတ်မည်)
ဥပမာ (code ကိုယ်တိုင်ပေးလိုရင်): /cuponcode 100 5 WELCOME100
⚠️ Code တစ်ခုကို user တစ်ယောက်စီက **တစ်ကြိမ်သာ** အသုံးပြုနိုင်ပါသည် (ထပ်ရေးရင် "အသုံးပြုပြီးပါပြီ" ဟု ငြင်းပယ်မည်)

**Coupon ကို ဘယ်နှစ်ယောက် သုံးထားလဲ / ဘယ်သူတွေ သုံးထားလဲ ကြည့်ရန်**:
/couponinfo <code>
ဥပမာ: /couponinfo WELCOME100
(ဒါက ထုတ်ထားသောစုစုပေါင်း၊ သုံးပြီးသားအရေအတွက်၊ ကျန်ရှိအရေအတွက်၊ ပြီးသုံးထားသူများ၏ နာမည်+id list ကို ပြပေးမည်)

**Main menu ထဲ button အသစ် ထည့်ရန်** (ဥပမာ - "Contact Admin" နှိပ်ရင် admin ရဲ့ Telegram chat ကို ရောက်စေရန်):
/addmenubutton ☎️ Contact Admin|https://t.me/YourAdminUsername
(YourAdminUsername နေရာမှာ ကိုယ့် Telegram username ကို အစားထိုးပါ)

ဖျက်ရန်: /removemenubutton ☎️ Contact Admin (label အတိအကျ ကူးရေးရပါမည်)`,

`👑 Admin Guide (၇/၇) — Bot ပို့တဲ့ message စာသားများ ပြင်ရန်

Bot ပို့တဲ့ message တွေ (welcome, balance message, order confirm, စသည်) ကို code မထိဘဲ ဒီကနေ ပြင်လို့ရပါတယ်:

/texts - ပြင်လို့ရသော key အားလုံးကို ကြည့်ရန်
/edittext <key> <new text> - ပြင်ရန်

ဥပမာ: /edittext welcome မင်္ဂလာပါ \${name} ရေ ❤️ ကျွန်တော်တို့ shop ကို ကြိုဆိုပါတယ်

⚠️ \${name}, \${balance}, \${cost} စသည် placeholder တွေကို အတိအကျ ထားခဲ့ပါ - ဒါမှ user နာမည်/ငွေပမာဏ အစား ထည့်ပေးနိုင်မှာပါ။ /texts ထဲက key list ကို ကြည့်ရင် ဘယ် key မှာ ဘယ် placeholder ရှိလဲ သိနိုင်ပါတယ်။

--- 
ဒီ guide ကို ပြန်ကြည့်ချင်ရင် /start ကို ထပ်နှိပ်ရုံပါပဲ။ Command တစ်ခုခု မှားနေရင် (ဥပမာ /-id လိုမျိုး "-" "+"ဖြင့် စတဲ့ command) Telegram က command အဖြစ် လုံးဝ အသိအမှတ်မပြုပါဘူး - ဒီ guide ထဲက command အတိအကျကိုပဲ သုံးပါ။`
];

async function sendAdminGuide(ctx) {
  for (const section of ADMIN_GUIDE) {
    await ctx.reply(section, { parse_mode: 'Markdown' }).catch(() => ctx.reply(section));
  }
}

bot.start(async (ctx) => {
  resetState(ctx.from.id);
  const name = displayName(ctx.from);
  await ctx.reply(texts.t('welcome', { name }), await mainMenuKeyboard());
  if (isAdmin(ctx.from.id)) await sendAdminGuide(ctx);
});

// =======================================================================
// Back button - context-aware based on state.level
// =======================================================================
bot.hears(BTN_BACK, async (ctx) => {
  const s = st(ctx.from.id);
  if (s.level === 'platform') {
    resetState(ctx.from.id);
    return ctx.reply('🏠 မူလ menu သို့ ပြန်သွားပါပြီရှင့်', await mainMenuKeyboard());
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
  return ctx.reply('🏠 မူလ menu သို့ ပြန်သွားပါပြီရှင့်', await mainMenuKeyboard());
});

// =======================================================================
// Main menu buttons
// =======================================================================
bot.hears(BTN_SERVICES, async (ctx) => { resetState(ctx.from.id); st(ctx.from.id).level = 'platform'; await showPlatformMenu(ctx); });

bot.hears(BTN_BALANCE, async (ctx) => {
  const name = displayName(ctx.from);
  await ctx.reply(
    texts.t('balance_msg', { name, balance: ctx.dbUser.balance }),
    Markup.inlineKeyboard([[Markup.button.callback('ငွေထည့်ရန်', 'go_topup')]])
  );
});

bot.hears(BTN_TOPUP, async (ctx) => { resetState(ctx.from.id); await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard()); });

// paginated, tidy order history (5 per page) with copyable order numbers
async function sendHistory(ctx, page = 1, edit = false) {
  const uid = String(ctx.from.id);
  const per = 5;
  const total = await Order.countDocuments({ userId: uid });
  if (!total) { return ctx.reply('📜 Order မှတ်တမ်း မရှိသေးပါရှင့်။'); }
  const pages = Math.ceil(total / per);
  page = Math.min(Math.max(1, page), pages);
  const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).skip((page - 1) * per).limit(per);
  await refreshOrderStatuses(orders).catch(err => console.error('refresh error', err.message));

  const lines = [`📜 <b>Order History</b>  (${page}/${pages})\n<i>Order ID ကို နှိပ်ရင် copy ကူးလို့ရပါတယ်</i>\n`];
  const rows = [];
  for (const o of orders) {
    const ref = orderRef(o);
    lines.push(
      `${statusIcon(o.status)} <code>${ref}</code> · <b>${esc(`${o.categoryLabel || ''} ${o.serviceLabel || ''}`.trim())}</b>\n` +
      `   🔢 ${nf(o.quantity)}  ·  💰 ${nf(o.cost)} ကျပ်  ·  ${esc(o.status)}${o.remains != null && Number(o.remains) > 0 ? `  ·  ကျန် ${nf(o.remains)}` : ''}\n` +
      `   🔗 ${esc(shorten(o.link))}`
    );
    const btns = [];
    if (helpOn()) btns.push(Markup.button.callback(`🆘 Help #${ref}`, `help_o_${o._id}`));
    if (['pending', 'in progress', 'processing'].includes(String(o.status).toLowerCase())) btns.push(Markup.button.callback(`❌ Cancel #${ref}`, `cancel_order_${o._id}`));
    if (btns.length) rows.push(btns);
  }
  if (pages > 1) {
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('◀️ နောက်', `hist_${page - 1}`));
    nav.push(Markup.button.callback(`${page}/${pages}`, 'noop'));
    if (page < pages) nav.push(Markup.button.callback('ရှေ့ ▶️', `hist_${page + 1}`));
    rows.push(nav);
  }
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: Markup.inlineKeyboard(rows).reply_markup };
  const text = lines.join('\n\n');
  if (edit) {
    try { return await ctx.editMessageText(text, extra); } catch (_) { /* unchanged / too old - send a new one */ }
  }
  return ctx.reply(text, extra);
}
bot.hears(BTN_HISTORY, async (ctx) => { resetState(ctx.from.id); await sendHistory(ctx, 1); });
bot.action(/^hist_(\d+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendHistory(ctx, parseInt(ctx.match[1], 10), true); });
bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.hears(BTN_COUPON, async (ctx) => { st(ctx.from.id).level = 'coupon'; await ctx.reply('🎁 Cupon code ကို ရိုက်ထည့်ပေးပါရှင့်'); });

// =======================================================================
// Platform -> Category -> Service navigation (bottom keyboard, scrollable)
// =======================================================================
async function showPlatformMenu(ctx) {
  const platforms = await Platform.find({}).sort({ _id: 1 }).lean();
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
  const cats = await Category.find({ platform }).lean();
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
  const services = await Service.find({ categoryId: category._id, active: { $ne: false } });
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
  const duration = formatted ? `${formatted} ဖြစ်ပါတယ်ရှင့် ❤️` : 'အနည်းငယ်ကြာနိုင်ပါတယ်ရှင့် ♥️';
  await ctx.reply(texts.t('ask_link', { duration }));
}

// =======================================================================
// Text handler for the whole state machine (order flow, topup flow,
// coupon redemption, and every admin text-based wizard step)
// =======================================================================
const MYANMAR_DIGITS = /[၀-၉]/;

// every reply-keyboard button the bot shows (fixed ones + admin-added ones are
// handled by the MenuButton lookup above). Used to keep the AI from answering them.
function isMenuButtonText(t) {
  return [BTN_SERVICES, BTN_BALANCE, BTN_TOPUP, BTN_HISTORY, BTN_COUPON, BTN_BACK, BTN_HELP].includes(t);
}

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const s = st(ctx.from.id);

  // any real command (starts with "/") must always reach the command
  // handlers below - never let leftover menu/wizard state swallow it
  if (text.startsWith('/')) return next();

  // admin-added custom menu buttons (e.g. "☎️ Contact Admin") work from
  // anywhere, regardless of what menu/wizard state the user is currently in
  const customBtn = await MenuButton.findOne({ _id: text });
  if (customBtn) {
    return ctx.reply('👇', Markup.inlineKeyboard([[Markup.button.url(text, customBtn.url)]]));
  }

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
    const service = await Service.findOne({ categoryId: s.categoryId, label: text, active: { $ne: false } });
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
    if (!service || service.active === false) { resetState(ctx.from.id); return ctx.reply('❌ Service မတွေ့ပါ၊ ပြန်လည် ရွေးပေးပါ။', await mainMenuKeyboard()); }
    if (quantity < service.min || quantity > service.max) {
      return ctx.reply(`⚠️ quantity သည် ${service.min} နှင့် ${service.max} ကြားဖြစ်ရပါမည်။`);
    }
    let cost;
    try {
      cost = priceFor(ctx.dbUser, service, quantity);
    } catch (err) {
      logFailure('customer order cost calculation failed', err);
      return ctx.reply(customerError());
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

  // ---- help order: customer types an Order ID ----
  if (s.level === 'help_id') {
    if (!helpOn()) { resetState(ctx.from.id); return ctx.reply(texts.t('help_disabled')); }
    const no = parseInt(text.replace(/^#/, ''), 10);
    const order = /^#?\d{1,12}$/.test(text) ? await Order.findOne({ orderNo: no, userId: String(ctx.from.id) }) : null;
    if (!order) return ctx.reply(texts.t('help_not_found'));
    resetState(ctx.from.id);
    return showHelpCard(ctx, order);
  }

  // ---- coupon redeem ----
  if (s.level === 'coupon') {
    resetState(ctx.from.id);
    const code = text.toUpperCase();
    const userId = String(ctx.from.id);
    const coupon = await Coupon.findById(code);
    if (!coupon) return ctx.reply('❌ Cupon code မှားနေပါသည်ရှင့်။');
    if (coupon.usedBy.includes(userId)) return ctx.reply('❌ ဒီ Cupon code ကို ခင်ဗျား အသုံးပြုပြီးပါပြီရှင့် - တစ်ယောက်ကို တစ်ကြိမ်သာ အသုံးပြုနိုင်ပါသည်။');
    if (coupon.remaining <= 0) return ctx.reply('❌ ဒီ Cupon code ကို သတ်မှတ်ထားသော ကန့်သတ်ချက် ပြည့်သွားပါပြီရှင့်။');
    // one atomic update: two people (or one person double-tapping) can never
    // both squeeze through the last remaining use
    const claimed = await Coupon.findOneAndUpdate(
      { _id: code, remaining: { $gt: 0 }, usedBy: { $ne: userId } },
      { $inc: { remaining: -1 }, $push: { usedBy: userId } },
      { new: true }
    );
    if (!claimed) return ctx.reply('❌ ဒီ Cupon code ကို အသုံးပြု၍ မရတော့ပါရှင့်။');
    await User.findByIdAndUpdate(userId, { $inc: { balance: coupon.amount } });
    return ctx.reply(`🎉 Cupon code အောင်မြင်ပါသည်! သင့်အကောင့်ထဲသို့ ${coupon.amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့်။`);
  }

  // ---- topup: amount typed after sending screenshot ----
  if (s.level === 'topup_amount') {
    if (MYANMAR_DIGITS.test(text)) return ctx.reply('မြန်မာလို ၁၂၃၄၅၆၇၈၉၀ ဂဏန်းတွေ ရေးရင်လည်း English လိုဘဲ ရေးပေးပါရှင့် 😊');
    if (!/^[0-9]+$/.test(text)) return ctx.reply('ငွေလွှဲထားတဲ့ ဂဏန်းနံပါတ်လေးကို English လိုဘဲ ရေးပေးပါရှင့် 😊');
    const amount = parseInt(text, 10);
    const minAmount = parseInt(texts.t('topup_min_amount'), 10) || 1000;
    if (amount < minAmount) {
      return ctx.reply(texts.t('topup_below_min', { min: minAmount })); // stays on this step so they can retype
    }
    const pending = await Deposit.countDocuments({ userId: String(ctx.from.id), status: 'pending' });
    if (pending >= 5) {
      resetState(ctx.from.id);
      return ctx.reply('⚠️ စစ်ဆေးဆဲ ငွေဖြည့်တောင်းဆိုမှု များနေပါသည်ရှင့်။ Admin အတည်ပြုပြီးမှ ထပ်တင်ပေးပါနော်။', await mainMenuKeyboard());
    }
    const dep = await Deposit.create({
      userId: String(ctx.from.id), method: s.method || '-', amount, requestedAmount: amount,
      screenshotFileId: s.screenshotFileId
    });
    s.level = 'root';
    await notifyAdminsNewDeposit(dep, ctx.from);
    await ctx.reply(texts.t('topup_submitted'), await mainMenuKeyboard());
    return;
  }

  // ---- admin: edit top-up amount before crediting ----
  if (s.level === 'admin_edit_amount' && isAdmin(ctx.from.id)) {
    if (!/^[0-9]+$/.test(text) || parseInt(text, 10) <= 0) return ctx.reply('ဂဏန်းသက်သက်ဖြင့်သာ ရေးပေးပါ။');
    const newAmount = parseInt(text, 10);
    const depositId = s.editDepositId;
    const targetUserId = s.editTargetUserId;
    resetState(ctx.from.id);
    if (depositId) {
      const res = await approveDeposit(depositId, { amount: newAmount, by: `bot:${ctx.from.id}` });
      if (res.ok) return ctx.reply(`✅ User ${res.deposit.userId} အတွက် ${newAmount} ကျပ် ပြင်ဆင်ပြီး ထည့်ပေးလိုက်ပါပြီ။`);
      return ctx.reply(res.error === 'already_handled' ? `ℹ️ ဒီတောင်းဆိုမှုကို ကိုင်တွယ်ပြီးသားပါ (${res.deposit && res.deposit.status})။` : '❌ တောင်းဆိုမှု မတွေ့ပါ။');
    }
    // legacy notification (sent before deposits were stored in the database)
    await User.findByIdAndUpdate(targetUserId, { $inc: { balance: newAmount } });
    await ctx.reply(`✅ ${targetUserId} အတွက် ${newAmount} ကျပ် ထည့်ပေးလိုက်ပါပြီ။`);
    await safeSend(targetUserId, texts.t('topup_edited', { amount: newAmount }));
    return;
  }

  // ---- admin: send message to one user / all users ----
  if (s.level === 'admin_send_one' && isAdmin(ctx.from.id)) {
    const target = s.sendMessageTarget; resetState(ctx.from.id);
    const ok = await safeSend(target, text);
    return ctx.reply(ok ? '✅ ပို့ပြီးပါပြီ။' : '❌ ပို့မရပါ (block ထားနိုင်သည်)။');
  }
  if (s.level === 'admin_send_all' && isAdmin(ctx.from.id)) {
    const adminId = String(ctx.from.id);
    resetState(ctx.from.id);
    const users = await User.find({}).select('_id').lean();
    startBroadcast(adminId, users.map(u => String(u._id)), text);
    return ctx.reply(`✅ User ${users.length} ယောက်ဆီ စာပို့ခြင်းကို စတင်လိုက်ပါပြီ။ Bot ကို ဆက်သုံးနိုင်ပါတယ်။`);
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
    await ctx.reply('Provider ကို ရေးပါ: shweboost, secsers, hiroshi တစ်ခုခု');
    return;
  }
  if (s.level === 'admin_addid_provider' && isAdmin(ctx.from.id)) {
    const provider = text.toLowerCase();
    if (!['shweboost', 'secsers', 'hiroshi'].includes(provider)) return ctx.reply('shweboost, secsers, hiroshi တစ်ခုခုကိုသာ ရေးပါ။');
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
      refill: s.newServiceInfo.refill,
      cancel: s.newServiceInfo.cancel,
      lastSynced: new Date()
    });
    resetState(ctx.from.id);
    await ctx.reply(
      `✅ Service ထည့်ပြီးပါပြီ။\nHome button: ${platform.label} (key: ${platform._id})\nCategory: ${category.label}\nButton label: ${label}\nService mongo id (ဖျက်ရန် /removeid သုံးမည့် id): ${service._id}`
    );
    return;
  }

  // menu button presses must NEVER go to the AI - let the matching
  // bot.hears(...) handler (some are registered further down) take them
  if (isMenuButtonText(text)) return next();

  // free text while the customer is not inside a menu step -> AI assistant
  if (s.level === 'root' && await aiReply(ctx, text)) return;
  return next();
});

// =======================================================================
// AI chat: any free text that is not part of a menu step is answered by the
// assistant (keys + prompt + daily limit are managed in Panel > AI Bot).
// =======================================================================
let aiAlertAt = 0;
async function aiReply(ctx, text) {
  if (!ai.enabled() || !(await ai.hasKeys())) return false; // not configured -> stay silent like before
  if (bot.telegram.sendChatAction) bot.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  const res = await ai.chat({
    userId: String(ctx.from.id), name: displayName(ctx.from), balance: ctx.dbUser ? ctx.dbUser.balance : null, text: text.slice(0, 1000)
  });
  if (res.ok) { await ctx.reply(res.text.slice(0, 4000)); return true; }
  if (res.reason === 'limit') { await ctx.reply(texts.t('ai_limit_msg')); return true; }
  console.error('AI reply failed:', res.reason);
  await ctx.reply(texts.t('ai_fallback'));
  // tell the admins (at most once an hour) so empty / broken keys get fixed
  if (Date.now() - aiAlertAt > 3600 * 1000) {
    aiAlertAt = Date.now();
    for (const id of ADMIN_IDS) await safeSend(id, `⚠️ AI Bot မဖြေနိုင်ပါ (${res.reason}): ${res.detail || ''}\nPanel > AI Bot မှာ API key / model ကို စစ်ပါ။`);
  }
  return true;
}

// =======================================================================
// Top-up flow
// =======================================================================
bot.action('go_topup', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('ငွေဖြည့်မည့် နည်းလမ်း ရွေးပါရှင့် ❤️', topupMethodKeyboard()); });

bot.action('topup_kpay', async (ctx) => {
  await ctx.answerCbQuery();
  const s = st(ctx.from.id); s.method = 'KPay'; s.level = 'topup_screenshot';
  await ctx.reply(`${texts.t('topup_min', { min: texts.t('topup_min_amount') })}\n\nkpay - ${texts.t('kpay_number')}\nname - ${texts.t('kpay_name')}\n\n${texts.t('topup_ask_screenshot')}`);
});
bot.action('topup_wave', async (ctx) => {
  await ctx.answerCbQuery();
  const s = st(ctx.from.id); s.method = 'Wave'; s.level = 'topup_screenshot';
  await ctx.reply(`${texts.t('topup_min', { min: texts.t('topup_min_amount') })}\n\nWave - ${texts.t('wave_number')}\nName - ${texts.t('wave_name')}\n\n${texts.t('topup_ask_screenshot')}`);
});

bot.on('photo', async (ctx) => {
  const s = st(ctx.from.id);
  if (s.level !== 'topup_screenshot') return;
  const photos = ctx.message.photo;
  s.screenshotFileId = photos[photos.length - 1].file_id;
  s.level = 'topup_amount';
  await ctx.reply(texts.t('topup_ask_amount'));
});

// ---------------------------------------------------------------------
// Deposits: the same approve / reject / edit logic is used by the Telegram
// buttons below AND the web admin panel (admin.js). The atomic
// pending -> approved/rejected switch guarantees one credit only, even if
// both places are tapped at the same moment.
// ---------------------------------------------------------------------
const MAX_TOPUP = 100000000;
function validAmount(n) { return Number.isFinite(n) && n > 0 && n <= MAX_TOPUP && Math.floor(n) === n; }

async function notifyAdminsNewDeposit(dep, from) {
  const caption = `🧾 ငွေဖြည့်တောင်းဆိုမှု\nUser: ${displayName(from)} (@${from.username || '-'})\nUser ID: ${from.id}\nနည်းလမ်း: ${dep.method || '-'}\nပမာဏ: ${dep.amount} ကျပ်`;
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm', `dep_ok_${dep._id}`), Markup.button.callback('❌ Reject', `dep_no_${dep._id}`)],
    [Markup.button.callback('✏️ Edit Amount', `dep_edit_${dep._id}`)]
  ]).reply_markup;
  const sent = [];
  for (const adminId of ADMIN_IDS) {
    try {
      const m = await bot.telegram.sendPhoto(adminId, dep.screenshotFileId, { caption, reply_markup: markup });
      sent.push({ chatId: String(adminId), messageId: m.message_id });
    } catch (err) { console.error('notify admin failed', err.message); }
  }
  if (sent.length) await Deposit.findByIdAndUpdate(dep._id, { adminMessages: sent });
}

// after a deposit is handled (from the bot OR the panel), strip the buttons
// from every admin's notification and show the result, so nobody taps stale buttons
async function refreshDepositMessages(dep) {
  const label = dep.status === 'approved'
    ? `✅ APPROVED — ${dep.amount} ကျပ်${dep.amount !== dep.requestedAmount ? ` (user တောင်းခဲ့သည်: ${dep.requestedAmount})` : ''}`
    : `❌ REJECTED${dep.note ? ' — ' + dep.note : ''}`;
  const by = dep.handledBy === 'panel' ? 'Admin Panel' : (dep.handledBy || '').replace('bot:', 'Admin ');
  for (const m of dep.adminMessages || []) {
    try {
      await bot.telegram.editMessageCaption(
        m.chatId, m.messageId, undefined,
        `🧾 ငွေဖြည့်တောင်းဆိုမှု\nUser ID: ${dep.userId}\nနည်းလမ်း: ${dep.method || '-'}\n\n${label}\n(${by})`,
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) { /* message too old / already edited - harmless */ }
  }
}

async function approveDeposit(id, { amount, by } = {}) {
  const current = await Deposit.findById(id).catch(() => null);
  if (!current) return { ok: false, error: 'not_found' };
  const finalAmount = amount != null ? amount : current.amount;
  if (!validAmount(finalAmount)) return { ok: false, error: 'bad_amount', deposit: current };
  const dep = await Deposit.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { status: 'approved', amount: finalAmount, handledBy: by || 'panel', handledAt: new Date() },
    { new: true }
  );
  if (!dep) return { ok: false, error: 'already_handled', deposit: current };
  await User.findByIdAndUpdate(dep.userId, { $inc: { balance: dep.amount } });
  const edited = dep.requestedAmount != null && dep.amount !== dep.requestedAmount;
  await safeSend(dep.userId, texts.t(edited ? 'topup_edited' : 'topup_success', { amount: dep.amount }));
  await refreshDepositMessages(dep);
  return { ok: true, deposit: dep };
}

async function rejectDeposit(id, { reason, by } = {}) {
  const current = await Deposit.findById(id).catch(() => null);
  if (!current) return { ok: false, error: 'not_found' };
  const dep = await Deposit.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { status: 'rejected', note: reason || '', handledBy: by || 'panel', handledAt: new Date() },
    { new: true }
  );
  if (!dep) return { ok: false, error: 'already_handled', deposit: current };
  await safeSend(dep.userId, texts.t('topup_rejected', { amount: dep.amount, reason: reason ? `\nအကြောင်းရင်း: ${reason}` : '' }));
  await refreshDepositMessages(dep);
  return { ok: true, deposit: dep };
}

function depositReply(res) {
  if (res.ok) return null;
  if (res.error === 'already_handled') return `ℹ️ ဒီတောင်းဆိုမှုကို ကိုင်တွယ်ပြီးသားပါ (${res.deposit && res.deposit.status})။`;
  if (res.error === 'bad_amount') return '❌ ပမာဏ မမှန်ပါ။';
  return '❌ တောင်းဆိုမှု မတွေ့ပါ။';
}

bot.action(/^dep_ok_([0-9a-f]{24})$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const res = await approveDeposit(ctx.match[1], { by: `bot:${ctx.from.id}` });
  await ctx.reply(res.ok ? `✅ User ${res.deposit.userId} အတွက် ${res.deposit.amount} ကျပ် အောင်မြင်စွာ ထည့်ပြီးပါပြီ။` : depositReply(res));
});
bot.action(/^dep_no_([0-9a-f]{24})$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const res = await rejectDeposit(ctx.match[1], { by: `bot:${ctx.from.id}` });
  await ctx.reply(res.ok ? `❌ User ${res.deposit.userId} ရဲ့ တောင်းဆိုမှုကို ပယ်ချလိုက်ပါပြီ။` : depositReply(res));
});
bot.action(/^dep_edit_([0-9a-f]{24})$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const dep = await Deposit.findById(ctx.match[1]).catch(() => null);
  if (!dep) return ctx.reply('❌ တောင်းဆိုမှု မတွေ့ပါ။');
  if (dep.status !== 'pending') return ctx.reply(`ℹ️ ဒီတောင်းဆိုမှုကို ကိုင်တွယ်ပြီးသားပါ (${dep.status})။`);
  const s = st(ctx.from.id);
  s.level = 'admin_edit_amount';
  s.editDepositId = String(dep._id);
  await ctx.reply('ပြောင်းလဲလိုသော amount အားရိုက်ထည့်ပါ');
});

// legacy buttons (notifications sent before deposits were stored in MongoDB)
bot.action(/^confirm_topup_(\d+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery();
  const userId = ctx.match[1], amount = parseInt(ctx.match[2], 10);
  await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
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
  // claim the confirm step BEFORE any await, so a double tap can never place two orders
  const s = st(ctx.from.id);
  const wasConfirm = s.level === 'confirm';
  if (wasConfirm) s.level = 'placing';
  await ctx.answerCbQuery().catch(() => {});
  if (!wasConfirm) return;

  const service = await Service.findById(s.serviceId);
  if (!service || service.active === false) { resetState(ctx.from.id); return ctx.reply('❌ Error, ပြန်စမ်းကြည့်ပါ။', await mainMenuKeyboard()); }

  const uid = String(ctx.from.id);
  // take the money first with ONE conditional update: if the balance is not
  // enough nothing changes, and parallel orders can never overspend it
  const charged = await User.findOneAndUpdate(
    { _id: uid, balance: { $gte: s.cost } },
    { $inc: { balance: -s.cost, totalSpent: s.cost } },
    { new: true }
  );
  if (!charged) {
    resetState(ctx.from.id);
    const name = displayName(ctx.from);
    return ctx.reply(
      texts.t('insufficient_balance', { name }),
      Markup.inlineKeyboard([[Markup.button.callback('💰ငွေဖြည့်ရန်💰', 'go_topup')]])
    );
  }

  let providerOrderId;
  try {
    providerOrderId = await providers.placeOrder(service.provider, service.providerServiceId, s.link, s.quantity);
  } catch (err) {
    // provider refused -> give the money straight back
    await User.findByIdAndUpdate(uid, { $inc: { balance: s.cost, totalSpent: -s.cost } });
    resetState(ctx.from.id);
    logFailure('customer order submission failed', err);
    return ctx.reply(customerError('Order ကို လက်ခံဆောင်ရွက်နေစဉ် အခက်အခဲ ဖြစ်နေပါသည်။ ခဏနေပြီး ပြန်ကြိုးစားပေးပါရှင့်။'), await mainMenuKeyboard());
  }

  let baseCost, orderNo;
  try { baseCost = providers.calcBaseCost(service.provider, service.rate, s.quantity); } catch (_) { /* profit stat only */ }
  try { orderNo = await nextOrderNo(); } catch (err) { console.error('order number failed (will be filled in later):', err.message); }
  try {
    await Order.create({
      orderNo,
      userId: uid,
      serviceId: service._id,
      platform: s.platform,
      categoryLabel: s.categoryLabel,
      serviceLabel: s.serviceLabel,
      provider: service.provider,
      providerOrderId: String(providerOrderId),
      link: s.link,
      quantity: s.quantity,
      cost: s.cost,
      baseCost,
      status: 'pending'
    });
  } catch (err) {
    console.error(`Order saved at provider (${service.provider} #${providerOrderId}) but DB write failed:`, err.message);
  }

  const paid = s.cost;
  resetState(ctx.from.id);
  await ctx.reply(
    `${esc(texts.t('order_success', { cost: nf(paid) }))}\n\n🆔 Order ID: <code>${orderNo || '-'}</code>\n<i>(နှိပ်ရင် copy ကူးလို့ရပါတယ်၊ အကူအညီလိုရင် 🆘 Order အကူအညီ မှာ သုံးပါ)</i>`,
    { parse_mode: 'HTML', reply_markup: (await mainMenuKeyboard()).reply_markup }
  );
});

// =======================================================================
// Order status refresh + cancel
//
// IMPORTANT: cashback is only ever given here, when the provider's STATUS
// API confirms an order is actually "Canceled" - never just because a
// cancel *request* was accepted. This correctly covers both:
//   1) the user pressing "Cancel Order" (we submit the request, then wait)
//   2) the provider cancelling on its own later (refill/drip issues etc.)
// =======================================================================
const CANCELLED_STATUSES = ['canceled', 'cancelled'];

// One atomic switch (refunded: false -> true) decides who gets to refund,
// so the background sweep, the user's cancel button and the admin panel can
// never pay the same order back twice.
async function refundOrder(order, amount, kind = 'cancel') {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return false;
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, refunded: { $ne: true } },
    { refunded: true, refundAmount: amount, updatedAt: new Date() },
    { new: true }
  );
  if (!claimed) return false;
  order.refunded = true; order.refundAmount = amount;
  await User.findByIdAndUpdate(order.userId, { $inc: { balance: amount, totalSpent: -amount } });
  if (kind === 'partial') {
    await safeSend(order.userId, texts.t('order_partial_refund', { remains: Math.max(0, Number(order.remains) || 0), amount }));
  } else {
    await safeSend(order.userId, texts.t('order_cancel_success', { cost: amount }));
  }
  return true;
}
async function refundIfCancelled(order) { return refundOrder(order, order.cost, 'cancel'); }

// provider says "Partial": it delivered part of the quantity - return the
// money for the undelivered part (remains / quantity of the price)
async function refundIfPartial(order) {
  const remains = Number(order.remains) || 0;
  const quantity = Number(order.quantity) || 0;
  if (remains <= 0 || quantity <= 0) return false;
  const amount = Math.floor(order.cost * Math.min(remains, quantity) / quantity);
  return refundOrder(order, amount, 'partial');
}

async function refreshOrderStatuses(orders) {
  const active = orders.filter(o => !['completed', 'error'].includes(String(o.status).toLowerCase()) && !o.refunded);
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
        // the provider reports what it really charged us - use it for exact profit numbers
        if (info.charge !== undefined && Number.isFinite(Number(info.charge)) && (!info.currency || info.currency === 'USD')) {
          const usd = Number(texts.t(o.provider + '_usd_to_mmk')) || 0;
          if (usd > 0) o.baseCost = Math.ceil(Number(info.charge) * usd);
        }
        o.updatedAt = new Date();
        await o.save();

        const statusLower = String(o.status).toLowerCase();
        if (!wasCompleted && statusLower === 'completed') {
          await safeSend(o.userId, texts.t('order_complete', { link: o.link, service: o.serviceLabel || o.categoryLabel }));
        }
        if (CANCELLED_STATUSES.includes(statusLower)) {
          await refundIfCancelled(o);
        } else if (statusLower === 'partial') {
          await refundIfPartial(o);
        }
      }
    } catch (err) {
      logFailure('status refresh failed', err);
    }
  }
}

// submits the cancel request to the provider; the refund itself is paid later,
// only once the provider's status API confirms "Canceled" (see refreshOrderStatuses)
async function requestCancel(ctx, order) {
  if (!['pending', 'in progress', 'processing'].includes(String(order.status).toLowerCase())) {
    return ctx.reply('ℹ️ ဒီ order ကို cancel လုပ်၍ မရတော့ပါ။');
  }
  try {
    const submitted = await providers.cancelOrder(order.provider, order.providerOrderId);
    if (submitted) {
      await ctx.reply('🕐 Cancel request တင်ပြီးပါပြီရှင့်။ cancel တာအောင်မြင်တာနဲ့ cashback ပြန်ပေးပါမည် (မိနစ်အနည်းငယ် စောင့်ပေးပါနော်) ❤️');
    } else {
      await ctx.reply(texts.t('order_cancel_fail'));
    }
  } catch (err) {
    logFailure('customer order cancellation failed', err);
    await ctx.reply(customerError('Cancel တောင်းဆိုမှုကို ဆောင်ရွက်နေစဉ် အခက်အခဲ ဖြစ်နေပါသည်။ ခဏနေပြီး ပြန်ကြိုးစားပေးပါရှင့်။'));
  }
}

bot.action(/^cancel_order_([0-9a-fA-F]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const order = await Order.findById(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id)) return ctx.reply('❌ Order မတွေ့ပါ။');
  await requestCancel(ctx, order);
});

// =======================================================================
// 🆘 Help Order: the customer gives an Order ID and picks one of
//   ♻️ refill (dropped after completion) / ⚡ speed up / ❌ cancel + refund.
// Refill and cancel go to the provider API automatically when possible;
// anything the API cannot do becomes a request the admin follows up in the
// panel (Help page) - speed-up has no API in standard SMM panels.
// =======================================================================
const HELP_LABEL = { refill: '♻️ Refill (ပြန်ဖြည့်)', speed: '⚡ Speed up (မြန်ပေး)', cancel: '❌ Cancel + Refund' };

bot.hears(BTN_HELP, async (ctx) => {
  resetState(ctx.from.id);
  if (!helpOn()) return ctx.reply(texts.t('help_disabled'));
  st(ctx.from.id).level = 'help_id';
  const recent = await Order.find({ userId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(5);
  const rows = recent.map(o => [Markup.button.callback(`${statusIcon(o.status)} #${orderRef(o)} · ${shorten(`${o.categoryLabel || ''} ${o.serviceLabel || ''}`.trim(), 28)}`, `help_o_${o._id}`)]);
  await ctx.reply(texts.t('help_ask_id'), rows.length ? Markup.inlineKeyboard(rows) : undefined);
});

async function showHelpCard(ctx, order) {
  const text =
    `🆘 <b>Order</b> <code>${orderRef(order)}</code>\n` +
    `📦 ${esc(`${order.categoryLabel || ''} ${order.serviceLabel || ''}`.trim())}\n` +
    `🔢 ${nf(order.quantity)}  ·  🔗 ${esc(shorten(order.link, 60))}\n` +
    `📊 Status: <b>${esc(order.status)}</b>\n\n${esc(texts.t('help_choose'))}`;
  await ctx.reply(text, {
    parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('ပြန်ကျသွားလို့ ပြန်ဖြည့်ပေးပါ', `help_a_${order._id}_refill`)],
      [Markup.button.callback('နှေးနေလို့ မြန်ပေးပါ', `help_a_${order._id}_speed`)],
      [Markup.button.callback('ပယ်ဖျက်ပြီး ငွေပြန်ပေးပါ', `help_a_${order._id}_cancel`)]
    ]).reply_markup
  });
}

bot.action(/^help_o_([0-9a-fA-F]{24})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!helpOn()) return ctx.reply(texts.t('help_disabled'));
  const order = await Order.findById(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id)) return ctx.reply(texts.t('help_not_found'));
  resetState(ctx.from.id);
  await showHelpCard(ctx, order);
});

async function notifyAdminsHelp(hr, order, user) {
  const text =
    `🆘 <b>Help Request — ${hr.type === 'refill' ? 'Refill' : hr.type === 'speed' ? 'Speed up' : 'Cancel'}</b>${hr.auto ? '  (API ဖြင့် ပို့ပြီး)' : ''}\n` +
    `👤 ${esc(sanitizeName(user.firstName || user.username || user._id))} (<code>${user._id}</code>)\n` +
    `🆔 Order <code>${orderRef(order)}</code>  ·  ${esc(order.provider)} <code>${esc(order.providerOrderId)}</code>\n` +
    `📦 ${esc(`${order.categoryLabel || ''} ${order.serviceLabel || ''}`.trim())}\n` +
    `🔢 ${nf(order.quantity)}  ·  📊 ${esc(order.status)}\n🔗 ${esc(shorten(order.link, 80))}\n` +
    (hr.result ? `\n📝 ${esc(hr.result)}` : '');
  for (const id of ADMIN_IDS) {
    await bot.telegram.sendMessage(id, text, {
      parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ ဆောင်ရွက်ပြီး', `help_done_${hr._id}`)]]).reply_markup
    }).catch(err => console.error('notify admin (help) failed', err.message));
  }
}

bot.action(/^help_a_([0-9a-fA-F]{24})_(refill|speed|cancel)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!helpOn()) return ctx.reply(texts.t('help_disabled'));
  const type = ctx.match[2];
  const order = await Order.findById(ctx.match[1]);
  if (!order || order.userId !== String(ctx.from.id)) return ctx.reply(texts.t('help_not_found'));
  const status = String(order.status).toLowerCase();
  const done = status === 'completed';
  const cancelled = ['canceled', 'cancelled'].includes(status) || order.refunded;

  const svc = order.serviceId ? await Service.findById(order.serviceId).catch(() => null) : null;
  if (type === 'cancel') {
    if (svc && svc.cancel === false) return ctx.reply(texts.t('help_cancel_unsupported'));
    return requestCancel(ctx, order);
  }
  if (cancelled) return ctx.reply(texts.t('help_cancelled'));
  if (type === 'speed' && (done || status === 'partial')) return ctx.reply(texts.t('help_speed_done'));
  if (type === 'refill' && svc && svc.refill === false) return ctx.reply(texts.t('help_refill_unsupported'));
  if (type === 'refill' && !done) return ctx.reply(texts.t('help_refill_not_done'));

  // same request for the same order only once per 24h (stops button spamming)
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (await HelpRequest.findOne({ orderId: String(order._id), type, createdAt: { $gte: since } })) return ctx.reply(texts.t('help_cooldown'));

  let auto = false, result = '', refillId;
  if (type === 'refill') {
    try {
      const id = await providers.refillOrder(order.provider, order.providerOrderId);
      auto = true; refillId = String(id); result = `provider refill #${id} ပို့ပြီး`;
    } catch (err) {
      logFailure('customer refill request failed', err);
      result = 'API refill မရ - manual ဆောင်ရွက်ရန်';
    }
  } else { result = 'Speed-up: provider support ထံ manual တောင်းဆိုရန်'; }

  const hr = await HelpRequest.create({
    orderId: String(order._id), orderNo: order.orderNo, userId: order.userId, type, auto, result, refillId,
    provider: order.provider, providerOrderId: order.providerOrderId
  });
  await ctx.reply(auto ? texts.t('help_refill_ok') : texts.t('help_manual'), await mainMenuKeyboard());
  const user = await User.findById(order.userId);
  await notifyAdminsHelp(hr, order, user || { _id: order.userId });
});

// follows every refill sent through the API: when the provider reports it
// Completed / Rejected the customer is told automatically
async function refillSweep() {
  try {
    const open = await HelpRequest.find({ type: 'refill', status: 'open', auto: true, refillId: { $exists: true } }).limit(50);
    for (const hr of open) {
      try {
        const st = String(await providers.refillStatus(hr.provider, hr.refillId)).toLowerCase();
        if (st === 'completed') {
          const done = await HelpRequest.findOneAndUpdate({ _id: hr._id, status: 'open' }, { status: 'done', doneAt: new Date(), result: 'provider refill Completed' }, { new: true });
          if (done) await safeSend(hr.userId, texts.t('help_refill_completed', { orderNo: hr.orderNo || '' }));
        } else if (['rejected', 'canceled', 'cancelled', 'error', 'failed'].includes(st)) {
          const upd = await HelpRequest.findOneAndUpdate({ _id: hr._id, auto: true }, { auto: false, result: `provider refill ${st} - manual လိုအပ်` }, { new: true });
          if (upd) {
            await safeSend(hr.userId, texts.t('help_refill_rejected', { orderNo: hr.orderNo || '' }));
            for (const id of ADMIN_IDS) await safeSend(id, `⚠️ Refill ${st}: Order ${hr.orderNo} (${hr.provider} ${hr.providerOrderId}) - Panel > Help Orders မှာ manual စစ်ပါ။`);
          }
        }
      } catch (err) { logFailure('refill status check failed', err); }
      await delay(300);
    }
  } catch (err) { console.error('refillSweep error:', err.message); }
}
setInterval(() => { refillSweep(); }, 10 * 60 * 1000);

bot.action(/^help_done_([0-9a-fA-F]{24})$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const hr = await HelpRequest.findOneAndUpdate({ _id: ctx.match[1], status: 'open' }, { status: 'done', doneAt: new Date() }, { new: true });
  if (!hr) return ctx.reply('ℹ️ ဒီတောင်းဆိုမှုကို ကိုင်တွယ်ပြီးသားပါ (သို့) မတွေ့ပါ။');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await safeSend(hr.userId, texts.t('help_done', { orderNo: hr.orderNo || '' }));
  await ctx.reply(`✅ Help request ပြီးပါပြီ (User ကို အကြောင်းကြားပြီး)။`);
});

// background job: periodically refresh all still-active orders so users get
// the "completed" notification even if they never reopen Order History.
// Runs in small batches with delays so a large number of orders can never
// crash the bot or hammer the provider API.
async function backgroundStatusSweep() {
  try {
    // provider statuses arrive in mixed case ("Completed", "Canceled"...) - match case-insensitively,
    // otherwise finished orders keep filling the 200-order window and new ones are never checked
    const active = await Order.find({
      status: { $not: /^(completed|canceled|cancelled|error|partial)$/i },
      refunded: { $ne: true }
    }).sort({ createdAt: 1 }).limit(200);
    for (const batch of chunk(active, 40)) {
      await refreshOrderStatuses(batch);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('backgroundStatusSweep error:', err.message);
  }
}
setInterval(() => { backgroundStatusSweep(); }, 2 * 60 * 1000);

// =======================================================================
// Admin: user/ban/money commands
// =======================================================================
function requireAdmin(ctx) {
  // silently ignore for non-admins - we never want to confirm to a random
  // user that "/ban", "/addmoney" etc are even valid admin commands
  if (!isAdmin(ctx.from.id)) return false;
  return true;
}

// /adminlogin - sends the admin a one-time button link into the web panel.
// Anyone who is not an admin gets NO reply at all (the command looks unknown).
bot.command('adminlogin', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  if (!ctx.chat || ctx.chat.type !== 'private') return; // never post a login link into a group
  if (!panel) return ctx.reply('⚠️ Admin panel မစတင်သေးပါ။');
  const url = panel.createLoginUrl(ctx.from.id);
  if (!url) {
    return ctx.reply('⚠️ Panel URL မသတ်မှတ်ရသေးပါ။ Render ရဲ့ Environment ထဲမှာ PANEL_URL=https://your-app.onrender.com ထည့်ပေးပါ။');
  }
  const text = '🔐 Admin Panel\n\nအောက်ပါ button ကိုနှိပ်ပြီး ဝင်ပါ။ Link က ၅ မိနစ်အတွင်း တစ်ကြိမ်သာ သုံးလို့ရပါတယ် - တခြားသူကို မပို့ပါနဲ့။';
  if (/^https:\/\//i.test(url)) {
    return ctx.reply(text, Markup.inlineKeyboard([[Markup.button.url('🚀 Admin Panel ဝင်ရန်', url)]]));
  }
  // Telegram refuses non-https buttons (e.g. http://localhost during testing)
  return ctx.reply(`${text}\n\n${url}`);
});

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
  const lines = users.map(u => {
    const label = escapeMarkdown(sanitizeName(u.firstName || u.username || u._id));
    return `👤 [${label}](tg://user?id=${u._id})\nID: ${u._id} | Balance: ${u.balance} | Spent: ${u.totalSpent || 0}${u.banned ? ' | 🚫banned' : ''}`;
  });
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
    ? orders.map(o => `- #${o._id.toString().slice(-6)} ${escapeMarkdown(o.link)} (${o.status})`).join('\n')
    : 'Order မရှိသေးပါ';
  const label = escapeMarkdown(sanitizeName(u.firstName || u.username || u._id));
  const usernameSafe = escapeMarkdown(u.username || '-');
  await ctx.replyWithMarkdown(
    `👤 [${label}](tg://user?id=${u._id})\n` +
    `ID: ${u._id}\nUsername: @${usernameSafe}\nBalance: ${u.balance}\nTotal spent: ${u.totalSpent || 0}\nBanned: ${u.banned}\n\n` +
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

bot.command('addmenubutton', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const raw = ctx.message.text.split(' ').slice(1).join(' ');
  const parts = raw.split('|').map(s => s.trim());
  if (parts.length !== 2) {
    return ctx.reply(
      'ပုံစံ: /addmenubutton <button label>|<url>\n\n' +
      'ဥပမာ (Admin ရဲ့ Telegram chat ကို တန်းသွားစေရန်):\n' +
      '/addmenubutton ☎️ Contact Admin|https://t.me/YourAdminUsername\n\n' +
      '(url နေရာမှာ ဘယ် link ကိုမဆို ထည့်လို့ရသည် - Telegram profile link, Facebook page link, ဘာမဆို)'
    );
  }
  const [label, url] = parts;
  await MenuButton.findByIdAndUpdate(label, { _id: label, url }, { upsert: true });
  await ctx.reply(`✅ Menu button "${label}" ထည့်ပြီးပါပြီ (main menu ရဲ့ အောက်ဆုံးမှာ ပေါ်ပါလိမ့်မယ်)။`);
});

bot.command('removemenubutton', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const label = ctx.message.text.split(' ').slice(1).join(' ');
  if (!label) return ctx.reply('ပုံစံ: /removemenubutton <button label အတိအကျ>');
  const removed = await MenuButton.findByIdAndDelete(label);
  await ctx.reply(removed ? `✅ "${label}" ဖျက်ပြီးပါပြီ။` : '❌ ဒီ label နဲ့ menu button မတွေ့ပါ။');
});

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
    avgTime: info.avgTime, refill: info.refill, cancel: info.cancel, lastSynced: new Date()
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
  if (!['shweboost', 'secsers', 'hiroshi'].includes(provider.toLowerCase())) {
    return ctx.reply('❌ provider ကို shweboost, secsers, hiroshi တစ်ခုခုကိုသာ ရေးပါ။');
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
  const platforms = await Platform.find({}).sort({ _id: 1 }).lean();
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
      `Markup formula applied: x${texts.t(service.provider + '_usd_to_mmk')} (USD→MMK) x${texts.t(service.provider + '_markup')}\n` +
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
      svc.avgTime = info.avgTime; svc.refill = info.refill; svc.cancel = info.cancel; svc.lastSynced = new Date();
      await svc.save(); ok++;
    } catch (err) { fail++; }
  }
  await ctx.reply(`✅ Sync ပြီးပါပြီ - success ${ok}, fail ${fail}`);
});

bot.command('providerbalance', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const lines = [];
  for (const provider of ['shweboost', 'secsers', 'hiroshi']) {
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
    const name = u ? sanitizeName(u.firstName || u.username || o.userId) : o.userId;
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
    const users = await User.find({}).select('_id').lean();
    startBroadcast(String(ctx.from.id), users.map(u => String(u._id)), rest);
    return ctx.reply(`✅ User ${users.length} ယောက်ဆီ စာပို့ခြင်းကို စတင်လိုက်ပါပြီ။ Bot ကို ဆက်သုံးနိုင်ပါတယ်။`);
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
  await ctx.reply(`🎁 Cupon code ထုတ်ပြီးပါပြီ။\n\nCode: ${code}\nတန်ဖိုး: ${amount} ကျပ်\nအသုံးပြုနိုင်သူ: ${count} ယောက်\n\n(တစ်ယောက်ချင်းစီ ဒီ code ကို တစ်ကြိမ်သာ အသုံးပြုနိုင်ပါသည်)`);
});

bot.command('couponinfo', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const code = (ctx.message.text.split(' ')[1] || '').toUpperCase();
  if (!code) return ctx.reply('ပုံစံ: /couponinfo <code>');
  const coupon = await Coupon.findById(code);
  if (!coupon) return ctx.reply('❌ ဒီ code ကို ရှာမတွေ့ပါ။');
  const totalIssued = coupon.remaining + coupon.usedBy.length;
  let usedLines = 'သုံးသေးသူ မရှိပါ။';
  if (coupon.usedBy.length) {
    const users = await User.find({ _id: { $in: coupon.usedBy } }).lean();
    usedLines = coupon.usedBy.map(id => {
      const u = users.find(x => x._id === id);
      const label = u ? sanitizeName(u.firstName || u.username || id) : id;
      return `- ${label} (id: ${id})`;
    }).join('\n');
  }
  await ctx.reply(
    `🎁 Coupon: ${code}\n` +
    `တန်ဖိုး: ${coupon.amount} ကျပ်\n` +
    `ထုတ်ထားသော စုစုပေါင်း: ${totalIssued} ယောက်စာ\n` +
    `သုံးပြီးသား: ${coupon.usedBy.length} ယောက်\n` +
    `ကျန်ရှိ: ${coupon.remaining} ယောက်စာ\n\n` +
    `အသုံးပြုပြီးသူများ:\n${usedLines}`
  );
});

// =======================================================================
// Admin: editable texts
// =======================================================================
bot.command('setrate', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const provider = (parts[1] || '').toLowerCase();
  const usdToMmk = parts[2];
  const markup = parts[3];
  if (!['shweboost', 'secsers', 'hiroshi'].includes(provider) || !usdToMmk || !markup) {
    return ctx.reply(
      'ပုံစံ: /setrate <shweboost|secsers|hiroshi> <USD→MMK rate> <markup>\n\n' +
      'ဥပမာ (ShweBoost က $1 ကို 2100 ကျပ်နှုန်းဖြင့် တွက်ပြီး 2.3 ဆ markup တင်လိုရင်):\n' +
      '/setrate shweboost 2100 2.3\n\n' +
      'ဥပမာ (Secsers က $1=4400ကျပ်, markup မတင်လိုရင်):\n' +
      '/setrate secsers 4400 1\n\n' +
      'ဥပမာ (Hiroshi):\n' +
      '/setrate hiroshi 4400 2.3\n\n' +
      'ဖော်မြူလာ: ကျသင့်ငွေ = provider ရဲ့ USD ကုန်ကျစရိတ် × <USD→MMK rate> × <markup>'
    );
  }
  await texts.setText(`${provider}_usd_to_mmk`, usdToMmk);
  await texts.setText(`${provider}_markup`, markup);
  await ctx.reply(
    `✅ ${provider} ရဲ့ ဈေးနှုန်း formula ကို ချက်ချင်း ပြောင်းပြီးပါပြီ:\n` +
    `ကျသင့်ငွေ = USD ကုန်ကျစရိတ် × ${usdToMmk} × ${markup}\n\n` +
    `စစ်ဆေးရန် /testcost <serviceMongoId> <quantity> ကို run ကြည့်ပါ။`
  );
});

bot.command('settopupmin', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const amount = ctx.message.text.split(' ')[1];
  if (!amount || !/^[0-9]+$/.test(amount)) return ctx.reply('ပုံစံ: /settopupmin <amount>\nဥပမာ: /settopupmin 1500');
  await texts.setText('topup_min_amount', amount);
  await ctx.reply(`✅ ငွေဖြည့်ရန် အနည်းဆုံးပမာဏကို ${amount} ကျပ် အဖြစ် သတ်မှတ်ပြီးပါပြီ။`);
});

bot.command('setkpay', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const number = parts[1];
  const name = parts.slice(2).join(' ');
  if (!number || !name) return ctx.reply('ပုံစံ: /setkpay <number> <name...>\nဥပမာ: /setkpay 09123456789 Nan Su');
  await texts.setText('kpay_number', number);
  await texts.setText('kpay_name', name);
  await ctx.reply(`✅ Kpay ကို ပြောင်းပြီးပါပြီ:\nkpay - ${number}\nname - ${name}`);
});

bot.command('setwave', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const number = parts[1];
  const name = parts.slice(2).join(' ');
  if (!number || !name) return ctx.reply('ပုံစံ: /setwave <number> <name...>\nဥပမာ: /setwave 09123456789 Nan Su');
  await texts.setText('wave_number', number);
  await texts.setText('wave_name', name);
  await ctx.reply(`✅ Wave ကို ပြောင်းပြီးပါပြီ:\nWave - ${number}\nName - ${name}`);
});

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

// Belt-and-braces: never let one unexpected synchronous throw kill the
// whole bot process either (unhandledRejection is already handled above).
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (bot keeps running):', err);
});

// MongoDB: log connection hiccups instead of silently going stale, and let
// the driver's own auto-reconnect do its job.
mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected - driver will try to reconnect...'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected.'));

const app = express();
app.get('/', (req, res) => res.send('SMM Telegram bot is running.'));
const PORT = process.env.PORT || 3000;

// Render's FREE tier spins a "Web Service" down after ~15 minutes with no
// inbound HTTP traffic - which would kill the bot's long-polling loop too.
// This pings our own public URL every 4 minutes so Render always sees
// recent traffic and never puts the service to sleep. RENDER_EXTERNAL_URL
// is provided automatically by Render - no setup needed. On a paid Render
// plan (or elsewhere) this is a harmless no-op if that variable isn't set.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL;
if (SELF_URL) {
  setInterval(() => {
    require('https').get(SELF_URL, (res) => res.resume())
      .on('error', (err) => console.error('Self-ping failed:', err.message));
  }, 4 * 60 * 1000);
  console.log(`Self-ping enabled for ${SELF_URL} (every 4 min) to prevent Render free-tier sleep.`);
} else {
  console.log('No RENDER_EXTERNAL_URL/SELF_PING_URL set - self-ping disabled.');
}

// ---------------------------------------------------------------------
// Web admin panel (Express) - see admin.js. Login links come from /adminlogin.
// ---------------------------------------------------------------------
panel = mountAdminPanel(app, {
  bot, adminIds: ADMIN_IDS, isAdmin, safeSend, startBroadcast, sanitizeName, toBoldUnicode,
  approveDeposit, rejectDeposit, refundOrder, refundIfPartial, refreshOrderStatuses, priceFor, orderRef
});

// Warn the admins in Telegram when a provider account runs low, so orders
// never start failing silently. Alerts once per drop (not every 30 minutes).
const lowAlerted = {};
async function lowBalanceSweep() {
  const threshold = Number(texts.t('low_balance_threshold')) || 0;
  if (!threshold) return;
  for (const provider of Object.keys(providers.CONFIG)) {
    const c = providers.CONFIG[provider];
    if (!c.url || !c.key) continue;
    try {
      const res = await providers.getBalance(provider);
      const bal = Number(res && res.balance);
      if (!Number.isFinite(bal)) continue;
      if (bal < threshold && !lowAlerted[provider]) {
        lowAlerted[provider] = true;
        for (const id of ADMIN_IDS) await safeSend(id, `⚠️ ${provider} လက်ကျန်ငွေ နည်းနေပါပြီ: ${bal} ${res.currency || ''}\n(သတ်မှတ်ထားသော အနိမ့်ဆုံး: ${threshold}) - ငွေဖြည့်ပေးပါ။`);
      } else if (bal >= threshold) {
        lowAlerted[provider] = false;
      }
    } catch (_) { /* provider unreachable - the panel dashboard shows the error */ }
  }
}
setInterval(() => { lowBalanceSweep(); }, 30 * 60 * 1000);

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('MongoDB connected');
  await texts.preload();
  migrateOrderNos().catch(err => console.error('order number migration failed:', err.message));
  retention.autoCleanup();
  setInterval(() => { retention.autoCleanup(); }, 6 * 3600 * 1000);
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

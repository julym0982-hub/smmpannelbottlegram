// =======================================================================
// Mobile Legends TopUp (Shop -> 💎 Mobile Legends TopUp)
//
//  customer: package -> Game ID -> Server ID -> bot shows the player name
//            -> "ဟုတ်ပါတယ်" buys it on Smile One / "မဟုတ်ပါ" cancels
//  admin   : Panel > ML TopUp (visibility, prices, session, orders)
//
// Prices:  cost (MMK) = Smile Coins x MMK-per-coin;  price = cost x (1 + markup%)
//          rounded to `roundTo`.  MMK-per-coin = MMK really paid / Smile Coins really received.
// Safety:  "တကယ်ဝယ်မည်" (live) is OFF by default -> the whole flow works but nothing is
//          charged and nothing is bought on Smile One.
// =======================================================================
const axios = require('axios');
const { Markup } = require('telegraf');
const texts = require('./texts');
const smile = require('./ml-smile');
const store = require('./store');
const { User, MlOrder } = require('./models');

// ---- package catalogue (the admin edits markup % and on/off; the rest is fixed here) ----
const PKGS = [
  { key: 'wp',    label: 'Weekly Diamond Pass', pid: '16642', qty: 1, markup: 1.4, limited: true },
  { key: 'd55',   label: '💎 55(50+5)',          pid: '22590', qty: 1, markup: 7.1 },
  { key: 'd86',   label: '💎86(78+8)',           pid: '13',    qty: 1, markup: 5.9 },
  { key: 'd165',  label: '💎165(150+15)',        pid: '22591', qty: 1, markup: 6.2 },
  { key: 'd172',  label: '💎172 (156+16)',       pid: '23',    qty: 1, markup: 5.9 },
  { key: 'd257',  label: '💎257(234+23)',        pid: '25',    qty: 1, markup: 8.4 },
  { key: 'd275',  label: '💎275(250+25)',        pid: '22592', qty: 1, markup: 8.4 },
  { key: 'd565',  label: '💎565(500+65)',        pid: '22593', qty: 1, markup: 8.2 },
  { key: 'd706',  label: '💎706(625+81)',        pid: '26',    qty: 1, markup: 7.2 },
  { key: 'd1130', label: '💎1,130(1,000+130)',   pid: '22593', qty: 2, markup: 8.1 } // = 2 x the 565 tier
];

const CFG_KEY = 'ml_cfg';
const CFG_DEFAULT = {
  enabled: true,          // button exists at all
  adminOnly: true,        // only admins see it
  live: false,            // false = dry run (nothing bought, nothing charged)
  mmkPaid: 25417,         // MMK really paid ...
  coinsCredited: 300,     // ... for this many Smile Coins (30 BRL = 300 coins)
  extraFeePct: 0,         // extra safety % on cost (USDT swings, transfer fee not already inside mmkPaid)
  roundTo: 100,
  maxCoinsPerOrder: 1000, // refuse one order that would spend more than this
  maxPerDay: 30,          // orders per day (all customers)
  pkgs: {}                // key -> { markup, enabled }
};

let cfgRaw = null, cfgParsed = null;
function cfg() {
  const raw = texts.getRaw(CFG_KEY);
  if (raw !== cfgRaw) {
    cfgRaw = raw;
    let saved = {};
    try { saved = raw ? JSON.parse(raw) : {}; } catch (_) { saved = {}; }
    cfgParsed = { ...CFG_DEFAULT, ...saved, pkgs: { ...(saved.pkgs || {}) } };
  }
  return cfgParsed;
}
async function saveCfg(c) { await texts.setText(CFG_KEY, JSON.stringify(c)); cfgRaw = null; }

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const toNum = (v, name, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw bad(name + ' မမှန်ပါ'); return n; };

// ---- pricing --------------------------------------------------------------------
const mmkPerCoin = (c = cfg()) => (c.mmkPaid / c.coinsCredited) * (1 + (c.extraFeePct || 0) / 100);
function pkgView(p, c = cfg()) {
  const o = c.pkgs[p.key] || {};
  const markup = o.markup != null ? Number(o.markup) : p.markup;
  const enabled = o.enabled !== false;
  const unitCoins = smile.liveCoins(p.pid);
  const coins = Math.round(unitCoins * p.qty * 10) / 10;
  const cost = coins * mmkPerCoin(c);
  const step = Math.max(1, Number(c.roundTo) || 1);
  const price = Math.max(step, Math.round(cost * (1 + markup / 100) / step) * step);
  return { key: p.key, label: p.label, pid: p.pid, qty: p.qty, limited: !!p.limited, markup, enabled, unitCoins, coins, cost: Math.round(cost), price, profit: Math.round(price - cost) };
}
const allViews = () => { const c = cfg(); return PKGS.map(p => pkgView(p, c)); };
const findView = (key) => { const p = PKGS.find(x => x.key === key); return p ? pkgView(p) : null; };
const visibleTo = (isAdminUser) => { const c = cfg(); return !!(c.enabled && (!c.adminOnly || isAdminUser)); };

const nf = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const startOfToday = () => { const off = 6.5 * 3600 * 1000; return new Date(Math.floor((Date.now() + off) / 86400000) * 86400000 - off); };


// ---- matching our orders with Smile One's order list ---------------------------------
// Smile One status codes -> what customers read (Burmese)
const SMILE_TXT = {
  '1': '✅ အောင်မြင်', '2': '⏳ ငွေပေးချေမှု စောင့်ဆိုင်း', '3': '↩️ ငွေပြန်အမ်းပြီး', '4': '↩️ ပြန်လည်ရုပ်သိမ်းခံရ',
  '5': '⏳ လုပ်ဆောင်နေဆဲ', '6': '❌ ငြင်းပယ်ခံရ', '7': '🔄 ရုပ်သိမ်းမှု ပယ်ဖျက်ပြီး', part: '⏳ တစ်စိတ်တစ်ပိုင်းသာ ပြီးသေး'
};
const BAD_SMILE = ['3', '4', '6'];
const utc3Day = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);

// Looks the order up on Smile One (user id + server + package + time) and stores what it finds.
// A 'check'/'processing' order that Smile One shows as successful becomes 'done'.
async function syncOrder(o) {
  const t0 = new Date(o.createdAt).getTime();
  const list = await smile.listOrders({ uid: o.gameId, startdate: utc3Day(t0 - 86400000), enddate: utc3Day(t0 + 86400000) });
  let mine;
  if (o.smileOrderIds && o.smileOrderIds.length) mine = list.filter(x => o.smileOrderIds.includes(x.id));
  else {
    const taken = new Set((await MlOrder.find({ _id: { $ne: o._id }, gameId: o.gameId, 'smileOrderIds.0': { $exists: true } }).select('smileOrderIds').lean()).flatMap(x => x.smileOrderIds));
    mine = list.filter(x => x.zone === o.zoneId && x.pid === o.smilePid && !taken.has(x.id) && x.at >= t0 - 5 * 60000 && x.at <= t0 + 90 * 60000)
      .sort((a, b) => a.at - b.at).slice(0, o.qty || 1);
  }
  let summary = null;
  if (mine.length) {
    const codes = mine.map(x => x.status);
    if (mine.length < (o.qty || 1)) summary = BAD_SMILE.find(c => codes.includes(c)) || 'part';
    else summary = BAD_SMILE.find(c => codes.includes(c)) || (codes.every(c => c === '1') ? '1' : (codes.includes('5') ? '5' : (codes.includes('2') ? '2' : codes[0])));
  }
  const set = { smileCheckedAt: new Date() };
  if (mine.length) {
    set.smileOrderIds = mine.map(x => x.id); set.smileStatus = summary;
    if (mine.every(x => Number.isFinite(x.brl))) set.chargedCoins = Math.round(mine.reduce((a, x) => a + x.brl, 0) * 100) / 10; // BRL x 10 = Smile Coins
  }
  let becameDone = false;
  if (summary === '1' && ['check', 'processing'].includes(o.status)) {
    const r = await MlOrder.findOneAndUpdate({ _id: o._id, status: { $in: ['check', 'processing'] } }, { $set: { ...set, status: 'done', note: ((o.note ? o.note + ' | ' : '') + 'smile: confirmed').slice(0, 300) } });
    becameDone = !!r;
  } else await MlOrder.updateOne({ _id: o._id }, { $set: set });
  return { summary, mine, becameDone };
}

// ---- bot ---------------------------------------------------------------------------
function register(bot, d) {
  const { st, resetState, isAdmin, showInline, displayName, safeSend, adminIds } = d;
  const homeKb = () => Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'ml_home')]]);
  const alertAdmins = (text) => Promise.all((adminIds || []).map(id => safeSend(id, text, { parse_mode: 'HTML' }))).catch(() => {});

  // admins get a heads-up when Smile One side breaks (throttled)
  let lastAlert = 0;
  const alertOnce = (text) => { if (Date.now() - lastAlert < 10 * 60 * 1000) return; lastAlert = Date.now(); alertAdmins(text); };
  const smileProblem = (e) => `⚠️ <b>ML TopUp</b> - Smile One ပြဿနာ: <code>${esc(e && e.code || '')}</code> ${esc(String(e && e.message || e).slice(0, 200))}` + (['NOT_LOGGED_IN', 'CLOUDFLARE', 'NO_SESSION'].includes(e && e.code) ? HOWTO : '');

  async function showHome(ctx) {
    if (!visibleTo(isAdmin(ctx.from.id))) return showInline(ctx, '💎 Mobile Legends TopUp ကို ခေတ္တပိတ်ထားပါသည်ရှင့်။', Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'shop_home')]]));
    resetState(ctx.from.id);
    if (Date.now() - smile.liveAge() > 30 * 60 * 1000 && smile.sessionInfo().has) smile.refreshLive().catch(() => {}); // never blocks the menu
    const rows = allViews().filter(v => v.enabled).map(v => [Markup.button.callback(`${v.label} — ${nf(v.price)}ကျပ်`, `ml_p_${v.key}`)]);
    rows.push([Markup.button.callback('◀️ Back', 'shop_home')]);
    const note = cfg().adminOnly ? '\n\n<i>(Admin only mode - customer တွေ မမြင်ရသေးပါ)</i>' : '';
    return showInline(ctx, 'ကြိုက်နှစ်သက်ရာ package များကို ရွေးချယ်ပါ' + note, Markup.inlineKeyboard(rows));
  }
  bot.action('ml_home', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await showHome(ctx); });

  bot.action(/^ml_p_(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!visibleTo(isAdmin(ctx.from.id))) return showHome(ctx);
    const v = findView(ctx.match[1]);
    if (!v || !v.enabled) return showHome(ctx);
    const s = st(ctx.from.id);
    s.level = 'ml_uid'; s.ml = { key: v.key };
    return showInline(ctx, `${esc(v.label)} — <b>${nf(v.price)}</b> ကျပ်\n\nMobile Legends <b>Game ID</b> ပို့ပေးပါ 🎮`, homeKb());
  });

  // Game ID + Server ID checked -> show the player name and ask to confirm
  async function runLookup(ctx, s, uid, zone) {
    const v = findView(s.ml.key);
    if (!v || !v.enabled || !visibleTo(isAdmin(ctx.from.id))) { resetState(ctx.from.id); await ctx.reply('💎 ဒီ package ကို ခေတ္တပိတ်ထားပါသည်ရှင့်။'); return true; }
    s.ml.uid = uid; s.ml.zone = zone; s.level = 'ml_wait';
    const wait = await ctx.reply('⏳ Game name စစ်နေပါတယ်...');
    let r;
    try { r = await smile.lookup(v.pid, uid, zone); }
    catch (e) {
      if (e && e.code === 'ROLE') {
        s.level = 'ml_uid'; s.ml.uid = undefined; s.ml.zone = undefined;
        await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, '❌ Game ID / Server ID မှားနေပါတယ်ရှင့်။\nGame ID ကို ပြန်ပို့ပေးပါ။').catch(() => {});
        return true;
      }
      console.error('ml lookup failed:', e && e.code, e && e.message);
      alertOnce(smileProblem(e));
      resetState(ctx.from.id);
      await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, '⚠️ ယခု ဝန်ဆောင်မှု ခေတ္တ အဆင်မပြေပါရှင့်။ ခဏနေမှ ပြန်စမ်းပေးပါ။').catch(() => {});
      return true;
    }
    s.ml.name = r.name; s.ml.type = r.type; s.level = 'ml_confirm';
    s.ml.price = v.price; s.ml.perUnitCoins = v.unitCoins; // what the customer is shown is what they pay
    const u = await User.findById(String(ctx.from.id)).lean();
    const body =
      `🎮 Game name : <b>${esc(r.name || '-')}</b>\n🆔 ID : <code>${esc(uid)}</code> (${esc(zone)})\n` +
      `💎 ${esc(v.label)}\n💰 ဈေး : <b>${nf(v.price)}</b> ကျပ်   |   လက်ကျန် : ${nf(u && u.balance)} ကျပ်\n\n` +
      `<b>ဒီဂိမ်းနာမည် မှန်ပါသလား?</b>`;
    await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, body, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ ဟုတ်ပါတယ်', 'ml_yes'), Markup.button.callback('❌ မဟုတ်ပါ', 'ml_no')]]).reply_markup
    }).catch(() => {});
    return true;
  }

  // text typed while in the ML flow (called from the main text handler). returns true when handled.
  // Accepts  "824412642"  (then Server ID is asked)  or  "824412642(12267)"  (nothing more is asked)
  async function onText(ctx, s, text) {
    if (s.level === 'ml_uid') {
      const both = /^(\d{4,15})\s*[(（\[]\s*(\d{1,8})\s*[)）\]]$/.exec(text) || /^(\d{4,15})[\s,/-]+(\d{1,8})$/.exec(text);
      if (both) return runLookup(ctx, s, both[1], both[2]);
      if (!/^\d{4,15}$/.test(text)) { await ctx.reply('⚠️ Game ID က ဂဏန်းသက်သက် ဖြစ်ရပါမယ်ရှင့်။ ပြန်ပို့ပေးပါ။'); return true; }
      s.ml.uid = text; s.level = 'ml_zone';
      await ctx.reply('ကောင်းပါပြီ ✅ ဆက်ပြီး <b>Server ID</b> ပို့ပေးပါ (ကွင်းထဲက ဂဏန်း)', { parse_mode: 'HTML' });
      return true;
    }
    if (s.level === 'ml_zone') {
      const both = /^(\d{4,15})\s*[(（\[]\s*(\d{1,8})\s*[)）\]]$/.exec(text);
      if (both) return runLookup(ctx, s, both[1], both[2]); // they sent id(zone) again
      if (!/^\d{1,8}$/.test(text)) { await ctx.reply('⚠️ Server ID က ဂဏန်းသက်သက် ဖြစ်ရပါမယ်ရှင့်။ ပြန်ပို့ပေးပါ။'); return true; }
      return runLookup(ctx, s, s.ml.uid, text);
    }
    if (s.level === 'ml_wait' || s.level === 'ml_confirm' || s.level === 'ml_buying') { await ctx.reply('အပေါ်က ခလုတ်ကို နှိပ်ပေးပါရှင့် 👆'); return true; }
    return false;
  }

  bot.action('ml_no', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    resetState(ctx.from.id);
    return showInline(ctx, '❌ Order ကို ပယ်ဖျက်ပြီးပါပြီရှင့်။', homeKb());
  });

  bot.action('ml_yes', async (ctx) => {
    const s = st(ctx.from.id);
    const ok = s.level === 'ml_confirm' && s.ml && s.ml.name !== undefined;
    if (ok) s.level = 'ml_buying';            // blocks a second tap
    await ctx.answerCbQuery().catch(() => {});
    if (!ok) return;
    const m = s.ml;
    resetState(ctx.from.id);
    const v = findView(m.key);
    const uid = String(ctx.from.id);
    if (!v || !v.enabled || !visibleTo(isAdmin(ctx.from.id))) return showInline(ctx, '💎 ဒီ package ကို ခေတ္တပိတ်ထားပါသည်ရှင့်။', homeKb());
    const c = cfg();
    const base = { userId: uid, pkgKey: v.key, label: v.label, smilePid: v.pid, qty: v.qty, gameId: m.uid, zoneId: m.zone, gameName: m.name, price: m.price, costCoins: Math.round(m.perUnitCoins * v.qty * 10) / 10, rate: mmkPerCoin(c) };

    // ---- dry run: everything checked, nothing charged, nothing bought ----
    if (!c.live) {
      if (store.isUp()) await MlOrder.create({ ...base, status: 'dryrun', note: 'dry run' }).catch(() => {});
      return showInline(ctx, `🧪 <b>စမ်းသပ်မုဒ် (DRY-RUN)</b>\n\n🎮 ${esc(m.name)} (${esc(m.uid)})\n💎 ${esc(v.label)} — ${nf(m.price)} ကျပ်\n\nအားလုံး မှန်ကန်ပါတယ်။ ဒါပေမယ့် ငွေမနှုတ်ပါ၊ Diamond လည်း မဝယ်ပါ။\n(Panel > ML TopUp မှာ "တကယ်ဝယ်မည်" ကို ဖွင့်မှ တကယ်ဝယ်ပါမယ်)`, homeKb());
    }
    if (!store.isUp()) return showInline(ctx, '⚠️ ယခု ဝန်ဆောင်မှု ခေတ္တ အဆင်မပြေပါရှင့်။', homeKb());
    const today = await MlOrder.countDocuments({ createdAt: { $gte: startOfToday() }, status: { $in: ['processing', 'done', 'check'] } });
    if (today >= c.maxPerDay) { alertOnce('⚠️ <b>ML TopUp</b> - တစ်နေ့ order limit ပြည့်သွားပါပြီ'); return showInline(ctx, '⚠️ ယနေ့အတွက် ဝန်ဆောင်မှု ပြည့်သွားပါပြီရှင့်၊ မနက်ဖြန်မှ ပြန်စမ်းပေးပါ။', homeKb()); }
    if (base.costCoins > c.maxCoinsPerOrder) return showInline(ctx, '⚠️ ဒီ package ကို ယခု မရောင်းနိုင်သေးပါရှင့်။', homeKb());

    // take the money first with ONE conditional update (same rule as the Boost orders)
    const charged = await User.findOneAndUpdate({ _id: uid, balance: { $gte: m.price } }, { $inc: { balance: -m.price, totalSpent: m.price } }, { new: true });
    if (!charged) return showInline(ctx, texts.t('insufficient_balance', { name: displayName(ctx.from) }), Markup.inlineKeyboard([[Markup.button.callback('💰ငွေဖြည့်ရန်💰', 'go_topup')], [Markup.button.callback('◀️ Back', 'ml_home')]]));
    const order = await MlOrder.create({ ...base, status: 'processing' });
    await showInline(ctx, '⏳ Order လုပ်နေပါတယ်ရှင့်... ခဏစောင့်ပေးပါ (ပြီးရင် စာပို့ပေးပါမယ်)', Markup.inlineKeyboard([]));

    const refund = (amount) => User.findByIdAndUpdate(uid, { $inc: { balance: amount, totalSpent: -amount } });
    const who = `${esc(m.name)} (${esc(m.uid)}/${esc(m.zone)}) · user ${uid}`;
    let r;
    try { r = await smile.purchase({ pid: v.pid, qty: v.qty, uid: m.uid, zone: m.zone, perUnitCoins: m.perUnitCoins }); }
    catch (e) { r = { delivered: 0, unknown: true, error: e, chargedCoins: null }; } // should not happen; treat as "check"

    const upd = (status, note) => MlOrder.updateOne({ _id: order._id }, { $set: { status, note: String(note || '').slice(0, 300), delivered: r.delivered, chargedCoins: r.chargedCoins } }).catch(() => {});
    const errTxt = r.error ? `${r.error.code || ''} ${String(r.error.message || r.error).slice(0, 160)}` : '';
    const send = (text) => safeSend(uid, text, { parse_mode: 'HTML', reply_markup: homeKb().reply_markup });

    if (r.unknown) {
      await upd('check', errTxt || 'unclear');
      alertAdmins(`🟠 <b>ML TopUp - စစ်ဆေးရန်</b>\n${who}\n💎 ${esc(v.label)} · ${nf(m.price)} ကျပ် (ငွေ မပြန်သေးပါ)\nSmile One ရလဒ် မရှင်းပါ: ${esc(errTxt)}\n👉 Smile One /customer/order မှာ စစ်ပြီး Panel > ML TopUp မှာ "ပြီးပြီ" ဒါမှမဟုတ် "ငွေပြန်ထည့်" လုပ်ပါ။`);
      return send('⏳ Order ကို စစ်ဆေးနေပါတယ်ရှင့်။ Admin က အတည်ပြုပေးပါမယ်၊ ခဏစောင့်ပေးပါနော်။ (ငွေ နှစ်ခါ မဖြတ်ပါ)');
    }
    if (r.delivered >= v.qty) {
      await upd('done', '');
      alertAdmins(`🟢 <b>ML TopUp ရောင်းပြီး</b>\n${who}\n💎 ${esc(v.label)} · ${nf(m.price)} ကျပ်\nSmile Coins ကုန်: ${r.chargedCoins != null ? r.chargedCoins : '?'} (ခန့်မှန်း ${base.costCoins})`);
      return send(`✅ <b>ဝယ်ယူမှု အောင်မြင်ပါတယ်ရှင့်</b>\n\n🎮 ${esc(m.name)} (${esc(m.uid)})\n💎 ${esc(v.label)}\n💰 ${nf(m.price)} ကျပ် နှုတ်ယူပြီးပါပြီ\n\nဂိမ်းထဲ မိနစ်အနည်းငယ်အတွင်း ဝင်ပါလိမ့်မယ် ❤️\n\n📜 ဝယ်ယူမှုမှတ်တမ်းကို <b>History > MlbbTopup ဝယ်ယူမှုမှတ်တမ်း</b> မှာ စစ်ကြည့်လို့ရပါတယ်`);
    }
    if (r.delivered > 0) { // part of a multi-buy went through
      const back = Math.round(m.price * (v.qty - r.delivered) / v.qty);
      await refund(back);
      await upd('done', `partial ${r.delivered}/${v.qty}, refunded ${back}. ${errTxt}`);
      alertAdmins(`🟠 <b>ML TopUp တစ်စိတ်တစ်ပိုင်း</b>\n${who}\n${r.delivered}/${v.qty} ပေးပြီး · ${nf(back)} ကျပ် ပြန်ထည့်ပြီး\n${esc(errTxt)}`);
      return send(`⚠️ Order တစ်စိတ်တစ်ပိုင်းသာ ပြီးမြောက်ပါတယ်ရှင့် (${r.delivered}/${v.qty})။\nမပြီးတဲ့အတွက် ${nf(back)} ကျပ် ပြန်ထည့်ပေးလိုက်ပါပြီ ❤️`);
    }
    // nothing was bought -> money straight back
    await refund(m.price);
    await upd('failed', errTxt);
    console.error('ml purchase failed:', errTxt);
    if (!['ROLE', 'LOW_SMILE_BALANCE', 'PRICE_CHANGED', 'PRICE_RULE'].includes(r.error && r.error.code)) alertOnce(smileProblem(r.error));
    else alertAdmins(`🔴 <b>ML TopUp မရောင်းနိုင်</b>\n${who}\n${esc(errTxt)}\n(customer ငွေ ပြန်ထည့်ပြီး)`);
    return send('⚠️ ယခု Order မအောင်မြင်ပါရှင့်။ သင့်ငွေ မနှုတ်ယူပါ (ပြန်ထည့်ပေးပြီး)။ ခဏနေမှ ပြန်စမ်းပေးပါ၊ ဆက်မရရင် Admin ကို ဆက်သွယ်ပါနော် 🙏');
  });

  // ---- purchase history (History > MlbbTopup ဝယ်ယူမှုမှတ်တမ်း) ----
  // 5 orders per page, newest first, at most 5 pages (the newest 25). Older ones are not shown any more.
  const MMT = (dte) => new Date(new Date(dte).getTime() + 6.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' (MMT)';
  const PER_PAGE = 5, MAX_SHOWN = 25;
  // what the customer reads: our own words only (nothing about where the diamonds are bought)
  const custStatus = (o) => {
    if (o.status === 'refunded') return '↩️ ငွေပြန်ထည့်ပြီး';
    if (o.status === 'failed') return '❌ မအောင်မြင် (ငွေပြန်ထည့်ပြီး)';
    if (o.status === 'processing') return '⏳ လုပ်ဆောင်နေဆဲ';
    if (o.status === 'check') return '⏳ စစ်ဆေးနေဆဲ (အတည်ပြုပေးမည်)';
    if (o.status === 'done') return BAD_SMILE.includes(o.smileStatus) ? '⏳ စစ်ဆေးနေဆဲ (အတည်ပြုပေးမည်)' : '✅ အောင်မြင်';
    return esc(o.status);
  };
  bot.action(/^ml_hist_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!store.isUp()) return;
    const all = await MlOrder.find({ userId: String(ctx.from.id), status: { $ne: 'dryrun' } }).sort({ createdAt: -1 }).limit(MAX_SHOWN).select('label price status').lean();
    const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
    const page = Math.min(Math.max(1, parseInt(ctx.match[1], 10) || 1), pages);
    const back = [Markup.button.callback('◀️ နောက်ပြန်', 'hist_menu')];
    if (!all.length) return showInline(ctx, 'ဝယ်ယူထားတဲ့ မှတ်တမ်း မရှိသေးပါရှင့်။', Markup.inlineKeyboard([back]));
    const rows = all.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(o => [Markup.button.callback(`${o.label} — ${nf(o.price)} ကျပ်`, `ml_ho_${o._id}_${page}`)]);
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('◀️ Back', `ml_hist_${page - 1}`));
    if (page < pages) nav.push(Markup.button.callback('Next ▶️', `ml_hist_${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push(back);
    return showInline(ctx, `ဝယ်ယူထားသောမှတ်တမ်းများ  (${page}/${pages})`, Markup.inlineKeyboard(rows));
  });
  const detailText = (o) =>
    `💎 <b>${esc(o.label)}</b>\n\n📌 Status : ${custStatus(o)}\n🎮 Game name : ${esc(o.gameName || '-')}\n🆔 User ID : <code>${esc(o.gameId)}</code>\n🌐 Server ID : <code>${esc(o.zoneId)}</code>\n💰 ကျသင့်ငွေ : <b>${nf(o.price)}</b> ကျပ်\n🕒 Order time : ${MMT(o.createdAt)}`;
  const detailKb = (o, page) => {
    const rows = [];
    if (['done', 'check', 'processing'].includes(o.status)) rows.push([Markup.button.callback('🔄 Status စစ်မည်', `ml_hs_${o._id}_${page}`)]);
    rows.push([Markup.button.callback('◀️ နောက်ပြန်', `ml_hist_${page}`)]);
    return Markup.inlineKeyboard(rows);
  };
  bot.action(/^ml_ho_([a-f0-9]{24})_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!store.isUp()) return;
    const o = await MlOrder.findOne({ _id: ctx.match[1], userId: String(ctx.from.id) }).lean(); // only your own orders
    if (!o) return;
    return showInline(ctx, detailText(o), detailKb(o, ctx.match[2]));
  });
  // 🔄 checks the order right now (at most once per 30 s per order)
  bot.action(/^ml_hs_([a-f0-9]{24})_(\d+)$/, async (ctx) => {
    if (!store.isUp()) return ctx.answerCbQuery().catch(() => {});
    const page = ctx.match[2];
    let o = await MlOrder.findOne({ _id: ctx.match[1], userId: String(ctx.from.id) });
    if (!o || !['done', 'check', 'processing'].includes(o.status)) return ctx.answerCbQuery().catch(() => {});
    if (o.smileCheckedAt && Date.now() - new Date(o.smileCheckedAt).getTime() < 30000) return ctx.answerCbQuery('ခဏနေမှ ပြန်စစ်ပါ (စက္ကန့် ၃၀)').catch(() => {});
    await ctx.answerCbQuery('စစ်နေပါတယ်...').catch(() => {});
    let note = '';
    try {
      const r = await syncOrder(o);
      if (!r.mine.length) note = '\n\n<i>မတွေ့သေးပါ၊ order လုပ်ပြီး မကြာသေးရင် ခဏနေမှ ပြန်စစ်ပါ</i>';
      if (r.becameDone) alertAdmins(`🟢 <b>ML TopUp အတည်ပြုပြီး</b>\nuser ${esc(o.userId)} · ${esc(o.label)} · Smile One မှာ အောင်မြင်ကြောင်း တွေ့ပါပြီ`);
      if (BAD_SMILE.includes(r.summary)) alertAdmins(`🔴 <b>ML TopUp - Smile One status ${esc(SMILE_TXT[r.summary])}</b>\nuser ${esc(o.userId)} · ${esc(o.label)} · ${esc(o.gameId)}/${esc(o.zoneId)}\nPanel > ML TopUp > Orders မှာ စစ်ပါ။`);
    } catch (e) {
      note = '\n\n<i>⚠️ ယခု စစ်လို့မရပါ၊ ခဏနေမှ ပြန်စမ်းပါ</i>';
      if (['NOT_LOGGED_IN', 'CLOUDFLARE', 'NO_SESSION'].includes(e && e.code)) alertOnce(smileProblem(e));
    }
    o = await MlOrder.findById(o._id).lean();
    return showInline(ctx, detailText(o) + note, detailKb(o, page));
  });

  // ---- re-check recent orders against Smile One every 2 hours (finds refunds / crashed orders) ----
  async function reconcile() {
    try {
      if (!cfg().live || !store.isUp() || !smile.sessionInfo().has) return;
      const rows = await MlOrder.find({
        status: { $in: ['done', 'check', 'processing'] }, createdAt: { $gte: new Date(Date.now() - 3 * 86400000) },
        $or: [{ smileCheckedAt: { $exists: false } }, { smileCheckedAt: { $lt: new Date(Date.now() - 3600000) } }]
      }).sort({ createdAt: 1 }).limit(8);
      for (const o of rows) {
        const prev = o.smileStatus;
        let r;
        try { r = await syncOrder(o); } catch (e) { if (['NOT_LOGGED_IN', 'CLOUDFLARE', 'NO_SESSION'].includes(e && e.code)) break; continue; }
        const who = `user ${esc(o.userId)} · ${esc(o.label)} · ${esc(o.gameId)}/${esc(o.zoneId)} · ${nf(o.price)} ကျပ်`;
        if (r.becameDone) alertAdmins(`🟢 <b>ML TopUp အတည်ပြုပြီး</b>\n${who}`);
        else if (BAD_SMILE.includes(r.summary) && prev !== r.summary) alertAdmins(`🔴 <b>ML TopUp - Smile One ${esc(SMILE_TXT[r.summary])}</b>\n${who}\nPanel > ML TopUp မှာ စစ်ပြီး လိုရင် ငွေပြန်ထည့်ပါ။`);
        else if (!r.mine.length && ['check', 'processing'].includes(o.status) && !o.notFoundAlert && Date.now() - new Date(o.createdAt).getTime() > 45 * 60000) {
          await MlOrder.updateOne({ _id: o._id }, { $set: { notFoundAlert: true } });
          alertAdmins(`🟠 <b>ML TopUp - Smile One မှာ order မတွေ့ပါ</b>\n${who}\nမိနစ် ၄၅ ကျော်နေပါပြီ။ Panel > ML TopUp မှာ စစ်ပြီး "ငွေပြန်ထည့်" လုပ်လို့ရပါတယ်။`);
        }
      }
    } catch (e) { console.error('ml reconcile:', e && e.message); }
  }
  setTimeout(reconcile, 5 * 60 * 1000).unref();
  setInterval(reconcile, 2 * 3600 * 1000).unref();

  // ---- keep an eye on the Smile One login: tell the admin the moment it stops working ----
  let sessionOk = null;
  const HOWTO = '\n\n👉 Laptop မှာ <code>tools\\get_session.bat</code> ကို double-click → Chrome မှာ smile.one login ဝင်ပြီး Enter နှိပ်ပါ → ထွက်လာတဲ့ JSON ကို Panel > ML TopUp မှာ paste (ဒါမှမဟုတ် ဒီ bot ကို ဖိုင်ပို့) ပြီး "Session စစ်" နှိပ်ပါ။';
  async function watchSession() {
    try {
      if (!cfg().enabled || !smile.sessionInfo().has) return;
      await smile.test();
      if (sessionOk === false) alertAdmins('🟢 <b>Smile One session ပြန်ကောင်းသွားပါပြီ</b>');
      sessionOk = true;
    } catch (e) {
      if (['NOT_LOGGED_IN', 'CLOUDFLARE', 'NO_SESSION'].includes(e && e.code)) {
        if (sessionOk !== false) alertAdmins(`🔴 <b>Smile One session မရတော့ပါ</b> (${esc(e.code)})\nMobile Legends order တွေ ခေတ္တ မရောင်းနိုင်ပါ။` + HOWTO);
        sessionOk = false;
      } // a plain network hiccup is ignored
    }
  }
  setTimeout(watchSession, 90 * 1000).unref();
  setInterval(watchSession, 3 * 3600 * 1000).unref();

  // admin sends smileone_session.json to the bot as a file -> saved (encrypted), file removed from the chat
  bot.on('document', async (ctx, next) => {
    const doc = ctx.message.document;
    if (!isAdmin(ctx.from.id) || !/\.json$/i.test(doc.file_name || '') || (doc.file_size || 0) > 200000) return next();
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await axios.get(String(link), { responseType: 'text', transformResponse: (x) => x, timeout: 20000 });
      const r = await smile.setSessionFromJson(res.data);
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply(`✅ Smile One session သိမ်းပြီးပါပြီ (smile.one cookie ${r.count} ခု${r.dropped ? `, တခြား cookie ${r.dropped} ခု ဖယ်ထားပြီး` : ''})။\nPanel > ML TopUp မှာ "Session စစ်" နှိပ်ပါ။ ပို့ထားတဲ့ဖိုင်ကို chat ထဲက ဖျက်ပေးထားပါတယ်။`);
    } catch (e) {
      await ctx.reply('❌ ' + (e && e.code === 'BAD_JSON' ? e.message : 'ဖိုင်ကို ဖတ်လို့မရပါ') + '\n(tools/save_session_smile.py နဲ့ ထုတ်ထားတဲ့ smileone_session.json ကို ပို့ပါ)');
    }
  });

  return { onText };
}

// ---- admin panel (routes live in admin.js) ----------------------------------------
async function adminState() {
  const c = cfg();
  const today = store.isUp() ? await MlOrder.countDocuments({ createdAt: { $gte: startOfToday() }, status: { $in: ['processing', 'done', 'check'] } }) : 0;
  const pending = store.isUp() ? await MlOrder.countDocuments({ status: 'check' }) : 0;
  return {
    cfg: { enabled: c.enabled, adminOnly: c.adminOnly, live: c.live, mmkPaid: c.mmkPaid, coinsCredited: c.coinsCredited, extraFeePct: c.extraFeePct, roundTo: c.roundTo, maxCoinsPerOrder: c.maxCoinsPerOrder, maxPerDay: c.maxPerDay },
    mmkPerCoin: Math.round(mmkPerCoin(c) * 100) / 100,
    pricesLive: smile.liveAge() ? new Date(smile.liveAge()).toISOString() : null,
    session: smile.sessionInfo(),
    today, pending,
    pkgs: allViews()
  };
}

// money of one order: cost = Smile Coins really spent (else the quoted coins) x the rate it was priced with
function orderMoney(o) {
  const rate = o.rate || mmkPerCoin();
  const coins = o.chargedCoins != null ? o.chargedCoins : (o.costCoins || 0);
  const cost = Math.round(coins * rate);
  const sold = o.status === 'done';
  return { coins, cost, profit: sold ? Math.round(o.price - cost) : null, margin: sold && o.price ? Math.round((o.price - cost) / o.price * 1000) / 10 : null };
}
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Panel > ML TopUp > Orders : filter + search + pages, with the money details
async function adminOrders({ status = '', q = '', page = 1 } = {}) {
  if (!store.isUp()) return { items: [], total: 0, page: 1, pages: 1 };
  const per = 15;
  const and = [];
  if (status === 'problem') and.push({ $or: [{ status: 'check' }, { status: 'done', smileStatus: { $in: BAD_SMILE } }] });
  else if (status) and.push({ status });
  else and.push({ status: { $ne: 'dryrun' } });
  q = String(q || '').trim().slice(0, 60);
  if (q) { const rx = new RegExp(escRx(q), 'i'); and.push({ $or: [{ userId: q }, { gameId: q }, { gameName: rx }, { label: rx }, { smileOrderIds: q }] }); }
  const f = { $and: and };
  const total = await MlOrder.countDocuments(f);
  const pages = Math.max(1, Math.ceil(total / per));
  page = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  const rows = await MlOrder.find(f).sort({ createdAt: -1 }).skip((page - 1) * per).limit(per).lean();
  return {
    total, page, pages,
    items: rows.map(o => ({
      id: String(o._id), shortId: String(o._id).slice(-6).toUpperCase(), userId: o.userId, label: o.label, pkgKey: o.pkgKey, smilePid: o.smilePid, qty: o.qty,
      gameId: o.gameId, zoneId: o.zoneId, gameName: o.gameName, price: o.price, status: o.status, delivered: o.delivered, note: o.note || '', createdAt: o.createdAt,
      smileStatus: o.smileStatus || '', smileText: o.smileStatus ? (SMILE_TXT[o.smileStatus] || o.smileStatus) : '', smileOrderIds: o.smileOrderIds || [],
      smileCheckedAt: o.smileCheckedAt || null, costCoins: o.costCoins, chargedCoins: o.chargedCoins, rate: o.rate || null, ...orderMoney(o)
    }))
  };
}

// Panel > ML TopUp > Profit : only what Mobile Legends sales earned (not mixed into the dashboard)
async function adminProfit() {
  if (!store.isUp()) return null;
  const rows = await MlOrder.find({ status: 'done' }).select('price costCoins chargedCoins rate label userId createdAt status').lean();
  const DAY = 86400000, t0 = startOfToday().getTime();
  const add = (acc, o) => { const m = orderMoney(o); acc.orders++; acc.revenue += o.price; acc.cost += m.cost; acc.coins += m.coins; acc.profit += m.profit; return acc; };
  const blank = () => ({ orders: 0, revenue: 0, cost: 0, coins: 0, profit: 0 });
  const periods = { today: [t0, Infinity], yesterday: [t0 - DAY, t0], d7: [t0 - 6 * DAY, Infinity], d30: [t0 - 29 * DAY, Infinity], all: [0, Infinity] };
  const sums = Object.fromEntries(Object.keys(periods).map(k => [k, blank()]));
  const pk = new Map(), days = new Map(), cust = new Map();
  for (const o of rows) {
    const ts = new Date(o.createdAt).getTime();
    for (const [k, [from, to]] of Object.entries(periods)) if (ts >= from && ts < to) add(sums[k], o);
    if (ts >= t0 - 29 * DAY) {
      const p = pk.get(o.label) || { label: o.label, ...blank() }; add(p, o); pk.set(o.label, p);
      const cu = cust.get(o.userId) || { userId: o.userId, ...blank() }; add(cu, o); cust.set(o.userId, cu);
    }
    if (ts >= t0 - 13 * DAY) {
      const day = new Date(ts + 6.5 * 3600 * 1000).toISOString().slice(0, 10);
      const dd = days.get(day) || { day, ...blank() }; add(dd, o); days.set(day, dd);
    }
  }
  const fin = (s) => ({ ...s, revenue: Math.round(s.revenue), cost: Math.round(s.cost), coins: Math.round(s.coins * 10) / 10, profit: Math.round(s.profit), margin: s.revenue ? Math.round(s.profit / s.revenue * 1000) / 10 : 0 });
  const [check, failed30, refunded30] = await Promise.all([
    MlOrder.countDocuments({ status: { $in: ['check', 'processing'] } }),
    MlOrder.countDocuments({ status: 'failed', createdAt: { $gte: new Date(t0 - 29 * DAY) } }),
    MlOrder.countDocuments({ status: 'refunded', createdAt: { $gte: new Date(t0 - 29 * DAY) } })
  ]);
  return {
    mmkPerCoin: Math.round(mmkPerCoin() * 100) / 100,
    sums: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, fin(v)])),
    byPackage: [...pk.values()].map(fin).sort((a, b) => b.profit - a.profit),
    byDay: [...days.values()].map(fin).sort((a, b) => (a.day < b.day ? 1 : -1)),
    topCustomers: [...cust.values()].map(fin).sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    check, failed30, refunded30
  };
}

// Panel > ML TopUp > Check : is every part working? (read only, nothing is bought)
async function adminDiagnose(b = {}) {
  const uid = /^\d{4,15}$/.test(String(b.uid || '').trim()) ? String(b.uid).trim() : '';
  const zone = /^\d{1,8}$/.test(String(b.zone || '').trim()) ? String(b.zone).trim() : '';
  let steps;
  try { steps = await smile.diagnose({ uid, zone }); } catch (e) { steps = [{ name: 'Smile One', ok: false, detail: String(e && e.message || e).slice(0, 160) }]; }
  const c = cfg(), views = allViews().filter(v => v.enabled);
  const add = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });
  add('Database (order မှတ်တမ်း)', store.isUp(), store.isUp() ? 'ချိတ်ပြီး' : 'မချိတ်ရသေးပါ');
  const loss = views.filter(v => v.profit <= 0);
  add('ရောင်းဈေးတိုင်း အမြတ်ရှိမှု', !loss.length, loss.length ? 'အမြတ်မရှိ/ရှုံး: ' + loss.map(v => `${v.label} (${v.profit})`).join(', ') : `ဖွင့်ထားတဲ့ package ${views.length} ခုလုံး အမြတ်ရှိ`);
  add('ဈေးစာရင်းကို ဆိုက်ကနေ ယူချိန်', !!smile.liveAge(), smile.liveAge() ? new Date(smile.liveAge()).toISOString() : 'မယူရသေးပါ (ပုံသေတန်ဖိုး သုံးနေ)');
  const pend = store.isUp() ? await MlOrder.countDocuments({ status: 'check' }) : 0;
  add('စစ်ရန်ကျန်တဲ့ order', pend === 0, pend ? `${pend} ခု - Orders tab မှာ စစ်ပါ` : 'မရှိ');
  add('လက်ရှိ မုဒ်', true, `${c.enabled ? 'ဖွင့်' : 'ပိတ်'} · ${c.adminOnly ? 'Admin only' : 'Everyone'} · ${c.live ? 'တကယ်ဝယ်' : 'စမ်းသပ် (DRY-RUN)'}`);
  return { steps, ok: steps.every(s => s.ok), at: new Date().toISOString() };
}

async function adminSettings(b) {
  const c = { ...cfg(), pkgs: { ...cfg().pkgs } };
  if (b.enabled !== undefined) c.enabled = !!b.enabled;
  if (b.adminOnly !== undefined) c.adminOnly = !!b.adminOnly;
  if (b.live !== undefined) c.live = !!b.live;
  if (b.mmkPaid !== undefined) c.mmkPaid = toNum(b.mmkPaid, 'ပေးခဲ့တဲ့ ကျပ်', 1, 1e9);
  if (b.coinsCredited !== undefined) c.coinsCredited = toNum(b.coinsCredited, 'ရခဲ့တဲ့ Smile Coins', 1, 1e7);
  if (b.extraFeePct !== undefined) c.extraFeePct = toNum(b.extraFeePct, 'အပို %', -20, 100);
  if (b.roundTo !== undefined) c.roundTo = toNum(b.roundTo, 'ဈေးဝိုင်းမယ့် ကိန်း', 1, 10000);
  if (b.maxCoinsPerOrder !== undefined) c.maxCoinsPerOrder = toNum(b.maxCoinsPerOrder, 'Order တစ်ခု Coins ကန့်သတ်', 1, 1e6);
  if (b.maxPerDay !== undefined) c.maxPerDay = toNum(b.maxPerDay, 'တစ်နေ့ order ကန့်သတ်', 1, 10000);
  await saveCfg(c);
}
async function adminPkg(key, b) {
  if (!PKGS.some(p => p.key === key)) throw bad('package မတွေ့ပါ');
  const c = { ...cfg(), pkgs: { ...cfg().pkgs } };
  const o = { ...(c.pkgs[key] || {}) };
  if (b.markup !== undefined) o.markup = Math.round(toNum(b.markup, 'ရာခိုင်နှုန်း', -50, 500) * 100) / 100;
  if (b.enabled !== undefined) o.enabled = !!b.enabled;
  c.pkgs[key] = o;
  await saveCfg(c);
}
async function adminBulk(delta) {
  const d = toNum(delta, 'တိုး/လျှော့ %', -50, 100);
  const c = { ...cfg(), pkgs: { ...cfg().pkgs } };
  for (const v of allViews()) c.pkgs[v.key] = { ...(c.pkgs[v.key] || {}), markup: Math.round((v.markup + d) * 100) / 100 };
  await saveCfg(c);
}
async function adminOrderAction(id, action, safeSend) {
  const o = await MlOrder.findById(id);
  if (!o) throw Object.assign(new Error('order မတွေ့ပါ'), { status: 404 });
  if (action === 'done') {
    if (!['check', 'processing'].includes(o.status)) throw bad('ဒီ order ကို ပြောင်းလို့မရပါ');
    o.status = 'done'; o.note = (o.note ? o.note + ' | ' : '') + 'admin: delivered'; await o.save();
    if (safeSend) safeSend(o.userId, `✅ <b>ဝယ်ယူမှု အောင်မြင်ပါတယ်ရှင့်</b>\n💎 ${esc(o.label)} - ဂိမ်းထဲ ဝင်ပါလိမ့်မယ် ❤️`, { parse_mode: 'HTML' });
    return;
  }
  if (action === 'check') {
    if (!['done', 'check', 'processing'].includes(o.status)) throw bad('ဒီ order ကို Smile One မှာ စစ်လို့မရပါ');
    let r;
    try { r = await syncOrder(o); } catch (e) { throw bad('Smile One စစ်မရပါ: ' + (e.code || '') + ' ' + String(e.message || '').slice(0, 120)); }
    if (r.becameDone && safeSend) safeSend(o.userId, `✅ <b>ဝယ်ယူမှု အောင်မြင်ပါတယ်ရှင့်</b>\n💎 ${esc(o.label)} - ဂိမ်းထဲ ဝင်ပါလိမ့်မယ် ❤️`, { parse_mode: 'HTML' });
    return { smile: r.summary ? (SMILE_TXT[r.summary] || r.summary) : 'Smile One စာရင်းထဲ မတွေ့ပါ', found: r.mine.map(x => `${x.id} · ${x.text} · BRL ${x.brl}`), becameDone: r.becameDone };
  }
  if (action === 'refund') {
    const okState = ['check', 'processing'].includes(o.status) || (o.status === 'done' && BAD_SMILE.includes(o.smileStatus)); // done + Smile One says refunded/refused
    if (!okState) throw bad('ဒီ order ကို ငွေပြန်ထည့်လို့မရပါ (failed ဆိုရင် ငွေပြန်ထည့်ပြီးသား၊ done ဆိုရင် Smile One status စစ်ပြီးမှ)');
    // flip the status first (conditional) so a double click can never refund twice
    const flipped = await MlOrder.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status: 'refunded', note: ((o.note ? o.note + ' | ' : '') + 'admin: refunded').slice(0, 300) } });
    if (!flipped) throw bad('ပြောင်းပြီးသား ဖြစ်နေပါတယ်');
    await User.findByIdAndUpdate(o.userId, { $inc: { balance: o.price, totalSpent: -o.price } });
    if (safeSend) safeSend(o.userId, `↩️ Mobile Legends order အတွက် ${nf(o.price)} ကျပ် ပြန်ထည့်ပေးလိုက်ပါပြီရှင့်။`);
    return;
  }
  throw bad('action မမှန်ပါ');
}

// History > Mlbb button: shown while the feature is visible to this user, or when they already have orders
async function hasHistory(userId, isAdminUser) {
  if (visibleTo(isAdminUser)) return true;
  try { return store.isUp() && !!(await MlOrder.exists({ userId: String(userId), status: { $ne: 'dryrun' } })); } catch (_) { return false; }
}

module.exports = { _test: { syncOrder }, register, visibleTo, hasHistory, adminState, adminOrders, adminProfit, adminDiagnose, adminSettings, adminPkg, adminBulk, adminOrderAction, smile };

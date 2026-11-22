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

// ---- bot ---------------------------------------------------------------------------
function register(bot, d) {
  const { st, resetState, isAdmin, showInline, displayName, safeSend, adminIds } = d;
  const homeKb = () => Markup.inlineKeyboard([[Markup.button.callback('◀️ Back', 'ml_home')]]);
  const alertAdmins = (text) => Promise.all((adminIds || []).map(id => safeSend(id, text, { parse_mode: 'HTML' }))).catch(() => {});

  // admins get a heads-up when Smile One side breaks (throttled)
  let lastAlert = 0;
  const alertOnce = (text) => { if (Date.now() - lastAlert < 10 * 60 * 1000) return; lastAlert = Date.now(); alertAdmins(text); };
  const smileProblem = (e) => `⚠️ <b>ML TopUp</b> - Smile One ပြဿနာ: <code>${esc(e && e.code || '')}</code> ${esc(String(e && e.message || e).slice(0, 200))}`;

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

  // text typed while in the ML flow (called from the main text handler). returns true when handled.
  async function onText(ctx, s, text) {
    if (s.level === 'ml_uid') {
      if (!/^\d{4,15}$/.test(text)) { await ctx.reply('⚠️ Game ID က ဂဏန်းသက်သက် ဖြစ်ရပါမယ်ရှင့်။ ပြန်ပို့ပေးပါ။'); return true; }
      s.ml.uid = text; s.level = 'ml_zone';
      await ctx.reply('ကောင်းပါပြီ ✅ ဆက်ပြီး <b>Server ID</b> ပို့ပေးပါ (ကွင်းထဲက ဂဏန်း)', { parse_mode: 'HTML' });
      return true;
    }
    if (s.level === 'ml_zone') {
      if (!/^\d{1,8}$/.test(text)) { await ctx.reply('⚠️ Server ID က ဂဏန်းသက်သက် ဖြစ်ရပါမယ်ရှင့်။ ပြန်ပို့ပေးပါ။'); return true; }
      const v = findView(s.ml.key);
      if (!v || !v.enabled || !visibleTo(isAdmin(ctx.from.id))) { resetState(ctx.from.id); await ctx.reply('💎 ဒီ package ကို ခေတ္တပိတ်ထားပါသည်ရှင့်။'); return true; }
      s.ml.zone = text; s.level = 'ml_wait';
      const wait = await ctx.reply('⏳ Game name စစ်နေပါတယ်...');
      let r;
      try { r = await smile.lookup(v.pid, s.ml.uid, s.ml.zone); }
      catch (e) {
        s.level = 'ml_uid'; s.ml.uid = undefined; s.ml.zone = undefined;
        if (e && e.code === 'ROLE') {
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
        `🎮 Game name : <b>${esc(r.name || '-')}</b>\n🆔 ID : <code>${esc(s.ml.uid)}</code> (${esc(s.ml.zone)})\n` +
        `💎 ${esc(v.label)}\n💰 ဈေး : <b>${nf(v.price)}</b> ကျပ်   |   လက်ကျန် : ${nf(u && u.balance)} ကျပ်\n\n` +
        `<b>ဒီဂိမ်းနာမည် မှန်ပါသလား?</b>`;
      await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, body, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ ဟုတ်ပါတယ်', 'ml_yes'), Markup.button.callback('❌ မဟုတ်ပါ', 'ml_no')]]).reply_markup
      }).catch(() => {});
      return true;
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
    const base = { userId: uid, pkgKey: v.key, label: v.label, smilePid: v.pid, qty: v.qty, gameId: m.uid, zoneId: m.zone, gameName: m.name, price: m.price, costCoins: Math.round(m.perUnitCoins * v.qty * 10) / 10 };

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
      return send(`✅ <b>ဝယ်ယူမှု အောင်မြင်ပါတယ်ရှင့်</b>\n\n🎮 ${esc(m.name)} (${esc(m.uid)})\n💎 ${esc(v.label)}\n💰 ${nf(m.price)} ကျပ် နှုတ်ယူပြီးပါပြီ\n\nဂိမ်းထဲ မိနစ်အနည်းငယ်အတွင်း ဝင်ပါလိမ့်မယ် ❤️`);
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
  const orders = store.isUp() ? await MlOrder.find({}).sort({ createdAt: -1 }).limit(40).lean() : [];
  const today = store.isUp() ? await MlOrder.countDocuments({ createdAt: { $gte: startOfToday() }, status: { $in: ['processing', 'done', 'check'] } }) : 0;
  return {
    cfg: { enabled: c.enabled, adminOnly: c.adminOnly, live: c.live, mmkPaid: c.mmkPaid, coinsCredited: c.coinsCredited, extraFeePct: c.extraFeePct, roundTo: c.roundTo, maxCoinsPerOrder: c.maxCoinsPerOrder, maxPerDay: c.maxPerDay },
    mmkPerCoin: Math.round(mmkPerCoin(c) * 100) / 100,
    pricesLive: smile.liveAge() ? new Date(smile.liveAge()).toISOString() : null,
    session: smile.sessionInfo(),
    today,
    pkgs: allViews(),
    orders: orders.map(o => ({ id: String(o._id), userId: o.userId, label: o.label, gameId: o.gameId, zoneId: o.zoneId, gameName: o.gameName, price: o.price, costCoins: o.costCoins, chargedCoins: o.chargedCoins, qty: o.qty, delivered: o.delivered, status: o.status, note: o.note || '', createdAt: o.createdAt }))
  };
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
  if (action === 'refund') {
    if (!['check', 'processing'].includes(o.status)) throw bad('ဒီ order ကို ငွေပြန်ထည့်လို့မရပါ (failed ဆိုရင် ငွေပြန်ထည့်ပြီးသား)');
    // flip the status first (conditional) so a double click can never refund twice
    const flipped = await MlOrder.findOneAndUpdate({ _id: o._id, status: { $in: ['check', 'processing'] } }, { $set: { status: 'refunded', note: (o.note ? o.note + ' | ' : '') + 'admin: refunded' } });
    if (!flipped) throw bad('ပြောင်းပြီးသား ဖြစ်နေပါတယ်');
    await User.findByIdAndUpdate(o.userId, { $inc: { balance: o.price, totalSpent: -o.price } });
    if (safeSend) safeSend(o.userId, `↩️ Mobile Legends order အတွက် ${nf(o.price)} ကျပ် ပြန်ထည့်ပေးလိုက်ပါပြီရှင့်။`);
    return;
  }
  throw bad('action မမှန်ပါ');
}

module.exports = { register, visibleTo, adminState, adminSettings, adminPkg, adminBulk, adminOrderAction, smile };

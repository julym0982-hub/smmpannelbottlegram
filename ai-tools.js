// =======================================================================
// AI assistant "tools": the ONLY things the AI is allowed to do.
//
// Design rules (security):
//  * The customer id always comes from Telegram (ctx.userId) - never from
//    anything the AI or the customer typed. There is no tool that takes a
//    user id, so one customer can never read another customer's data.
//  * No tool moves money. The AI can only PREPARE an order (a draft). The
//    customer must tap the confirm button, which runs the normal, atomic
//    place_order code (balance check + charge + provider call).
//  * Prices always come from the server (priceFor), never from the AI.
//  * Tool results never contain provider names / provider ids.
// =======================================================================
const crypto = require('crypto');
const { Platform, Category, Service, Order, User } = require('./models');
const providers = require('./providers');

const MAX_FIND = 12;
const CATALOG_TTL = 60 * 1000;
let catalogCache = { at: 0, rows: [], platforms: [] };

async function loadCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache;
  const [platforms, categories, services] = await Promise.all([
    Platform.find({}).lean(), Category.find({}).lean(), Service.find({ active: { $ne: false } }).lean()
  ]);
  const pMap = new Map(platforms.map(p => [String(p._id), p]));
  const cMap = new Map(categories.map(c => [String(c._id), c]));
  const rows = [];
  for (const s of services) {
    const c = cMap.get(String(s.categoryId));
    if (!c) continue;
    if (!providers.isSupportedType(s.serviceType)) continue; // bot flow only handles link + quantity services
    const p = pMap.get(String(c.platform));
    rows.push({ s, platformKey: String(c.platform), platformLabel: p ? p.label : String(c.platform), categoryLabel: c.label });
  }
  catalogCache = { at: Date.now(), rows, platforms };
  return catalogCache;
}

const durationOf = (s) => s.manualDuration || providers.formatDuration(s.avgTime) || null;

function publicService(user, row, priceFor) {
  const s = row.s;
  let price = null;
  try { price = priceFor(user, s, 1000); } catch (_) { /* leave null */ }
  return {
    service_id: String(s._id),
    platform: row.platformLabel,
    category: row.categoryLabel,
    name: s.label,
    price_per_1000_kyat: price,
    min: s.min, max: s.max,
    duration: durationOf(s),
    refill: s.refill === true ? true : (s.refill === false ? false : null)
  };
}

const tool = (name, description, properties = {}, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } }
});

const DEFINITIONS = [
  tool('list_platforms', 'ဆိုင်မှာ ရှိတဲ့ platform (Telegram/TikTok/Facebook...) တွေနဲ့ ၎င်းတို့ရဲ့ category နာမည်တွေ စာရင်း။ ဘာရှိလဲ မသေချာရင် ဒါကို အရင်ခေါ်။'),
  tool('find_services', 'Service ရှာ။ query ထဲ platform/category/service နာမည်ထဲက စကားလုံးတွေ (အင်္ဂလိပ်လည်း ရ၊ ဥပမာ "tiktok like") ထည့်။ ဈေး (၁၀၀၀ အတွက်)၊ min/max၊ ကြာချိန်၊ refill ပါ/မပါ ပြန်ပေး။',
    { query: { type: 'string', description: 'ရှာမယ့် စကားလုံးများ' } }, ['query']),
  tool('order_draft', 'ဖောက်သည်ရဲ့ Order မူကြမ်း (draft) ကို ထည့်/ပြင်/ကြည့်။ ရှိတဲ့အချက်တွေကိုပဲ ပို့ (ဘာမှမပို့ရင် လက်ရှိ draft ကိုကြည့်)။ ဈေး၊ လက်ကျန်ငွေ အလုံအလောက်ရှိမရှိ၊ ဘာလိုသေးလဲ (status) ကို server က ပြန်ပေး။ Order ကို တကယ်မတင်ပါ၊ ပြီးရင် ဖောက်သည်က အတည်ပြုခလုတ် နှိပ်ရမယ်။',
    {
      service_id: { type: 'string', description: 'find_services က ရတဲ့ service_id (၂၄ လုံး)' },
      quantity: { type: 'integer', description: 'တိုးချင်တဲ့ အရေအတွက်' },
      link: { type: 'string', description: 'ဖောက်သည် ပို့တဲ့ link' },
      clear: { type: 'boolean', description: 'draft ကို အကုန်ဖျက်ပြီး အသစ်ပြန်စ' }
    }),
  tool('my_balance', 'ဖောက်သည်ရဲ့ လက်ကျန်ငွေ (ကျပ်)'),
  tool('my_orders', 'ဖောက်သည်ရဲ့ နောက်ဆုံး order များ (order_no၊ service၊ အရေအတွက်၊ status၊ ကျန်တာ)',
    { limit: { type: 'integer', description: '၁ မှ ၈' } }),
  tool('order_status', 'ဖောက်သည်ရဲ့ order တစ်ခု (order_no နဲ့) status ကြည့်',
    { order_no: { type: 'integer', description: 'Order ID နံပါတ်' } }, ['order_no'])
];

function create({ priceFor }) {
  const linkOk = (v) => typeof v === 'string' && v.length <= 500 && !/\s/.test(v) && (/^https?:\/\//i.test(v) || v.includes('.'));

  async function listPlatforms() {
    const { rows, platforms } = await loadCatalog();
    const out = new Map();
    for (const r of rows) {
      const e = out.get(r.platformKey) || { platform: r.platformLabel, categories: new Map() };
      e.categories.set(r.categoryLabel, (e.categories.get(r.categoryLabel) || 0) + 1);
      out.set(r.platformKey, e);
    }
    return {
      platforms: [...out.values()].map(e => ({ platform: e.platform, categories: [...e.categories].map(([name, n]) => `${name} (${n} ခု)`) })),
      note: platforms.length ? undefined : 'service မရှိသေးပါ'
    };
  }

  async function findServices(args, ctx) {
    const q = String(args.query || '').toLowerCase().trim().slice(0, 100);
    if (!q) return { error: 'query လိုအပ်တယ်၊ platform ကြည့်ချင်ရင် list_platforms ကိုသုံး' };
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const { rows } = await loadCatalog();
    const hay = (r) => `${r.platformLabel} ${r.platformKey} ${r.categoryLabel} ${r.s.label}`.toLowerCase();
    let hits = rows.filter(r => { const h = hay(r); return tokens.every(t => h.includes(t)); });
    let loose = false;
    if (!hits.length) { hits = rows.filter(r => { const h = hay(r); return tokens.some(t => h.includes(t)); }); loose = hits.length > 0; }
    if (!hits.length) return { results: [], note: 'မတွေ့ပါ - list_platforms နဲ့ ရှိတာကို ကြည့်ပါ' };
    return {
      total: hits.length,
      note: loose ? 'စကားလုံးအားလုံး မကိုက်ပါ၊ တစ်စိတ်တစ်ပိုင်း ကိုက်တာတွေပါ' : undefined,
      results: hits.slice(0, MAX_FIND).map(r => publicService(ctx.user, r, priceFor))
    };
  }

  async function orderDraft(args, ctx) {
    const s = ctx.session;
    let d = args.clear ? {} : Object.assign({}, s.aiDraft || {});
    const notes = [];

    if (args.service_id !== undefined && args.service_id !== null && args.service_id !== '') {
      const id = String(args.service_id).trim();
      if (!/^[0-9a-f]{24}$/i.test(id)) return { error: 'service_id မမှန်ပါ - find_services က ရတဲ့ id ကိုပဲသုံး' };
      const { rows } = await loadCatalog();
      const row = rows.find(r => String(r.s._id) === id);
      if (!row) return { error: 'ဒီ service မတွေ့ပါ (ပိတ်ထားနိုင်တယ်) - find_services နဲ့ ပြန်ရှာ' };
      d.serviceId = id;
    }
    if (args.quantity !== undefined && args.quantity !== null) {
      const n = Number(args.quantity);
      if (!Number.isInteger(n) || n <= 0) return { error: 'quantity က ၁ နဲ့အထက် ဂဏန်းပြည့် ဖြစ်ရမယ်' };
      d.quantity = n;
    }
    if (args.link !== undefined && args.link !== null && args.link !== '') {
      const l = String(args.link).trim();
      if (!linkOk(l)) return { error: 'link မမှန်ပါ (http/https နဲ့စ၊ space မပါရ) - ဖောက်သည်ကို link အမှန်ပြန်တောင်း' };
      d.link = l;
    }

    let row = null;
    if (d.serviceId) {
      const { rows } = await loadCatalog();
      row = rows.find(r => String(r.s._id) === d.serviceId) || null;
      if (!row) { delete d.serviceId; notes.push('service မရှိတော့ပါ'); }
    }
    if (row && d.quantity && (d.quantity < row.s.min || d.quantity > row.s.max)) {
      notes.push(`quantity က ${row.s.min} နဲ့ ${row.s.max} ကြား ဖြစ်ရမယ် (ထည့်ခဲ့တာ ${d.quantity})`);
      delete d.quantity;
    }

    const user = await User.findById(ctx.userId).lean();
    const balance = user ? user.balance : 0;
    let cost = null, enough = null;
    if (row && d.quantity) {
      try { cost = priceFor(user, row.s, d.quantity); } catch (_) { cost = null; }
      if (!Number.isFinite(cost) || cost <= 0) { cost = null; notes.push('ဈေးတွက်လို့မရပါ - Admin ကို ဆက်သွယ်ခိုင်း'); }
      else enough = balance >= cost;
    }

    let status;
    if (!row) status = 'need_service';
    else if (!d.quantity) status = 'need_quantity';
    else if (cost == null) status = 'price_unavailable';
    else if (!enough) status = 'need_topup';
    else if (!d.link) status = 'need_link';
    else status = 'ready_for_confirm';

    s.aiDraft = d;

    if (status === 'ready_for_confirm') {
      const nonce = crypto.randomBytes(5).toString('hex');
      Object.assign(s, {
        level: 'confirm', fromAi: true, aiNonce: nonce,
        serviceId: d.serviceId, platform: row.platformKey, categoryLabel: row.categoryLabel, serviceLabel: row.s.label,
        link: d.link, quantity: d.quantity, cost
      });
      ctx.effects.confirm = { nonce, cost, serviceLabel: row.s.label, categoryLabel: row.categoryLabel, quantity: d.quantity, link: d.link };
    } else {
      if (s.fromAi && s.level === 'confirm') { s.level = 'root'; s.fromAi = false; delete s.aiNonce; }
      if (status === 'need_topup') ctx.effects.topup = true;
    }

    return {
      status,
      draft: {
        service: row ? { service_id: String(row.s._id), platform: row.platformLabel, category: row.categoryLabel, name: row.s.label, price_per_1000_kyat: (() => { try { return priceFor(user, row.s, 1000); } catch (_) { return null; } })(), min: row.s.min, max: row.s.max, duration: durationOf(row.s) } : null,
        quantity: d.quantity || null,
        link_received: !!d.link
      },
      cost_kyat: cost, balance_kyat: balance, enough_balance: enough,
      notes: notes.length ? notes : undefined,
      instruction: ({
        need_service: 'ဘယ် service လဲ ရွေးခိုင်း (find_services)',
        need_quantity: 'အရေအတွက် မေး',
        price_unavailable: 'ဈေးမတွက်နိုင်၊ Admin ဆက်သွယ်ခိုင်း',
        need_topup: 'လက်ကျန်ငွေ မလောက်ဘူး၊ ငွေဖြည့်ဖို့ ပြော (ငွေဖြည့်ခလုတ်ကို bot က တွဲပေးမယ်)',
        need_link: 'link ပို့ခိုင်း',
        ready_for_confirm: 'bot က ကျသင့်ငွေနဲ့ အတည်ပြုခလုတ်ကို ပို့ပေးမယ်။ မင်းက စာတိုလေးပဲ ပြော၊ ငွေပမာဏ ထပ်မရေးနဲ့၊ Order တင်ပြီးပြီလို့ မပြောနဲ့'
      })[status]
    };
  }

  async function myBalance(_args, ctx) {
    const u = await User.findById(ctx.userId).lean();
    return { balance_kyat: u ? u.balance : 0 };
  }

  const mapOrder = (o) => ({
    order_no: o.orderNo, service: `${o.categoryLabel || ''} ${o.serviceLabel || ''}`.trim(), quantity: o.quantity,
    status: o.status, remains: o.remains == null ? undefined : o.remains, cost_kyat: o.cost,
    refunded_kyat: o.refundAmount || undefined, date: o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : undefined
  });

  async function myOrders(args, ctx) {
    const limit = Math.min(8, Math.max(1, parseInt(args.limit, 10) || 5));
    const list = await Order.find({ userId: ctx.userId }).sort({ createdAt: -1 }).limit(limit).lean();
    return { orders: list.map(mapOrder), note: list.length ? 'status က မိနစ်အနည်းငယ်ခြားပြီး update ဖြစ်တယ်' : 'order မရှိသေးပါ' };
  }

  async function orderStatus(args, ctx) {
    const no = parseInt(args.order_no, 10);
    if (!Number.isInteger(no)) return { error: 'order_no မမှန်ပါ' };
    const o = await Order.findOne({ orderNo: no, userId: ctx.userId }).lean(); // userId from Telegram: only OWN orders
    if (!o) return { error: 'ဒီ Order ID မတွေ့ပါ' };
    return mapOrder(o);
  }

  const impl = { list_platforms: listPlatforms, find_services: findServices, order_draft: orderDraft, my_balance: myBalance, my_orders: myOrders, order_status: orderStatus };

  return {
    definitions: DEFINITIONS,
    // a fresh context per customer message: ctx = { userId, session, effects }
    bind({ userId, session, effects }) {
      const ctx = { userId: String(userId), session, effects, user: null };
      return {
        definitions: DEFINITIONS,
        async run(name, args) {
          const fn = impl[name];
          if (!fn) return { error: 'unknown tool' };
          try {
            if (!ctx.user) ctx.user = await User.findById(ctx.userId).lean();
            return await fn(args && typeof args === 'object' ? args : {}, ctx);
          } catch (err) {
            console.error(`AI tool ${name} failed:`, err.message);
            return { error: 'စနစ်အခက်အခဲ ဖြစ်နေပါတယ်' };
          }
        }
      };
    },
    // one line about the current draft, added to the system prompt each turn so the AI remembers it
    async draftNote(session) {
      const d = session && session.aiDraft;
      if (!d || (!d.serviceId && !d.quantity && !d.link)) return '';
      let name = '';
      if (d.serviceId) { const { rows } = await loadCatalog(); const r = rows.find(x => String(x.s._id) === d.serviceId); if (r) name = `${r.categoryLabel} / ${r.s.label} (service_id ${d.serviceId})`; }
      return `လက်ရှိ order draft: service=${name || 'မရွေးရသေး'}, quantity=${d.quantity || 'မရှိသေး'}, link=${d.link ? 'ရပြီး' : 'မရသေး'} (အသေးစိတ်ကို order_draft နဲ့ ပြန်စစ်)`;
    }
  };
}

module.exports = { create };

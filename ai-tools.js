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

// English on purpose: Burmese text costs 3-4x more tokens, and Groq limits tokens per minute
const DEFINITIONS = [
  tool('list_platforms', 'List shop platforms and their categories. Call when unsure what exists.'),
  tool('find_services', 'Search services by keywords (English ok, e.g. "tiktok like"). Returns id, price per 1000 (kyat), min/max, duration, refill.',
    { query: { type: 'string' } }, ['query']),
  tool('order_draft', 'View/update the customer order draft. Send only the fields you have (none = just view). Server returns status, cost, balance. Does NOT place the order; customer must tap a confirm button.',
    {
      service_id: { type: 'string', description: 'id from find_services' },
      quantity: { type: 'integer' },
      link: { type: 'string' },
      clear: { type: 'boolean', description: 'reset draft' }
    }),
  tool('my_balance', "Customer's balance in kyat"),
  tool('my_orders', "Customer's latest orders", { limit: { type: 'integer', description: '1-8' } }),
  tool('order_status', "Status of one of the customer's orders", { order_no: { type: 'integer' } }, ['order_no'])
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
      platforms: [...out.values()].map(e => ({ platform: e.platform, categories: [...e.categories].map(([name, n]) => `${name} (${n})`) })),
      note: platforms.length ? undefined : 'no services yet'
    };
  }

  async function findServices(args, ctx) {
    const q = String(args.query || '').toLowerCase().trim().slice(0, 100);
    if (!q) return { error: 'query required; use list_platforms to browse' };
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const { rows } = await loadCatalog();
    const hay = (r) => `${r.platformLabel} ${r.platformKey} ${r.categoryLabel} ${r.s.label}`.toLowerCase();
    let hits = rows.filter(r => { const h = hay(r); return tokens.every(t => h.includes(t)); });
    let loose = false;
    if (!hits.length) { hits = rows.filter(r => { const h = hay(r); return tokens.some(t => h.includes(t)); }); loose = hits.length > 0; }
    if (!hits.length) return { results: [], note: 'no match; try list_platforms' };
    return {
      total: hits.length,
      note: loose ? 'partial matches only' : undefined,
      results: hits.slice(0, MAX_FIND).map(r => publicService(ctx.user, r, priceFor))
    };
  }

  async function orderDraft(args, ctx) {
    const s = ctx.session;
    let d = args.clear ? {} : Object.assign({}, s.aiDraft || {});
    const notes = [];

    if (args.service_id !== undefined && args.service_id !== null && args.service_id !== '') {
      const id = String(args.service_id).trim();
      if (!/^[0-9a-f]{24}$/i.test(id)) return { error: 'bad service_id; use an id from find_services' };
      const { rows } = await loadCatalog();
      const row = rows.find(r => String(r.s._id) === id);
      if (!row) return { error: 'service not found (maybe disabled); search again' };
      d.serviceId = id;
    }
    if (args.quantity !== undefined && args.quantity !== null) {
      const n = Number(args.quantity);
      if (!Number.isInteger(n) || n <= 0) return { error: 'quantity must be a positive integer' };
      d.quantity = n;
    }
    if (args.link !== undefined && args.link !== null && args.link !== '') {
      const l = String(args.link).trim();
      if (!linkOk(l)) return { error: 'invalid link (needs http/https, no spaces); ask the customer for a correct link' };
      d.link = l;
    }

    let row = null;
    if (d.serviceId) {
      const { rows } = await loadCatalog();
      row = rows.find(r => String(r.s._id) === d.serviceId) || null;
      if (!row) { delete d.serviceId; notes.push('service no longer available'); }
    }
    if (row && d.quantity && (d.quantity < row.s.min || d.quantity > row.s.max)) {
      notes.push(`quantity must be between ${row.s.min} and ${row.s.max} (got ${d.quantity})`);
      delete d.quantity;
    }

    const user = await User.findById(ctx.userId).lean();
    const balance = user ? user.balance : 0;
    let cost = null, enough = null;
    if (row && d.quantity) {
      try { cost = priceFor(user, row.s, d.quantity); } catch (_) { cost = null; }
      if (!Number.isFinite(cost) || cost <= 0) { cost = null; notes.push('price unavailable; tell customer to contact admin'); }
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
        need_service: 'ask which service (use find_services)',
        need_quantity: 'ask quantity',
        price_unavailable: 'cannot price; tell customer to contact admin',
        need_topup: 'balance too low: say so politely with cost_kyat and balance_kyat, ask to top up (bot attaches the top-up button)',
        need_link: 'ask for the link (must be public)',
        ready_for_confirm: 'bot sends cost + confirm button. Say one short line to tap it. Do not repeat the price. Never say the order is placed.'
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
    return { orders: list.map(mapOrder), note: list.length ? 'status refreshes every few minutes' : 'no orders yet' };
  }

  async function orderStatus(args, ctx) {
    const no = parseInt(args.order_no, 10);
    if (!Number.isInteger(no)) return { error: 'bad order_no' };
    const o = await Order.findOne({ orderNo: no, userId: ctx.userId }).lean(); // userId from Telegram: only OWN orders
    if (!o) return { error: 'order not found' };
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
            return { error: 'system error' };
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
      return `Current order draft: service=${name || 'none yet'}, quantity=${d.quantity || 'none yet'}, link=${d.link ? 'received' : 'not yet'} (verify with order_draft)`;
    }
  };
}

module.exports = { create };

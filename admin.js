// =======================================================================
// Web Admin Panel - REST API + static UI (admin-ui/)
//
// Login: the admin sends /adminlogin to the bot -> bot replies with a
// one-time button link -> the link logs the browser in with a signed,
// HttpOnly session cookie. Non-admins never get a link (see index.js).
// =======================================================================
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { Platform, User, Category, Service, Order, Coupon, Deposit, AdminLog, MenuButton } = require('./models');
const providers = require('./providers');
const texts = require('./texts');

const COOKIE = 'smm_admin';
const SESSION_TTL = 12 * 60 * 60 * 1000;  // 12 hours
const LOGIN_TTL = 5 * 60 * 1000;          // login link lives 5 minutes, single use
const PAGE = 20;
const MMT_OFFSET = 6.5 * 3600 * 1000;     // Myanmar time (UTC+6:30) - "today" means today in Myanmar

const SECRET = process.env.PANEL_SESSION_SECRET
  || crypto.createHash('sha256').update('smm-panel-session:' + (process.env.BOT_TOKEN || '')).digest();

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function makeSession(adminId) {
  const body = b64(JSON.stringify({ id: String(adminId), exp: Date.now() + SESSION_TTL }));
  return `${body}.${sign(body)}`;
}
function readSession(value) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return null;
  const [body, sig] = value.split('.');
  if (!safeEqual(sig, sign(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data && data.exp > Date.now() ? data : null;
  } catch (_) { return null; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const isOid = (id) => /^[0-9a-f]{24}$/i.test(String(id));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function startOfTodayMMT() {
  return new Date(Math.floor((Date.now() + MMT_OFFSET) / 86400000) * 86400000 - MMT_OFFSET);
}
function dayKey(date) { return new Date(date.getTime() + MMT_OFFSET).toISOString().slice(0, 10); }
function baseUrl() {
  return String(process.env.PANEL_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
}
function num(v, name, { min = -Infinity, max = Infinity, int = false } = {}) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (int && Math.floor(n) !== n)) {
    throw fail(400, `${name} မမှန်ပါ`);
  }
  return n;
}
function str(v, name, { max = 200, required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw fail(400, `${name} ထည့်ပါ`);
  if (s.length > max) throw fail(400, `${name} အရှည်လွန်နေသည် (${max} ထိ)`);
  return s;
}

// ---------------------------------------------------------------------
// the status buckets used by the Orders page filters
// ---------------------------------------------------------------------
const STATUS_FILTERS = {
  pending: /^pending$/i,
  processing: /^(processing|in progress)$/i,
  completed: /^completed$/i,
  partial: /^partial$/i,
  canceled: /^(canceled|cancelled)$/i,
  problem: /^(partial|error|fail|failed|canceled|cancelled)$/i
};
const SETTABLE_STATUS = { pending: 'pending', processing: 'Processing', 'in progress': 'In progress', completed: 'Completed', partial: 'Partial', canceled: 'Canceled' };

const PAYMENT_KEYS = ['kpay_number', 'kpay_name', 'wave_number', 'wave_name', 'topup_min_amount', 'low_balance_threshold'];
const NUMERIC_KEYS = () => [
  'topup_min_amount', 'low_balance_threshold',
  ...Object.keys(providers.CONFIG).flatMap(p => [`${p}_usd_to_mmk`, `${p}_markup`])
];

module.exports = function mountAdminPanel(app, deps) {
  const { bot, isAdmin, safeSend, startBroadcast, sanitizeName, toBoldUnicode, approveDeposit, rejectDeposit, refundOrder, refundIfPartial, refreshOrderStatuses } = deps;

  const loginTokens = new Map(); // token -> { adminId, exp }
  const loginAttempts = new Map(); // ip -> [timestamps]

  function createLoginUrl(adminId) {
    const base = baseUrl();
    if (!base) return null;
    for (const [t, v] of loginTokens) if (v.exp < Date.now() || v.adminId === String(adminId)) loginTokens.delete(t);
    const token = crypto.randomBytes(32).toString('base64url');
    loginTokens.set(token, { adminId: String(adminId), exp: Date.now() + LOGIN_TTL });
    return `${base}/admin/login?token=${token}`;
  }

  const log = (req, action, detail) => AdminLog.create({ admin: req.adminId, action, detail: String(detail || '').slice(0, 500) }).catch(() => {});
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error('admin api error:', err && err.stack || err);
    res.status(status).json({ error: status >= 500 ? 'server_error' : 'bad_request', message: status >= 500 ? 'Server error: ' + err.message : err.message });
  });

  app.set('trust proxy', 1); // behind Render's proxy: lets req.secure / req.ip be right
  const router = express.Router();

  // ---- security headers + static UI --------------------------------------
  router.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    next();
  });
  const uiDir = path.join(__dirname, 'admin-ui');
  const sendIndex = (req, res) => res.sendFile(path.join(uiDir, 'index.html'));
  router.get(['/', '/login'], sendIndex);
  router.use(express.static(uiDir, { index: false, maxAge: 0 }));

  // ---- API: body parsing, origin check, login ----------------------------
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET') {
      // state-changing calls must be JSON from our own origin (CSRF defence on top of SameSite=Strict)
      const origin = req.headers.origin;
      if (origin) {
        let host = ''; try { host = new URL(origin).host; } catch (_) {}
        if (host !== req.headers.host) return res.status(403).json({ error: 'forbidden', message: 'Bad origin' });
      }
      if (!req.is('application/json')) return res.status(415).json({ error: 'unsupported', message: 'JSON only' });
    }
    next();
  });

  api.post('/login', wrap(async (req, res) => {
    const ip = req.ip || 'x';
    const arr = (loginAttempts.get(ip) || []).filter(t => Date.now() - t < 60000);
    arr.push(Date.now()); loginAttempts.set(ip, arr);
    if (arr.length > 10) throw fail(429, 'ကြိုးစားမှု များလွန်းနေသည်။ ခဏနေမှ ပြန်စမ်းပါ။');

    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const entry = loginTokens.get(token);
    loginTokens.delete(token); // single use, even when it fails below
    if (!entry || entry.exp < Date.now() || !isAdmin(entry.adminId)) {
      throw fail(401, 'Link သက်တမ်းကုန်သွားပါပြီ (သို့) သုံးပြီးသားပါ။ Bot ထဲမှာ /adminlogin ပြန်ပို့ပါ။');
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie(COOKIE, makeSession(entry.adminId), {
      httpOnly: true, sameSite: 'strict', secure, path: '/admin', maxAge: SESSION_TTL
    });
    await AdminLog.create({ admin: entry.adminId, action: 'login', detail: `ip ${ip}` }).catch(() => {});
    res.json({ ok: true });
  }));

  api.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/admin' });
    res.json({ ok: true });
  });

  // ---- everything below needs a valid session ------------------------------
  api.use((req, res, next) => {
    const sess = readSession(parseCookies(req.headers.cookie)[COOKIE]);
    if (!sess || !isAdmin(sess.id)) return res.status(401).json({ error: 'unauthorized', message: 'Login လိုအပ်ပါသည်' });
    req.adminId = sess.id;
    next();
  });

  api.get('/me', (req, res) => res.json({ adminId: req.adminId, botUsername: bot.botInfo && bot.botInfo.username || null }));

  // ======================================================================
  // Dashboard
  // ======================================================================
  // revenue / profit / order count per Myanmar day. The aggregation is the
  // fast path; if the database rejects it for any reason the same numbers
  // are computed in JS so the dashboard never breaks.
  async function dailySeries(since) {
    try {
      return await Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $addFields: { net: { $subtract: ['$cost', { $ifNull: ['$refundAmount', 0] }] } } },
        { $addFields: { profit: { $cond: [
          { $and: [{ $gt: ['$cost', 0] }, { $in: [{ $type: '$baseCost' }, ['int', 'long', 'double', 'decimal']] }] },
          { $subtract: ['$net', { $multiply: ['$baseCost', { $divide: ['$net', '$cost'] }] }] },
          0
        ] } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+06:30' } },
          orders: { $sum: 1 }, revenue: { $sum: '$net' }, profit: { $sum: '$profit' }
        } }
      ]);
    } catch (err) {
      console.error('daily aggregation failed, using JS fallback:', err.message);
      const rows = await Order.find({ createdAt: { $gte: since } }).select('cost baseCost refundAmount createdAt').lean();
      const out = {};
      for (const o of rows) {
        const k = dayKey(new Date(o.createdAt));
        const net = (o.cost || 0) - (o.refundAmount || 0);
        const profit = o.cost > 0 && typeof o.baseCost === 'number' ? net - o.baseCost * (net / o.cost) : 0;
        const r = out[k] || (out[k] = { _id: k, orders: 0, revenue: 0, profit: 0 });
        r.orders += 1; r.revenue += net; r.profit += profit;
      }
      return Object.values(out);
    }
  }

  const PROBLEM = STATUS_FILTERS.problem;
  api.get('/dashboard', wrap(async (req, res) => {
    const today = startOfTodayMMT();
    const since = new Date(today.getTime() - 13 * 86400000);
    const [usersTotal, usersToday, bannedCount, ordersTotal, pendingDeposits, problemOrders, depToday, series, liability] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ banned: true }),
      Order.countDocuments(),
      Deposit.countDocuments({ status: 'pending' }),
      Order.countDocuments({ status: PROBLEM, refunded: { $ne: true } }),
      Deposit.aggregate([{ $match: { status: 'approved', handledAt: { $gte: today } } }, { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      dailySeries(since),
      User.aggregate([{ $group: { _id: null, sum: { $sum: '$balance' } } }])
    ]);

    const byDay = Object.fromEntries(series.map(r => [r._id, r]));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(new Date(today.getTime() - i * 86400000));
      const r = byDay[k] || {};
      days.push({ date: k, orders: r.orders || 0, revenue: Math.round(r.revenue || 0), profit: Math.round(r.profit || 0) });
    }
    const t = days[days.length - 1];
    const week = days.slice(-7).reduce((a, d) => ({ orders: a.orders + d.orders, revenue: a.revenue + d.revenue, profit: a.profit + d.profit }), { orders: 0, revenue: 0, profit: 0 });
    res.json({
      users: { total: usersTotal, today: usersToday, banned: bannedCount },
      orders: { total: ordersTotal, today: t.orders },
      today: { revenue: t.revenue, profit: t.profit, deposits: depToday[0] ? depToday[0].sum : 0, depositCount: depToday[0] ? depToday[0].n : 0 },
      week,
      alerts: { pendingDeposits, problemOrders },
      userBalances: liability[0] ? liability[0].sum : 0,
      days
    });
  }));

  // light endpoint polled by the UI every few seconds for the notification badge
  api.get('/alerts', wrap(async (req, res) => {
    const [pendingDeposits, latest] = await Promise.all([
      Deposit.countDocuments({ status: 'pending' }),
      Deposit.findOne({ status: 'pending' }).sort({ createdAt: -1 }).select('_id createdAt').lean()
    ]);
    res.json({ pendingDeposits, latestPendingId: latest ? String(latest._id) : null });
  }));

  let balCache = { at: 0, data: null };
  api.get('/providers/balance', wrap(async (req, res) => {
    if (!req.query.force && balCache.data && Date.now() - balCache.at < 60000) return res.json(balCache.data);
    const threshold = Number(texts.t('low_balance_threshold')) || 0;
    const data = await Promise.all(Object.keys(providers.CONFIG).map(async (p) => {
      const c = providers.CONFIG[p];
      if (!c.url || !c.key) return { provider: p, configured: false };
      try {
        const r = await providers.getBalance(p);
        const balance = Number(r && r.balance);
        return { provider: p, configured: true, balance: Number.isFinite(balance) ? balance : null, currency: r && r.currency || c.currency, low: threshold > 0 && Number.isFinite(balance) && balance < threshold };
      } catch (err) {
        console.error(`provider balance (${p}) failed:`, err.message);
        return { provider: p, configured: true, error: 'ချိတ်ဆက်မရပါ' };
      }
    }));
    balCache = { at: Date.now(), data: { providers: data, threshold } };
    res.json(balCache.data);
  }));

  // ======================================================================
  // Deposits (top-up requests)
  // ======================================================================
  async function withUsers(rows, field = 'userId') {
    const ids = [...new Set(rows.map(r => String(r[field])))];
    const users = await User.find({ _id: { $in: ids } }).select('username firstName balance').lean();
    return Object.fromEntries(users.map(u => [String(u._id), u]));
  }
  const userLabel = (u, id) => u ? sanitizeName(u.firstName || u.username || id) : String(id);

  api.get('/deposits', wrap(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = status ? { status } : {};
    const [total, rows] = await Promise.all([
      Deposit.countDocuments(filter),
      Deposit.find(filter).sort(status === 'pending' ? { createdAt: 1 } : { createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean()
    ]);
    const users = await withUsers(rows);
    res.json({
      total, page, pages: Math.max(1, Math.ceil(total / PAGE)),
      items: rows.map(d => ({
        id: String(d._id), userId: d.userId, userName: userLabel(users[d.userId], d.userId),
        username: users[d.userId] && users[d.userId].username || '',
        method: d.method, amount: d.amount, requestedAmount: d.requestedAmount, status: d.status,
        note: d.note || '', handledBy: d.handledBy || '', hasPhoto: !!d.screenshotFileId,
        createdAt: d.createdAt, handledAt: d.handledAt
      }))
    });
  }));

  // the screenshot lives on Telegram's servers - stream it through us so the
  // bot token (part of Telegram's file URL) never reaches the browser
  api.get('/deposits/:id/photo', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const d = await Deposit.findById(req.params.id).select('screenshotFileId').lean();
    if (!d || !d.screenshotFileId) throw fail(404, 'screenshot မရှိပါ');
    const link = await bot.telegram.getFileLink(d.screenshotFileId);
    const r = await axios.get(String(link), { responseType: 'stream', timeout: 20000 });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    r.data.pipe(res);
  }));

  const depositError = (r) => {
    if (r.error === 'already_handled') throw fail(409, `ဒီတောင်းဆိုမှုကို ကိုင်တွယ်ပြီးသားပါ (${r.deposit && r.deposit.status})`);
    if (r.error === 'bad_amount') throw fail(400, 'ပမာဏ မမှန်ပါ');
    throw fail(404, 'တောင်းဆိုမှု မတွေ့ပါ');
  };
  api.post('/deposits/:id/approve', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const amount = req.body.amount === undefined || req.body.amount === null || req.body.amount === ''
      ? undefined : num(req.body.amount, 'ပမာဏ', { min: 1, max: 100000000, int: true });
    const r = await approveDeposit(req.params.id, { amount, by: 'panel' });
    if (!r.ok) depositError(r);
    log(req, 'deposit_approve', `${r.deposit.userId} +${r.deposit.amount}`);
    res.json({ ok: true, deposit: { id: String(r.deposit._id), status: r.deposit.status, amount: r.deposit.amount } });
  }));
  api.post('/deposits/:id/reject', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const reason = str(req.body.reason, 'အကြောင်းရင်း', { max: 200, required: false });
    const r = await rejectDeposit(req.params.id, { reason, by: 'panel' });
    if (!r.ok) depositError(r);
    log(req, 'deposit_reject', `${r.deposit.userId} ${r.deposit.amount} ${reason}`);
    res.json({ ok: true });
  }));

  // ======================================================================
  // Users
  // ======================================================================
  api.get('/users', wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q = str(req.query.q || '', 'search', { max: 60, required: false }).replace(/^@/, '');
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ _id: q }, { username: rx }, { firstName: rx }];
    }
    if (req.query.banned === '1') filter.banned = true;
    const sort = { balance: { balance: -1 }, spent: { totalSpent: -1 }, new: { createdAt: -1 } }[req.query.sort] || { createdAt: -1 };
    const [total, rows] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort(sort).skip((page - 1) * PAGE).limit(PAGE).lean()
    ]);
    res.json({
      total, page, pages: Math.max(1, Math.ceil(total / PAGE)),
      items: rows.map(u => ({
        id: String(u._id), name: sanitizeName(u.firstName || u.username || u._id), username: u.username || '',
        balance: u.balance || 0, totalSpent: u.totalSpent || 0, banned: !!u.banned, discount: u.discount || 0, createdAt: u.createdAt
      }))
    });
  }));

  api.get('/users/:id', wrap(async (req, res) => {
    const u = await User.findById(String(req.params.id)).lean();
    if (!u) throw fail(404, 'User မတွေ့ပါ');
    const [orders, deposits, orderCount] = await Promise.all([
      Order.find({ userId: u._id }).sort({ createdAt: -1 }).limit(15).lean(),
      Deposit.find({ userId: u._id }).sort({ createdAt: -1 }).limit(10).lean(),
      Order.countDocuments({ userId: u._id })
    ]);
    res.json({
      user: { id: String(u._id), name: sanitizeName(u.firstName || u.username || u._id), username: u.username || '', balance: u.balance || 0, totalSpent: u.totalSpent || 0, banned: !!u.banned, discount: u.discount || 0, note: u.note || '', createdAt: u.createdAt },
      orderCount,
      orders: orders.map(o => ({ id: String(o._id), label: `${o.categoryLabel || ''} ${o.serviceLabel || ''}`.trim(), quantity: o.quantity, cost: o.cost, status: o.status, createdAt: o.createdAt })),
      deposits: deposits.map(d => ({ id: String(d._id), amount: d.amount, method: d.method, status: d.status, createdAt: d.createdAt }))
    });
  }));

  api.post('/users/:id/balance', wrap(async (req, res) => {
    const amount = num(req.body.amount, 'ပမာဏ', { min: 1, max: 100000000 });
    const mode = req.body.mode === 'deduct' ? 'deduct' : 'add';
    const id = String(req.params.id);
    const notify = req.body.notify !== false;
    const u = mode === 'add'
      ? await User.findByIdAndUpdate(id, { $inc: { balance: amount } }, { new: true })
      : await User.findOneAndUpdate({ _id: id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
    if (!u) {
      if (!(await User.exists({ _id: id }))) throw fail(404, 'User မတွေ့ပါ');
      throw fail(400, 'လက်ကျန်ငွေ မလုံလောက်လို့ နှုတ်၍မရပါ');
    }
    log(req, mode === 'add' ? 'balance_add' : 'balance_deduct', `${id} ${amount}`);
    if (notify) {
      await safeSend(id, mode === 'add'
        ? `Admin မှ သင့်အကောင့်ထဲသို့ ${amount} ကျပ် ထည့်ပေးလိုက်ပါပြီရှင့် ❤️`
        : `Admin မှ သင့်အကောင့်ထဲမှ ${amount} ကျပ် နှုတ်ယူလိုက်ပါပြီရှင့်။`);
    }
    res.json({ ok: true, balance: u.balance });
  }));

  api.post('/users/:id/ban', wrap(async (req, res) => {
    const banned = !!req.body.banned;
    if (isAdmin(req.params.id)) throw fail(400, 'Admin ကို ban လုပ်၍ မရပါ');
    const u = await User.findByIdAndUpdate(String(req.params.id), { banned }, { new: true });
    if (!u) throw fail(404, 'User မတွေ့ပါ');
    log(req, banned ? 'ban' : 'unban', req.params.id);
    res.json({ ok: true, banned: u.banned });
  }));

  api.post('/users/:id/profile', wrap(async (req, res) => {
    const update = {};
    if (req.body.discount !== undefined) update.discount = num(req.body.discount, 'Discount %', { min: 0, max: 100 });
    if (req.body.note !== undefined) update.note = str(req.body.note, 'Note', { max: 300, required: false });
    const u = await User.findByIdAndUpdate(String(req.params.id), update, { new: true });
    if (!u) throw fail(404, 'User မတွေ့ပါ');
    log(req, 'user_profile', `${req.params.id} ${JSON.stringify(update)}`);
    res.json({ ok: true });
  }));

  api.post('/users/:id/message', wrap(async (req, res) => {
    const text = str(req.body.text, 'Message', { max: 3500 });
    if (!(await User.exists({ _id: String(req.params.id) }))) throw fail(404, 'User မတွေ့ပါ');
    const ok = await safeSend(String(req.params.id), text);
    log(req, 'message_user', `${req.params.id} (${ok ? 'sent' : 'failed'})`);
    if (!ok) throw fail(502, 'ပို့မရပါ (User က bot ကို block ထားနိုင်သည်)');
    res.json({ ok: true });
  }));

  api.post('/broadcast', wrap(async (req, res) => {
    const text = str(req.body.text, 'Message', { max: 3500 });
    const users = await User.find(req.body.skipBanned ? { banned: { $ne: true } } : {}).select('_id').lean();
    startBroadcast(req.adminId, users.map(u => String(u._id)), text);
    log(req, 'broadcast', `${users.length} users: ${text.slice(0, 80)}`);
    res.json({ ok: true, recipients: users.length });
  }));

  // ======================================================================
  // Orders
  // ======================================================================
  api.get('/orders', wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = {};
    if (STATUS_FILTERS[req.query.status]) filter.status = STATUS_FILTERS[req.query.status];
    const q = str(req.query.q || '', 'search', { max: 200, required: false });
    if (q) {
      if (/^\d+$/.test(q)) filter.userId = q;
      else if (isOid(q)) filter._id = q;
      else filter.link = new RegExp(escapeRegex(q), 'i');
    }
    const [total, rows] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean()
    ]);
    const users = await withUsers(rows);
    res.json({
      total, page, pages: Math.max(1, Math.ceil(total / PAGE)),
      items: rows.map(o => ({
        id: String(o._id), shortId: String(o._id).slice(-6), userId: o.userId, userName: userLabel(users[o.userId], o.userId),
        label: `${o.categoryLabel || ''} ${o.serviceLabel || ''}`.trim(), link: o.link, quantity: o.quantity,
        cost: o.cost, baseCost: o.baseCost == null ? null : o.baseCost, status: o.status, remains: o.remains, startCount: o.startCount,
        provider: o.provider, providerOrderId: o.providerOrderId, refunded: !!o.refunded, refundAmount: o.refundAmount || 0,
        createdAt: o.createdAt
      }))
    });
  }));

  async function loadOrder(id) {
    if (!isOid(id)) throw fail(404, 'Order မတွေ့ပါ');
    const o = await Order.findById(id);
    if (!o) throw fail(404, 'Order မတွေ့ပါ');
    return o;
  }

  api.post('/orders/:id/refresh', wrap(async (req, res) => {
    const o = await loadOrder(req.params.id);
    await refreshOrderStatuses([o]);
    const fresh = await Order.findById(o._id).lean();
    res.json({ ok: true, status: fresh.status, remains: fresh.remains, refunded: !!fresh.refunded });
  }));

  api.post('/orders/:id/status', wrap(async (req, res) => {
    const o = await loadOrder(req.params.id);
    const key = String(req.body.status || '').toLowerCase();
    if (!SETTABLE_STATUS[key]) throw fail(400, 'Status မမှန်ပါ');
    const wasCompleted = /^completed$/i.test(o.status);
    if (o.refunded && !['canceled', 'partial'].includes(key)) throw fail(400, 'ငွေပြန်အမ်းပြီးသား order ဖြစ်၍ status ပြန်ပြောင်း၍ မရပါ');

    if (key === 'partial') {
      const remains = num(req.body.remains, 'မပြီးသေးသော အရေအတွက်', { min: 1, max: o.quantity || Infinity, int: true });
      o.remains = remains;
    }
    o.status = SETTABLE_STATUS[key];
    o.updatedAt = new Date();
    await o.save();

    let refunded = false;
    if (key === 'canceled') refunded = await refundOrder(o, o.cost, 'cancel');
    else if (key === 'partial') refunded = await refundIfPartial(o);
    else if (key === 'completed' && !wasCompleted) {
      await safeSend(o.userId, texts.t('order_complete', { link: o.link, service: o.serviceLabel || o.categoryLabel }));
    }
    log(req, 'order_status', `#${String(o._id).slice(-6)} -> ${o.status}${refunded ? ' (refunded)' : ''}`);
    res.json({ ok: true, status: o.status, refunded });
  }));

  api.post('/orders/:id/refund', wrap(async (req, res) => {
    const o = await loadOrder(req.params.id);
    if (o.refunded) throw fail(409, 'ဒီ order ကို ငွေပြန်အမ်းပြီးသားပါ');
    const amount = req.body.amount === undefined || req.body.amount === '' ? o.cost : num(req.body.amount, 'ပမာဏ', { min: 1, max: o.cost, int: true });
    const done = await refundOrder(o, amount, amount === o.cost ? 'cancel' : 'partial');
    if (!done) throw fail(409, 'ငွေပြန်အမ်း၍ မရပါ');
    log(req, 'order_refund', `#${String(o._id).slice(-6)} ${amount}`);
    res.json({ ok: true, amount });
  }));

  api.delete('/orders/:id', wrap(async (req, res) => {
    const o = await loadOrder(req.params.id);
    await o.deleteOne();
    log(req, 'order_delete', `#${String(o._id).slice(-6)}`);
    res.json({ ok: true });
  }));

  // ======================================================================
  // Catalogue: home buttons -> categories -> services
  // ======================================================================
  function salePer1000(s) {
    try { return providers.calcSaleCost(s.provider, s.rate, 1000); } catch (_) { return null; }
  }
  api.get('/catalog', wrap(async (req, res) => {
    const [platforms, categories, services] = await Promise.all([
      Platform.find({}).sort({ _id: 1 }).lean(), Category.find({}).sort({ platform: 1, createdAt: 1 }).lean(), Service.find({}).sort({ createdAt: 1 }).lean()
    ]);
    res.json({
      platforms: platforms.map(p => ({ key: String(p._id), label: p.label })),
      categories: categories.map(c => ({ id: String(c._id), platform: c.platform, label: c.label })),
      services: services.map(s => ({
        id: String(s._id), categoryId: String(s.categoryId), label: s.label, provider: s.provider, providerServiceId: s.providerServiceId,
        providerName: s.providerName, rate: s.rate, min: s.min, max: s.max, active: s.active !== false,
        manualDuration: s.manualDuration || '', salePer1000: salePer1000(s), lastSynced: s.lastSynced
      }))
    });
  }));

  const KEY_RX = /^[a-z0-9_-]{1,30}$/;
  api.post('/platforms', wrap(async (req, res) => {
    const key = str(req.body.key, 'Key', { max: 30 }).toLowerCase();
    if (!KEY_RX.test(key)) throw fail(400, 'Key မှာ English စာလုံးသေး/ဂဏန်း/-/_ သာ ပါရမည်');
    const label = toBoldUnicode(str(req.body.label, 'Label', { max: 40 }));
    await Platform.findByIdAndUpdate(key, { _id: key, label }, { upsert: true });
    log(req, 'platform_save', `${key} ${label}`);
    res.json({ ok: true });
  }));
  api.delete('/platforms/:key', wrap(async (req, res) => {
    const key = String(req.params.key).toLowerCase();
    const removed = await Platform.findByIdAndDelete(key);
    if (!removed) throw fail(404, 'Home button မတွေ့ပါ');
    const cats = await Category.find({ platform: key }).select('_id').lean();
    await Service.deleteMany({ categoryId: { $in: cats.map(c => c._id) } });
    await Category.deleteMany({ platform: key });
    log(req, 'platform_delete', key);
    res.json({ ok: true });
  }));

  api.post('/categories', wrap(async (req, res) => {
    const platform = str(req.body.platform, 'Platform', { max: 30 }).toLowerCase();
    if (!(await Platform.exists({ _id: platform }))) throw fail(400, 'Home button မတွေ့ပါ');
    const label = str(req.body.label, 'Category label', { max: 60 });
    const exists = await Category.findOne({ platform, label });
    if (exists) throw fail(409, 'ဒီ category နာမည် ရှိပြီးသားပါ');
    const c = await Category.create({ platform, label });
    log(req, 'category_add', `${platform}/${label}`);
    res.json({ ok: true, id: String(c._id) });
  }));
  api.patch('/categories/:id', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const label = str(req.body.label, 'Category label', { max: 60 });
    const c = await Category.findById(req.params.id);
    if (!c) throw fail(404, 'Category မတွေ့ပါ');
    if (await Category.exists({ platform: c.platform, label, _id: { $ne: c._id } })) throw fail(409, 'ဒီ category နာမည် ရှိပြီးသားပါ');
    c.label = label; await c.save();
    res.json({ ok: true });
  }));
  api.delete('/categories/:id', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const c = await Category.findByIdAndDelete(req.params.id);
    if (!c) throw fail(404, 'Category မတွေ့ပါ');
    const { deletedCount } = await Service.deleteMany({ categoryId: c._id });
    log(req, 'category_delete', `${c.label} (+${deletedCount} services)`);
    res.json({ ok: true, deletedServices: deletedCount });
  }));

  api.patch('/services/:id', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const s = await Service.findById(req.params.id);
    if (!s) throw fail(404, 'Service မတွေ့ပါ');
    if (req.body.label !== undefined) s.label = str(req.body.label, 'Button label', { max: 80 });
    if (req.body.active !== undefined) s.active = !!req.body.active;
    if (req.body.manualDuration !== undefined) s.manualDuration = str(req.body.manualDuration, 'ကြာချိန်', { max: 60, required: false });
    if (req.body.categoryId !== undefined) {
      if (!isOid(req.body.categoryId) || !(await Category.exists({ _id: req.body.categoryId }))) throw fail(400, 'Category မတွေ့ပါ');
      s.categoryId = req.body.categoryId;
    }
    // the bot finds a service by its button label inside its category - two equal labels would clash
    if (await Service.exists({ categoryId: s.categoryId, label: s.label, _id: { $ne: s._id } })) throw fail(409, 'ဒီ category ထဲမှာ button label တူနေပါသည်');
    await s.save();
    log(req, 'service_edit', `${s.label} active=${s.active}`);
    res.json({ ok: true });
  }));
  api.delete('/services/:id', wrap(async (req, res) => {
    if (!isOid(req.params.id)) throw fail(404, 'not found');
    const s = await Service.findByIdAndDelete(req.params.id);
    if (!s) throw fail(404, 'Service မတွေ့ပါ');
    log(req, 'service_delete', s.label);
    res.json({ ok: true });
  }));

  api.post('/services/sync', wrap(async (req, res) => {
    const services = await Service.find({});
    const byProvider = {};
    for (const s of services) (byProvider[s.provider] = byProvider[s.provider] || []).push(s);
    let ok = 0, failed = 0, missing = 0;
    for (const p of Object.keys(byProvider)) {
      let list;
      try { list = await providers.listServices(p, true); } catch (err) { failed += byProvider[p].length; continue; }
      const map = new Map(list.map(x => [String(x.service), x]));
      for (const s of byProvider[p]) {
        const f = map.get(String(s.providerServiceId));
        if (!f) { missing++; continue; }
        s.rate = Number(f.rate); s.min = Number(f.min); s.max = Number(f.max); s.providerName = f.name;
        s.lastSynced = new Date();
        await s.save(); ok++;
      }
    }
    log(req, 'services_sync', `ok ${ok} fail ${failed} missing ${missing}`);
    res.json({ ok: true, updated: ok, failed, missing });
  }));

  // ---- browse a provider's catalogue and add services in one click -------
  const PROVIDER_PAGE = 30;
  function checkProvider(p) {
    const name = String(p || '').toLowerCase();
    if (!providers.CONFIG[name]) throw fail(404, 'Provider မတွေ့ပါ');
    return name;
  }
  api.get('/providers/:p/services', wrap(async (req, res) => {
    const p = checkProvider(req.params.p);
    let list;
    try { list = await providers.listServices(p, req.query.force === '1'); }
    catch (err) { console.error(`provider list (${p}) failed:`, err.message); throw fail(502, `${p} ဆီက service စာရင်း ဆွဲမရပါ - API URL/KEY ကို စစ်ပါ`); }

    const cats = {};
    for (const s of list) { const c = String(s.category || '—'); cats[c] = (cats[c] || 0) + 1; }
    const q = str(req.query.q || '', 'search', { max: 80, required: false }).toLowerCase();
    const category = String(req.query.category || '');
    let rows = list;
    if (category) rows = rows.filter(s => String(s.category || '—') === category);
    if (q) rows = rows.filter(s => String(s.service) === q || String(s.name).toLowerCase().includes(q) || String(s.category || '').toLowerCase().includes(q));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const slice = rows.slice((page - 1) * PROVIDER_PAGE, page * PROVIDER_PAGE);
    const used = new Set((await Service.find({ provider: p, providerServiceId: { $in: slice.map(s => String(s.service)) } }).select('providerServiceId').lean()).map(s => s.providerServiceId));
    res.json({
      total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / PROVIDER_PAGE)),
      categories: Object.entries(cats).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
      items: slice.map(s => {
        const rate = Number(s.rate);
        let sale = null;
        try { sale = providers.calcSaleCost(p, rate, 1000); } catch (_) {}
        let base = null;
        try { base = providers.calcBaseCost(p, rate, 1000); } catch (_) {}
        return { service: String(s.service), name: s.name, category: s.category || '', type: s.type || '', rate, min: Number(s.min), max: Number(s.max), refill: !!s.refill, cancel: !!s.cancel, salePer1000: sale, basePer1000: base, added: used.has(String(s.service)) };
      })
    });
  }));

  api.post('/services/add', wrap(async (req, res) => {
    const provider = checkProvider(req.body.provider);
    const platformKey = str(req.body.platform, 'Home button', { max: 30 }).toLowerCase();
    if (!KEY_RX.test(platformKey)) throw fail(400, 'Home button key မမှန်ပါ');
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    if (!items.length) throw fail(400, 'Service တစ်ခုမှ မရွေးထားပါ');

    let platform = await Platform.findById(platformKey);
    if (!platform) {
      const label = toBoldUnicode(str(req.body.platformLabel || platformKey.charAt(0).toUpperCase() + platformKey.slice(1) + ' Service', 'Home button label', { max: 40 }));
      platform = await Platform.create({ _id: platformKey, label });
    }
    let category;
    if (req.body.categoryId) {
      if (!isOid(req.body.categoryId)) throw fail(400, 'Category မမှန်ပါ');
      category = await Category.findOne({ _id: req.body.categoryId, platform: platformKey });
      if (!category) throw fail(400, 'Category မတွေ့ပါ');
    } else {
      const label = str(req.body.categoryLabel, 'Category label', { max: 60 });
      category = await Category.findOne({ platform: platformKey, label }) || await Category.create({ platform: platformKey, label });
    }

    let list;
    try { list = await providers.listServices(provider); } catch (err) { throw fail(502, 'Provider ဆီက စာရင်း ဆွဲမရပါ'); }
    const map = new Map(list.map(x => [String(x.service), x]));
    const created = [], skipped = [];
    for (const it of items) {
      const sid = String(it.providerServiceId || '').trim();
      const info = map.get(sid);
      if (!info) { skipped.push({ id: sid, reason: 'provider ထဲ မတွေ့ပါ' }); continue; }
      if (await Service.exists({ categoryId: category._id, provider, providerServiceId: sid })) { skipped.push({ id: sid, reason: 'ဒီ category ထဲ ရှိပြီးသား' }); continue; }
      let label = str(typeof it.label === 'string' && it.label.trim() && it.label.trim() !== '-' ? it.label : info.name, 'Button label', { max: 80 });
      if (await Service.exists({ categoryId: category._id, label })) label = `${label} #${sid}`.slice(0, 80);
      const svc = await Service.create({
        categoryId: category._id, label, provider, providerServiceId: sid, providerName: info.name,
        rate: Number(info.rate), min: Number(info.min), max: Number(info.max),
        avgTime: info.average_time || info.averageTime || null, lastSynced: new Date()
      });
      created.push({ id: String(svc._id), label });
    }
    log(req, 'services_add', `${provider} -> ${platformKey}/${category.label}: +${created.length}`);
    res.json({ ok: true, created, skipped, categoryId: String(category._id) });
  }));

  // ======================================================================
  // Coupons
  // ======================================================================
  api.get('/coupons', wrap(async (req, res) => {
    const rows = await Coupon.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items: rows.map(c => ({ code: String(c._id), amount: c.amount, remaining: c.remaining, used: (c.usedBy || []).length, createdAt: c.createdAt })) });
  }));
  api.post('/coupons', wrap(async (req, res) => {
    const amount = num(req.body.amount, 'တန်ဖိုး', { min: 1, max: 10000000 });
    const count = num(req.body.count, 'အရေအတွက်', { min: 1, max: 100000, int: true });
    let code = str(req.body.code, 'Code', { max: 30, required: false }).toUpperCase();
    if (code && !/^[A-Z0-9_-]+$/.test(code)) throw fail(400, 'Code မှာ English စာလုံး/ဂဏန်းသာ ပါရမည်');
    if (!code) code = 'SMM' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    if (await Coupon.exists({ _id: code })) throw fail(409, 'ဒီ code ရှိပြီးသားပါ');
    await Coupon.create({ _id: code, amount, remaining: count });
    log(req, 'coupon_create', `${code} ${amount}x${count}`);
    res.json({ ok: true, code });
  }));
  api.delete('/coupons/:code', wrap(async (req, res) => {
    const c = await Coupon.findByIdAndDelete(String(req.params.code).toUpperCase());
    if (!c) throw fail(404, 'Coupon မတွေ့ပါ');
    log(req, 'coupon_delete', c._id);
    res.json({ ok: true });
  }));

  // ======================================================================
  // Settings: pricing, payment numbers, bot messages, menu buttons
  // ======================================================================
  api.get('/settings', wrap(async (req, res) => {
    const pricing = {};
    for (const p of Object.keys(providers.CONFIG)) {
      pricing[p] = { usd_to_mmk: texts.t(`${p}_usd_to_mmk`), markup: texts.t(`${p}_markup`), configured: !!(providers.CONFIG[p].url && providers.CONFIG[p].key) };
    }
    const payment = Object.fromEntries(PAYMENT_KEYS.map(k => [k, texts.t(k)]));
    const hidden = new Set([...PAYMENT_KEYS, ...NUMERIC_KEYS()]);
    const messages = texts.allKeys().filter(k => !hidden.has(k)).map(k => ({
      key: k, value: texts.getRaw(k), isDefault: texts.getRaw(k) === texts.DEFAULTS[k], placeholders: [...new Set((texts.DEFAULTS[k].match(/\$\{\w+\}/g) || []))]
    }));
    const buttons = await MenuButton.find({}).sort({ createdAt: 1 }).lean();
    res.json({ pricing, payment, messages, menuButtons: buttons.map(b => ({ label: String(b._id), url: b.url })) });
  }));

  api.post('/settings', wrap(async (req, res) => {
    const values = req.body.values && typeof req.body.values === 'object' ? req.body.values : null;
    if (!values) throw fail(400, 'values မပါပါ');
    const numeric = new Set(NUMERIC_KEYS());
    const entries = Object.entries(values);
    if (!entries.length || entries.length > 40) throw fail(400, 'values မမှန်ပါ');
    // validate everything first so a bad value never leaves a half-applied change
    for (const [k, v] of entries) {
      if (!texts.allKeys().includes(k)) throw fail(400, `"${k}" ဆိုတဲ့ key မရှိပါ`);
      if (typeof v !== 'string' && typeof v !== 'number') throw fail(400, `${k} မမှန်ပါ`);
      const sv = String(v).trim();
      if (numeric.has(k)) {
        const n = Number(sv);
        const mustBePositive = k.endsWith('_usd_to_mmk') || k.endsWith('_markup') || k === 'topup_min_amount';
        if (!sv || !Number.isFinite(n) || n < 0 || (mustBePositive && n <= 0)) throw fail(400, `${k} သည် မှန်ကန်သော ဂဏန်း ဖြစ်ရမည်`);
      } else if (!sv || sv.length > 2000) {
        throw fail(400, `${k} မှာ စာသား ထည့်ပါ (အများဆုံး 2000)`);
      }
    }
    for (const [k, v] of entries) await texts.setText(k, String(v).trim());
    balCache = { at: 0, data: null };
    log(req, 'settings', entries.map(([k]) => k).join(', '));
    res.json({ ok: true });
  }));

  api.post('/settings/reset', wrap(async (req, res) => {
    const key = String(req.body.key || '');
    if (!texts.allKeys().includes(key)) throw fail(400, 'key မမှန်ပါ');
    await texts.resetText(key);
    log(req, 'settings_reset', key);
    res.json({ ok: true, value: texts.getRaw(key) });
  }));

  api.post('/menu-buttons', wrap(async (req, res) => {
    const label = str(req.body.label, 'Button label', { max: 40 });
    const url = str(req.body.url, 'URL', { max: 300 });
    if (!/^(https?:\/\/|tg:\/\/)/i.test(url)) throw fail(400, 'URL သည် https:// (သို့) tg:// ဖြင့် စရမည်');
    await MenuButton.findByIdAndUpdate(label, { _id: label, url }, { upsert: true });
    log(req, 'menu_button_save', label);
    res.json({ ok: true });
  }));
  api.post('/menu-buttons/delete', wrap(async (req, res) => {
    const removed = await MenuButton.findByIdAndDelete(String(req.body.label || ''));
    if (!removed) throw fail(404, 'Button မတွေ့ပါ');
    log(req, 'menu_button_delete', removed._id);
    res.json({ ok: true });
  }));

  api.get('/logs', wrap(async (req, res) => {
    const rows = await AdminLog.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items: rows.map(l => ({ admin: l.admin, action: l.action, detail: l.detail, createdAt: l.createdAt })) });
  }));

  api.use((req, res) => res.status(404).json({ error: 'not_found', message: 'Not found' }));
  router.use('/api', api);
  app.use('/admin', router);

  return { createLoginUrl };
};

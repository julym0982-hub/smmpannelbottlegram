// =======================================================================
// AI chat log - stored in a SEPARATE MongoDB (env MONGODB_URI_AI) so the
// customer <-> AI conversations never fill up the main database.
//  - every customer question + AI answer is saved
//  - MongoDB deletes entries older than AI_LOG_DAYS (default 7) by itself
//    (TTL index), so storage stays small
//  - if MONGODB_URI_AI is not set, logging is simply switched off
// =======================================================================
const mongoose = require('mongoose');

const URI = String(process.env.MONGODB_URI_AI || '').trim().replace(/^["']|["']$/g, '');
const DAYS = Math.min(365, Math.max(1, Math.floor(Number(process.env.AI_LOG_DAYS)) || 7));
const TTL = DAYS * 86400;

let conn = null, Chat = null, ready = false;

if (URI) {
  conn = mongoose.createConnection(URI, { serverSelectionTimeoutMS: 15000 });
  conn.on('error', (e) => console.error('AI-log MongoDB error:', e.message));
  const schema = new mongoose.Schema({
    userId: { type: String, index: true },
    name: String,
    username: String,
    question: String,
    reply: String,
    provider: String,
    blocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }, { autoIndex: false });
  schema.index({ createdAt: 1 }, { expireAfterSeconds: TTL });
  schema.index({ userId: 1, createdAt: 1 });
  Chat = conn.model('AiChatLog', schema);
}

async function init() {
  if (!URI) { console.log('AI chat log: OFF (MONGODB_URI_AI not set)'); return; }
  try {
    await conn.asPromise();
    try { await Chat.createIndexes(); }
    catch (e) {
      // AI_LOG_DAYS was changed since the index was created -> update its expiry in place
      if (/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(e.message)) {
        await conn.db.command({ collMod: Chat.collection.collectionName, index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: TTL } });
      } else throw e;
    }
    ready = true;
    console.log(`AI chat log: ON (auto-delete after ${DAYS} days)`);
  } catch (e) { console.error('AI chat log init failed (logging disabled):', e.message); }
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// fire-and-forget: a logging problem must never break the customer's chat
function save({ userId, name, username, question, reply, provider, blocked }) {
  if (!ready) return;
  Chat.create({ userId: String(userId), name: clip(name, 60), username: clip(username, 40), question: clip(question, 1200), reply: clip(reply, 4100), provider: clip(provider, 20), blocked: !!blocked })
    .catch(e => console.error('AI chat log save failed:', e.message));
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// customers who chatted, newest conversation first
async function listUsers({ q = '', page = 1, per = 20, sort = 'recent' }) {
  if (!ready) return { enabled: false, items: [], total: 0, page: 1, pages: 1, days: DAYS };
  const match = {};
  const s = String(q || '').trim().slice(0, 40);
  if (s) { const re = new RegExp(esc(s), 'i'); match.$or = [{ userId: re }, { name: re }, { username: re }]; }
  const MMT = 6.5 * 3600 * 1000;
  const todayStart = new Date(Math.floor((Date.now() + MMT) / 86400000) * 86400000 - MMT); // 00:00 Myanmar time
  const base = [{ $match: match }, { $group: { _id: '$userId', name: { $last: '$name' }, username: { $last: '$username' }, count: { $sum: 1 }, today: { $sum: { $cond: [{ $gte: ['$createdAt', todayStart] }, 1, 0] } }, first: { $min: '$createdAt' }, last: { $max: '$createdAt' }, lastQuestion: { $last: '$question' } } }];
  const order = sort === 'count' ? { count: -1, last: -1 } : { last: -1 };
  const [{ n = 0 } = {}] = await Chat.aggregate([...base, { $count: 'n' }]);
  const pages = Math.max(1, Math.ceil(n / per));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await Chat.aggregate([{ $match: match }, { $sort: { createdAt: 1 } }, ...base.slice(1), { $sort: order }, { $skip: (p - 1) * per }, { $limit: per }]);
  return { enabled: true, days: DAYS, total: n, page: p, pages, items: rows.map(r => ({ userId: r._id, name: r.name || '', username: r.username || '', count: r.count, today: r.today, first: r.first, last: r.last, lastQuestion: clip(r.lastQuestion, 80) })) };
}

// one customer's whole conversation (oldest -> newest)
async function conversation(userId, limit = 300) {
  if (!ready) return [];
  const rows = await Chat.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.reverse().map(r => ({ question: r.question, reply: r.reply, provider: r.provider || '', blocked: !!r.blocked, createdAt: r.createdAt }));
}

async function clearUser(userId) {
  if (!ready) return 0;
  return (await Chat.deleteMany({ userId: String(userId) })).deletedCount;
}

module.exports = { init, save, listUsers, conversation, clearUser, enabled: () => ready, days: DAYS };

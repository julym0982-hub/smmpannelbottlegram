// =======================================================================
// History retention: keeps MongoDB (free 512MB) from filling up.
//  - finished orders older than `history_keep_days` are deleted,
//    EXCEPT each user's newest `history_keep_last` orders (always kept)
//  - active orders (pending / processing) are never touched
//  - before deleting, the revenue/profit/order counts are added to the
//    daily Stat collection, so the dashboard totals stay correct
//  - old closed deposits, help requests and admin logs (>30 days) go too
// =======================================================================
const { Order, Deposit, HelpRequest, AdminLog, Stat, AiUsage } = require('./models');
const texts = require('./texts');

const MMT_OFFSET = 6.5 * 3600 * 1000;
const DAY = 86400000;
const FINISHED = /^(completed|canceled|cancelled|partial|error|fail|failed)$/i;
const dayKey = (d) => new Date(new Date(d).getTime() + MMT_OFFSET).toISOString().slice(0, 10);

function settings() {
  const keepDays = Math.max(1, Math.floor(Number(texts.t('history_keep_days')) || 5));
  const keepLast = Math.max(0, Math.floor(Number(texts.t('history_keep_last'))));
  return { keepDays, keepLast: Number.isFinite(keepLast) ? keepLast : 6 };
}

// dryRun: only count what WOULD be removed (looks at up to 20,000 orders)
async function cleanOrders({ dryRun = false } = {}) {
  const { keepDays, keepLast } = settings();
  const cutoff = new Date(Date.now() - keepDays * DAY);
  let deleted = 0, passes = 0;
  const keepCache = new Map();
  for (;;) {
    const old = await Order.find({ createdAt: { $lt: cutoff }, status: FINISHED })
      .sort({ createdAt: 1 }).limit(dryRun ? 20000 : 3000).select('userId createdAt cost baseCost refundAmount').lean();
    if (!old.length) break;
    // each affected user's newest N orders are protected
    const users = [...new Set(old.map(o => o.userId))].filter(u => !keepCache.has(u));
    for (const u of users) {
      const newest = keepLast > 0
        ? await Order.find({ userId: u }).sort({ createdAt: -1 }).limit(keepLast).select('_id').lean()
        : [];
      keepCache.set(u, new Set(newest.map(o => String(o._id))));
    }
    const doomed = old.filter(o => !keepCache.get(o.userId).has(String(o._id)));
    if (dryRun) { deleted = doomed.length; break; }
    if (doomed.length) {
      await Order.deleteMany({ _id: { $in: doomed.map(o => o._id) } });
      // add the removed orders to the daily totals
      const days = {};
      for (const o of doomed) {
        const net = (o.cost || 0) - (o.refundAmount || 0);
        const profit = o.cost > 0 && typeof o.baseCost === 'number' ? net - o.baseCost * (net / o.cost) : 0;
        const r = days[dayKey(o.createdAt)] || (days[dayKey(o.createdAt)] = { orders: 0, revenue: 0, profit: 0 });
        r.orders += 1; r.revenue += net; r.profit += profit;
      }
      for (const [k, r] of Object.entries(days)) {
        await Stat.findOneAndUpdate({ _id: k }, { $inc: { orders: r.orders, revenue: Math.round(r.revenue), profit: Math.round(r.profit) } }, { upsert: true });
      }
      deleted += doomed.length;
    }
    // everything left in this batch is protected - stop instead of looping forever
    if (doomed.length === 0 || ++passes >= 30 || old.length < 3000) break;
  }
  return { orders: deleted, keepDays, keepLast };
}

async function runCleanup({ dryRun = false } = {}) {
  const res = await cleanOrders({ dryRun });
  const cutoff30 = new Date(Date.now() - 30 * DAY);
  if (dryRun) {
    res.deposits = await Deposit.countDocuments({ status: { $ne: 'pending' }, createdAt: { $lt: cutoff30 } });
    res.help = await HelpRequest.countDocuments({ status: 'done', createdAt: { $lt: cutoff30 } });
    res.logs = await AdminLog.countDocuments({ createdAt: { $lt: cutoff30 } });
  } else {
    res.deposits = (await Deposit.deleteMany({ status: { $ne: 'pending' }, createdAt: { $lt: cutoff30 } })).deletedCount;
    res.help = (await HelpRequest.deleteMany({ status: 'done', createdAt: { $lt: cutoff30 } })).deletedCount;
    res.logs = (await AdminLog.deleteMany({ createdAt: { $lt: cutoff30 } })).deletedCount;
    await AiUsage.deleteMany({ createdAt: { $lt: new Date(Date.now() - 3 * DAY) } }); // daily question counters are only needed for today
    await texts.setText('history_last_cleanup', new Date().toISOString());
  }
  return res;
}

// runs at startup and every few hours; actually cleans at most once per ~day
async function autoCleanup() {
  if (texts.t('history_auto') !== '1') return;
  const last = Date.parse(texts.t('history_last_cleanup')) || 0;
  if (Date.now() - last < 20 * 3600 * 1000) return;
  try {
    const r = await runCleanup();
    console.log(`History cleanup: orders ${r.orders}, deposits ${r.deposits}, help ${r.help}, logs ${r.logs}`);
  } catch (err) { console.error('History cleanup failed:', err.message); }
}

module.exports = { runCleanup, autoCleanup, settings };

// =======================================================================
// "Store" database - an OPTIONAL third MongoDB (env MONGODB_URI_STORE).
// Holds the bulky / fast-growing data so the main database (users, orders,
// balances, services) stays small:
//   - Telegram accounts for sale + their sale history (TgAccount)
//   - the admin Activity Log (AdminLog)
// If MONGODB_URI_STORE is NOT set everything simply stays in the main
// database exactly as before - nothing breaks.
// =======================================================================
const mongoose = require('mongoose');

const URI = String(process.env.MONGODB_URI_STORE || '').trim().replace(/^["']|["']$/g, '');
const separate = !!URI;
let db = mongoose; // default connection (same as the main database)

if (separate) {
  db = mongoose.createConnection(URI, { serverSelectionTimeoutMS: 15000 });
  db.on('error', (e) => console.error('Store MongoDB error:', e.message));
  db.on('disconnected', () => console.warn('Store MongoDB disconnected - driver will try to reconnect...'));
}

// true while queries to the store can run. Callers skip store work when false
// instead of waiting for Mongoose's 10 s buffering timeout.
const isUp = () => !separate || db.readyState === 1;

async function init() {
  if (!separate) { console.log('Store DB: same as main database (MONGODB_URI_STORE not set)'); return; }
  try {
    await db.asPromise();
    console.log('Store DB: connected (separate MongoDB)');
  } catch (e) { console.error('Store DB connection failed:', e.message); }
}

module.exports = { db, separate, isUp, init };

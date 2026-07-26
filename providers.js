const axios = require('axios');

// Both ShweBoost and Secsers (like almost every SMM reseller panel) expose
// the same "Perfect Panel" style API: one endpoint, an `action` field picks
// the operation. If either site's real API differs from this shape, only
// this file needs to change - nothing else in the bot depends on the
// specific provider.
const CONFIG = {
  shweboost: {
    url: process.env.SHWEBOOST_API_URL,
    key: process.env.SHWEBOOST_API_KEY,
    currency: 'MMK',
    // provider's own cost is already in MMK - we mark it up
    toSaleCost: (providerCostMMK) =>
      providerCostMMK * Number(process.env.SHWEBOOST_MARKUP_MULTIPLIER || 2.3)
  },
  secsers: {
    url: process.env.SECSERS_API_URL,
    key: process.env.SECSERS_API_KEY,
    currency: 'USD',
    // provider's cost comes back in USD - convert to MMK, then mark up
    toSaleCost: (providerCostUSD) =>
      providerCostUSD *
      Number(process.env.SECSERS_USD_TO_MMK || 4400) *
      Number(process.env.SECSERS_MARKUP_MULTIPLIER || 1)
  }
};

function cfg(provider) {
  const c = CONFIG[provider];
  if (!c) throw new Error(`Unknown provider "${provider}"`);
  if (!c.url || !c.key) throw new Error(`${provider} API URL/KEY not set in .env yet`);
  return c;
}

async function call(provider, params) {
  const c = cfg(provider);
  const { data } = await axios.post(c.url, Object.assign({ key: c.key }, params), { timeout: 20000 });
  return data;
}

// Fetch the provider's full services list and find one entry (used both by
// the admin /+id flow, to auto-fill rate/min/max, and by /syncservices to
// refresh prices later).
async function fetchServiceInfo(provider, providerServiceId) {
  const list = await call(provider, { action: 'services' });
  if (!Array.isArray(list)) throw new Error('Unexpected response from provider services list');
  const found = list.find(s => String(s.service) === String(providerServiceId));
  if (!found) throw new Error(`Service id ${providerServiceId} ကို ${provider} ထဲမှာ ရှာမတွေ့ပါ`);
  return {
    providerName: found.name,
    rate: Number(found.rate),
    min: Number(found.min),
    max: Number(found.max),
    // some panels return average time in a field like "average_time" or "dripfeed" info; not all do
    avgTimeMinutes: found.average_time ? Number(found.average_time) : null
  };
}

// cost of ONE order in MMK, for display + balance deduction
function calcSaleCost(provider, rate, quantity) {
  const providerCost = (rate / 1000) * quantity; // in provider's own currency
  return Math.ceil(cfg(provider).toSaleCost(providerCost));
}

async function placeOrder(provider, providerServiceId, link, quantity) {
  const res = await call(provider, { action: 'add', service: providerServiceId, link, quantity });
  if (!res || (!res.order && res.order !== 0)) {
    throw new Error((res && (res.error || JSON.stringify(res))) || 'Unknown error placing order');
  }
  return res.order;
}

async function orderStatus(provider, providerOrderId) {
  return call(provider, { action: 'status', order: providerOrderId });
}

async function orderStatusBulk(provider, providerOrderIds) {
  // Perfect-Panel APIs support batch status via comma-separated orders
  if (!providerOrderIds.length) return {};
  return call(provider, { action: 'status', orders: providerOrderIds.join(',') });
}

async function cancelOrder(provider, providerOrderId) {
  const res = await call(provider, { action: 'cancel', orders: String(providerOrderId) });
  // most panels return [{ order: id, cancel: { status: 'Awaiting' / error msg } }, ...] or similar
  if (Array.isArray(res)) {
    const entry = res.find(r => String(r.order) === String(providerOrderId));
    if (entry && entry.cancel && !entry.cancel.error) return true;
    return false;
  }
  if (res && !res.error) return true;
  return false;
}

async function getBalance(provider) {
  return call(provider, { action: 'balance' });
}

module.exports = {
  CONFIG, fetchServiceInfo, calcSaleCost, placeOrder, orderStatus, orderStatusBulk, cancelOrder, getBalance
};

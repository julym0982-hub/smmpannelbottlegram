const axios = require('axios');
const texts = require('./texts');

// Both ShweBoost and Secsers (like almost every SMM reseller panel) expose
// the same "Perfect Panel" style API: one endpoint, an `action` field picks
// the operation. If either site's real API differs from this shape, only
// this file needs to change - nothing else in the bot depends on the
// specific provider.
const CONFIG = {
  shweboost: {
    url: process.env.SHWEBOOST_API_URL,
    key: process.env.SHWEBOOST_API_KEY,
    currency: 'USD',
    // ShweBoost's own API quotes rate/balance/order-status in USD (confirmed
    // from their API docs) - convert to MMK, then mark up. Rates are read
    // live from texts.js so admin can change them with /setrate, no
    // redeploy or env var editing needed.
    toSaleCost: (providerCostUSD) =>
      providerCostUSD *
      Number(texts.t('shweboost_usd_to_mmk')) *
      Number(texts.t('shweboost_markup'))
  },
  secsers: {
    url: process.env.SECSERS_API_URL,
    key: process.env.SECSERS_API_KEY,
    currency: 'USD',
    // Secsers also quotes in USD - convert to MMK, then mark up
    toSaleCost: (providerCostUSD) =>
      providerCostUSD *
      Number(texts.t('secsers_usd_to_mmk')) *
      Number(texts.t('secsers_markup'))
  },
  hiroshi: {
    url: process.env.HIROSHI_API_URL,
    key: process.env.HIROSHI_API_KEY,
    currency: 'USD',
    // Hiroshi is the same Perfect-Panel API shape as the others, also USD
    toSaleCost: (providerCostUSD) =>
      providerCostUSD *
      Number(texts.t('hiroshi_usd_to_mmk')) *
      Number(texts.t('hiroshi_markup'))
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
  // Perfect-Panel-style APIs are built to accept classic HTML-form POST
  // data, not a JSON body - some providers (like ShweBoost, apparently)
  // tolerate JSON anyway, but stricter ones (behind Cloudflare, etc.) will
  // 403 a JSON request. Form-encoding + a normal User-Agent is the safest
  // format that works across all of them.
  const form = new URLSearchParams(Object.assign({ key: c.key }, params));
  try {
    const { data } = await axios.post(c.url, form, {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; SMMPanelBot/1.0)'
      }
    });
    return data;
  } catch (err) {
    if (err.response) {
      throw new Error(`${provider} API error ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`);
    }
    throw err;
  }
}

// Some panels return average completion time under different keys and as a
// free-text string (e.g. "18 Minutes", "10-30 minutes", "1 Hour"), not a
// clean number - so we keep the raw text and only extract a number as a
// best-effort fallback, rather than forcing Number() and silently getting NaN.
async function fetchServiceInfo(provider, providerServiceId) {
  const list = await call(provider, { action: 'services' });
  if (!Array.isArray(list)) throw new Error('Unexpected response from provider services list');
  const found = list.find(s => String(s.service) === String(providerServiceId));
  if (!found) throw new Error(`Service id ${providerServiceId} ကို ${provider} ထဲမှာ ရှာမတွေ့ပါ`);
  const rawTime = found.average_time || found.averageTime || found.average || found.time || null;
  return {
    providerName: found.name,
    rate: Number(found.rate),
    min: Number(found.min),
    max: Number(found.max),
    avgTime: rawTime ? String(rawTime).trim() : null
  };
}

// Turn whatever the provider gave us (a plain number of minutes, or free
// text like "10-30 minutes" / "1 Hour") into a friendly Burmese phrase.
function formatDuration(rawTime) {
  if (!rawTime) return null;
  const text = String(rawTime).trim();
  if (/^\d+$/.test(text)) return `${text} မိနစ်`; // pure number -> assume minutes
  return text
    .replace(/hours?/gi, 'နာရီ')
    .replace(/minutes?|mins?/gi, 'မိနစ်');
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
  CONFIG, fetchServiceInfo, calcSaleCost, placeOrder, orderStatus, orderStatusBulk, cancelOrder, getBalance, formatDuration
};

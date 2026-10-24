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

function responsePreview(data) {
  if (typeof data === 'string') return data.replace(/\s+/g, ' ').trim().slice(0, 300);
  try { return JSON.stringify(data).slice(0, 300); }
  catch (_) { return String(data).slice(0, 300); }
}

function isCloudflareChallenge(status, data) {
  const body = typeof data === 'string' ? data : responsePreview(data);
  return status === 403 && /just a moment|cf-chl-|challenge-platform|cloudflare/i.test(body);
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
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; SMMPanelBot/1.0)'
      },
      // Do not follow redirects silently: a redirect from /api/v2 to a web
      // login/challenge page is a configuration/provider problem, not an API
      // response that the bot can safely interpret.
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 300
    });
    return data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const body = err.response.data;
      if (isCloudflareChallenge(status, body)) {
        throw new Error(
          `${provider} API ကို Cloudflare က block လုပ်ထားပါတယ် (403 challenge page). ` +
          `HIROSHI_API_URL ကို website URL မဟုတ်ဘဲ provider ရဲ့ API documentation ထဲက API endpoint (/api/v2 စသည်) အတိအကျထားပါ၊ ` +
          `မရသေးရင် Hiroshi support ဆီက server IP/API access whitelist တောင်းပါ။`
        );
      }
      throw new Error(`${provider} API error ${status}: ${responsePreview(body)}`);
    }
    if (err.code === 'ERR_FR_TOO_MANY_REDIRECTS' || err.code === 'ERR_BAD_REQUEST') {
      throw new Error(`${provider} API endpoint သည် API response မပေးဘဲ redirect လုပ်နေပါတယ်။ API endpoint URL ကို ပြန်စစ်ပါ။`);
    }
    throw err;
  }
}

// Some panels return average completion time under different keys and as a
// free-text string (e.g. "18 Minutes", "10-30 minutes", "1 Hour"), not a
// clean number - so we keep the raw text and only extract a number as a
// best-effort fallback, rather than forcing Number() and silently getting NaN.
// The full provider catalogue is big (thousands of rows) and every
// /addbutton, /syncservices item and admin-panel search needs it - cache it
// for a few minutes instead of downloading it again for each service.
const listCache = {};
const LIST_TTL = 5 * 60 * 1000;
async function listServices(provider, force = false) {
  const hit = listCache[provider];
  if (!force && hit && Date.now() - hit.at < LIST_TTL) return hit.list;
  const list = await call(provider, { action: 'services' });
  if (!Array.isArray(list)) throw new Error('Unexpected response from provider services list');
  listCache[provider] = { at: Date.now(), list };
  return list;
}

async function fetchServiceInfo(provider, providerServiceId) {
  const list = await listServices(provider);
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

// what the PROVIDER charges us for an order, converted to MMK (no markup) -
// stored on each order so the panel can show real profit
function calcBaseCost(provider, rate, quantity) {
  const usdToMmk = Number(texts.t(provider + '_usd_to_mmk')) || 0;
  return Math.ceil((rate / 1000) * quantity * usdToMmk);
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
  CONFIG, listServices, fetchServiceInfo, calcSaleCost, calcBaseCost, placeOrder, orderStatus, orderStatusBulk, cancelOrder, getBalance, formatDuration
};

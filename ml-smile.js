// =======================================================================
// Smile One client (Mobile Legends, paid with Smile Coins) - Node port of
// the Python flow that was tested by hand:
//   page (csrf + price table) -> checkrole -> customer check -> query (flowid) -> pay
//
// The login session is a list of smile.one cookies, saved ENCRYPTED in the
// Settings collection. Only smile.one cookies are ever kept (anything else in
// an uploaded file, e.g. Google cookies, is dropped on the spot).
// Every call that touches Smile One runs one at a time (exclusive()).
// =======================================================================
const axios = require('axios');
const texts = require('./texts');
const ai = require('./ai');

const BASE = 'https://www.smile.one';
const PAGE = BASE + '/merchant/mobilelegends';
const SESSION_KEY = 'ml_session_enc';

class SmileError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// BRL price table copied from the site's own JS (fixedPricesList). Charge for
// zones whose checkrole says type 3 = fixed*10 - (discount_total - total_amount).
const FIXED_BRL = {
  '13': 7.23, '23': 14.45, '25': 21.68, '26': 57.8, '27': 173.41, '28': 289.02, '29': 433.53, '30': 722.54,
  '22590': 4.62, '22591': 13.86, '22592': 22.83, '22593': 46.82, '33': 47.69, '16642': 9.25, '26555': 4.62, '26556': 22.83
};
// last values measured by hand (used until the first live refresh)
const DEFAULT_COINS = {
  '13': 71.3, '23': 141.5, '25': 206.8, '26': 558.0, '27': 1687.1, '28': 2814.2, '29': 4245.3, '30': 7054.4,
  '22590': 45.2, '22591': 135.6, '22592': 218.3, '22593': 448.2, '33': 466.9, '16642': 88.5, '26555': 45.2, '26556': 227.3
};

// ---- session / cookie jar ----------------------------------------------
let jar = null;        // Map name -> value
let jarMeta = null;    // { savedAt }
let jarDirty = false;

const ua = () => String(texts.getRaw('ml_ua') || '').trim() || 'Mozilla/5.0';

function loadJar() {
  if (jar) return jar;
  jar = new Map();
  const blob = texts.getRaw(SESSION_KEY);
  if (!blob) return jar;
  try {
    const s = JSON.parse(ai.decrypt(blob));
    for (const c of s.cookies || []) jar.set(c.name, c.value);
    jarMeta = { savedAt: s.savedAt || null };
  } catch (e) { console.error('Smile session could not be decrypted:', e.message); jar = new Map(); }
  return jar;
}
async function saveJar() {
  if (!jar || !jar.size) return;
  const cookies = [...jar].map(([name, value]) => ({ name, value }));
  jarMeta = { savedAt: new Date().toISOString() };
  await texts.setText(SESSION_KEY, ai.encrypt(JSON.stringify({ cookies, savedAt: jarMeta.savedAt })));
  jarDirty = false;
}
function sessionInfo() {
  const j = loadJar();
  return { has: j.size > 0, count: j.size, savedAt: jarMeta && jarMeta.savedAt || null };
}
// accepts the text of smileone_session.json (Playwright storage_state) - keeps smile.one cookies only
async function setSessionFromJson(text) {
  let st;
  try { st = JSON.parse(String(text || '')); } catch (_) { throw new SmileError('BAD_JSON', 'JSON မမှန်ပါ'); }
  const list = Array.isArray(st) ? st : (st && st.cookies);
  if (!Array.isArray(list)) throw new SmileError('BAD_JSON', 'cookies စာရင်း မတွေ့ပါ');
  const mine = list.filter(c => c && c.name && typeof c.value === 'string' && /(^|\.)smile\.one$/i.test(String(c.domain || '').replace(/^\./, '')));
  if (mine.length < 3 || !mine.some(c => c.name === 'PHPSESSID')) throw new SmileError('BAD_JSON', 'smile.one cookie မပြည့်စုံပါ (PHPSESSID မပါ)');
  jar = new Map(mine.map(c => [c.name, c.value]));
  await saveJar();
  return { count: jar.size, dropped: list.length - mine.length };
}
async function clearSession() { jar = new Map(); jarMeta = null; await texts.setText(SESSION_KEY, ''); }

// ---- one-at-a-time queue -------------------------------------------------
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run.finally(() => { if (jarDirty) saveJar().catch(() => {}); });
}

// ---- http ------------------------------------------------------------------
function mergeCookies(res) {
  const sc = res.headers && res.headers['set-cookie'];
  if (!sc) return;
  for (const line of [].concat(sc)) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(line);
    if (!m) continue;
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) { if (jar.delete(m[1])) jarDirty = true; continue; }
    if (jar.get(m[1]) !== m[2]) { jar.set(m[1], m[2]); jarDirty = true; }
  }
}
async function http(method, url, { form, ajax, timeout = 25000, follow = true } = {}) {
  const j = loadJar();
  if (!j.size) throw new SmileError('NO_SESSION', 'Smile One session မရှိသေးပါ');
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const headers = {
      'User-Agent': ua(), 'Accept-Language': 'en-US,en;q=0.9',
      Cookie: [...j].map(([k, v]) => `${k}=${v}`).join('; ')
    };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (method !== 'GET') { headers.Referer = PAGE; headers.Origin = BASE; }
    if (ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
    const res = await axios.request({
      method, url: cur, headers, timeout, maxRedirects: 0, validateStatus: () => true,
      responseType: 'text', transformResponse: (x) => x,
      data: form ? new URLSearchParams(form).toString() : undefined
    });
    mergeCookies(res);
    const body = typeof res.data === 'string' ? res.data : '';
    if (res.status === 403 || /<title>\s*just a moment/i.test(body)) throw new SmileError('CLOUDFLARE', 'Cloudflare challenge (HTTP ' + res.status + ')');
    const loc = res.headers && res.headers.location;
    if (follow && method === 'GET' && res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
    return { status: res.status, body, location: loc ? new URL(loc, cur).toString() : '', url: cur };
  }
  throw new SmileError('REDIRECTS', 'too many redirects');
}

// ---- parsing -----------------------------------------------------------------
function pageCsrf(html) {
  const m = /<input[^>]*name=["']_csrf["'][^>]*value=["']([^"']+)["']/i.exec(html) || /<input[^>]*value=["']([^"']+)["'][^>]*name=["']_csrf["']/i.exec(html);
  return m ? m[1] : null;
}
function pageInfo(html) {
  const m = /info\s*=\s*JSON\.parse\('(.*?)'\)/s.exec(html);
  if (!m) return {};
  try {
    const once = JSON.parse('"' + m[1].replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"');
    return JSON.parse(once);
  } catch (_) { return {}; }
}
function visibleLines(html) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function getPage() {
  const r = await http('GET', PAGE);
  const csrf = pageCsrf(r.body);
  if (!csrf) throw new SmileError('NOT_LOGGED_IN', 'csrf မတွေ့ပါ - session ကုန်နေနိုင်ပါတယ်');
  return { csrf, info: pageInfo(r.body) };
}
async function getBalance() {
  const r = await http('GET', BASE + '/customer/order');
  const low = r.body.toLowerCase();
  if (!/logout|sair|sign out/.test(low)) throw new SmileError('NOT_LOGGED_IN', 'login မဝင်ထားပါ (session ကုန်)');
  const lines = visibleLines(r.body);
  for (let i = 0; i < lines.length; i++) {
    if (/^saldo/i.test(lines[i])) {
      const same = /[-+]?\d[\d.,]*/.exec(lines[i].replace(/^saldo:?/i, ''));
      const v = parseFloat(String(same ? same[0] : (lines[i + 1] || '')).replace(/,/g, ''));
      if (Number.isFinite(v)) return v;
    }
  }
  throw new SmileError('NO_BALANCE', 'Saldo (လက်ကျန်) မတွေ့ပါ');
}
const parseJson = (r, what) => { try { return JSON.parse(r.body); } catch (_) { throw new SmileError('BAD_REPLY', what + ' ကို နားမလည်နိုင်သော ပြန်စာ'); } };

async function checkRoleRaw(csrf, pid, uid, zone) {
  const r = await http('POST', BASE + '/merchant/mobilelegends/checkrole', { ajax: true, form: {
    user_id: uid, zone_id: zone, pid, checkrole: '1', pay_methond: 'smilecoin', channel_method: 'smilecoin', _csrf: csrf } });
  const j = parseJson(r, 'checkrole');
  if (String(j.code) !== '200') throw new SmileError('ROLE', String(j.info || 'Game ID / Server ID မှားနေပါသည်'));
  return { name: String(j.username || ''), type: j.type, changePrice: j.change_price };
}

// Smile Coins the site will really take for `pid` in a zone of this `type` (null = rule unknown)
function expectedCoins(pid, info, type) {
  const t = Number(type);
  if (t === 1 || t === 2 || !FIXED_BRL[pid]) return null;
  const sc = info && info[pid] && info[pid].smilecoin;
  if (!sc) return null;
  const tot = Number(sc.total_amount), cut = Number(sc.discount_total);
  if (!Number.isFinite(tot) || !Number.isFinite(cut)) return null;
  return Math.round((FIXED_BRL[pid] * 10 - (cut - tot)) * 10) / 10;
}

// ---- live price quotes (type-3 zones) -------------------------------------------
let live = { at: 0, coins: {} };
const liveCoins = (pid) => (live.coins[pid] != null ? live.coins[pid] : DEFAULT_COINS[pid]);
const liveAge = () => live.at;
async function refreshLive() {
  return exclusive(async () => {
    const { info } = await getPage();
    const coins = {};
    for (const pid of Object.keys(FIXED_BRL)) {
      const v = expectedCoins(pid, info, 3);
      if (v != null) coins[pid] = v;
    }
    live = { at: Date.now(), coins };
    return coins;
  });
}

// ---- operations used by the bot / panel -------------------------------------------
// session health check: logged in? balance? (also refreshes the price table)
function test() {
  return exclusive(async () => {
    const balance = await getBalance();
    try { const { info } = await getPage(); const coins = {}; for (const pid of Object.keys(FIXED_BRL)) { const v = expectedCoins(pid, info, 3); if (v != null) coins[pid] = v; } if (Object.keys(coins).length) live = { at: Date.now(), coins }; } catch (_) { /* balance is the main check */ }
    return { balance };
  });
}
// player name + zone type
function lookup(pid, uid, zone) {
  return exclusive(async () => {
    const { csrf, info } = await getPage();
    const role = await checkRoleRaw(csrf, pid, uid, zone);
    return { ...role, expected: expectedCoins(pid, info, role.type) };
  });
}

// Buy `qty` x package `pid` for the player. perUnitCoins = coins the price was based on.
// Never throws: returns { delivered, unknown, error, chargedCoins }.
//   unknown=true  -> a pay request may or may not have gone through (admin must check /customer/order)
function purchase({ pid, qty, uid, zone, perUnitCoins }) {
  return exclusive(async () => {
    const out = { delivered: 0, unknown: false, error: null, chargedCoins: null, name: null };
    let start = null;
    try { start = await getBalance(); } catch (e) { out.error = e; return out; }
    let last = start;
    for (let i = 0; i < qty; i++) {
      let stage = 'pre';
      let exp = null;
      try {
        const { csrf, info } = await getPage();
        const role = await checkRoleRaw(csrf, pid, uid, zone);
        out.name = role.name;
        exp = expectedCoins(pid, info, role.type);
        if (exp == null) throw new SmileError('PRICE_RULE', 'ဒီ server အတွက် ဈေးတွက်ပုံ မသိသေးပါ');
        if (perUnitCoins && exp > perUnitCoins * 1.03 + 0.5) throw new SmileError('PRICE_CHANGED', `Smile One ဈေး တက်နေပါတယ် (${exp} > ${perUnitCoins})`);
        if (last < exp) throw new SmileError('LOW_SMILE_BALANCE', `Smile Coins မလောက်ပါ (${last} < ${exp})`);
        await http('POST', BASE + '/merchant/customer', { ajax: true, form: { check: 'check', _csrf: csrf } });
        const q = await http('POST', BASE + '/merchant/mobilelegends/query', { ajax: true, form: {
          user_id: uid, zone_id: zone, pid, checkrole: '', pay_methond: 'smilecoin', channel_method: 'smilecoin', _csrf: csrf } });
        const qj = parseJson(q, 'query');
        if (String(qj.code) !== '200' || !qj.flowid) throw new SmileError('QUERY', String(qj.info || 'query refused'));
        stage = 'pay';
        const p = await http('POST', BASE + '/merchant/mobilelegends/pay', { follow: false, timeout: 40000, form: {
          _csrf: csrf, user_id: uid, zone_id: zone, pay_methond: 'smilecoin', product_id: pid, channel_method: 'smilecoin',
          flowid: qj.flowid, email: '', coupon_id: '' } });
        const okRedirect = p.status >= 300 && p.status < 400 && /success/i.test(p.location);
        let now = null;
        try { now = await getBalance(); } catch (_) { /* judged below */ }
        const spent = now != null ? Math.round((last - now) * 10) / 10 : null;
        if (okRedirect) { out.delivered++; if (now != null) last = now; continue; }
        // no success page: did Smile One take the coins anyway?
        if (spent == null || spent >= Math.max(0.5, exp * 0.5)) { out.unknown = true; out.error = new SmileError('PAY_UNCLEAR', 'pay ရလဒ် မရှင်းပါ (HTTP ' + p.status + ')'); break; }
        throw new SmileError('PAY_REFUSED', 'pay refused (HTTP ' + p.status + ')');
      } catch (e) {
        out.error = e;
        // a network error / timeout during pay = we cannot know whether it went through
        if (stage === 'pay' && !(e instanceof SmileError)) out.unknown = true;
        break;
      }
    }
    try { const end = await getBalance(); out.chargedCoins = Math.round((start - end) * 10) / 10; } catch (_) { /* optional */ }
    return out;
  });
}

module.exports = {
  _parse: { pageCsrf, pageInfo, visibleLines, expectedCoins },
  SmileError, FIXED_BRL, DEFAULT_COINS, liveCoins, liveAge, refreshLive,
  sessionInfo, setSessionFromJson, clearSession, test, lookup, purchase
};

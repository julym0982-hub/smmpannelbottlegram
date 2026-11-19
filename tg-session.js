// Reads the newest login code that Telegram itself (service chat 777000) sent
// to an account the ADMIN owns, using the session string the admin stored.
// It only ever reads that one service chat - never the account's other chats.
//
// Needs:  npm i telegram   +   TG_API_ID / TG_API_HASH in the environment
// (get them free at https://my.telegram.org -> API development tools)
const API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const API_HASH = process.env.TG_API_HASH || '';

function lib() {
  try { return { ...require('telegram'), sessions: require('telegram/sessions') }; }
  catch (_) { throw Object.assign(new Error('"telegram" package မရှိသေးပါ - npm install telegram လုပ်ပါ'), { code: 'NOLIB' }); }
}

async function withClient(sessionString, fn) {
  if (!API_ID || !API_HASH) throw Object.assign(new Error('TG_API_ID / TG_API_HASH မသတ်မှတ်ရသေးပါ'), { code: 'NOCONF' });
  const { TelegramClient, sessions } = lib();
  const client = new TelegramClient(new sessions.StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 2, useWSS: false });
  client.setLogLevel && client.setLogLevel('none');
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('Telegram timeout')), 25000));
  try {
    await Promise.race([client.connect(), timer]);
    return await Promise.race([fn(client), timer]);
  } finally {
    try { await client.disconnect(); } catch (_) {}
    try { await client.destroy && client.destroy(); } catch (_) {}
  }
}

// -> { code, date } | null   (only codes newer than maxAgeMin minutes)
async function latestLoginCode(sessionString, maxAgeMin = 10) {
  return withClient(sessionString, async (client) => {
    const msgs = await client.getMessages(777000, { limit: 5 });
    const cutoff = Date.now() - maxAgeMin * 60 * 1000;
    for (const m of msgs) {
      const when = (m.date || 0) * 1000;
      if (when < cutoff) continue;
      const hit = /(?:code|ကုဒ်|код)[^\d]{0,20}(\d{5,6})/i.exec(m.message || '') || /\b(\d{5,6})\b/.exec(m.message || '');
      if (hit) return { code: hit[1], date: new Date(when) };
    }
    return null;
  });
}

// quick health check used by the admin panel -> { ok, phone, name }
async function checkSession(sessionString) {
  return withClient(sessionString, async (client) => {
    if (!(await client.checkAuthorization())) return { ok: false };
    const me = await client.getMe();
    return { ok: true, id: String(me.id), username: String(me.username || ''), phone: String(me.phone || ''), name: [me.firstName, me.lastName].filter(Boolean).join(' ') };
  });
}

// Is this 777000 message Telegram's "new login / new device" notice (not a login code)?
function isNewLoginNotice(text) {
  if (!text) return false;
  if (/new login|new device|detected a login|login into your account/i.test(text)) return true;
  return !/\b\d{5,6}\b/.test(text); // other languages: anything that is not a code message
}

// Keeps one connection open and calls onNotice(text, date) for every NEW
// new-device-login notice that arrives until state.until (a ms timestamp the
// caller may extend). Reads only the Telegram service chat (777000).
async function watchNewLogin(sessionString, state, onNotice, intervalMs = 5000) {
  if (!API_ID || !API_HASH) return;
  const { TelegramClient, sessions } = lib();
  const client = new TelegramClient(new sessions.StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 2, useWSS: false });
  client.setLogLevel && client.setLogLevel('none');
  try {
    await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('Telegram timeout')), 25000))]);
    const first = await client.getMessages(777000, { limit: 1 });
    let lastId = first[0] ? first[0].id : 0;
    while (Date.now() < state.until) {
      await new Promise(r => setTimeout(r, intervalMs));
      const msgs = await client.getMessages(777000, { limit: 5 });
      const fresh = msgs.filter(m => m.id > lastId).sort((a, b) => a.id - b.id);
      for (const m of fresh) {
        lastId = Math.max(lastId, m.id);
        if (isNewLoginNotice(m.message)) await onNotice(m.message, new Date((m.date || 0) * 1000));
      }
    }
  } finally {
    try { await client.disconnect(); } catch (_) {}
    try { client.destroy && await client.destroy(); } catch (_) {}
  }
}

// ---- creating a NEW session from the admin panel (phone -> code -> [2FA password])
// The half-finished login lives in memory only; the session string is never sent
// to the browser - the panel saves the account server-side with tgLoginTake().
const crypto = require('crypto');
const logins = new Map(); // loginId -> { client, phone, hash, step, password, timer }
const LOGIN_TTL = 10 * 60 * 1000;

function dropLogin(id) {
  const l = logins.get(id);
  if (!l) return;
  clearTimeout(l.timer);
  logins.delete(id);
  Promise.resolve(l.client.disconnect()).catch(() => {}).then(() => l.client.destroy && l.client.destroy()).catch(() => {});
}
async function tgLoginStart(phone) {
  if (!API_ID || !API_HASH) throw Object.assign(new Error('TG_API_ID / TG_API_HASH မသတ်မှတ်ရသေးပါ'), { code: 'NOCONF' });
  if (logins.size >= 5) throw new Error('Login တစ်ပြိုင်နက် များနေပါတယ်၊ ခဏနေမှ ပြန်စမ်းပါ');
  const { TelegramClient, sessions } = lib();
  const client = new TelegramClient(new sessions.StringSession(''), API_ID, API_HASH, { connectionRetries: 2, useWSS: false });
  client.setLogLevel && client.setLogLevel('none');
  try {
    await client.connect();
    const r = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, '+' + String(phone).replace(/\D/g, ''));
    const id = crypto.randomBytes(8).toString('hex');
    logins.set(id, { client, phone: '+' + String(phone).replace(/\D/g, ''), hash: r.phoneCodeHash, step: 'code', password: '', timer: setTimeout(() => dropLogin(id), LOGIN_TTL) });
    return { loginId: id, viaApp: !!r.isCodeViaApp };
  } catch (e) { try { await client.disconnect(); } catch (_) {} throw e; }
}
async function finishLogin(l) {
  const me = await l.client.getMe();
  l.step = 'ready';
  l.me = { id: String(me.id), username: String(me.username || ''), phone: String(me.phone || ''), name: [me.firstName, me.lastName].filter(Boolean).join(' ') };
  l.session = l.client.session.save();
  return { status: 'ready', ...l.me, hasPassword: !!l.password };
}
async function tgLoginCode(id, code) {
  const l = logins.get(id);
  if (!l || l.step !== 'code') throw new Error('Login သက်တမ်းကုန်သွားပါပြီ၊ အစက ပြန်စပါ');
  const { Api } = lib();
  try {
    await l.client.invoke(new Api.auth.SignIn({ phoneNumber: l.phone, phoneCodeHash: l.hash, phoneCode: String(code).replace(/\D/g, '') }));
  } catch (e) {
    if (e && e.errorMessage === 'SESSION_PASSWORD_NEEDED') { l.step = 'password'; return { status: 'password' }; }
    throw e;
  }
  return finishLogin(l);
}
async function tgLoginPassword(id, password) {
  const l = logins.get(id);
  if (!l || l.step !== 'password') throw new Error('Login သက်တမ်းကုန်သွားပါပြီ၊ အစက ပြန်စပါ');
  await l.client.signInWithPassword({ apiId: API_ID, apiHash: API_HASH }, {
    password: async () => password,
    onError: async (err) => { throw err; }
  });
  l.password = password; // used as the account's 2step password unless the admin types another
  return finishLogin(l);
}
// returns { session, me, password } and closes the login
function tgLoginTake(id) {
  const l = logins.get(id);
  if (!l || l.step !== 'ready') throw new Error('Login မပြီးသေးပါ / သက်တမ်းကုန်သွားပါပြီ');
  const out = { session: l.session, me: l.me, password: l.password };
  dropLogin(id);
  return out;
}

module.exports = { tgLoginStart, tgLoginCode, tgLoginPassword, tgLoginTake, tgLoginCancel: dropLogin, latestLoginCode, checkSession, watchNewLogin, configured: () => !!(API_ID && API_HASH) };

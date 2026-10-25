// =======================================================================
// AI chat assistant: Gemini + Groq with encrypted keys, automatic failover
// between keys, and a per-user daily question limit.
// =======================================================================
const crypto = require('crypto');
const axios = require('axios');
const { ApiKey, AiUsage } = require('./models');
const texts = require('./texts');

const MMT_OFFSET = 6.5 * 3600 * 1000;
const today = () => new Date(Date.now() + MMT_OFFSET).toISOString().slice(0, 10);
const COOLDOWN = { quota: 15 * 60 * 1000, invalid: 6 * 3600 * 1000 };

// ---- encryption (AES-256-GCM). Set AI_KEY_SECRET in the environment so the
// keys keep working even if BOT_TOKEN ever changes.
const SECRET = crypto.createHash('sha256').update('smm-ai-keys:' + (process.env.AI_KEY_SECRET || process.env.BOT_TOKEN || '')).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const num = (k, def) => { const n = Number(texts.t(k)); return Number.isFinite(n) ? n : def; };
const enabled = () => texts.t('ai_enabled') === '1';

// ---- provider calls ---------------------------------------------------
async function callProvider(provider, apiKey, { system, history, text }) {
  const temperature = num('ai_temperature', 0.8);
  const maxTokens = Math.max(64, Math.floor(num('ai_max_tokens', 1024)));
  if (provider === 'gemini') {
    const model = texts.t('ai_model_gemini').trim();
    const contents = [...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }] }];
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature, maxOutputTokens: maxTokens } },
      { timeout: 30000, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } }
    );
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const out = (parts || []).map(p => p.text || '').join('').trim();
    if (!out) throw Object.assign(new Error('empty reply (blocked or no text)'), { kind: 'empty' });
    return out;
  }
  if (provider === 'groq') {
    const model = texts.t('ai_model_groq').trim();
    const messages = [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role, content: m.text })), { role: 'user', content: text }];
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model, messages, temperature, max_tokens: maxTokens },
      { timeout: 30000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }
    );
    const out = data && data.choices && data.choices[0] && data.choices[0].message && String(data.choices[0].message.content || '').trim();
    if (!out) throw Object.assign(new Error('empty reply'), { kind: 'empty' });
    return out;
  }
  throw new Error('unknown provider');
}

// what kind of failure was it? decides whether the key is parked or not
function classify(err) {
  if (err.kind) return err.kind;
  const status = err.response && err.response.status;
  const msg = String(err.response && err.response.data && (err.response.data.error && (err.response.data.error.message || err.response.data.error) || '') || err.message || '');
  if (status === 429) return 'quota';
  if (status === 401 || status === 403 || (status === 400 && /api key|permission|invalid/i.test(msg))) return 'invalid';
  if (status === 404 || /model/i.test(msg) && status === 400) return 'model';
  return 'transient';
}
const errText = (err) => {
  const status = err.response && err.response.status;
  const d = err.response && err.response.data;
  const m = d && d.error && (d.error.message || (typeof d.error === 'string' ? d.error : '')) || err.message || 'error';
  return `${status ? status + ': ' : ''}${String(m).slice(0, 200)}`;
};

// keys that can be used right now, least-used today first (spreads the load)
async function usableKeys(onlyId) {
  const all = await ApiKey.find(onlyId ? { _id: onlyId } : { isActive: true });
  const now = Date.now(), t = today();
  return all
    .filter(k => onlyId || !k.exhaustedUntil || new Date(k.exhaustedUntil).getTime() <= now)
    .sort((a, b) => (a.usageDay === t ? a.dailyUsageCount : 0) - (b.usageDay === t ? b.dailyUsageCount : 0) || Math.random() - 0.5);
}
async function hasKeys() { return (await usableKeys()).length > 0; }

async function recordSuccess(k) {
  const t = today();
  await ApiKey.findOneAndUpdate({ _id: k._id, usageDay: { $ne: t } }, { $set: { usageDay: t, dailyUsageCount: 0 } });
  await ApiKey.findByIdAndUpdate(k._id, { $inc: { dailyUsageCount: 1, totalCount: 1 }, $set: { lastError: '', exhaustedUntil: null } });
}
async function recordFailure(k, kind, err) {
  const upd = { lastError: `${kind}: ${errText(err)}`, lastErrorAt: new Date() };
  if (kind === 'quota' || kind === 'invalid') upd.exhaustedUntil = new Date(Date.now() + COOLDOWN[kind]);
  await ApiKey.findByIdAndUpdate(k._id, { $set: upd });
}

// Ask the AI. Tries each usable key in turn; a quota/invalid key is parked
// and the SAME question is retried on the next key straight away.
// Returns { ok: true, text, keyId } or { ok: false, reason, detail }.
async function ask({ system, history = [], text, onlyKeyId }) {
  const keys = await usableKeys(onlyKeyId);
  if (!keys.length) return { ok: false, reason: 'no_keys', detail: 'သုံးလို့ရတဲ့ API key မရှိပါ' };
  let lastDetail = '';
  for (const k of keys.slice(0, 5)) {
    let apiKey;
    try { apiKey = decrypt(k.encryptedKey); }
    catch (_) { await recordFailure(k, 'invalid', new Error('key ကို decrypt မလုပ်နိုင်ပါ (AI_KEY_SECRET / BOT_TOKEN ပြောင်းသွားသလား)')); lastDetail = 'decrypt failed'; continue; }
    try {
      const out = await callProvider(k.provider, apiKey, { system, history, text });
      await recordSuccess(k);
      return { ok: true, text: out, keyId: String(k._id), provider: k.provider };
    } catch (err) {
      const kind = classify(err);
      lastDetail = `${k.provider}${k.label ? ' (' + k.label + ')' : ''}: ${errText(err)}`;
      console.error(`AI key failed [${k.provider} …${k.last4}]: ${kind}`);
      await recordFailure(k, kind, err);
      if (kind === 'empty') return { ok: false, reason: 'empty', detail: lastDetail }; // same answer would come from any key
    }
  }
  return { ok: false, reason: 'all_failed', detail: lastDetail };
}

// ---- per-user daily limit -------------------------------------------------
// the counter goes up first (atomically); anything over the limit is refused
async function takeQuestion(userId) {
  if (texts.t('ai_limit_enabled') !== '1') return { allowed: true };
  const limit = Math.max(1, Math.floor(num('ai_limit_per_day', 20)));
  const row = await AiUsage.findOneAndUpdate({ _id: `${userId}:${today()}` }, { $inc: { count: 1 } }, { new: true, upsert: true });
  return { allowed: row.count <= limit, used: row.count, limit };
}

// ---- conversation memory (in RAM, short, expires after 30 minutes) ----------
const memory = new Map();
function getHistory(userId) {
  const m = memory.get(String(userId));
  if (!m || Date.now() - m.at > 30 * 60 * 1000) return [];
  return m.turns.slice(-Math.max(0, Math.floor(num('ai_history_turns', 6))) * 2);
}
function remember(userId, user, assistant) {
  const key = String(userId);
  const m = memory.get(key) && Date.now() - memory.get(key).at < 30 * 60 * 1000 ? memory.get(key) : { turns: [] };
  m.turns.push({ role: 'user', text: user }, { role: 'assistant', text: assistant });
  m.turns = m.turns.slice(-24); m.at = Date.now();
  memory.set(key, m);
  if (memory.size > 5000) for (const [k, v] of memory) if (Date.now() - v.at > 30 * 60 * 1000) memory.delete(k);
}

function buildSystem(vars) {
  const base = texts.t('ai_system_prompt', vars);
  const extra = texts.t('ai_knowledge', vars).trim();
  return extra ? `${base}\n\nဆိုင်အကြောင်း အချက်အလက်များ (ဒါတွေကို အခြေခံပြီး ဖြေပါ):\n${extra}` : base;
}

// full customer chat turn: limit -> prompt -> AI (with failover) -> memory
async function chat({ userId, name, balance, text }) {
  const lim = await takeQuestion(userId);
  if (!lim.allowed) return { ok: false, reason: 'limit' };
  const res = await ask({ system: buildSystem({ name: name || 'ဖောက်သည်', balance: balance == null ? '' : balance }), history: getHistory(userId), text });
  if (res.ok) remember(userId, text, res.text);
  // the AI never answered (all keys down) - do not charge the customer a question
  else if (lim.used) await AiUsage.findOneAndUpdate({ _id: `${userId}:${today()}` }, { $inc: { count: -1 } });
  return res;
}

// settings edited from Panel > AI Bot (kept out of the normal settings lists)
const SETTING_KEYS = ['ai_enabled', 'ai_model_gemini', 'ai_model_groq', 'ai_limit_enabled', 'ai_limit_per_day', 'ai_temperature', 'ai_max_tokens', 'ai_history_turns', 'ai_limit_msg', 'ai_fallback', 'ai_knowledge', 'ai_system_prompt'];

module.exports = { SETTING_KEYS, encrypt, decrypt, enabled, hasKeys, ask, chat, buildSystem, today, takeQuestion, COOLDOWN };

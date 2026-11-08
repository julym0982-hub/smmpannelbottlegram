// =======================================================================
// AI chat assistant: Gemini + Groq with encrypted keys, automatic failover
// between keys, and a per-user daily question limit.
// =======================================================================
const crypto = require('crypto');
const axios = require('axios');
const { ApiKey, AiUsage, MenuButton } = require('./models');
const texts = require('./texts');
const chatlog = require('./chatlog');

const MMT_OFFSET = 6.5 * 3600 * 1000;
const today = () => new Date(Date.now() + MMT_OFFSET).toISOString().slice(0, 10);
// 'rate' = per-minute limit (TPM/RPM): only a few seconds. 'quota' = per-day limit or exhausted: long.
const COOLDOWN = { quota: 15 * 60 * 1000, invalid: 6 * 3600 * 1000, rate: 20 * 1000 };

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
async function callProvider(provider, apiKey, { system, history, text, tools }) {
  // with tools the model should be steadier (fewer invented ids / numbers)
  const temperature = tools ? Math.min(num('ai_temperature', 0.8), 0.5) : num('ai_temperature', 0.8);
  const maxTokens = Math.max(64, Math.floor(num('ai_max_tokens', 1024)));
  if (provider === 'gemini') {
    const model = texts.t('ai_model_gemini').trim();
    const contents = [...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }] }];
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { systemInstruction: { parts: [{ text: tools ? system + '\n\n(အခုအချိန်မှာ tool မရနိုင်ပါ - လက်ကျန်ငွေ/order စစ်တာ၊ order မှာတာကို Menu ခလုတ်တွေကို ညွှန်ပါ။ ဈေးနှုန်း မမှန်းပါနဲ့။)' : system }] }, contents, generationConfig: { temperature, maxOutputTokens: maxTokens } },
      { timeout: 30000, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } }
    );
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const out = (parts || []).map(p => p.text || '').join('').trim();
    if (!out) throw Object.assign(new Error('empty reply (blocked or no text)'), { kind: 'empty' });
    return { text: out, tokens: (data.usageMetadata && data.usageMetadata.totalTokenCount) || 0 };
  }
  if (provider === 'groq') {
    const model = texts.t('ai_model_groq').trim();
    const messages = [{ role: 'system', content: system }, ...history.map(m => ({ role: m.role, content: m.text })), { role: 'user', content: text }];
    let tokens = 0; // total tokens this question used (every tool round counts) - used to spread load over keys
    const post = async (body) => {
      const data = (await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        body,
        { timeout: 30000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }
      )).data;
      tokens += (data && data.usage && data.usage.total_tokens) || 0;
      return data;
    };
    const base = { model, temperature, max_tokens: maxTokens };
    if (model.includes('gpt-oss')) base.reasoning_effort = 'low'; // reasoning model: keep it fast, don't burn max_tokens on thinking
    if (tools) { base.tools = tools.definitions; base.tool_choice = 'auto'; }

    // tool loop: model asks for a tool -> the server runs it (own data only) -> result goes back -> repeat (max 6 rounds)
    for (let round = 0; round < 6; round++) {
      const data = await post(Object.assign({ messages }, base));
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (tools && calls.length) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls.slice(0, 4)) {
          let args = {};
          try { args = JSON.parse(c.function && c.function.arguments || '{}'); } catch (_) { args = {}; }
          const result = await tools.run(c.function && c.function.name, args);
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 6000) });
        }
        continue;
      }
      const out = msg && String(msg.content || '').trim();
      if (out) return { text: out, tokens };
      if (tools && round > 0) return { text: 'ဟုတ်ကဲ့ရှင့် 😊', tokens }; // tools did the work (e.g. confirm button is sent by the bot) but the model said nothing
      throw Object.assign(new Error('empty reply'), { kind: 'empty' });
    }
    throw Object.assign(new Error('too many tool rounds'), { kind: 'empty' });
  }
  throw new Error('unknown provider');
}

// what kind of failure was it? decides whether the key is parked or not
function classify(err) {
  if (err.kind) return err.kind;
  const status = err.response && err.response.status;
  const msg = String(err.response && err.response.data && (err.response.data.error && (err.response.data.error.message || err.response.data.error) || '') || err.message || '');
  if (status === 429) return /per minute|\bTPM\b|\bRPM\b|per second/i.test(msg) ? 'rate' : 'quota';
  if (status === 401 || status === 403 || (status === 400 && /api key|permission|invalid/i.test(msg))) return 'invalid';
  if (status === 404 || /model/i.test(msg) && status === 400) return 'model';
  return 'transient';
}
// how long the provider says to wait ("retry-after" header or "Please try again in 1m2.5s")
function retryAfterMs(err) {
  const h = err.response && err.response.headers && err.response.headers['retry-after'];
  if (h && Number.isFinite(Number(h))) return Number(h) * 1000;
  const m = String(err.response && err.response.data && err.response.data.error && err.response.data.error.message || '').match(/try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
  return 0;
}
const errText = (err) => {
  const status = err.response && err.response.status;
  const d = err.response && err.response.data;
  const m = d && d.error && (d.error.message || (typeof d.error === 'string' ? d.error : '')) || err.message || 'error';
  return `${status ? status + ': ' : ''}${String(m).slice(0, 200)}`;
};

// tokens each key used in the last minute (RAM) - Groq limits tokens PER MINUTE, so the key that is
// least busy right now goes first
const recentTokens = new Map();
function noteTokens(keyId, n) {
  const a = (recentTokens.get(keyId) || []).filter(x => Date.now() - x.t < 60000); a.push({ t: Date.now(), n: n || 0 }); recentTokens.set(keyId, a);
}
const busy = (keyId) => (recentTokens.get(keyId) || []).filter(x => Date.now() - x.t < 60000).reduce((t, x) => t + x.n, 0);

// keys that can be used right now, least busy first (spreads the load)
async function usableKeys(onlyId) {
  const all = await ApiKey.find(onlyId ? { _id: onlyId } : { isActive: true });
  const now = Date.now(), t = today();
  return all
    .filter(k => onlyId || !k.exhaustedUntil || new Date(k.exhaustedUntil).getTime() <= now)
    .sort((a, b) => busy(String(a._id)) - busy(String(b._id)) || (a.usageDay === t ? a.dailyUsageCount : 0) - (b.usageDay === t ? b.dailyUsageCount : 0) || Math.random() - 0.5);
}
async function hasKeys() { return (await usableKeys()).length > 0; }

async function recordSuccess(k) {
  const t = today();
  await ApiKey.findOneAndUpdate({ _id: k._id, usageDay: { $ne: t } }, { $set: { usageDay: t, dailyUsageCount: 0 } });
  await ApiKey.findByIdAndUpdate(k._id, { $inc: { dailyUsageCount: 1, totalCount: 1 }, $set: { lastError: '', exhaustedUntil: null } });
}
async function recordFailure(k, kind, err) {
  const upd = { lastError: `${kind}: ${errText(err)}`, lastErrorAt: new Date() };
  if (kind === 'rate') upd.exhaustedUntil = new Date(Date.now() + Math.min(90000, Math.max(3000, (retryAfterMs(err) || COOLDOWN.rate) + 1500)));
  else if (kind === 'quota') upd.exhaustedUntil = new Date(Date.now() + Math.min(3 * 3600 * 1000, retryAfterMs(err) || COOLDOWN.quota));
  else if (kind === 'invalid') upd.exhaustedUntil = new Date(Date.now() + COOLDOWN.invalid);
  await ApiKey.findByIdAndUpdate(k._id, { $set: upd });
}

// Ask the AI. Tries each usable key in turn; a quota/invalid key is parked
// and the SAME question is retried on the next key straight away.
// Returns { ok: true, text, keyId } or { ok: false, reason, detail }.
async function ask({ system, history = [], text, onlyKeyId, tools, _retried }) {
  const keys = await usableKeys(onlyKeyId);
  if (!keys.length) {
    // every key is only resting because of a per-minute limit? wait a few seconds once instead of failing the customer
    const wait = await shortestRateWait();
    if (!onlyKeyId && !_retried && wait > 0 && wait <= 12000) { await new Promise(r => setTimeout(r, wait + 300)); return ask({ system, history, text, onlyKeyId, tools, _retried: true }); }
    return { ok: false, reason: 'no_keys', detail: 'သုံးလို့ရတဲ့ API key မရှိပါ (limit ကြောင့် ခေတ္တနားနေသည်)' };
  }
  let lastDetail = '', sawRate = false;
  for (const k of keys.slice(0, 5)) {
    let apiKey;
    try { apiKey = decrypt(k.encryptedKey); }
    catch (_) { await recordFailure(k, 'invalid', new Error('key ကို decrypt မလုပ်နိုင်ပါ (AI_KEY_SECRET / BOT_TOKEN ပြောင်းသွားသလား)')); lastDetail = 'decrypt failed'; continue; }
    try {
      const out = await callProvider(k.provider, apiKey, { system, history, text, tools });
      noteTokens(String(k._id), out.tokens);
      await recordSuccess(k);
      return { ok: true, text: out.text, keyId: String(k._id), provider: k.provider };
    } catch (err) {
      const kind = classify(err);
      if (kind === 'rate') sawRate = true;
      lastDetail = `${k.provider}${k.label ? ' (' + k.label + ')' : ''}: ${errText(err)}`;
      console.error(`AI key failed [${k.provider} …${k.last4}]: ${kind}`);
      await recordFailure(k, kind, err);
      if (kind === 'empty') return { ok: false, reason: 'empty', detail: lastDetail }; // same answer would come from any key
    }
  }
  // all keys hit a per-minute limit at once: wait for the soonest one and try one more time
  if (sawRate && !onlyKeyId && !_retried) {
    const wait = await shortestRateWait();
    if (wait > 0 && wait <= 12000) { await new Promise(r => setTimeout(r, wait + 300)); return ask({ system, history, text, onlyKeyId, tools, _retried: true }); }
  }
  return { ok: false, reason: 'all_failed', detail: lastDetail };
}
// ms until the soonest active key is usable again (only when that is a short rest); 0 if unknown
async function shortestRateWait() {
  const all = await ApiKey.find({ isActive: true });
  const now = Date.now();
  const waits = all.map(k => k.exhaustedUntil ? new Date(k.exhaustedUntil).getTime() - now : 0).filter(w => w > 0);
  return waits.length ? Math.min(...waits) : 0;
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
  return m.turns.slice(-Math.max(0, Math.floor(num('ai_history_turns', 4))) * 2).map(t => ({ role: t.role, text: String(t.text).slice(0, 500) }));
}
function remember(userId, user, assistant) {
  const key = String(userId);
  const m = memory.get(key) && Date.now() - memory.get(key).at < 30 * 60 * 1000 ? memory.get(key) : { turns: [] };
  // assistant may be null when the AI could not answer: the customer's message is still kept, so the next
  // answer (maybe from another key) knows what was asked
  m.turns.push({ role: 'user', text: user });
  if (assistant) m.turns.push({ role: 'assistant', text: assistant });
  m.turns = m.turns.slice(-24); m.at = Date.now();
  memory.set(key, m);
  if (memory.size > 5000) for (const [k, v] of memory) if (Date.now() - v.at > 30 * 60 * 1000) memory.delete(k);
}

// facts the bot already knows itself - filled in automatically so the shop owner never has to type them
// (customers see these in the bot anyway: payment accounts, min top-up, admin-added link buttons like Contact Admin)
async function autoFacts() {
  const out = [];
  const minTopup = texts.t('topup_min_amount');
  if (minTopup) out.push(`အနည်းဆုံး ငွေဖြည့်ပမာဏ: ${minTopup} ကျပ်`);
  const real = (n) => n && !/^0?9x+$/i.test(String(n).trim()) && !/x{4,}/i.test(String(n));
  const pay = [];
  if (real(texts.t('kpay_number'))) pay.push(`KPay ${texts.t('kpay_number')} (${texts.t('kpay_name')})`);
  if (real(texts.t('wave_number'))) pay.push(`Wave ${texts.t('wave_number')} (${texts.t('wave_name')})`);
  if (pay.length) out.push(`ငွေလွှဲလက်ခံတဲ့ account: ${pay.join('၊ ')} - ငွေဖြည့်တဲ့အခါ 💰ငွေဖြည့်ရန်💰 ခလုတ်ကနေ လုပ်ရမယ်၊ ဒီမှာ လွှဲပြီး screenshot ပို့လို့ မရဘူးလို့ ရှင်းပြပါ`);
  try {
    const btns = await MenuButton.find({}).lean();
    if (btns.length) out.push(`Menu ထဲက link ခလုတ်များ (Admin/ဆက်သွယ်ရန်): ${btns.map(b => b._id).join('၊ ')} - ဆက်သွယ်ချင်ရင် ဒီခလုတ်ကို ညွှန်ပါ (link/username ကိုယ်တိုင် မစပ်ပါနဲ့)`);
  } catch (_) { /* ignore */ }
  return out.join('\n');
}
function buildSystem(vars, auto = '') {
  const base = texts.t('ai_system_prompt', vars);
  const extra = texts.t('ai_knowledge', vars).trim();
  const facts = [auto, extra].filter(Boolean).join('\n');
  return facts ? `${base}\n\nဆိုင်အကြောင်း အချက်အလက်များ (ဒါတွေကို အခြေခံပြီး ဖြေပါ):\n${facts}` : base;
}

// ---- security: customer-controlled text must never steer or leak the assistant ----
// a Telegram first name goes INTO the system prompt, so it is stripped down to harmless characters
function safeName(n) {
  const cleaned = String(n || '').replace(/[\u0000-\u001f\u007f"'`$\\{}<>\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  return cleaned || 'ဖောက်သည်';
}
// obvious prompt-extraction / panel-attack attempts get a fixed polite reply without calling the AI at all
const ATTACK_RE = /(system\s*prompt|initial\s*prompt|ignore\s+(all\s+|the\s+)?(previous|above|prior)|disregard\s+(all\s+)?(previous|above)|developer\s*mode|jailbreak|\bDAN\b|reveal\s+(your|the)\s+(prompt|instructions)|admin\s*panel|adminlogin|panel2fa|PANEL_(PASSWORD|TOTP|PATH|USERNAME)|authenticator|BOT_TOKEN|api[\s_-]*key|prompt\s*(ကို|ပြ|ပေး)|ညွှန်ကြားချက်\s*(တွေ|များ)?\s*(ကို)?\s*(ပြ|မေ့|ကူးပေး))/i;
const BLOCKED_REPLY = 'အဲဒါလေးတွေတော့ ပြောပြလို့ မရပါဘူးရှင့် 🙏 service ဝယ်တာ၊ ငွေဖြည့်တာ၊ order ကိစ္စတွေဆို ကူညီပေးပါ့မယ်နော်။';
function secretValues() {
  const names = ['BOT_TOKEN', 'MONGODB_URI', 'MONGODB_URI_AI', 'PANEL_PASSWORD', 'PANEL_SESSION_SECRET', 'PANEL_TOTP_SECRET', 'PANEL_USERNAME', 'AI_KEY_SECRET', 'SHWEBOOST_API_KEY', 'HIROSHI_API_KEY', 'SECSERS_API_KEY', 'MORETHANPANEL_API_KEY'];
  return names.map(n => process.env[n]).filter(v => v && String(v).length >= 8).map(String);
}
const SECRET_PATTERNS = [/AIza[0-9A-Za-z_\-]{20,}/, /gsk_[A-Za-z0-9]{20,}/, /\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b/, /mongodb(\+srv)?:\/\//i, /\/admin\/login\?token=/i];
// true when the model's answer would leak a secret or a long piece of the system prompt
function leaks(out, prompt) {
  if (SECRET_PATTERNS.some(re => re.test(out))) return true;
  if (secretValues().some(v => out.includes(v))) return true;
  // the example dialogue lines and the shop facts are meant to be said to customers, so only the rules part is protected
  const sys = String(prompt).split('\n').filter(l => !/^\s*(ဝန်ထမ်း|ဧည့်သည်)\s*[:：]/.test(l)).join(' ').replace(/\s+/g, ' ');
  const o = String(out).replace(/\s+/g, ' ');
  for (let i = 0; i + 40 <= sys.length; i += 20) if (o.includes(sys.slice(i, i + 40))) return true;
  return false;
}

// ---- price guard -------------------------------------------------------
// The model must never calculate prices itself (it multiplied a per-1000 price by the quantity and quoted
// 57,510 instead of 58). Every number written next to "ကျပ်" must appear in a tool result, in the customer's
// own message / recent history, or in the shop facts. Otherwise the answer is not sent.
const toAscii = (t) => String(t).replace(/[၀-၉]/g, c => String('၀၁၂၃၄၅၆၇၈၉'.indexOf(c)));
const numbersIn = (t) => (toAscii(t).replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || []).map(x => String(Number(x)));
function unverifiedPrices(reply, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  const bad = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(?:ကျပ်|kyat|MMK)|(?:ကျပ်|MMK)\s*(\d[\d,]*)/gi;
  let m; const text = toAscii(reply);
  while ((m = re.exec(text))) { const n = String(Number((m[1] || m[2]).replace(/,/g, ''))); if (!allowed.has(n)) bad.push(n); }
  return bad;
}

// full customer chat turn: limit -> prompt -> AI (with failover) -> memory
async function chat({ userId, name, username, balance, text, tools, draftNote }) {
  const rec = (reply, extra = {}) => chatlog.save({ userId, name, username, question: text, reply, ...extra });
  if (ATTACK_RE.test(text)) { console.error(`AI guard: blocked suspicious message from ${userId}`); rec(BLOCKED_REPLY, { blocked: true }); return { ok: true, text: BLOCKED_REPLY }; }
  const lim = await takeQuestion(userId);
  if (!lim.allowed) return { ok: false, reason: 'limit' };
  const vars = { name: safeName(name), balance: balance == null ? '' : balance };
  const factsText = [await autoFacts(), texts.t('ai_knowledge', vars)].filter(Boolean).join('\n'); // numbers the shop itself states (min top-up ...)
  const system = buildSystem(vars, [await autoFacts(), draftNote].filter(Boolean).join('\n'));
  const hist = getHistory(userId);
  let res = await ask({ system, history: hist, text, tools });
  if (res.ok && tools && tools.results) {
    const allowed = () => [text, ...hist.map(h => h.text), factsText, ...tools.results()].join(' ');
    let bad = unverifiedPrices(res.text, allowed());
    if (bad.length) { // one correction round: tell the model, let it use price_quote / order_draft
      console.error(`AI guard: unverified price(s) ${bad.join(',')} for ${userId} - retrying`);
      const fix = await ask({ system: system + '\n\nIMPORTANT: your previous answer contained a price you calculated yourself (' + bad.join(', ') + '). Never calculate. Call price_quote or order_draft and only repeat the numbers they return. Do not mention this correction.', history: hist, text, tools });
      if (fix.ok) { res = fix; bad = unverifiedPrices(res.text, allowed()); }
      if (bad.length) res.text = 'ဈေးအတိအကျကို စနစ်ကနေ တွက်ပေးဖို့ ဘယ် service ကို ဘယ်လောက်တိုးချင်လဲ ထပ်ပြောပေးပါနော်ရှင့် 😊';
    }
  }
  if (res.ok && leaks(res.text, texts.t('ai_system_prompt', vars))) { console.error(`AI guard: blocked a leaking reply to ${userId}`); res.text = BLOCKED_REPLY; }
  if (res.ok) { remember(userId, text, res.text); rec(res.text, { provider: res.provider, blocked: res.text === BLOCKED_REPLY }); }
  // the AI never answered (all keys down) - do not charge the customer a question
  else {
    remember(userId, text, null);
    if (lim.used) await AiUsage.findOneAndUpdate({ _id: `${userId}:${today()}` }, { $inc: { count: -1 } });
  }
  return res;
}

// settings edited from Panel > AI Bot (kept out of the normal settings lists)
const SETTING_KEYS = ['ai_enabled', 'ai_model_gemini', 'ai_model_groq', 'ai_limit_enabled', 'ai_limit_per_day', 'ai_temperature', 'ai_max_tokens', 'ai_history_turns', 'ai_limit_msg', 'ai_fallback', 'ai_knowledge', 'ai_system_prompt'];

module.exports = { SETTING_KEYS, encrypt, decrypt, enabled, hasKeys, ask, chat, buildSystem, autoFacts, today, takeQuestion, COOLDOWN };

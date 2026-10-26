/* SMM Admin Panel - vanilla JS single page app (no build step).
   All user-controlled text is inserted with textContent via h() - never innerHTML. */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // tiny DOM helpers
  // ------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const mmk = (n) => fmt(Math.round(Number(n || 0))) + ' ကျပ်';
  const tz = 'Asia/Yangon';
  const dt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
  function ago(d) {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'ခုနကပဲ';
    if (s < 3600) return Math.floor(s / 60) + ' မိနစ်က';
    if (s < 86400) return Math.floor(s / 3600) + ' နာရီက';
    return Math.floor(s / 86400) + ' ရက်က';
  }

  const ICONS = {
    dash: '<path d="M4 19V10M10 19V5M16 19v-7M22 19H2"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    cart: '<path d="M3 4h2l2.4 11h10.2L20 8H6"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18 14.8c2 .6 3.3 2.3 3.6 5.2"/>',
    box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.3M12 17h.01"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8h14v-8M8.5 8a2.5 2.5 0 110-5C11 3 12 8 12 8s1-5 3.5-5a2.5 2.5 0 110 5"/>',
    mega: '<path d="M3 11v2a1 1 0 001 1h3l8 4V6L7 10H4a1 1 0 00-1 1zM19 8.5a5 5 0 010 7"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    log: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/><circle cx="12" cy="3.5" r="1"/>',
    bell: '<path d="M6 9a6 6 0 0112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 004 0"/>',
    out: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>'
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  // ------------------------------------------------------------------
  // api
  // ------------------------------------------------------------------
  const BASE = (document.querySelector('meta[name=panel-base]') || {}).content || '/admin';
  class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(BASE + '/api' + url, {
        method, credentials: 'same-origin',
        headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'GET' ? undefined : JSON.stringify(body === undefined ? {} : body)
      });
    } catch (_) { throw new ApiError('Server နဲ့ ချိတ်ဆက်မရပါ', 0); }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && url !== '/login') { state.me = null; renderRoot(); throw new ApiError('Login လိုအပ်ပါသည်', 401); }
    if (!res.ok) throw new ApiError((data && data.message) || ('Error ' + res.status), res.status);
    return data;
  }
  const GET = (u) => api('GET', u);
  const POST = (u, b) => api('POST', u, b || {});
  const PATCH = (u, b) => api('PATCH', u, b || {});
  const DEL = (u) => api('DELETE', u);

  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || '') }, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 5000 : 2800);
  }
  const fail = (e) => { if (!e || e.status !== 401) toast(e && e.message || 'Error', 'err'); };
  // run an async action with the clicked button disabled; toasts errors
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { fail(e); return undefined; } finally { if (btn) btn.disabled = false; }
  }

  // ------------------------------------------------------------------
  // modal
  // ------------------------------------------------------------------
  function modal(title, body, opts = {}) {
    const close = () => { ov.remove(); document.removeEventListener('keydown', esc); if (opts.onClose) opts.onClose(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const sheet = h('div', { class: 'sheet' + (opts.wide ? ' wide' : '') },
      h('header', {}, h('h2', {}, title), h('button', { class: 'btn ghost icon', onclick: close, 'aria-label': 'ပိတ်' }, '✕')),
      body);
    const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } }, sheet);
    document.addEventListener('keydown', esc);
    document.body.appendChild(ov);
    return { close, sheet };
  }
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(resolve => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
      const m = modal(title, h('div', { class: 'stack' },
        h('div', {}, text),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn', onclick: () => finish(false) }, 'မလုပ်တော့ပါ'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, okLabel || 'သေချာပါတယ်'))),
        { onClose: () => finish(false) });
      m.sheet.dataset.confirm = '1';
    });
  }
  function promptBox(title, label, { value = '', type = 'text', okLabel = 'OK', hint = '', textarea = false } = {}) {
    return new Promise(resolve => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
      const input = textarea ? h('textarea', { value }) : h('input', { type, value, inputmode: type === 'number' ? 'numeric' : null });
      const go = () => finish(input.value.trim());
      if (!textarea) input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      const m = modal(title, h('div', { class: 'stack' },
        h('label', { class: 'f' }, h('span', {}, label), input),
        hint ? h('div', { class: 'small muted' }, hint) : null,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn', onclick: () => finish(null) }, 'မလုပ်တော့ပါ'),
          h('button', { class: 'btn primary', onclick: go }, okLabel))),
        { onClose: () => finish(null) });
      setTimeout(() => input.focus(), 30);
    });
  }
  function lightbox(src) {
    const ov = h('div', { class: 'overlay lightbox', onclick: () => ov.remove() }, h('img', { src, alt: 'screenshot' }));
    document.body.appendChild(ov);
  }

  // ------------------------------------------------------------------
  // shared bits
  // ------------------------------------------------------------------
  function statusPill(status) {
    const s = String(status || '').toLowerCase();
    let cls = '';
    if (s === 'completed' || s === 'approved') cls = 'ok';
    else if (['pending', 'processing', 'in progress'].includes(s)) cls = 'warn';
    else if (['canceled', 'cancelled', 'rejected', 'error', 'fail', 'failed'].includes(s)) cls = 'bad';
    else if (s === 'partial') cls = 'acc';
    return h('span', { class: 'pill ' + cls }, status || '-');
  }
  function pager(data, go) {
    if (!data || data.pages <= 1) return null;
    return h('div', { class: 'pager' },
      h('button', { class: 'btn sm', disabled: data.page <= 1, onclick: () => go(data.page - 1) }, '‹ နောက်'),
      h('span', { class: 'muted small' }, `${data.page} / ${data.pages}`),
      h('button', { class: 'btn sm', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }, 'ရှေ့ ›'));
  }
  const empty = (t) => h('div', { class: 'empty' }, t);
  const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const field = (label, input) => h('label', { class: 'f' }, h('span', {}, label), input);
  // one-tap copy (falls back to a hidden textarea for old/in-app browsers)
  function copyText(text) {
    const ok = () => toast('Copy ပြီး: ' + String(text).slice(0, 40), 'ok');
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(String(text)).then(ok).catch(() => legacy());
    return legacy();
    function legacy() {
      const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = String(text); document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); ok(); } catch (_) { toast('Copy မရပါ', 'err'); }
      t.remove();
    }
  }
  const copyBtn = (text, label) => h('button', { class: 'btn sm', title: 'Copy', onclick: (e) => { e.stopPropagation(); copyText(text); } }, '⧉ ' + (label || 'Copy'));
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ------------------------------------------------------------------
  // app state + routing
  // ------------------------------------------------------------------
  const state = { me: null, pending: 0, route: 'dashboard', sound: false, timers: [] };
  try { state.sound = localStorage.getItem('smm_sound') === '1'; } catch (_) {}

  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dash' },
    { id: 'deposits', label: 'ငွေဖြည့်', icon: 'cash' },
    { id: 'orders', label: 'Orders', icon: 'cart' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'services', label: 'Services', icon: 'box' }
  ];
  const MORE = [
    { id: 'ai', label: 'AI Bot', icon: 'bot' },
    { id: 'help', label: 'Help Orders', icon: 'help' },
    { id: 'coupons', label: 'Coupon', icon: 'gift' },
    { id: 'broadcast', label: 'စာပို့ရန်', icon: 'mega' },
    { id: 'settings', label: 'Settings', icon: 'gear' },
    { id: 'logs', label: 'Activity Log', icon: 'log' }
  ];
  const PAGES = { dashboard: pageDashboard, deposits: pageDeposits, orders: pageOrders, users: pageUsers, services: pageServices, help: pageHelp, ai: pageAI, coupons: pageCoupons, broadcast: pageBroadcast, settings: pageSettings, logs: pageLogs };

  function routeId() { const r = (location.hash || '#dashboard').slice(1).split('?')[0]; return PAGES[r] ? r : 'dashboard'; }
  function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
  function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

  function renderRoot() {
    clearTimers();
    const app = $('#app');
    app.replaceChildren();
    if (!state.me) return renderLogin(app);
    state.route = routeId();
    const view = h('div', { id: 'view' });
    const navLink = (n, cls) => h('a', { href: '#' + n.id, class: (state.route === n.id ? 'on ' : '') + (cls || '') },
      icon(n.icon), n.label,
      n.id === 'deposits' && state.pending ? h('span', { class: 'badge-dot', 'data-pend': '1' }, state.pending > 99 ? '99+' : state.pending) : null);
    const moreActive = MORE.some(m => m.id === state.route);
    app.appendChild(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('i', {}, icon('dash')), 'SMM Admin'),
        NAV.map(n => navLink(n)), MORE.map(n => navLink(n)),
        h('div', { class: 'spacer' }),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); toggleSound(); } }, icon('bell'), state.sound ? 'Alert: ON' : 'Alert: OFF'),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, icon('out'), 'Logout')),
      h('main', { class: 'main' },
        h('div', { class: 'topbar only-narrow' },
          h('h1', {}, (NAV.concat(MORE).find(n => n.id === state.route) || {}).label),
          h('button', { class: 'btn ghost icon', onclick: toggleSound, 'aria-label': 'Alert' }, icon('bell')),
          h('button', { class: 'btn ghost icon', onclick: logout, 'aria-label': 'Logout' }, icon('out'))),
        view),
      h('nav', { class: 'bottomnav' },
        NAV.map(n => navLink(n)),
        h('a', { href: '#', class: moreActive ? 'on' : '', onclick: (e) => { e.preventDefault(); openMore(); } }, icon('more'), 'More'))));
    PAGES[state.route](view);
    document.title = (state.pending ? `(${state.pending}) ` : '') + 'SMM Admin';
  }
  function openMore() {
    const m = modal('More', h('div', { class: 'stack' }, MORE.map(n =>
      h('a', { class: 'btn', href: '#' + n.id, onclick: () => m.close(), style: 'justify-content:flex-start;text-decoration:none' }, icon(n.icon), n.label)),
      h('button', { class: 'btn', onclick: () => { m.close(); toggleSound(); } }, icon('bell'), state.sound ? 'Alert sound: ON' : 'Alert sound: OFF')));
  }
  async function logout() { try { await POST('/logout'); } catch (_) {} state.me = null; location.hash = ''; renderRoot(); }
  window.addEventListener('hashchange', () => { if (state.me) renderRoot(); });

  // ------------------------------------------------------------------
  // login screen (handles the one-time link from /adminlogin)
  // ------------------------------------------------------------------
  function renderLogin(app) {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const msg = h('p', { class: 'muted' });
    const user = h('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, spellcheck: 'false', 'aria-label': '2FA', style: 'text-align:center;letter-spacing:.35em;font-size:1.4rem' });
    const btn = h('button', { class: 'btn primary', style: 'width:100%' }, 'ဝင်မည်');
    const box = h('div', { class: 'hide' }, user, pass);
    const card = h('div', { class: 'card' },
      h('div', { class: 'logo' }, icon('dash')),
      h('h1', {}, 'SMM Admin Panel'), msg, box, btn);
    app.appendChild(h('div', { class: 'login' }, card));
    const grid = 'display:grid;gap:10px;margin:12px 0';
    const done = async () => { history.replaceState(null, '', BASE); await boot(); };
    let ticket = null;
    const submit = async () => {
      btn.disabled = true; msg.textContent = '';
      try {
        if (ticket) {
          await POST('/login', { ticket, code: code.value }); code.value = ''; await done();
        } else {
          const r = await POST('/login', { username: user.value, password: pass.value });
          pass.value = '';
          if (r.step === '2fa') { // step 2: password was right -> ONLY the code box (nothing else on screen)
            ticket = r.ticket;
            box.replaceChildren(code); btn.disabled = false; code.focus();
            code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
            return;
          }
          await done();
        }
      } catch (e) {
        msg.textContent = e.message; btn.disabled = false;
        if (ticket) { code.value = ''; if (/ပြန်စပါ|အချိန်ကုန်/.test(e.message)) { ticket = null; box.replaceChildren(user, pass); user.focus(); } else code.focus(); }
        else pass.value = '';
      }
    };
    if (token) {
      msg.textContent = 'Admin အတည်ပြုနေပါသည်...';
      btn.classList.add('hide');
      (async () => {
        try { await POST('/login', { token }); await done(); }
        catch (e) { msg.textContent = e.message; }
      })();
      return;
    }
    GET('/login-info').then(info => {
      if (info.password) {
        box.classList.remove('hide'); box.style.cssText = grid;
        btn.onclick = submit;
        for (const el of [user, pass]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        user.focus();
      } else {
        btn.classList.add('hide');
        msg.replaceChildren('Telegram bot ထဲမှာ ', h('code', {}, '/adminlogin'), ' လို့ ပို့ပါ။ ပြန်လာတဲ့ button ကိုနှိပ်ရင် ဒီ panel ထဲ ဝင်ရပါမယ်။');
      }
    }).catch(() => { btn.classList.add('hide'); msg.textContent = 'Server နဲ့ ချိတ်ဆက်မရပါ။'; });
  }

  // ------------------------------------------------------------------
  // new-deposit alerts (badge + sound + browser notification)
  // ------------------------------------------------------------------
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = i ? 1046 : 784; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.18);
      });
    } catch (_) {}
  }
  function toggleSound() {
    state.sound = !state.sound;
    try { localStorage.setItem('smm_sound', state.sound ? '1' : '0'); } catch (_) {}
    if (state.sound) {
      beep();
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    }
    toast(state.sound ? 'Alert ဖွင့်ပြီး (ငွေဖြည့်တောင်းဆိုမှုအသစ်ဝင်ရင် အသံမြည်မည်)' : 'Alert ပိတ်ပြီး');
    renderRoot();
  }
  let lastLatest = undefined;
  async function pollAlerts() {
    if (!state.me) return;
    try {
      const a = await GET('/alerts');
      const prev = state.pending;
      state.pending = a.pendingDeposits;
      if (lastLatest !== undefined && a.latestPendingId && a.latestPendingId !== lastLatest) {
        toast('💰 ငွေဖြည့်တောင်းဆိုမှု အသစ်ရောက်လာပါပြီ');
        if (state.sound) {
          beep();
          if ('Notification' in window && Notification.permission === 'granted' && document.hidden) { try { new Notification('ငွေဖြည့်တောင်းဆိုမှု အသစ်', { body: `စောင့်ဆိုင်းနေသည်: ${a.pendingDeposits}` }); } catch (_) {} }
        }
        if (state.route === 'deposits' && typeof state.refreshDeposits === 'function') state.refreshDeposits();
      }
      lastLatest = a.latestPendingId;
      if (prev !== state.pending) {
        document.title = (state.pending ? `(${state.pending}) ` : '') + 'SMM Admin';
        document.querySelectorAll('[data-pend]').forEach(e => e.remove());
        if (state.pending) document.querySelectorAll('a[href="#deposits"]').forEach(a2 => a2.appendChild(h('span', { class: 'badge-dot', 'data-pend': '1' }, state.pending > 99 ? '99+' : state.pending)));
      }
    } catch (_) { /* transient */ }
  }
  setInterval(pollAlerts, 12000);

  // ==================================================================
  // PAGE: Dashboard
  // ==================================================================
  async function pageDashboard(view) {
    view.appendChild(h('div', { class: 'empty' }, 'Loading...'));
    let d;
    try { d = await GET('/dashboard'); } catch (e) { return fail(e); }
    view.replaceChildren();
    const kpi = (label, value, sub, cls) => h('div', { class: 'card kpi-card ' + (cls || '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub || ' '));

    const banners = [];
    if (d.alerts.pendingDeposits) banners.push(h('a', { class: 'banner warn', href: '#deposits' }, `💰 စစ်ဆေးရန် ငွေဖြည့်တောင်းဆိုမှု ${d.alerts.pendingDeposits} ခု စောင့်နေပါသည်`));
    if (d.alerts.openHelp) banners.push(h('a', { class: 'banner warn', href: '#help' }, `🆘 Order အကူအညီ တောင်းဆိုမှု ${d.alerts.openHelp} ခု စောင့်နေပါသည်`));
    if (d.alerts.problemOrders) banners.push(h('a', { class: 'banner bad', href: '#orders' }, `⚠️ အာရုံစိုက်ရန် Order ${d.alerts.problemOrders} ခု (Partial / Cancel / Error)`));
    const provBox = h('div', { class: 'stack' }, h('div', { class: 'muted small' }, 'Loading...'));
    const lowBanner = h('div');
    view.appendChild(h('div', { class: 'stack' },
      banners, lowBanner,
      h('div', { class: 'grid kpi' },
        kpi('ယနေ့ ရောင်းရငွေ', mmk(d.today.revenue), `Order ${fmt(d.orders.today)} ခု`),
        kpi('ယနေ့ အမြတ် (ခန့်မှန်း)', mmk(d.today.profit), '၇ ရက်: ' + mmk(d.week.profit), 'good'),
        kpi('ယနေ့ ငွေဖြည့်', mmk(d.today.deposits), `${fmt(d.today.depositCount)} ကြိမ်`),
        kpi('Users', fmt(d.users.total), `ယနေ့ +${fmt(d.users.today)}${d.users.banned ? ' · ban ' + d.users.banned : ''}`)),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h2', {}, 'ရောင်းရငွေ - ၁၄ ရက်'), chart(d.days)),
        h('div', { class: 'stack' },
          h('div', { class: 'card' },
            h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Provider လက်ကျန်ငွေ'),
              h('button', { class: 'btn sm', onclick: (e) => busy(e.target, () => loadProviders(true)) }, '↻')),
            h('div', { style: 'height:8px' }), provBox),
          h('div', { class: 'card' }, h('h2', {}, 'အနှစ်ချုပ်'),
            kv([['User တွေရဲ့ စုစုပေါင်း လက်ကျန်', mmk(d.userBalances)], ['Order စုစုပေါင်း', fmt(d.orders.total)], ['၇ ရက် ရောင်းရငွေ', mmk(d.week.revenue)], ['၇ ရက် Order', fmt(d.week.orders)]]))))));

    async function loadProviders(force) {
      const r = await GET('/providers/balance' + (force ? '?force=1' : ''));
      provBox.replaceChildren(...r.providers.map(p => h('div', { class: 'row nowrap' },
        h('strong', { class: 'grow' }, p.provider),
        !p.configured ? h('span', { class: 'pill' }, 'မချိတ်ရသေး')
          : p.error ? h('span', { class: 'pill bad' }, p.error)
          : h('span', { class: 'pill ' + (p.low ? 'bad' : 'ok') }, p.balance === null ? '?' : `${p.balance} ${p.currency || ''}`))));
      const low = r.providers.filter(p => p.low);
      lowBanner.replaceChildren(...low.map(p => h('div', { class: 'banner bad' }, `⚠️ ${p.provider} လက်ကျန်ငွေ နည်းနေပါပြီ (${p.balance} ${p.currency || ''}) - ငွေဖြည့်ပါ`)));
    }
    loadProviders(false).catch(fail);
  }

  function chart(days) {
    const W = 340, H = 170, pad = { l: 6, r: 6, t: 8, b: 22 };
    const max = Math.max(1, ...days.map(x => x.revenue));
    const bw = (W - pad.l - pad.r) / days.length;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'ရောင်းရငွေ ၁၄ ရက်');
    const mk = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; };
    days.forEach((x, i) => {
      const x0 = pad.l + i * bw + bw * 0.14, w = bw * 0.72, ch = H - pad.t - pad.b;
      const hr = Math.max(x.revenue > 0 ? 2 : 0, (x.revenue / max) * ch);
      const hp = Math.max(0, Math.min(hr, (Math.max(0, x.profit) / max) * ch));
      const g = mk('g', {});
      g.appendChild(mk('title', {}, `${x.date}\nရောင်းရငွေ ${fmt(x.revenue)}\nအမြတ် ${fmt(x.profit)}\nOrder ${x.orders}`));
      g.appendChild(mk('rect', { class: 'bar-r', x: x0, y: H - pad.b - hr, width: w, height: hr, rx: 3 }));
      if (hp > 0) g.appendChild(mk('rect', { class: 'bar-p', x: x0, y: H - pad.b - hp, width: w, height: hp, rx: 3 }));
      if (i % 2 === 1 || days.length < 8) g.appendChild(mk('text', { x: x0 + w / 2, y: H - 6, 'text-anchor': 'middle' }, x.date.slice(8)));
      svg.appendChild(g);
    });
    return h('div', {}, svg, h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--accent)' }), 'ရောင်းရငွေ'), h('span', {}, h('i', { style: 'background:var(--ok)' }), 'အမြတ်'), h('span', {}, 'အမြင့်ဆုံး ', fmt(max))));
  }

  // ==================================================================
  // PAGE: Deposits
  // ==================================================================
  function pageDeposits(view) {
    let status = 'pending', page = 1;
    const list = h('div', { class: 'stack' });
    const tabs = h('div', { class: 'chips', style: 'margin-bottom:12px' });
    const TABS = [['pending', 'စောင့်ဆိုင်းဆဲ'], ['approved', 'လက်ခံပြီး'], ['rejected', 'ပယ်ချပြီး'], ['', 'အားလုံး']];
    function drawTabs() { tabs.replaceChildren(...TABS.map(([k, label]) => h('button', { class: 'chip' + (status === k ? ' on' : ''), onclick: () => { status = k; page = 1; drawTabs(); load(); } }, label, k === 'pending' && state.pending ? h('span', { class: 'n' }, state.pending) : null))); }
    view.append(tabs, list);
    drawTabs();

    async function load() {
      let r;
      try { r = await GET(`/deposits?status=${status}&page=${page}`); } catch (e) { return fail(e); }
      list.replaceChildren();
      if (!r.items.length) list.appendChild(empty(status === 'pending' ? '🎉 စောင့်ဆိုင်းနေတာ မရှိတော့ပါ' : 'မှတ်တမ်း မရှိပါ'));
      r.items.forEach(d => list.appendChild(depositCard(d, load)));
      const p = pager(r, (n) => { page = n; load(); });
      if (p) list.appendChild(p);
    }
    state.refreshDeposits = () => { if (state.route === 'deposits' && page === 1) load(); };
    load();
    every(15000, () => { if (status === 'pending') load(); });
  }

  function depositCard(d, reload) {
    const pending = d.status === 'pending';
    const shot = d.hasPhoto
      ? h('div', { class: 'shot', style: `background-image:url(${BASE}/api/deposits/${d.id}/photo)`, onclick: () => lightbox(`${BASE}/api/deposits/${d.id}/photo`), title: 'ကြည့်ရန်' })
      : h('div', { class: 'shot' }, 'No img');
    async function act(btn, fn, okMsg) { const r = await busy(btn, fn); if (r !== undefined) { toast(okMsg, 'ok'); reload(); pollAlerts(); } else reload(); }
    return h('div', { class: 'card' },
      h('div', { class: 'row nowrap', style: 'align-items:flex-start' }, shot,
        h('div', { class: 'grow' },
          h('div', { class: 'row nowrap' },
            h('button', { class: 'link trunc', onclick: () => openUser(d.userId) }, d.userName),
            statusPill(d.status)),
          h('div', { class: 'muted small' }, `ID ${d.userId}${d.username ? ' · @' + d.username : ''}`),
          h('div', { class: 'muted small' }, `${d.method || '-'} · ${dt(d.createdAt)} (${ago(d.createdAt)})`)),
        h('div', { class: 'right' }, h('div', { class: 'big' }, fmt(d.amount)), d.requestedAmount && d.requestedAmount !== d.amount ? h('div', { class: 'small muted' }, 'မူရင်း ' + fmt(d.requestedAmount)) : h('div', { class: 'small muted' }, 'ကျပ်'))),
      !pending ? h('div', { class: 'small muted', style: 'margin-top:8px' }, `${d.handledBy === 'panel' ? 'Panel' : (d.handledBy || '').replace('bot:', 'Telegram Admin ')} · ${dt(d.handledAt)}${d.note ? ' · ' + d.note : ''}`) : null,
      pending ? h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn ok grow', onclick: (e) => act(e.target, () => POST(`/deposits/${d.id}/approve`), `✅ ${fmt(d.amount)} ကျပ် ထည့်ပြီး`) }, '✅ Accept'),
        h('button', { class: 'btn', onclick: async (e) => {
          const v = await promptBox('ပမာဏ ပြင်ပြီး လက်ခံမည်', 'မှန်ကန်သော ပမာဏ (ကျပ်)', { value: String(d.amount), type: 'number', okLabel: 'လက်ခံမည်' });
          if (v) act(e.target, () => POST(`/deposits/${d.id}/approve`, { amount: v }), `✅ ${fmt(v)} ကျပ် ထည့်ပြီး`);
        } }, '✏️ Edit'),
        h('button', { class: 'btn danger', onclick: async (e) => {
          const v = await promptBox('ပယ်ချမည်', 'အကြောင်းရင်း (User ဆီ ပို့ပါမယ်၊ မရေးလည်းရ)', { okLabel: 'ပယ်ချမည်' });
          if (v !== null) act(e.target, () => POST(`/deposits/${d.id}/reject`, { reason: v }), 'ပယ်ချပြီး');
        } }, '❌ Reject')) : null);
  }

  // ==================================================================
  // PAGE: Orders
  // ==================================================================
  function pageOrders(view) {
    let status = '', page = 1, q = '';
    const list = h('div', { class: 'stack' });
    const chips = h('div', { class: 'chips' });
    const FILTERS = [['', 'အားလုံး'], ['pending', 'Pending'], ['processing', 'Processing'], ['completed', 'Completed'], ['partial', 'Partial'], ['canceled', 'Canceled'], ['problem', '⚠️ Problem']];
    const search = h('input', { type: 'search', placeholder: 'Order ID / Link / User ID ရှာရန်', oninput: debounce(() => { q = search.value.trim(); page = 1; load(); }, 350) });
    function drawChips() { chips.replaceChildren(...FILTERS.map(([k, l]) => h('button', { class: 'chip' + (status === k ? ' on' : ''), onclick: () => { status = k; page = 1; drawChips(); load(); } }, l))); }
    view.append(h('div', { class: 'toolbar' }, search), chips, h('div', { style: 'height:12px' }), list);
    drawChips();
    async function load() {
      let r;
      try { r = await GET(`/orders?status=${status}&q=${encodeURIComponent(q)}&page=${page}`); } catch (e) { return fail(e); }
      list.replaceChildren();
      if (!r.items.length) list.appendChild(empty('Order မရှိပါ'));
      r.items.forEach(o => list.appendChild(orderCard(o, load)));
      const p = pager(r, n => { page = n; load(); }); if (p) list.appendChild(p);
    }
    load();
  }

  function orderCard(o, reload) {
    const profit = o.baseCost == null ? null : (o.cost - o.refundAmount) - o.baseCost * ((o.cost - o.refundAmount) / (o.cost || 1));
    return h('div', { class: 'card', style: 'cursor:pointer', onclick: () => openOrder(o, reload) },
      h('div', { class: 'row nowrap' },
        h('div', { class: 'grow' }, h('div', { class: 'trunc', style: 'font-weight:700' }, o.label || '-'), h('div', { class: 'muted small trunc' }, o.link)),
        h('button', { class: 'pill acc', style: 'border:0;cursor:copy', title: 'Order ID copy', onclick: (e) => { e.stopPropagation(); copyText(o.shortId); } }, '#' + o.shortId),
        statusPill(o.status)),
      h('div', { class: 'row small muted', style: 'margin-top:6px;justify-content:space-between' },
        h('span', {}, `${o.userName} · ${fmt(o.quantity)} ခု`),
        h('span', {}, `${fmt(o.cost)} ကျပ်${profit !== null ? ' (+' + fmt(Math.round(profit)) + ')' : ''}${o.refunded ? ' · refunded ' + fmt(o.refundAmount) : ''}`),
        h('span', {}, dt(o.createdAt))));
  }

  function openOrder(o, reload) {
    const done = (m) => { m.close(); reload(); };
    const profit = o.baseCost == null ? '-' : mmk((o.cost - o.refundAmount) - o.baseCost * ((o.cost - o.refundAmount) / (o.cost || 1)));
    const sel = h('select', {}, ['pending', 'processing', 'in progress', 'completed', 'partial', 'canceled'].map(s => h('option', { value: s, selected: String(o.status).toLowerCase() === s }, s)));
    const m = modal(`Order #${o.shortId}`, h('div', { class: 'stack' },
      kv([
        ['Order ID', h('span', { class: 'row', style: 'justify-content:flex-end' }, h('strong', { class: 'mono' }, o.shortId), copyBtn(o.shortId))],
        ['Provider order ID', h('span', { class: 'row', style: 'justify-content:flex-end' }, h('span', { class: 'mono' }, `${o.provider} ${o.providerOrderId}`), copyBtn(o.providerOrderId))],
        ['Service', o.label], ['Link', h('span', {}, h('a', { href: /^https?:\/\//i.test(o.link) ? o.link : null, target: '_blank', rel: 'noopener noreferrer' }, o.link), ' ', copyBtn(o.link))],
        ['User', h('button', { class: 'link', onclick: () => { m.close(); openUser(o.userId); } }, `${o.userName} (${o.userId})`)],
        ['အရေအတွက်', fmt(o.quantity)], ['ကျသင့်ငွေ', mmk(o.cost)], ['Provider ကုန်ကျ', o.baseCost == null ? '-' : mmk(o.baseCost)], ['အမြတ်', profit],
        ['Status', statusPill(o.status)], ['ကျန်ရှိ (remains)', o.remains == null ? '-' : fmt(o.remains)],
        ['ငွေပြန်အမ်း', o.refunded ? mmk(o.refundAmount) : 'မရှိ'], ['ရက်စွဲ', dt(o.createdAt)]
      ]),
      h('button', { class: 'btn', onclick: (e) => busy(e.target, async () => { const r = await POST(`/orders/${o.id}/refresh`); toast('Provider ကနေ ပြန်စစ်ပြီး: ' + r.status, 'ok'); done(m); }) }, '↻ Provider ကနေ status ပြန်စစ်ရန်'),
      h('div', { class: 'row nowrap' }, sel,
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
          const body = { status: sel.value };
          if (sel.value === 'partial') {
            const v = await promptBox('Partial', 'မပြီးသေးတဲ့ အရေအတွက် (remains)', { type: 'number', okLabel: 'သတ်မှတ်မည်', hint: 'ဒီအရေအတွက်အတွက် ငွေ အချိုးကျ ပြန်အမ်းပါမယ်' });
            if (!v) return; body.remains = v;
          }
          if (sel.value === 'canceled' && !(await confirmBox('Cancel & Refund', `${mmk(o.cost)} ကို User ဆီ ပြန်အမ်းပါမယ်။`, 'Cancel လုပ်မည်', true))) return;
          const r = await POST(`/orders/${o.id}/status`, body);
          toast(r.refunded ? 'Status ပြောင်းပြီး၊ ငွေပြန်အမ်းပြီး' : 'Status ပြောင်းပြီး', 'ok'); done(m);
        }) }, 'Status ပြောင်း')),
      !o.refunded ? h('button', { class: 'btn', onclick: async (e) => {
        const v = await promptBox('ငွေပြန်အမ်းမည်', `ပြန်အမ်းမည့် ပမာဏ (အများဆုံး ${fmt(o.cost)})`, { type: 'number', value: String(o.cost), okLabel: 'ပြန်အမ်းမည်' });
        if (v) busy(e.target, async () => { await POST(`/orders/${o.id}/refund`, { amount: v }); toast('ငွေပြန်အမ်းပြီး', 'ok'); done(m); });
      } }, '💸 ငွေပြန်အမ်းရန် (ပမာဏ ရွေးနိုင်)') : null,
      h('button', { class: 'btn danger', onclick: async (e) => {
        if (await confirmBox('Order မှတ်တမ်း ဖျက်မည်', 'Database ထဲက မှတ်တမ်းကိုသာ ဖျက်ပါမယ် (ငွေမပြန်အမ်းပါ၊ provider ဘက် order ကိုလည်း မထိပါ)။', 'ဖျက်မည်', true))
          busy(e.target, async () => { await DEL(`/orders/${o.id}`); toast('ဖျက်ပြီး', 'ok'); done(m); });
      } }, '🗑 မှတ်တမ်းဖျက်ရန်')));
  }

  // ==================================================================
  // PAGE: Users (+ user modal used everywhere)
  // ==================================================================
  function pageUsers(view) {
    let page = 1, q = '', sort = 'new', banned = '';
    const list = h('div', { class: 'stack' });
    const search = h('input', { type: 'search', placeholder: 'နာမည် / @username / ID ရှာရန်', oninput: debounce(() => { q = search.value.trim(); page = 1; load(); }, 350) });
    const sortSel = h('select', { onchange: () => { sort = sortSel.value; page = 1; load(); } },
      h('option', { value: 'new' }, 'နောက်ဆုံးဝင်'), h('option', { value: 'balance' }, 'လက်ကျန်ငွေ များ'), h('option', { value: 'spent' }, 'သုံးငွေ များ'));
    const banSel = h('select', { onchange: () => { banned = banSel.value; page = 1; load(); } }, h('option', { value: '' }, 'အားလုံး'), h('option', { value: '1' }, 'Ban ထားသူ'));
    view.append(h('div', { class: 'toolbar' }, search, sortSel, banSel), list);
    async function load() {
      let r;
      try { r = await GET(`/users?q=${encodeURIComponent(q)}&page=${page}&sort=${sort}&banned=${banned}`); } catch (e) { return fail(e); }
      list.replaceChildren(h('div', { class: 'muted small' }, `စုစုပေါင်း ${fmt(r.total)} ယောက်`));
      if (!r.items.length) list.appendChild(empty('User မတွေ့ပါ'));
      list.appendChild(h('div', { class: 'card' }, h('div', { class: 'list' }, r.items.map(u =>
        h('div', { class: 'item row nowrap', style: 'cursor:pointer', onclick: () => openUser(u.id, load) },
          h('div', { class: 'grow' },
            h('div', { class: 'row nowrap' }, h('strong', { class: 'trunc' }, u.name), u.banned ? h('span', { class: 'pill bad' }, 'banned') : null, u.blockedBot ? h('span', { class: 'pill warn' }, 'bot block') : null, u.discount ? h('span', { class: 'pill acc' }, `-${u.discount}%`) : null),
            h('div', { class: 'muted small trunc' }, `${u.id}${u.username ? ' · @' + u.username : ''}`)),
          h('div', { class: 'right' }, h('div', { style: 'font-weight:700' }, fmt(u.balance)), h('div', { class: 'muted small' }, 'သုံး ' + fmt(u.totalSpent))))))));
      const p = pager(r, n => { page = n; load(); }); if (p) list.appendChild(p);
    }
    load();
  }

  async function openUser(id, onChange) {
    let r;
    try { r = await GET('/users/' + encodeURIComponent(id)); } catch (e) { return fail(e); }
    const u = r.user;
    let m;
    const refresh = async () => { m.close(); if (onChange) onChange(); openUser(id, onChange); };
    const amount = h('input', { type: 'number', placeholder: 'ပမာဏ (ကျပ်)', inputmode: 'numeric' });
    const discount = h('input', { type: 'number', value: String(u.discount), min: 0, max: 100, inputmode: 'decimal' });
    const note = h('input', { type: 'text', value: u.note, placeholder: 'Admin note (user မမြင်ရ)', maxlength: 300 });
    const msg = h('textarea', { placeholder: 'ဒီ user ဆီ Telegram ကနေ ပို့မည့် စာ...' });
    m = modal(u.name, h('div', { class: 'stack' },
      kv([['Telegram ID', u.id], ['Username', u.username ? '@' + u.username : '-'], ['လက်ကျန်ငွေ', h('strong', {}, mmk(u.balance))], ['စုစုပေါင်းသုံးငွေ', mmk(u.totalSpent)], ['Order', fmt(r.orderCount)], ['ဝင်သည့်ရက်', dt(u.createdAt)], ['Status', u.banned ? h('span', { class: 'pill bad' }, 'Banned') : h('span', { class: 'pill ok' }, 'Active')], ['Bot', u.blockedBot ? h('span', { class: 'pill warn' }, 'Bot ကို block/ဖျက်ထား (စာမပို့နိုင်)') : 'ပို့လို့ရ']]),
      h('div', { class: 'card flat' }, h('h3', {}, 'လက်ကျန်ငွေ ပြင်ရန်'), h('div', { style: 'height:8px' }), amount, h('div', { style: 'height:8px' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn ok grow', onclick: (e) => amount.value && busy(e.target, async () => { await POST(`/users/${u.id}/balance`, { amount: amount.value, mode: 'add' }); toast('ငွေထည့်ပြီး', 'ok'); refresh(); }) }, '＋ ထည့်'),
          h('button', { class: 'btn danger grow', onclick: (e) => amount.value && busy(e.target, async () => { await POST(`/users/${u.id}/balance`, { amount: amount.value, mode: 'deduct' }); toast('ငွေနှုတ်ပြီး', 'ok'); refresh(); }) }, '－ နှုတ်'))),
      h('div', { class: 'card flat' }, h('h3', {}, 'Reseller discount & note'), h('div', { style: 'height:8px' }),
        field('Discount % (ဈေးကို ဒီရာခိုင်နှုန်း လျှော့ပေးမည်)', discount), h('div', { style: 'height:8px' }), field('Note', note), h('div', { style: 'height:8px' }),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await POST(`/users/${u.id}/profile`, { discount: discount.value, note: note.value }); toast('သိမ်းပြီး', 'ok'); refresh(); }) }, 'သိမ်းမည်')),
      h('div', { class: 'card flat' }, h('h3', {}, 'စာပို့ရန်'), h('div', { style: 'height:8px' }), msg, h('div', { style: 'height:8px' }),
        h('button', { class: 'btn primary', onclick: (e) => msg.value.trim() && busy(e.target, async () => { await POST(`/users/${u.id}/message`, { text: msg.value }); toast('ပို့ပြီး ✅', 'ok'); msg.value = ''; }) }, 'ပို့မည်')),
      h('button', { class: 'btn ' + (u.banned ? 'ok' : 'danger'), onclick: async (e) => {
        if (!u.banned && !(await confirmBox('Ban လုပ်မည်', `${u.name} ကို bot သုံးခွင့် ပိတ်မည်။`, 'Ban', true))) return;
        busy(e.target, async () => { await POST(`/users/${u.id}/ban`, { banned: !u.banned }); toast(u.banned ? 'ပြန်ဖွင့်ပြီး' : 'Ban ပြီး', 'ok'); refresh(); });
      } }, u.banned ? 'Unban လုပ်မည်' : '🚫 Ban လုပ်မည်'),
      r.orders.length ? h('div', {}, h('h3', {}, 'နောက်ဆုံး Orders'), h('div', { class: 'list', style: 'margin-top:8px' }, r.orders.map(o =>
        h('div', { class: 'item row nowrap small' }, h('div', { class: 'grow trunc' }, `${o.label} · ${fmt(o.quantity)}`), h('span', {}, fmt(o.cost)), statusPill(o.status))))) : null,
      r.deposits.length ? h('div', {}, h('h3', {}, 'ငွေဖြည့်မှတ်တမ်း'), h('div', { class: 'list', style: 'margin-top:8px' }, r.deposits.map(d =>
        h('div', { class: 'item row nowrap small' }, h('div', { class: 'grow' }, `${d.method || '-'} · ${dt(d.createdAt)}`), h('span', {}, fmt(d.amount)), statusPill(d.status))))) : null),
      { wide: true });
  }

  // ==================================================================
  // PAGE: Services (catalogue + provider browser)
  // ==================================================================
  function pageServices(view) {
    let tab = 'catalog';
    const body = h('div', {});
    const chips = h('div', { class: 'chips', style: 'margin-bottom:12px' });
    function draw() {
      chips.replaceChildren(...[['catalog', '📦 ဆိုင်ထဲက Services'], ['add', '➕ Provider ကနေ ထည့်ရန်']].map(([k, l]) => h('button', { class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, l)));
      body.replaceChildren();
      (tab === 'catalog' ? catalogView : providerBrowser)(body, () => { tab = 'catalog'; draw(); });
    }
    view.append(chips, body);
    draw();
  }

  async function catalogView(root) {
    let c;
    try { c = await GET('/catalog'); } catch (e) { return fail(e); }
    const reload = () => { root.replaceChildren(); catalogView(root); };
    root.appendChild(h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: async () => {
        const key = await promptBox('Home button အသစ်', 'Key (English စာလုံးသေး၊ space မပါ) ဥပမာ telegram', { okLabel: 'ဆက်သွားမည်' }); if (!key) return;
        const label = await promptBox('Home button အမည်', 'User မြင်ရမည့် စာသား ဥပမာ Telegram Service', { okLabel: 'ထည့်မည်' }); if (!label) return;
        try { await POST('/platforms', { key, label }); toast('ထည့်ပြီး', 'ok'); reload(); } catch (e) { fail(e); }
      } }, '＋ Home button'),
      h('button', { class: 'btn', onclick: (e) => busy(e.target, async () => { const r = await POST('/services/sync'); toast(`Sync ပြီး: update ${r.updated}, fail ${r.failed}, provider ထဲမတွေ့ ${r.missing}`, 'ok'); reload(); }) }, '↻ Provider ဈေး/min/max Sync')));
    if (!c.platforms.length) { root.appendChild(empty('Home button မရှိသေးပါ။ "Provider ကနေ ထည့်ရန်" tab ကနေ စထည့်နိုင်ပါတယ်။')); return; }
    const stack = h('div', { class: 'stack' });
    for (const p of c.platforms) {
      const cats = c.categories.filter(x => x.platform === p.key);
      stack.appendChild(h('div', { class: 'card' },
        h('div', { class: 'tree-h' }, h('h2', { class: 'grow', style: 'margin:0' }, p.label), h('span', { class: 'muted small' }, p.key),
          h('button', { class: 'btn sm', onclick: async () => { const l = await promptBox('Category အသစ်', 'Category နာမည် ဥပမာ Reaction တိုးရန်❤️'); if (l) { try { await POST('/categories', { platform: p.key, label: l }); reload(); } catch (e) { fail(e); } } } }, '＋ Category'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Home button ဖျက်မည်', `"${p.label}" နှင့် အောက်က category/service အားလုံး ပါသွားမည်။`, 'ဖျက်မည်', true)) { try { await DEL('/platforms/' + p.key); reload(); } catch (e) { fail(e); } } } }, '🗑')),
        !cats.length ? h('div', { class: 'muted small' }, 'Category မရှိသေးပါ') : null,
        cats.map(cat => {
          const svcs = c.services.filter(s => s.categoryId === cat.id);
          return h('div', { class: 'cat' },
            h('div', { class: 'tree-h' }, h('strong', { class: 'grow' }, cat.label),
              h('button', { class: 'btn sm ghost', onclick: async () => { const l = await promptBox('Category နာမည်ပြင်', 'နာမည်အသစ်', { value: cat.label }); if (l) { try { await PATCH('/categories/' + cat.id, { label: l }); reload(); } catch (e) { fail(e); } } } }, '✏️'),
              h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmBox('Category ဖျက်မည်', `"${cat.label}" နှင့် service ${svcs.length} ခု ပါသွားမည်။`, 'ဖျက်မည်', true)) { try { await DEL('/categories/' + cat.id); reload(); } catch (e) { fail(e); } } } }, '🗑')),
            !svcs.length ? h('div', { class: 'muted small' }, 'Service မရှိသေးပါ') : null,
            svcs.map(s => serviceLine(s, c, reload)));
        })));
    }
    root.appendChild(stack);
  }

  function serviceLine(s, c, reload) {
    const sw = h('input', { type: 'checkbox', checked: s.active, onchange: async () => { try { await PATCH('/services/' + s.id, { active: sw.checked }); toast(sw.checked ? 'ဖွင့်ပြီး' : 'ပိတ်ပြီး (user မမြင်ရ)', 'ok'); } catch (e) { sw.checked = !sw.checked; fail(e); } } });
    return h('div', { class: 'svc-line' },
      h('label', { class: 'switch', title: 'ဖွင့်/ပိတ်' }, sw, h('i')),
      h('div', { class: 'grow' },
        h('div', { style: 'font-weight:600', class: 'trunc' }, s.label),
        h('div', { class: 'muted small' }, `${s.provider} #${s.providerServiceId} · $${s.rate}/1k → ${s.salePer1000 == null ? '?' : fmt(s.salePer1000)} ကျပ်/1k · ${fmt(s.min)}–${fmt(s.max)}${s.manualDuration ? ' · ' + s.manualDuration : ''}`)),
      h('button', { class: 'btn sm', onclick: () => editService(s, c, reload) }, 'Edit'),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Service ဖျက်မည်', `"${s.label}"`, 'ဖျက်မည်', true)) { try { await DEL('/services/' + s.id); reload(); } catch (e) { fail(e); } } } }, '🗑'));
  }

  function editService(s, c, reload) {
    const label = h('input', { type: 'text', value: s.label, maxlength: 80 });
    const dur = h('input', { type: 'text', value: s.manualDuration, placeholder: 'ဥပမာ 18 မိနစ်', maxlength: 60 });
    const catSel = h('select', {}, c.platforms.map(p => h('optgroup', { label: p.label }, c.categories.filter(x => x.platform === p.key).map(x => h('option', { value: x.id, selected: x.id === s.categoryId }, x.label)))));
    const m = modal('Service ပြင်ရန်', h('div', { class: 'stack' },
      field('Button label (user မြင်ရမည့်စာ)', label), field('ကြာချိန် (user ကို ပြမည့်စာ)', dur), field('Category', catSel),
      h('div', { class: 'small muted' }, `${s.provider} #${s.providerServiceId} — ${s.providerName || ''}`),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await PATCH('/services/' + s.id, { label: label.value, manualDuration: dur.value, categoryId: catSel.value }); m.close(); toast('သိမ်းပြီး', 'ok'); reload(); }) }, 'သိမ်းမည်')));
  }

  // ---- provider browser: search a provider's catalogue, tick, add ---------
  const PROVIDERS = ['shweboost', 'hiroshi', 'secsers'];
  async function providerBrowser(root, done) {
    const st = { provider: 'shweboost', q: '', category: '', page: 1, selected: new Map() };
    const head = h('div', { class: 'stack' });
    const listBox = h('div', {});
    const selbar = h('div', { class: 'hide' });
    root.append(head, listBox, selbar);

    const provChips = h('div', { class: 'chips' });
    const search = h('input', { type: 'search', placeholder: 'Service အမည် / ID / category ရှာရန်', oninput: debounce(() => { st.q = search.value.trim(); st.page = 1; load(); }, 400) });
    const catSel = h('select', { onchange: () => { st.category = catSel.value; st.page = 1; load(); } }, h('option', { value: '' }, 'Category အားလုံး'));
    function drawProv() { provChips.replaceChildren(...PROVIDERS.map(p => h('button', { class: 'chip' + (st.provider === p ? ' on' : ''), onclick: () => { st.provider = p; st.page = 1; st.category = ''; st.selected.clear(); drawProv(); drawSel(); load(true); } }, p))); }
    head.append(provChips, h('div', { class: 'toolbar', style: 'margin:0' }, search, catSel,
      h('button', { class: 'btn', title: 'Provider ဆီက ပြန်ဆွဲ', onclick: (e) => busy(e.target, () => load(true, true)) }, '↻')));
    drawProv();

    function drawSel() {
      selbar.className = st.selected.size ? 'selbar' : 'hide';
      selbar.replaceChildren(h('strong', { class: 'grow' }, `ရွေးထားသည် ${st.selected.size} ခု`),
        h('button', { class: 'btn sm', onclick: () => { st.selected.clear(); drawSel(); load(); } }, 'ဖျက်'),
        h('button', { class: 'btn sm primary', onclick: openAdd }, 'ထည့်မည် ›'));
    }

    async function load(resetCats, force) {
      listBox.replaceChildren(h('div', { class: 'empty' }, 'Provider ဆီက ဆွဲနေပါသည်...'));
      let r;
      try { r = await GET(`/providers/${st.provider}/services?q=${encodeURIComponent(st.q)}&category=${encodeURIComponent(st.category)}&page=${st.page}${force ? '&force=1' : ''}`); }
      catch (e) { listBox.replaceChildren(empty(e.message)); return; }
      if (resetCats || catSel.options.length <= 1) {
        catSel.replaceChildren(h('option', { value: '' }, `Category အားလုံး (${r.categories.reduce((a, x) => a + x.count, 0)})`), ...r.categories.map(x => h('option', { value: x.name, selected: x.name === st.category }, `${x.name} (${x.count})`)));
      }
      listBox.replaceChildren();
      if (!r.items.length) { listBox.appendChild(empty('မတွေ့ပါ')); return; }
      const card = h('div', { class: 'card' }, h('div', { class: 'list' }, r.items.map(it => {
        const cb = h('input', { type: 'checkbox', checked: st.selected.has(it.service), disabled: it.added, onchange: () => { if (cb.checked) st.selected.set(it.service, it); else st.selected.delete(it.service); drawSel(); } });
        const margin = it.salePer1000 != null && it.basePer1000 != null ? it.salePer1000 - it.basePer1000 : null;
        return h('label', { class: 'svc-row' + (it.added ? ' added' : '') }, cb,
          h('div', { class: 'grow' },
            h('div', { style: 'font-weight:600' }, it.name, ' ', it.added ? h('span', { class: 'pill ok' }, 'ထည့်ပြီး') : null),
            h('div', { class: 'muted small' }, `#${it.service} · ${it.category}`),
            h('div', { class: 'small', style: 'margin-top:2px' }, `$${it.rate}/1k · min ${fmt(it.min)} – max ${fmt(it.max)}`,
              it.salePer1000 != null ? ` · ရောင်းဈေး ${fmt(it.salePer1000)} ကျပ်/1k` : '',
              margin !== null ? h('span', { class: 'pill ' + (margin > 0 ? 'ok' : 'bad'), style: 'margin-left:6px' }, `${margin > 0 ? '+' : ''}${fmt(margin)}`) : null,
              it.refill ? h('span', { class: 'pill', style: 'margin-left:4px' }, 'refill') : null, it.cancel ? h('span', { class: 'pill', style: 'margin-left:4px' }, 'cancel') : null)));
      })));
      listBox.appendChild(card);
      const p = pager(r, n => { st.page = n; load(); window.scrollTo({ top: 0 }); }); if (p) listBox.appendChild(p);
      listBox.appendChild(h('div', { class: 'muted small', style: 'margin-top:8px;text-align:center' }, `${fmt(r.total)} ခု တွေ့ပါသည်`));
    }

    async function openAdd() {
      let cat;
      try { cat = await GET('/catalog'); } catch (e) { return fail(e); }
      const items = [...st.selected.values()];
      const platSel = h('select', {}, [h('option', { value: '__new' }, '＋ Home button အသစ်'), ...cat.platforms.map(p => h('option', { value: p.key }, p.label))]);
      const newKey = h('input', { type: 'text', placeholder: 'key ဥပမာ telegram' });
      const newLabel = h('input', { type: 'text', placeholder: 'label ဥပမာ Telegram Service' });
      const newBox = h('div', { class: 'stack' }, field('Key (English)', newKey), field('Label (user မြင်ရမည်)', newLabel));
      const catSel2 = h('select', {});
      const newCat = h('input', { type: 'text', placeholder: 'ဥပမာ Reaction တိုးရန်❤️' });
      const newCatBox = field('Category အသစ် နာမည်', newCat);
      function syncCats() {
        const isNew = platSel.value === '__new';
        newBox.classList.toggle('hide', !isNew);
        const cs = isNew ? [] : cat.categories.filter(x => x.platform === platSel.value);
        catSel2.replaceChildren(h('option', { value: '__new' }, '＋ Category အသစ်'), ...cs.map(x => h('option', { value: x.id }, x.label)));
        if (cs.length) catSel2.value = cs[0].id;
        newCatBox.classList.toggle('hide', catSel2.value !== '__new');
      }
      platSel.onchange = syncCats; catSel2.onchange = () => newCatBox.classList.toggle('hide', catSel2.value !== '__new');
      if (cat.platforms.length) platSel.value = cat.platforms[0].key;
      syncCats();
      const labels = items.map(it => h('input', { type: 'text', value: it.name.length > 60 ? it.name.slice(0, 60) : it.name, maxlength: 80 }));
      const m = modal(`Service ${items.length} ခု ထည့်မည်`, h('div', { class: 'stack' },
        field('Home button', platSel), newBox, field('Category', catSel2), newCatBox,
        h('h3', {}, 'User မြင်ရမည့် button စာသား (ပြင်လို့ရ)'),
        h('div', { class: 'stack' }, items.map((it, i) => h('div', {}, labels[i], h('div', { class: 'muted small' }, `${st.provider} #${it.service}`)))),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
          const body = { provider: st.provider, items: items.map((it, i) => ({ providerServiceId: it.service, label: labels[i].value })) };
          if (platSel.value === '__new') { body.platform = newKey.value.trim().toLowerCase(); body.platformLabel = newLabel.value.trim(); } else body.platform = platSel.value;
          if (catSel2.value === '__new') body.categoryLabel = newCat.value; else body.categoryId = catSel2.value;
          const r = await POST('/services/add', body);
          m.close(); st.selected.clear();
          toast(`ထည့်ပြီး ${r.created.length} ခု${r.skipped.length ? ' · ကျော် ' + r.skipped.length : ''}`, 'ok');
          if (r.skipped.length) toast(r.skipped.map(s => `#${s.id}: ${s.reason}`).slice(0, 3).join(' | '));
          drawSel(); load();
        }) }, 'ထည့်မည်')), { wide: true });
    }
    load(true);
  }

  // ==================================================================
  // PAGE: Help Orders (refill / speed up requests from the bot)
  // ==================================================================
  function pageHelp(view) {
    let status = 'open', page = 1;
    const list = h('div', { class: 'stack' });
    const chips = h('div', { class: 'chips', style: 'margin-bottom:12px' });
    const TYPE = { refill: '♻️ Refill', speed: '⚡ Speed up', cancel: '❌ Cancel' };
    function drawChips() { chips.replaceChildren(...[['open', 'စောင့်ဆိုင်းဆဲ'], ['done', 'ပြီးပြီ']].map(([k, l]) => h('button', { class: 'chip' + (status === k ? ' on' : ''), onclick: () => { status = k; page = 1; drawChips(); load(); } }, l))); }
    view.append(h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'User တွေ Bot ထဲက "Order အကူအညီ" ကနေ တောင်းထားတာတွေပါ။ Provider order ID ကို copy ကူးပြီး provider ရဲ့ support chat မှာ ပို့ပါ၊ ပြီးရင် "ဆောင်ရွက်ပြီး" နှိပ်ပါ။ User ဆီ အလိုအလျောက် အကြောင်းကြားပါမယ်။'), chips, list);
    drawChips();
    async function load() {
      let r; try { r = await GET(`/help?status=${status}&page=${page}`); } catch (e) { return fail(e); }
      list.replaceChildren();
      if (!r.items.length) list.appendChild(empty(status === 'open' ? '🎉 စောင့်ဆိုင်းနေတာ မရှိပါ' : 'မှတ်တမ်း မရှိပါ'));
      r.items.forEach(x => {
        const msgText = `Order ${x.providerOrderId} ${x.type === 'refill' ? 'refill please' : x.type === 'speed' ? 'speed up please' : 'cancel please'}`;
        list.appendChild(h('div', { class: 'card' },
          h('div', { class: 'row nowrap' }, h('strong', { class: 'grow' }, TYPE[x.type] || x.type), x.auto ? h('span', { class: 'pill ok' }, 'API ပို့ပြီး') : h('span', { class: 'pill warn' }, 'Manual'), h('span', { class: 'muted small' }, ago(x.createdAt))),
          h('div', { style: 'height:8px' }),
          kv([
            ['User', h('button', { class: 'link', onclick: () => openUser(x.userId) }, `${x.userName} (${x.userId})`)],
            ['Order ID', h('span', { class: 'row', style: 'justify-content:flex-end' }, h('strong', { class: 'mono' }, x.orderNo || '-'), x.orderNo ? copyBtn(x.orderNo) : null)],
            ['Provider order', h('span', { class: 'row', style: 'justify-content:flex-end' }, h('span', { class: 'mono' }, `${x.provider} ${x.providerOrderId}`), copyBtn(x.providerOrderId))],
            ['Service', x.label || '-'], ['Qty / Status', `${fmt(x.quantity)} · ${x.orderStatus}`],
            ['Link', h('span', {}, x.link ? shortLink(x.link) : '-', ' ', x.link ? copyBtn(x.link) : null)],
            x.result ? ['မှတ်ချက်', x.result] : null
          ]),
          h('div', { class: 'row', style: 'margin-top:12px' },
            copyBtn(msgText, 'Support စာ copy'),
            status === 'open' ? h('button', { class: 'btn ok grow', onclick: (e) => busy(e.target, async () => { await POST(`/help/${x.id}/done`, {}); toast('ပြီးပြီ၊ User ကို အကြောင်းကြားပြီး', 'ok'); load(); pollAlerts(); }) }, '✅ ဆောင်ရွက်ပြီး') : null,
            status === 'open' ? h('button', { class: 'btn', onclick: async (e) => { const v = await promptBox('User ဆီ စာနဲ့ အကြောင်းကြားမည်', 'ပို့မည့်စာ', { textarea: true, okLabel: 'ပို့ပြီး ပြီးစီးမည်' }); if (v) busy(e.target, async () => { await POST(`/help/${x.id}/done`, { message: v }); toast('ပို့ပြီး', 'ok'); load(); pollAlerts(); }); } }, '✉️ စာနဲ့') : null,
            h('button', { class: 'btn danger', onclick: async (e) => { if (await confirmBox('ဖျက်မည်', 'ဒီ request ကို ဖျက်မလား?', 'ဖျက်မည်', true)) busy(e.target, async () => { await DEL('/help/' + x.id); load(); }); } }, '🗑'))));
      });
      const p = pager(r, n => { page = n; load(); }); if (p) list.appendChild(p);
    }
    const shortLink = (l) => (l.length > 38 ? l.slice(0, 38) + '…' : l);
    load();
    every(20000, load);
  }


  // ==================================================================
  // PAGE: AI Bot
  // ==================================================================
  async function pageAI(view) {
    let d;
    try { d = await GET('/ai'); } catch (e) { return fail(e); }
    const S = d.settings;
    const sw = (checked) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked }), h('i'));
    const saveS = async (values) => { await POST('/ai/settings', { values }); toast('သိမ်းပြီး ✅', 'ok'); };

    // --- on/off + limit
    const onSw = sw(S.ai_enabled !== '0'), limSw = sw(S.ai_limit_enabled !== '0');
    const limN = h('input', { type: 'number', min: 1, value: S.ai_limit_per_day, inputmode: 'numeric' });
    const stats = h('div', { class: 'small muted' }, `ဒီနေ့ AI ကို မေးသူ ${fmt(d.stats.usersToday)} ယောက် · မေးခွန်း ${fmt(d.stats.questionsToday)} ခု`);
    view.append(h('div', { class: 'card' }, h('h2', {}, '🤖 AI အကူ'),
      h('div', { class: 'stack' },
        h('label', { class: 'row nowrap' }, onSw, h('div', { class: 'grow' }, h('strong', {}, 'AI အကူ ဖွင့်မည်'), h('div', { class: 'muted small' }, 'Menu ခလုတ်မဟုတ်တဲ့ စာတွေ (မေးခွန်းတွေ) ကို AI က လူလို ပြန်ဖြေပေးမည်'))),
        h('label', { class: 'row nowrap' }, limSw, h('div', { class: 'grow' }, h('strong', {}, 'နေ့စဉ် မေးခွန်း Limit သုံးမည်'), h('div', { class: 'muted small' }, 'ပိတ်ထားရင် အကန့်အသတ်မရှိ (API key quota ကုန်မှာ သတိထားပါ)'))),
        h('label', { class: 'f' }, h('span', {}, 'User တစ်ယောက် တစ်ရက်လျှင် မေးခွင့် အကြိမ်ရေ'), limN),
        stats,
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveS({ ai_enabled: onSw.firstChild.checked ? '1' : '0', ai_limit_enabled: limSw.firstChild.checked ? '1' : '0', ai_limit_per_day: limN.value })) }, 'သိမ်းမည်'))));
    view.append(h('div', { style: 'height:12px' }));

    // --- keys
    const keysBox = h('div', { class: 'card' });
    view.append(keysBox, h('div', { style: 'height:12px' }));
    const statusPill = (k) => k.status === 'active' ? h('span', { class: 'pill ok' }, 'Active') : k.status === 'limit' ? h('span', { class: 'pill warn' }, 'Limit ပြည့်') : h('span', { class: 'pill' }, 'ပိတ်ထား');
    function drawKeys() {
      keysBox.replaceChildren(
        h('div', { class: 'row nowrap' }, h('h2', { class: 'grow', style: 'margin:0' }, '🔑 API Keys'), h('button', { class: 'btn primary sm', onclick: () => keyForm() }, '➕ Add API Key')),
        h('div', { class: 'muted small', style: 'margin:6px 0 10px' }, 'Key တွေကို encrypt လုပ်ပြီးသိမ်းပါတယ်၊ ဒီစာမျက်နှာမှာတောင် အပြည့်ပြန်မပြပါ။ Key တစ်ခု limit ပြည့်ရင် နောက် key တစ်ခုကို user မသိအောင် အလိုအလျောက် ပြောင်းသုံးပါမယ်။'),
        d.keys.length ? h('div', { class: 'list' }, d.keys.map(k => h('div', { class: 'item' },
          h('div', { class: 'row nowrap' },
            h('div', { class: 'grow' }, h('strong', {}, k.provider === 'gemini' ? 'Gemini' : 'Groq'), ' ', h('span', { class: 'mono muted' }, k.masked), k.label ? h('span', { class: 'muted' }, ' · ' + k.label) : null),
            statusPill(k)),
          h('div', { class: 'small muted' }, `ဒီနေ့ ${fmt(k.today)} ကြိမ် · စုစုပေါင်း ${fmt(k.total)}` + (k.status === 'limit' && k.until ? ` · ${new Date(k.until).toLocaleTimeString()} ထိ နားမည်` : '')),
          k.lastError ? h('div', { class: 'small', style: 'color:var(--bad)' }, 'Error: ' + k.lastError) : null,
          h('div', { class: 'row', style: 'margin-top:6px' },
            h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => { const r = await POST(`/ai/keys/${k.id}/test`); r.ok ? toast('အလုပ်လုပ်သည် ✅ ' + r.reply, 'ok') : toast('မရပါ: ' + r.error, 'err'); reload(); }) }, '🧪 Test'),
            k.status === 'limit' ? h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => { await POST(`/ai/keys/${k.id}/reset`); reload(); }) }, '♻️ Reset') : null,
            h('button', { class: 'btn sm', onclick: () => keyForm(k) }, '✏️ Edit'),
            h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Key ဖျက်မည်', `${k.provider} ${k.masked} ကို ဖျက်မှာ သေချာပါသလား?`, 'ဖျက်မည်', true)) { try { await DEL('/ai/keys/' + k.id); reload(); } catch (e) { fail(e); } } } }, '🗑️ Remove'))))) : empty('API key မရှိသေးပါ — Add API Key နှိပ်ပါ'));
    }
    async function reload() { try { d = await GET('/ai'); drawKeys(); } catch (e) { fail(e); } }
    function keyForm(k) {
      const prov = h('select', {}, h('option', { value: 'gemini' }, 'Gemini'), h('option', { value: 'groq' }, 'Groq'));
      if (k) { prov.value = k.provider; prov.disabled = true; }
      const key = h('input', { type: 'text', placeholder: k ? 'Key အသစ်ထည့်မှ ပြောင်းမည် (မထည့်ရင် မပြောင်း)' : 'API Key ကို ဒီမှာ paste လုပ်ပါ', autocomplete: 'off', spellcheck: false });
      const label = h('input', { type: 'text', placeholder: 'နာမည်ပေးချင်ရင် (မထည့်လည်းရ)', maxlength: 40, value: k ? k.label : '' });
      const act = k ? sw(k.isActive) : null;
      const m = modal(k ? 'Key ပြင်မည်' : 'API Key ထည့်မည်', h('div', { class: 'stack' },
        field('Provider', prov), field('API Key', key), field('Label', label),
        act ? h('label', { class: 'row nowrap' }, act, h('span', {}, 'ဒီ key ကို သုံးမည်')) : null,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn', onclick: () => m.close() }, 'မလုပ်တော့ပါ'),
          h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
            if (k) await PATCH('/ai/keys/' + k.id, { label: label.value, isActive: act.firstChild.checked, key: key.value.trim() || undefined });
            else await POST('/ai/keys', { provider: prov.value, key: key.value, label: label.value });
            toast('သိမ်းပြီး ✅', 'ok'); m.close(); reload();
          }) }, 'Save'))));
    }
    drawKeys();

    // --- model + tuning
    const mG = h('input', { type: 'text', value: S.ai_model_gemini, spellcheck: false });
    const mQ = h('input', { type: 'text', value: S.ai_model_groq, spellcheck: false });
    const temp = h('input', { type: 'number', step: '0.1', min: 0, max: 2, value: S.ai_temperature, inputmode: 'decimal' });
    const mt = h('input', { type: 'number', min: 64, max: 8192, value: S.ai_max_tokens, inputmode: 'numeric' });
    const mem = h('input', { type: 'number', min: 0, max: 20, value: S.ai_history_turns, inputmode: 'numeric' });
    view.append(h('div', { class: 'card' }, h('h2', {}, '⚙️ Model & ပုံစံ'), h('div', { class: 'stack' },
      field('Gemini model ID (3.x သို့မဟုတ် အသစ်ဆုံး ID အတိအကျ ထည့်ပါ)', mG),
      field('Groq model ID', mQ),
      field('Temperature (0–2၊ များရင် ပိုလူဆန်/ပိုကွဲ)', temp),
      field('အဖြေ အရှည်ဆုံး (tokens)', mt),
      field('ယခင်စကားပြောကို ဘယ်နှခွန်း မှတ်ထားမလဲ (0–20)', mem),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveS({ ai_model_gemini: mG.value, ai_model_groq: mQ.value, ai_temperature: temp.value, ai_max_tokens: mt.value, ai_history_turns: mem.value })) }, 'သိမ်းမည်'))));
    view.append(h('div', { style: 'height:12px' }));

    // --- prompt & messages
    const sp = h('textarea', { style: 'min-height:320px', value: S.ai_system_prompt });
    const kn = h('textarea', { style: 'min-height:140px', placeholder: 'ဥပမာ -\nဆိုင်အမည်: ...\nAdmin ဆက်သွယ်ရန်: @username\nAdmin အလုပ်ချိန်: မနက် ၉ နာရီ - ည ၁၀ နာရီ\nငွေဖြည့်ကြာချိန်: ၅-၁၅ မိနစ်ခန့်\nRefill: ရက် ၃၀ အာမခံ (Refill ပါတဲ့ service များသာ)\nဈေးအကြမ်းဖျင်း: TikTok follower ၁၀၀၀ = ... ကျပ်\n\n(KPay/Wave နံပါတ်၊ အနည်းဆုံးငွေဖြည့်ပမာဏ၊ Contact Admin ခလုတ်ကို bot က အလိုအလျောက် သိပြီးသားမို့ ထပ်မရေးလည်းရ)', value: S.ai_knowledge });
    const lm = h('textarea', { value: S.ai_limit_msg });
    const fb = h('textarea', { value: S.ai_fallback });
    const resetBtn = (key, ta) => h('button', { class: 'btn sm', onclick: async (e) => { if (await confirmBox('မူလအတိုင်း ပြန်ထားမည်', 'ပြင်ထားတာတွေ ပျောက်မယ်။ သေချာပါသလား?', 'ပြန်ထားမည်')) busy(e.target, async () => { const r = await POST('/ai/settings/reset', { key }); ta.value = r.value; toast('မူလအတိုင်း ပြန်ထားပြီး', 'ok'); }); } }, '↩️ မူလအတိုင်း');
    view.append(h('div', { class: 'card' }, h('h2', {}, '🧠 AI ကို ပေးထားတဲ့ ညွှန်ကြားချက် (System Prompt)'),
      h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'AI ဘယ်လိုစကားပြောရမလဲ၊ ဘာတွေ မလုပ်ရဘူးလဲ ဒီမှာ ပြင်ပါ။ ${name} = customer နာမည်၊ ${balance} = လက်ကျန်ငွေ ပေါ်လာမည်။'),
      h('div', { class: 'stack' }, sp, h('div', { class: 'row' }, resetBtn('ai_system_prompt', sp)),
        h('label', { class: 'f' }, h('span', {}, '📚 ဆိုင်အကြောင်း အချက်အလက် (Knowledge)'), kn),
        h('label', { class: 'f' }, h('span', {}, 'Limit ပြည့်သွားရင် ပြမည့်စာ'), lm, resetBtn('ai_limit_msg', lm)),
        h('label', { class: 'f' }, h('span', {}, 'AI အလုပ်မလုပ်တော့ရင် (key အကုန်ကုန်/error) ပြမည့်စာ'), fb, resetBtn('ai_fallback', fb)),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => saveS({ ai_system_prompt: sp.value, ai_knowledge: kn.value, ai_limit_msg: lm.value, ai_fallback: fb.value })) }, 'သိမ်းမည်'))));
    view.append(h('div', { style: 'height:12px' }));

    // --- test chat
    const log = h('div', { class: 'stack', style: 'min-height:60px;margin-bottom:8px' });
    const msg = h('input', { type: 'text', placeholder: 'customer လို မေးကြည့်ပါ...', maxlength: 500 });
    const hist = [];
    const bubble = (who, t, err) => h('div', { class: 'item', style: `${who === 'user' ? 'margin-left:24px' : 'margin-right:24px'};${err ? 'color:var(--bad)' : ''}`, 'data-who': who }, t);
    async function send(btn) {
      const t = msg.value.trim(); if (!t) return;
      msg.value = ''; log.appendChild(bubble('user', t));
      await busy(btn, async () => {
        const r = await POST('/ai/test', { message: t, history: hist.slice() });
        if (r.ok) { hist.push({ role: 'user', text: t }, { role: 'assistant', text: r.reply }); log.appendChild(bubble('bot', r.reply)); }
        else log.appendChild(bubble('bot', 'မရပါ: ' + r.error, true));
        reload();
      });
    }
    const sendBtn = h('button', { class: 'btn primary', onclick: (e) => send(e.target) }, 'ပို့');
    msg.addEventListener('keydown', e => { if (e.key === 'Enter') send(sendBtn); });
    view.append(h('div', { class: 'card' }, h('h2', {}, '💬 စမ်းပြောကြည့်ရန်'), h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'သိမ်းထားပြီးသား prompt နဲ့ key တွေကို သုံးပြီး customer မေးသလို စမ်းမေးနိုင်ပါတယ် (နေ့စဉ် limit မပါပါ)။'), log, h('div', { class: 'row nowrap' }, h('div', { class: 'grow' }, msg), sendBtn)));

    // --- customer <-> AI conversations (read-only, auto-deleted by the server)
    const chatBox = h('div', {});
    const chatList = h('div', {});
    const qBox = h('input', { type: 'text', placeholder: 'ID / နာမည် / @username ရှာရန်...', autocomplete: 'off' });
    let chatPage = 1, chatQ = '', chatSort = 'count';
    const sortSel = h('select', {}, h('option', { value: 'count' }, '🔥 အများဆုံးပြောတဲ့သူ အပေါ်ဆုံး'), h('option', { value: 'recent' }, '🕒 နောက်ဆုံးပြောတဲ့သူ အပေါ်ဆုံး'));
    sortSel.addEventListener('change', () => { chatSort = sortSel.value; chatPage = 1; loadChats(); });
    async function openChat(u) {
      let r; try { r = await GET('/ai/chats/' + encodeURIComponent(u.userId)); } catch (e) { return fail(e); }
      const body = h('div', { class: 'stack', style: 'max-height:65vh;overflow:auto' },
        r.items.length ? r.items.map(m => h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'muted small' }, dt(m.createdAt) + (m.provider ? ' · ' + m.provider : '') + (m.blocked ? ' · 🚫 blocked' : '')),
          h('div', { class: 'item', style: 'margin-left:24px;white-space:pre-wrap;word-break:break-word' }, '👤 ' + (m.question || '')),
          h('div', { class: 'item', style: 'margin-right:24px;white-space:pre-wrap;word-break:break-word' }, '🤖 ' + (m.reply || '')))) : empty('စကားဝိုင်း မရှိတော့ပါ'));
      const m = modal(`${u.name || 'User'} ${u.username ? '@' + u.username : ''} (${u.userId}) · ${fmt(u.count)} ကြိမ်`, h('div', { class: 'stack' }, body,
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', { class: 'muted small' }, `ဒီ user ရဲ့ chat ကို ${r.days} ရက်ကျော်ရင် အလိုအလျောက်ဖျက်မည်`),
          h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => openUser(u.userId) }, '👤 User'),
            h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Chat ဖျက်မည်', 'ဒီ user ရဲ့ AI chat အားလုံး ဖျက်မလား?', 'ဖျက်မည်', true)) { try { await DEL('/ai/chats/' + encodeURIComponent(u.userId)); m.close(); loadChats(); } catch (e) { fail(e); } } } }, '🗑 ဖျက်မည်')))), { wide: true });
    }
    async function loadChats() {
      let r; try { r = await GET(`/ai/chats?page=${chatPage}&sort=${chatSort}&q=${encodeURIComponent(chatQ)}`); } catch (e) { return fail(e); }
      if (!r.enabled) { chatList.replaceChildren(empty('AI chat log ပိတ်ထားသည် — Render env ထဲမှာ MONGODB_URI_AI ထည့်ပါ')); return; }
      chatList.replaceChildren(r.items.length ? h('div', { class: 'list' }, r.items.map(u =>
        h('button', { class: 'item row nowrap', style: 'text-align:left;width:100%', onclick: () => openChat(u) },
          h('div', { class: 'grow' }, h('strong', {}, u.name || 'User'), ' ', h('span', { class: 'muted small' }, (u.username ? '@' + u.username + ' · ' : '') + u.userId),
            h('div', { class: 'muted small' }, u.lastQuestion)),
          h('div', { class: 'muted small', style: 'text-align:right;white-space:nowrap' }, h('strong', {}, `${fmt(u.count)} ကြိမ်`), h('br'), `ဒီနေ့ ${fmt(u.today)}`, h('br'), ago(u.last))))) : empty('Chat မရှိသေးပါ'));
      const p = pager(r, n => { chatPage = n; loadChats(); }); if (p) chatList.appendChild(p);
      chatBox.querySelector('.chat-note').textContent = `User ${fmt(r.total)} ယောက် · ${r.days} ရက်ကျော်တာတွေကို အလိုအလျောက်ဖျက်သည်`;
    }
    qBox.addEventListener('keydown', e => { if (e.key === 'Enter') { chatQ = qBox.value.trim(); chatPage = 1; loadChats(); } });
    chatBox.append(h('h2', {}, '🗂 Customer နဲ့ AI ပြောထားတာများ'), h('div', { class: 'muted small chat-note', style: 'margin-bottom:8px' }), h('div', { class: 'stack' }, qBox, sortSel, chatList));
    view.append(h('div', { style: 'height:12px' }), h('div', { class: 'card' }, chatBox));
    loadChats();
  }

  // ==================================================================
  // PAGE: Coupons
  // ==================================================================
  async function pageCoupons(view) {
    const amount = h('input', { type: 'number', placeholder: 'တန်ဖိုး (ကျပ်)', inputmode: 'numeric' });
    const count = h('input', { type: 'number', placeholder: 'သုံးခွင့်ရမည့် လူအရေအတွက်', inputmode: 'numeric' });
    const code = h('input', { type: 'text', placeholder: 'Code (မထည့်ရင် random)', maxlength: 30 });
    const list = h('div', {});
    view.append(h('div', { class: 'card' }, h('h2', {}, 'Coupon အသစ်ထုတ်ရန်'), h('div', { class: 'stack' }, amount, count, code,
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { const r = await POST('/coupons', { amount: amount.value, count: count.value, code: code.value }); toast('ထုတ်ပြီး: ' + r.code, 'ok'); amount.value = count.value = code.value = ''; load(); }) }, 'ထုတ်မည်'))),
      h('div', { style: 'height:12px' }), list);
    async function load() {
      let r; try { r = await GET('/coupons'); } catch (e) { return fail(e); }
      list.replaceChildren(r.items.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, r.items.map(c =>
        h('div', { class: 'item row nowrap' },
          h('div', { class: 'grow' }, h('strong', { class: 'mono' }, c.code), h('div', { class: 'muted small' }, `${fmt(c.amount)} ကျပ် · သုံးပြီး ${c.used} · ကျန် ${c.remaining}`)),
          h('button', { class: 'btn sm', onclick: () => navigator.clipboard && navigator.clipboard.writeText(c.code).then(() => toast('Copy ပြီး', 'ok')) }, 'Copy'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Coupon ဖျက်မည်', c.code, 'ဖျက်မည်', true)) { try { await DEL('/coupons/' + encodeURIComponent(c.code)); load(); } catch (e) { fail(e); } } } }, '🗑'))))) : empty('Coupon မရှိသေးပါ'));
    }
    load();
  }

  // ==================================================================
  // PAGE: Broadcast
  // ==================================================================
  function pageBroadcast(view) {
    const text = h('textarea', { placeholder: 'User အားလုံးဆီ ပို့မည့် စာ...', style: 'min-height:160px', maxlength: 3500 });
    const skip = h('input', { type: 'checkbox', checked: true });
    view.append(h('div', { class: 'card' }, h('h2', {}, 'User အားလုံးဆီ စာပို့ရန်'), h('div', { class: 'stack' }, text,
      h('label', { class: 'row' }, skip, 'Ban ထားသူများကို မပို့ပါနှင့်'),
      h('div', { class: 'muted small' }, 'နောက်ကွယ်ကနေ တဖြည်းဖြည်း ပို့ပါမယ် (Telegram limit မထိအောင်)။ ပြီးရင် Telegram ထဲ အစီရင်ခံစာ ပြန်ပို့ပေးပါမယ်။ တစ်ဦးချင်းပို့လိုရင် Users page ထဲက user ကိုနှိပ်ပါ။'),
      h('button', { class: 'btn primary', onclick: async (e) => {
        if (!text.value.trim()) return;
        if (!(await confirmBox('Broadcast ပို့မည်', 'User အားလုံးဆီ ဒီစာ ပို့မှာ သေချာပါသလား?', 'ပို့မည်'))) return;
        busy(e.target, async () => { const r = await POST('/broadcast', { text: text.value, skipBanned: skip.checked }); toast(`${fmt(r.recipients)} ယောက်ဆီ ပို့စပြီ` + (r.skipped ? ` (bot block ထားသူ ${fmt(r.skipped)} ယောက် ကျော်)` : ''), 'ok'); text.value = ''; });
      } }, '📣 ပို့မည်'))));
    // one customer only
    const uid = h('input', { type: 'text', placeholder: 'User ID (Telegram ID) - Users စာမျက်နှာမှာ ကြည့်ပါ', inputmode: 'numeric', autocomplete: 'off' });
    const one = h('textarea', { placeholder: 'ဒီ user တစ်ယောက်တည်းဆီ ပို့မည့် စာ...', style: 'min-height:110px', maxlength: 3500 });
    view.append(h('div', { style: 'height:12px' }), h('div', { class: 'card' }, h('h2', {}, 'User တစ်ယောက်ချင်းကို ပို့ရန်'), h('div', { class: 'stack' }, uid, one,
      h('button', { class: 'btn primary', onclick: (e) => { const id = uid.value.replace(/\D/g, ''); if (!id || !one.value.trim()) return toast('User ID နဲ့ စာ ထည့်ပါ', 'err'); busy(e.target, async () => { await POST(`/users/${id}/message`, { text: one.value }); toast('ပို့ပြီး ✅', 'ok'); one.value = ''; }); } }, '✉️ ပို့မည်'),
      h('div', { class: 'muted small' }, 'Bot ကို block/ဖျက်ထားတဲ့ user ဆိုရင် "ပို့မရပါ" လို့ ပြပါမယ် (panel မပျက်ပါ)။ Users စာမျက်နှာထဲက user ကို နှိပ်ပြီးလည်း ပို့လို့ရပါတယ်။'))));
  }

  // ==================================================================
  // PAGE: Settings
  // ==================================================================
  async function pageSettings(view) {
    let s;
    try { s = await GET('/settings'); } catch (e) { return fail(e); }
    let tab = 'pricing';
    const body = h('div', { class: 'stack' });
    const chips = h('div', { class: 'chips', style: 'margin-bottom:12px' });
    function draw() {
      chips.replaceChildren(...[['pricing', 'ဈေးနှုန်း'], ['payment', 'ငွေလက်ခံ'], ['features', 'Help & Data'], ['messages', 'Bot စာသားများ'], ['menu', 'Menu buttons']].map(([k, l]) => h('button', { class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { tab = k; draw(); } }, l)));
      body.replaceChildren();
      ({ pricing: tabPricing, payment: tabPayment, features: tabFeatures, messages: tabMessages, menu: tabMenu })[tab]();
    }
    async function save(values) { await POST('/settings', { values }); toast('သိမ်းပြီး ✅', 'ok'); }

    function tabPricing() {
      body.appendChild(h('div', { class: 'muted small' }, 'ရောင်းဈေး = Provider ရဲ့ USD ဈေး × USD→MMK rate × Markup (နောက်ထပ် Order တွေကစပြီး ချက်ချင်း သက်ရောက်ပါမယ်)'));
      for (const [p, v] of Object.entries(s.pricing)) {
        const rate = h('input', { type: 'number', value: v.usd_to_mmk, step: 'any', inputmode: 'decimal' });
        const mk = h('input', { type: 'number', value: v.markup, step: 'any', inputmode: 'decimal' });
        const preview = h('div', { class: 'small muted' });
        const upd = () => { const r = Number(rate.value), m = Number(mk.value); preview.textContent = r > 0 && m > 0 ? `ဥပမာ: Provider $1 → User ဆီ ${fmt(Math.ceil(r * m))} ကျပ် (Provider ကုန်ကျ ${fmt(Math.ceil(r))} ကျပ်၊ အမြတ် ${fmt(Math.ceil(r * m - r))})` : ''; };
        rate.oninput = mk.oninput = upd; upd();
        // helper: copy the price the PROVIDER'S OWN website shows for one order -> we work out the USD->MMK rate it uses
        const hs = h('input', { type: 'text', placeholder: 'Service ID (provider ရဲ့)', inputmode: 'numeric' });
        const hq = h('input', { type: 'number', placeholder: 'အရေအတွက် (ဥပမာ 300)', inputmode: 'numeric' });
        const hp = h('input', { type: 'number', placeholder: 'Provider website မှာ ပြတဲ့ ကျသင့်ငွေ (ဥပမာ 357.2)', step: 'any', inputmode: 'decimal' });
        const hres = h('div', { class: 'small' });
        const helper = h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer;margin-top:8px' }, '🧮 Provider website နဲ့ ဈေးမကိုက်ရင် - rate ကို အလိုအလျောက်တွက်ရန်'),
          h('div', { class: 'stack', style: 'margin-top:8px' },
            h('div', { class: 'muted small' }, `${p} website မှာ service တစ်ခုကို အရေအတွက်ထည့်ကြည့်ရင် "ကျသင့်ငွေ" ပြပါတယ်။ အဲဒီဂဏန်းကို ထည့်ပါ၊ website က သုံးတဲ့ USD→MMK rate ကို တွက်ပေးပါမယ်။`), hs, hq, hp,
            h('button', { class: 'btn', onclick: (e) => busy(e.target, async () => {
              const r = await GET(`/pricing/implied-rate?provider=${p}&service=${encodeURIComponent(hs.value)}&qty=${encodeURIComponent(hq.value)}&shown=${encodeURIComponent(hp.value)}`);
              hres.replaceChildren(h('div', {}, `${r.name}: $${r.usdPer1000}/1000 → ${hq.value} ခုမှာ $${r.usdForQty.toFixed(4)}`), h('div', {}, h('strong', {}, `Website rate ≈ ${r.implied.toFixed(2)} ကျပ်/ $1`)),
                h('button', { class: 'btn sm primary', style: 'margin-top:6px', onclick: () => { rate.value = String(r.rounded); upd(); toast(`Rate ကို ${r.rounded} ထည့်ပြီး - အပေါ်က "သိမ်းမည်" ကို နှိပ်ပါ`, 'ok'); } }, `${r.rounded} ကို သုံးမည်`));
            }) }, 'တွက်မည်'), hres));
        body.appendChild(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, p), v.configured ? h('span', { class: 'pill ok' }, 'API ချိတ်ပြီး') : h('span', { class: 'pill warn' }, 'API မချိတ်ရသေး')),
          h('div', { class: 'stack', style: 'margin-top:10px' }, field('$1 = ဘယ်လောက်ကျပ် (USD→MMK)', rate), field('Markup (ဆ) ဥပမာ 2.3', mk), preview,
            h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => save({ [`${p}_usd_to_mmk`]: rate.value, [`${p}_markup`]: mk.value })) }, 'သိမ်းမည်'), helper)));
      }
    }
    function tabPayment() {
      const keys = [['kpay_number', 'KPay ဖုန်းနံပါတ်'], ['kpay_name', 'KPay နာမည်'], ['wave_number', 'Wave ဖုန်းနံပါတ်'], ['wave_name', 'Wave နာမည်'], ['topup_min_amount', 'ငွေဖြည့် အနည်းဆုံး (ကျပ်)'], ['low_balance_threshold', 'Provider လက်ကျန် ဒီထက်နည်းရင် သတိပေး (USD, 0 = ပိတ်)']];
      const inputs = Object.fromEntries(keys.map(([k]) => [k, h('input', { type: 'text', value: s.payment[k] })]));
      body.appendChild(h('div', { class: 'card' }, h('div', { class: 'stack' }, keys.map(([k, l]) => field(l, inputs[k])),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => save(Object.fromEntries(keys.map(([k]) => [k, inputs[k].value])))) }, 'သိမ်းမည်'))));
    }
    async function tabFeatures() {
      const f = s.features;
      const sw = (checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange }), h('i'));
      const helpSw = sw(f.help_enabled !== '0', async () => { try { await save({ help_enabled: helpSw.firstChild.checked ? '1' : '0' }); toast(helpSw.firstChild.checked ? 'Help Order ဖွင့်ပြီး (user တွေ မြင်ရမည်)' : 'Help Order ပိတ်ပြီး (user တွေ မမြင်ရတော့)', 'ok'); } catch (e) { helpSw.firstChild.checked = !helpSw.firstChild.checked; fail(e); } });
      body.appendChild(h('div', { class: 'card' }, h('div', { class: 'row nowrap' }, h('div', { class: 'grow' }, h('h2', { style: 'margin:0' }, '🆘 Order အကူအညီ (Help Order)'), h('div', { class: 'muted small' }, 'ပိတ်ထားရင် user တွေရဲ့ main menu ထဲမှာ ခလုတ် မပေါ်ပါ၊ ဖွင့်ရင် ပေါ်ပါမယ်')), helpSw)));

      const autoSw = sw(f.history_auto !== '0', () => {});
      const days = h('input', { type: 'number', value: f.history_keep_days, min: 1, max: 365, inputmode: 'numeric' });
      const last = h('input', { type: 'number', value: f.history_keep_last, min: 0, max: 365, inputmode: 'numeric' });
      const info = h('div', { class: 'small muted' }, 'Loading...');
      const result = h('div', { class: 'small' });
      body.appendChild(h('div', { class: 'card' }, h('h2', {}, '🧹 History ရှင်းလင်းခြင်း (MongoDB နေရာမပြည့်အောင်)'),
        h('div', { class: 'muted small' }, 'ပြီးဆုံးပြီးသား (completed/canceled/partial) order တွေကိုသာ ရှင်းပါမယ်။ လုပ်ဆောင်နေဆဲ order တွေကို လုံးဝ မထိပါ။ ရှင်းလိုက်တဲ့ order တွေရဲ့ ရောင်းရငွေ/အမြတ် စာရင်းကိုတော့ Dashboard မှာ ဆက်မှတ်ထားပါမယ်။'),
        h('div', { style: 'height:10px' }), info, h('div', { style: 'height:10px' }),
        h('div', { class: 'stack' },
          h('label', { class: 'row nowrap' }, autoSw, h('span', {}, 'နေ့စဉ် အလိုအလျောက် ရှင်းမည်')),
          field('ဘယ်နှရက်ထက် ကျော်တဲ့ order တွေကို ရှင်းမလဲ', days),
          field('User တစ်ယောက်စီရဲ့ နောက်ဆုံး order ဘယ်နှခုကို အမြဲချန်ထားမလဲ', last),
          h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await save({ history_auto: autoSw.firstChild.checked ? '1' : '0', history_keep_days: days.value, history_keep_last: last.value }); loadInfo(); }) }, 'သိမ်းမည်'),
          h('div', { class: 'row' },
            h('button', { class: 'btn grow', onclick: (e) => busy(e.target, async () => { const r = await POST('/data/cleanup', { dryRun: true }); result.textContent = `ကြိုကြည့်: Order ${fmt(r.orders)} ခု၊ ငွေဖြည့်မှတ်တမ်း ${fmt(r.deposits)}၊ help ${fmt(r.help)}၊ log ${fmt(r.logs)} ကို ရှင်းမည်ဖြစ်သည်`; }) }, '👁 ဘာတွေ ရှင်းမလဲ ကြိုကြည့်'),
            h('button', { class: 'btn danger grow', onclick: async (e) => { if (await confirmBox('ယခု ရှင်းမည်', 'သိမ်းထားတဲ့ ဆက်တင်အတိုင်း အဟောင်းတွေကို ဖျက်မှာ သေချာပါသလား? (ပြန်မရပါ)', 'ရှင်းမည်', true)) busy(e.target, async () => { const r = await POST('/data/cleanup', { dryRun: false }); result.textContent = `ရှင်းပြီး: Order ${fmt(r.orders)} ခု၊ ငွေဖြည့်မှတ်တမ်း ${fmt(r.deposits)}၊ help ${fmt(r.help)}၊ log ${fmt(r.logs)}`; toast('ရှင်းပြီး ✅', 'ok'); loadInfo(); }); } }, '🧹 ယခုရှင်းမည်')),
          result)));
      async function loadInfo() {
        try {
          const d = await GET('/data');
          info.replaceChildren(...[
            h('div', {}, `Orders ${fmt(d.counts.orders)} · Users ${fmt(d.counts.users)} · ငွေဖြည့် ${fmt(d.counts.deposits)} · Help ${fmt(d.counts.help)} · Log ${fmt(d.counts.logs)}`),
            d.storage ? h('div', {}, `Database အသုံးပြုမှု: ${d.storage.storageMB} MB / ${d.storage.limitMB} MB (free plan)`) : null,
            h('div', {}, 'နောက်ဆုံး ရှင်းခဲ့တာ: ' + (d.lastCleanup ? dt(d.lastCleanup) : 'မရှင်းရသေးပါ'))].filter(Boolean));
        } catch (e) { info.textContent = e.message; }
      }
      loadInfo();
    }
    function tabMessages() {
      body.appendChild(h('div', { class: 'muted small' }, '${name} ${balance} စတဲ့ placeholder တွေကို မဖျက်ပါနဲ့ - ဒါမှ user နာမည်/ငွေပမာဏ အစားထိုးပေးနိုင်မှာပါ။'));
      for (const m of s.messages) {
        const ta = h('textarea', { value: m.value, style: 'min-height:72px' });
        body.appendChild(h('div', { class: 'card' },
          h('div', { class: 'row' }, h('strong', { class: 'grow mono' }, m.key), m.isDefault ? null : h('span', { class: 'pill acc' }, 'ပြင်ထား')),
          m.placeholders.length ? h('div', { class: 'small muted' }, 'Placeholders: ' + m.placeholders.join('  ')) : null, h('div', { style: 'height:6px' }), ta,
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'btn sm primary', onclick: (e) => busy(e.target, async () => { await save({ [m.key]: ta.value }); m.value = ta.value; m.isDefault = false; }) }, 'သိမ်းမည်'),
            h('button', { class: 'btn sm', onclick: (e) => busy(e.target, async () => { const r = await POST('/settings/reset', { key: m.key }); ta.value = r.value; m.value = r.value; m.isDefault = true; toast('မူလအတိုင်း ပြန်ထားပြီး', 'ok'); }) }, 'မူလအတိုင်း'))));
      }
    }
    function tabMenu() {
      const label = h('input', { type: 'text', placeholder: '☎️ Contact Admin', maxlength: 40 });
      const url = h('input', { type: 'url', placeholder: 'https://t.me/YourUsername' });
      body.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Main menu button အသစ်'), h('div', { class: 'stack' }, field('Button စာသား', label), field('Link (user နှိပ်ရင် ဖွင့်မည့် link)', url),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => { await POST('/menu-buttons', { label: label.value, url: url.value }); toast('ထည့်ပြီး', 'ok'); s = await GET('/settings'); draw(); }) }, 'ထည့်မည်'))));
      body.appendChild(h('div', { class: 'card' }, h('h2', {}, 'ရှိပြီးသား'), s.menuButtons.length ? h('div', { class: 'list' }, s.menuButtons.map(b =>
        h('div', { class: 'item row nowrap' }, h('div', { class: 'grow' }, h('strong', {}, b.label), h('div', { class: 'muted small trunc' }, b.url)),
          h('button', { class: 'btn sm danger', onclick: (e) => busy(e.target, async () => { await POST('/menu-buttons/delete', { label: b.label }); s = await GET('/settings'); draw(); }) }, '🗑')))) : empty('မရှိသေးပါ')));
    }
    view.append(chips, body);
    draw();
  }

  // ==================================================================
  // PAGE: Logs
  // ==================================================================
  async function pageLogs(view) {
    let r; try { r = await GET('/logs'); } catch (e) { return fail(e); }
    view.appendChild(r.items.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, r.items.map(l =>
      h('div', { class: 'item small' }, h('div', { class: 'row nowrap' }, h('strong', { class: 'grow' }, l.action), h('span', { class: 'muted' }, dt(l.createdAt))), h('div', { class: 'muted' }, `Admin ${l.admin} · ${l.detail || ''}`))))) : empty('မှတ်တမ်း မရှိသေးပါ'));
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  async function boot() {
    try { state.me = await GET('/me'); } catch (_) { state.me = null; }
    renderRoot();
    if (state.me) pollAlerts();
  }
  boot();
})();

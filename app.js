/* ==========================================================================
   SplitStack — offline-first shared expense PWA
   Backend: your own Google Apps Script web app over your own Google Sheet.
   ========================================================================== */
'use strict';

/* Shown in Settings ▸ App & updates. Bump this and SW_BUILD in sw.js together
   whenever you re-upload the app. */
const APP_BUILD = '2026-08-09.6';

/* ────────────────────────────────────────────────────────────────  helpers */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uuid = () => 'txn_' + Date.now().toString(36) + '_' +
  ([...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join(''));
const ruleId = () => 'rec_' + Date.now().toString(36) + '_' +
  ([...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join(''));

/**
 * Step a YYYY-MM-DD on by one period. Mirrors addPeriod() in Code.gs, and for
 * the same reason it takes an anchor: a monthly rule starting on the 31st has
 * to become the 28th in February and then go back to the 31st in March. All
 * arithmetic is on the numbers, so no timezone can shift a day underneath it.
 */
function addPeriodISO(from, freq, every = 1, anchor = 0) {
  const [y0, m0, d0] = String(from).split('-').map(Number);
  const n = clamp(Number(every) || 1, 1, 52);
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (freq === 'weekly') {
    const t = new Date(Date.UTC(y0, m0 - 1, d0));
    t.setUTCDate(t.getUTCDate() + 7 * n);
    return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (freq === 'yearly') return fmt(y0 + n, m0, Math.min(anchor || d0, dim(y0 + n, m0)));
  let m = m0 + n;
  const y = y0 + Math.floor((m - 1) / 12);
  m = ((m - 1) % 12) + 1;
  return fmt(y, m, Math.min(anchor || d0, dim(y, m)));
}
const hexBytes = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

function money(n, withSign = false) {
  const sym = (S.config && S.config.symbol) || '$';
  const v = Math.abs(round2(n));
  const s = sym + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (withSign && round2(n) < 0) return '−' + s;
  return s;
}
function niceDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00'), now = new Date();
  const t = todayISO();
  if (iso === t) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === y.toISOString().slice(0, 10)) return 'Yesterday';
  const opt = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opt.year = 'numeric';
  return d.toLocaleDateString(undefined, opt);
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function haptic(ms = 12) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }

/* ────────────────────────────────────────────── self-configuring links */
/**
 * Every Apps Script deployment is https://script.google.com/macros/s/<ID>/exec,
 * so a link only needs to carry <ID>. That keeps shared links short and lets a
 * brand-new phone configure itself from a single tap.
 */
const b64u   = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

function backendId(url) {
  const m = /^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/.exec(url || '');
  if (m) return m[1];
  try { return url ? 'u.' + b64u(url) : ''; } catch (e) { return ''; }
}
function backendFromId(id) {
  if (!id) return '';
  if (id.slice(0, 2) === 'u.') { try { return unb64u(id.slice(2)); } catch (e) { return ''; } }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return 'https://script.google.com/macros/s/' + id + '/exec';
}
/** Where this copy of the app lives, without any hash. */
const appHome = () => location.origin + location.pathname;

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* ─────────────────────────────────────────────────────────────── confetti */
function confetti(n = 90) {
  const c = $('#confetti'), ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight; c.style.display = 'block';
  const cols = ['#6C5CE7', '#00B894', '#FF7675', '#FDCB6E', '#0984E3', '#E84393', '#00CEC9'];
  const bits = Array.from({ length: n }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 160, y: innerHeight * .45,
    vx: (Math.random() - .5) * 15, vy: -8 - Math.random() * 13,
    r: 4 + Math.random() * 7, a: Math.random() * 6.3, va: (Math.random() - .5) * .4,
    col: cols[(Math.random() * cols.length) | 0]
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, c.width, c.height);
    bits.forEach(b => {
      b.vy += .42; b.x += b.vx; b.y += b.vy; b.a += b.va; b.vx *= .995;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.col;
      ctx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 1.5); ctx.restore();
    });
    if (++frames < 150) requestAnimationFrame(tick);
    else { ctx.clearRect(0, 0, c.width, c.height); c.style.display = 'none'; }
  })();
}

/* ─────────────────────────────────────────────────────────────── IndexedDB */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('splitstack', 2);
      rq.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('txns')) {
          const s = db.createObjectStore('txns', { keyPath: 'key' });
          s.createIndex('ledger', 'ledgerId');
        }
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    async get(k) { const db = await open(); return req(db.transaction('kv').objectStore('kv').get(k)); },
    async set(k, v) { return tx('kv', 'readwrite', s => s.put(v, k)); },
    async del(k) { return tx('kv', 'readwrite', s => s.delete(k)); },
    async putTxns(ledgerId, list) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('txns', 'readwrite'), s = t.objectStore('txns');
        list.forEach(x => s.put(Object.assign({}, x, { key: ledgerId + '|' + x.id, ledgerId })));
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    },
    async allTxns(ledgerId) {
      const db = await open();
      return req(db.transaction('txns').objectStore('txns').index('ledger').getAll(ledgerId));
    },
    async dropLedger(ledgerId) {
      const list = await this.allTxns(ledgerId);
      return tx('txns', 'readwrite', s => list.forEach(x => s.delete(x.key)));
    },
    async queue(item) { return tx('outbox', 'readwrite', s => s.add(item)); },
    async outbox() { const db = await open(); return req(db.transaction('outbox').objectStore('outbox').getAll()); },
    async unqueue(seq) { return tx('outbox', 'readwrite', s => s.delete(seq)); },
    async blobGet(k) { const db = await open(); return req(db.transaction('blobs').objectStore('blobs').get(k)); },
    async blobSet(k, v) { return tx('blobs', 'readwrite', s => s.put(v, k)); },
    async wipe() {
      const db = await open();
      return new Promise(res => {
        const t = db.transaction(['kv', 'txns', 'outbox', 'blobs'], 'readwrite');
        ['kv', 'txns', 'outbox', 'blobs'].forEach(n => t.objectStore(n).clear());
        t.oncomplete = res;
      });
    }
  };
})();

/* ─────────────────────────────────────────────────────────────── crypto */
async function derive(password, saltHex, iterations) {
  if (!crypto.subtle) throw new Error('This browser needs a secure (https) connection for login.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array((saltHex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iterations || 210000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ─────────────────────────────────────────────────────────────────── state */
const LS = {
  get api() { return localStorage.getItem('ss.api') || ''; }, set api(v) { localStorage.setItem('ss.api', v); },
  get token() { return localStorage.getItem('ss.token') || ''; }, set token(v) { v ? localStorage.setItem('ss.token', v) : localStorage.removeItem('ss.token'); },
  get gate() { return localStorage.getItem('ss.gate') || ''; }, set gate(v) { v ? localStorage.setItem('ss.gate', v) : localStorage.removeItem('ss.gate'); }
};

const S = {
  api: LS.api, token: LS.token, gate: LS.gate,
  me: null, users: [], ledgers: [], members: [], recurring: [],
  config: { symbol: '$', currency: 'USD', appName: 'SplitStack' },
  cursors: {}, txns: {}, pending: {}, online: navigator.onLine,
  view: 'boot', params: {}, tab: 'feed', syncing: false, lastError: '', updateReady: false,
  searchOpen: false, search: '', reviewOnly: false, apiVersion: 0,
  filterWho: '', filterCat: '', seen: {}, seenAt: {}
};

/* The backend API this build needs. The Apps Script is pasted in by hand, so
   it can lag the PWA — which updates itself — by any amount. */
const NEEDS_API = 7;

/** A member who isn't a person: an employer, a kitty, someone not using the app. */
const isEntity = u => u && u.kind === 'entity';

/* ─────────────────────────────────────────────────────────────── paying */
/**
 * Actually moving the money was the one step in settling up the app couldn't
 * help with: you left, opened Venmo, retyped the amount, came back and logged
 * it. A handle turns that into a link with the amount already in it.
 *
 * These are all documented web endpoints rather than private URL schemes, so
 * they work on a desktop browser and hand off to the installed app on a phone,
 * instead of dead-ending on whichever half of that isn't true.
 */
const PAY_SERVICES = {
  venmo:   { label: 'Venmo',    hint: 'your-username', prefix: '@',
             url: (h, a, n) => `https://venmo.com/${encodeURIComponent(h.replace(/^@/, ''))}?txn=pay&amount=${a}&note=${encodeURIComponent(n)}` },
  paypal:  { label: 'PayPal.me', hint: 'your-name', prefix: '',
             url: (h, a) => `https://paypal.me/${encodeURIComponent(h.replace(/^@/, ''))}/${a}` },
  cashapp: { label: 'Cash App', hint: 'your-cashtag', prefix: '$',
             url: (h, a) => `https://cash.app/$${encodeURIComponent(h.replace(/^\$/, ''))}/${a}` },
  revolut: { label: 'Revolut',  hint: 'your-revtag', prefix: '@',
             url: h => `https://revolut.me/${encodeURIComponent(h.replace(/^@/, ''))}` },
  upi:     { label: 'UPI',      hint: 'you@bank', prefix: '',
             url: (h, a, n) => `upi://pay?pa=${encodeURIComponent(h)}&am=${a}&cu=${encodeURIComponent(S.config.currency || 'INR')}&tn=${encodeURIComponent(n)}` },
  link:    { label: 'Any link', hint: 'https://…', prefix: '',
             url: h => h }
};

const canBePaid = u => !!(u && u.payType && u.payHandle && PAY_SERVICES[u.payType]);

/** The deep link to pay someone, or '' if we don't know how to reach them. */
function payLink(user, amount, note) {
  if (!canBePaid(user)) return '';
  const svc = PAY_SERVICES[user.payType];
  try { return svc.url(user.payHandle, round2(amount).toFixed(2), note || (S.config.appName || 'SplitStack')); }
  catch (e) { return ''; }
}

const userById = id => S.users.find(u => u.id === id) || { id, name: 'Unknown', color: '#8A84A6', emoji: '👤', avatar: '' };
const ledgerById = id => S.ledgers.find(l => l.id === id);
const memberIdsOf = id => S.members.filter(m => m.ledgerId === id).map(m => m.userId);
const isAdmin = () => S.me && S.me.role === 'admin';

/* ──────────────────────────────────────────────────────────────────── api */
class ApiError extends Error { constructor(code) { super(code); this.code = code; } }

async function api(action, payload = {}, opts = {}) {
  if (!S.api) throw new ApiError('NO_API');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 45000);
  let res;
  try {
    res = await fetch(S.api, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: S.token, gate: S.gate, payload })
    });
  } catch (e) {
    clearTimeout(timer);
    S.online = false;
    throw new ApiError('OFFLINE');
  }
  clearTimeout(timer);
  S.online = true;
  let j;
  try { j = await res.json(); } catch (e) { throw new ApiError('BAD_RESPONSE'); }
  if (!j.ok) {
    if (/^AUTH_/.test(j.error)) { await signOut(true); throw new ApiError(j.error); }
    // The admin turned the gate on (or changed it) since this device last spoke.
    if (/^GATE_/.test(j.error) && !opts.noGateRedirect) {
      S.gate = ''; LS.gate = '';
      if (S.view !== 'gate') { S.view = 'gate'; S.params = { reason: j.error }; render(); }
      throw new ApiError(j.error);
    }
    throw new ApiError(j.error);
  }
  return j.data;
}

const ERRORS = {
  NO_API: 'No backend configured yet.',
  OFFLINE: "Can't reach the server — you're offline.",
  BAD_CREDENTIALS: 'Wrong username or password.',
  BAD_SETUP_KEY: 'That setup key is not right.',
  ADMIN_EXISTS: 'An admin account already exists here.',
  USERNAME_TAKEN: 'That username is taken.',
  BAD_USERNAME: 'Usernames are 2–24 letters, numbers, dot, dash or underscore.',
  ACCOUNT_DISABLED: 'That account has been switched off.',
  LAST_ADMIN: "You can't remove the last admin.",
  CANNOT_DELETE_SELF: "You can't delete your own account.",
  SPLIT_MUST_TOTAL_100: 'The split has to add up to 100%.',
  FORBIDDEN: "You don't have access to that.",
  BAD_INVITE: 'That invite link is no longer valid.',
  SEAT_TAKEN: 'That person already set up their password.',
  AVATAR_TOO_BIG: 'That picture is too large.',
  TOO_MANY_ATTEMPTS: 'Too many wrong tries. This account is locked for 15 minutes.',
  GATE_REQUIRED: 'This server needs an access phrase.',
  GATE_INVALID: 'That access phrase is not right.',
  GATE_TOO_SHORT: 'Use at least 6 characters.',
  BAD_RESPONSE: 'The server sent something unexpected. Is the deployment URL right?',
  BAD_EMAIL: "That doesn't look like an email address.",
  NO_EMAIL_ON_FILE: 'No email address on file for them yet.',
  NOTIFY_OFF: "They've turned email off.",
  NUDGE_TOO_SOON: 'You nudged them recently — give it a few hours.',
  NOTHING_OWED: "They don't owe anything right now.",
  YOU_ARE_NOT_OWED: "You're not owed anything on this ledger.",
  CANNOT_NUDGE_SELF: "You can't nudge yourself.",
  MAIL_QUOTA_EXHAUSTED: "Your Google account's daily email limit is used up. Try tomorrow.",
  NOT_A_MEMBER: "They're not on this ledger.",
  PAYER_NOT_A_MEMBER: "Whoever pays it has to be on the ledger.",
  BAD_FREQUENCY: 'Pick weekly, monthly or yearly.',
  BAD_DATE: 'That date is not valid.',
  BAD_AMOUNT: 'Add an amount first.',
  AMOUNT_TOO_LARGE: "That's larger than this app will store.",
  NAME_REQUIRED: 'Give it a name.',
  SPLIT_REQUIRED: 'Pick who splits it.',
  NO_SUCH_RULE: 'That repeating expense is gone.',
  NOT_A_PERSON: "That's not a person — it can't log in or be emailed.",
  HAS_A_LOGIN: "They've already set a password, so they're a person. Remove the account instead.",
  ADMIN_IS_A_PERSON: 'Admins have to be people. Change the role first.'
};
const errMsg = e => ERRORS[e && e.code] || (e && e.message) || 'Something went wrong.';

/* ────────────────────────────────────────────────────────────── sync engine */
function syncBadge(text, cls) {
  const el = $('#sync');
  if (!text) { el.classList.remove('on'); return; }
  el.className = 'on ' + (cls || '');
  el.innerHTML = text;
}

async function applyState(st) {
  S.me = st.me; S.users = st.users; S.ledgers = st.ledgers; S.members = st.members;
  S.config = st.config || S.config;
  // A backend too old to know about rules sends nothing rather than an empty
  // list — keep what we had instead of blanking the screen.
  if (st.recurring) S.recurring = st.recurring;
  await DB.set('state', { me: st.me, users: st.users, ledgers: st.ledgers, members: st.members,
                          recurring: S.recurring, config: st.config });
  document.title = (S.config.appName || 'SplitStack');
}

async function loadCache() {
  const st = await DB.get('state');
  if (st) { S.me = st.me; S.users = st.users; S.ledgers = st.ledgers; S.members = st.members;
            S.recurring = st.recurring || []; S.config = st.config || S.config; }
  S.cursors = (await DB.get('cursors')) || {};
  S.seen = (await DB.get('seen')) || {};
  for (const l of S.ledgers) {
    const rows = await DB.allTxns(l.id);
    S.txns[l.id] = rows.map(r => { const c = Object.assign({}, r); delete c.key; return c; });
  }
  await refreshPending();
}

async function refreshPending() {
  const ob = await DB.outbox();
  S.pending = {};
  ob.forEach(o => { if (o.kind === 'txn') S.pending[o.payload.id] = true; });
  return ob;
}

function mergeTxns(ledgerId, incoming) {
  const map = new Map((S.txns[ledgerId] || []).map(t => [t.id, t]));
  incoming.forEach(t => {
    const cur = map.get(t.id);
    // An edit that is still sitting in the outbox always wins until it lands.
    if (cur && cur._local && S.pending[t.id]) return;
    map.set(t.id, t);
  });
  S.txns[ledgerId] = [...map.values()];
}

async function persistLedger(ledgerId) {
  await DB.putTxns(ledgerId, S.txns[ledgerId] || []);
  await DB.set('cursors', S.cursors);
}

let syncing = null;
async function sync({ silent = false, full = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!S.token) return;
    if (!silent) syncBadge('<span class="spinner"></span>Syncing…');
    try {
      /* 1 ── drain the outbox, in order */
      const ob = await refreshPending();
      const byLedger = {};
      ob.filter(o => o.kind === 'txn').forEach(o => (byLedger[o.ledgerId] = byLedger[o.ledgerId] || []).push(o));

      for (const [ledgerId, items] of Object.entries(byLedger)) {
        // receipts first so the txn row carries a real id
        for (const it of items) {
          if (it.payload._receiptLocal) {
            try {
              const data = await DB.blobGet(it.payload._receiptLocal);
              if (data) {
                const r = await api('putReceipt', { ledgerId, txnId: it.payload.id, dataUrl: data });
                it.payload.receiptId = r.receiptId;
                delete it.payload._receiptLocal;
              }
            } catch (e) { if (e.code === 'OFFLINE') throw e; }
          }
        }
        const res = await api('push', {
          ledgerId, txns: items.map(i => i.payload), since: S.cursors[ledgerId] || 0
        });
        S.cursors[ledgerId] = res.cursor;
        (S.txns[ledgerId] || []).forEach(t => { delete t._local; });
        mergeTxns(ledgerId, res.txns);
        for (const it of items) await DB.unqueue(it.seq);
        await persistLedger(ledgerId);
      }

      /* sign-offs and flags, after the rows they talk about exist */
      for (const it of ob.filter(o => o.kind === 'review')) {
        try {
          const r = await api('reviewTxn', it.payload);
          mergeTxns(it.payload.ledgerId, [r.txn]);
          await persistLedger(it.payload.ledgerId);
        } catch (e) {
          if (e.code === 'OFFLINE') throw e;
          // A backend that predates reviews doesn't know the action. That is
          // fixable by pasting the new Code.gs, so hold the queue rather than
          // throwing the sign-off away — it lands the moment they update.
          if (/^UNKNOWN_ACTION/.test(e.code || '')) { S.apiVersion = 1; break; }
          // Anything else (row gone, already cleared by someone else) is not
          // worth jamming the queue over — the next pull carries the truth.
        }
        await DB.unqueue(it.seq);
      }

      /* repeating-expense rules and saved splits — small, rare, and safe to
         replay, so they drain the same way everything else does */
      for (const it of ob.filter(o => o.kind === 'rule' || o.kind === 'preset')) {
        try {
          if (it.kind === 'preset') await api('setPresets', it.payload);
          else if (it.payload.op === 'delete') await api('recurringDelete', { id: it.payload.id });
          else await api('recurringSave', it.payload);
        } catch (e) {
          if (e.code === 'OFFLINE') throw e;
          // An old backend can't store either of these yet. Hold the queue so
          // they land the moment the script is updated, exactly like reviews.
          if (/^UNKNOWN_ACTION/.test(e.code || '')) { S.apiVersion = Math.min(S.apiVersion || 3, 3); break; }
          toast(errMsg(e));    // rejected on its merits — say so rather than retry forever
        }
        await DB.unqueue(it.seq);
      }
      await refreshPending();

      /* Once per session, check the backend is new enough to store reviews at
         all. Fired without awaiting: it must not slow a sync down. */
      if (!S.apiVersion) {
        api('ping', {}, { timeout: 15000 })
          .then(i => { S.apiVersion = Number(i.version) || 1; if (S.apiVersion < NEEDS_API) render(); })
          .catch(() => {});
      }

      /* 2 ── pull deltas (and tell the backend where this app is hosted) */
      const st = await api('bootstrap', { home: appHome() });
      await applyState(st);
      const since = full ? {} : S.cursors;
      const pulled = await api('pull', { since });
      for (const [ledgerId, blk] of Object.entries(pulled.ledgers || {})) {
        if (blk.full) S.txns[ledgerId] = [];
        mergeTxns(ledgerId, blk.txns);
        S.cursors[ledgerId] = blk.cursor;
        await persistLedger(ledgerId);
      }
      await DB.set('lastSync', Date.now());
      S.lastError = '';
      if (!silent) { syncBadge('✓ Up to date', 'ok'); setTimeout(() => syncBadge(''), 1400); }
      render();
    } catch (e) {
      S.lastError = errMsg(e);
      if (e.code === 'OFFLINE') { syncBadge('📴 Offline — changes are saved', 'offline'); setTimeout(() => syncBadge(''), 2600); }
      else if (!/^AUTH_/.test(e.code || '')) { syncBadge('⚠️ ' + esc(errMsg(e)), 'err'); setTimeout(() => syncBadge(''), 3800); }
      render();
    } finally { syncing = null; }
  })();
  return syncing;
}

async function queueTxn(ledgerId, txn) {
  txn._local = true;
  mergeTxns(ledgerId, [txn]);
  S.pending[txn.id] = true;
  await persistLedger(ledgerId);
  await DB.queue({ kind: 'txn', ledgerId, payload: txn, ts: Date.now() });
  render();
  sync({ silent: true });
}

/**
 * Signing off, flagging and withdrawing all go through the outbox like
 * everything else, so they work on a plane. The local row is updated straight
 * away and the server's version replaces it when the queue drains.
 */
async function queueReview(ledgerId, txnId, op, note = '') {
  const t = (S.txns[ledgerId] || []).find(x => x.id === txnId);
  if (t) {
    const clear = () => { t.reviewState = ''; t.reviewBy = ''; t.reviewNote = ''; t.reviewDone = []; t.reviewWas = null; };
    if (op === 'flag') {
      t.reviewState = 'flag'; t.reviewBy = S.me.id; t.reviewNote = note;
      t.reviewDone = [S.me.id]; t.reviewWas = null;
    } else if (op === 'unflag') clear();
    else if (op === 'ack') {
      t.reviewDone = reviewDoneBy(t).concat(reviewDoneBy(t).includes(S.me.id) ? [] : [S.me.id]);
      if (!reviewOutstanding(t).length) clear();
    }
    await persistLedger(ledgerId);
  }
  await DB.queue({ kind: 'review', ledgerId, payload: { ledgerId, txnId, op, note }, ts: Date.now() });
  render();
  sync({ silent: true });
}

/* ────────────────────────────────────────────── repeating rules & presets */
/**
 * Both live on the server rather than in the transaction stream, but both are
 * things you reach for while standing in a shop with no signal, so both go
 * through the outbox. The local copy updates immediately and the server's
 * version replaces it on the next sync.
 */
const rulesFor = ledgerId => S.recurring.filter(r => r.ledgerId === ledgerId);
const ruleById = id => S.recurring.find(r => r.id === id);
const presetsOf = l => (l && l.presets) || [];

async function queueRule(rule) {
  const i = S.recurring.findIndex(r => r.id === rule.id);
  if (i >= 0) S.recurring[i] = rule; else S.recurring.push(rule);
  await DB.set('state', { me: S.me, users: S.users, ledgers: S.ledgers, members: S.members,
                          recurring: S.recurring, config: S.config });
  await DB.queue({ kind: 'rule', payload: rule, ts: Date.now() });
  render();
  sync({ silent: true });
}

async function queueRuleDelete(id) {
  S.recurring = S.recurring.filter(r => r.id !== id);
  await DB.set('state', { me: S.me, users: S.users, ledgers: S.ledgers, members: S.members,
                          recurring: S.recurring, config: S.config });
  await DB.queue({ kind: 'rule', payload: { id, op: 'delete' }, ts: Date.now() });
  render();
  sync({ silent: true });
}

async function queuePresets(ledgerId, presets) {
  const l = ledgerById(ledgerId);
  if (l) l.presets = presets;
  await DB.set('state', { me: S.me, users: S.users, ledgers: S.ledgers, members: S.members,
                          recurring: S.recurring, config: S.config });
  await DB.queue({ kind: 'preset', payload: { ledgerId, presets }, ts: Date.now() });
  sync({ silent: true });
}

addEventListener('online', () => { S.online = true; sync({ silent: true }); render(); });
addEventListener('offline', () => { S.online = false; render(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (S.token) sync({ silent: true });
  Updater.check(false);        // throttled to once every 30 minutes
});

/* ══════════════════════════════════════════════════════════ app updates */
/**
 * Keeping a PWA current is fiddly: the browser caches the code, the service
 * worker caches it again, and a newly installed worker sits in "waiting" until
 * every tab closes. This handles all three so the user just taps a button.
 */
const Updater = {
  reg: null,
  swBuild: null,
  lastCheck: 0,
  checking: false,

  /* Single funnel for page reloads — one place to reason about, and a seam
     that tests can stand in front of. */
  reload() { location.reload(); },

  async init() {
    if (!navigator.serviceWorker || location.protocol === 'file:') return;
    try {
      this.reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    } catch (e) { return; }

    // Somebody else's tab activated a new worker — reload to match it.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this._applying) this.reload();
    });

    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'version') { this.swBuild = e.data.build; render(); }
    });

    if (this.reg.waiting && navigator.serviceWorker.controller) this.flagReady();
    this.reg.addEventListener('updatefound', () => this.watch());
    this.watch();
    this.askVersion();
    this.check(false);
  },

  askVersion() {
    const c = navigator.serviceWorker.controller;
    if (c) c.postMessage('version');
  },

  watch() {
    const w = this.reg && this.reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) this.flagReady();
    });
  },

  flagReady() {
    if (S.updateReady) return;
    S.updateReady = true;
    render();
    toast('A new version is ready 🎉', 4000);
  },

  /** Ask the browser to re-fetch sw.js and see if the bytes changed. */
  async check(manual) {
    if (!this.reg) return { ok: false, reason: 'no-sw' };
    if (this.checking) return { ok: false, reason: 'busy' };
    if (!manual && Date.now() - this.lastCheck < 1800000) return { ok: false, reason: 'throttled' };
    this.checking = true;
    this.lastCheck = Date.now();
    try {
      await this.reg.update();
      // Also compare the deployed app.js against what's running, which catches
      // a re-upload where sw.js itself didn't change.
      let remoteChanged = false;
      try {
        const r = await fetch('app.js?probe=' + Date.now(), { cache: 'no-store' });
        if (r.ok) {
          const txt = await r.text();
          const m = txt.match(/APP_BUILD\s*=\s*'([^']+)'/);
          if (m && m[1] !== APP_BUILD) remoteChanged = true;
        }
      } catch (e) { /* offline — nothing to compare against */ }
      if (this.reg.waiting || remoteChanged) this.flagReady();
      return { ok: true, updateReady: !!(this.reg.waiting || remoteChanged) };
    } catch (e) {
      return { ok: false, reason: 'failed' };
    } finally { this.checking = false; }
  },

  /** Activate the waiting worker and reload onto the new code. */
  async apply() {
    this._applying = true;
    if (this.reg && this.reg.waiting) {
      this.reg.waiting.postMessage('skipWaiting');
      setTimeout(() => this.reload(), 1200);   // belt and braces
    } else {
      this.reload();
    }
  },

  /** Nuclear option: drop every cache and re-register from scratch. */
  async hardReset() {
    try {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clearCaches');
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch (e) { /* keep going — the reload is what matters */ }
    this.reload();
  }
};

/* ───────────────────────────────────────────────────────────────── balances */
/**
 * Turn percentages into real money that adds up to the cent.
 * Percentages can never express thirds exactly, so we floor everyone to a
 * cent and hand the leftover pennies to the largest fractional remainders
 * (ties broken by user id, so every device agrees).
 */
function allocate(amount, split) {
  const ids = Object.keys(split || {}).sort();
  const out = {};
  if (!ids.length) return out;
  const totalCents = Math.round(round2(amount) * 100);
  const raw = ids.map(id => round2(amount) * (Number(split[id]) || 0) / 100 * 100); // in cents
  const cents = raw.map(v => Math.floor(v));
  let residual = totalCents - cents.reduce((a, b) => a + b, 0);
  const order = ids.map((id, i) => ({ i, id, frac: raw[i] - cents[i] }))
    .sort((a, b) => (b.frac - a.frac) || (a.id < b.id ? -1 : 1));
  for (let k = 0; residual > 0 && k < 10000; k++, residual--) cents[order[k % ids.length].i]++;
  for (let k = 0; residual < 0 && k < 10000; k++, residual++) cents[order[order.length - 1 - (k % ids.length)].i]--;
  ids.forEach((id, i) => out[id] = cents[i] / 100);
  return out;
}
/** What this transaction does to one person's balance. */
function impactOf(t, userId) {
  if (t.type === 'settlement')
    return (t.paidBy === userId ? t.amount : 0) - (t.paidTo === userId ? t.amount : 0);
  const share = allocate(t.amount, t.split)[userId] || 0;
  return round2((t.paidBy === userId ? t.amount : 0) - share);
}

function balancesFor(ledgerId) {
  const ids = memberIdsOf(ledgerId);
  const net = {}; ids.forEach(i => net[i] = 0);
  (S.txns[ledgerId] || []).filter(t => !t.deleted).forEach(t => {
    if (t.type === 'settlement') {
      net[t.paidBy] = round2((net[t.paidBy] || 0) + t.amount);
      net[t.paidTo] = round2((net[t.paidTo] || 0) - t.amount);
    } else {
      net[t.paidBy] = round2((net[t.paidBy] || 0) + t.amount);
      const shares = allocate(t.amount, t.split);
      Object.entries(shares).forEach(([uid, v]) => net[uid] = round2((net[uid] || 0) - v));
    }
  });
  Object.keys(net).forEach(k => net[k] = round2(net[k]));
  return net;
}

/** Greedy minimum-cash-flow: fewest transfers that zero everyone out. */
function simplify(net) {
  const cred = [], debt = [];
  Object.entries(net).forEach(([id, v]) => {
    if (v > 0.005) cred.push({ id, v }); else if (v < -0.005) debt.push({ id, v: -v });
  });
  cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = round2(Math.min(debt[i].v, cred[j].v));
    if (amt > 0.005) out.push({ from: debt[i].id, to: cred[j].id, amount: amt });
    debt[i].v = round2(debt[i].v - amt); cred[j].v = round2(cred[j].v - amt);
    if (debt[i].v <= 0.005) i++;
    if (cred[j].v <= 0.005) j++;
  }
  return out;
}

function myBalance(ledgerId) {
  const b = balancesFor(ledgerId);
  return S.me ? (b[S.me.id] || 0) : 0;
}

/**
 * Who owes whom once every ledger is taken together.
 *
 * The per-ledger view answers "where do I stand here"; it can't tell you that
 * Ada owes you $621 on the beach house while you owe her $40 from the ski trip.
 * This sums the settle-up suggestions the app already shows, per counterparty,
 * so the totals agree with the buttons on each Balances tab rather than being
 * a second opinion computed a different way.
 *
 * Ledgers stay separate for settling — you don't pay one debt with another
 * house's money — so this reports, and each row links back to where the money
 * actually is.
 */
function overallByPerson() {
  const by = new Map();
  S.ledgers.filter(l => !l.archived).forEach(l => {
    simplify(balancesFor(l.id)).forEach(d => {
      if (d.from !== S.me.id && d.to !== S.me.id) return;
      const other = d.from === S.me.id ? d.to : d.from;
      const signed = d.to === S.me.id ? d.amount : -d.amount;   // + means they owe me
      const row = by.get(other) || { id: other, net: 0, parts: [] };
      row.net = round2(row.net + signed);
      row.parts.push({ ledgerId: l.id, amount: signed });
      by.set(other, row);
    });
  });
  return [...by.values()]
    .filter(r => Math.abs(r.net) > 0.005)
    .sort((a, b) => b.net - a.net);
}

/**
 * Drop anyone no longer on the ledger and rescale the rest back to 100.
 * Mirrors normaliseSplit() in Code.gs — a saved split or a repeating rule
 * outlives the housemate who moved out, and the percentages have to still add
 * up when it does. Returns null when nobody named in it is left.
 */
function normaliseSplit(split, memberIds) {
  const kept = {};
  let sum = 0;
  Object.keys(split || {}).forEach(k => {
    if (!memberIds.includes(k)) return;
    const v = Number(split[k]) || 0;
    if (v <= 0) return;
    kept[k] = v; sum += v;
  });
  const ids = Object.keys(kept);
  if (!ids.length || sum <= 0) return null;
  if (Math.abs(sum - 100) < 0.005) return kept;
  const out = {};
  let acc = 0;
  ids.forEach((k, i) => {
    if (i === ids.length - 1) out[k] = round2(100 - acc);
    else { const v = round2(kept[k] / sum * 100); out[k] = v; acc = round2(acc + v); }
  });
  return out;
}

/** True when a split is just "everyone in it, evenly". */
function isEvenSplit(split) {
  const vals = Object.values(split || {});
  if (!vals.length) return false;
  const eq = 100 / vals.length;
  return vals.every(v => Math.abs(v - eq) < 0.02);
}

/* ─────────────────────────────────────────────────────────────────── review */
/**
 * Three ways a row ends up wanting a second pair of eyes:
 *   edit      someone who didn't enter it changed it  -> the author signs off
 *   conflict  …and they collided with a change they
 *             hadn't seen yet                         -> same, flagged louder
 *   flag      anyone asking everyone to look, for
 *             placeholders and not-yet-final amounts  -> everyone signs off
 * A review never changes the money: balances count an under-review row exactly
 * like any other, and the Balances tab says so out loud.
 */
const REVIEW_LABEL = { edit: 'Edited by someone else', conflict: 'Edited at the same time', flag: 'Marked for review' };

/** Who still has to sign this off. Mirrors reviewersOf() in Code.gs. */
function reviewersFor(t) {
  if (!t.reviewState) return [];
  if (t.reviewState !== 'flag') return t.enteredBy ? [t.enteredBy] : [];
  if (t.type === 'settlement') return [t.paidBy, t.paidTo].filter(Boolean);
  return Object.keys(t.split || {});
}
const reviewDoneBy = t => t.reviewDone || [];
const reviewOutstanding = t => reviewersFor(t).filter(u => !reviewDoneBy(t).includes(u));
const needsMyReview = t => !!t.reviewState && S.me && reviewOutstanding(t).includes(S.me.id);
const underReview = t => !!t.reviewState && !t.deleted;

/** Rows in a ledger waiting on me — including ones deleted out from under me. */
const myReviews = ledgerId => (S.txns[ledgerId] || []).filter(needsMyReview);
const openReviews = ledgerId => (S.txns[ledgerId] || []).filter(t => t.reviewState && !t.deleted);

/**
 * Plain language account of what an edit did, written by the editor's client
 * because it is the side holding both the old row and the currency symbol.
 */
function changeSummary(before, after) {
  const bits = [];
  const nm = (a, b, label, fmt = String) => {
    if (String(a ?? '') !== String(b ?? '')) bits.push(`${label} ${fmt(a) || '—'} → ${fmt(b) || '—'}`);
  };
  if (after.deleted && !before.deleted) return 'Deleted it';
  nm(before.name, after.name, 'Name', v => v ? `“${v}”` : '');
  if (round2(before.amount) !== round2(after.amount)) bits.push(`Amount ${money(before.amount)} → ${money(after.amount)}`);
  nm(before.date, after.date, 'Date', niceDate);
  nm(before.category, after.category, 'Category');
  if (before.paidBy !== after.paidBy) bits.push(`Paid by ${userById(before.paidBy).name} → ${userById(after.paidBy).name}`);
  if (JSON.stringify(before.split || {}) !== JSON.stringify(after.split || {})) bits.push('Changed the split');
  if (String(before.notes ?? '') !== String(after.notes ?? ''))
    bits.push(!before.notes ? 'Added a note' : !after.notes ? 'Cleared the notes' : 'Changed the notes');
  if (!bits.length) return 'Saved it again without changing anything';
  return bits.slice(0, 4).join(' · ') + (bits.length > 4 ? ` · +${bits.length - 4} more` : '');
}

/** The fields "Put it back" restores. Receipts are blobs and stay put. */
const REVERTABLE = ['name', 'amount', 'date', 'category', 'paidBy', 'paidTo', 'split', 'notes', 'deleted'];
function snapshotOf(t) {
  const out = {};
  REVERTABLE.forEach(k => out[k] = t[k]);
  return out;
}

/**
 * What the editor sends alongside an edit. baseRev is only meaningful once the
 * row has been to the server and back — a row still in the outbox carries a
 * local clock value, which would make the collision check meaningless.
 */
function reviewPatch(existing, next) {
  if (!existing || existing.enteredBy === S.me.id) return {};
  return {
    baseRev: existing._local ? 0 : (existing.updatedAt || 0),
    reviewNote: changeSummary(existing, next),
    reviewWas: snapshotOf(existing)
  };
}

/* ───────────────────────────────────────────────────────────────── snippets */
function avatar(u, size = 'm', badge) {
  const bg = u.avatar ? `background-image:url('${u.avatar}')` : `background:${esc(u.color || '#8A84A6')}`;
  // Entities wear squared-off corners. It reads at avatar size in a way a badge
  // or a colour never would, and it means a split row shows at a glance that
  // one of the shares belongs to a company rather than a housemate.
  return `<div class="av ${size}${isEntity(u) ? ' entity' : ''}" style="${bg}" title="${esc(u.name)}">${u.avatar ? '' : esc(u.emoji || initials(u.name))}${badge ? `<span class="badge">${badge}</span>` : ''}</div>`;
}
function avStack(ids, max = 5) {
  const shown = ids.slice(0, max);
  return `<div class="avstack">${shown.map(id => avatar(userById(id), 's')).join('')}` +
    (ids.length > max ? `<div class="av s" style="background:var(--ink-3)">+${ids.length - max}</div>` : '') + '</div>';
}
/* The list every instance starts with. An admin can replace it under
   Settings ▸ Categories; leaving it alone keeps these, so the defaults can
   improve later without being frozen into anybody's spreadsheet. */
const CATEGORIES_DEFAULT = [
  ['🍕', 'Food'], ['🛒', 'Groceries'], ['🏠', 'Home'], ['💡', 'Utilities'], ['🚗', 'Transport'],
  ['✈️', 'Travel'], ['🏨', 'Lodging'], ['🎟️', 'Fun'], ['🍺', 'Drinks'], ['🧻', 'Supplies'],
  ['🩺', 'Health'], ['🎁', 'Gifts'], ['🐶', 'Pets'], ['📶', 'Internet'], ['💼', 'Other']
];
const categories = () => {
  const c = S.config.categories;
  return (c && c.length) ? c.map(x => [x.emoji || '🧾', x.name]) : CATEGORIES_DEFAULT;
};
/* Removing a category never rewrites history, so a row can name one that is no
   longer offered. It keeps the name and falls back to a generic icon. */
const catEmoji = c => (categories().find(x => x[1] === c) || ['🧾'])[0];
const firstCategory = () => (categories()[0] || ['🧾', 'Other'])[1];

/**
 * Guess a category from what the expense is called.
 *
 * Purely local, and deliberately only ever *pre*-selects — the moment somebody
 * taps a chip themselves the guessing stops for that expense, because being
 * quietly overruled by a keyword list is worse than typing it yourself. Each
 * entry maps to a default category name; an instance that has renamed its
 * categories away from those simply gets no guesses, which is the right
 * failure.
 */
const CATEGORY_HINTS = [
  [/\b(uber|lyft|taxi|cab|train|bus|metro|tube|fuel|petrol|gas station|parking|toll|mot|car park)\b/, 'Transport'],
  [/\b(tesco|sainsbury|aldi|lidl|asda|waitrose|costco|trader joe|whole foods|safeway|kroger|walmart|grocer|supermarket|market)\b/, 'Groceries'],
  [/\b(pizza|sushi|burger|takeaway|takeout|deliveroo|ubereats|just ?eat|doordash|grubhub|restaurant|dinner|lunch|brunch|breakfast|cafe|coffee|starbucks|costa|bakery)\b/, 'Food'],
  [/\b(beer|wine|pub|bar|cocktail|brewery|booze|drinks|spirits)\b/, 'Drinks'],
  [/\b(rent|mortgage|deposit|landlord|cleaner|cleaning|repair|plumber|electrician|furniture|ikea|garden)\b/, 'Home'],
  [/\b(electric|electricity|power|gas bill|water|council tax|heating|energy|utility|utilities)\b/, 'Utilities'],
  [/\b(wifi|broadband|internet|fibre|fiber|router|mobile|phone bill|data plan)\b/, 'Internet'],
  [/\b(flight|airline|airfare|ryanair|easyjet|baggage|passport|visa fee|rail pass)\b/, 'Travel'],
  [/\b(hotel|airbnb|hostel|motel|cabin|lodge|booking\.com|check-?in)\b/, 'Lodging'],
  [/\b(cinema|movie|concert|ticket|museum|festival|game|golf|ski|surf|bowling|netflix|spotify|gig)\b/, 'Fun'],
  [/\b(pharmacy|chemist|doctor|dentist|medicine|prescription|hospital|clinic|optician)\b/, 'Health'],
  [/\b(gift|present|birthday|christmas|anniversary|wedding)\b/, 'Gifts'],
  [/\b(vet|dog|cat|puppy|kitten|pet food|litter|kennel|groomer)\b/, 'Pets'],
  [/\b(toilet|loo roll|detergent|soap|batteries|bin bags|light ?bulb|cleaning supplies|paper towel)\b/, 'Supplies'],
];

function guessCategory(name) {
  const s = String(name || '').toLowerCase().trim();
  if (s.length < 3) return '';
  const available = categories().map(c => c[1]);
  for (const [re, cat] of CATEGORY_HINTS) {
    if (re.test(s) && available.includes(cat)) return cat;
  }
  return '';
}

/* ─────────────────────────────────────────────────────────────────── router */
/** Feed filters are per-visit, not sticky — leaving a ledger drops them. */
const resetFeedView = () => {
  S.searchOpen = false; S.search = ''; S.reviewOnly = false;
  S.filterWho = ''; S.filterCat = '';
  // Leaving a ledger releases the frozen "last time", so the next visit
  // measures from where this one left off.
  S.seenAt = {};
};

function go(view, params = {}, replace = false) {
  resetFeedView();
  S.view = view; S.params = params;
  const hash = '#/' + view + (params.id ? '/' + params.id : '') + (params.token ? '/' + params.token : '');
  if (replace) history.replaceState({ view, params }, '', hash);
  else history.pushState({ view, params }, '', hash);
  window.scrollTo(0, 0);
  render();
}
addEventListener('popstate', e => {
  resetFeedView();
  if (e.state && e.state.view) { S.view = e.state.view; S.params = e.state.params || {}; render(); }
  else routeFromHash();
});
const HASH_VIEWS = ['home', 'people', 'profile', 'admin', 'ledger'];
function routeFromHash() {
  resetFeedView();
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  // join/connect links can carry a backend id, so let boot() do the full dance
  if (parts[0] === 'join' || parts[0] === 'connect') return void boot();
  if (parts[0] === 'ledger' && parts[1]) { S.view = 'ledger'; S.params = { id: parts[1] }; }
  else if (S.token && HASH_VIEWS.includes(parts[0])) { S.view = parts[0]; S.params = { id: parts[1] }; }
  else S.view = S.token ? 'home' : 'login';
  render();
}

/* ──────────────────────────────────────────────────────────────────── sheets */
/* Sheets stack — saving a split from inside the expense editor opens a second
   one on top of the first. Counting them keeps the body scroll lock balanced,
   so closing the inner sheet doesn't unlock the page behind the outer one. */
let sheetDepth = 0;

function openSheet(html, opts = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet"><div class="grip"></div>${html}</div>`;
  document.body.appendChild(scrim);
  sheetDepth++;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => scrim.classList.add('on'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove('on');
    sheetDepth = Math.max(0, sheetDepth - 1);
    if (!sheetDepth) document.body.style.overflow = '';
    setTimeout(() => scrim.remove(), 340);
    opts.onClose && opts.onClose();
  };
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  scrim.close = close;
  return scrim;
}
function confirmSheet(title, body, confirmLabel = 'Do it', danger = true) {
  return new Promise(res => {
    const s = openSheet(`
      <h2>${esc(title)}</h2><p class="sheet-sub">${esc(body)}</p>
      <div class="flex mt"><button class="btn ghost grow" data-x="no">Cancel</button>
      <button class="btn ${danger ? 'danger' : ''} grow" data-x="yes">${esc(confirmLabel)}</button></div>`);
    s.addEventListener('click', e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      s.close(); res(b.dataset.x === 'yes');
    });
  });
}

/* ────────────────────────────────────────────────────────────── image utils */
function pickImage(maxPx, quality) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return res(null);
      const img = new Image(), url = URL.createObjectURL(f);
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => res(null);
      img.src = url;
    };
    inp.click();
  });
}
/** Square crop for avatars. */
function pickAvatar() {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return res(null);
      const img = new Image(), url = URL.createObjectURL(f);
      img.onload = () => {
        const side = Math.min(img.width, img.height), out = 220;
        const c = document.createElement('canvas'); c.width = c.height = out;
        const g = c.getContext('2d');
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', .82));
      };
      img.onerror = () => res(null);
      img.src = url;
    };
    inp.click();
  });
}

/* ══════════════════════════════════════════════════════════════════ RENDER */
function render() {
  const root = $('#root');
  // A background sync can land mid-keystroke — hold the search caret in place.
  const focused = document.activeElement;
  const caret = focused && focused.id === 'q-search' ? focused.selectionStart : null;
  let html = '';
  switch (S.view) {
    case 'connect': html = viewConnect(); break;
    case 'switch': html = viewSwitch(); break;
    case 'gate': html = viewGate(); break;
    case 'setupAdmin': html = viewSetupAdmin(); break;
    case 'login': html = viewLogin(); break;
    case 'invite': html = viewInvite(); break;
    case 'home': html = viewHome(); break;
    case 'ledger': html = viewLedger(); break;
    case 'people': html = viewPeople(); break;
    case 'profile': html = viewProfile(); break;
    case 'admin': html = viewAdmin(); break;
    default: html = viewBoot();
  }
  root.innerHTML = html;
  wire();
  if (caret !== null) {
    const box = $('#q-search');
    if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch (e) {} }
  }
}

const shell = (title, body, opts = {}) => `
  <div class="topbar"><div class="wrap row">
    ${opts.back ? `<button class="iconbtn back" data-act="back">‹</button>` : `<div class="av m" style="background:linear-gradient(140deg,var(--violet),var(--pink))">💸</div>`}
    <h1>${esc(title)}</h1>
    ${opts.actions || ''}
  </div></div>
  <div class="screen"><div class="wrap page">${updateBanner()}${backendBanner()}${body}</div></div>
  ${opts.fab ? `<button class="fab" data-act="${opts.fab}">+</button>` : ''}`;

function updateBanner() {
  if (!S.updateReady) return '';
  return `<button class="card mb" data-act="apply-update" style="display:block;width:100%;text-align:left;
      background:linear-gradient(135deg,var(--violet),var(--pink));border:0;color:#fff;cursor:pointer">
    <div class="flex"><span style="font-size:26px">✨</span>
      <div class="grow"><div class="ttl" style="color:#fff">A new version is ready</div>
        <div class="sub" style="color:rgba(255,255,255,.85)">Tap to restart — nothing unsaved is lost.</div></div>
      <span class="pill" style="background:rgba(255,255,255,.25);color:#fff">RESTART</span></div>
  </button>`;
}

/**
 * The PWA updates itself; the Apps Script behind it does not. When the two
 * drift far enough that a feature silently can't work, say so — the failure
 * mode otherwise is "I flagged it and nothing happened on the other phone".
 */
function backendBanner() {
  if (!S.apiVersion || S.apiVersion >= NEEDS_API) return '';
  return `<div class="card mb reviewnote">
    <div class="flex"><span style="font-size:26px">🔌</span>
      <div class="grow"><div class="ttl">Your backend script is out of date</div>
        <div class="sub" style="white-space:normal">Reviews, repeating expenses, saved splits and
          email can't sync until it's updated. Anything you set up meanwhile is saved on this
          device and goes through afterwards.</div></div></div>
    <div class="tiny mt" style="line-height:1.5">Open your spreadsheet ▸ <b>Extensions ▸ Apps Script</b>,
      paste the latest <b>Code.gs</b> over what's there, then
      <b>Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy</b>.</div>
  </div>`;
}

function offlineChip() {
  if (S.online) return '';
  return `<div class="card mt" style="background:rgba(247,159,31,.14);border-color:rgba(247,159,31,.4)">
    <div class="flex"><span style="font-size:22px">📴</span>
    <div class="grow"><div class="ttl">Working offline</div>
    <div class="sub">Everything you do is saved and will sync automatically.</div></div></div></div>`;
}

/* ───────────────────────────────────────────────────────────────── boot */
function viewBoot() {
  return `<div class="screen wrap"><div class="hero"><span class="mark">💸</span>
    <h1>SplitStack</h1><p>Loading your stuff…</p></div>
    <div class="card"><div class="skel" style="height:20px;width:60%"></div>
    <div class="skel mt" style="height:14px"></div><div class="skel mt" style="height:14px;width:80%"></div></div></div>`;
}

/* ─────────────────────────────────────────────────────────── connect screen */
function viewConnect() {
  // Someone followed an old-style invite that didn't carry the backend with it.
  if (S.params.needServer) {
    return `<div class="screen wrap">
      <div class="hero"><span class="mark">🔑</span><h1>Almost there</h1>
        <p>This invite doesn't include the server address.</p></div>
      <div class="card">
        <p class="hint" style="margin-top:0">Ask whoever invited you to open the ledger, tap ✉️ and
          send you a <b>fresh link</b> — new ones set everything up on their own. Or paste the
          server URL here if you have it.</p>
        <div class="field mt"><label>Server URL</label>
          <input class="input" id="c-url" placeholder="https://script.google.com/macros/s/…/exec"
                 autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></div>
        <div id="c-err"></div>
        <button class="btn block mt" data-act="connect">Connect →</button>
      </div></div>`;
  }
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">🔌</span><h1>Connect</h1>
      <p>Paste the web app URL from your Apps Script deployment.</p></div>
    <div class="card">
      <div class="field"><label>Web app URL</label>
        <input class="input" id="c-url" placeholder="https://script.google.com/macros/s/…/exec"
               value="${esc(S.api)}" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></div>
      <div id="c-err"></div>
      <button class="btn block mt" data-act="connect">Connect →</button>
      <p class="hint">It ends in <b>/exec</b>. Open SETUP.md if you haven't deployed the script yet — it takes about four minutes.</p>
    </div></div>`;
}

/* ─────────────────────────────────────────── switching between instances */
function viewSwitch() {
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">🔀</span><h1>Different server</h1>
      <p>That link points at a different SplitStack than the one this device uses.</p></div>
    <div class="card">
      <p class="hint" style="margin-top:0">Switching signs you out here and replaces the local copy
        of your ledgers. Anything already synced is safe on the other server — but anything still
        waiting to sync would be lost.</p>
      <button class="btn block mt" data-act="do-switch">Switch to the new server</button>
      <button class="btn ghost block mt" data-act="stay">Stay where I am</button>
    </div></div>`;
}

/* ──────────────────────────────────────────────────────────── gate screen */
function viewGate() {
  const changed = S.params.reason === 'GATE_INVALID';
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">🔐</span><h1>Access phrase</h1>
      <p>${changed ? 'The phrase for this server has changed.' : 'This server is locked behind a shared phrase.'}</p></div>
    <div class="card">
      <div class="field"><label>Phrase</label>
        <input class="input" id="g-phrase" type="password" placeholder="Ask whoever set this up"
               autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div id="g-err"></div>
      <button class="btn block mt" data-act="submit-gate">Unlock →</button>
      <p class="hint">You only enter this once on this device. It sits in front of the login
        screen — you'll still need your own username and password after it.</p>
    </div>
    <p class="hint center mt2"><a href="#" data-act="change-api">Change server</a></p>
  </div>`;
}

/* ───────────────────────────────────────────────────────── admin claim */
function viewSetupAdmin() {
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">👑</span><h1>You're the boss</h1>
      <p>Create the admin account for this instance.</p></div>
    <div class="card">
      <div class="field"><label>Setup key</label>
        <input class="input" id="s-key" placeholder="ABC123" autocapitalize="characters" autocorrect="off" spellcheck="false">
        <p class="hint">Printed by <b>setup()</b> in the Apps Script editor (View ▸ Logs), or run <b>showSetupKey()</b>.</p></div>
      <div class="field"><label>Your name</label><input class="input" id="s-name" placeholder="Mike"></div>
      <div class="field"><label>Username</label>
        <input class="input" id="s-user" placeholder="mike" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>Password</label>
        <input class="input" id="s-pw" type="password" placeholder="Make it a good one"></div>
      <div class="field"><label>Confirm password</label>
        <input class="input" id="s-pw2" type="password"></div>
      <div id="s-err"></div>
      <button class="btn block mt" data-act="claim-admin">Create admin account 🎉</button>
      <button class="btn ghost block mt" data-act="to-login">I already have an account</button>
    </div></div>`;
}

/* ──────────────────────────────────────────────────────────────── login */
function viewLogin() {
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">💸</span><h1>${esc(S.config.appName || 'SplitStack')}</h1>
      <p>Who owes who? Let's find out.</p></div>
    <div class="card">
      <div class="field"><label>Username</label>
        <input class="input" id="l-user" autocapitalize="off" autocorrect="off" spellcheck="false"
               autocomplete="username" placeholder="mike"></div>
      <div class="field"><label>Password</label>
        <input class="input" id="l-pw" type="password" autocomplete="current-password"></div>
      <div id="l-err"></div>
      <button class="btn block mt" data-act="login">Let me in →</button>
    </div>
    <p class="hint center mt2"><a href="#" data-act="change-api">Change server</a></p>
  </div>`;
}

/* ─────────────────────────────────────────────────────────────── invite */
function viewInvite() {
  const inv = S.params.invite;
  if (!inv) return `<div class="screen wrap"><div class="hero"><span class="mark">✉️</span><h1>Checking invite…</h1></div></div>`;
  if (inv.error) {
    return `<div class="screen wrap"><div class="hero"><span class="mark">🙈</span><h1>Hmm</h1><p>${esc(inv.error)}</p></div>
      <button class="btn block" data-act="to-login">Go to login</button></div>`;
  }
  const claimable = inv.members.filter(m => m.claimable);
  return `<div class="screen wrap">
    <div class="hero"><span class="mark">${esc(inv.ledger.emoji)}</span>
      <h1>${esc(inv.ledger.name)}</h1><p>You've been invited to split expenses here.</p></div>
    <div class="card">
      <div class="section-title" style="margin-top:0">Who's already in</div>
      ${inv.members.map(m => `<div class="row-item">${avatar(m, 'm')}<div class="grow">
        <div class="ttl">${esc(m.name)}</div>
        <div class="sub">${isEntity(m) ? 'Not a person — just holds a balance'
          : m.claimable ? 'Seat waiting — no password set' : 'Active'}</div></div></div>`).join('') ||
        '<p class="hint">Nobody yet.</p>'}
    </div>
    ${claimable.length ? `<div class="card">
      <h3>Claim your seat</h3>
      <p class="hint mb">Pick yourself, choose a password, and you're in.</p>
      <div class="chips">${claimable.map(m =>
        `<button class="chip" data-claim="${esc(m.id)}">${avatar(m, 's')}${esc(m.name)}</button>`).join('')}</div>
    </div>` : ''}
    <div class="card">
      <h3>Already have an account?</h3>
      <p class="hint mb">Log in and this ledger gets added to your list.</p>
      <button class="btn ghost block" data-act="invite-login">Log in and join</button>
    </div>
  </div>`;
}

/* ──────────────────────────────────────────────────────────────── home */
function viewHome() {
  if (!S.me) return viewBoot();
  const active = S.ledgers.filter(l => !l.archived);
  const archived = S.ledgers.filter(l => l.archived);
  let total = 0;
  active.forEach(l => total += myBalance(l.id));
  total = round2(total);

  const people = overallByPerson();
  const summary = `
    <button class="card" ${people.length ? 'data-act="people"' : ''} style="display:block;width:100%;text-align:left;
        background:linear-gradient(140deg,var(--violet),var(--pink));border:0;color:#fff;${people.length ? 'cursor:pointer' : ''}">
      <div class="flex">
        ${avatar(S.me, 'l')}
        <div class="grow">
          <div style="font-size:13px;font-weight:800;opacity:.85;text-transform:uppercase;letter-spacing:.07em">
            ${total > 0.005 ? 'You are owed' : total < -0.005 ? 'You owe' : 'All square'}</div>
          <div style="font-size:34px;font-weight:900;letter-spacing:-.03em" class="mono">${money(total)}</div>
          ${people.length ? `<div style="font-size:12.5px;font-weight:750;opacity:.85;margin-top:2px">
            across ${people.length} ${people.length === 1 ? 'person' : 'people'} · tap to see who</div>` : ''}
        </div>
        <div style="font-size:44px">${total > 0.005 ? '🤑' : total < -0.005 ? '😬' : '😎'}</div>
      </div>
    </button>`;

  const cards = active.map(l => {
    const bal = myBalance(l.id);
    const ids = memberIdsOf(l.id);
    const n = (S.txns[l.id] || []).filter(t => !t.deleted).length;
    const rev = myReviews(l.id).length;
    return `<button class="tile" data-ledger="${esc(l.id)}"
        style="background:linear-gradient(140deg,${esc(l.color)},${shade(l.color, -32)})">
      <div class="between" style="align-items:flex-start">
        <div class="emoji">${esc(l.emoji)}</div>
        ${avStack(ids)}
      </div>
      <div style="font-size:20px;font-weight:900;margin-top:10px;text-align:left">${esc(l.name)}</div>
      <div class="between" style="margin-top:6px">
        <div style="font-size:12.5px;font-weight:750;opacity:.88">${rev
          ? `<span class="pill" style="background:rgba(255,255,255,.28);color:#fff">👀 ${rev}</span>`
          : `${n} ${n === 1 ? 'entry' : 'entries'}`}</div>
        <div style="font-size:17px;font-weight:900" class="mono">
          ${Math.abs(bal) < 0.005 ? 'settled ✓' : (bal > 0 ? '+' : '−') + money(bal)}
        </div>
      </div>
    </button>`;
  }).join('');

  const empty = `<div class="empty"><span class="big">🌱</span>
    <h3>No ledgers yet</h3>
    <p>${isAdmin() ? 'Create one for your house, a trip, whatever.' : 'Ask your admin to add you to one.'}</p>
    ${isAdmin() ? '<button class="btn mt" data-act="new-ledger">Create a ledger</button>' : ''}</div>`;

  return shell(S.config.appName || 'SplitStack', `
    ${offlineChip()}
    ${summary}
    <div class="section-title">Your ledgers</div>
    ${active.length ? `<div class="grid2">${cards}</div>` : empty}
    ${archived.length ? `<div class="section-title">Archived</div>
      <div class="card">${archived.map(l => `<div class="row-item tap" data-ledger="${esc(l.id)}">
        <div style="font-size:22px">${esc(l.emoji)}</div><div class="grow"><div class="ttl">${esc(l.name)}</div>
        <div class="sub">archived</div></div><div>›</div></div>`).join('')}</div>` : ''}
    <div class="section-title">Account</div>
    <div class="card">
      <div class="row-item tap" data-act="profile">${avatar(S.me, 'm')}
        <div class="grow"><div class="ttl">${esc(S.me.name)}</div><div class="sub">@${esc(S.me.username)}${isAdmin() ? ' · admin' : ''}</div></div><div>›</div></div>
      ${isAdmin() ? `<div class="row-item tap" data-act="admin"><div class="av m" style="background:var(--ink)">⚙️</div>
        <div class="grow"><div class="ttl">Settings</div><div class="sub">People, ledgers, app</div></div><div>›</div></div>` : ''}
      <div class="row-item tap" data-act="sync"><div class="av m" style="background:var(--sky)">🔄</div>
        <div class="grow"><div class="ttl">Sync now</div><div class="sub">${S.online ? 'Connected' : 'Offline — will retry'}</div></div></div>
    </div>`,
    { fab: isAdmin() ? 'new-ledger' : '' });
}

function shade(hex, amt) {
  const h = String(hex || '#6C5CE7').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = clamp(((n >> 16) & 255) + amt, 0, 255), g = clamp(((n >> 8) & 255) + amt, 0, 255), b = clamp((n & 255) + amt, 0, 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/* ─────────────────────────────────────────────────────────────── ledger */
function viewLedger() {
  const l = ledgerById(S.params.id);
  if (!l) return shell('Ledger', `<div class="empty"><span class="big">🫥</span><h3>Not found</h3>
    <p>This ledger isn't in your list.</p><button class="btn mt" data-act="home">Back home</button></div>`, { back: true });
  // Freezes the comparison point on the first render of a visit and advances
  // the stored marker; both are guarded, so repainting costs nothing.
  markLedgerSeen(l.id);

  const tabs = `<div class="seg mb">
    <button data-tab="feed" class="${S.tab === 'feed' ? 'on' : ''}">Expenses</button>
    <button data-tab="balances" class="${S.tab === 'balances' ? 'on' : ''}">Balances</button>
    <button data-tab="charts" class="${S.tab === 'charts' ? 'on' : ''}">Stats</button>
  </div>`;

  let body = '';
  if (S.tab === 'feed') body = ledgerFeed(l);
  else if (S.tab === 'balances') body = ledgerBalances(l);
  else body = ledgerCharts(l);

  // Search belongs to the expense feed, so the magnifier only rides along there.
  const searchable = S.tab === 'feed' && liveTxns(l.id).length > 0;
  const actions = `${searchable ? `<button class="iconbtn ${S.searchOpen ? 'on' : ''}" data-act="toggle-search"
      title="Search expenses" aria-label="Search expenses">🔍</button>` : ''}
    <button class="iconbtn" data-act="share-invite" title="Invite">✉️</button>
    ${isAdmin() ? `<button class="iconbtn" data-act="edit-ledger" title="Edit">⚙️</button>` : ''}`;

  return shell(l.emoji + '  ' + l.name, offlineChip() + tabs + body, { back: true, fab: 'new-expense', actions });
}

/* A deleted row normally vanishes. One deleted by someone else stays visible,
   as a tombstone, to the person being asked to sign the deletion off — an
   expense quietly disappearing is the thing reviews exist to prevent. */
const liveTxns = id => (S.txns[id] || []).filter(t => !t.deleted || needsMyReview(t))
  .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

/* ───────────────────────────────────────────────────────────────── search */
/**
 * Every whitespace-separated word has to land somewhere in the row, so
 * "pizza 40" finds the one that cost 40 and nothing else. A word with a digit is
 * matched loosely against the amount — the currency symbol and thousands
 * separators are stripped from it, and the amount is compared at 2dp, so "12.5",
 * "$12.50" and "1,840" all hit what you'd expect them to.
 */
function prepQuery(raw) {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return null;
  const toks = q.split(/\s+/)
    .map(t => /\d/.test(t) ? t.replace(/[$£€¥₹,]/g, '') : t)
    .filter(Boolean);
  return toks.length ? toks : null;
}
/** Settlements have no name of their own, so they search on who paid whom. */
function txnHaystack(t) {
  const name = t.type === 'settlement'
    ? `${userById(t.paidBy).name} paid ${userById(t.paidTo).name}`
    : t.name;
  return (String(name || '') + ' ' + round2(t.amount).toFixed(2)).toLowerCase();
}
const txnMatches = (t, toks) => { const h = txnHaystack(t); return toks.every(k => h.includes(k)); };

function searchBar(l) {
  return `<div class="searchbar mb${S.search ? '' : ' blank'}">
    <span class="ico" aria-hidden="true">🔍</span>
    <input id="q-search" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search"
      placeholder="Name or amount…" aria-label="Search expenses" value="${esc(S.search)}">
    <button class="clear" data-act="clear-search" title="Clear" aria-label="Clear search">✕</button>
  </div>${filterBar(l)}`;
}

/**
 * Who paid, and what it was filed under — the two questions the text box can't
 * answer on its own ("what did Ben pay for?"). Both are ANDed with whatever is
 * typed, so they narrow rather than replace it.
 *
 * Only the payers and categories actually present in this ledger are offered.
 * A row of fifteen category chips when the ledger uses four is a worse control
 * than none.
 */
function filterBar(l) {
  const live = liveTxns(l.id).filter(t => t.type !== 'settlement');
  const payers = [...new Set(live.map(t => t.paidBy))].filter(Boolean);
  const cats = [...new Set(live.map(t => t.category).filter(Boolean))];
  if (payers.length < 2 && cats.length < 2) return '';
  return `<div class="filterbar mb">
    ${payers.length > 1 ? payers.map(id => { const u = userById(id);
      return `<button class="chip ${S.filterWho === id ? 'on' : ''}" data-who="${esc(id)}"
        title="Paid by ${esc(u.name)}">${avatar(u, 's')}${esc(u.name.split(' ')[0])}</button>`; }).join('') : ''}
    ${cats.length > 1 ? cats.map(c =>
      `<button class="chip ${S.filterCat === c ? 'on' : ''}" data-cat-filter="${esc(c)}">
        ${esc(catEmoji(c))} ${esc(c)}</button>`).join('') : ''}
  </div>`;
}

const filtersActive = () => !!(S.filterWho || S.filterCat);

function reviewBanner(l) {
  const n = myReviews(l.id).length;
  if (!n) return '';
  return `<button class="card mb reviewbar${S.reviewOnly ? ' on' : ''}" data-act="toggle-reviews">
    <div class="flex"><span style="font-size:24px">👀</span>
      <div class="grow" style="text-align:left">
        <div class="ttl">${n} ${n === 1 ? 'entry needs' : 'entries need'} your review</div>
        <div class="sub">${S.reviewOnly ? 'Showing only these — tap to show everything' : 'Tap to see just those'}</div>
      </div>
      <span class="pill pend">${S.reviewOnly ? 'SHOW ALL' : 'REVIEW'}</span></div>
  </button>`;
}

function ledgerFeed(l) {
  // Signing off the last one takes the banner away with it, so the filter must
  // not be able to outlive the control that turns it off.
  if (S.reviewOnly && !myReviews(l.id).length) S.reviewOnly = false;
  if (!liveTxns(l.id).length) return recurringCard(l) + `<div class="empty"><span class="big">🧾</span>
    <h3>Nothing here yet</h3><p>Tap the + to log the first expense.</p></div>`;
  return reviewBanner(l) + sinceCard(l) + recurringCard(l) + (S.searchOpen ? searchBar(l) : '') +
    `<div id="feed-list">${feedList(l)}</div>`;
}

/* ──────────────────────────────────────────────── since you last looked */
/**
 * Rev is already a strictly increasing counter that delta sync runs on, so
 * "what has changed since I last opened this" is free: remember the highest
 * one seen on the way out, compare on the way in.
 *
 * The comparison point is frozen for the duration of a visit (S.seenAt) rather
 * than read live, so the banner doesn't vanish from under you the moment the
 * background sync writes the new cursor.
 */
const maxRevOf = ledgerId => (S.txns[ledgerId] || []).reduce((m, t) => Math.max(m, t.updatedAt || 0), 0);

/** Entering a ledger: freeze what "last time" meant, then move the marker on. */
function markLedgerSeen(ledgerId) {
  if (!ledgerId) return;
  if (S.seenAt[ledgerId] === undefined) S.seenAt[ledgerId] = Number(S.seen[ledgerId] || 0);
  const now = maxRevOf(ledgerId);
  if (now > Number(S.seen[ledgerId] || 0)) {
    S.seen = Object.assign({}, S.seen, { [ledgerId]: now });
    DB.set('seen', S.seen);
  }
}

/** Entries that landed since the visit before this one — mine excluded. */
function newSinceSeen(ledgerId) {
  const since = Number(S.seenAt[ledgerId] || 0);
  if (!since) return [];                          // first ever visit: everything is "new", so nothing is
  return (S.txns[ledgerId] || []).filter(t =>
    (t.updatedAt || 0) > since && !t.deleted && t.enteredBy !== S.me.id);
}

function sinceCard(l) {
  const fresh = newSinceSeen(l.id);
  if (!fresh.length || S.searchOpen || S.reviewOnly) return '';
  const who = [...new Set(fresh.map(t => t.enteredBy))].map(i => userById(i).name.split(' ')[0]);
  const spent = round2(fresh.reduce((a, t) => a + (t.type === 'settlement' ? 0 : t.amount), 0));
  return `<div class="card mb" style="border-color:var(--violet)">
    <div class="flex"><span style="font-size:24px">✨</span>
      <div class="grow"><div class="ttl">${fresh.length} new since you last looked</div>
        <div class="sub">${esc(who.slice(0, 3).join(', '))}${who.length > 3 ? ' and others' : ''}${spent ? ' · ' + esc(money(spent)) : ''}</div></div>
    </div></div>`;
}

/**
 * The standing orders on this ledger. Only appears once there is one — the way
 * in is the Repeats field on a new expense, so an empty ledger isn't wearing a
 * control for a thing it doesn't have.
 */
function recurringCard(l) {
  const rules = rulesFor(l.id);
  if (!rules.length || S.searchOpen) return '';
  const on = rules.filter(r => r.active);
  const next = on.map(r => r.nextDate).filter(Boolean).sort()[0];
  // What actually lands on that date — summing every rule regardless of
  // frequency would quote a total that never occurs.
  const due = round2(on.filter(r => r.nextDate === next).reduce((a, r) => a + (Number(r.amount) || 0), 0));
  return `<button class="card mb" data-act="recurring" style="display:block;width:100%;text-align:left;cursor:pointer">
    <div class="flex"><span style="font-size:24px">🔁</span>
      <div class="grow"><div class="ttl">${on.length || 'No'} repeating ${on.length === 1 ? 'expense' : 'expenses'}
        ${rules.length > on.length ? `<span class="pill">${rules.length - on.length} paused</span>` : ''}</div>
        <div class="sub">${next ? `Next: ${esc(niceDate(next))}${due ? ' · ' + esc(money(due)) : ''}`
          : 'All paused'}</div></div>
      <div>›</div></div>
  </button>`;
}

/** The list of rules, and the way into editing any one of them. */
function recurringSheet(ledger) {
  const sheet = openSheet('<div id="rc-body"></div>');
  const draw = () => {
    const rules = rulesFor(ledger.id).slice()
      .sort((a, b) => Number(b.active) - Number(a.active) || (a.nextDate || '').localeCompare(b.nextDate || ''));
    $('#rc-body', sheet).innerHTML = `
      <h2>Repeating expenses</h2>
      <p class="sheet-sub">${esc(ledger.emoji)} ${esc(ledger.name)} — rent, bills, the cleaner.
        They post themselves and split the way you set them.</p>
      ${S.config.jobs === false ? `<div class="card mb reviewnote"><div class="flex">
        <span style="font-size:22px">⏰</span><div class="grow">
        <div class="ttl">Automatic posting is switched off</div>
        <div class="sub" style="white-space:normal">In your spreadsheet, choose
          <b>SplitStack ▸ Check background jobs</b>. Rules are saved either way, but nothing
          posts until that is on.</div></div></div></div>` : ''}
      ${rules.length ? `<div class="card">${rules.map(r => {
        const u = userById(r.paidBy);
        // Three facts in one line runs out of room on a narrow phone, and the
        // one that gets cut is the date — the thing you opened this to see.
        return `<div class="row-item tap" data-rule="${esc(r.id)}">
          <div class="av m" style="background:${r.active ? esc(ledger.color) : 'var(--ink-3)'}">${esc(catEmoji(r.category))}</div>
          <div class="grow"><div class="ttl">${esc(r.name)}${r.review ? ' 👀' : ''}</div>
            <div class="sub" style="white-space:normal">${esc(REPEAT_LABEL[r.freq] || r.freq)} ·
              ${esc(u.name.split(' ')[0])} pays ·
              ${r.active ? 'next ' + esc(niceDate(r.nextDate)) : '<b>paused</b>'}</div></div>
          <div class="num mono">${money(r.amount)}</div><div>›</div></div>`;
      }).join('')}</div>`
        : `<div class="empty" style="padding:26px"><span class="big" style="font-size:44px">🔁</span>
            <h3>Nothing repeats yet</h3>
            <p>Tick <b>Repeats</b> when you log an expense and it lands here.</p></div>`}
      <button class="btn ghost block mt" data-x="close">Done</button>`;
  };
  sheet.addEventListener('click', e => {
    const el = e.target.closest('[data-x],[data-rule]');
    if (!el) return;
    if (el.dataset.x === 'close') return sheet.close();
    const r = ruleById(el.dataset.rule);
    if (r) ruleSheet(ledger, r, () => draw());
  });
  draw();
}

/** Edit one rule: amount, payer, schedule, pause, delete. */
function ruleSheet(ledger, rule, onDone) {
  const ids = memberIdsOf(ledger.id);
  const st = Object.assign({}, rule, { split: Object.assign({}, rule.split) });
  const sheet = openSheet('<div id="rr-body"></div>', { onClose: () => onDone && onDone() });

  const draw = () => {
    const split = normaliseSplit(st.split, ids);
    $('#rr-body', sheet).innerHTML = `
      <h2>${esc(st.name)}</h2>
      <p class="sheet-sub">${st.active
        ? esc(repeatBlurb(st.freq, st.nextDate))
        : 'Paused — nothing posts until you resume it.'}</p>

      <div class="amount-wrap mb"><span class="cur">${esc(S.config.symbol || '$')}</span>
        <input id="r-amount" type="text" inputmode="decimal" placeholder="0.00" value="${esc(String(st.amount || ''))}"></div>

      <div class="field"><label>What it's called</label>
        <input class="input" id="r-name" maxlength="120" value="${esc(st.name)}"></div>

      <div class="field"><label>How often</label>
        <div class="chips">${['weekly', 'monthly', 'yearly'].map(f =>
          `<button class="chip ${st.freq === f ? 'on' : ''}" data-freq="${f}">${REPEAT_LABEL[f]}</button>`).join('')}</div></div>

      <div class="field"><label>Next one lands</label>
        <input class="input" id="r-next" type="date" value="${esc(st.nextDate)}"></div>

      <div class="field"><label>Who pays it</label>
        <div class="chips">${ids.map(i => { const u = userById(i);
          return `<button class="chip ${st.paidBy === i ? 'on' : ''}" data-payer="${esc(i)}">${avatar(u, 's')}${esc(u.name)}</button>`;
        }).join('')}</div></div>

      <div class="field"><label>Split</label>
        ${split ? `<div class="card" style="padding:12px">${Object.keys(split).map(i =>
          `<div class="row-item" style="padding:5px 0">${avatar(userById(i), 's')}
            <div class="grow"><div class="ttl" style="font-size:14px">${esc(userById(i).name)}</div></div>
            <div class="num mono" style="font-size:14px">${esc(money(st.amount * split[i] / 100))} · ${round2(split[i])}%</div>
          </div>`).join('')}</div>`
          : `<p class="hint">Nobody in this split is on the ledger any more — pick a new one below.</p>`}
        <div class="flex mt">
          <button class="btn ghost sm grow" data-x="split">✏️ Edit the split</button>
          ${defaultSplitOf(ledger) ? `<button class="btn ghost sm grow" data-x="usedefault">⭐ Use the default</button>` : ''}
        </div>
        <p class="hint">Changing the ledger's default never rewrites a rule that already exists —
          a standing instruction about money shouldn't move on its own.</p></div>

      <button class="chip ${st.review ? 'on' : ''}" data-x="review">
        ${st.review ? '☑' : '☐'} 👀 Ask everyone to check each one</button>

      <div class="flex mt">
        <button class="btn ghost" data-x="delete">🗑</button>
        <button class="btn ghost grow" data-x="pause">${st.active ? 'Pause' : 'Resume'}</button>
        <button class="btn grow" data-x="save">Save</button>
      </div>`;
  };

  const read = () => {
    const a = parseFloat(($('#r-amount', sheet) || {}).value || '0');
    st.amount = isNaN(a) ? 0 : Math.max(0, a);
    st.name = (($('#r-name', sheet) || {}).value || '').trim();
    st.nextDate = ($('#r-next', sheet) || {}).value || st.nextDate;
  };

  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-x],[data-freq],[data-payer]');
    if (!el) return;
    read();
    if (el.dataset.freq) { st.freq = el.dataset.freq; haptic(); }
    else if (el.dataset.payer) { st.paidBy = el.dataset.payer; haptic(); }
    else if (el.dataset.x === 'review') { st.review = !st.review; haptic(); }
    else if (el.dataset.x === 'usedefault') {
      st.split = Object.assign({}, defaultSplitOf(ledger));
      haptic(); toast('Using the ledger default');
    }
    else if (el.dataset.x === 'split') {
      return splitEditorSheet({
        title: 'Split',
        subtitle: `How ${st.name || 'this'} divides each time it posts.`,
        ids: ids.slice(),
        split: st.split,
        confirmLabel: 'Use this',
        onSave: s => { st.split = s; haptic(25); draw(); }
      });
    }
    else if (el.dataset.x === 'pause') {
      st.active = !st.active;
      await queueRule(Object.assign({}, st, { anchor: Number(String(st.nextDate).slice(8, 10)) }));
      toast(st.active ? 'Resumed 🔁' : 'Paused');
      sheet.close();
      return;
    }
    else if (el.dataset.x === 'delete') {
      sheet.close();
      if (await confirmSheet('Stop repeating this?',
        'Entries it has already posted stay exactly where they are. It just stops adding new ones.',
        'Stop repeating')) {
        await queueRuleDelete(st.id);
        toast('Stopped');
      }
      return;
    }
    else if (el.dataset.x === 'save') {
      if (!st.name) return toast('Give it a name');
      if (!(st.amount > 0)) return toast('Add an amount');
      if (!normaliseSplit(st.split, ids)) return toast('Nobody in that split is on the ledger');
      await queueRule(Object.assign({}, st, {
        amount: round2(st.amount),
        anchor: Number(String(st.nextDate).slice(8, 10))
      }));
      haptic(25); toast('Saved ✓');
      sheet.close();
      return;
    }
    draw();
  });

  draw();
}

function feedList(l) {
  const toks = S.searchOpen ? prepQuery(S.search) : null;
  let all = liveTxns(l.id);
  if (S.reviewOnly) all = all.filter(needsMyReview);
  if (S.searchOpen && S.filterWho) all = all.filter(t => t.paidBy === S.filterWho);
  if (S.searchOpen && S.filterCat) all = all.filter(t => t.category === S.filterCat);
  const txns = toks ? all.filter(t => txnMatches(t, toks)) : all;

  if (!txns.length) return `<div class="empty"><span class="big">🔍</span><h3>No matches</h3>
    <p>${filtersActive() ? 'Nothing matches those filters.' : 'Nothing here is called that, or costs that.'}</p>
    ${filtersActive() ? '<button class="btn ghost mt" data-act="clear-filters">Clear the filters</button>' : ''}</div>`;

  const groups = {};
  txns.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));

  const spent = round2(txns.reduce((a, t) => a + (t.type === 'settlement' ? 0 : t.amount), 0));
  const tally = (toks || filtersActive()) ? `<div class="section-title" style="margin-top:2px">
    ${txns.length} match${txns.length === 1 ? '' : 'es'}${spent ? ' · ' + money(spent) : ''}</div>` : '';

  return tally + Object.entries(groups).map(([date, list]) => `
    <div class="section-title">${esc(niceDate(date))}</div>
    <div class="card">${list.map(t => txnRow(t, l)).join('')}</div>`).join('');
}

/** Repaints just the results, so typing never costs the input its focus. */
function applySearch() {
  const l = ledgerById(S.params.id), box = $('#feed-list');
  if (!l || !box) return;
  box.innerHTML = feedList(l);
  const bar = $('.searchbar');
  if (bar) bar.classList.toggle('blank', !S.search);
}

/** The amber marker a row wears while it is waiting on somebody. */
function reviewPill(t) {
  if (!t.reviewState) return '';
  const need = reviewersFor(t), out = reviewOutstanding(t);
  const conflict = t.reviewState === 'conflict';
  const text = needsMyReview(t)
    ? (t.reviewState === 'flag' ? 'NEEDS YOUR OK' : conflict ? 'EDITED AT THE SAME TIME' : 'REVIEW THIS CHANGE')
    : `UNDER REVIEW${need.length > 1 ? ` · ${need.length - out.length} OF ${need.length}` : ''}`;
  return `<div style="margin-top:5px"><span class="pill ${conflict ? 'no' : 'pend'}">${conflict ? '⚠️' : '👀'} ${text}</span></div>`;
}

function txnRow(t, l) {
  const mine = S.me.id;
  const pending = S.pending[t.id];
  const gone = t.deleted ? ' gone' : '';
  if (t.type === 'settlement') {
    const from = userById(t.paidBy), to = userById(t.paidTo);
    return `<div class="row-item tap${gone}" data-txn="${esc(t.id)}">
      <div class="av m" style="background:var(--good)">🤝</div>
      <div class="grow"><div class="ttl">${esc(from.name)} paid ${esc(to.name)}</div>
      <div class="sub">${t.deleted ? 'Deleted' : 'Settle up'}${t.notes ? ' · ' + esc(t.notes) : ''}${pending ? ' · syncing' : ''}</div>
      ${reviewPill(t)}</div>
      <div class="num zero mono">${money(t.amount)}</div></div>`;
  }
  const payer = userById(t.paidBy);
  const impact = impactOf(t, mine);
  const cls = impact > 0.005 ? 'pos' : impact < -0.005 ? 'neg' : 'zero';
  const label = impact > 0.005 ? 'you lent' : impact < -0.005 ? 'you owe' : 'not you';
  return `<div class="row-item tap${gone}" data-txn="${esc(t.id)}">
    <div class="av m" style="background:${esc(l.color)}">${esc(catEmoji(t.category))}</div>
    <div class="grow">
      <div class="ttl">${esc(t.name)}${t.receiptId || t._receiptLocal ? ' 📎' : ''}</div>
      <div class="sub">${t.deleted ? `Deleted by ${esc(userById(t.reviewBy).name)}`
        : `${esc(payer.name)} paid ${money(t.amount)}`}${pending ? ' · <span style="color:var(--warn)">syncing</span>' : ''}</div>
      ${reviewPill(t)}
    </div>
    <div style="text-align:right">
      <div class="num ${cls} mono">${impact > 0.005 ? '+' : impact < -0.005 ? '−' : ''}${money(Math.abs(impact))}</div>
      <div class="tiny">${t.deleted ? 'no longer counts' : label}</div>
    </div></div>`;
}

function ledgerBalances(l) {
  const net = balancesFor(l.id);
  const ids = memberIdsOf(l.id);
  const debts = simplify(net);
  const max = Math.max(0.01, ...ids.map(i => Math.abs(net[i] || 0)));

  const rows = ids.slice().sort((a, b) => (net[b] || 0) - (net[a] || 0)).map(id => {
    const u = userById(id), v = net[id] || 0;
    const cls = v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : 'zero';
    const col = v > 0.005 ? 'var(--good)' : v < -0.005 ? 'var(--bad)' : 'var(--ink-3)';
    return `<div class="row-item">${avatar(u, 'm')}
      <div class="grow"><div class="ttl">${esc(u.name)}${id === S.me.id ? ' <span class="pill">you</span>' : ''}</div>
        <div class="bar mt" style="margin-top:6px"><i style="width:${(Math.abs(v) / max * 100).toFixed(1)}%;background:${col}"></i></div></div>
      <div class="num ${cls} mono">${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${money(Math.abs(v))}</div></div>`;
  }).join('');

  const settleList = debts.length ? debts.map(d => {
    const f = userById(d.from), t = userById(d.to);
    const involvesMe = d.from === S.me.id || d.to === S.me.id;
    // Only the person actually owed the money gets to send the reminder, and
    // only when there is an address to send it to.
    const canNudge = d.to === S.me.id && !isEntity(f) && f.notify !== false && !!f.email
      && S.apiVersion >= NEEDS_API;
    // Only offered on the row where I'm the one paying, and only when the
    // person being paid has said how to reach them.
    const iPay = d.from === S.me.id && canBePaid(t);
    return `<div class="row-item">
      ${avatar(f, 'm')}<div style="font-size:18px;color:var(--ink-3)">→</div>${avatar(t, 'm')}
      <div class="grow"><div class="ttl">${money(d.amount)}</div>
        <div class="sub">${esc(f.name)} pays ${esc(t.name)}</div></div>
      ${canNudge ? `<button class="btn sm ghost" data-nudge="${esc(d.from)}" title="Email a reminder">👋</button>` : ''}
      ${iPay ? `<button class="btn sm good" data-pay='${esc(JSON.stringify(d))}'
        title="Pay with ${esc(PAY_SERVICES[t.payType].label)}">${esc(PAY_SERVICES[t.payType].label === 'Any link' ? 'Pay' : PAY_SERVICES[t.payType].label)}</button>` : ''}
      <button class="btn sm ${involvesMe && !iPay ? 'good' : 'ghost'}" data-settle='${esc(JSON.stringify(d))}'>Settle</button></div>`;
  }).join('') : `<div class="empty" style="padding:26px"><span class="big" style="font-size:44px">🎉</span>
      <h3>Everyone's square</h3><p>Nothing owed in either direction.</p></div>`;

  // Under-review rows count like any other, so say so rather than let the
  // numbers quietly disagree with the pills on the Expenses tab.
  const open = openReviews(l.id);
  const caveat = open.length ? `<div class="card mb reviewnote">
    <div class="flex"><span style="font-size:22px">👀</span>
      <div class="grow"><div class="ttl">${open.length} ${open.length === 1 ? 'entry is' : 'entries are'} under review</div>
      <div class="sub">They're counted below, so these totals may still move.</div></div></div></div>` : '';

  return caveat + `<div class="card"><div class="section-title" style="margin-top:0">Where everyone stands</div>${rows}</div>
    <div class="card"><div class="between mb"><div class="section-title" style="margin:0">Simplest way to settle</div>
      ${debts.length ? `<span class="pill">${debts.length} payment${debts.length > 1 ? 's' : ''}</span>` : ''}</div>
      ${settleList}</div>
    <button class="btn ghost block mt" data-act="record-payment">🤝 Record a payment</button>`;
}

function ledgerCharts(l) {
  const txns = (S.txns[l.id] || []).filter(t => !t.deleted && t.type !== 'settlement');
  if (!txns.length) return `<div class="empty"><span class="big">📊</span><h3>No data yet</h3><p>Add expenses and the charts fill in.</p></div>`;
  const ids = memberIdsOf(l.id);
  const total = round2(txns.reduce((a, t) => a + t.amount, 0));

  /* by category */
  const byCat = {};
  txns.forEach(t => byCat[t.category || 'Other'] = round2((byCat[t.category || 'Other'] || 0) + t.amount));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const cols = ['#6C5CE7', '#00B894', '#FF7675', '#FDCB6E', '#0984E3', '#E84393', '#00CEC9', '#E17055', '#A29BFE'];
  let acc = 0;
  const R = 62, C = 2 * Math.PI * R;
  const arcs = cats.map(([name, v], i) => {
    const frac = v / total, dash = `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`;
    const off = -acc * C; acc += frac;
    return `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${cols[i % cols.length]}" stroke-width="30"
      stroke-dasharray="${dash}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 80 80)"/>`;
  }).join('');

  /* by person: paid vs owed */
  const paid = {}, owed = {};
  ids.forEach(i => { paid[i] = 0; owed[i] = 0; });
  txns.forEach(t => {
    paid[t.paidBy] = round2((paid[t.paidBy] || 0) + t.amount);
    Object.entries(allocate(t.amount, t.split)).forEach(([u, v]) => owed[u] = round2((owed[u] || 0) + v));
  });
  const maxP = Math.max(0.01, ...ids.map(i => Math.max(paid[i] || 0, owed[i] || 0)));

  /* by month */
  const byMonth = {};
  txns.forEach(t => { const m = (t.date || '').slice(0, 7); byMonth[m] = round2((byMonth[m] || 0) + t.amount); });
  const months = Object.keys(byMonth).sort().slice(-8);
  const maxM = Math.max(0.01, ...months.map(m => byMonth[m]));

  const biggest = txns.slice().sort((a, b) => b.amount - a.amount)[0];
  const topSpender = ids.slice().sort((a, b) => (paid[b] || 0) - (paid[a] || 0))[0];
  const avg = round2(total / txns.length);

  return `
  <div class="card"><div class="flex" style="gap:10px">
    <div class="stat"><b class="mono">${money(total)}</b><span>total</span></div>
    <div class="stat"><b class="mono">${txns.length}</b><span>expenses</span></div>
    <div class="stat"><b class="mono">${money(avg)}</b><span>average</span></div>
  </div></div>

  <div class="card"><div class="section-title" style="margin-top:0">Where the money went</div>
    <svg class="donut" width="160" height="160" viewBox="0 0 160 160">${arcs}
      <text x="80" y="76" text-anchor="middle" font-size="13" font-weight="800" fill="var(--ink-3)">total</text>
      <text x="80" y="96" text-anchor="middle" font-size="17" font-weight="900" fill="var(--ink)">${esc(money(total))}</text>
    </svg>
    <div class="legend">${cats.slice(0, 9).map(([n, v], i) =>
      `<div><span class="dot" style="background:${cols[i % cols.length]}"></span>${esc(catEmoji(n))} ${esc(n)}
      <b class="mono">${esc(money(v))}</b></div>`).join('')}</div>
  </div>

  <div class="card"><div class="section-title" style="margin-top:0">Paid vs. fair share</div>
    ${ids.map(id => {
      const u = userById(id);
      return `<div style="padding:9px 0">
        <div class="between" style="margin-bottom:6px">
          <div class="flex" style="gap:8px">${avatar(u, 's')}<b style="font-size:14.5px">${esc(u.name)}</b></div>
          <div class="tiny mono">paid ${money(paid[id] || 0)} · owed ${money(owed[id] || 0)}</div></div>
        <div class="bar" style="margin-bottom:4px"><i style="width:${((paid[id] || 0) / maxP * 100).toFixed(1)}%;background:var(--violet)"></i></div>
        <div class="bar"><i style="width:${((owed[id] || 0) / maxP * 100).toFixed(1)}%;background:var(--teal)"></i></div>
      </div>`;
    }).join('')}
    <div class="legend"><div><span class="dot" style="background:var(--violet)"></span>paid</div>
      <div><span class="dot" style="background:var(--teal)"></span>their share</div></div>
  </div>

  ${months.length > 1 ? `<div class="card"><div class="section-title" style="margin-top:0">Month by month</div>
    <div class="spark">${months.map(m => `<i style="height:${(byMonth[m] / maxM * 100).toFixed(1)}%" title="${esc(m)}: ${esc(money(byMonth[m]))}"></i>`).join('')}</div>
    <div class="flex mt" style="justify-content:space-between">${months.map(m =>
      `<span class="tiny" style="flex:1;text-align:center">${new Date(m + '-02').toLocaleDateString(undefined, { month: 'short' })}</span>`).join('')}</div>
  </div>` : ''}

  <div class="card"><div class="section-title" style="margin-top:0">Fun facts</div>
    <div class="row-item"><div class="av m" style="background:var(--sun)">🏆</div><div class="grow">
      <div class="ttl">${esc(userById(topSpender).name)}</div><div class="sub">has fronted the most cash</div></div>
      <div class="num mono">${money(paid[topSpender] || 0)}</div></div>
    <div class="row-item"><div class="av m" style="background:var(--coral)">💥</div><div class="grow">
      <div class="ttl">${esc(biggest.name)}</div><div class="sub">biggest single expense</div></div>
      <div class="num mono">${money(biggest.amount)}</div></div>
  </div>`;
}

/* ─────────────────────────────────────────────────── everything at once */
/**
 * One row per person, netted across every active ledger, each opening out into
 * the ledgers that make it up. Nothing is settled from here on purpose: a debt
 * lives on a ledger, and paying one house's balance with another's would make
 * both wrong.
 */
function viewPeople() {
  const people = overallByPerson();
  if (!people.length) return shell('Everyone', `<div class="empty"><span class="big">🎉</span>
    <h3>Nothing outstanding</h3><p>You're square with everybody, everywhere.</p></div>`, { back: true });

  const owedToMe = round2(people.filter(p => p.net > 0).reduce((a, p) => a + p.net, 0));
  const iOwe = round2(-people.filter(p => p.net < 0).reduce((a, p) => a + p.net, 0));

  return shell('Everyone', `
    <div class="card"><div class="flex" style="gap:10px">
      <div class="stat"><b class="mono" style="color:var(--good)">${money(owedToMe)}</b><span>owed to you</span></div>
      <div class="stat"><b class="mono" style="color:var(--bad)">${money(iOwe)}</b><span>you owe</span></div>
    </div></div>

    ${people.map(p => {
      const u = userById(p.id);
      const them = p.net > 0;
      return `<div class="card">
        <div class="row-item" style="padding-top:0">${avatar(u, 'm')}
          <div class="grow"><div class="ttl">${esc(u.name)}</div>
            <div class="sub">${them ? 'owes you' : 'you owe them'}</div></div>
          <div class="num ${them ? 'pos' : 'neg'} mono">${money(Math.abs(p.net))}</div></div>
        ${p.parts.length > 1 ? p.parts.slice().sort((a, b) => b.amount - a.amount).map(part => {
          const l = ledgerById(part.ledgerId);
          if (!l) return '';
          return `<div class="row-item tap" data-ledger="${esc(l.id)}" style="padding:7px 0">
            <div class="av s" style="background:${esc(l.color)}">${esc(l.emoji)}</div>
            <div class="grow"><div class="sub">${esc(l.name)}</div></div>
            <div class="num ${part.amount > 0 ? 'pos' : 'neg'} mono" style="font-size:14px">
              ${part.amount > 0 ? '+' : '−'}${money(Math.abs(part.amount))}</div></div>`;
        }).join('')
        : `<div class="row-item tap" data-ledger="${esc(p.parts[0].ledgerId)}" style="padding:7px 0">
            <div class="av s" style="background:${esc((ledgerById(p.parts[0].ledgerId) || {}).color || '#888')}">
              ${esc((ledgerById(p.parts[0].ledgerId) || {}).emoji || '💸')}</div>
            <div class="grow"><div class="sub">on ${esc((ledgerById(p.parts[0].ledgerId) || {}).name || '—')}</div></div>
            <div>›</div></div>`}
      </div>`;
    }).join('')}

    <p class="hint center mt">Debts live on their own ledger — open one to settle up there.</p>`,
    { back: true });
}

/* ─────────────────────────────────────────────────────────────── profile */
function viewProfile() {
  const u = S.me;
  return shell('Your profile', `
    <div class="card center">
      <div style="display:inline-block;position:relative">${avatar(u, 'xl')}</div>
      <div class="mt"><button class="btn sm ghost" data-act="pick-avatar">📷 Change photo</button>
        ${u.avatar ? `<button class="btn sm ghost" data-act="clear-avatar">Remove</button>` : ''}</div>
      <h2 class="mt">${esc(u.name)}</h2><p class="hint">@${esc(u.username)}${isAdmin() ? ' · admin 👑' : ''}</p>
    </div>
    <div class="card">
      <div class="row-item tap" data-act="change-password"><div class="av m" style="background:var(--sky)">🔑</div>
        <div class="grow"><div class="ttl">Change password</div><div class="sub">Sets a new one for this account</div></div><div>›</div></div>
      <div class="row-item tap" data-act="signout-everywhere"><div class="av m" style="background:var(--warn)">📵</div>
        <div class="grow"><div class="ttl">Sign out other devices</div>
          <div class="sub">Kicks out every session except this one</div></div><div>›</div></div>
      <div class="row-item tap" data-act="full-resync"><div class="av m" style="background:var(--teal)">♻️</div>
        <div class="grow"><div class="ttl">Rebuild local data</div><div class="sub">Re-download everything from the sheet</div></div><div>›</div></div>
      <div class="row-item tap" data-act="signout"><div class="av m" style="background:var(--bad)">👋</div>
        <div class="grow"><div class="ttl">Sign out</div><div class="sub">Clears this device</div></div><div>›</div></div>
    </div>

    <div class="section-title">Email</div>
    <div class="card">
      <div class="field"><label>Where to reach you</label>
        <input class="input" id="p-email" type="email" inputmode="email" autocomplete="email"
          placeholder="you@example.com" value="${esc(u.email || '')}"></div>
      <div class="row-item tap" data-act="toggle-notify">
        <div class="av m" style="background:${u.notify === false ? 'var(--ink-3)' : 'var(--good)'}">${u.notify === false ? '🔕' : '🔔'}</div>
        <div class="grow"><div class="ttl">Email me updates</div>
          <div class="sub">${u.notify === false
            ? 'Off — no summaries, and nobody can nudge you'
            : 'Where you stand, what changed, and anything waiting on you'}</div></div>
        <span class="pill ${u.notify === false ? 'no' : 'ok'}">${u.notify === false ? 'OFF' : 'ON'}</span></div>
      <button class="btn block mt" data-act="save-profile">Save</button>
      <p class="hint">${u.email
        ? 'Summaries follow the schedule your admin sets. Nudges arrive when somebody you owe sends one.'
        : "Without an address there's nothing to send to — everything else works exactly the same."}</p>
    </div>

    <div class="section-title">Getting paid</div>
    <div class="card">
      <div class="field"><label>Pay me with</label>
        <div class="chips">${Object.entries(PAY_SERVICES).map(([k, s]) =>
          `<button class="chip ${u.payType === k ? 'on' : ''}" data-pt="${k}">${esc(s.label)}</button>`).join('')}
          ${u.payType ? `<button class="chip ghost" data-pt="">✕ None</button>` : ''}</div></div>
      ${u.payType ? `<div class="field"><label>${esc(PAY_SERVICES[u.payType].label)} ${u.payType === 'link' ? 'URL' : 'handle'}</label>
        <input class="input" id="p-handle" inputmode="${u.payType === 'link' ? 'url' : 'text'}"
          autocapitalize="off" autocorrect="off" spellcheck="false"
          placeholder="${esc(PAY_SERVICES[u.payType].hint)}" value="${esc(u.payHandle || '')}"></div>
        <button class="btn block" data-act="save-pay">Save</button>` : ''}
      <p class="hint">${u.payHandle
        ? "Anyone who owes you sees a one-tap button that opens " + esc(PAY_SERVICES[u.payType].label) +
          " with the amount already filled in. It never moves money by itself — you both still confirm."
        : "Add one and anybody settling up with you gets a button that opens it with the amount filled in."}</p>
    </div>

    <div class="section-title">App &amp; updates</div>
    <div class="card">
      <div class="row-item">
        <div class="av m" style="background:var(--violet)">📦</div>
        <div class="grow"><div class="ttl">Version</div>
          <div class="sub mono">${esc(APP_BUILD)}${Updater.swBuild && Updater.swBuild !== APP_BUILD
            ? ' · worker ' + esc(Updater.swBuild) : ''}</div></div>
        ${S.updateReady ? '<span class="pill pend">UPDATE READY</span>' : '<span class="pill ok">CURRENT</span>'}
      </div>
      ${S.updateReady ? `
      <div class="row-item tap" data-act="apply-update"><div class="av m" style="background:var(--good)">✨</div>
        <div class="grow"><div class="ttl">Restart to update</div>
          <div class="sub">Takes a second. Queued changes are kept.</div></div><div>›</div></div>` : `
      <div class="row-item tap" data-act="check-update"><div class="av m" style="background:var(--sky)">🔄</div>
        <div class="grow"><div class="ttl">Check for updates</div>
          <div class="sub">Looks for a newer build right now</div></div><div>›</div></div>`}
      <div class="row-item tap" data-act="hard-reset"><div class="av m" style="background:var(--warn)">🧹</div>
        <div class="grow"><div class="ttl">Clear cache &amp; reload</div>
          <div class="sub">If it's still stuck on an old version</div></div><div>›</div></div>
      <p class="hint">Your ledgers and anything waiting to sync are stored separately — none of
        these touch them.</p>
    </div>

    <p class="hint center mt2">Server: ${esc((S.api || '').slice(0, 46))}…<br>
      <a href="#" data-act="change-api">Change server</a></p>`, { back: true });
}

/* ────────────────────────────────────────────────────────────────── admin */
function viewAdmin() {
  if (!isAdmin()) return shell('Settings', `<div class="empty"><span class="big">🔒</span><h3>Admins only</h3></div>`, { back: true });
  const users = S.users;
  return shell('Settings', `
    <div class="section-title" style="margin-top:6px">People</div>
    <div class="card">
      ${users.map(u => `<div class="row-item tap" data-user="${esc(u.id)}">
        ${avatar(u, 'm')}
        <div class="grow"><div class="ttl">${esc(u.name)} ${u.role === 'admin' ? '<span class="pill">admin</span>' : ''}</div>
          <div class="sub">${isEntity(u) ? 'Not a person — no login' : '@' + esc(u.username) + (u.email ? ' · ' + esc(u.email) : '')}</div></div>
        ${!u.active ? '<span class="pill no">off</span>'
          : isEntity(u) ? '<span class="pill">🏢</span>'
          : !u.hasPassword ? '<span class="pill pend">no password</span>' : ''}
        <div>›</div></div>`).join('')}
      <button class="btn ghost block mt" data-act="new-user">+ Add someone</button>
    </div>

    <div class="section-title">Ledgers</div>
    <div class="card">
      ${S.ledgers.map(l => `<div class="row-item tap" data-editledger="${esc(l.id)}">
        <div class="av m" style="background:${esc(l.color)}">${esc(l.emoji)}</div>
        <div class="grow"><div class="ttl">${esc(l.name)}</div>
          <div class="sub">${memberIdsOf(l.id).length} people · ${(S.txns[l.id] || []).filter(t => !t.deleted).length} entries</div></div>
        ${l.archived ? '<span class="pill">archived</span>' : ''}<div>›</div></div>`).join('') || '<p class="hint">None yet.</p>'}
      <button class="btn ghost block mt" data-act="new-ledger">+ Create a ledger</button>
    </div>

    <div class="section-title">Security</div>
    <div class="card">
      <div class="row-item tap" data-act="set-gate">
        <div class="av m" style="background:${S.config.gated ? 'var(--good)' : 'var(--ink-3)'}">🔐</div>
        <div class="grow"><div class="ttl">Shared access phrase</div>
          <div class="sub">${S.config.gated
            ? 'On — required before the login screen appears'
            : 'Off — anyone with the server URL sees the login screen'}</div></div>
        <span class="pill ${S.config.gated ? 'ok' : ''}">${S.config.gated ? 'ON' : 'OFF'}</span></div>
      <div class="row-item"><div class="av m" style="background:var(--sun)">🛡️</div>
        <div class="grow"><div class="ttl">Brute-force protection</div>
          <div class="sub">8 wrong passwords locks an account for 15 minutes</div></div>
        <span class="pill ok">ON</span></div>
    </div>

    <div class="section-title">Categories</div>
    <div class="card">
      <div class="row-item tap" data-act="categories"><div class="av m" style="background:var(--sun)">🏷️</div>
        <div class="grow"><div class="ttl">Expense categories</div>
          <div class="sub">${categories().length} in use${S.config.categories ? '' : ' · the built-in set'}</div></div>
        <div>›</div></div>
    </div>

    <div class="section-title">Notifications</div>
    <div class="card">
      ${S.config.jobs === false ? `<div class="card mb reviewnote"><div class="flex">
        <span style="font-size:22px">⏰</span><div class="grow">
          <div class="ttl">Background jobs aren't running</div>
          <div class="sub" style="white-space:normal">Repeating expenses and email summaries both need them.
            Open your spreadsheet and choose <b>SplitStack ▸ Check background jobs</b>.</div></div></div></div>` : ''}
      <div class="field"><label>Email summary</label>
        <div class="seg">${[['off', 'Off'], ['weekly', 'Weekly'], ['daily', 'Daily']].map(([v, lbl]) =>
          `<button data-digest="${v}" class="${(S.config.digest || 'weekly') === v ? 'on' : ''}">${lbl}</button>`).join('')}</div>
        <p class="hint">Sent in the morning${(S.config.digest || 'weekly') === 'weekly' ? ' on Mondays' : ''} to
          everyone with an address on file. Quiet weeks send nothing at all.</p></div>
      <div class="row-item tap" data-act="test-digest"><div class="av m" style="background:var(--sky)">✉️</div>
        <div class="grow"><div class="ttl">Send me one now</div>
          <div class="sub">A real summary, to your address only</div></div><div>›</div></div>
    </div>

    <div class="section-title">App</div>
    <div class="card">
      <div class="field"><label>App name</label><input class="input" id="a-name" value="${esc(S.config.appName || 'SplitStack')}"></div>
      <div class="grid2">
        <div class="field"><label>Currency code</label><input class="input" id="a-cur" value="${esc(S.config.currency || 'USD')}"></div>
        <div class="field"><label>Symbol</label><input class="input" id="a-sym" value="${esc(S.config.symbol || '$')}"></div>
      </div>
      <button class="btn block" data-act="save-config">Save</button>
    </div>`, { back: true });
}

/* ═══════════════════════════════════════════════ saved splits & repeats */
const REPEATS = [['never', "Doesn't repeat"], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const REPEAT_LABEL = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
const REPEAT_ADVERB = { weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };

const ORDINAL = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

/** Plain English for what a schedule will actually do. */
function repeatBlurb(freq, date) {
  if (!freq || freq === 'never' || !date) return '';
  const d = new Date(date + 'T00:00:00');
  const next = addPeriodISO(date, freq, 1, Number(date.slice(8, 10)));
  const when = freq === 'weekly' ? `every ${d.toLocaleDateString(undefined, { weekday: 'long' })}`
    : freq === 'yearly' ? `every year on ${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
    : `on the ${ORDINAL(Number(date.slice(8, 10)))} of each month`;
  return `Posts ${when} — next on ${niceDate(next)}.`;
}

/** The ledger's starting split, or null for "evenly". */
const defaultSplitOf = l => (l && l.defaultSplit) || null;

/** Members the ledger's default split doesn't mention — usually people who joined later. */
function notInDefault(split, ids) {
  if (!split) return [];
  return ids.filter(i => !(i in split));
}

/**
 * Fold missing members into a split without throwing away the ratio between
 * the people already in it. Newcomers take an even share of the whole; what is
 * left is divided among the existing shares in their original proportions, so
 * 60/40 plus a third person becomes 40/26.67/33.33 rather than a flat third
 * each. The last share absorbs the rounding drift so it always totals 100.
 */
function includeEqually(split, ids) {
  const missing = notInDefault(split, ids);
  if (!missing.length) return Object.assign({}, split);
  const existing = Object.keys(split || {}).filter(i => ids.includes(i));
  if (!existing.length) {
    const even = {}; ids.forEach(i => even[i] = 0);
    return normaliseSplit(Object.keys(even).reduce((a, k) => (a[k] = 1, a), {}), ids);
  }
  const each = 100 / ids.length;
  const forExisting = 100 - each * missing.length;
  const oldTotal = existing.reduce((a, i) => a + (Number(split[i]) || 0), 0) || 1;
  const out = {};
  let acc = 0;
  const order = existing.concat(missing);
  order.forEach((i, n) => {
    if (n === order.length - 1) { out[i] = round2(100 - acc); return; }
    const v = existing.includes(i) ? round2((Number(split[i]) || 0) / oldTotal * forExisting) : round2(each);
    out[i] = v; acc = round2(acc + v);
  });
  return out;
}

/**
 * The chips above the member toggles: the ledger's default, then any saved
 * splits, then the way to save one. Hidden entirely on a small ledger with
 * nothing set up, where the row would be pure noise — but a default counts as
 * something set up, which is what finally gives a two-person 60/40 ledger a
 * one-tap way back to its own baseline.
 */
function presetChips(ledger, ids) {
  const list = presetsOf(ledger);
  const def = defaultSplitOf(ledger);
  if (!list.length && !def && ids.length < 3) return '';
  return `<div class="chips mb">
    ${def ? `<button class="chip ghost" data-preset="__default" title="The ledger's default split">⭐ Default</button>` : ''}
    ${list.map(p => `<button class="chip ghost" data-preset="${esc(p.id)}" title="${esc(p.name)}">
      🔖 ${esc(p.name)}</button>`).join('')}
    <button class="chip ghost" data-preset="__save">${list.length ? '＋ Save / manage' : '＋ Save this split'}</button>
  </div>`;
}

/**
 * Type percentages against a fixed set of people. Deliberately simpler than the
 * splitter inside the expense sheet — there is no amount to allocate and no
 * money to show, so it is percentages, a running total, and a way to even them
 * out. Used for the ledger default and for a repeating rule's split.
 */
function splitEditorSheet({ title, subtitle, ids, split, confirmLabel = 'Save', allowEven = true, onSave }) {
  const st = { parts: {} };
  const even = () => {
    const each = Math.floor((100 / ids.length) * 100) / 100;
    st.parts = {};
    ids.forEach(i => st.parts[i] = each);
    const drift = round2(100 - each * ids.length);
    if (Math.abs(drift) > 0.001) st.parts[ids[0]] = round2(st.parts[ids[0]] + drift);
  };
  const seeded = normaliseSplit(split || {}, ids);
  if (seeded && !notInDefault(seeded, ids).length) ids.forEach(i => st.parts[i] = seeded[i]);
  else if (seeded) ids.forEach(i => st.parts[i] = seeded[i] !== undefined ? seeded[i] : 0);
  else even();

  const total = () => round2(ids.reduce((a, i) => a + (Number(st.parts[i]) || 0), 0));
  const sheet = openSheet('<div id="se-body"></div>');

  const draw = () => {
    const t = total(), ok = Math.abs(t - 100) < 0.05;
    $('#se-body', sheet).innerHTML = `
      <h2>${esc(title)}</h2>
      <p class="sheet-sub">${esc(subtitle)}</p>
      ${ids.map(i => { const u = userById(i);
        return `<div class="split-row">${avatar(u, 's')}
          <div class="grow"><div class="ttl" style="font-size:14.5px">${esc(u.name)}</div></div>
          <div class="pctbox"><input type="text" inputmode="decimal" data-part="${esc(i)}"
            value="${esc(String(round2(Number(st.parts[i]) || 0)))}"><span>%</span></div></div>`;
      }).join('')}
      <div class="total-bar ${ok ? 'ok' : 'bad'}"><span>Total</span><span class="mono">${t}%</span></div>
      ${allowEven ? `<button class="btn ghost block mt" data-x="even">Split evenly</button>` : ''}
      <div class="flex mt">
        <button class="btn ghost grow" data-x="cancel">Cancel</button>
        <button class="btn grow" data-x="save">${esc(confirmLabel)}</button></div>`;
  };

  const read = () => $$('[data-part]', sheet).forEach(el => {
    const v = parseFloat(el.value || '0');
    st.parts[el.dataset.part] = isNaN(v) ? 0 : Math.max(0, v);
  });

  sheet.addEventListener('input', e => {
    if (!e.target.dataset || !e.target.dataset.part) return;
    read();
    const t = total(), ok = Math.abs(t - 100) < 0.05;
    const bar = $('.total-bar', sheet);
    if (bar) { bar.className = 'total-bar ' + (ok ? 'ok' : 'bad'); bar.lastElementChild.textContent = t + '%'; }
  });

  sheet.addEventListener('click', e => {
    const el = e.target.closest('[data-x]'); if (!el) return;
    read();
    if (el.dataset.x === 'cancel') return sheet.close();
    if (el.dataset.x === 'even') { even(); haptic(); return draw(); }
    if (el.dataset.x === 'save') {
      if (Math.abs(total() - 100) > 0.05) return toast('The split has to add up to 100%');
      const out = {};
      ids.forEach(i => { const v = round2(Number(st.parts[i]) || 0); if (v > 0) out[i] = v; });
      if (!Object.keys(out).length) return toast('Somebody has to have a share');
      sheet.close();
      onSave(out);
    }
  });

  draw();
}

/**
 * Name the split you have set up, and tidy up the ones you saved before.
 * Membership is the bar, not admin: the person who enters the rent is not
 * necessarily the person who made the ledger.
 */
function presetSheet(ledger, currentSplit, onDone) {
  const ids = memberIdsOf(ledger.id);
  const usable = normaliseSplit(currentSplit, ids);
  const sheet = openSheet('<div id="ps-body"></div>', { onClose: () => onDone && onDone() });

  const draw = () => {
    const list = presetsOf(ledger);
    $('#ps-body', sheet).innerHTML = `
      <h2>Saved splits</h2>
      <p class="sheet-sub">Rent 40/30/30, or everyone-but-Ben. Save it once, tap it after that.</p>

      ${usable ? `<div class="field"><label>Save what you have now</label>
        <div class="card mb" style="padding:12px">
          ${Object.keys(usable).map(i => `<div class="row-item" style="padding:5px 0">
            ${avatar(userById(i), 's')}<div class="grow"><div class="ttl" style="font-size:14px">${esc(userById(i).name)}</div></div>
            <div class="num mono" style="font-size:14px">${round2(usable[i])}%</div></div>`).join('')}
        </div>
        <div class="flex"><input class="input grow" id="ps-name" maxlength="40" placeholder="Rent split">
          <button class="btn" data-x="save">Save</button></div></div>`
        : `<p class="hint">Pick who splits it first, then come back to save that as a preset.</p>`}

      ${list.length ? `<div class="section-title">Saved on this ledger</div>
        <div class="card">${list.map(p => `<div class="row-item">
          <div class="av m" style="background:${esc(ledger.color)}">🔖</div>
          <div class="grow"><div class="ttl">${esc(p.name)}</div>
            <div class="sub">${Object.keys(p.split).map(i => esc(userById(i).name.split(' ')[0]) +
              ' ' + round2(p.split[i]) + '%').join(' · ')}</div></div>
          <button class="iconbtn" data-del="${esc(p.id)}" title="Delete">🗑</button></div>`).join('')}</div>` : ''}

      <button class="btn ghost block mt" data-x="close">Done</button>`;
  };

  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-x],[data-del]');
    if (!el) return;
    if (el.dataset.x === 'close') return sheet.close();
    if (el.dataset.del) {
      const next = presetsOf(ledger).filter(p => p.id !== el.dataset.del);
      await queuePresets(ledger.id, next);
      haptic(); toast('Deleted');
      return draw();
    }
    if (el.dataset.x === 'save') {
      const name = ($('#ps-name', sheet) || {}).value.trim();
      if (!name) return toast('Give it a name');
      if (!usable) return toast('Pick who splits it first');
      const list = presetsOf(ledger);
      if (list.length >= 12) return toast('Twelve saved splits is the limit');
      // Saving over a name you already used replaces it rather than making a
      // second chip that looks identical.
      const at = list.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
      const entry = { id: at >= 0 ? list[at].id : 'pst_' + Date.now().toString(36), name, split: usable };
      const next = list.slice();
      if (at >= 0) next[at] = entry; else next.push(entry);
      await queuePresets(ledger.id, next);
      haptic(25); toast(`Saved “${name}” ✓`);
      return draw();
    }
  });

  draw();
}

/* ══════════════════════════════════════════════════════ sheets: expense */
function expenseSheet(ledger, existing) {
  const ids = memberIdsOf(ledger.id);
  const t = existing || {
    id: uuid(), type: 'expense', date: todayISO(), name: '', category: firstCategory(), amount: 0,
    paidBy: S.me.id, enteredBy: S.me.id, notes: '', split: {}, receiptId: ''
  };
  // editor state
  const ed = {
    id: t.id, date: t.date, name: t.name, category: t.category || firstCategory(),
    amount: t.amount || 0, paidBy: t.paidBy || S.me.id, notes: t.notes || '',
    mode: 'equal', receiptId: t.receiptId || '', receiptLocal: t._receiptLocal || '',
    receiptPreview: '',
    parts: Object.assign({}, t.split),
    on: {}, locked: {},
    // Repeating is offered on the way in only. Turning an entry that already
    // exists into a rule would need the row to remember which rule it made, or
    // every re-save would spawn another one.
    repeat: 'never', repeatReview: false
  };
  const fromRule = /^rec_/.test(t.id || '');
  // A new expense starts from the ledger's default split when it has one, and
  // evenly when it doesn't. An existing expense always starts from its own.
  const ledgerDefault = existing ? null : normaliseSplit(defaultSplitOf(ledger) || {}, ids);
  if (ledgerDefault) {
    Object.keys(ledgerDefault).forEach(i => { ed.on[i] = true; ed.parts[i] = ledgerDefault[i]; });
    ed.mode = isEvenSplit(ledgerDefault) ? 'equal' : 'percent';
  } else if (!Object.keys(ed.parts).length) ids.forEach(i => ed.on[i] = true);
  else ids.forEach(i => { if (ed.parts[i] !== undefined) ed.on[i] = true; });
  if (existing && Object.keys(t.split).length) {
    const eq = 100 / Object.keys(t.split).length;
    ed.mode = Object.values(t.split).every(v => Math.abs(v - eq) < 0.02) ? 'equal' : 'percent';
  }

  const sheet = openSheet(`<div id="ex-body"></div>`);
  const body = () => $('#ex-body', sheet);

  function equalise() {
    const on = ids.filter(i => ed.on[i]);
    if (!on.length) { ed.parts = {}; return; }
    const each = Math.floor((100 / on.length) * 100) / 100;
    ed.parts = {};
    on.forEach(i => ed.parts[i] = each);
    const drift = round2(100 - each * on.length);
    if (Math.abs(drift) > 0.001) ed.parts[on[0]] = round2(ed.parts[on[0]] + drift);
  }
  if (ed.mode === 'equal') equalise();

  const sum = () => round2(ids.filter(i => ed.on[i]).reduce((a, i) => a + (Number(ed.parts[i]) || 0), 0));

  /** Live money-per-person. Exact-to-the-cent once the split totals 100. */
  function liveShares() {
    const on = ids.filter(i => ed.on[i]);
    const split = {}; on.forEach(i => split[i] = Number(ed.parts[i]) || 0);
    if (Math.abs(sum() - 100) < 0.05) return allocate(ed.amount, split);
    const out = {}; on.forEach(i => out[i] = round2(ed.amount * (split[i] || 0) / 100));
    return out;
  }

  function draw() {
    const on = ids.filter(i => ed.on[i]);
    const total = sum();
    const ok = Math.abs(total - 100) < 0.05;
    const shares = liveShares();
    body().innerHTML = `
      <h2>${existing ? 'Edit expense' : 'New expense'}</h2>
      <p class="sheet-sub">${esc(ledger.emoji)} ${esc(ledger.name)}</p>

      <div class="amount-wrap mb"><span class="cur">${esc(S.config.symbol || '$')}</span>
        <input id="f-amount" type="text" inputmode="decimal" placeholder="0.00" value="${ed.amount ? esc(String(ed.amount)) : ''}"></div>

      <div class="field"><label>What was it</label>
        <input class="input" id="f-name" placeholder="Pizza night" value="${esc(ed.name)}"></div>

      <div class="field"><label>Category</label>
        <div class="chips" id="cat-chips">${categories().map(([e, n]) =>
          `<button class="chip ${ed.category === n ? 'on' : ''}" data-cat="${esc(n)}">${e} ${esc(n)}</button>`).join('')}</div></div>

      <div class="field"><label>Date</label><input class="input" id="f-date" type="date" value="${esc(ed.date)}"></div>

      ${existing ? (fromRule ? `<div class="field"><div class="hint" style="margin:0">
          🔁 This one was posted by a repeating rule. Editing it here changes this month only —
          use <b>Repeating</b> on the ledger to change the rule itself.</div></div>` : '')
        : `<div class="field"><label>Repeats</label>
        <div class="chips">${REPEATS.map(([v, lbl]) =>
          `<button class="chip ${ed.repeat === v ? 'on' : ''}" data-rep="${esc(v)}">${lbl}</button>`).join('')}</div>
        ${ed.repeat !== 'never' ? `<div class="hint" style="margin:8px 0 0">
          ${esc(repeatBlurb(ed.repeat, ed.date))}</div>
          <button class="chip mt ${ed.repeatReview ? 'on' : ''}" data-repreview="1">
            ${ed.repeatReview ? '☑' : '☐'} Ask everyone to check each one</button>` : ''}</div>`}

      <div class="field"><label>Who paid</label>
        <div class="chips">${ids.map(i => { const u = userById(i);
          return `<button class="chip ${ed.paidBy === i ? 'on' : ''}" data-paid="${esc(i)}">${avatar(u, 's')}${esc(u.name)}</button>`; }).join('')}</div></div>

      <div class="field"><label>Split between</label>
        ${presetChips(ledger, ids)}
        <div class="chips mb">${ids.map(i => { const u = userById(i);
          return `<button class="chip ${ed.on[i] ? 'on' : ''}" data-tog="${esc(i)}">${avatar(u, 's')}${esc(u.name)}</button>`; }).join('')}</div>
        <div class="seg mb">
          <button data-mode="equal" class="${ed.mode === 'equal' ? 'on' : ''}">Equal</button>
          <button data-mode="percent" class="${ed.mode === 'percent' ? 'on' : ''}">%</button>
          <button data-mode="amount" class="${ed.mode === 'amount' ? 'on' : ''}">${esc(S.config.symbol || '$')}</button>
        </div>
        ${on.length ? on.map(i => {
          const u = userById(i), pct = Number(ed.parts[i]) || 0;
          const shown = ed.mode === 'amount' ? (shares[i] || 0).toFixed(2) : String(round2(pct));
          return `<div class="split-row">
            ${avatar(u, 's')}<div class="grow"><div class="ttl" style="font-size:14.5px">${esc(u.name)}</div>
              <div class="sub mono">${esc(money(shares[i] || 0))} · ${round2(pct)}%</div></div>
            ${ed.mode === 'percent' ? `<button class="lock ${ed.locked[i] ? 'on' : ''}" data-lock="${esc(i)}" title="Lock">${ed.locked[i] ? '🔒' : '🔓'}</button>` : ''}
            <div class="pctbox"><input type="text" inputmode="decimal" data-part="${esc(i)}" value="${esc(shown)}"
              ${ed.mode === 'equal' ? 'disabled' : ''}><span>${ed.mode === 'amount' ? esc(S.config.symbol || '$') : '%'}</span></div>
          </div>`;
        }).join('') : '<p class="hint">Pick at least one person.</p>'}
        <div class="total-bar ${on.length ? (ok ? 'ok' : 'bad') : ''}">
          <span>${ed.mode === 'amount' ? 'Allocated' : 'Total split'}</span>
          <span class="mono">${ed.mode === 'amount' ? esc(money(ed.amount * total / 100)) + ' / ' + esc(money(ed.amount)) : round2(total) + '%'}</span>
        </div>
      </div>

      <div class="field"><label>Receipt</label>
        ${ed.receiptPreview || ed.receiptId ? `<div class="flex mb">
          ${ed.receiptPreview ? `<img src="${ed.receiptPreview}" style="width:72px;height:72px;object-fit:cover;border-radius:14px">` :
            `<div class="av l" style="background:var(--card-2);color:var(--ink-3)">📎</div>`}
          <button class="btn sm ghost" data-act="rm-receipt">Remove</button></div>` : ''}
        <button class="btn ghost block" data-act="add-receipt">📷 ${ed.receiptPreview || ed.receiptId ? 'Replace photo' : 'Attach a photo'}</button></div>

      <div class="field"><label>Notes</label>
        <textarea class="input" id="f-notes" placeholder="Anything worth remembering">${esc(ed.notes)}</textarea></div>

      <div class="flex mt">
        ${existing ? `<button class="btn ghost" data-act="del-expense">🗑</button>` : ''}
        <button class="btn ghost grow" data-act="cancel">Cancel</button>
        <button class="btn grow" data-act="save-expense">${existing ? 'Save' : 'Add it'}</button>
      </div>`;
  }

  function readFields() {
    const a = parseFloat(($('#f-amount', sheet) || {}).value || '0');
    ed.amount = isNaN(a) ? 0 : Math.max(0, a);
    ed.name = ($('#f-name', sheet) || {}).value || '';
    ed.date = ($('#f-date', sheet) || {}).value || todayISO();
    ed.notes = ($('#f-notes', sheet) || {}).value || '';
  }

  /** Redistribute unlocked shares so everything totals 100. */
  function rebalance(changedId) {
    const on = ids.filter(i => ed.on[i]);
    const free = on.filter(i => i !== changedId && !ed.locked[i]);
    if (!free.length) return;
    const fixed = on.filter(i => i === changedId || ed.locked[i])
      .reduce((a, i) => a + (Number(ed.parts[i]) || 0), 0);
    let rest = round2(100 - fixed);
    if (rest < 0) rest = 0;
    const each = Math.floor((rest / free.length) * 100) / 100;
    free.forEach(i => ed.parts[i] = each);
    const drift = round2(rest - each * free.length);
    if (Math.abs(drift) > 0.001) ed.parts[free[0]] = round2(ed.parts[free[0]] + drift);
  }

  /** Load a saved split into the editor, keeping only people still on the ledger. */
  function applyPreset(p) {
    const split = normaliseSplit(p.split, ids);
    if (!split) return toast('Nobody in that split is on this ledger any more');
    ed.on = {}; ed.locked = {}; ed.parts = {};
    Object.keys(split).forEach(i => { ed.on[i] = true; ed.parts[i] = split[i]; });
    ed.mode = isEvenSplit(split) ? 'equal' : 'percent';
    if (ed.mode === 'equal') equalise();
    haptic(); toast(`Split: ${p.name}`);
  }

  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-cat],[data-paid],[data-tog],[data-mode],[data-lock],[data-rep],[data-repreview],[data-preset],[data-act]');
    if (!el) return;
    readFields();
    // Picking one yourself ends the guessing for this expense — being quietly
    // overruled by a keyword list is worse than typing it in.
    if (el.dataset.cat) { ed.category = el.dataset.cat; ed.catTouched = true; haptic(); }
    else if (el.dataset.rep) { ed.repeat = el.dataset.rep; haptic(); }
    else if (el.dataset.repreview) { ed.repeatReview = !ed.repeatReview; haptic(); }
    else if (el.dataset.preset) {
      if (el.dataset.preset === '__save') {
        // Opens on top rather than replacing this sheet — a half-filled
        // expense must not be lost to a detour through a settings screen.
        const on = ids.filter(i => ed.on[i]);
        const split = {}; on.forEach(i => split[i] = round2(Number(ed.parts[i]) || 0));
        presetSheet(ledger, split, () => draw());
        return;
      }
      if (el.dataset.preset === '__default') {
        const d = defaultSplitOf(ledger);
        if (d) applyPreset({ name: 'the ledger default', split: d });
        return draw();
      }
      const p = presetsOf(ledger).find(x => x.id === el.dataset.preset);
      if (p) applyPreset(p);
    }
    else if (el.dataset.paid) { ed.paidBy = el.dataset.paid; haptic(); }
    else if (el.dataset.tog) {
      const i = el.dataset.tog; ed.on[i] = !ed.on[i];
      if (!ed.on[i]) { delete ed.parts[i]; delete ed.locked[i]; }
      if (ed.mode === 'equal') equalise(); else rebalance(null);
      haptic();
    }
    else if (el.dataset.mode) {
      ed.mode = el.dataset.mode;
      if (ed.mode === 'equal') { ed.locked = {}; equalise(); }
      haptic();
    }
    else if (el.dataset.lock) { const i = el.dataset.lock; ed.locked[i] = !ed.locked[i]; haptic(); }
    else {
      const act = el.dataset.act;
      if (act === 'cancel') return sheet.close();
      if (act === 'add-receipt') {
        const d = await pickImage(1400, .72);
        if (d) {
          ed.receiptPreview = d;
          ed.receiptLocal = 'rcp_' + ed.id;
          await DB.blobSet(ed.receiptLocal, d);
          ed.receiptId = '';
          toast('Photo attached');
        }
      }
      if (act === 'rm-receipt') { ed.receiptPreview = ''; ed.receiptLocal = ''; ed.receiptId = ''; }
      if (act === 'del-expense') {
        sheet.close();
        const mine = existing.enteredBy === S.me.id;
        if (await confirmSheet('Delete this expense?',
          mine ? 'It disappears for everyone on the ledger.'
               : `${userById(existing.enteredBy).name} entered this, so they'll be asked to review the deletion.`,
          'Delete')) {
          const gone = Object.assign({}, existing, { deleted: true, updatedAt: Date.now() });
          await queueTxn(ledger.id, Object.assign(gone, reviewPatch(existing, gone)));
          toast('Deleted');
        }
        return;
      }
      if (act === 'save-expense') {
        const on = ids.filter(i => ed.on[i]);
        if (!ed.amount || ed.amount <= 0) return toast('Add an amount first');
        if (!ed.name.trim()) return toast('Give it a name');
        if (!on.length) return toast('Pick who splits it');
        if (ed.mode === 'equal') equalise();
        if (Math.abs(sum() - 100) > 0.05) return toast('The split has to add up to 100%');
        const split = {}; on.forEach(i => split[i] = round2(Number(ed.parts[i]) || 0));
        const txn = {
          id: ed.id, type: 'expense', date: ed.date, name: ed.name.trim(), category: ed.category,
          amount: round2(ed.amount), paidBy: ed.paidBy, paidTo: '',
          enteredBy: existing ? (existing.enteredBy || S.me.id) : S.me.id,
          split, notes: ed.notes.trim(), receiptId: ed.receiptId || '',
          deleted: false, createdAt: existing ? existing.createdAt : new Date().toISOString(),
          updatedAt: Date.now()
        };
        if (ed.receiptLocal) txn._receiptLocal = ed.receiptLocal;
        Object.assign(txn, reviewPatch(existing, txn));
        sheet.close();
        await queueTxn(ledger.id, txn);

        // The entry just logged is the first occurrence, so the rule starts
        // from the one after it.
        if (!existing && ed.repeat !== 'never') {
          const anchor = Number(txn.date.slice(8, 10));
          await queueRule({
            id: ruleId(), ledgerId: ledger.id, name: txn.name, category: txn.category,
            amount: txn.amount, paidBy: txn.paidBy, split, notes: txn.notes,
            freq: ed.repeat, every: 1, anchor,
            nextDate: addPeriodISO(txn.date, ed.repeat, 1, anchor),
            active: true, review: ed.repeatReview, createdBy: S.me.id, lastRun: ''
          });
        }

        haptic(25);
        toast(existing
          ? (txn.reviewNote ? `Saved · ${userById(existing.enteredBy).name} will review it` : 'Saved ✓')
          : ed.repeat !== 'never'
            ? `${money(txn.amount)} added · repeats ${REPEAT_ADVERB[ed.repeat]} 🔁`
            : `${money(txn.amount)} added ✓`);
        if (!existing) confetti(50);
        return;
      }
    }
    draw();
  });

  sheet.addEventListener('input', e => {
    const t = e.target;
    /* Guess the category as they type the name, repainting only the chip row
       so the caret never leaves the field they're in. */
    if (t.id === 'f-name' && !ed.catTouched && !existing) {
      const guess = guessCategory(t.value);
      if (guess && guess !== ed.category) {
        ed.category = guess;
        const box = $('#cat-chips', sheet);
        if (box) $$('[data-cat]', box).forEach(c =>
          c.classList.toggle('on', c.dataset.cat === guess));
      }
      return;
    }
    if (t.id === 'f-amount') {
      const a = parseFloat(t.value || '0'); ed.amount = isNaN(a) ? 0 : Math.max(0, a);
      const sh = liveShares();
      $$('.split-row .sub', sheet).forEach((el, k) => {
        const on = ids.filter(i => ed.on[i]); const i = on[k];
        if (i) el.textContent = `${money(sh[i] || 0)} · ${round2(ed.parts[i] || 0)}%`;
      });
      const tb = $('.total-bar span:last-child', sheet);
      if (tb && ed.mode === 'amount') tb.textContent = money(ed.amount * sum() / 100) + ' / ' + money(ed.amount);
      return;
    }
    if (t.dataset && t.dataset.part) {
      const i = t.dataset.part;
      let v = parseFloat(t.value || '0'); if (isNaN(v)) v = 0;
      ed.parts[i] = ed.mode === 'amount' ? (ed.amount > 0 ? round2(v / ed.amount * 100) : 0) : round2(v);
      const total = sum(), ok = Math.abs(total - 100) < 0.05;
      const bar = $('.total-bar', sheet);
      if (bar) {
        bar.className = 'total-bar ' + (ok ? 'ok' : 'bad');
        bar.lastElementChild.textContent = ed.mode === 'amount'
          ? money(ed.amount * total / 100) + ' / ' + money(ed.amount) : round2(total) + '%';
      }
    }
  });
  sheet.addEventListener('change', e => {
    if (e.target.dataset && e.target.dataset.part && ed.mode === 'percent') {
      readFields(); rebalance(e.target.dataset.part); draw();
    }
  });

  draw();
  setTimeout(() => { const a = $('#f-amount', sheet); a && a.focus(); }, 380);
}

/* ─────────────────────────────────────────────────────────── settle sheet */
function settleSheet(ledger, preset, opts = {}) {
  const ids = memberIdsOf(ledger.id);
  const payee = preset ? userById(preset.to) : null;
  const st = {
    from: preset ? preset.from : S.me.id,
    to: preset ? preset.to : (ids.find(i => i !== S.me.id) || ids[0]),
    amount: preset ? preset.amount : 0,
    date: todayISO(),
    // Arriving here straight from a payment link, the method is already known.
    notes: opts.paid && payee && PAY_SERVICES[payee.payType] ? PAY_SERVICES[payee.payType].label : ''
  };
  const sheet = openSheet('<div id="st-body"></div>');
  const draw = () => {
    $('#st-body', sheet).innerHTML = `
      <h2>Record a payment 🤝</h2>
      <p class="sheet-sub">${opts.paid
        ? 'Once it has gone through, record it here so the balances catch up.'
        : 'Someone handed over real money — log it so balances update.'}</p>
      <div class="amount-wrap mb"><span class="cur">${esc(S.config.symbol || '$')}</span>
        <input id="f-amount" type="text" inputmode="decimal" placeholder="0.00" value="${st.amount ? esc(String(st.amount)) : ''}"></div>
      <div class="field"><label>Who paid</label><div class="chips">${ids.map(i => { const u = userById(i);
        return `<button class="chip ${st.from === i ? 'on' : ''}" data-from="${esc(i)}">${avatar(u, 's')}${esc(u.name)}</button>`; }).join('')}</div></div>
      <div class="field"><label>Who received it</label><div class="chips">${ids.map(i => { const u = userById(i);
        return `<button class="chip ${st.to === i ? 'on' : ''}" data-to="${esc(i)}" ${i === st.from ? 'style="opacity:.35"' : ''}>${avatar(u, 's')}${esc(u.name)}</button>`; }).join('')}</div></div>
      <div class="field"><label>Date</label><input class="input" id="f-date" type="date" value="${esc(st.date)}"></div>
      <div class="field"><label>Notes</label><input class="input" id="f-notes" placeholder="Venmo, cash, …" value="${esc(st.notes)}"></div>
      <div class="flex mt"><button class="btn ghost grow" data-act="cancel">Cancel</button>
        <button class="btn good grow" data-act="save-settle">Record it</button></div>`;
  };
  const readF = () => {
    const a = parseFloat(($('#f-amount', sheet) || {}).value || '0');
    st.amount = isNaN(a) ? 0 : Math.max(0, a);
    st.date = ($('#f-date', sheet) || {}).value || todayISO();
    st.notes = ($('#f-notes', sheet) || {}).value || '';
  };
  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-from],[data-to],[data-act]'); if (!el) return;
    readF();
    if (el.dataset.from) { st.from = el.dataset.from; if (st.to === st.from) st.to = ids.find(i => i !== st.from); }
    else if (el.dataset.to) { if (el.dataset.to === st.from) return toast("Can't pay yourself"); st.to = el.dataset.to; }
    else if (el.dataset.act === 'cancel') return sheet.close();
    else if (el.dataset.act === 'save-settle') {
      if (!st.amount) return toast('How much was it?');
      if (st.from === st.to) return toast('Pick two different people');
      sheet.close();
      await queueTxn(ledger.id, {
        id: uuid(), type: 'settlement', date: st.date, name: 'Settle up', category: '',
        amount: round2(st.amount), paidBy: st.from, paidTo: st.to, enteredBy: S.me.id,
        split: {}, notes: st.notes, receiptId: '', deleted: false,
        createdAt: new Date().toISOString(), updatedAt: Date.now()
      });
      haptic(30); confetti(120); toast('Settled up! 🎉');
      return;
    }
    draw();
  });
  draw();
}

/* ────────────────────────────────────────────────────── categories sheet */
/**
 * Rename, remove and add the chips people pick from. Categories are stored on
 * transactions as plain strings, so removing one never rewrites history — old
 * rows keep the name and simply lose their icon.
 */
function categorySheet() {
  const st = { list: categories().map(([emoji, name]) => ({ emoji, name })) };
  const sheet = openSheet('<div id="ct-body"></div>');

  const draw = () => {
    $('#ct-body', sheet).innerHTML = `
      <h2>Expense categories</h2>
      <p class="sheet-sub">What everyone picks from when they log something.</p>
      <div class="card mb">${st.list.map((c, i) => `<div class="row-item" style="padding:6px 0">
        <input class="input" data-cemoji="${i}" value="${esc(c.emoji)}" maxlength="4"
          style="width:58px;text-align:center;flex:0 0 auto">
        <input class="input grow" data-cname="${i}" value="${esc(c.name)}" maxlength="24">
        <button class="iconbtn" data-cdel="${i}" title="Remove">🗑</button></div>`).join('')
        || '<p class="hint">None left — add at least one.</p>'}
        <button class="btn ghost block mt" data-x="add">+ Add a category</button></div>
      <p class="hint">Removing one leaves past expenses alone — they keep the name they were
        filed under. ${S.config.categories ? '' : "You're on the built-in set; saving makes your own copy."}</p>
      <div class="flex mt">
        <button class="btn ghost" data-x="reset" title="Back to the built-in list">↩️</button>
        <button class="btn ghost grow" data-x="cancel">Cancel</button>
        <button class="btn grow" data-x="save">Save</button></div>`;
  };

  const read = () => {
    $$('[data-cname]', sheet).forEach(el => { const i = +el.dataset.cname; if (st.list[i]) st.list[i].name = el.value; });
    $$('[data-cemoji]', sheet).forEach(el => { const i = +el.dataset.cemoji; if (st.list[i]) st.list[i].emoji = el.value; });
  };

  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-x],[data-cdel]'); if (!el) return;
    read();
    if (el.dataset.cdel !== undefined) { st.list.splice(+el.dataset.cdel, 1); haptic(); return draw(); }
    if (el.dataset.x === 'cancel') return sheet.close();
    if (el.dataset.x === 'add') {
      if (st.list.length >= 40) return toast('Forty is the limit');
      st.list.push({ emoji: '🧾', name: '' }); return draw();
    }
    if (el.dataset.x === 'reset') {
      if (!await confirmSheet('Back to the built-in list?',
        'Your own list is discarded. Past expenses keep whatever they were filed under.',
        'Use the built-in list', false)) return;
      try {
        await api('adminSetConfig', { categories: CATEGORIES_DEFAULT.map(([emoji, name]) => ({ emoji, name })) });
        // The server stores the list it is given; clearing locally is what makes
        // "no override" visible until the next sync confirms it.
        S.config = Object.assign({}, S.config, { categories: null });
        sheet.close(); toast('Back to the built-in list'); await sync({ silent: true }); render();
      } catch (err) { toast(errMsg(err)); }
      return;
    }
    if (el.dataset.x === 'save') {
      const list = st.list.map(c => ({ emoji: c.emoji.trim() || '🧾', name: c.name.trim() })).filter(c => c.name);
      if (!list.length) return toast('Keep at least one category');
      const names = list.map(c => c.name.toLowerCase());
      if (new Set(names).size !== names.length) return toast('Two categories share a name');
      try {
        await api('adminSetConfig', { categories: list });
        S.config = Object.assign({}, S.config, { categories: list });
        sheet.close(); toast('Saved ✓'); await sync({ silent: true }); render();
      } catch (err) { toast(errMsg(err)); }
      return;
    }
  });

  draw();
}

/* ─────────────────────────────────────────────────────────── nudge sheet */
/**
 * A reminder is a message from a person, not a system alert, so it gets a
 * confirmation step and an optional line of your own. The amount is worked out
 * on the server from the ledger itself — this screen shows what it will say,
 * it doesn't decide it.
 */
function nudgeSheet(ledger, target) {
  const net = balancesFor(ledger.id);
  const owed = round2(Math.min(-(net[target.id] || 0), net[S.me.id] || 0));
  const sheet = openSheet(`
    <div class="center mb">${avatar(target, 'xl')}
      <h2 class="mt">Nudge ${esc(target.name)}?</h2>
      <p class="hint">We'll email them a friendly reminder that they owe you
        <b>${esc(money(owed))}</b> on ${esc(ledger.emoji)} ${esc(ledger.name)}.</p></div>
    <div class="field"><label>Add a line (optional)</label>
      <input class="input" id="n-note" maxlength="300" placeholder="No rush — whenever you get a chance"></div>
    <p class="hint">One nudge per person per ledger every six hours, so this can't turn into pestering.</p>
    <div class="flex mt"><button class="btn ghost grow" data-x="no">Cancel</button>
      <button class="btn grow" data-x="go">👋 Send it</button></div>`);

  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'no') return sheet.close();
    const note = ($('#n-note', sheet) || {}).value.trim();
    sheet.close();
    try {
      syncBadge('<span class="spinner"></span>Sending…');
      const r = await api('nudge', { ledgerId: ledger.id, userId: target.id, note });
      syncBadge('');
      haptic(25); toast(`Nudged ${r.to} for ${money(r.amount)} 👋`);
    } catch (err) { syncBadge(''); toast(errMsg(err)); }
  });
}

/* ───────────────────────────────────────────────────── ledger edit sheet */
const EMOJIS = ['💸', '🏠', '✈️', '🏝️', '🍕', '🎿', '🚗', '🎉', '🛒', '🏕️', '🎓', '🐕', '⛵', '🎸', '🍻', '👨‍👩‍👧'];
function ledgerSheet(existing) {
  const st = existing ? {
    id: existing.id, name: existing.name, emoji: existing.emoji, color: existing.color,
    archived: existing.archived, members: memberIdsOf(existing.id).slice(),
    defaultSplit: defaultSplitOf(existing)
  } : { name: '', emoji: '💸', color: '#6C5CE7', archived: false, members: [S.me.id], defaultSplit: null };

  const PAL = ['#6C5CE7', '#00B894', '#FF7675', '#FDCB6E', '#0984E3', '#E84393', '#00CEC9', '#E17055'];
  const sheet = openSheet('<div id="lg-body"></div>');

  /**
   * How new expenses here start out. Computed against the members currently
   * ticked above rather than the saved ones, so ticking somebody on surfaces
   * the "they aren't in it" warning immediately instead of after a save.
   */
  const defaultSplitField = () => {
    const live = normaliseSplit(st.defaultSplit || {}, st.members);
    const missing = live ? notInDefault(live, st.members) : [];
    return `<div class="field"><label>Default split</label>
      <div class="seg mb">
        <button data-def="even" class="${live ? '' : 'on'}">Evenly</button>
        <button data-def="custom" class="${live ? 'on' : ''}">Custom</button></div>
      ${live ? `<div class="card" style="padding:12px">${Object.keys(live).map(i =>
        `<div class="row-item" style="padding:5px 0">${avatar(userById(i), 's')}
          <div class="grow"><div class="ttl" style="font-size:14px">${esc(userById(i).name)}</div></div>
          <div class="num mono" style="font-size:14px">${round2(live[i])}%</div></div>`).join('')}
        <button class="btn ghost block mt" data-def="edit">✏️ Edit the split</button></div>` : ''}
      ${missing.length ? `<div class="card mt reviewnote"><div class="flex">
        <span style="font-size:22px">⚠️</span><div class="grow">
          <div class="ttl">${esc(missing.map(i => userById(i).name).join(' and '))}
            ${missing.length === 1 ? "isn't" : "aren't"} in it</div>
          <div class="sub" style="white-space:normal">New expenses will leave them out
            unless you say otherwise.</div></div></div>
        <button class="btn ghost block mt" data-def="include">Include ${missing.length === 1 ? 'them' : 'everyone'} equally</button>
      </div>` : ''}
      <p class="hint">${live
        ? 'New expenses and repeating rules start this way. Anyone can still change any of them.'
        : 'New expenses divide evenly between whoever is in them.'}</p></div>`;
  };

  const draw = () => {
    $('#lg-body', sheet).innerHTML = `
      <h2>${existing ? 'Edit ledger' : 'New ledger'}</h2>
      <p class="sheet-sub">${existing ? 'Rename it, restyle it, change the crew.' : 'A trip, the house bills, whatever you share.'}</p>
      <div class="card mb" style="background:linear-gradient(140deg,${esc(st.color)},${shade(st.color, -32)});color:#fff;border:0;box-shadow:var(--shadow-lg)">
        <div style="font-size:36px">${esc(st.emoji)}</div>
        <div style="font-size:21px;font-weight:900;margin-top:6px">${esc(st.name || 'Untitled ledger')}</div>
        <div style="opacity:.85;font-size:13px;font-weight:700">${st.members.length} ${st.members.length === 1 ? 'person' : 'people'}</div>
      </div>
      <div class="field"><label>Name</label><input class="input" id="lg-name" placeholder="Beach house 2026" value="${esc(st.name)}"></div>
      <div class="field"><label>Icon</label><div class="chips">${EMOJIS.map(e =>
        `<button class="chip ${st.emoji === e ? 'on' : ''}" data-emoji="${e}" style="font-size:19px">${e}</button>`).join('')}</div></div>
      <div class="field"><label>Colour</label><div class="chips">${PAL.map(c =>
        `<button class="chip" data-color="${c}" style="background:${c};border-color:${c};width:44px;height:38px;${st.color === c ? 'outline:3px solid var(--ink);outline-offset:2px' : ''}"></button>`).join('')}</div></div>
      <div class="field"><label>Who's in it</label><div class="chips">${S.users.filter(u => u.active).map(u =>
        `<button class="chip ${st.members.includes(u.id) ? 'on' : ''}" data-mem="${esc(u.id)}">${avatar(u, 's')}${esc(u.name)}</button>`).join('')}</div>
        <p class="hint">Anyone here can add expenses and see the whole ledger.</p></div>

      ${defaultSplitField()}
      ${existing ? `<div class="field"><label>Status</label>
        <button class="chip ${st.archived ? 'on' : ''}" data-arch="1">${st.archived ? '📦 Archived' : '✅ Active'}</button></div>` : ''}
      <div class="flex mt">
        ${existing ? `<button class="btn ghost" data-act="del-ledger">🗑</button>` : ''}
        <button class="btn ghost grow" data-act="cancel">Cancel</button>
        <button class="btn grow" data-act="save-ledger">${existing ? 'Save' : 'Create'}</button></div>`;
  };
  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-emoji],[data-color],[data-mem],[data-arch],[data-def],[data-act]'); if (!el) return;
    st.name = ($('#lg-name', sheet) || {}).value || st.name;
    if (el.dataset.emoji) st.emoji = el.dataset.emoji;
    else if (el.dataset.color) st.color = el.dataset.color;
    else if (el.dataset.def) {
      const op = el.dataset.def;
      if (op === 'even') st.defaultSplit = null;
      else if (op === 'include') st.defaultSplit = includeEqually(st.defaultSplit, st.members);
      else {
        if (!st.members.length) return toast('Pick who is in it first');
        // Opens on top; the ledger form underneath keeps everything typed so far.
        return splitEditorSheet({
          title: 'Default split',
          subtitle: `How new expenses on ${st.name || 'this ledger'} start out.`,
          ids: st.members.slice(),
          split: st.defaultSplit,
          confirmLabel: 'Use this',
          onSave: s => { st.defaultSplit = isEvenSplit(s) ? null : s; haptic(25); draw(); }
        });
      }
      haptic();
    }
    else if (el.dataset.mem) {
      const id = el.dataset.mem;
      st.members = st.members.includes(id) ? st.members.filter(x => x !== id) : st.members.concat(id);
    }
    else if (el.dataset.arch) st.archived = !st.archived;
    else if (el.dataset.act === 'cancel') return sheet.close();
    else if (el.dataset.act === 'del-ledger') {
      sheet.close();
      if (await confirmSheet('Delete "' + st.name + '"?',
        'The tab and every expense on it are removed from your spreadsheet. This cannot be undone.', 'Delete forever')) {
        try {
          await api('adminDeleteLedger', { id: st.id });
          await DB.dropLedger(st.id); delete S.txns[st.id]; delete S.cursors[st.id];
          toast('Ledger deleted'); go('admin', {}, true); await sync({ silent: true });
        } catch (err) { toast(errMsg(err)); }
      }
      return;
    }
    else if (el.dataset.act === 'save-ledger') {
      if (!st.name.trim()) return toast('Give it a name');
      if (!st.members.length) return toast('Add at least one person');
      sheet.close();
      try {
        syncBadge('<span class="spinner"></span>Saving…');
        const r = await api('adminSaveLedger', {
          id: st.id, name: st.name.trim(), emoji: st.emoji, color: st.color,
          archived: st.archived, memberIds: st.members,
          defaultSplit: st.defaultSplit || {}      // {} clears it back to evenly
        });
        syncBadge('');
        toast(existing ? 'Saved ✓' : 'Ledger created 🎉');
        if (!existing) confetti(70);
        await sync({ silent: true });
        if (!existing && r.ledger) go('ledger', { id: r.ledger.id });
      } catch (err) { syncBadge(''); toast(errMsg(err)); }
      return;
    }
    draw();
  });
  draw();
}

/* ───────────────────────────────────────────────────────── user edit sheet */
function userSheet(existing) {
  const st = existing ? Object.assign({}, existing) :
    { name: '', username: '', email: '', emoji: '', color: '#6C5CE7', role: 'member', active: true, kind: 'person' };
  st.pw = ''; st.pw2 = '';
  st.kind = st.kind || 'person';
  const PAL = ['#6C5CE7', '#00B894', '#FF7675', '#FDCB6E', '#0984E3', '#E84393', '#00CEC9', '#E17055'];
  const sheet = openSheet('<div id="us-body"></div>');
  const draw = () => {
    const ent = st.kind === 'entity';
    // Switching an existing person across is refused server-side once they have
    // a login, so don't offer it — a control that always errors is worse than
    // no control.
    const canSwitch = !existing || !existing.hasPassword;
    $('#us-body', sheet).innerHTML = `
      <h2>${existing ? (ent ? 'Edit' : 'Edit person') : 'Add someone'}</h2>
      <p class="sheet-sub">${existing
        ? (ent ? 'Not a person — no login, no email.' : '@' + esc(existing.username))
        : 'Somebody who uses the app, or something that just holds a balance.'}</p>

      ${canSwitch ? `<div class="seg mb">
        <button data-kind="person" class="${ent ? '' : 'on'}">👤 Person</button>
        <button data-kind="entity" class="${ent ? 'on' : ''}">🏢 Not a person</button></div>` : ''}

      <div class="center mb">${avatar({ name: st.name || '?', color: st.color, emoji: st.emoji,
        kind: st.kind, avatar: existing ? existing.avatar : '' }, 'xl')}
        ${existing && !ent ? `<div class="mt"><button class="btn sm ghost" data-act="pick-avatar-for">📷 Set photo</button></div>` : ''}</div>

      ${ent ? `<div class="card mb"><div class="flex"><span style="font-size:22px">🏢</span>
        <div class="grow"><div class="sub" style="white-space:normal">Holds a balance and takes a share
          of a split, but can't sign in, can't be invited and is never emailed. Use it for an employer
          you claim expenses back from, a house kitty, or someone who is never going to install
          this.</div></div></div></div>` : ''}

      <div class="field"><label>${ent ? 'Name' : 'Display name'}</label>
        <input class="input" id="us-name" value="${esc(st.name)}" placeholder="${ent ? 'Acme Corp' : 'Sam'}"></div>

      ${ent ? '' : `<div class="field"><label>Username</label><input class="input" id="us-user" value="${esc(st.username)}"
        autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sam"></div>
      <div class="field"><label>Email (optional)</label><input class="input" id="us-email" type="email" value="${esc(st.email || '')}"></div>`}

      <div class="field"><label>Badge emoji (optional)</label><input class="input" id="us-emoji" value="${esc(st.emoji || '')}" placeholder="${ent ? '🏢' : '🦊'}" maxlength="4"></div>
      <div class="field"><label>Colour</label><div class="chips">${PAL.map(c =>
        `<button class="chip" data-color="${c}" style="background:${c};border-color:${c};width:44px;height:38px;${st.color === c ? 'outline:3px solid var(--ink);outline-offset:2px' : ''}"></button>`).join('')}</div></div>

      ${ent ? '' : `<div class="field"><label>Role</label><div class="seg">
        <button data-role="member" class="${st.role !== 'admin' ? 'on' : ''}">Member</button>
        <button data-role="admin" class="${st.role === 'admin' ? 'on' : ''}">Admin 👑</button></div>
        <p class="hint">Admins can manage people and ledgers.</p></div>`}

      ${existing ? `<div class="field"><label>Account</label>
        <button class="chip ${st.active ? 'on' : ''}" data-active="1">${st.active ? '✅ Active' : '🚫 Disabled'}</button></div>` : ''}

      ${ent ? '' : `<div class="field"><label>${existing ? 'Reset password' : 'Password'}</label>
        <input class="input mb" id="us-pw" type="password" placeholder="${existing ? 'Leave blank to keep current' : 'Optional — they can set it via invite'}">
        <input class="input" id="us-pw2" type="password" placeholder="Confirm">
        <p class="hint">${existing ? '' : 'Leave blank and they can claim their own seat from the invite link.'}</p></div>`}

      <div class="flex mt">
        ${existing ? `<button class="btn ghost" data-act="del-user">🗑</button>` : ''}
        <button class="btn ghost grow" data-act="cancel">Cancel</button>
        <button class="btn grow" data-act="save-user">Save</button></div>`;
  };
  /* The entity form has no username, email or password inputs, so those reads
     have to leave the existing values alone rather than blank them. */
  const readF = () => {
    const get = (sel, fallback) => { const el = $(sel, sheet); return el ? el.value : fallback; };
    st.name = get('#us-name', st.name) || '';
    st.username = get('#us-user', st.username) || '';
    st.email = get('#us-email', st.email) || '';
    st.emoji = get('#us-emoji', st.emoji) || '';
    st.pw = get('#us-pw', '') || '';
    st.pw2 = get('#us-pw2', '') || '';
  };
  sheet.addEventListener('click', async e => {
    const el = e.target.closest('[data-color],[data-role],[data-kind],[data-active],[data-act]'); if (!el) return;
    readF();
    if (el.dataset.color) st.color = el.dataset.color;
    else if (el.dataset.kind) { st.kind = el.dataset.kind; if (st.kind === 'entity') st.role = 'member'; haptic(); }
    else if (el.dataset.role) st.role = el.dataset.role;
    else if (el.dataset.active) st.active = !st.active;
    else if (el.dataset.act === 'cancel') return sheet.close();
    else if (el.dataset.act === 'pick-avatar-for') {
      const d = await pickAvatar();
      if (d) {
        try { await api('setAvatar', { userId: existing.id, avatar: d }); existing.avatar = d;
          toast('Photo set'); await sync({ silent: true }); } catch (err) { toast(errMsg(err)); }
      }
      return;
    }
    else if (el.dataset.act === 'del-user') {
      sheet.close();
      if (await confirmSheet('Remove ' + st.name + '?',
        st.kind === 'entity'
          ? 'It leaves every ledger. Past expenses keep its name on them.'
          : 'Their login is deleted and they leave every ledger. Past expenses keep their name on them.',
        'Remove')) {
        try { await api('adminDeleteUser', { id: existing.id }); toast('Removed'); await sync({ silent: true }); }
        catch (err) { toast(errMsg(err)); }
      }
      return;
    }
    else if (el.dataset.act === 'save-user') {
      const ent = st.kind === 'entity';
      if (ent && !st.name.trim()) return toast('Give it a name');
      if (!ent && !st.username.trim()) return toast('Username required');
      if (!ent && (st.pw || st.pw2)) {
        if (st.pw !== st.pw2) return toast("Passwords don't match");
        if (st.pw.length < 6) return toast('Use at least 6 characters');
      }
      if (ent && S.apiVersion && S.apiVersion < NEEDS_API)
        return toast('Your backend script is too old for this — update it first', 3600);
      sheet.close();
      try {
        syncBadge('<span class="spinner"></span>Saving…');
        const payload = {
          id: existing ? existing.id : undefined,
          name: st.name.trim() || st.username.trim(), username: st.username.trim(),
          email: ent ? '' : st.email.trim(), emoji: st.emoji.trim(), color: st.color,
          role: ent ? 'member' : st.role, kind: st.kind
        };
        if (existing) payload.active = st.active;
        if (st.pw && !existing) {
          const salt = hexBytes(16);
          payload.salt = salt; payload.dk = await derive(st.pw, salt, 210000);
        }
        const r = await api('adminSaveUser', payload);
        if (st.pw && existing) {
          const salt = hexBytes(16);
          await api('adminSetPassword', { userId: existing.id, salt, dk: await derive(st.pw, salt, 210000) });
        }
        syncBadge('');
        toast('Saved ✓');
        await sync({ silent: true });
      } catch (err) { syncBadge(''); toast(errMsg(err)); }
      return;
    }
    draw();
  });
  draw();
}

/* ─────────────────────────────────────────────────────────── invite sheet */
/** Raising a manual review request: an optional word on why, then everyone's asked. */
function flagSheet(ledger, txn) {
  const need = txn.type === 'settlement'
    ? [txn.paidBy, txn.paidTo].filter(Boolean) : Object.keys(txn.split || {});
  const others = need.filter(u => u !== S.me.id);
  const sheet = openSheet(`
    <h2>Ask everyone to review 👀</h2>
    <p class="sheet-sub">Good for placeholders, rough amounts and anything not finalised.
      It stays marked until everyone splitting it has signed off.</p>
    <div class="field"><label>Why? (optional)</label>
      <input class="input" id="fl-note" maxlength="120" placeholder="Estimate — waiting on the real receipt"></div>
    <p class="hint">${others.length
      ? 'Waiting on ' + others.map(u => esc(userById(u).name)).join(', ') + '. It still counts towards balances meanwhile.'
      : "Nobody else is splitting this, so it'll just be marked for you."}</p>
    <div class="flex mt"><button class="btn ghost grow" data-x="cancel">Cancel</button>
      <button class="btn grow" data-x="go">Ask for review</button></div>`);

  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') return sheet.close();
    const note = ($('#fl-note', sheet) || {}).value || '';
    sheet.close();
    await queueReview(ledger.id, txn.id, 'flag', note.trim());
    haptic(25); toast('Marked for review 👀');
  });
}

function inviteSheet(ledger) {
  // The link carries the backend id too, so a brand-new phone needs nothing else.
  const bid = backendId(S.api);
  const url = appHome() + '#/join/' + ledger.invite + (bid ? '/' + bid : '');
  const sheet = openSheet(`
    <h2>Invite people ✉️</h2>
    <p class="sheet-sub">Anyone with this link can join <b>${esc(ledger.name)}</b>.</p>
    <div class="card mb" style="word-break:break-all;font-size:13.5px;font-weight:700">${esc(url)}</div>
    <div class="flex">
      <button class="btn grow" data-x="copy">📋 Copy link</button>
      ${navigator.share ? `<button class="btn ghost grow" data-x="share">Share…</button>` : ''}
    </div>
    <p class="hint">Tip: in Settings ▸ People, add someone <b>without</b> a password. They can then claim their
      own seat from this link and pick their own password.</p>
    ${isAdmin() ? `<button class="btn ghost block mt" data-x="rotate">🔄 Generate a new link</button>
      <p class="hint">The old link stops working immediately.</p>` : ''}`);
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'copy') {
      try { await navigator.clipboard.writeText(url); toast('Link copied 📋'); }
      catch (err) { toast('Copy failed — long-press the link'); }
    }
    if (b.dataset.x === 'share') {
      try { await navigator.share({ title: ledger.name, text: 'Join our expense ledger', url }); } catch (err) {}
    }
    if (b.dataset.x === 'rotate') {
      sheet.close();
      if (await confirmSheet('New invite link?', 'The current link stops working right away.', 'Regenerate')) {
        try { await api('adminRotateInvite', { id: ledger.id }); await sync({ silent: true }); toast('New link ready'); }
        catch (err) { toast(errMsg(err)); }
      }
    }
  });
}

/* ───────────────────────────────────────────────────── password sheets */
function changePasswordSheet() {
  const sheet = openSheet(`
    <h2>Change password 🔑</h2><p class="sheet-sub">You'll stay signed in on this device.</p>
    <div class="field"><label>Current password</label><input class="input" id="p-old" type="password"></div>
    <div class="field"><label>New password</label><input class="input" id="p-new" type="password"></div>
    <div class="field"><label>Confirm new password</label><input class="input" id="p-new2" type="password"></div>
    <div class="flex mt"><button class="btn ghost grow" data-x="cancel">Cancel</button>
      <button class="btn grow" data-x="save">Update</button></div>`);
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') return sheet.close();
    const oldPw = $('#p-old', sheet).value, np = $('#p-new', sheet).value, np2 = $('#p-new2', sheet).value;
    if (np !== np2) return toast("New passwords don't match");
    if (np.length < 6) return toast('Use at least 6 characters');
    try {
      syncBadge('<span class="spinner"></span>Updating…');
      const sInfo = await api('authSalt', { username: S.me.username });
      const oldDk = await derive(oldPw, sInfo.salt, sInfo.iterations);
      const salt = hexBytes(16);
      const dk = await derive(np, salt, 210000);
      const r = await api('changePassword', { oldDk, salt, dk });
      S.token = r.token; LS.token = r.token;
      syncBadge(''); sheet.close(); toast('Password updated ✓');
    } catch (err) { syncBadge(''); toast(errMsg(err)); }
  });
}

function claimSeatSheet(invite, member) {
  const sheet = openSheet(`
    <h2>Hi ${esc(member.name)} 👋</h2><p class="sheet-sub">Pick a password and you're in.</p>
    <div class="center mb">${avatar(member, 'xl')}</div>
    <div class="field"><label>Password</label><input class="input" id="cs-pw" type="password"></div>
    <div class="field"><label>Confirm</label><input class="input" id="cs-pw2" type="password"></div>
    <div class="flex mt"><button class="btn ghost grow" data-x="cancel">Cancel</button>
      <button class="btn grow" data-x="go">Join 🎉</button></div>`);
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') return sheet.close();
    const pw = $('#cs-pw', sheet).value, pw2 = $('#cs-pw2', sheet).value;
    if (pw !== pw2) return toast("Passwords don't match");
    if (pw.length < 6) return toast('Use at least 6 characters');
    try {
      syncBadge('<span class="spinner"></span>Setting up…');
      const salt = hexBytes(16);
      const dk = await derive(pw, salt, 210000);
      const r = await api('claimSeat', { invite, userId: member.id, salt, dk });
      S.token = r.token; LS.token = r.token;
      await applyState(r.state);
      syncBadge(''); sheet.close(); confetti(110); toast('Welcome aboard! 🎉');
      go('home', {}, true);
      sync({ silent: true, full: true });
    } catch (err) { syncBadge(''); toast(errMsg(err)); }
  });
}

/* ──────────────────────────────────────────────────────── txn detail sheet */
/** The review panel inside a transaction: what happened, who's left, what to do. */
function reviewCard(t) {
  if (!t.reviewState) return '';
  const who = userById(t.reviewBy);
  const need = reviewersFor(t), out = reviewOutstanding(t);
  const conflict = t.reviewState === 'conflict';
  const iAmAuthor = t.enteredBy === S.me.id;
  const canRevert = t.reviewState !== 'flag' && t.reviewWas && (iAmAuthor || isAdmin());
  const canWithdraw = t.reviewState === 'flag' && (t.reviewBy === S.me.id || isAdmin());

  const heading = t.reviewState === 'flag'
    ? `${esc(who.name)} asked everyone to take a look`
    : conflict ? `${esc(who.name)} changed this at the same time you did`
               : `${esc(who.name)} changed this`;

  return `<div class="card mb reviewnote${conflict ? ' bad' : ''}">
    <div class="flex mb"><span style="font-size:24px">${conflict ? '⚠️' : '👀'}</span>
      <div class="grow"><div class="ttl">${heading}</div>
        <div class="sub" style="white-space:normal">${esc(REVIEW_LABEL[t.reviewState])}</div></div></div>
    ${t.reviewNote ? `<p style="font-weight:700;line-height:1.5;margin:0 0 12px">${esc(t.reviewNote)}</p>` : ''}
    ${need.length > 1 ? `<div class="flex mb" style="flex-wrap:wrap">
      ${need.map(u => `<span class="chip ${out.includes(u) ? '' : 'on'}" style="pointer-events:none">
        ${avatar(userById(u), 's')}${esc(userById(u).name)}${out.includes(u) ? '' : ' ✓'}</span>`).join('')}</div>` : ''}
    ${needsMyReview(t) ? `<button class="btn good block" data-x="ack">Looks right to me</button>` : ''}
    ${canRevert ? `<button class="btn ghost block mt" data-x="revert">↩️ Put it back the way it was</button>` : ''}
    ${canWithdraw ? `<button class="btn ghost block mt" data-x="unflag">Withdraw the review request</button>` : ''}
    ${!needsMyReview(t) && !canRevert && !canWithdraw
      ? `<p class="hint center" style="margin:0">Waiting on ${out.map(u => esc(userById(u).name)).join(', ') || 'nobody'}.</p>` : ''}
  </div>`;
}

async function txnSheet(ledger, txn) {
  const payer = userById(txn.paidBy), entered = userById(txn.enteredBy);
  const parts = Object.entries(txn.split || {});
  const canEdit = true;
  const sheet = openSheet(`
    <div class="center mb">
      <div class="av xl" style="background:${esc(ledger.color)};margin:0 auto">${esc(txn.type === 'settlement' ? '🤝' : catEmoji(txn.category))}</div>
      <h2 class="mt">${esc(txn.name)}</h2>
      <div style="font-size:32px;font-weight:900" class="mono">${esc(money(txn.amount))}</div>
      <p class="hint">${esc(niceDate(txn.date))}${txn.category ? ' · ' + esc(txn.category) : ''}</p>
    </div>
    ${reviewCard(txn)}
    ${txn.type === 'settlement' ? `<div class="card mb">
      <div class="row-item">${avatar(payer, 'm')}<div class="grow"><div class="ttl">${esc(payer.name)}</div>
        <div class="sub">paid</div></div><div style="font-size:19px">→</div>
        ${avatar(userById(txn.paidTo), 'm')}<div class="grow"><div class="ttl">${esc(userById(txn.paidTo).name)}</div>
        <div class="sub">received</div></div></div></div>` :
    `<div class="card mb"><div class="row-item">${avatar(payer, 'm')}
        <div class="grow"><div class="ttl">${esc(payer.name)} paid</div><div class="sub">the whole ${money(txn.amount)}</div></div></div>
      <div class="section-title">Split</div>
      ${(() => { const sh = allocate(txn.amount, txn.split);
        return parts.map(([id, pct]) => { const u = userById(id);
        return `<div class="row-item">${avatar(u, 's')}<div class="grow"><div class="ttl">${esc(u.name)}</div>
          <div class="sub">${round2(pct)}%</div></div>
          <div class="num mono">${money(sh[id] || 0)}</div></div>`; }).join(''); })()}</div>`}
    ${txn.notes ? `<div class="card mb"><div class="section-title" style="margin-top:0">Notes</div>
      <p style="font-weight:600;line-height:1.5;white-space:pre-wrap">${esc(txn.notes)}</p></div>` : ''}
    <div id="rcp"></div>
    <p class="hint center">Entered by ${esc(entered.name)}${S.pending[txn.id] ? ' · <b style="color:var(--warn)">waiting to sync</b>' : ''}</p>
    ${!txn.reviewState && !txn.deleted
      ? `<button class="btn ghost block" data-x="flag">👀 Ask everyone to review this</button>` : ''}
    <div class="flex mt">
      <button class="btn ghost grow" data-x="close">Close</button>
      ${canEdit ? `<button class="btn grow" data-x="edit">Edit</button>` : ''}
    </div>`);

  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const act = b.dataset.x;
    if (act === 'close') sheet.close();
    if (act === 'edit') {
      sheet.close();
      setTimeout(() => txn.type === 'settlement' ? settleSheet(ledger, { from: txn.paidBy, to: txn.paidTo, amount: txn.amount }) : expenseSheet(ledger, txn), 200);
    }
    if (act === 'ack') {
      sheet.close();
      await queueReview(ledger.id, txn.id, 'ack');
      haptic(25); toast('Signed off ✓');
    }
    if (act === 'unflag') {
      sheet.close();
      await queueReview(ledger.id, txn.id, 'unflag');
      toast('Review request withdrawn');
    }
    if (act === 'flag') { sheet.close(); setTimeout(() => flagSheet(ledger, txn), 200); }
    if (act === 'revert') {
      sheet.close();
      if (!await confirmSheet('Put it back?',
        `This restores the values from before ${userById(txn.reviewBy).name} changed it. They'll be asked to review that.`,
        'Put it back', false)) return;
      // Restoring is an ordinary edit made by the author, which is what clears
      // the review — no special server path needed.
      const back = Object.assign({}, txn, txn.reviewWas, {
        updatedAt: Date.now(), reviewState: '', reviewBy: '', reviewNote: '', reviewDone: [], reviewWas: null
      });
      await queueTxn(ledger.id, Object.assign(back, reviewPatch(txn, back)));
      haptic(25); toast('Put back ✓');
    }
  });

  // receipt (local first, then server)
  const box = $('#rcp', sheet);
  if (txn._receiptLocal) {
    const d = await DB.blobGet(txn._receiptLocal);
    if (d) box.innerHTML = `<div class="card mb"><div class="section-title" style="margin-top:0">Receipt</div>
      <img src="${d}" style="width:100%;border-radius:16px"></div>`;
  } else if (txn.receiptId) {
    const cacheKey = 'srv_' + txn.receiptId;
    let d = await DB.blobGet(cacheKey);
    if (!d) {
      box.innerHTML = `<div class="card mb"><div class="skel" style="height:180px"></div></div>`;
      try { const r = await api('getReceipt', { receiptId: txn.receiptId }); d = r.dataUrl; await DB.blobSet(cacheKey, d); }
      catch (err) { box.innerHTML = `<p class="hint center">📎 Receipt can't be loaded right now.</p>`; }
    }
    if (d) box.innerHTML = `<div class="card mb"><div class="section-title" style="margin-top:0">Receipt</div>
      <img src="${d}" style="width:100%;border-radius:16px"></div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════ wiring */
function wire() {
  const root = $('#root');

  root.onclick = async e => {
    const t = e.target;

    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) { S.tab = tabBtn.dataset.tab; haptic(); return render(); }

    const who = t.closest('[data-who]');
    if (who) { S.filterWho = S.filterWho === who.dataset.who ? '' : who.dataset.who; haptic(); return render(); }

    const cf = t.closest('[data-cat-filter]');
    if (cf) { S.filterCat = S.filterCat === cf.dataset.catFilter ? '' : cf.dataset.catFilter; haptic(); return render(); }

    const pt = t.closest('[data-pt]');
    if (pt) {
      const type = pt.dataset.pt;
      if (!type) {
        try { const r = await api('setProfile', { payType: '', payHandle: '' }); S.me = r.me; toast('Removed'); }
        catch (err) { return toast(errMsg(err)); }
      } else S.me = Object.assign({}, S.me, { payType: type });
      haptic(); return render();
    }

    const dg = t.closest('[data-digest]');
    if (dg) {
      const mode = dg.dataset.digest;
      S.config = Object.assign({}, S.config, { digest: mode });
      haptic(); render();
      try { await api('adminSetConfig', { digest: mode }); toast(mode === 'off' ? 'Summaries off' : `Summaries: ${mode}`); }
      catch (err) { toast(errMsg(err)); await sync({ silent: true }); }
      return;
    }

    const led = t.closest('[data-ledger]');
    if (led) { S.tab = 'feed'; return go('ledger', { id: led.dataset.ledger }); }

    const txnEl = t.closest('[data-txn]');
    if (txnEl) {
      const l = ledgerById(S.params.id);
      const x = (S.txns[l.id] || []).find(z => z.id === txnEl.dataset.txn);
      if (x) txnSheet(l, x);
      return;
    }

    const set = t.closest('[data-settle]');
    if (set) { settleSheet(ledgerById(S.params.id), JSON.parse(set.dataset.settle)); return; }

    const ndg = t.closest('[data-nudge]');
    if (ndg) { nudgeSheet(ledgerById(S.params.id), userById(ndg.dataset.nudge)); return; }

    const pay = t.closest('[data-pay]');
    if (pay) {
      const d = JSON.parse(pay.dataset.pay);
      const l = ledgerById(S.params.id), to = userById(d.to);
      const url = payLink(to, d.amount, `${l.emoji} ${l.name}`);
      if (!url) return toast("Couldn't build a payment link for them");
      // Opened straight from the tap so the popup blocker doesn't eat it, then
      // the settle sheet is waiting behind it to log what just happened.
      window.open(url, '_blank', 'noopener');
      haptic(20);
      settleSheet(l, d, { paid: true });
      return;
    }

    const usr = t.closest('[data-user]');
    if (usr) { userSheet(S.users.find(u => u.id === usr.dataset.user)); return; }

    const el2 = t.closest('[data-editledger]');
    if (el2) { ledgerSheet(ledgerById(el2.dataset.editledger)); return; }

    const clm = t.closest('[data-claim]');
    if (clm) {
      const m = S.params.invite.members.find(x => x.id === clm.dataset.claim);
      claimSeatSheet(S.params.token, m); return;
    }

    const act = t.closest('[data-act]');
    if (!act) return;
    e.preventDefault();
    await handle(act.dataset.act, act);
  };

  root.oninput = e => {
    if (e.target.id !== 'q-search') return;
    S.search = e.target.value;
    applySearch();
  };

  root.onkeydown = e => {
    if (e.target.id === 'q-search') {
      // Enter just dismisses the keyboard — results are already live.
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      if (e.key === 'Escape') handle('toggle-search');
      return;
    }
    if (e.key !== 'Enter') return;
    if (['l-user', 'l-pw'].includes(e.target.id)) handle('login');
    if (['c-url'].includes(e.target.id)) handle('connect');
    if (e.target.id === 'g-phrase') handle('submit-gate');
  };
}

async function handle(act, el) {
  switch (act) {
    case 'back': return history.length > 1 ? history.back() : go('home', {}, true);
    case 'home': return go('home', {}, true);
    case 'profile': return go('profile');
    case 'people': return go('people');
    case 'admin': return go('admin');
    case 'sync': haptic(); return sync({ full: false });
    case 'check-update': {
      if (!Updater.reg)
        return toast('Updates need the app served over https');
      syncBadge('<span class="spinner"></span>Checking…');
      const r = await Updater.check(true);
      syncBadge('');
      if (r.updateReady) { toast('Update found 🎉'); render(); }
      else if (r.ok) toast("You're on the latest version ✓");
      else if (!navigator.onLine) toast("Can't check while offline");
      else toast("Couldn't check just now");
      return;
    }
    case 'apply-update': {
      toast('Updating…');
      return Updater.apply();
    }
    case 'hard-reset': {
      const queued = (await DB.outbox()).length;
      const warn = queued
        ? `You have ${queued} change${queued > 1 ? 's' : ''} waiting to sync. They're kept, but sync first if you can.`
        : 'Re-downloads the app from scratch. Your ledgers and login stay put.';
      if (!await confirmSheet('Clear cache and reload?', warn, 'Clear and reload', false)) return;
      toast('Clearing…');
      return Updater.hardReset();
    }
    case 'full-resync': {
      S.cursors = {}; await DB.set('cursors', {});
      for (const l of S.ledgers) { await DB.dropLedger(l.id); S.txns[l.id] = []; }
      toast('Rebuilding…'); return sync({ full: true });
    }
    case 'to-login': return go('login', {}, true);
    case 'change-api': {
      if (await confirmSheet('Change server?', 'You will be signed out of this device.', 'Change', false)) {
        await signOut(true);
        localStorage.removeItem('ss.api'); S.api = '';
        LS.gate = ''; S.gate = '';
        go('connect', {}, true);
      }
      return;
    }
    case 'connect': return doConnect();
    case 'stay': {
      history.replaceState(null, '', location.pathname);
      S.params = {};
      return boot();
    }
    case 'do-switch': {
      const to = S.params.to, invite = S.params.invite;
      await signOut(true);
      LS.gate = ''; S.gate = '';
      S.api = to; LS.api = to;
      history.replaceState(null, '', location.pathname + (invite ? '#/join/' + invite : ''));
      toast('Switched server');
      return boot();
    }
    case 'submit-gate': return doGate();
    case 'claim-admin': return doClaimAdmin();
    case 'login': return doLogin();
    case 'signout-everywhere': {
      if (!await confirmSheet('Sign out everywhere else?',
        'Every other phone, tablet and browser signed in as you is kicked out immediately. This device stays.',
        'Sign out other devices', false)) return;
      try {
        const r = await api('signOutEverywhere', {});
        S.token = r.token; LS.token = r.token;
        toast('Other devices signed out ✓');
      } catch (err) { toast(errMsg(err)); }
      return;
    }
    case 'set-gate': return gateSheet();
    case 'invite-login': { S.params.pendingInvite = S.params.token; return go('login', { joinAfter: S.params.token }, true); }
    case 'new-ledger': return ledgerSheet(null);
    case 'edit-ledger': return ledgerSheet(ledgerById(S.params.id));
    case 'share-invite': return inviteSheet(ledgerById(S.params.id));
    case 'toggle-search': {
      S.searchOpen = !S.searchOpen;
      if (!S.searchOpen) { S.search = ''; S.filterWho = ''; S.filterCat = ''; }
      haptic(); render();
      const box = $('#q-search'); if (box) box.focus();
      return;
    }
    case 'toggle-reviews': { S.reviewOnly = !S.reviewOnly; haptic(); return render(); }
    case 'clear-filters': { S.filterWho = ''; S.filterCat = ''; haptic(); return render(); }
    case 'clear-search': {
      S.search = '';
      const box = $('#q-search');
      if (box) { box.value = ''; box.focus(); }
      return applySearch();
    }
    case 'new-expense': return expenseSheet(ledgerById(S.params.id), null);
    case 'recurring': return recurringSheet(ledgerById(S.params.id));
    case 'toggle-notify': {
      // Flipped locally and saved with the button below, so the toggle and the
      // address field can't disagree about which of them was saved.
      S.me.notify = S.me.notify === false;
      haptic(); return render();
    }
    case 'save-profile': {
      const email = ($('#p-email') || {}).value.trim();
      try {
        const r = await api('setProfile', { email, notify: S.me.notify !== false });
        S.me = r.me;
        await applyState({ me: S.me, users: S.users, ledgers: S.ledgers, members: S.members, config: S.config });
        toast('Saved ✓'); render();
      } catch (err) { toast(errMsg(err)); }
      return;
    }
    case 'categories': return categorySheet();
    case 'save-pay': {
      const handle = ($('#p-handle') || {}).value.trim();
      try {
        const r = await api('setProfile', { payType: S.me.payType || '', payHandle: handle });
        S.me = r.me;
        await applyState({ me: S.me, users: S.users, ledgers: S.ledgers, members: S.members, config: S.config });
        toast(handle ? 'Saved ✓' : 'Removed'); render();
      } catch (err) { toast(errMsg(err)); }
      return;
    }
    case 'test-digest': {
      try {
        syncBadge('<span class="spinner"></span>Sending…');
        const r = await api('adminTestDigest', {});
        syncBadge('');
        toast(r.quiet
          ? 'Nothing to report right now — so nothing was sent'
          : 'Sent — check your inbox ✉️', 3600);
      } catch (err) { syncBadge(''); toast(errMsg(err), 3600); }
      return;
    }
    case 'record-payment': return settleSheet(ledgerById(S.params.id), null);
    case 'new-user': return userSheet(null);
    case 'change-password': return changePasswordSheet();
    case 'signout': {
      if (await confirmSheet('Sign out?', 'Anything not yet synced stays queued on this device.', 'Sign out', false))
        await signOut();
      return;
    }
    case 'pick-avatar': {
      const d = await pickAvatar();
      if (!d) return;
      try { syncBadge('<span class="spinner"></span>Uploading…'); await api('setAvatar', { avatar: d });
        S.me.avatar = d; await sync({ silent: true }); syncBadge(''); toast('Looking good 😎'); render(); }
      catch (err) { syncBadge(''); toast(errMsg(err)); }
      return;
    }
    case 'clear-avatar': {
      try { await api('setAvatar', { avatar: '' }); S.me.avatar = ''; await sync({ silent: true }); render(); }
      catch (err) { toast(errMsg(err)); }
      return;
    }
    case 'save-config': {
      try {
        await api('adminSetConfig', {
          appName: $('#a-name').value.trim() || 'SplitStack',
          currency: $('#a-cur').value.trim().toUpperCase() || 'USD',
          currencySymbol: $('#a-sym').value.trim() || '$'
        });
        toast('Saved ✓'); await sync({ silent: true });
      } catch (err) { toast(errMsg(err)); }
      return;
    }
  }
}

/* ─────────────────────────────────────────────────────────────── actions */
function fieldErr(sel, msg) {
  const box = $(sel); if (!box) return toast(msg);
  box.innerHTML = `<div class="err">${esc(msg)}</div>`;
  box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 520);
}

async function doConnect() {
  let url = $('#c-url').value.trim();
  if (!url) return fieldErr('#c-err', 'Paste the /exec URL first.');
  url = url.replace(/\/dev$/, '/exec');
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url))
    return fieldErr('#c-err', 'That should be a script.google.com URL ending in /exec.');
  S.api = url;
  try {
    syncBadge('<span class="spinner"></span>Knocking…');
    const info = await api('ping', {}, { timeout: 25000 });
    syncBadge('');
    LS.api = url;
    S.config.appName = info.appName || 'SplitStack';
    if (info.gated && !S.gate) return go('gate', {}, true);
    go(info.ready ? 'login' : 'setupAdmin', {}, true);
  } catch (err) {
    syncBadge('');
    S.api = LS.api;
    fieldErr('#c-err', err.code === 'OFFLINE'
      ? "Couldn't reach it. Check the URL, and that the deployment is set to “Anyone”."
      : errMsg(err));
  }
}

async function doGate() {
  const phrase = $('#g-phrase').value.trim();
  if (!phrase) return fieldErr('#g-err', 'Enter the phrase.');
  S.gate = phrase;
  try {
    syncBadge('<span class="spinner"></span>Unlocking…');
    // authSalt is gated, cheap, and reveals nothing — a perfect probe.
    await api('authSalt', { username: '' }, { noGateRedirect: true });
    LS.gate = phrase;
    syncBadge('');
    const info = await api('ping', {}, { timeout: 20000 });
    go(S.token ? 'home' : (info.ready ? 'login' : 'setupAdmin'), {}, true);
    if (S.token) sync({ silent: true });
  } catch (err) {
    syncBadge('');
    S.gate = ''; LS.gate = '';
    fieldErr('#g-err', errMsg(err));
  }
}

/** Admin: turn the shared gate on, change it, or switch it off. */
function gateSheet() {
  const on = !!(S.config && S.config.gated);
  const sheet = openSheet(`
    <h2>Access phrase 🔐</h2>
    <p class="sheet-sub">${on ? 'Currently <b>on</b>. Everyone needs this phrase before they can even see the login screen.'
                             : 'Currently <b>off</b>. Anyone who has your server URL can reach the login screen.'}</p>
    <div class="card mb" style="background:var(--card-2)">
      <p style="font-weight:650;font-size:13.5px;line-height:1.5;margin:0">
        This is one shared phrase for the whole app, entered once per device, on top of everyone's
        personal password. It's useful if your server URL ever leaks — but because everybody knows
        the same phrase, it doesn't rotate when someone moves out. Change it when that happens.</p>
    </div>
    <div class="field"><label>${on ? 'New phrase' : 'Phrase'}</label>
      <input class="input" id="gs-p" type="text" placeholder="six characters or more"
             autocapitalize="off" autocorrect="off" spellcheck="false"></div>
    <p class="hint mb">⚠️ Everyone, including you, has to enter this again on every device.</p>
    <div class="flex mt">
      <button class="btn ghost grow" data-x="cancel">Cancel</button>
      ${on ? `<button class="btn danger" data-x="off">Turn off</button>` : ''}
      <button class="btn grow" data-x="save">${on ? 'Change it' : 'Turn it on'}</button>
    </div>`);
  sheet.addEventListener('click', async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') return sheet.close();
    if (b.dataset.x === 'off') {
      sheet.close();
      if (!await confirmSheet('Turn the access phrase off?',
        'Anyone with your server URL will be able to reach the login screen again.', 'Turn it off')) return;
      try { await api('adminSetGate', { phrase: '' }); S.gate = ''; LS.gate = '';
        await sync({ silent: true }); toast('Access phrase off'); render(); }
      catch (err) { toast(errMsg(err)); }
      return;
    }
    const phrase = $('#gs-p', sheet).value.trim();
    if (phrase.length < 6) return toast('Use at least 6 characters');
    sheet.close();
    try {
      await api('adminSetGate', { phrase });
      S.gate = phrase; LS.gate = phrase;      // keep this device working
      await sync({ silent: true });
      confetti(60);
      toast('Access phrase set ✓');
      render();
    } catch (err) { toast(errMsg(err)); }
  });
}

async function doClaimAdmin() {
  const key = $('#s-key').value.trim(), name = $('#s-name').value.trim();
  const username = $('#s-user').value.trim(), pw = $('#s-pw').value, pw2 = $('#s-pw2').value;
  if (!key) return fieldErr('#s-err', 'The setup key is required.');
  if (!username) return fieldErr('#s-err', 'Pick a username.');
  if (pw.length < 8) return fieldErr('#s-err', 'Admin passwords need at least 8 characters.');
  if (pw !== pw2) return fieldErr('#s-err', "Those passwords don't match.");
  try {
    syncBadge('<span class="spinner"></span>Creating…');
    const salt = hexBytes(16);
    const dk = await derive(pw, salt, 210000);
    const r = await api('claimAdmin', { setupKey: key, username, displayName: name || username, salt, dk });
    S.token = r.token; LS.token = r.token;
    await applyState(r.state);
    syncBadge(''); confetti(140);
    go('home', {}, true);
    sync({ silent: true, full: true });
  } catch (err) { syncBadge(''); fieldErr('#s-err', errMsg(err)); }
}

async function doLogin() {
  const username = $('#l-user').value.trim(), pw = $('#l-pw').value;
  if (!username || !pw) return fieldErr('#l-err', 'Both fields, please.');
  try {
    syncBadge('<span class="spinner"></span>Checking…');
    const s = await api('authSalt', { username });
    const dk = await derive(pw, s.salt, s.iterations);
    const r = await api('login', { username, dk });
    S.token = r.token; LS.token = r.token;
    await applyState(r.state);
    const joinAfter = S.params.joinAfter;
    if (joinAfter) {
      try { const j = await api('joinLedger', { invite: joinAfter }); await applyState(j.state); confetti(90); }
      catch (e2) { toast(errMsg(e2)); }
    }
    syncBadge('');
    go('home', {}, true);
    sync({ silent: true, full: true });
  } catch (err) { syncBadge(''); fieldErr('#l-err', errMsg(err)); }
}

async function signOut(silent) {
  S.token = ''; LS.token = '';
  S.me = null; S.users = []; S.ledgers = []; S.members = []; S.txns = {}; S.cursors = {};
  await DB.wipe();
  if (!silent) { go('login', {}, true); toast('Signed out'); }
  else render();
}

/* ───────────────────────────────────────────────────────────────── boot */
async function boot() {
  Updater.init();

  await loadCache();

  const hash = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const inviteToken = hash[0] === 'join' ? hash[1] : null;

  /* A link can carry the backend with it — #/join/<token>/<id> or #/connect/<id>.
     That's what lets someone go from "tapped a text message" to "choose your
     password" without ever seeing a setup screen. */
  const linkedId  = hash[0] === 'join' ? hash[2] : (hash[0] === 'connect' ? hash[1] : null);
  const linkedApi = linkedId ? backendFromId(linkedId) : '';

  if (linkedApi) {
    if (!S.api) {
      S.api = linkedApi; LS.api = linkedApi;          // fresh device: just adopt it
    } else if (S.api !== linkedApi) {
      // Already pointed somewhere else. Never silently switch someone's data.
      S.view = 'switch';
      S.params = { to: linkedApi, invite: inviteToken };
      return render();
    }
  }

  if (!S.api) {
    // No backend and no link to learn one from.
    S.view = 'connect';
    S.params = { needServer: !!inviteToken };
    return render();
  }

  // If a gate is configured and this device hasn't got the phrase, stop here.
  // Offline devices skip the check and run from cache — the queue syncs later.
  if (!S.gate && navigator.onLine) {
    try {
      const info = await api('ping', {}, { timeout: 20000 });
      if (info.gated) { S.view = 'gate'; S.params = {}; return render(); }
    } catch (e) { /* offline or unreachable — fall through to the cache */ }
  }

  if (inviteToken && !S.token) {
    S.view = 'invite'; S.params = { token: inviteToken }; render();
    try { S.params.invite = await api('inviteInfo', { invite: inviteToken }); }
    catch (e) { S.params.invite = { error: errMsg(e) }; }
    return render();
  }

  if (!S.token) {
    if (hash[0] === 'connect') history.replaceState(null, '', location.pathname);
    try { const info = await api('ping', {}, { timeout: 20000 });
      S.config.appName = info.appName || S.config.appName;
      S.view = info.ready ? 'login' : 'setupAdmin';
    } catch (e) { S.view = 'login'; }
    return render();
  }

  // logged in
  S.view = S.me ? 'home' : 'home';
  render();

  if (inviteToken) {
    try { const j = await api('joinLedger', { invite: inviteToken }); await applyState(j.state);
      history.replaceState(null, '', location.pathname); toast('Joined! 🎉'); confetti(80); }
    catch (e) { if (e.code !== 'OFFLINE') toast(errMsg(e)); }
  }

  await sync({ silent: false });
  if (!S.me) { S.view = 'login'; render(); }
}

boot();

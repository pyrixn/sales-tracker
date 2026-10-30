// Edge Function client. The URL comes from config.js (window.API_BASE_URL). A staff login is a Supabase session (access token in
// localStorage, sent as Authorization: Bearer). The panel password (owner) stays in localStorage and goes out as X-App-Secret.
// Every write carries a request id.
const SECRET_KEY = 'sales_tracker_secret';
const SESSION_KEY = 'sales_tracker_session';

export function rid() {
  try { return crypto.randomUUID(); } catch (e) { return 'r' + Date.now() + Math.random().toString(36).slice(2); }
}

export function getSecret() {
  try { return localStorage.getItem(SECRET_KEY) || ''; } catch (e) { return ''; }
}
// authEpoch moves on every set or clear: a reply to a request sent before that is never cached (not even when the secret reads the same).
let authEpoch = 0;
export function setSecret(v) {
  try { localStorage.setItem(SECRET_KEY, v); localStorage.removeItem(SESSION_KEY); } catch (e) {}
  authEpoch++;
  for (const k in cache) delete cache[k];
  inflight.clear();
}
export function clearSecret() {
  try { localStorage.removeItem(SECRET_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) {}
  authEpoch++;
  for (const k in cache) delete cache[k];
  inflight.clear();
  clearInitCache();
}

// ---- staff login (Supabase Auth) -------------------------------------------------------------------------------------
// The Supabase URL and anon key come from config.js (window.SUPABASE_URL, window.SUPABASE_ANON_KEY, set at build time).
// The anon key is used ONLY for the Auth endpoints below (sign-in and token refresh). Data never goes to Supabase with it:
// every data request goes to the Edge Function with the staff access token, as CLAUDE.md requires.
function authConfig() {
  const url = String(window.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(window.SUPABASE_ANON_KEY || '');
  return url && anonKey ? { url, anonKey } : null;
}
export function emailSignInEnabled() { return !!authConfig(); }

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.access_token && s.user_id ? s : null;
  } catch (e) { return null; }
}
function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); localStorage.removeItem(SECRET_KEY); } catch (e) {}
  authEpoch++;
  for (const k in cache) delete cache[k];
  inflight.clear();
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  authEpoch++;
  for (const k in cache) delete cache[k];
  inflight.clear();
  clearInitCache();
}
/** The credential the panel is signed in with: the staff user id, or the password. It keys the first-paint cache. */
export function credential() {
  const s = getSession();
  return s ? 'user:' + s.user_id : getSecret();
}

function sessionFrom(data) {
  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token || ''),
    expires_at: Number(data.expires_at) || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    user_id: String(data.user && data.user.id || ''),
    email: String(data.user && data.user.email || '')
  };
}
async function authPost(path, body) {
  const cfg = authConfig();
  if (!cfg) return { ok: false, status: 0, error: 'Email sign-in is not set up in this build.' };
  try {
    const r = await fetch(cfg.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => null);
    return { ok: r.ok && !!data && !!data.access_token, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: 'Network error' };
  }
}

/** Email and password sign-in. The password goes only in the Auth request body. -> { ok } | { ok: false, error } */
export async function signInWithPassword(email, password) {
  const r = await authPost('/auth/v1/token?grant_type=password', { email: String(email || '').trim(), password: String(password || '') });
  if (!r.ok) {
    if (r.error) return { ok: false, error: r.error };
    return { ok: false, error: r.status === 400 || r.status === 422 ? 'That email or password is not right.' : 'Could not sign in. Try again.' };
  }
  saveSession(sessionFrom(r.data));
  return { ok: true };
}

let refreshing = null;
async function refreshSession(s) {
  const r = await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  if (r.ok) { saveSession(sessionFrom(r.data)); return getSession(); }
  // The refresh was refused (revoked or expired): sign in again. A network error keeps the session for the next try.
  if (r.status === 400 || r.status === 401 || r.status === 403) { clearSession(); return null; }
  return s;
}
// The session to send, refreshed first when its token is about to expire. One refresh at a time.
async function currentSession() {
  const s = getSession();
  if (!s) return null;
  if (s.expires_at * 1000 - Date.now() > 60000) return s;
  if (!refreshing) refreshing = refreshSession(s).finally(() => { refreshing = null; });
  return refreshing;
}

// ---- first-paint cache for init (stale-while-revalidate) ------------------------------------------------------------
// The last init answer lives in sessionStorage under st:init:<hash of the credential>, stamped with the Dhaka date it was computed for. A warm
// load paints it at once and the real read replaces it. It is only used when its date is TODAY in Dhaka (so "today" figures never carry
// over past midnight) and when the key matches the current credential (a different or cleared one finds nothing). Sign-out removes it.
// Every storage access is in try/catch: with no storage the panel simply paints after the network, as before.
const INIT_PREFIX = 'st:init:';
let DHAKA = null;
try { DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) {}
export function dhakaToday() {
  try { return DHAKA.format(new Date()); } catch (e) { return ''; }
}
function hashSecret(str) {   // cyrb53: only keeps the secret itself out of storage keys
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const initKey = cred => INIT_PREFIX + hashSecret(cred === undefined ? credential() : cred);

/** The cached init answer for the current credential and today's Dhaka date, or null. An entry from another day is removed. */
export function readInitCache() {
  try {
    const key = initKey();
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const today = dhakaToday();
    if (!v || !today || v.date !== today || !v.data || !v.data.lookups || !v.data.home || v.data.home.today !== today) {
      sessionStorage.removeItem(key);
      return null;
    }
    return v.data;
  } catch (e) { return null; }
}
// Written under the credential the request was sent with, and only while it is still the current one (a reply landing after sign-out is dropped).
function writeInitCache(data, cred) {
  try {
    if (credential() !== cred) return;
    const date = data && data.home && data.home.today;
    if (!date) return;
    sessionStorage.setItem(initKey(cred), JSON.stringify({ date, data }));
  } catch (e) {}
}
/** Removes the cached init of every credential. */
export function clearInitCache() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf(INIT_PREFIX) === 0) sessionStorage.removeItem(k);
    }
  } catch (e) {}
}

// init and home are answered with a version. When we hold one for the same call, send it as ifNone: the server then
// replies { notModified: true, version } and we keep the cached data instead of downloading it again.
const VERSIONED = { init: true, home: true };
const cache = {};   // key -> { version, data }
const cacheKey = (action, payload) => action + ':' + JSON.stringify(payload || {});

// Single flight: an identical read (same action and payload) already on its way is shared, not sent twice. Writes are never shared.
// A read may join only a read that started after the last write finished: readEpoch moves when a write finishes and on invalidate(),
// so a read joined to an older one can never return the answer from before the caller's own write.
const READS = {};
['moneyOverview', 'moneyExport', 'init', 'home', 'lookups', 'customer', 'reminderMessage', 'dues', 'accounts', 'payLinks', 'payRequests',
  'deliveries', 'book', 'entry', 'product', 'profit', 'suggestCustomers', 'insights', 'inbox', 'reminderLog', 'activity', 'importReview', 'profitMonthly', 'orders', 'apiKeys', 'webhooks', 'notifyStatus', 'staffList', 'me'].forEach(a => { READS[a] = true; });
const inflight = new Map();   // action:JSON(payload) -> { p, epoch }
let readEpoch = 0;
let writesPending = 0;

/** Ends the sharing of reads already in flight: the next identical read is sent. */
export function invalidate() { readEpoch++; }
/** Number of writes sent and not yet answered. A poll waits for these. */
export function writesInFlight() { return writesPending; }

/** call(action, payload) -> { ok, data } | { ok: false, error } */
export function call(action, payload) {
  if (!READS[action]) {
    writesPending++;
    return send(action, payload).finally(() => { writesPending--; readEpoch++; });
  }
  const k = cacheKey(action, payload);
  const open = inflight.get(k);
  if (open && open.epoch === readEpoch) return open.p;
  const epoch = readEpoch;
  const p = send(action, payload).finally(() => { if (inflight.get(k) && inflight.get(k).p === p) inflight.delete(k); });
  inflight.set(k, { p, epoch });
  return p;
}

let sendSeq = 0;   // numbers the requests in the order they are sent: a reply to an older request never replaces a newer cached one
async function send(action, payload) {
  const apiBase = window.API_BASE_URL;
  if (!apiBase) return { ok: false, error: 'API URL not configured.' };
  const headers = { 'Content-Type': 'application/json' };
  const cred = credential();
  const mine = ++sendSeq;
  const auth = authEpoch;
  const storable = () => auth === authEpoch && credential() === cred;   // still the same sign-in when the reply lands
  const session = await currentSession();
  if (session) headers.Authorization = 'Bearer ' + session.access_token;
  else if (cred && cred.indexOf('user:') !== 0) headers['X-App-Secret'] = cred;
  const key = VERSIONED[action] ? cacheKey(action, payload) : '';
  // A warm reload: the cached init carries its version, so the server can answer notModified instead of the whole thing.
  if (key && !cache[key] && action === 'init') {
    const warm = readInitCache();
    if (warm && typeof warm.version === 'string') cache[key] = { version: warm.version, data: warm };
  }
  const held = key ? cache[key] : null;
  const body = Object.assign({}, payload || {});
  if (held) body.ifNone = held.version;
  try {
    const r = await fetch(apiBase, { method: 'POST', headers, body: JSON.stringify({ action, payload: body }) });
    let res;
    try { res = await r.json(); } catch (e) { return { ok: false, error: 'Bad response (' + r.status + ')' }; }
    if (key && res && res.ok && res.data) {
      // A newer request's answer is already cached: this older one must not replace it (in memory or in the first-paint cache).
      const stale = !!(cache[key] && (cache[key].seq || 0) > mine) || !storable();
      if (res.data.notModified === true && held) {
        if (action === 'init' && !stale) writeInitCache(held.data, cred);
        return { ok: true, data: held.data };
      }
      if (!stale && typeof res.data.version === 'string') cache[key] = { version: res.data.version, data: res.data, seq: mine };
      if (action === 'init' && res.data.lookups && !stale) writeInitCache(res.data, cred);
    }
    if (action === 'init' && res && !res.ok && res.error === 'Unauthorized') clearInitCache();
    // A refused login token: forget it, so the panel asks for sign-in again instead of retrying the same token.
    // access_changed: the staff row no longer matches this token (deactivated, or a new role). Sign in again to get a fresh token.
    if (session && res && !res.ok && (res.error === 'Unauthorized' || res.code === 'access_changed' || res.error === 'This login has no staff access.')) clearSession();
    return res;
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Network error' };
  }
}

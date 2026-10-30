// Staff accounts through the real router: who may call what, token checks, the actor on change_log, and staff administration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { loginToken, signJwt } = require('./support/jwt');
const { cid } = require('./fixtures');

const SECRET = 'app-secret-for-tests';
const JWT = 'jwt-secret-for-tests-0123456789';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const NOW = () => Math.floor(Date.now() / 1000);

async function boot(env) {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  await seedDb(db, tables, m);
  tables.staff.set(OWNER_ID, { user_id: OWNER_ID, email: 'owner@example.test', role: 'owner', active: true, created_at: '2026-10-01' });
  tables.staff.set(STAFF_ID, { user_id: STAFF_ID, email: 'staff@example.test', role: 'staff', active: true, created_at: '2026-10-02' });
  tables.staff.set(VIEWER_ID, { user_id: VIEWER_ID, email: 'viewer@example.test', role: 'viewer', active: true, created_at: '2026-10-03' });
  const e = Object.assign({ APP_SECRET: SECRET, SUPABASE_JWT_SECRET: JWT }, env || {});
  return { db, tables, edge: loadEdge(db, { env: e }) };
}
function post(body, headers) {
  return new Request('https://x.test/functions/v1/api/', { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
}
const bearer = t => ({ Authorization: 'Bearer ' + t });
const call = async (edge, body, headers) => { const r = await edge.handle(post(body, headers)); return { status: r.status, body: await r.json() }; };
const all = tbl => (Array.isArray(tbl) ? tbl : Array.from(tbl.values()));

test('owner: the panel password still works and is the owner, actor secret', async () => {
  const { edge } = await boot();
  const r = await call(edge, { action: 'me' }, { 'X-App-Secret': SECRET });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { role: 'owner', email: '', actor: 'secret' });
  const init = await call(edge, { action: 'init' }, { 'X-App-Secret': SECRET });
  assert.equal(init.body.data.me.role, 'owner');
});

test('no secret and no token is 401; a wrong secret is 401', async () => {
  const { edge } = await boot();
  assert.equal((await call(edge, { action: 'home' })).status, 401);
  assert.equal((await call(edge, { action: 'home' }, { 'X-App-Secret': 'nope' })).status, 401);
});

test('neither APP_SECRET nor SUPABASE_JWT_SECRET set: refused, fail closed', async () => {
  const { edge } = await boot({ APP_SECRET: '', SUPABASE_JWT_SECRET: '' });
  const r = await call(edge, { action: 'home' }, { 'X-App-Secret': SECRET, ...bearer(loginToken({}, JWT)) });
  assert.equal(r.status, 503);
});

test('staff token: reads and sales work; settings, money and staff admin are refused with 403', async () => {
  const { edge } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  const me = await call(edge, { action: 'me' }, t);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.role, 'staff');
  assert.equal(me.body.data.email, 'staff@example.test');
  assert.equal(me.body.data.actor, STAFF_ID);
  assert.equal((await call(edge, { action: 'home' }, t)).status, 200);
  const denied = await call(edge, { action: 'settings', payload: { values: { bkash_number: '01799999999' } } }, t);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.ok, false);
  assert.equal((await call(edge, { action: 'moneyOverview', payload: {} }, t)).status, 403);
  assert.equal((await call(edge, { action: 'staffList', payload: {} }, t)).status, 403);
});

test('staff sale: the change is logged with the staff user id as actor', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  const r = await call(edge, { action: 'pay', payload: { requestId: 'staff-pay-1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, t);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.ok(all(tables.change_log).some(l => l.actor === STAFF_ID), 'a change_log line names the staff user');
  assert.ok(!all(tables.change_log).some(l => l.actor === 'secret'), 'no line claims the password');
});

test('owner write through the password is logged with actor secret', async () => {
  const { edge, tables } = await boot();
  const r = await call(edge, { action: 'settings', payload: { requestId: 'o-set-1', values: { bkash_number: '01799999999' } } }, { 'X-App-Secret': SECRET });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.ok(all(tables.change_log).some(l => l.actor === 'secret' && l.action === 'settings'));
});

test('viewer token: reads only; a sale is refused with 403 and nothing is written', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: VIEWER_ID, app_role: 'viewer' }, JWT));
  assert.equal((await call(edge, { action: 'init' }, t)).status, 200);
  const before = all(tables.change_log).length;
  const r = await call(edge, { action: 'pay', payload: { requestId: 'v1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, t);
  assert.equal(r.status, 403);
  assert.equal(all(tables.change_log).length, before, 'nothing written');
});

test('bad tokens: wrong signature, expired, wrong audience, alg none, not yet valid, garbage: all 401', async () => {
  const { edge } = await boot();
  const forged = loginToken({ sub: STAFF_ID, app_role: 'owner' }, 'some-other-secret');
  const expired = loginToken({ sub: STAFF_ID, exp: NOW() - 5 }, JWT);
  const wrongAud = loginToken({ sub: STAFF_ID, aud: 'anon' }, JWT);
  const noneAlg = signJwt({ sub: STAFF_ID, app_role: 'owner', aud: 'authenticated', exp: NOW() + 600 }, '', { alg: 'none', typ: 'JWT' });
  const future = loginToken({ sub: STAFF_ID, nbf: NOW() + 3600 }, JWT);
  for (const tok of [forged, expired, wrongAud, noneAlg, future, 'not-a-token', 'a.b.c']) {
    const r = await call(edge, { action: 'home' }, bearer(tok));
    assert.equal(r.status, 401, tok.slice(0, 20));
    assert.equal(r.body.ok, false);
  }
});

test('a valid login with no app_role claim gets 403, and an unknown role claim too', async () => {
  const { edge } = await boot();
  const noRole = loginToken({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', app_role: undefined }, JWT);
  assert.equal((await call(edge, { action: 'home' }, bearer(noRole))).status, 403);
  const weird = loginToken({ sub: STAFF_ID, app_role: 'admin' }, JWT);
  assert.equal((await call(edge, { action: 'home' }, bearer(weird))).status, 403);
});

test('a token with no sub is 401 (it would otherwise log as system work)', async () => {
  const { edge } = await boot();
  const t = signJwt({ aud: 'authenticated', app_role: 'owner', exp: NOW() + 600 }, JWT);
  assert.equal((await call(edge, { action: 'home' }, bearer(t))).status, 401);
});

test('with only SUPABASE_JWT_SECRET set, the password is not accepted', async () => {
  const { edge } = await boot({ APP_SECRET: '' });
  assert.equal((await call(edge, { action: 'home' }, { 'X-App-Secret': SECRET })).status, 401);
  assert.equal((await call(edge, { action: 'home' }, bearer(loginToken({ sub: STAFF_ID }, JWT)))).status, 200);
});

test('a staff token is refused when SUPABASE_JWT_SECRET is not configured', async () => {
  const { edge } = await boot({ SUPABASE_JWT_SECRET: '' });
  assert.equal((await call(edge, { action: 'home' }, bearer(loginToken({ sub: STAFF_ID }, JWT)))).status, 401);
});

test('staffList: owner sees the list, staff cannot', async () => {
  const { edge } = await boot();
  const owner = await call(edge, { action: 'staffList', payload: {} }, { 'X-App-Secret': SECRET });
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.data.staff.map(s => s.email).sort(), ['owner@example.test', 'staff@example.test', 'viewer@example.test']);
  const staff = await call(edge, { action: 'staffList', payload: {} }, bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT)));
  assert.equal(staff.status, 403);
});

test('staffUpdate: owner changes a role and deactivates; logged as staff:role and staff:active with the owner as actor', async () => {
  const { edge, tables } = await boot();
  const r = await call(edge, { action: 'staffUpdate', payload: { requestId: 'su1', userId: STAFF_ID, role: 'viewer', active: false } }, { 'X-App-Secret': SECRET });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(tables.staff.get(STAFF_ID).role, 'viewer');
  assert.equal(tables.staff.get(STAFF_ID).active, false);
  const lines = all(tables.change_log).filter(l => /^staff:/.test(l.action));
  assert.deepEqual(lines.map(l => [l.action, l.field, l.old, l.new, l.actor]).sort(), [
    ['staff:active', 'active', 'true', 'false', 'secret'],
    ['staff:role', 'role', 'staff', 'viewer', 'secret']]);
});

test('staffUpdate: refuses your own access, unknown or malformed ids, and promotion to owner', async () => {
  const { edge, tables } = await boot();
  const own = bearer(loginToken({ sub: OWNER_ID, app_role: 'owner' }, JWT));
  const self = await call(edge, { action: 'staffUpdate', payload: { requestId: 's1', userId: OWNER_ID, active: false } }, own);
  assert.equal(self.body.ok, false);
  assert.match(self.body.error, /your own access/);
  const unknown = await call(edge, { action: 'staffUpdate', payload: { requestId: 's2', userId: '99999999-9999-4999-8999-999999999999', active: false } }, { 'X-App-Secret': SECRET });
  assert.match(unknown.body.error, /Unknown staff member/);
  const bad = await call(edge, { action: 'staffUpdate', payload: { requestId: 's3', userId: 'not-a-uuid', role: 'staff' } }, { 'X-App-Secret': SECRET });
  assert.match(bad.body.error, /Unknown staff member/);
  const promote = await call(edge, { action: 'staffUpdate', payload: { requestId: 's4', userId: STAFF_ID, role: 'owner' } }, { 'X-App-Secret': SECRET });
  assert.match(promote.body.error, /staff or viewer/);
  assert.equal(tables.staff.get(STAFF_ID).role, 'staff', 'nothing changed');
});

test('staffUpdate: the only active owner cannot be deactivated; with a second owner it can', async () => {
  const { edge, tables } = await boot();
  const last = await call(edge, { action: 'staffUpdate', payload: { requestId: 's5', userId: OWNER_ID, active: false } }, { 'X-App-Secret': SECRET });
  assert.match(last.body.error, /At least one active owner/);
  assert.equal(tables.staff.get(OWNER_ID).active, true);
  tables.staff.set('44444444-4444-4444-8444-444444444444', { user_id: '44444444-4444-4444-8444-444444444444', email: 'o2@example.test', role: 'owner', active: true, created_at: '2026-10-04' });
  const ok = await call(edge, { action: 'staffUpdate', payload: { requestId: 's6', userId: OWNER_ID, active: false } }, { 'X-App-Secret': SECRET });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
});

test('staffInvite: invite through Supabase with the service key, add the row as staff; bad input is refused without an invite', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: '55555555-5555-4555-8555-555555555555' }), { status: 200 });
  };
  try {
    const { edge, tables } = await boot({ SUPABASE_URL: 'https://proj.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' });
    const r = await call(edge, { action: 'staffInvite', payload: { requestId: 'i1', email: ' New.Person@Example.test ', role: 'staff' } }, { 'X-App-Secret': SECRET });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://proj.test/auth/v1/invite');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer service-key-value');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'new.person@example.test' });
    assert.equal(tables.staff.get('55555555-5555-4555-8555-555555555555').role, 'staff');
    assert.ok(all(tables.change_log).some(l => l.action === 'staff:invite' && l.actor === 'secret'));
    const bad = await call(edge, { action: 'staffInvite', payload: { requestId: 'i3', email: 'nope', role: 'staff' } }, { 'X-App-Secret': SECRET });
    assert.match(bad.body.error, /valid email/);
    const owner = await call(edge, { action: 'staffInvite', payload: { requestId: 'i4', email: 'boss@example.test', role: 'owner' } }, { 'X-App-Secret': SECRET });
    assert.match(owner.body.error, /staff or viewer/);
    assert.equal(calls.length, 1, 'no invite for a refused request');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('staffInvite without the service key says what is missing, and writes nothing', async () => {
  const { edge, tables } = await boot({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
  const r = await call(edge, { action: 'staffInvite', payload: { requestId: 'i5', email: 'a@example.test', role: 'staff' } }, { 'X-App-Secret': SECRET });
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(tables.staff.size, 3);
});

test('Undo skips staff lines: it reverts the last sale, not the last staff change', async () => {
  const { edge, tables } = await boot();
  const pay = await call(edge, { action: 'pay', payload: { requestId: 'u-pay', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, { 'X-App-Secret': SECRET });
  assert.equal(pay.body.ok, true, JSON.stringify(pay.body));
  await call(edge, { action: 'staffUpdate', payload: { requestId: 'u-staff', userId: STAFF_ID, role: 'viewer' } }, { 'X-App-Secret': SECRET });
  const undo = await call(edge, { action: 'undo', payload: { requestId: 'u-undo' } }, { 'X-App-Secret': SECRET });
  assert.equal(undo.body.ok, true, JSON.stringify(undo.body));
  assert.equal(tables.staff.get(STAFF_ID).role, 'viewer', 'the staff change is not undone');
});

test('edit: staff cannot void a sale or retire an account, even sending _role owner; the owner can', async () => {
  const { edge, tables } = await boot();
  const m = makeUiState();
  const acct = m.accounts[0].Account_ID, saleId = m.sales[0].Sale_ID;
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  const acc = await call(edge, { action: 'edit', payload: { requestId: 'e1', kind: 'account', id: acct, values: { Account_Status: 'Deleted' } } }, t);
  assert.equal(acc.body.ok, false);
  assert.match(acc.body.error, /^Only the owner can change Account_Status/);
  const sale = await call(edge, { action: 'edit', payload: { requestId: 'e2', kind: 'sale', id: saleId, values: { Record_Status: 'Void' } } }, t);
  assert.equal(sale.body.ok, false);
  assert.match(sale.body.error, /^Only the owner can change Record_Status/);
  const forged = await call(edge, { action: 'edit', payload: { requestId: 'e3', _role: 'owner', kind: 'sale', id: saleId, values: { Record_Status: 'Void' } } }, t);
  assert.equal(forged.body.ok, false);
  assert.match(forged.body.error, /Only the owner/);
  const owner = await call(edge, { action: 'edit', payload: { requestId: 'e4', kind: 'sale', id: saleId, values: { Record_Status: 'Void' } } }, { 'X-App-Secret': SECRET });
  assert.equal(owner.body.ok, true, JSON.stringify(owner.body));
});

test('request id reuse: another action or another caller is refused; the same caller and action replays', async () => {
  const { edge } = await boot();
  const cust = cid(makeUiState(), 'Kabir');
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  const first = await call(edge, { action: 'pay', payload: { requestId: 'reuse-1', customerId: cust, amount: 100, method: 'bKash' } }, t);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const again = await call(edge, { action: 'pay', payload: { requestId: 'reuse-1', customerId: cust, amount: 100, method: 'bKash' } }, t);
  assert.deepEqual(again.body, first.body);
  assert.ok(!('_req' in again.body));
  const other = await call(edge, { action: 'edit', payload: { requestId: 'reuse-1', kind: 'customer', id: cust, values: { Notes: 'x' } } }, t);
  assert.equal(other.body.ok, false);
  assert.equal(other.body.error, 'Request id already used for another action.');
  const caller = await call(edge, { action: 'pay', payload: { requestId: 'reuse-1', customerId: cust, amount: 100, method: 'bKash' } }, { 'X-App-Secret': SECRET });
  assert.equal(caller.body.error, 'Request id already used for another action.');
});

test('API key and webhook owner actions write change_log lines without secrets', async () => {
  const { edge, tables } = await boot();
  const H = { 'X-App-Secret': SECRET };
  const k = await call(edge, { action: 'createApiKey', payload: { requestId: 'k1', name: 'Site', scopes: ['catalog:read'] } }, H);
  assert.equal(k.body.ok, true, JSON.stringify(k.body));
  const w = await call(edge, { action: 'saveWebhook', payload: { requestId: 'w1', url: 'https://hooks.example.test/secret-path?t=abc', events: ['order.created'] } }, H);
  assert.equal(w.body.ok, true, JSON.stringify(w.body));
  const rev = await call(edge, { action: 'revokeApiKey', payload: { requestId: 'k2', keyId: k.body.data.keyId } }, H);
  assert.equal(rev.body.ok, true, JSON.stringify(rev.body));
  const lines = all(tables.change_log).filter(l => /^(apiKey|webhook):/.test(l.action));
  assert.deepEqual(lines.map(l => l.action).sort(), ['apiKey:create', 'apiKey:revoke', 'webhook:add']);
  const dump = JSON.stringify(lines);
  assert.ok(!dump.includes(k.body.data.key) && !dump.includes(w.body.data.secret) && !dump.includes('secret-path'), 'no key, secret or url path in the log');
  assert.match(dump, /hooks\.example\.test/);
});

test('staffInvite: an address that already has a login is linked by looking its id up, not refused', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    if (String(url).endsWith('/auth/v1/invite')) return new Response(JSON.stringify({ error_code: 'email_exists', msg: 'exists' }), { status: 422 });
    return new Response(JSON.stringify({ users: [{ id: '66666666-6666-4666-8666-666666666666', email: 'Old.Login@Example.test', email_confirmed_at: '2026-10-01T00:00:00Z' }] }), { status: 200 });
  };
  try {
    const { edge, tables } = await boot({ SUPABASE_URL: 'https://proj.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' });
    const r = await call(edge, { action: 'staffInvite', payload: { requestId: 'i9', email: 'old.login@example.test', role: 'viewer' } }, { 'X-App-Secret': SECRET });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(tables.staff.get('66666666-6666-4666-8666-666666666666').role, 'viewer');
    assert.ok(seen.some(u => u.includes('/auth/v1/admin/users')));
  } finally { globalThis.fetch = realFetch; }
});

test('staffInvite links an existing login only when its email is confirmed', async () => {
  const realFetch = globalThis.fetch;
  const mk = confirmed => async url => {
    if (String(url).endsWith('/invite')) return new Response(JSON.stringify({ error_code: 'email_exists', msg: 'registered' }), { status: 422 });
    return new Response(JSON.stringify({ users: [{ id: '66666666-6666-4666-8666-666666666666', email: 'Taken@Example.test', email_confirmed_at: confirmed ? '2026-10-01T00:00:00Z' : null }] }), { status: 200 });
  };
  try {
    const env = { SUPABASE_URL: 'https://proj.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' };
    globalThis.fetch = mk(false);
    let h = await boot(env);
    let r = await call(h.edge, { action: 'staffInvite', payload: { requestId: 'c1', email: 'taken@example.test', role: 'staff' } }, { 'X-App-Secret': SECRET });
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /exists but is not confirmed/);
    assert.equal(h.tables.staff.size, 3);
    globalThis.fetch = mk(true);
    h = await boot(env);
    r = await call(h.edge, { action: 'staffInvite', payload: { requestId: 'c2', email: 'taken@example.test', role: 'staff' } }, { 'X-App-Secret': SECRET });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(h.tables.staff.get('66666666-6666-4666-8666-666666666666'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('request_log row without _req replays for the owner only', async () => {
  const { edge, tables } = await boot();
  tables.request_log.set('old-1', { request_id: 'old-1', response: JSON.stringify({ ok: true, data: { message: 'legacy' } }), created_at: new Date().toISOString() });
  const staff = await call(edge, { action: 'pay', payload: { requestId: 'old-1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT)));
  assert.equal(staff.body.ok, false);
  assert.match(staff.body.error, /Request id already used for another action/);
  const owner = await call(edge, { action: 'pay', payload: { requestId: 'old-1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, { 'X-App-Secret': SECRET });
  assert.equal(owner.body.ok, true);
  assert.equal(owner.body.data.message, 'legacy');
});

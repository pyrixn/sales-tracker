// Staff access through the router: money fields redacted for staff and viewers (owner unchanged), and the staff row checked on every
// token request (deactivation, downgrade and removal refused at once with 403).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { loginToken } = require('./support/jwt');
const { cid } = require('./fixtures');

const SECRET = 'app-secret-for-tests';
const JWT = 'jwt-secret-for-tests-0123456789';
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const MONEY = ['cost', 'costSnapshot', 'budgets', 'suppliers', 'expenseCategories', 'totals', 'net', 'collected', 'profit', 'expenses', 'purchases', 'markup', 'margin'];

async function boot() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  tables.staff.set(STAFF_ID, { user_id: STAFF_ID, email: 'staff@example.test', role: 'staff', active: true, created_at: '2026-10-02' });
  tables.staff.set(VIEWER_ID, { user_id: VIEWER_ID, email: 'viewer@example.test', role: 'viewer', active: true, created_at: '2026-10-03' });
  return { db, tables, edge: loadEdge(db, { env: { APP_SECRET: SECRET, SUPABASE_JWT_SECRET: JWT } }) };
}
const post = (body, headers) => new Request('https://x.test/functions/v1/api/', { method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
const call = async (edge, body, headers) => { const r = await edge.handle(post(body, headers)); return { status: r.status, body: await r.json() }; };
const bearer = t => ({ Authorization: 'Bearer ' + t });
function keysDeep(v, out) {
  out = out || new Set();
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.add(k); keysDeep(v[k], out); }
  return out;
}

test('staff and viewer reads carry no money fields; the owner still gets them', async () => {
  const { edge } = await boot();
  const owner = await call(edge, { action: 'init' }, { 'X-App-Secret': SECRET });
  const ownerKeys = keysDeep(owner.body.data);
  for (const k of ['cost', 'suppliers', 'expenseCategories']) assert.equal(ownerKeys.has(k), true, 'owner has ' + k);
  for (const [id, role] of [[STAFF_ID, 'staff'], [VIEWER_ID, 'viewer']]) {
    const t = bearer(loginToken({ sub: id, app_role: role }, JWT));
    for (const action of ['init', 'home', 'lookups', 'accounts', 'product']) {
      const payload = action === 'product' ? { productId: 'EXITLAG' } : {};
      const r = await call(edge, { action, payload }, t);
      // accounts is a staff read only (src/core/permissions.js): a viewer is refused, not redacted.
      if (role === 'viewer' && action === 'accounts') { assert.equal(r.status, 403); continue; }
      assert.equal(r.status, 200, role + ' ' + action);
      const keys = keysDeep(r.body.data);
      for (const k of MONEY) assert.equal(keys.has(k), false, role + ' ' + action + ' still has ' + k);
    }
  }
});

test('staff sale reply carries no cost field', async () => {
  const { edge } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  const r = await call(edge, { action: 'pay', payload: { requestId: 'red-1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, t);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const keys = keysDeep(r.body.data);
  for (const k of MONEY) assert.equal(keys.has(k), false, 'pay reply still has ' + k);
});

test('a deactivated staff login is refused at once with 403, and works again once reactivated', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  assert.equal((await call(edge, { action: 'home' }, t)).status, 200);
  tables.staff.get(STAFF_ID).active = false;
  const r = await call(edge, { action: 'home' }, t);
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  tables.staff.get(STAFF_ID).active = true;
  assert.equal((await call(edge, { action: 'home' }, t)).status, 200);
});

test('a removed staff row is refused with 403', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  tables.staff.delete(STAFF_ID);
  assert.equal((await call(edge, { action: 'home' }, t)).status, 403);
});

test('a downgraded login (row now viewer, token still says staff) is refused at once with access_changed, and writes nothing', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: STAFF_ID, app_role: 'staff' }, JWT));
  tables.staff.get(STAFF_ID).role = 'viewer';
  const before = Array.from(tables.change_log).length;
  const r = await call(edge, { action: 'pay', payload: { requestId: 'dg-1', customerId: cid(makeUiState(), 'Kabir'), amount: 300, method: 'bKash' } }, t);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'access_changed');
  assert.equal(Array.from(tables.change_log).length, before, 'nothing written');
});

test('an upgraded row against an old viewer token is also refused with access_changed (sign in again)', async () => {
  const { edge, tables } = await boot();
  const t = bearer(loginToken({ sub: VIEWER_ID, app_role: 'viewer' }, JWT));
  tables.staff.get(VIEWER_ID).role = 'staff';
  const r = await call(edge, { action: 'home' }, t);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'access_changed');
});

test('a valid token whose sub has no staff row is 403; a non-uuid sub is 401', async () => {
  const { edge } = await boot();
  const stranger = bearer(loginToken({ sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', app_role: 'staff' }, JWT));
  assert.equal((await call(edge, { action: 'home' }, stranger)).status, 403);
  const bad = bearer(loginToken({ sub: 'not-a-uuid', app_role: 'staff' }, JWT));
  assert.equal((await call(edge, { action: 'home' }, bad)).status, 401);
});

test('the owner by password is not checked against a staff row and sees money', async () => {
  const { edge, tables } = await boot();
  tables.staff.clear();
  const r = await call(edge, { action: 'home' }, { 'X-App-Secret': SECRET });
  assert.equal(r.status, 200);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

async function host(env, opts) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  return { tables, edge: loadEdge(db, Object.assign({ env }, opts)) };
}
function post(path, body, headers) {
  return new Request('https://x.test/functions/v1/api' + path, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
}
const status = async (edge, req) => { const r = await edge.handle(req); return { status: r.status, body: await r.json() }; };

test('API POST with APP_SECRET unset is refused (fail closed)', async () => {
  const { edge, tables } = await host({});
  const before = tables.customers.size;
  const r = await status(edge, post('/', { action: 'home', payload: {} }));
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(tables.customers.size, before);
});

test('API POST: wrong or missing secret is 401, correct secret works', async () => {
  const { edge } = await host({ APP_SECRET: 's3cret-value' });
  assert.equal((await status(edge, post('/', { action: 'home' }))).status, 401);
  assert.equal((await status(edge, post('/', { action: 'home' }, { 'X-App-Secret': 's3cret-valuX' }))).status, 401);
  assert.equal((await status(edge, post('/', { action: 'home' }, { 'X-App-Secret': 's3cret-value' }))).status, 200);
});

test('/relay with RELAY_TOKEN unset is refused and writes nothing', async () => {
  const { edge, tables } = await host({ APP_SECRET: 'a' });
  const before = tables.payment_inbox.size;
  const r = await status(edge, post('/relay?src=bkash', { sender: '16247', text: 'You have received Tk 120.00 from 01712345678. TrxID ZZ1234567 at 18/10/2026 14:17' }));
  assert.equal(r.status, 503);
  assert.equal(tables.payment_inbox.size, before);
});

test('/relay: wrong token 401, right token stores the message', async () => {
  const { edge } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'tok-123' });
  const text = 'You have received Tk 120.00 from 01712345678. TrxID ZZ1234567 at 18/10/2026 14:17';
  assert.equal((await status(edge, post('/relay?src=bkash', { token: 'nope', sender: '16247', text }))).status, 401);
  assert.equal((await status(edge, post('/relay?src=bkash', { sender: '16247', text }))).status, 401);
  const ok = await status(edge, post('/relay?src=bkash', { token: 'tok-123', sender: '16247', text }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

test('/health stays open without secrets', async () => {
  const { edge } = await host({});
  const r = await edge.handle(new Request('https://x.test/functions/v1/api/health'));
  assert.equal(r.status, 200);
});

test('CORS: no ACAO header by default, never "*"; allowed origin is echoed exactly', async () => {
  const { edge } = await host({ APP_SECRET: 'a' });
  const h = (origin) => new Request('https://x.test/functions/v1/api/health', { headers: origin ? { Origin: origin } : {} });
  let r = await edge.handle(h('https://evil.test'));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);

  const { edge: e2 } = await host({ APP_SECRET: 'a', ALLOWED_ORIGIN: 'https://panel.example.test' });
  r = await e2.handle(h('https://panel.example.test'));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://panel.example.test');
  assert.equal(r.headers.get('Vary'), 'Origin');
  r = await e2.handle(h('https://evil.test'));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await e2.handle(new Request('https://x.test/functions/v1/api/', { method: 'OPTIONS', headers: { Origin: 'https://panel.example.test' } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://panel.example.test');
});

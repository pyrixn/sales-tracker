// The public API (/v1/...) through the real Edge router over the fake db: auth, origins, scopes, rate limits, the catalog, orders with
// Idempotency-Key, order status, the customer portal, owner key and webhook actions, and the webhook sender with signed bodies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { Core } = require('./load-core');

const TODAY = '2026-10-28';
const ORIGIN = 'https://shop.example';
const ALL = ['catalog:read', 'orders:write', 'orders:read', 'portal:read'];
let seq = 0;
const rid = () => 'rq-' + (++seq) + '-' + Math.random().toString(36).slice(2);

async function host() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  tables.settings.set('pay_base_url', 'https://pay.example');
  tables.accounts.set('EXL-09', { account_id: 'EXL-09', product_id: 'EXITLAG', account_label: 'Test seats', cycle_cost: 2000,
    renewal_date: '2026-11-20', slots: 5, notes: '', account_status: 'Active' });
  const edge = loadEdge(db, { today: TODAY, env: { APP_SECRET: 'x' } });
  const h = { db, tables, edge, api: (a, p) => edge.api(a, p || {}) };
  const pub = await h.api('editProductPublic', { productId: 'EXITLAG', slug: 'exitlag', public: true, publicPrice: 300, sortOrder: 1,
    description: 'Gaming ping reducer', requestId: rid() });
  assert.equal(pub.ok, true, pub.error);
  return h;
}
async function makeKey(h, scopes, origins) {
  const r = await h.api('createApiKey', { name: 'Shop', scopes: scopes || ALL, origins: origins === undefined ? [ORIGIN] : origins, requestId: rid() });
  assert.equal(r.ok, true, r.error);
  return r.data;
}
/** One request through the router. o: { key, origin, ip, idem, body | raw }. */
function req(h, method, path, o) {
  o = o || {};
  const headers = {};
  if (o.key) headers.Authorization = 'Bearer ' + o.key;
  if (o.origin) headers.Origin = o.origin;
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  if (o.idem) headers['Idempotency-Key'] = o.idem;
  let body;
  if (o.raw !== undefined) { body = o.raw; headers['Content-Type'] = 'application/json'; }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
  return h.edge.handle(new Request('https://api.example/functions/v1/api' + path, { method, headers, body }));
}
async function out(p) {
  const res = await p;
  const text = await res.text();
  return { status: res.status, headers: res.headers, text: text, body: text ? JSON.parse(text) : null };
}
const get = (h, path, o) => out(req(h, 'GET', path, o));
const post = (h, path, o) => out(req(h, 'POST', path, o));

/** Stubs the global fetch for the webhook sender. handler(url, init) -> Response. Returns the calls and a restore function. */
function stubFetch(handler) {
  const orig = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init }); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const goodOrder = (over) => Object.assign({ product: 'exitlag', months: 2, price: 300, customer: { name: 'Rahim', contact: '01711111111', channel: 'WhatsApp' } }, over || {});

// ---- auth, origin and scope ----

test('no key: 401 with a stable code and a Bearer challenge', async () => {
  const h = await host();
  const r = await get(h, '/v1/products');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'unauthorized');
  assert.equal(r.body.ok, false);
  assert.equal(r.headers.get('WWW-Authenticate'), 'Bearer');
});

test('a malformed key, an unknown key and a revoked key are all 401', async () => {
  const h = await host();
  const k = await makeKey(h);
  assert.equal((await get(h, '/v1/products', { key: 'st_live_short' })).status, 401);
  assert.equal((await get(h, '/v1/products', { key: 'st_live_' + 'Z'.repeat(32) })).status, 401);
  assert.equal((await get(h, '/v1/products', { key: k.key, origin: ORIGIN })).status, 200);
  assert.equal((await h.api('revokeApiKey', { keyId: k.keyId, requestId: rid() })).ok, true);
  const r = await get(h, '/v1/products', { key: k.key, origin: ORIGIN });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'unauthorized');
});

test('wrong origin: a browser call from another site is refused, and no origin is echoed', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await get(h, '/v1/products', { key: k.key, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'origin_not_allowed');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('right origin: the response echoes that origin only, never *', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await get(h, '/v1/products', { key: k.key, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.notEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(r.headers.get('Vary'), 'Origin');
});

test('a server call (no Origin header) with a key passes, and gets no CORS header', async () => {
  const h = await host();
  const k = await makeKey(h, ALL, []);
  const r = await get(h, '/v1/products', { key: k.key });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('wrong scope: a catalog key cannot place an order (403 insufficient_scope)', async () => {
  const h = await host();
  const k = await makeKey(h, ['catalog:read']);
  const r = await post(h, '/v1/orders', { key: k.key, idem: 'idem-scope-1', body: goodOrder() });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'insufficient_scope');
  assert.equal(h.tables.orders.size, 0);
});

test('the API key is stored only as a hash: the raw key appears nowhere in the rows', async () => {
  const h = await host();
  const k = await makeKey(h);
  assert.match(k.key, /^st_live_[0-9A-Za-z]{32}$/);
  const rows = [...h.tables.api_keys.values()];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(k.key), 'raw key is not stored');
  assert.equal(rows[0].hash.length, 64);
  const list = (await h.api('apiKeys')).data.keys;
  assert.ok(!JSON.stringify(list).includes(rows[0].hash), 'the panel never gets the hash');
  assert.ok(!JSON.stringify(list).includes(k.key), 'the panel never gets the raw key again');
  assert.equal(list[0].name, 'Shop');
  assert.deepEqual(list[0].scopes, ALL);
});

test('the key is shown once: a repeated request id does not repeat the key', async () => {
  const h = await host();
  const requestId = rid();
  const a = await h.api('createApiKey', { name: 'Shop', scopes: ALL, origins: [ORIGIN], requestId });
  const b = await h.api('createApiKey', { name: 'Shop', scopes: ALL, origins: [ORIGIN], requestId });
  assert.match(a.data.key, /^st_live_/);
  assert.equal(b.ok, true);
  assert.equal(b.data.key, undefined, 'a replay carries no secret');
  assert.equal(h.tables.api_keys.size, 1, 'one key only');
  assert.ok(!JSON.stringify([...h.tables.request_log.values()]).includes(a.data.key), 'the request log does not hold the key');
});

test('owner key creation refuses bad scopes, origins and a missing name', async () => {
  const h = await host();
  assert.equal((await h.api('createApiKey', { name: 'x', scopes: ['admin'], requestId: rid() })).ok, false);
  assert.equal((await h.api('createApiKey', { name: 'x', scopes: ALL, origins: ['*'], requestId: rid() })).ok, false);
  assert.equal((await h.api('createApiKey', { name: '  ', scopes: ALL, requestId: rid() })).ok, false);
  assert.equal(h.tables.api_keys.size, 0);
});

test('preflight: an origin some active key lists is echoed; another origin is not; no key is needed', async () => {
  const h = await host();
  await makeKey(h);
  const yes = await out(req(h, 'OPTIONS', '/v1/orders', { origin: ORIGIN }));
  assert.equal(yes.status, 204);
  assert.equal(yes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(yes.headers.get('Access-Control-Allow-Headers'), /Idempotency-Key/);
  const no = await out(req(h, 'OPTIONS', '/v1/orders', { origin: 'https://evil.example' }));
  assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
});

test('unknown paths and wrong methods on a known path', async () => {
  const h = await host();
  const k = await makeKey(h);
  assert.equal((await get(h, '/v1/nothing', { key: k.key })).status, 404);
  const wrong = await post(h, '/v1/products', { key: k.key, body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.code, 'method_not_allowed');
});

// ---- rate limits ----

test('per key: the 61st request in a minute is 429 with Retry-After', async () => {
  const h = await host();
  const k = await makeKey(h);
  for (let i = 0; i < 60; i++) {
    const r = await get(h, '/v1/products', { key: k.key, origin: ORIGIN, ip: '10.0.0.' + i });
    assert.equal(r.status, 200, 'request ' + (i + 1));
  }
  const over = await get(h, '/v1/products', { key: k.key, origin: ORIGIN, ip: '10.9.9.9' });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'rate_limited');
  assert.ok(Number(over.headers.get('Retry-After')) >= 1);
});

test('per IP on POST: the 21st order request from one address is 429, even with no key', async () => {
  const h = await host();
  for (let i = 0; i < 20; i++) {
    const r = await post(h, '/v1/orders', { ip: '198.51.100.7', body: {} });
    assert.equal(r.status, 401, 'request ' + (i + 1) + ' reaches the key check');
  }
  const over = await post(h, '/v1/orders', { ip: '198.51.100.7', body: {} });
  assert.equal(over.status, 429, 'the limit is checked before the key');
  assert.equal(over.body.code, 'rate_limited');
});

// ---- catalog ----

test('GET /v1/products lists public products with only the public fields', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await get(h, '/v1/products', { key: k.key, origin: ORIGIN });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'private, max-age=60');
  assert.match(r.headers.get('ETag'), /^W\/"/);
  assert.equal(r.body.products.length, 1);
  const p = r.body.products[0];
  assert.equal(p.slug, 'exitlag');
  assert.equal(p.public_price, 300);
  assert.equal(typeof p.available, 'boolean');
  assert.deepEqual(Object.keys(p).sort(), ['available', 'currency', 'description', 'image_path', 'name', 'public_price', 'slug']);
  const text = r.text;
  const cost = h.tables.products.get('EXITLAG').account_cost;
  assert.ok(!text.includes('"' + String(cost) + '"') && !/account_cost|code_unit_cost|supplier|Supplier|template|Account_Label|account_label|code/i.test(text),
    'no cost, code, supplier or account fields');
  assert.ok(!/\b(Code|Sub_Code|Cycle_Cost|Slots|Account_ID)\b/.test(text));
});

test('a repeat catalog request with the ETag gets 304 and no body', async () => {
  const h = await host();
  const k = await makeKey(h);
  const first = await get(h, '/v1/products', { key: k.key, origin: ORIGIN });
  const etag = first.headers.get('ETag');
  const cond = await out(h.edge.handle(new Request('https://api.example/functions/v1/api/v1/products',
    { method: 'GET', headers: { Authorization: 'Bearer ' + k.key, Origin: ORIGIN, 'If-None-Match': etag } })));
  assert.equal(cond.status, 304);
  assert.equal(cond.text, '');
});

test('GET /v1/products/<slug>: a public product; anything else is not found', async () => {
  const h = await host();
  const k = await makeKey(h);
  const ok = await get(h, '/v1/products/exitlag', { key: k.key, origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.product.slug, 'exitlag');
  const hidden = await get(h, '/v1/products/hellcase', { key: k.key, origin: ORIGIN });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, 'not_found');
  assert.equal((await get(h, '/v1/products/%E0%A4%A', { key: k.key, origin: ORIGIN })).status, 404, 'a broken escape is not found');
});

test('the /functions/v1/api prefix that Supabase adds is accepted', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await out(h.edge.handle(new Request('https://x.supabase.co/functions/v1/api/v1/products', { headers: { Authorization: 'Bearer ' + k.key, Origin: ORIGIN } })));
  assert.equal(r.status, 200);
});

// ---- orders ----

test('POST /v1/orders needs an Idempotency-Key, JSON and a valid body', async () => {
  const h = await host();
  const k = await makeKey(h);
  const none = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, body: goodOrder() });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'idempotency_key_required');
  const junk = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'idem-json-01', raw: '{not json' });
  assert.equal(junk.status, 400);
  assert.equal(junk.body.code, 'invalid_json');
  const bad = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'idem-bad-001', body: goodOrder({ months: 99, customer: { name: 'R' } }) });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'validation_failed');
  assert.ok(bad.body.errors.length >= 2);
  assert.equal(h.tables.orders.size, 0, 'nothing is written for a bad order');
});

test('happy path: the order and its pay link, the token, and the order in the panel as a website order', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-happy-01', body: goodOrder() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.order.id, /^O-\d{5}$/);
  assert.equal(r.body.order.status, 'New');
  assert.equal(r.body.order.total, 600);
  assert.equal(r.body.order.product.slug, 'exitlag');
  assert.match(r.body.order.payment.url, /^https:\/\/pay\.example\/pay\/.+/);
  assert.match(r.body.token, /^ot_[0-9A-Za-z]{40}$/);
  assert.equal(r.body.order.payment.status, 'Open');
  const row = h.tables.orders.get(r.body.order.id);
  assert.equal(row.source, 'website');
  assert.equal(row.api_key_id, k.keyId, 'the order records the key that placed it');
  assert.equal(row.access_token, r.body.token);
  const panel = (await h.api('orders')).data.orders[0];
  assert.equal(panel.source, 'website');
  assert.equal(panel.contact, '01711111111');
});

test('a price that moved is 409 price_changed and writes nothing', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-price-01', body: goodOrder({ price: 250 }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'price_changed');
  assert.equal(h.tables.orders.size, 0);
  assert.equal(h.tables.pay_requests.size, 0);
});

test('an unknown or hidden product is 404 product_not_found', async () => {
  const h = await host();
  const k = await makeKey(h);
  const r = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-slug-01', body: goodOrder({ product: 'hellcase' }) });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'product_not_found');
});

test('a repeat with the same Idempotency-Key returns the same order (200), with no second order or pay link', async () => {
  const h = await host();
  const k = await makeKey(h);
  const first = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-repeat-1', body: goodOrder() });
  const again = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-repeat-1', body: goodOrder() });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('Idempotent-Replayed'), 'true');
  assert.equal(again.body.order.id, first.body.order.id);
  assert.equal(again.body.token, first.body.token);
  assert.equal(h.tables.orders.size, 1);
  assert.equal(h.tables.pay_requests.size, 1);
});

test('the same Idempotency-Key with a different body is 422 idempotency_conflict', async () => {
  const h = await host();
  const k = await makeKey(h);
  await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-conflict', body: goodOrder() });
  const other = await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-conflict', body: goodOrder({ months: 3 }) });
  assert.equal(other.status, 422);
  assert.equal(other.body.code, 'idempotency_conflict');
  assert.equal(h.tables.orders.size, 1);
});

test('two keys can use the same Idempotency-Key without colliding (the key is the namespace)', async () => {
  const h = await host();
  const a = await makeKey(h), b = await makeKey(h);
  const ra = await post(h, '/v1/orders', { key: a.key, origin: ORIGIN, idem: 'shared-key-01', body: goodOrder() });
  const rb = await post(h, '/v1/orders', { key: b.key, origin: ORIGIN, idem: 'shared-key-01', body: goodOrder() });
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.body.order.id, rb.body.order.id);
});

test('GET /v1/orders/<id>: needs the token; wrong ids and tokens are not found; no contact details', async () => {
  const h = await host();
  const k = await makeKey(h);
  const made = (await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-status-1', body: goodOrder() })).body;
  const id = made.order.id;
  const noTok = await get(h, '/v1/orders/' + id, { key: k.key, origin: ORIGIN });
  assert.equal(noTok.status, 400);
  assert.equal(noTok.body.code, 'token_required');
  assert.equal((await get(h, '/v1/orders/' + id + '?token=ot_wrong', { key: k.key, origin: ORIGIN })).status, 404);
  assert.equal((await get(h, '/v1/orders/O-99999?token=' + made.token, { key: k.key, origin: ORIGIN })).status, 404);
  const ok = await get(h, '/v1/orders/' + id.toLowerCase() + '?token=' + made.token, { key: k.key, origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.id, id);
  assert.equal(ok.body.order.status, 'New');
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.ok(!ok.text.includes('01711111111') && !ok.text.includes('Rahim') && !ok.text.includes(made.token), 'no contact, name or token in the answer');
});

test('an order moves to Fulfilled through the panel, and the status answer follows', async () => {
  const h = await host();
  const k = await makeKey(h);
  const made = (await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-fulfil-1', body: goodOrder() })).body;
  const rqId = h.tables.orders.get(made.order.id).pay_request_id;
  assert.ok(h.tables.pay_requests.get(rqId));
  const pay = await h.api('gotPaidRequest', { id: rqId, trx: 'TRXWEB0001', method: 'bkash', amount: 600, requestId: rid() });
  assert.equal(pay.ok, true, pay.error);
  assert.equal((await h.api('orderStatus', { id: made.order.id, status: 'Paid', requestId: rid() })).ok, true);
  assert.equal((await h.api('fulfilOrder', { orderId: made.order.id, accountId: 'EXL-09', requestId: rid() })).ok, true);
  const r = await get(h, '/v1/orders/' + made.order.id + '?token=' + made.token, { key: k.key, origin: ORIGIN });
  assert.equal(r.body.order.status, 'Fulfilled');
  assert.equal(r.body.order.payment.status, 'Paid');
});

// ---- customer portal ----

test('portal: a pay token shows only its customer\'s lines (product, paid till, owes), never another customer', async () => {
  const h = await host();
  const k = await makeKey(h);
  const lines = (await h.api('lookups')).data.lines;
  const byCustomer = {};
  lines.forEach(l => { (byCustomer[l.customerId] = byCustomer[l.customerId] || []).push(l); });
  const ids = Object.keys(byCustomer);
  assert.ok(ids.length >= 2, 'the seed has two customers with lines');
  const [a, b] = ids;
  const tokenA = 'PORTALTOKENA' + 'x'.repeat(10), tokenB = 'PORTALTOKENB' + 'y'.repeat(10);
  h.tables.sales.get(String(byCustomer[a][0].saleId)).pay_token = tokenA;
  h.tables.sales.get(String(byCustomer[b][0].saleId)).pay_token = tokenB;
  const r = await get(h, '/v1/portal/' + tokenA, { key: k.key, origin: ORIGIN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mine = (await h.api('customer', { id: a })).data.lines;
  assert.equal(r.body.portal.lines.length, mine.length);
  assert.deepEqual(r.body.portal.lines.map(x => x.product).sort(), mine.map(x => x.productName).sort());
  assert.equal(r.body.portal.owes, Math.round(mine.reduce((s, x) => s + x.owes, 0) * 100) / 100);
  assert.deepEqual(Object.keys(r.body.portal.lines[0]).sort(), ['owes', 'paid_till', 'product']);
  const bName = (await h.api('customer', { id: b })).data.customer.Name;
  assert.ok(!r.text.includes(bName), 'the other customer is not named');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal((await get(h, '/v1/portal/PORTALTOKENZZZZZZZZZZZZ', { key: k.key, origin: ORIGIN })).status, 404);
  assert.equal((await get(h, '/v1/portal/short', { key: k.key, origin: ORIGIN })).status, 404);
});

test('portal needs a key with portal:read', async () => {
  const h = await host();
  const k = await makeKey(h, ['catalog:read']);
  assert.equal((await get(h, '/v1/portal/PORTALTOKENA' + 'x'.repeat(10), { key: k.key, origin: ORIGIN })).status, 403);
  assert.equal((await get(h, '/v1/portal/PORTALTOKENA' + 'x'.repeat(10))).status, 401);
});

// ---- owner: webhooks and their delivery ----

test('a website order queues order.created for the endpoints that asked; the sender signs the body and marks it delivered', async () => {
  const h = await host();
  const k = await makeKey(h);
  const hook = await h.api('saveWebhook', { url: 'https://hooks.shop.example/tracker', events: ['order.created', 'order.paid'], requestId: rid() });
  assert.equal(hook.ok, true, hook.error);
  const secret = hook.data.secret;
  assert.match(secret, /^whsec_[0-9A-Za-z]{40}$/);
  await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-hook-01', body: goodOrder() });
  const queued = [...h.tables.webhook_deliveries.values()];
  assert.equal(queued.length, 1);
  assert.equal(queued[0].event, 'order.created');
  assert.equal(queued[0].status, 'pending');
  const payloadText = String(queued[0].payload);
  assert.ok(!payloadText.includes('01711111111') && !payloadText.includes('Rahim'), 'no contact details in a webhook');

  const sent = stubFetch(async () => new Response('ok', { status: 200 }));
  try {
    const r = await h.api('sendWebhooks');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { sent: 1, retry: 0, failed: 0, skipped: 0 });
    const call = sent.calls[0];
    assert.equal(call.url, 'https://hooks.shop.example/tracker');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual', 'redirects are not followed');
    assert.equal(call.init.headers['X-Event-Id'], queued[0].id);
    const check = Core.publicapi.verifySignature(secret, call.init.headers['X-Signature'], call.init.body, Math.floor(Date.now() / 1000));
    assert.deepEqual(check, { ok: true }, 'the receiver verifies with the secret');
    assert.equal(Core.publicapi.verifySignature('whsec_wrong', call.init.headers['X-Signature'], call.init.body, Math.floor(Date.now() / 1000)).ok, false);
    const env = JSON.parse(call.init.body);
    assert.equal(env.id, queued[0].id);
    assert.equal(env.type, 'order.created');
    assert.equal(env.data.orderId, JSON.parse(queued[0].payload).orderId);
  } finally { sent.restore(); }
  assert.equal([...h.tables.webhook_deliveries.values()][0].status, 'delivered');
  const listed = (await h.api('webhooks')).data;
  assert.equal(listed.endpoints[0].url, 'https://hooks.shop.example/tracker');
  assert.ok(!JSON.stringify(listed).includes(secret), 'the panel never gets the signing secret again');
});

test('a failing endpoint is retried with backoff, then marked failed; resend keeps the event id', async () => {
  const h = await host();
  const k = await makeKey(h);
  await h.api('saveWebhook', { url: 'https://hooks.shop.example/down', events: ['order.created'], requestId: rid() });
  await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-retry-01', body: goodOrder() });
  const id = [...h.tables.webhook_deliveries.values()][0].id;
  const down = stubFetch(async () => new Response('no', { status: 500 }));
  try {
    const first = await h.api('sendWebhooks');
    assert.equal(first.data.retry, 1);
    let row = h.tables.webhook_deliveries.get(id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'HTTP 500');
    assert.ok(Date.parse(row.next_try_at) > Date.now(), 'the next try is in the future');
    for (let i = 0; i < Core.publicapi.MAX_ATTEMPTS - 1; i++) {
      h.tables.webhook_deliveries.get(id).next_try_at = '2000-01-01T00:00:00.000Z';   // make it due now
      await h.api('sendWebhooks');
    }
    row = h.tables.webhook_deliveries.get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, Core.publicapi.MAX_ATTEMPTS);
  } finally { down.restore(); }
  const re = await h.api('resendWebhook', { deliveryId: id, requestId: rid() });
  assert.equal(re.ok, true);
  const again = h.tables.webhook_deliveries.get(id);
  assert.equal(again.status, 'pending');
  assert.equal(again.attempts, 0);
  assert.equal(again.id, id, 'the event id is kept, so a receiver can dedupe');
});

test('a receiver that does not answer in time is a failed try, not a crash', async () => {
  const h = await host();
  const k = await makeKey(h);
  await h.api('saveWebhook', { url: 'https://hooks.shop.example/slow', events: ['order.created'], requestId: rid() });
  await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-slow-01', body: goodOrder() });
  const slow = stubFetch(async () => { throw new Error('The operation was aborted.'); });
  try {
    const r = await h.api('sendWebhooks');
    assert.equal(r.data.retry, 1);
    assert.match([...h.tables.webhook_deliveries.values()][0].last_error, /aborted/);
  } finally { slow.restore(); }
});

test('order.paid is queued when the panel marks the order Paid; a switched-off endpoint is skipped', async () => {
  const h = await host();
  const k = await makeKey(h);
  const hook = await h.api('saveWebhook', { url: 'https://hooks.shop.example/paid', events: ['order.paid'], requestId: rid() });
  await h.api('saveWebhook', { id: hook.data.endpoint.id, url: 'https://hooks.shop.example/paid', events: ['order.paid'], active: false, requestId: rid() });
  const made = (await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-paidhook', body: goodOrder() })).body;
  const rq = [...h.tables.pay_requests.values()][0];
  await h.api('gotPaidRequest', { id: rq.request_id, trx: 'TRXHOOK001', method: 'bkash', amount: 600, requestId: rid() });
  await h.api('orderStatus', { id: made.order.id, status: 'Paid', requestId: rid() });
  assert.equal([...h.tables.webhook_deliveries.values()].length, 0, 'the endpoint was switched off before the events');
  await h.api('saveWebhook', { id: hook.data.endpoint.id, url: 'https://hooks.shop.example/paid', events: ['order.paid'], active: true, requestId: rid() });
  const made2 = (await post(h, '/v1/orders', { key: k.key, origin: ORIGIN, idem: 'order-paidhook2', body: goodOrder() })).body;
  const rq2 = [...h.tables.pay_requests.values()].find(x => x.request_id !== rq.request_id);
  await h.api('gotPaidRequest', { id: rq2.request_id, trx: 'TRXHOOK002', method: 'bkash', amount: 600, requestId: rid() });
  await h.api('orderStatus', { id: made2.order.id, status: 'Paid', requestId: rid() });
  const events = [...h.tables.webhook_deliveries.values()].map(d => d.event);
  assert.deepEqual(events, ['order.paid']);
});

test('saveWebhook: https only, a known event list, at least one event', async () => {
  const h = await host();
  assert.equal((await h.api('saveWebhook', { url: 'http://shop.example/x', events: ['order.created'], requestId: rid() })).ok, false);
  assert.equal((await h.api('saveWebhook', { url: 'https://shop.example/x', events: ['order.deleted'], requestId: rid() })).ok, false);
  assert.equal((await h.api('saveWebhook', { url: 'https://shop.example/x', events: [], requestId: rid() })).ok, false);
  assert.equal(h.tables.webhook_endpoints.size, 0);
});

test('revoking a key stops it at once, and the key list keeps the row', async () => {
  const h = await host();
  const k = await makeKey(h);
  assert.equal((await get(h, '/v1/products', { key: k.key, origin: ORIGIN })).status, 200);
  await h.api('revokeApiKey', { keyId: k.keyId, requestId: rid() });
  assert.equal((await get(h, '/v1/products', { key: k.key, origin: ORIGIN })).status, 401);
  const list = (await h.api('apiKeys')).data.keys;
  assert.equal(list[0].active, false);
  assert.equal((await h.api('revokeApiKey', { keyId: 'ak_nosuchkey', requestId: rid() })).ok, false);
});

test('the key records when it was last used', async () => {
  const h = await host();
  const k = await makeKey(h);
  await get(h, '/v1/products', { key: k.key, origin: ORIGIN });
  assert.ok(String(h.tables.api_keys.get(k.keyId).last_used_at || '').length > 0);
});

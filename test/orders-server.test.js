// Orders and catalog listing through the Edge router (src/server/edge.js) over the fake db: the owner actions, idempotent retries,
// the path from order to sale, and that the declared tables (NEEDS_) give the same answers as a full read for each write.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const Adapter = require('../src/adapters/postgres.js');

const TODAY = '2026-10-28';

async function host() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  // A public base URL for pay links, and a fresh ExitLag account with free seats (the seed's own account is full).
  tables.settings.set('pay_base_url', 'https://shop.example');
  tables.accounts.set('EXL-09', { account_id: 'EXL-09', product_id: 'EXITLAG', account_label: 'Test seats', cycle_cost: 2000,
    renewal_date: '2026-11-20', slots: 5, notes: '', account_status: 'Active' });
  const edge = loadEdge(db, { today: TODAY, env: { APP_SECRET: 'x' } });
  return { db, tables, edge, api: (a, p) => edge.api(a, p || {}) };
}
const rid = () => 'rq-' + Math.random().toString(36).slice(2);
const priceOf = async (h, id) => (await h.api('lookups')).data.products.find(p => p.id === id).price;
const orderRow = (h, id) => h.tables.orders.get(id);

test('the orders read is empty, then lists a created order with its pay link', async () => {
  const h = await host();
  assert.deepEqual((await h.api('orders')).data, { orders: [] });
  const price = await priceOf(h, 'EXITLAG');
  const c = await h.api('createOrder', { productId: 'EXITLAG', months: 2, customerId: 'CU-0001', price, requestId: rid() });
  assert.equal(c.ok, true, c.error);
  assert.match(c.data.orderId, /^O-\d{5}$/);
  assert.match(c.data.url, /\/pay\//);
  const list = (await h.api('orders')).data.orders;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'New');
  assert.equal(list[0].total, price * 2);
  assert.equal(list[0].payRequestStatus, 'Open');
  assert.equal(list[0].payUrl, c.data.url);
});

test('a price that moved is refused with a code, and nothing is written', async () => {
  const h = await host();
  const before = h.tables.orders.size, requestsBefore = h.tables.pay_requests.size;
  const r = await h.api('createOrder', { productId: 'EXITLAG', customerId: 'CU-0001', price: 1, requestId: rid() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'price_changed');
  assert.equal(h.tables.orders.size, before);
  assert.equal(h.tables.pay_requests.size, requestsBefore);
});

test('a repeated request id returns the first answer and writes one order (idempotent writes)', async () => {
  const h = await host();
  const price = await priceOf(h, 'EXITLAG');
  const requestId = rid();
  const a = await h.api('createOrder', { productId: 'EXITLAG', customerId: 'CU-0001', price, requestId });
  const b = await h.api('createOrder', { productId: 'EXITLAG', customerId: 'CU-0001', price, requestId });
  assert.deepEqual(b, a);
  assert.equal(h.tables.orders.size, 1);
  assert.equal(h.tables.pay_requests.size, 1);
});

test('status moves: Paid waits for the pay link; cancelling cancels the open link and the order is then final', async () => {
  const h = await host();
  const price = await priceOf(h, 'EXITLAG');
  const { data } = await h.api('createOrder', { productId: 'EXITLAG', customerId: 'CU-0001', price, requestId: rid() });
  const id = data.orderId;
  assert.equal((await h.api('orderStatus', { id, status: 'AwaitingPayment', requestId: rid() })).ok, true);
  const early = await h.api('orderStatus', { id, status: 'Paid', requestId: rid() });
  assert.equal(early.ok, false);
  assert.match(early.error, /pay link/);
  const fulfilEarly = await h.api('fulfilOrder', { orderId: id, accountId: 'EXL-09', requestId: rid() });
  assert.equal(fulfilEarly.ok, false);
  const cancelled = await h.api('orderStatus', { id, status: 'Cancelled', requestId: rid() });
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(orderRow(h, id).status, 'Cancelled');
  assert.equal(h.tables.pay_requests.get(data.requestId).status, 'Cancelled');
  assert.equal((await h.api('orderStatus', { id, status: 'New', requestId: rid() })).ok, false);
});

test('the path from order to sale: pay link paid, order Paid, fulfilled into a sale with the payment attached', async () => {
  const h = await host();
  const price = await priceOf(h, 'EXITLAG');
  const { data } = await h.api('createOrder', { productId: 'EXITLAG', customerId: 'CU-0001', price, requestId: rid() });
  const paid = await h.api('gotPaidRequest', { id: data.requestId, trx: 'TRXSRV1', method: 'bkash', amount: price, requestId: rid() });
  assert.equal(paid.ok, true, paid.error);
  assert.equal((await h.api('orderStatus', { id: data.orderId, status: 'Paid', requestId: rid() })).ok, true);
  const f = await h.api('fulfilOrder', { orderId: data.orderId, accountId: 'EXL-09', requestId: rid() });
  assert.equal(f.ok, true, f.error);
  const saleId = f.data.saleId;
  assert.ok([...h.tables.sales.values()].some(s => Number(s.sale_id) === Number(saleId)), 'sale row written');
  const list = (await h.api('orders')).data.orders[0];
  assert.equal(list.status, 'Fulfilled');
  assert.equal(list.saleId, saleId);
  assert.equal(list.payRequestStatus, 'Paid');
  const pay = [...h.tables.payments.values()].find(p => p.transaction_id === 'TRXSRV1');
  assert.equal(String(pay.sale_id), String(saleId));
  // Fulfilling twice is refused: the order is final.
  assert.equal((await h.api('fulfilOrder', { orderId: data.orderId, accountId: 'EXL-09', requestId: rid() })).ok, false);
});

test('catalog listing: slugs are unique, public needs an address, and the lookups carry the fields', async () => {
  const h = await host();
  const ok1 = await h.api('editProductPublic', { productId: 'NETFLIX', slug: 'netflix', public: true, publicPrice: 320, sortOrder: 2, requestId: rid() });
  assert.equal(ok1.ok, true, ok1.error);
  const clash = await h.api('editProductPublic', { productId: 'EXITLAG', slug: 'netflix', requestId: rid() });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already uses/);
  assert.equal((await h.api('editProductPublic', { productId: 'EXITLAG', public: true, requestId: rid() })).ok, false);
  const p = (await h.api('lookups')).data.products.find(x => x.id === 'NETFLIX');
  assert.equal(p.slug, 'netflix');
  assert.equal(p.public, true);
  assert.equal(p.publicPrice, 320);
  assert.equal(p.sortOrder, 2);
  const bad = await h.api('editProductPublic', { productId: 'NETFLIX', imagePath: '../x.png', requestId: rid() });
  assert.equal(bad.ok, false);
});

test('the declared tables give the same answers as a full read for every order write', async () => {
  // Two hosts over the same seed; one reads every table, the other the declared tables only. Results and rows must match.
  const scoped = await host(), full = await host();
  const orig = Adapter.readState;
  const run = async (h, fullRead) => {
    const reads = fullRead ? (db, today) => orig(db, today) : orig;
    if (fullRead) Adapter.readState = reads;
    try {
      const out = [];
      const price = (await h.api('lookups')).data.products.find(p => p.id === 'EXITLAG').price;
      const c = await h.api('createOrder', { productId: 'EXITLAG', months: 1, customerId: 'CU-0001', price, requestId: 'fixed-1' });
      out.push(c);
      const g = await h.api('gotPaidRequest', { id: c.data.requestId, trx: 'TRXCMP1', method: 'bkash', amount: price, requestId: 'fixed-2' });
      out.push(g);
      out.push(await h.api('orderStatus', { id: c.data.orderId, status: 'Paid', requestId: 'fixed-3' }));
      out.push(await h.api('fulfilOrder', { orderId: c.data.orderId, accountId: 'EXL-09', requestId: 'fixed-4' }));
      return out;
    } finally { Adapter.readState = orig; }
  };
  const a = await run(scoped, false), b = await run(full, true);
  // Generated secrets and wall-clock stamps differ between two runs; everything else must match exactly.
  const VOLATILE = ['url', 'token', 'pay_token', 'Token', 'Pay_Token', 'batchId', 'created_at', 'created', 'expires', 'fulfilled_at', 'delivered_at'];
  const strip = x => JSON.parse(JSON.stringify(x, (k, v) => (VOLATILE.includes(k) && v !== null && v !== undefined ? '<masked>' : v)));
  assert.deepStrictEqual(strip(a), strip(b));
  assert.equal(a[3].ok, true, a[3].error);
  const rowsOf = h => ({ orders: [...h.tables.orders.values()], requests: [...h.tables.pay_requests.values()],
    sales: [...h.tables.sales.values()], deliveries: [...h.tables.deliveries.values()], payments: [...h.tables.payments.values()] });
  assert.deepStrictEqual(strip(rowsOf(scoped)), strip(rowsOf(full)));
});

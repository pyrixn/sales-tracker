const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { ok } = require('./helpers');

const P = () => Core.paylinks;
const NOW = Date.parse('2026-10-24T10:00:00.000Z');

function mk(extra) {
  return Object.assign({
    today: '2026-10-24',
    settings: { pay_link_expiry_hours: '24', pay_base_url: 'https://shop.example/' },
    products: [
      { Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Default_Price: 500, Unit_Cost: 400 },
      { Product_ID: 'NF', Product_Name: 'Netflix', Category: 'Streaming', Delivers_As: 'account', Default_Price: 300, Unit_Cost: 0 }
    ],
    accounts: [], customers: [{ Customer_ID: 'CU-0001', Name: 'Rafi' }], sales: [], payments: [], inbox: [], payIntents: [],
    codes: [
      { Code_ID: 'C-0001', Product_ID: 'GC', Code: 'AAA', Status: 'Available' },
      { Code_ID: 'C-0002', Product_ID: 'GC', Code: 'BBB', Status: 'Sold' }
    ],
    payRequests: []
  }, extra || {});
}
const apply = (state, r) => r.ops.forEach(o => {
  const rows = state[o.tab === 'Pay_Requests' ? 'payRequests' : 'codes'];
  if (o.op === 'append') rows.push(Object.assign({}, o.values));
  else Object.assign(rows.find(x => x[o.key] === o.id), o.values);
});

test('IdGen request and delivery ids follow existing max', () => {
  const g = Core.ids.IdGen({ payRequests: [{ Request_ID: 'R11' }], deliveries: [{ Delivery_ID: 'D3' }, { Delivery_ID: 'D9' }] });
  assert.equal(g.request(), 'R12'); assert.equal(g.request(), 'R13');
  assert.equal(g.delivery(), 'D10');
  const e = Core.ids.IdGen({});
  assert.equal(e.request(), 'R1'); assert.equal(e.delivery(), 'D1');
  // multi-letter sub-code counter still scanned
  assert.equal(Core.ids.IdGen({ sales: [{ Sub_Code: 'NF7' }, { Sub_Code: 'ABC12' }] }).subCode('X'), 'X13');
});

test('create reserves the first Available code and returns a long url-safe token', () => {
  const s = mk();
  const r = ok(P().planCreateRequest(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001', nowMs: NOW }));
  assert.equal(r.result.requestId, 'R1'); assert.equal(r.result.ref, 'R1');
  assert.match(r.result.token, /^[A-Za-z0-9_-]{32,}$/);
  const row = r.ops.find(o => o.op === 'append' && o.tab === 'Pay_Requests').values;
  assert.deepEqual([row.Status, row.Code_ID, row.Amount, row.Customer_ID, row.Customer_Name, row.Token, row.Created, row.Expires],
    ['Open', 'C-0001', 500, 'CU-0001', 'Rafi', r.result.token, '2026-10-24T10:00:00.000Z', '2026-10-25T10:00:00.000Z']);
  const up = r.ops.find(o => o.op === 'update' && o.tab === 'Code_Inventory');
  assert.deepEqual([up.key, up.id, up.values], ['Code_ID', 'C-0001', { Status: 'Reserved' }]);
});

test('second create for the last code fails Out of stock; Reserved code is not offered', () => {
  const s = mk();
  apply(s, ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'GC', nowMs: NOW })));
  const r = P().planCreateRequest(s, { title: 'y', amount: 500, productId: 'GC', nowMs: NOW });
  assert.deepEqual(r.errors, ['Out of stock']); assert.deepEqual(r.ops, []);
  assert.ok(Core.sales.planNewSale(s, { productId: 'GC', customerId: 'CU-0001', codeId: 'C-0001' }).errors.length, 'sale refuses Reserved code');
});

test('seat product reserves nothing; hours override and default', () => {
  const s = mk();
  const r = ok(P().planCreateRequest(s, { title: 'Netflix', amount: 300, productId: 'NF', customerName: 'Walk in', hours: 2, nowMs: NOW }));
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].values.Code_ID, ''); assert.equal(r.ops[0].values.Customer_Name, 'Walk in');
  assert.equal(r.ops[0].values.Expires, '2026-10-24T12:00:00.000Z');
});

test('invalid input rejected', () => {
  const s = mk();
  for (const amount of [0, -5, 1000000, NaN, 'abc', undefined]) assert.ok(P().planCreateRequest(s, { title: 't', amount }).errors.length, String(amount));
  assert.ok(P().planCreateRequest(s, { title: 't', amount: 999999 }).errors.length === 0);
  assert.ok(P().planCreateRequest(s, { title: 't', amount: 5, productId: 'ZZ' }).errors.length);
  assert.ok(P().planCreateRequest(s, { title: 't', amount: 5, customerId: 'CU-9999' }).errors.length);
  assert.ok(P().planCreateRequest(s, { title: 'x'.repeat(121), amount: 5 }).errors.length);
});

test('only the amount is needed: a blank title is saved as Payment', () => {
  const s = mk();
  const r = ok(P().planCreateRequest(s, { amount: 500, nowMs: NOW }));
  assert.equal(r.ops[0].values.Title, 'Payment');
  assert.equal(r.ops[0].values.Amount, 500);
  assert.equal(r.ops[0].values.Customer_ID, '');
  assert.equal(ok(P().planCreateRequest(s, { title: '   ', amount: '250', nowMs: NOW })).ops[0].values.Title, 'Payment');
  assert.equal(ok(P().planCreateRequest(s, { title: 'x'.repeat(120), amount: 5, nowMs: NOW })).ops[0].values.Title.length, 120);
});

test('a typed name that clashes with a customer is refused and tagged, so the panel can offer the list', () => {
  const r = P().planCreateRequest(mk(), { amount: 5, customerName: 'rafi' });
  assert.equal(r.errors.length, 1);
  assert.equal(r.code, 'customer_name_taken');
  assert.match(r.errors[0], /Pick them from the list/);
  assert.equal(P().planCreateRequest(mk(), { amount: 5, customerId: 'CU-0001' }).code, undefined, 'a picked customer is not a clash');
});

test('cancel releases the code, only Open requests', () => {
  const s = mk();
  const c = ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'GC', nowMs: NOW })); apply(s, c);
  const x = ok(P().planCancelRequest(s, { id: 'R1' }));
  assert.deepEqual(x.ops.find(o => o.tab === 'Pay_Requests').values, { Status: 'Cancelled' });
  assert.deepEqual(x.ops.find(o => o.tab === 'Code_Inventory').values, { Status: 'Available' });
  apply(s, x);
  assert.ok(P().planCancelRequest(s, { id: 'R1' }).errors.length, 'already cancelled');
  assert.ok(P().planCancelRequest(s, { id: 'R9' }).errors.length);
  ok(P().planCreateRequest(s, { title: 'again', amount: 500, productId: 'GC', nowMs: NOW }));
});

test('expiry releases the code of Open requests past Expires only', () => {
  const s = mk();
  apply(s, ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'GC', nowMs: NOW })));
  assert.deepEqual(P().planExpireRequests(s, NOW + 3600e3), []);
  const ops = P().planExpireRequests(s, NOW + 25 * 3600e3);
  assert.deepEqual(ops.map(o => [o.tab, o.id, o.values]), [['Pay_Requests', 'R1', { Status: 'Expired' }], ['Code_Inventory', 'C-0001', { Status: 'Available' }]]);
  s.payRequests[0].Status = 'Cancelled';
  assert.deepEqual(P().planExpireRequests(s, NOW + 99 * 3600e3), []);
});

test('requestStatus uses order stages keyed by request id; requestUrl joins base', () => {
  const s = mk();
  apply(s, ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'NF', nowMs: NOW })));
  const rq = s.payRequests[0];
  assert.equal(P().requestStatus(s, rq).stage, 'created');
  s.payIntents.push({ Token: rq.Token, Method: 'bkash', Payer_Number: '01711223344', Claimed: '', Created: '2026-10-24' });
  assert.equal(P().requestStatus(s, rq).stage, 'waiting');
  s.inbox.push({ Reference: 'r1', Type: 'Received', Amount: 500, Status: 'Pending', Received: '2026-10-24 10:05' });
  assert.equal(P().requestStatus(s, rq).stage, 'received');
  assert.equal(P().requestUrl(s.settings, rq), 'https://shop.example/pay/' + encodeURIComponent(rq.Token));
  assert.equal(P().requestUrl({}, rq), '');
});

test('lookups list only Available codes, never Reserved', () => {
  const s = mk({ accounts: [], suppliers: [], wallets: [], rates: [] });
  assert.deepEqual(Core.views.lookups(s).codes.map(c => c.id), ['C-0001']);
  apply(s, ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'GC', nowMs: NOW })));
  assert.deepEqual(Core.views.lookups(s).codes, []);
});

test('fix round 1: R letter reserved, batch delete blocks Reserved, hours/amount/shared code', () => {
  const s = mk();
  assert.match(Core.sales.planProduct(s, { name: 'Roblox', category: 'Misc', deliversAs: 'code', letter: 'r', price: 1 }).errors[0], /reserved/);
  assert.equal(Core.sales.planProduct(s, { name: 'Roblox', category: 'Misc', deliversAs: 'code', letter: 'RB', price: 1 }).errors.length, 0);
  s.codes[0].Batch_ID = 'B1'; s.codes[0].Status = 'Reserved';
  const d = Core.sales.planBatchDelete(s, { codeBatch: 'B1' });
  assert.match(d.errors[0], /held by open pay links/);
  s.codes[0].Status = 'Available';
  assert.equal(Core.sales.planBatchDelete(s, { codeBatch: 'B1' }).errors.length, 0);
  for (const hours of [0, 721, 'x']) assert.ok(P().planCreateRequest(s, { title: 't', amount: 5, hours }).errors.length, String(hours));
  const bad = mk(); bad.settings.pay_link_expiry_hours = '99999';
  assert.equal(ok(P().planCreateRequest(bad, { title: 't', amount: 5, nowMs: NOW })).ops[0].values.Expires, '2026-10-25T10:00:00.000Z');
  assert.equal(ok(P().planCreateRequest(s, { title: 't', amount: '500' })).ops[0].values.Amount, 500);
  assert.ok(P().planCreateRequest(s, { title: 't', amount: 'abc' }).errors.length);
  const sh = mk(); sh.codes[0].Status = 'Reserved';
  sh.payRequests = [{ Request_ID: 'R1', Status: 'Open', Code_ID: 'C-0001' }, { Request_ID: 'R2', Status: 'Open', Code_ID: 'C-0001' }];
  assert.equal(P().planCancelRequest(sh, { id: 'R1' }).ops.length, 1, 'code kept while another open request holds it');
});

test('task5: cancel uppercases the id like confirm does', () => {
  const s = mk();
  apply(s, ok(P().planCreateRequest(s, { title: 'x', amount: 500, productId: 'GC', nowMs: NOW })));
  const x = ok(P().planCancelRequest(s, { id: ' r1 ' }));
  assert.equal(x.result.requestId, 'R1');
  assert.deepEqual(x.ops.find(o => o.tab === 'Pay_Requests').values, { Status: 'Cancelled' });
});

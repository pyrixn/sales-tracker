const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { ok } = require('./helpers');

const D = () => Core.delivery;
const P = () => Core.paylinks;
const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const LATER = NOW + 3600e3; // one hour in, link still open (24 h)

const TAB_STATE = { Customers: 'customers', Sales_Log: 'sales', Payments: 'payments', Code_Inventory: 'codes', Payment_Inbox: 'inbox',
  Pay_Requests: 'payRequests', Deliveries: 'deliveries', Accounts: 'accounts' };
const TAB_KEY = { Customers: 'Customer_ID', Sales_Log: 'Sale_ID', Payments: 'Payment_ID', Code_Inventory: 'Code_ID', Payment_Inbox: 'Transaction_ID',
  Pay_Requests: 'Request_ID', Deliveries: 'Delivery_ID', Accounts: 'Account_ID' };

function mk(extra) {
  return Object.assign({
    today: '2026-10-24', nowMs: LATER,
    settings: { pay_link_expiry_hours: '24', pay_base_url: 'https://shop.example', tos_text: 'No refunds after delivery.',
      review_discord_url: 'https://discord.gg/abc', review_facebook_url: 'https://facebook.com/shop' },
    products: [
      { Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400 },
      { Product_ID: 'NF', Product_Name: 'Netflix', Category: 'Streaming', Delivers_As: 'account', Letter: 'N', Default_Price: 300, Billing_Cycle_Days: 30 }
    ],
    accounts: [{ Account_ID: 'NF-01', Product_ID: 'NF', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Rafi' }], sales: [], payments: [], inbox: [], payIntents: [],
    codes: [
      { Code_ID: 'C-0001', Product_ID: 'GC', Code: 'AAAA-SECRET', Status: 'Available' },
      { Code_ID: 'C-0002', Product_ID: 'GC', Code: 'BBBB-SOLD', Status: 'Sold' }
    ],
    payRequests: [], deliveries: []
  }, extra || {});
}
function apply(state, r) {
  r.ops.forEach(o => {
    const rows = state[TAB_STATE[o.tab]];
    if (!rows) throw new Error('no tab ' + o.tab);
    if (o.op === 'append') rows.push(Object.assign({}, o.values));
    else {
      const key = o.key || TAB_KEY[o.tab];
      const row = rows.find(x => String(x[key]).toUpperCase() === String(o.id).toUpperCase());
      if (row) Object.assign(row, o.values);
    }
  });
  return state;
}
function request(s, input) { return apply(s, ok(P().planCreateRequest(s, Object.assign({ nowMs: NOW }, input)))).payRequests.slice(-1)[0]; }
function sms(s, amount, ref, trx, extra) {
  const row = Object.assign({ Transaction_ID: trx, Sender: '16247', Type: 'Received', Amount: amount, Reference: ref, Counterparty: '01756999991',
    Received: '2026-10-24 16:10', Status: 'Pending', Raw_SMS: 'You have received Tk ' + amount + '.00 from 01756999991. Ref ' + ref + '. TrxID ' + trx }, extra || {});
  s.inbox.push(row);
  return row;
}
const tabs = r => r.ops.map(o => o.op + ':' + o.tab);

test('an R12-style SMS confirms the request: one payment, a sale with the code, code Sold, request Paid, delivery Delivered, inbox Matched', () => {
  const s = mk();
  const rq = request(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  assert.equal(rq.Request_ID, 'R1');
  const row = sms(s, 500, 'R1', 'TRXR1A');
  const m = Core.matching.planInboxMatch(s, row);
  assert.equal(m.status, 'auto', JSON.stringify(m));
  assert.deepEqual(m.errors, []);
  const pays = m.ops.filter(o => o.tab === 'Payments');
  assert.equal(pays.length, 1);
  const sale = m.ops.find(o => o.op === 'append' && o.tab === 'Sales_Log').values;
  assert.deepEqual([sale.Code_ID, sale.Unit_Price, sale.Customer_ID, sale.Product_ID], ['C-0001', 500, 'CU-0001', 'GC']);
  assert.deepEqual([pays[0].values.Sale_ID, pays[0].values.Amount, pays[0].values.Transaction_ID, pays[0].values.Method, pays[0].values.Source, pays[0].values.Date],
    [sale.Sale_ID, 500, 'TRXR1A', 'bKash', 'Auto', '2026-10-24']);
  assert.deepEqual(m.ops.find(o => o.tab === 'Code_Inventory').values, { Status: 'Sold' });
  assert.deepEqual(m.ops.find(o => o.tab === 'Pay_Requests').values, { Status: 'Paid', Sale_ID: sale.Sale_ID });
  const dl = m.ops.find(o => o.tab === 'Deliveries').values;
  assert.deepEqual([dl.Delivery_ID, dl.Kind, dl.Status, dl.Code_ID, dl.Sale_ID, dl.Request_ID, dl.Customer_ID, dl.Delivered_At],
    ['D1', 'code', 'Delivered', 'C-0001', sale.Sale_ID, 'R1', 'CU-0001', new Date(LATER).toISOString()]);
  const ib = m.ops.find(o => o.tab === 'Payment_Inbox');
  assert.deepEqual([ib.id, ib.values.Status, ib.values.Matched_Sale_ID], ['TRXR1A', 'Matched', sale.Sale_ID]);
  assert.equal(m.result.saleId, sale.Sale_ID);
  // No op ever carries the code value itself.
  assert.ok(!JSON.stringify(m).includes('AAAA-SECRET'));
  apply(s, m);
  assert.equal(s.codes[0].Status, 'Sold');
  assert.equal(Core.ledger.saleBalance(s.sales[0], s), 0);
});

test('the same SMS processed twice (relay retry): second run writes no sale, payment or delivery', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const row = sms(s, 500, 'R1', 'TRXTWICE');
  apply(s, Core.matching.planInboxMatch(s, row));
  const again = Core.matching.planInboxMatch(s, Object.assign({}, row, { Status: 'Pending' }));
  assert.equal(again.status, 'duplicate');
  assert.deepEqual(tabs(again), ['update:Payment_Inbox']);
  apply(s, again);
  assert.equal(s.sales.length, 1); assert.equal(s.payments.length, 1); assert.equal(s.deliveries.length, 1);
});

test('"Got paid" twice: confirm is idempotent by transaction id, and a Paid request never confirms again', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const first = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'gotpaid1', method: 'bKash', amount: 500, source: 'App' }));
  assert.equal(first.result.delivered, true);
  assert.equal(first.result.deliveryId, 'D1');
  apply(s, first);
  const dup = D().planConfirmRequest(s, { id: 'R1', trx: 'GOTPAID1', method: 'bKash', amount: 500, source: 'App' });
  assert.deepEqual([dup.ops, dup.errors, dup.result.duplicate], [[], [], true]);
  const noTrx = D().planConfirmRequest(s, { id: 'R1', trx: '', method: 'Cash', amount: 500, source: 'App' });
  assert.deepEqual(noTrx.ops, []); assert.match(noTrx.errors[0], /R1 is Paid/);
  const otherTrx = D().planConfirmRequest(s, { id: 'R1', trx: 'OTHER9', method: 'bKash', amount: 500 });
  assert.deepEqual(otherTrx.ops, []); assert.match(otherTrx.errors[0], /R1 is Paid/);
  assert.equal(s.sales.length, 1); assert.equal(s.deliveries.length, 1);
});

test('underpayment: no ops, the inbox row stays Pending with a clear note', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const row = sms(s, 400, 'R1', 'TRXUNDER');
  const m = Core.matching.planInboxMatch(s, row);
  assert.equal(m.status, 'pending'); assert.deepEqual(m.ops, []);
  assert.match(m.result.note, /400.*less than.*500/);
  const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXUNDER', method: 'bKash', amount: 499.99 });
  assert.deepEqual(c.ops, []); assert.match(c.errors[0], /less than/);
  assert.equal(s.codes[0].Status, 'Reserved');
});

test('overpayment with a customer: request amount pays the sale, the excess is credit', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const m = Core.matching.planInboxMatch(s, sms(s, 650, 'r1', 'TRXOVER'));
  assert.equal(m.status, 'auto', JSON.stringify(m.result));
  apply(s, m);
  const saleId = s.sales[0].Sale_ID;
  assert.deepEqual(s.payments.map(p => [p.Sale_ID, p.Amount, p.Customer_ID]), [[saleId, 500, 'CU-0001'], ['', 150, 'CU-0001']]);
  assert.equal(Core.ledger.creditOf(s, 'CU-0001'), 150);
  assert.equal(s.deliveries[0].Status, 'Delivered');
  assert.match(m.result.note, /150.*credit/);
});

test('overpayment without a customer: a new customer gets the sale, the excess is noted on the delivery and is nobody\'s credit', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Walk in' });
  const c = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXNOCUST', method: 'bKash', amount: 600 }));
  apply(s, c);
  const cust = s.customers.find(x => x.Name === 'Walk in');
  assert.ok(cust, 'customer created from the request name');
  assert.equal(s.sales[0].Customer_ID, cust.Customer_ID);
  assert.equal(Core.ledger.creditOf(s, cust.Customer_ID), 0);
  assert.equal(s.payments.reduce((a, p) => a + p.Amount, 0), 600, 'every taka received is in the book');
  const ph = s.customers.find(x => x.Name === 'Unlogged payment (pay links)');
  assert.ok(ph, 'placeholder created');
  assert.equal(s.payments.find(p => p.Amount === 100).Customer_ID, ph.Customer_ID);
  assert.match(s.deliveries[0].Note, /Overpaid .*100/);
});

test('a name that already exists does not attach the sale to that customer', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Rafa' });
  s.customers.push({ Customer_ID: 'CU-0002', Name: 'rafa' }); // created after the link was made
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXNAME', method: 'bKash', amount: 500 })));
  assert.notEqual(s.sales[0].Customer_ID, 'CU-0002');
  assert.equal(s.customers.find(c => c.Customer_ID === s.sales[0].Customer_ID).Name, 'Rafa (R1)');
});

test('expired or cancelled request: SMS stays Pending, nothing delivered; Open past Expires counts as expired', () => {
  for (const kind of ['statusExpired', 'clockExpired', 'cancelled']) {
    const s = mk();
    request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
    if (kind === 'statusExpired') apply(s, { ops: P().planExpireRequests(s, NOW + 25 * 3600e3) });
    if (kind === 'clockExpired') s.nowMs = NOW + 25 * 3600e3;
    if (kind === 'cancelled') apply(s, ok(P().planCancelRequest(s, { id: 'R1' })));
    const m = Core.matching.planInboxMatch(s, sms(s, 500, 'R1', 'TRXLATE'));
    assert.equal(m.status, 'pending', kind); assert.deepEqual(m.ops, [], kind);
    assert.match(m.result.note, /R1 is (Expired|Cancelled)|R1 expired/, kind);
    const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXLATE', method: 'bKash', amount: 500, nowMs: s.nowMs });
    assert.deepEqual(c.ops, [], kind); assert.ok(c.errors.length, kind);
  }
});

test('the last code already taken: a clear error and no second sale', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  // The code was sold by hand after the link was made (status no longer Reserved).
  s.codes[0].Status = 'Sold';
  const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXGONE', method: 'bKash', amount: 500 });
  assert.deepEqual(c.ops, []); assert.match(c.errors[0], /C-0001 .*no longer reserved/);
  // A sale already holds the code although its status still says Reserved.
  const t = mk();
  request(t, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  t.sales.push({ Sale_ID: 1, Code_ID: 'C-0001', Record_Status: 'Active', Product_ID: 'GC', Customer_ID: 'CU-0001' });
  const c2 = D().planConfirmRequest(t, { id: 'R1', trx: 'TRXGONE2', method: 'bKash', amount: 500 });
  assert.deepEqual(c2.ops, []); assert.match(c2.errors[0], /already sold/);
  const m = Core.matching.planInboxMatch(t, sms(t, 500, 'R1', 'TRXGONE2'));
  assert.equal(m.status, 'pending'); assert.deepEqual(m.ops, []);
});

test('two links holding the same last code: the first payment gets it, the second is refused', () => {
  const s = mk();
  request(s, { title: 'A', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  s.payRequests.push(Object.assign({}, s.payRequests[0], { Request_ID: 'R2', Token: 'x'.repeat(32) }));
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXA', method: 'bKash', amount: 500 })));
  const second = D().planConfirmRequest(s, { id: 'R2', trx: 'TRXB', method: 'bKash', amount: 500 });
  assert.deepEqual(second.ops, []); assert.ok(second.errors.length);
  assert.equal(s.sales.filter(x => x.Code_ID === 'C-0001').length, 1);
});

test('seat product: sale on a free account, delivery Pending (kind seat), no code involved', () => {
  const s = mk();
  request(s, { title: 'Netflix 1 month', amount: 300, productId: 'NF', customerId: 'CU-0001' });
  const c = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXSEAT', method: 'bKash', amount: 300 }));
  assert.equal(c.result.delivered, false);
  apply(s, c);
  assert.deepEqual([s.sales[0].Account_ID, s.sales[0].Unit_Price, s.sales[0].Code_ID], ['NF-01', 300, '']);
  assert.deepEqual([s.deliveries[0].Kind, s.deliveries[0].Status, s.deliveries[0].Delivered_At, s.deliveries[0].Code_ID], ['seat', 'Pending', '', '']);
  assert.ok(!c.ops.some(o => o.tab === 'Code_Inventory'));
  const full = mk({ accounts: [{ Account_ID: 'NF-01', Product_ID: 'NF', Slots: 0, Account_Status: 'Active' }] });
  request(full, { title: 'Netflix', amount: 300, productId: 'NF', customerId: 'CU-0001' });
  const f = D().planConfirmRequest(full, { id: 'R1', trx: 'TRXFULL', method: 'bKash', amount: 300 });
  assert.deepEqual(f.ops, []); assert.match(f.errors[0], /free seat/);
});

test('request without a product: payment only, no sale, no delivery, not counted as credit', () => {
  const s = mk();
  request(s, { title: 'Custom job', amount: 250, customerId: 'CU-0001' });
  const m = Core.matching.planInboxMatch(s, sms(s, 250, 'R1', 'TRXPLAIN'));
  assert.equal(m.status, 'auto', JSON.stringify(m.result));
  assert.deepEqual(tabs(m), ['append:Payments', 'update:Pay_Requests', 'update:Payment_Inbox']);
  apply(s, m);
  assert.deepEqual([s.payments[0].Amount, s.payments[0].Sale_ID, s.payments[0].Customer_ID], [250, '', 'CU-0001']);
  assert.match(s.payments[0].Note, /R1/);
  assert.deepEqual([s.payRequests[0].Status, s.payRequests[0].Sale_ID], ['Paid', '']);
  assert.equal(s.deliveries.length, 0);
});

test('confirm rejects unknown request and bad amounts', () => {
  const s = mk();
  request(s, { title: 'x', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  assert.match(D().planConfirmRequest(s, { id: 'R9', trx: 'T1', amount: 500 }).errors[0], /Unknown request R9/);
  for (const amount of [0, -1, NaN, 'abc', 1000000]) assert.ok(D().planConfirmRequest(s, { id: 'R1', trx: 'T1', amount }).errors.length, String(amount));
});

test('matching: R reference for an unknown request and ordinary references behave as before', () => {
  const s = mk();
  const unknown = Core.matching.planInboxMatch(s, sms(s, 500, 'R77', 'TRXUNK'));
  assert.equal(unknown.status, 'pending'); assert.deepEqual(unknown.ops, []);
  assert.equal(Core.refs.normalizeRef('R12', s.products.map(p => p.Letter)), null, 'R is not a product prefix');
  // Wrong sender: still pending even with a valid R reference.
  request(s, { title: 'x', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const fake = Core.matching.planInboxMatch(s, sms(s, 500, 'R1', 'TRXFAKE', { Sender: '01799999999' }));
  assert.equal(fake.status, 'pending'); assert.deepEqual(fake.ops, []);
  // Reference only in the raw SMS text.
  const raw = Core.matching.planInboxMatch(s, sms(s, 500, '', 'TRXRAW', { Raw_SMS: 'You have received Tk 500.00 from 01756999991. Ref: R1. TrxID TRXRAW' }));
  assert.equal(raw.status, 'auto', JSON.stringify(raw.result));
});

test('planSetDelivery: statuses, Delivered stamps the time, note kept short; bad input rejected', () => {
  const s = mk();
  request(s, { title: 'Netflix', amount: 300, productId: 'NF', customerId: 'CU-0001' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXSET', method: 'bKash', amount: 300 })));
  const r = ok(D().planSetDelivery(s, { id: 'D1', status: 'Ready', note: '  sent login on WhatsApp ' }));
  assert.deepEqual(r.ops, [{ op: 'update', tab: 'Deliveries', key: 'Delivery_ID', id: 'D1', values: { Status: 'Ready', Note: 'sent login on WhatsApp', Delivered_At: '' } }]);
  const d = ok(D().planSetDelivery(s, { id: 'D1', status: 'Delivered', nowMs: NOW }));
  assert.deepEqual(d.ops[0].values, { Status: 'Delivered', Delivered_At: new Date(NOW).toISOString() });
  assert.match(D().planSetDelivery(s, { id: 'D1', status: 'Done' }).errors[0], /Pending, Ready, Delivered or Failed/);
  assert.match(D().planSetDelivery(s, { id: 'D9', status: 'Ready' }).errors[0], /Unknown delivery D9/);
  assert.ok(D().planSetDelivery(s, { id: 'D1', status: 'Ready', note: 'x'.repeat(501) }).errors.length);
});

test('listDeliveries: names, kind, order url, status filter; never the code value', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXL1', method: 'bKash', amount: 500 })));
  request(s, { title: 'Netflix', amount: 300, productId: 'NF', customerName: 'Walk in' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R2', trx: 'TRXL2', method: 'bKash', amount: 300 })));
  const all = D().listDeliveries(s, {});
  assert.deepEqual(all.map(r => [r.Delivery_ID, r.kind, r.customerName, r.productName]), [['D2', 'seat', 'Walk in', 'Netflix'], ['D1', 'code', 'Rafi', 'Gift card']]);
  assert.equal(all[1].orderUrl, 'https://shop.example/pay/' + encodeURIComponent(s.payRequests[0].Token));
  assert.deepEqual(D().listDeliveries(s, { status: 'Pending' }).map(r => r.Delivery_ID), ['D2']);
  assert.ok(!JSON.stringify(all).includes('AAAA-SECRET'));
});

test('receipt: the code only once the request is Paid and delivered; tos and https-only links', () => {
  const s = mk();
  const rq = request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const before = D().receipt(s, rq);
  assert.equal(before.code, undefined);
  assert.ok(!JSON.stringify(before).includes('AAAA-SECRET'));
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXREC', method: 'bKash', amount: 500 })));
  const after = D().receipt(s, s.payRequests[0]);
  assert.equal(after.code, 'AAAA-SECRET');
  assert.equal(after.tos, 'No refunds after delivery.');
  assert.deepEqual(after.links, [{ label: 'Discord', url: 'https://discord.gg/abc' }, { label: 'Facebook', url: 'https://facebook.com/shop' }]);
  assert.ok(after.lines.some(l => l.value === 'R1'));
  // Paid but no delivery row: no code.
  const noDl = Object.assign({}, s, { deliveries: [] });
  assert.equal(D().receipt(noDl, s.payRequests[0]).code, undefined);
  // Crafted settings: non-https links dropped.
  s.settings.review_discord_url = 'javascript:alert(1)';
  s.settings.review_facebook_url = 'http://facebook.com/shop';
  assert.deepEqual(D().receipt(s, s.payRequests[0]).links, []);
  s.settings.review_discord_url = 'https://ok.example/" onmouseover="x';
  assert.deepEqual(D().receipt(s, s.payRequests[0]).links, []);
});

// ---------------------------------------------------------------- fix round 1
test('fix1: hand-matching an R-SMS for an open link is refused; Got paid with that trx then confirms exactly once', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const row = sms(s, 6000, 'R1', 'TRXBIG');
  const hand = Core.matching.planInboxMatch(s, row, { customerId: 'CU-0001' });
  assert.deepEqual(hand.ops, []);
  assert.equal(hand.errors[0], 'R1 is an open pay link. Confirm it from Pay links with Got paid, using this transaction id.');
  const got = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'trxbig', method: 'bKash', amount: 6000, source: 'App' }));
  const ib = got.ops.filter(o => o.tab === 'Payment_Inbox');
  assert.deepEqual(ib.map(o => [o.id, o.values.Status]), [['TRXBIG', 'Matched']]);
  apply(s, got);
  assert.equal(s.inbox[0].Status, 'Matched');
  assert.equal(s.payments.reduce((a, p) => a + p.Amount, 0), 6000);
  assert.equal(s.sales.length, 1); assert.equal(s.deliveries.length, 1);
  const again = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXBIG', method: 'bKash', amount: 6000 });
  assert.deepEqual([again.ops, again.errors, again.result.duplicate], [[], [], true]);
});

test('fix1: hand-matching an R-SMS whose link is Paid, Cancelled or unknown works as before', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  apply(s, ok(P().planCancelRequest(s, { id: 'R1' })));
  const m = Core.matching.planInboxMatch(s, sms(s, 500, 'R1', 'TRXHAND'), { customerId: 'CU-0001' });
  assert.deepEqual(m.errors, []); assert.equal(m.status, 'manual');
  const u = Core.matching.planInboxMatch(s, sms(s, 500, 'R44', 'TRXHAND2'), { customerId: 'CU-0001' });
  assert.deepEqual(u.errors, []); assert.equal(u.status, 'manual');
  // Paid: a second, late SMS for an already confirmed link is hand-matched as before.
  const p = mk();
  request(p, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  apply(p, ok(D().planConfirmRequest(p, { id: 'R1', trx: 'TRXPAID1', method: 'bKash', amount: 500 })));
  assert.equal(p.payRequests[0].Status, 'Paid');
  const late = Core.matching.planInboxMatch(p, sms(p, 500, 'R1', 'TRXPAID2'), { customerId: 'CU-0001' });
  assert.deepEqual(late.errors, []); assert.equal(late.status, 'manual');
});

// ---------------------------------------------------------------- fix round 2
test('fix2: expired-but-Open link: hand-match books to the chosen customer; Got paid errors and says what to do', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  s.nowMs = NOW + 25 * 3600e3;
  assert.equal(s.payRequests[0].Status, 'Open');
  const row = sms(s, 500, 'R1', 'TRXEXPHAND');
  const got = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXEXPHAND', method: 'bKash', amount: 500 });
  assert.deepEqual(got.ops, []);
  assert.equal(got.errors[0], 'R1 expired at 2026-10-25T10:00:00.000Z, so it cannot be confirmed. Match the payment by hand from Today, then cancel R1.');
  const m = Core.matching.planInboxMatch(s, row, { customerId: 'CU-0001' });
  assert.deepEqual(m.errors, []); assert.equal(m.status, 'manual');
  apply(s, m);
  assert.deepEqual(s.payments.map(p => [p.Customer_ID, p.Amount, p.Transaction_ID]), [['CU-0001', 500, 'TRXEXPHAND']]);
  assert.equal(s.inbox[0].Status, 'Matched');
  assert.equal(s.sales.length, 0); assert.equal(s.deliveries.length, 0);
});

test('fix2: link whose code is no longer Reserved (or already on a sale): hand-match works; Got paid errors and says what to do', () => {
  for (const how of ['status', 'sale']) {
    const s = mk();
    request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
    if (how === 'status') s.codes[0].Status = 'Sold';
    else s.sales.push({ Sale_ID: 1, Code_ID: 'C-0001', Record_Status: 'Active', Product_ID: 'GC', Customer_ID: 'CU-0001', Unit_Price: 500, Qty: 1, Months: 1 });
    const row = sms(s, 500, 'R1', 'TRXLOST');
    const got = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXLOST', method: 'bKash', amount: 500 });
    assert.deepEqual(got.ops, [], how);
    assert.match(got.errors[0], /^Code C-0001 for R1 is (no longer reserved \(Sold\)|already sold)\. Match the payment by hand from Today, then cancel R1\.$/, how);
    const m = Core.matching.planInboxMatch(s, row, { customerId: 'CU-0001' });
    assert.deepEqual(m.errors, [], how); assert.equal(m.status, 'manual', how);
    assert.ok(m.ops.some(o => o.tab === 'Payments' && o.values.Customer_ID === 'CU-0001'), how);
  }
});

test('fix2: open unexpired link: hand-match still refused, Got paid confirms once', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const row = sms(s, 500, 'R1', 'TRXOPEN');
  const hand = Core.matching.planInboxMatch(s, row, { customerId: 'CU-0001' });
  assert.deepEqual(hand.ops, []); assert.match(hand.errors[0], /R1 is an open pay link/);
  assert.equal(D().confirmable(s, s.payRequests[0]), true);
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXOPEN', method: 'bKash', amount: 500 })));
  assert.equal(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXOPEN', method: 'bKash', amount: 500 }).result.duplicate, true);
  assert.equal(s.sales.length, 1); assert.equal(s.payments.length, 1); assert.equal(s.deliveries.length, 1);
});

test('fix2: an overpayment note for R10 is not a payment of R1', () => {
  const s = mk();
  request(s, { title: 'Custom', amount: 100, customerId: 'CU-0001' });
  s.payRequests[0].Status = 'Paid';
  s.payments.push({ Payment_ID: 'PM-00001', Customer_ID: '', Sale_ID: '', Amount: 5, Transaction_ID: 'TRX10', Note: 'Overpaid on R10, no customer to credit' });
  const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRX10', method: 'bKash', amount: 100 });
  assert.match(c.errors[0], /something else/);
  s.payments[0].Note = 'Overpaid on R1, no customer to credit';
  assert.equal(D().planConfirmRequest(s, { id: 'R1', trx: 'TRX10', method: 'bKash', amount: 100 }).result.duplicate, true);
  s.payments[0].Note = 'Overpaid on R1';
  assert.equal(D().planConfirmRequest(s, { id: 'R1', trx: 'TRX10', method: 'bKash', amount: 100 }).result.duplicate, true);
});

test('fix1: Got paid with a trx already booked for something else errors; no ops', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  s.payments.push({ Payment_ID: 'PM-00001', Customer_ID: 'CU-0001', Sale_ID: '', Amount: 500, Transaction_ID: 'TRXELSE', Note: '' });
  const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXELSE', method: 'bKash', amount: 500 });
  assert.deepEqual(c.ops, []); assert.equal(c.errors[0], 'Transaction TRXELSE is already recorded for something else.');
  // Same trx confirmed another request: not a duplicate of this one either.
  const t = mk();
  request(t, { title: 'A', amount: 100, customerId: 'CU-0001' });
  request(t, { title: 'B', amount: 100, customerId: 'CU-0001' });
  apply(t, ok(D().planConfirmRequest(t, { id: 'R1', trx: 'TRXA1', method: 'bKash', amount: 100 })));
  assert.equal(D().planConfirmRequest(t, { id: 'R1', trx: 'TRXA1', method: 'bKash', amount: 100 }).result.duplicate, true, 'no-product duplicate still a no-op');
  assert.match(D().planConfirmRequest(t, { id: 'R2', trx: 'TRXA1', method: 'bKash', amount: 100 }).errors[0], /something else/);
});

test('fix1: underpayment error tells the owner what to do; a missing inbox row adds no inbox op', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const c = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXSHORT', method: 'bKash', amount: 400 });
  assert.match(c.errors[0], /remaining ৳100.*cancel R1 and match this payment by hand/);
  const g = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXNOROW', method: 'bKash', amount: 500, markInbox: true }));
  assert.ok(!g.ops.some(o => o.tab === 'Payment_Inbox'));
});

test('fix2: receipt hides the code once the sale is voided or refunded and the code resold', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXV1', method: 'bKash', amount: 500 })));
  const first = s.payRequests[0];
  assert.equal(D().receipt(s, first).code, 'AAAA-SECRET');
  for (const st of ['Void', 'Refunded']) {
    s.sales[0].Record_Status = st;
    assert.equal(D().receipt(s, first).code, undefined, st);
  }
  // Resell the code to another sale; the old link must not show it.
  s.sales[0].Record_Status = 'Void'; s.codes[0].Status = 'Available';
  apply(s, ok(Core.sales.planNewSale(s, { productId: 'GC', customerId: 'CU-0001', codeId: 'C-0001', price: 500 })));
  assert.equal(D().receipt(s, first).code, undefined);
  // Sale active again but its Code_ID moved to another code: still nothing.
  s.sales[0].Record_Status = 'Active'; s.sales[0].Code_ID = 'C-0002';
  assert.equal(D().receipt(s, first).code, undefined);
});

test('task5: receipt never serves the code while the delivery is Failed', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXF1', method: 'bKash', amount: 500 })));
  assert.equal(D().receipt(s, s.payRequests[0]).code, 'AAAA-SECRET');
  for (const st of ['Pending', 'Ready', 'Failed']) {
    s.deliveries[0].Status = st;
    assert.equal(D().receipt(s, s.payRequests[0]).code, undefined, st);
  }
  s.deliveries[0].Status = 'Failed';
  assert.equal(D().receipt(s, s.payRequests[0]).code, undefined);
  assert.ok(!JSON.stringify(D().receipt(s, s.payRequests[0])).includes('AAAA-SECRET'));
  s.deliveries[0].Status = 'Delivered';
  assert.equal(D().receipt(s, s.payRequests[0]).code, 'AAAA-SECRET');
});

test('a name clash that blocks Got paid frees the hand-match; create refuses the clash up front', () => {
  const s = mk();
  const created = P().planCreateRequest(s, { title: 'Gift card', amount: 500, productId: 'GC', customerName: ' RAFI ', nowMs: NOW });
  assert.deepEqual(created.ops, []); assert.match(created.errors[0], /already exists.*Pick them/);
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Walk in' });
  s.customers.push({ Customer_ID: 'CU-0002', Name: 'Walk in' }, { Customer_ID: 'CU-0003', Name: 'Walk in (R1)' });
  const why = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXCLASH', method: 'bKash', amount: 500 });
  assert.deepEqual(why.ops, []); assert.match(why.errors[0], /already exists.*by hand/);
  assert.equal(D().confirmable(s, s.payRequests[0]), false);
  const m = Core.matching.planInboxMatch(s, sms(s, 500, 'R1', 'TRXCLASH'), { customerId: 'CU-0002' });
  assert.ok(!/open pay link/.test((m.errors || []).join(' ')), 'hand-match is not sent back to Got paid');
});

test('Got paid needs a known method', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  for (const method of ['', undefined, 'Bitcoin']) {
    const r = D().planConfirmRequest(s, { id: 'R1', trx: 'TRXM', method, amount: 500 });
    assert.deepEqual(r.ops, []); assert.match(r.errors[0], /payment method/);
  }
  const good = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXM', method: 'NAGAD', amount: 500 }));
  assert.equal(good.ops.find(o => o.tab === 'Payments').values.Method, 'Nagad');
});

test('pay request text fields are capped', () => {
  const s = mk();
  for (const [f, n] of [['title', 121], ['note', 501], ['customerName', 121]]) {
    const r = P().planCreateRequest(s, Object.assign({ title: 'T', amount: 100, nowMs: NOW }, { [f]: 'x'.repeat(n) }));
    assert.deepEqual(r.ops, [], f); assert.match(r.errors[0], /up to/, f);
    ok(P().planCreateRequest(s, Object.assign({ title: 'T', amount: 100, nowMs: NOW }, { [f]: 'x'.repeat(n - 1) })));
  }
});

test('hand-matching an underpaying SMS for an open link points to cancelling it', () => {
  const s = mk();
  request(s, { title: 'Gift card', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const hand = Core.matching.planInboxMatch(s, sms(s, 400, 'R1', 'TRXLOW'), { customerId: 'CU-0001' });
  assert.deepEqual(hand.ops, []); assert.match(hand.errors[0], /less than the ৳500.*cancel R1 first/);
});

// Task 11: pay requests carry a random customer reference (Pay_Requests.Ref); Request_ID stays the internal key.
test('random style: a pay request gets a random Ref, Request_ID stays R<n>, result.ref is the Ref', () => {
  const s = mk({ settings: Object.assign(mk().settings, { ref_style: 'random' }) });
  const r = ok(P().planCreateRequest(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001', nowMs: NOW }));
  const row = r.ops.find(o => o.tab === 'Pay_Requests').values;
  assert.equal(row.Request_ID, 'R1');
  assert.ok(Core.refs.isRandomRef(row.Ref), row.Ref);
  assert.equal(r.result.ref, row.Ref);
});

test('legacy style: Ref is blank and result.ref is the Request_ID', () => {
  const s = mk();
  const r = ok(P().planCreateRequest(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001', nowMs: NOW }));
  assert.equal(r.ops.find(o => o.tab === 'Pay_Requests').values.Ref, '');
  assert.equal(r.result.ref, 'R1');
});

test('a random pay request ref confirms the request like R1 does, and the order shows received', () => {
  const s = mk({ settings: Object.assign(mk().settings, { ref_style: 'random' }) });
  const rq = request(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  assert.ok(Core.refs.isRandomRef(rq.Ref));
  const row = sms(s, 500, rq.Ref, 'TRXRND1');
  assert.equal(Core.paylinks.requestStatus(s, rq).stage, 'received');
  const m = Core.matching.planInboxMatch(s, row);
  assert.equal(m.status, 'auto');
  assert.ok(m.ops.some(o => o.tab === 'Pay_Requests' && o.values.Status === 'Paid'));
});

test('a random pay request ref is never a sale code, and the two sets are checked together', () => {
  const s = mk({ settings: Object.assign(mk().settings, { ref_style: 'random' }) });
  const rq = request(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const used = Core.refs.usedRefs(s);
  assert.equal(used[rq.Ref.toUpperCase()], true);
  assert.equal(used[rq.Request_ID], true);
});

test('manual match of a row that carries an open request ref gives the open pay link error', () => {
  const s = mk({ settings: Object.assign(mk().settings, { ref_style: 'random' }) });
  const rq = request(s, { title: 'Gift card 500', amount: 500, productId: 'GC', customerId: 'CU-0001' });
  const row = sms(s, 500, rq.Ref, 'TRXRND2');
  const m = Core.matching.planInboxMatch(s, row, { customerId: 'CU-0001' });
  assert.match(m.errors[0], /open pay link/);
});

const PH = 'Unlogged payment (pay links)';
const custIds = s => new Set(s.customers.map(c => c.Customer_ID));

test('custom link with no customer: confirm creates the placeholder and books one valid Payments row; a second reuses it', () => {
  const s = mk();
  request(s, { title: 'Custom job', amount: 250 });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXNC1', method: 'bKash', amount: 250 })));
  const phs = s.customers.filter(c => c.Name === PH);
  assert.equal(phs.length, 1);
  assert.equal(s.payments.length, 1);
  assert.equal(s.payments[0].Customer_ID, phs[0].Customer_ID);
  assert.ok(custIds(s).has(s.payments[0].Customer_ID));
  request(s, { title: 'Another', amount: 100 });
  const c2 = ok(D().planConfirmRequest(s, { id: 'R2', trx: 'TRXNC2', method: 'bKash', amount: 100 }));
  assert.ok(!c2.ops.some(o => o.tab === 'Customers'), 'placeholder reused');
  apply(s, c2);
  assert.equal(s.customers.filter(c => c.Name === PH).length, 1);
  assert.deepEqual(s.payments.map(p => p.Customer_ID), [phs[0].Customer_ID, phs[0].Customer_ID]);
});

test('custom link with no customer and overpay: due and excess share one placeholder, created once', () => {
  const s = mk();
  request(s, { title: 'Custom job', amount: 250 });
  const c = ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXNC3', method: 'bKash', amount: 300 }));
  assert.equal(c.ops.filter(o => o.tab === 'Customers').length, 1);
  apply(s, c);
  assert.equal(s.payments.length, 2);
  assert.equal(new Set(s.payments.map(p => p.Customer_ID)).size, 1);
  assert.ok(custIds(s).has(s.payments[0].Customer_ID));
});

test('custom link with a customer: due books to that customer, overpay is credit', () => {
  const s = mk();
  request(s, { title: 'Custom job', amount: 250, customerId: 'CU-0001' });
  apply(s, ok(D().planConfirmRequest(s, { id: 'R1', trx: 'TRXC1', method: 'bKash', amount: 400 })));
  assert.equal(s.customers.length, 1);
  assert.deepEqual(s.payments.map(p => [p.Amount, p.Customer_ID]), [[250, 'CU-0001'], [150, 'CU-0001']]);
});

test('auto-match of a Ref SMS on a no-customer custom link yields ops whose Payments all have a known customer', () => {
  const s = mk();
  request(s, { title: 'Custom job', amount: 250 });
  const m = Core.matching.planInboxMatch(s, sms(s, 250, 'R1', 'TRXNC4'));
  assert.equal(m.status, 'auto', JSON.stringify(m.result));
  apply(s, m);
  assert.equal(s.payments.length, 1);
  assert.ok(custIds(s).has(s.payments[0].Customer_ID));
  assert.equal(s.customers.find(c => c.Customer_ID === s.payments[0].Customer_ID).Name, PH);
});

test('paymentOps refuses a payment with no customer', () => {
  const s = mk();
  const r = Core.sales.paymentOps(s, Core.ids.IdGen(s), { customerId: '', amount: 10 }, []);
  assert.deepEqual(r.ops, []); assert.equal(r.errors[0], 'A payment needs a customer.');
});

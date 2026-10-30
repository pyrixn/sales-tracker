const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { appendsOf, appendOf, updateOf, ok } = require('./helpers');

const M = () => Core.matching;

/** Migrated fixture. N44 stands in for sale 54: Netflix line at 300 a month, paid till 2026-10-09 (past grace). Inbox row DJP2JBSWHA = 1,200 Tk. */
function scenario() {
  const m = makeMigratedState();
  const line = m.sales.find(s => s.Sub_Code === 'N44');
  assert.ok(line, 'fixture has N44');
  line.Unit_Price = 300;
  line.Paid_Till = '2026-10-09';
  m.inbox.push({ Transaction_ID: 'DJP2JBSWHA', Amount: 1200, Received: '2026-10-25 21:06', Type: 'Received', Sender: '16247',
    Status: 'Pending', Reference: '', Raw_SMS: 'Cash In Tk 1,200.00 from 01XXXXXXXXX successful TrxID DJP2JBSWHA' });
  return { m, row: m.inbox[m.inbox.length - 1], customerId: line.Customer_ID };
}

const RENEW = (over) => Object.assign({ kind: 'renew', subCode: 'N44', months: 2, price: 300, from: 'oldPaidTill' }, over || {});
const CUSTOM = (over) => Object.assign({ kind: 'custom', title: 'Tinder Premium', price: 600, cost: 450, date: '2026-10-25' }, over || {});

test('acceptance: Netflix 2 months plus a custom item use the whole 1,200 payment', () => {
  const { m, row, customerId } = scenario();
  const before = JSON.stringify(m);
  const r = M().planSplitMatch(m, row, { customerId, targets: [RENEW({ paidTill: '2026-11-09' }), CUSTOM()] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.status, 'manual');
  const sales = appendsOf(r, 'Sales_Log');
  const renewRow = sales.find(o => o.values.Months === 2).values;
  const customRow = sales.find(o => o.values.Product_ID === 'CUSTOM').values;
  assert.equal(renewRow.Unit_Price, 300);
  assert.equal(renewRow.Paid_Till, '2026-11-09');
  assert.equal(renewRow.Sub_Code, 'N44');
  assert.equal(customRow.Cost_Snapshot, 450);
  assert.equal(sales.length, 2);
  const oldUpdate = r.ops.filter(o => o.op === 'update' && o.tab === 'Sales_Log');
  assert.deepEqual(oldUpdate.map(o => o.values), [{ Record_Status: 'Renewed' }]);
  const pays = appendsOf(r, 'Payments').map(o => o.values);
  assert.deepEqual(pays.map(p => [p.Amount, p.Transaction_ID, p.Date, p.Sale_ID]),
    [[600, 'DJP2JBSWHA', '2026-10-25', renewRow.Sale_ID], [600, 'DJP2JBSWHA', '2026-10-25', customRow.Sale_ID]]);
  assert.equal(pays.reduce((a, p) => a + p.Amount, 0), 1200);
  assert.deepEqual(updateOf(r, 'DJP2JBSWHA').values, { Status: 'Matched', Matched_Sale_ID: renewRow.Sale_ID });
  assert.equal(r.ops[r.ops.length - 1].tab, 'Payment_Inbox');
  assert.equal(r.result.saleIds.length, 2);
  assert.ok(r.result.saleIds[0] < r.result.saleIds[1]);
  assert.equal(r.result.credit, 0);
  assert.deepEqual(r.result.renewedSubCodes, ['N44']);
  assert.equal(JSON.stringify(m), before, 'state is not mutated');
});

test('renewal end date without paidTill: oldPaidTill gives 2026-12-09, today gives 2026-12-18; the override wins', () => {
  const { m, row, customerId } = scenario();
  const paidTill = (t) => {
    const r = ok(M().planSplitMatch(m, row, { customerId, targets: [RENEW(t), CUSTOM()] }));
    return appendsOf(r, 'Sales_Log').find(o => o.values.Months === 2).values.Paid_Till;
  };
  assert.equal(paidTill({ from: 'oldPaidTill' }), '2026-12-09');
  assert.equal(paidTill({ from: 'today' }), '2026-12-18');
  assert.equal(paidTill({ from: 'today', paidTill: '2026-11-09' }), '2026-11-09');
  const bad = M().planSplitMatch(m, row, { customerId, targets: [RENEW({ from: 'today', paidTill: '2026-10-10' }), CUSTOM()] });
  assert.deepEqual(bad.errors, ['Item 1: Paid till must be after 2026-10-18.']);
  assert.deepEqual(bad.ops, []);
});

test('remainder: kept as credit when asked, refused otherwise', () => {
  const { m, row, customerId } = scenario();
  const small = { customerId, targets: [CUSTOM({ price: 450, cost: undefined })] };
  const kept = ok(M().planSplitMatch(m, row, Object.assign({ creditRest: true }, small)));
  const pays = appendsOf(kept, 'Payments').map(o => o.values);
  assert.deepEqual(pays.map(p => [p.Amount, p.Sale_ID]), [[450, kept.result.saleIds[0]], [750, '']]);
  assert.equal(kept.result.credit, 750);
  const refused = M().planSplitMatch(m, row, small);
  assert.deepEqual(refused.errors, ['৳750 of the payment is not assigned. Add it to an item or keep it as credit.']);
  assert.deepEqual(refused.ops, []);
});

test('too much: items add up to more than the payment', () => {
  const { m, row, customerId } = scenario();
  const r = M().planSplitMatch(m, row, { customerId, targets: [RENEW(), CUSTOM({ price: 700 })] });
  assert.deepEqual(r.errors, ['The items add up to ৳1300, more than the payment ৳1200.']);
  assert.deepEqual(r.ops, []);
});

test('cent exactness: 333.33 + 333.33 + 333.35 is 1000.01; 0.1 + 0.2 is 0.3', () => {
  const { m, row, customerId } = scenario();
  row.Amount = 1000.01;
  const a = M().planSplitMatch(m, row, { customerId, targets: [CUSTOM({ price: 333.33 }), CUSTOM({ price: 333.33 }), CUSTOM({ price: 333.35 })] });
  assert.deepEqual(a.errors, []);
  assert.equal(appendsOf(a, 'Payments').reduce((s, o) => s + o.values.Amount, 0), 1000.01);
  row.Amount = 0.3;
  const b = M().planSplitMatch(m, row, { customerId, targets: [CUSTOM({ price: 0.1 }), CUSTOM({ price: 0.2 })] });
  assert.deepEqual(b.errors, []);
});

test('new customer: Customers append first, sale and payment use the new id; renew of another customer line is refused', () => {
  const { m, row } = scenario();
  const max = Math.max(...m.customers.map(c => Number(c.Customer_ID.slice(3))));
  const r = ok(M().planSplitMatch(m, row, { newCustomer: { name: 'Fresh Buyer' }, targets: [CUSTOM({ price: 1200, cost: 0 })] }));
  assert.equal(r.ops[0].tab, 'Customers');
  const id = 'CU-' + String(max + 1).padStart(4, '0');
  assert.equal(appendOf(r, 'Customers').values.Customer_ID, id);
  assert.equal(appendOf(r, 'Sales_Log').values.Customer_ID, id);
  assert.equal(appendsOf(r, 'Payments')[0].values.Customer_ID, id);
  const renewNew = M().planSplitMatch(m, row, { newCustomer: { name: 'Fresh Buyer' }, targets: [RENEW()] });
  assert.deepEqual(renewNew.errors, ['N44 is not an active subscription of this customer.']);
});

test('guards: duplicate line, bad kind, zero or seven items, blank title, unknown line; every failure writes nothing', () => {
  const { m, row, customerId } = scenario();
  const cases = [
    [[RENEW(), RENEW()], ['N44 appears twice. Use months instead.']],
    [[{ kind: 'bogus', price: 1 }], ['Item 1: pick renew, custom or new sale.']],
    [[], ['Add at least one item to split.']],
    [[CUSTOM({ price: 100 }), CUSTOM({ price: 100 }), CUSTOM({ price: 100 }), CUSTOM({ price: 100 }), CUSTOM({ price: 100 }), CUSTOM({ price: 100 }), CUSTOM({ price: 100 })], ['A split can have at most 6 items.']],
    [[CUSTOM({ price: 100 }), CUSTOM({ title: '', price: 1100 })], ['Item 2: Give the item a name (up to 80 characters).']],
    [[RENEW({ subCode: 'ZZ99' })], ['Item 1: No active subscription has the code ZZ99.']],
  ];
  cases.forEach(([targets, errors]) => {
    const r = M().planSplitMatch(m, row, { customerId, targets });
    assert.deepEqual(r.errors, errors, JSON.stringify(targets).slice(0, 80));
    assert.deepEqual(r.ops, []);
  });
});

test('a payment that is already recorded comes back as duplicate with one inbox update', () => {
  const { m, row, customerId } = scenario();
  m.payments.push({ Payment_ID: 'PM-99998', Transaction_ID: 'DJP2JBSWHA', Sale_ID: 1, Amount: 1200, Customer_ID: customerId });
  const r = M().planSplitMatch(m, row, { customerId, targets: [CUSTOM()] });
  assert.equal(r.status, 'duplicate');
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].tab, 'Payment_Inbox');
});

test('an open pay link for this reference is refused, as in the manual match', () => {
  const { m, row, customerId } = scenario();
  m.nowMs = Date.parse('2026-10-18T06:00:00Z');
  const req = Core.paylinks.planCreateRequest(m, { title: 'Netflix', amount: 1200, productId: 'NETFLIX', customerId, nowMs: m.nowMs });
  assert.deepEqual(req.errors, [], 'request created');
  const rq = req.ops.find(o => o.tab === 'Pay_Requests').values;
  m.payRequests = [rq];
  row.Reference = rq.Request_ID;
  const r = M().planSplitMatch(m, row, { customerId, targets: [CUSTOM()] });
  assert.match(r.errors[0], /is an open pay link. Confirm it from Pay links/);
  assert.deepEqual(r.ops, []);
});

test('mixed: a renewal and a product sale on a free seat, each paid 290 of 580', () => {
  const { m, row, customerId } = scenario();
  row.Amount = 580;
  const acc = m.accounts.find(a => a.Product_ID === 'NETFLIX' && Core.sales.freeSlots(m, a) > 0);
  assert.ok(acc, 'a NETFLIX account with a free seat');
  const r = ok(M().planSplitMatch(m, row, { customerId, targets: [RENEW({ months: 1, price: 290 }),
    { kind: 'newSale', productId: 'NETFLIX', accountId: acc.Account_ID, price: 290 }] }));
  assert.equal(r.result.saleIds.length, 2);
  const newSale = appendsOf(r, 'Sales_Log').find(o => o.values.Product_ID === 'NETFLIX').values;
  assert.equal(newSale.Account_ID, acc.Account_ID);
  assert.deepEqual(appendsOf(r, 'Payments').map(o => o.values.Amount), [290, 290]);
});

test('ids come from one generator: no duplicate sale or payment ids in one split', () => {
  const { m, row, customerId } = scenario();
  const r = ok(M().planSplitMatch(m, row, { customerId, targets: [RENEW(), CUSTOM()] }));
  const saleIds = appendsOf(r, 'Sales_Log').map(o => o.values.Sale_ID);
  const payIds = appendsOf(r, 'Payments').map(o => o.values.Payment_ID);
  assert.equal(new Set(saleIds).size, saleIds.length);
  assert.equal(new Set(payIds).size, payIds.length);
});

test('no transaction id, or no amount, is refused with no ops', () => {
  const { m, row, customerId } = scenario();
  row.Transaction_ID = '';
  assert.deepEqual(M().planSplitMatch(m, row, { customerId, targets: [CUSTOM()] }).errors, ['This message has no transaction ID, so it cannot be matched.']);
  row.Transaction_ID = 'NOAMT1';
  row.Amount = '';
  assert.deepEqual(M().planSplitMatch(m, row, { customerId, targets: [CUSTOM()] }).errors, ['This message has no amount.']);
});

// Task 0.7: an Ended line stops counting as owed. Billing and Profit keep its full price.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

const S = () => Core.sales;
const cust = (id, name) => ({ Customer_ID: id, Name: name || 'N' + id, Channel: '', Handle: '', Discord_User_ID: '', Notes: '', Created: '2026-10-01' });
const sale = (id, cid, extra) => Object.assign({ Sale_ID: id, Sale_Date: '2026-10-01', Customer: 'N' + cid, Contact: '', Product_ID: 'NETFLIX',
  Account_ID: 'NFX-03', Code_ID: '', Qty: 1, Unit_Price: 300, Paid_Till: '2026-10-15', Record_Status: 'Active', Notes: '', Customer_ID: cid, Months: 1,
  Sub_Code: 'N' + id, Cost_Snapshot: 100 }, extra || {});
const pay = (id, cid, saleId, amount) => ({ Payment_ID: id, Date: '2026-10-02', Customer_ID: cid, Sale_ID: saleId, Amount: amount,
  Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' });
const base = extra => makeState(Object.assign({ customers: [cust('C-1')], sales: [sale(1, 'C-1')], payments: [], remindersLog: [] }, extra || {}));

const KEY = { Sales_Log: ['sales', 'Sale_ID'], Accounts: ['accounts', 'Account_ID'] };
function apply(st, plan) {
  assert.deepEqual(plan.errors, []);
  for (const o of plan.ops) {
    const [field, key] = KEY[o.tab];
    st[field].filter(r => String(r[o.key || key]) === String(o.id)).forEach(r => Object.assign(r, o.values));
  }
}
const endIt = (st, id) => apply(st, S().planEndLine(st, { saleId: id, date: '2026-10-16' }));
const owed = st => ({
  dues: Core.views.duesList(st).total,
  duesRows: Core.views.duesList(st).rows.length,
  home: Core.views.homeData(st).owed,
  owes: Core.views.customerData(st, 'C-1').owes,
  credit: Core.views.customerData(st, 'C-1').credit,
  balance: Core.ledger.customerBalance(st, 'C-1'),
  lookup: Core.views.lookups(st).customers.find(c => c.id === 'C-1').owes,
  reminders: Core.reminders.planReminders(st).filter(r => r.saleId === 1).length
});

test('an unpaid Active line is owed; after End line it is not, anywhere', () => {
  const st = base();
  const before = owed(st);
  assert.equal(before.dues, 300);
  assert.equal(before.home, 300);
  assert.equal(before.owes, 300);
  assert.equal(before.lookup, 300);
  assert.ok(before.reminders >= 1, 'an unpaid active line is chased');
  endIt(st, 1);
  assert.deepEqual(owed(st), { dues: 0, duesRows: 0, home: 0, owes: 0, credit: 0, balance: 0, lookup: 0, reminders: 0 });
  assert.equal(Core.money.overview(st, '2026-10').dues.total, 0, 'aging buckets');
});

test('an Ended part-paid line owes nothing and the part payment does not become credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100)] });
  assert.equal(owed(st).owes, 200);
  endIt(st, 1);
  const o = owed(st);
  assert.equal(o.owes, 0);
  assert.equal(o.balance, 0, 'no negative balance, so no credit appears');
  assert.equal(o.credit, 0);
  assert.equal(o.dues, 0);
  const d = Core.views.customerData(st, 'C-1');
  assert.equal(d.payments.length, 1, 'payment is still listed');
  assert.equal(d.history.length, 1, 'the ended line stays in the customer history');
  assert.equal(d.history[0].status, 'Ended');
  assert.equal(d.history[0].owes, 0);
});

test('an Ended fully paid line has identical numbers before and after ending', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 300)] });
  const before = owed(st);
  endIt(st, 1);
  assert.deepEqual(owed(st), before);
});

test('an Ended overpaid line leaves only the excess as credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 300), pay('PM-2', 'C-1', 1, 50)] });
  endIt(st, 1);
  assert.equal(Core.ledger.customerBalance(st, 'C-1'), -50);
  assert.equal(owed(st).owes, 0);
});

test('retiring an account ends its Active lines and their balances leave Dues', () => {
  const st = base({ sales: [sale(1, 'C-1', { Paid_Till: '2026-10-10' }), sale(2, 'C-1', { Paid_Till: '2026-10-10', Account_ID: 'NFX-03' })] });
  assert.equal(Core.views.duesList(st).total, 600);
  apply(st, S().planDeleteAccount(st, { accountId: 'NFX-03' }));
  assert.equal(st.sales.filter(s => s.Record_Status === 'Ended').length, 2);
  assert.equal(Core.views.duesList(st).total, 0);
  assert.equal(Core.views.homeData(st).owed, 0);
});

test('Profit is identical before and after ending a part-paid line', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100)] });
  const fam0 = Core.views.profitByFamily(st), m0 = Core.views.profitByFamily(st, '2026-10');
  endIt(st, 1);
  assert.deepEqual(Core.views.profitByFamily(st), fam0);
  assert.deepEqual(Core.views.profitByFamily(st, '2026-10'), m0);
  assert.equal(Core.ledger.saleRevenue(st.sales[0], st.products), 300, 'billed revenue keeps the full price');
});

test('uncollectedFor is price minus paid for any non-void status, and 0 for Void and Refunded', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100)] });
  const L = Core.ledger;
  assert.equal(L.uncollectedFor(st.sales[0], st), 200);
  endIt(st, 1);
  assert.equal(L.uncollectedFor(st.sales[0], st), 200, 'Ended keeps its uncollected part');
  st.sales[0].Record_Status = 'Void';
  assert.equal(L.uncollectedFor(st.sales[0], st), 0);
  st.sales[0].Record_Status = 'Refunded';
  assert.equal(L.uncollectedFor(st.sales[0], st), 0);
  st.sales[0].Record_Status = 'Renewed';
  assert.equal(L.uncollectedFor(st.sales[0], st), 200);
});

test('owedBillFor: full price for every status but Ended, which is capped at what was paid', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100)] });
  const L = Core.ledger, s = st.sales[0];
  assert.equal(L.owedBillFor(s, st), 300);
  s.Record_Status = 'Ended';
  assert.equal(L.owedBillFor(s, st), 100);
  st.payments.push(pay('PM-2', 'C-1', 1, 500));
  assert.equal(L.owedBillFor(s, st), 300, 'never above the full price');
  s.Record_Status = 'Void';
  assert.equal(L.owedBillFor(s, st), 0);
  assert.equal(L.isVoided({ Record_Status: 'Refunded' }), true);
  assert.equal(L.isVoided({ Record_Status: 'Ended' }), false);
});

test('a payment recorded later against an Ended line stays on that line and is never credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100)] });
  endIt(st, 1);
  const plan = S().planPayment(st, { customerId: 'C-1', saleId: 1, amount: 40, method: 'bKash', trxId: 'TRXE1' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.result.applied, [{ saleId: 1, amount: 40 }]);
  assert.equal(plan.result.credit, 0);
  // an unassigned payment is not pushed onto an ended line: it has nothing owed
  const lump = S().planPayment(st, { customerId: 'C-1', amount: 40, method: 'bKash', trxId: 'TRXE2' });
  assert.deepEqual(lump.result.applied, []);
  assert.equal(lump.result.credit, 40);
});

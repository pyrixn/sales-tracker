const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { appendsOf, appendOf, ok } = require('./helpers');

const RENT = { Product_ID: 'EXLRENT1D', Product_Name: 'ExitLag rent 1D', Category: 'Subscription', Billing_Cycle_Days: 1,
  Default_Price: 50, Unit_Cost: 0, Letter: 'ER', Parent_ID: 'EXITLAG', Delivers_As: 'account', Active: 'Yes' };

function rentState() {
  const m = makeMigratedState();
  m.products.push(Object.assign({}, RENT));
  return m;
}

// Copy the rows a planner appends into a state copy, so later planners see them.
function commit(state, r) {
  appendsOf(r, 'Customers').forEach(o => state.customers.push(o.values));
  appendsOf(r, 'Sales_Log').forEach(o => state.sales.push(o.values));
  appendsOf(r, 'Payments').forEach(o => state.payments.push(o.values));
  return state;
}

// ExitLag accounts with a free seat today, in Account_ID order.
function freeEXL(state) {
  return state.accounts.filter(a => a.Product_ID === 'EXITLAG' && Core.sales.freeSlots(state, a) > 0)
    .map(a => a.Account_ID).sort();
}

function rent(state, extra) {
  return Core.sales.planNewSale(state, Object.assign({ productId: 'EXLRENT1D', customerId: cid(state, 'Kabir'),
    price: 50, cost: 30, _rand: n => 0 }, extra || {}));
}

test('rent product: planProduct takes a 1-day cycle as a variant of ExitLag', () => {
  const m = makeMigratedState();
  const r = ok(Core.sales.planProduct(m, { name: 'ExitLag rent 1D', productId: 'EXLRENT1D', category: 'Subscription',
    letter: 'ER', parentId: 'EXITLAG', cycleDays: 1, slots: 1, accountCost: 1, price: 50, deliversAs: 'account' }));
  const v = appendOf(r, 'Product_Catalog').values;
  assert.equal(v.Billing_Cycle_Days, 1);
  assert.equal(v.Parent_ID, 'EXITLAG');
  const letter = (l) => Core.sales.planProduct(m, { name: 'Rent ' + l, category: 'Subscription', letter: l,
    cycleDays: 1, slots: 1, accountCost: 1, price: 50, deliversAs: 'account' }).errors;
  assert.deepEqual(letter('R'), ['R is reserved for custom pay links.']);
  assert.equal(letter('E')[0], 'Letter E is already used by EXITLAG.');
  const days = (d) => Core.sales.planProduct(m, { name: 'Rent d' + d, category: 'Subscription', letter: 'ZR', cycleDays: d,
    slots: 1, accountCost: 1, price: 50, deliversAs: 'account' }).errors;
  assert.deepEqual(days(0), ['Renews every must be 1-400 days.']);
  assert.deepEqual(days(401), ['Renews every must be 1-400 days.']);
});

test('rent product: randomInt stays in range, covers every value, and n = 1 is always 0', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const x = Core.util.randomInt(7);
    assert.ok(Number.isInteger(x) && x >= 0 && x < 7);
    seen.add(x);
  }
  assert.equal(seen.size, 7);
  for (let i = 0; i < 50; i++) assert.equal(Core.util.randomInt(1), 0);
});

test('rent product: accountPoolId is the parent for a rent product, itself otherwise, and an own-account variant keeps its id', () => {
  const m = rentState();
  const rentP = m.products.find(p => p.Product_ID === 'EXLRENT1D');
  assert.equal(Core.sales.accountPoolId(m, rentP), 'EXITLAG');
  assert.equal(Core.sales.accountPoolId(m, m.products.find(p => p.Product_ID === 'EXITLAG')), 'EXITLAG');
  const v = Object.assign({}, rentP, { Product_ID: 'EXLV', Product_Name: 'ExitLag own', Letter: 'EV' });
  m.products.push(v);
  m.accounts.push({ Account_ID: 'EXLV-01', Product_ID: 'EXLV', Account_Label: 'own', Cycle_Cost: 1, Slots: 1,
    Renewal_Date: '', Account_Status: 'Active', Cost_Per_Slot: 1 });
  assert.equal(Core.sales.accountPoolId(m, v), 'EXLV');
});

test('rent product: a blank account picks a random free ExitLag account (never full, banned or closed ones)', () => {
  const m = rentState();
  const free = freeEXL(m);
  assert.ok(free.length >= 2, 'fixture needs two free ExitLag accounts');
  const first = ok(rent(m, { _rand: n => 0 }));
  assert.equal(first.result.accountId, free[0]);
  const row = appendOf(first, 'Sales_Log').values;
  assert.equal(row.Account_ID, free[0]);
  assert.equal(row.Paid_Till, '2026-10-19');
  assert.equal(row.Cost_Snapshot, 30);
  assert.equal(row.Unit_Price, 50);
  assert.equal(Core.ledger.saleRevenue(row, m.products), 50);
  const last = ok(rent(m, { _rand: n => n - 1 }));
  assert.equal(last.result.accountId, free[free.length - 1]);
  // A banned account is not a candidate.
  m.accounts.find(a => a.Account_ID === free[0]).Account_Status = 'Banned';
  const after = freeEXL(m);
  assert.equal(ok(rent(m, { _rand: n => 0 })).result.accountId, after[0]);
  assert.ok(after.indexOf(free[0]) < 0);
});

test('rent product: every ExitLag account full gives the no-free-seat error and writes nothing', () => {
  const m = rentState();
  m.accounts.forEach(a => { if (a.Product_ID === 'EXITLAG') a.Slots = 0; });
  const r = rent(m);
  assert.deepEqual(r.errors, ['No free seat on any ExitLag shared squad slot account. Add one, or wait for a seat to free up.']);
  assert.equal(r.ops.length, 0);
});

test('rent product: an explicit ExitLag account works; another product account is refused', () => {
  const m = rentState();
  const pick = freeEXL(m)[0];
  assert.equal(ok(rent(m, { accountId: pick })).result.accountId, pick);
  assert.deepEqual(rent(m, { accountId: 'NFX-01' }).errors, ['NFX-01 is not a EXITLAG account.']);
});

test('rent product: the sale takes a seat until its day ends, and the Accounts overview lists it', () => {
  const m = rentState();
  const acc = freeEXL(m)[0];
  const a = m.accounts.find(x => x.Account_ID === acc);
  const before = Core.sales.freeSlots(m, a);
  const r = ok(rent(m, { accountId: acc }));
  commit(m, r);
  assert.equal(Core.sales.freeSlots(m, a), before - 1);
  assert.ok(JSON.stringify(Core.views.accountsOverview(m)).indexOf('"saleId":' + r.result.saleId) >= 0);
  m.today = '2026-10-20';
  assert.equal(Core.sales.freeSlots(m, a), before);
});

test('rent product: renewing 3 days from the old date, or from today, keeps the account', () => {
  const m = rentState();
  const acc = freeEXL(m)[0];
  const r = ok(rent(m, { accountId: acc }));
  commit(m, r);
  const sub = r.result.subCode;
  m.sales.find(s => s.Sale_ID === r.result.saleId).Paid_Till = '2026-10-18';
  const a = ok(Core.sales.planRenew(m, { subCode: sub, months: 3, from: 'oldPaidTill' }));
  assert.equal(a.result.paidTill, '2026-10-21');
  assert.equal(appendOf(a, 'Sales_Log').values.Account_ID, acc);
  m.today = '2026-10-22';
  const b = ok(Core.sales.planRenew(m, { subCode: sub, months: 3, from: 'today' }));
  assert.equal(b.result.paidTill, '2026-10-25');
});

test('rent product: moving the sale to another ExitLag account works; to a Netflix account is refused', () => {
  const m = rentState();
  const acc = freeEXL(m)[0];
  const r = ok(rent(m, { accountId: acc }));
  commit(m, r);
  const other = m.accounts.find(a => a.Product_ID === 'EXITLAG' && a.Account_ID !== acc).Account_ID;
  assert.equal(Core.sales.planEdit(m, { kind: 'sale', id: r.result.saleId, values: { Account_ID: other } }).errors.length, 0);
  assert.deepEqual(Core.sales.planEdit(m, { kind: 'sale', id: r.result.saleId, values: { Account_ID: 'NFX-01' } }).errors,
    ['NFX-01 is not a EXITLAG account.']);
});

test('rent product: reminders - no before for a 1-day line, on the day and after still come; a 30-day line still gets before', () => {
  const m = rentState();
  const r = ok(rent(m, { accountId: freeEXL(m)[0] }));
  commit(m, r);
  const row = m.sales.find(s => s.Sale_ID === r.result.saleId);
  const kinds = (paidTill) => {
    row.Paid_Till = paidTill;
    return Core.reminders.planReminders(m).filter(x => x.saleId === r.result.saleId && x.kind !== 'due').map(x => x.kind);
  };
  assert.deepEqual(kinds('2026-10-19'), []);
  assert.deepEqual(kinds('2026-10-18'), ['on_day']);
  assert.deepEqual(kinds('2026-10-17'), ['after']);
  const n = m.sales.find(s => s.Product_ID === 'NETFLIX' && s.Record_Status === 'Active');
  n.Paid_Till = '2026-10-19';
  assert.deepEqual(Core.reminders.planReminders(m).filter(x => x.saleId === n.Sale_ID && x.kind !== 'due').map(x => x.kind), ['before']);
});

test('rent product: profit counts the rent sale under Subscription at 50 - 30', () => {
  const m = rentState();
  const r = ok(rent(m, { accountId: freeEXL(m)[0] }));
  commit(m, r);
  const sub = Core.views.profitByFamily(m).find(g => g.category === 'Subscription');
  const p = sub.products.find(x => x.productId === 'EXLRENT1D');
  assert.equal(p.name, 'ExitLag rent 1D');
  assert.equal(p.profit, 20);
});

test('rent product: two rent items in one split cannot both take the last free seat', () => {
  const m = rentState();
  const keep = freeEXL(m)[0];
  m.accounts.forEach(a => {
    if (a.Product_ID !== 'EXITLAG') return;
    a.Slots = a.Account_ID === keep ? a.Slots - Core.sales.freeSlots(m, a) + 1 : 0;
  });
  assert.equal(Core.sales.freeSlots(m, m.accounts.find(a => a.Account_ID === keep)), 1);
  const row = { Transaction_ID: 'RENTSPLIT1', Amount: 100, Received: '2026-10-18 10:00', Type: 'Received', Sender: '16247',
    Status: 'Pending', Reference: '', Raw_SMS: 'Cash In Tk 100.00 from 01XXXXXXXXX successful TrxID RENTSPLIT1' };
  const split = { customerId: cid(m, 'Kabir'), targets: [
    { kind: 'newSale', productId: 'EXLRENT1D', price: 50 },
    { kind: 'newSale', productId: 'EXLRENT1D', price: 50 }] };
  const plan = Core.matching.planSplitMatch(m, row, split);
  assert.deepEqual(plan.errors, [keep + ' has no free slot for both items.']);
  assert.equal(plan.ops.length, 0);
});

test('rent product: cost is optional and must be 0 or more', () => {
  const m = rentState();
  const acc = freeEXL(m)[0];
  assert.deepEqual(rent(m, { accountId: acc, cost: -1 }).errors, ['Cost must be 0 or more.']);
  const plain = ok(rent(m, { accountId: acc, cost: undefined }));
  assert.equal(appendOf(plain, 'Sales_Log').values.Cost_Snapshot, m.accounts.find(a => a.Account_ID === acc).Cost_Per_Slot);
});

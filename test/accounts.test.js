const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

const S = () => Core.sales;
const accountOf = m => m.accounts.find(a => a.Account_ID === 'NFX-03') || m.accounts[0];

test('editing an account: label, cost, seats, renewal date, notes and status', () => {
  const m = makeMigratedState();
  const a = accountOf(m);
  const plan = S().planEdit(m, { kind: 'account', id: a.Account_ID, values: { Account_Label: ' new@login.test ', Cycle_Cost: '850', Slots: 4, Renewal_Date: '2027-01-05', Notes: 'family plan', Account_Status: 'Inactive' } });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0], { op: 'update', tab: 'Accounts', key: 'Account_ID', id: a.Account_ID,
    values: { Account_Label: 'new@login.test', Cycle_Cost: '850', Slots: 4, Renewal_Date: '2027-01-05', Notes: 'family plan', Account_Status: 'Inactive' } });
});

test('editing an account refuses bad values and fields it does not own', () => {
  const m = makeMigratedState();
  const id = accountOf(m).Account_ID;
  const bad = [{ Account_Label: '  ' }, { Cycle_Cost: '' }, { Cycle_Cost: '-5' }, { Cycle_Cost: 'abc' }, { Slots: 0 }, { Slots: 2.5 }, { Slots: 21 },
    { Renewal_Date: '5 Jan' }, { Account_Status: 'Gone' }, { Product_ID: 'NETFLIX' }];
  for (const v of bad) assert.equal(S().planEdit(m, { kind: 'account', id, values: v }).errors.length, 1, JSON.stringify(v));
  assert.ok(S().planEdit(m, { kind: 'account', id: 'NOPE', values: {} }).errors[0].includes('NOPE'));
  assert.deepEqual(S().planEdit(m, { kind: 'account', id, values: { Renewal_Date: '' } }).errors, [], 'a blank renewal date clears it');
});

test('retiring an account dates its undated receipts and later cost entries, and keeps everything on record', () => {
  const m = makeMigratedState();
  const a = accountOf(m);
  const sale = m.sales.find(s => s.Account_ID === a.Account_ID);
  m.payments.push({ Payment_ID: 'PM-RET-1', Date: '', Customer_ID: sale.Customer_ID, Sale_ID: sale.Sale_ID, Amount: 100, Source: 'Migrated' });
  m.payments.push({ Payment_ID: 'PM-RET-2', Date: '2026-08-01', Customer_ID: sale.Customer_ID, Sale_ID: sale.Sale_ID, Amount: 50, Source: 'App' });
  m.purchases.push({ Purchase_ID: 'P-RET-1', Date: '2026-10-18', Account_ID: a.Account_ID, Amount: 800, Paid_With: 'UNKNOWN' });
  m.purchases.push({ Purchase_ID: 'P-RET-2', Date: '2026-05-01', Account_ID: a.Account_ID, Amount: 800, Paid_With: 'UNKNOWN' });
  const plan = S().planRetireAccount(m, { accountId: a.Account_ID, date: '2026-09-06' });
  assert.deepEqual(plan.errors, []);
  const upd = (tab, id) => plan.ops.find(o => o.tab === tab && o.id === id);
  assert.equal(upd('Accounts', a.Account_ID).values.Account_Status, 'Inactive');
  assert.match(upd('Accounts', a.Account_ID).values.Notes, /Retired 2026-09-06$/);
  assert.equal(upd('Payments', 'PM-RET-1').values.Date, '2026-09-06');
  assert.equal(upd('Payments', 'PM-RET-2'), undefined, 'a dated receipt stays');
  assert.equal(upd('Purchases', 'P-RET-1').values.Date, '2026-09-06', 'a cost entry after the last day moves back');
  assert.equal(upd('Purchases', 'P-RET-2'), undefined, 'an earlier cost entry stays');
  assert.ok(plan.ops.every(o => o.op === 'update'), 'nothing is deleted');
  assert.equal(plan.result.movedPayments >= 1, true);
  assert.equal(plan.result.movedPurchases, plan.ops.filter(o => o.tab === 'Purchases').length, 'the count matches the ops');
  assert.ok(plan.result.movedPurchases >= 1);
});

test('retiring without moving entries only changes the account; it refuses a retired account, a bad date and an unknown id', () => {
  const m = makeMigratedState();
  const a = accountOf(m);
  const plan = S().planRetireAccount(m, { accountId: a.Account_ID, date: '2026-09-06', moveEntries: false });
  assert.deepEqual(plan.ops.map(o => o.tab), ['Accounts']);
  assert.ok(S().planRetireAccount(m, { accountId: a.Account_ID, date: 'soon' }).errors[0].includes('date'));
  assert.ok(S().planRetireAccount(m, { accountId: 'NOPE', date: '2026-09-06' }).errors[0].includes('NOPE'));
  a.Account_Status = 'Inactive';
  assert.ok(S().planRetireAccount(m, { accountId: a.Account_ID, date: '2026-09-06' }).errors[0].includes('inactive'));
});

test('the overview rows carry what Edit sale needs and the account carries its last active day', () => {
  const m = makeMigratedState();
  const a = Core.views.accountsOverview(m).groups.flatMap(g => g.accounts).find(x => x.rows.length > 0);
  const r = a.rows[0];
  for (const k of ['saleId', 'productId', 'productName', 'accountId', 'status', 'price', 'months', 'profile', 'paidTill']) assert.ok(k in r, k);
  assert.equal(r.accountId, a.id);
  assert.ok(a.lastActive === '' || /^\d{4}-\d{2}-\d{2}$/.test(a.lastActive));
  assert.equal(typeof a.rawSlots, 'number');
});

test('a Deleted account is edit-accepted, has no free seats and drops out of the overview and lookups', () => {
  const m = makeMigratedState();
  const a = accountOf(m);
  assert.deepEqual(S().planEdit(m, { kind: 'account', id: a.Account_ID, values: { Account_Status: 'Deleted' } }).errors, []);
  a.Account_Status = 'Deleted';
  assert.equal(S().freeSlots(m, a), 0);
  assert.ok(!Core.views.lookups(m).accounts.some(x => x.id === a.Account_ID));
  assert.ok(!Core.views.accountsOverview(m).groups.some(g => g.accounts.some(x => x.id === a.Account_ID)));
});

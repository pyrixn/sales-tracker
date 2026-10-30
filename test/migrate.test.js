const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState, makeMigratedState } = require('./fixtures');

const r2 = n => Math.round(n * 100) / 100;

test('one customer per name, case and spacing ignored', () => {
  const mg = Core.migrate.planMigration(makeState());
  assert.equal(mg.customers.filter(c => c.Name.toLowerCase() === 'kabir').length, 1);
  const kabir = mg.customers.find(c => c.Name === 'Kabir').Customer_ID;
  assert.equal(mg.saleUpdates.filter(u => u.Customer_ID === kabir).length, 5);
  const farid = mg.customers.filter(c => c.Name.toLowerCase() === 'farid');
  assert.equal(farid.length, 1);
  assert.equal(mg.saleUpdates.filter(u => u.Customer_ID === farid[0].Customer_ID).length, 3);   // sales 3, 44, 80
  assert.equal(mg.customers[0].Customer_ID, 'CU-0001');
  assert.equal(mg.customers[0].Name, 'imran');
});

test('placeholder rows become one "Unlogged payment" customer per product', () => {
  const mg = Core.migrate.planMigration(makeState());
  const names = mg.customers.map(c => c.Name);
  assert.ok(names.includes('Unlogged payment (EXITLAG)'));
  assert.ok(names.includes('Unlogged payment (CRUNCHYROLL)'));
  assert.ok(!names.some(n => /^bkash/i.test(n)));
  const ex = mg.customers.find(c => c.Name === 'Unlogged payment (EXITLAG)').Customer_ID;
  assert.equal(mg.saleUpdates.filter(u => u.Customer_ID === ex).length, 17);   // 6,17,23-35,41,42
});

test('near-duplicate names are reported, never merged', () => {
  const mg = Core.migrate.planMigration(makeState());
  assert.ok(mg.nearDupes.some(p => p.includes('sadia') && p.includes('sadia mahin')));
  assert.ok(mg.customers.some(c => c.Name === 'sadia') && mg.customers.some(c => c.Name === 'sadia mahin'));
  assert.ok(!mg.nearDupes.some(p => p.includes('me')), 'two-letter names are too short to compare');
});

test('every sale gets Months 1 and its own Sub_Code from the product letter', () => {
  const mg = Core.migrate.planMigration(makeState());
  assert.equal(mg.saleUpdates.length, 102);
  assert.ok(mg.saleUpdates.every(u => u.Months === 1));
  assert.equal(mg.saleUpdates[0].Sub_Code, 'E1');
  assert.equal(mg.saleUpdates.find(u => u.Sale_ID === 44).Sub_Code, 'N44');
  assert.equal(new Set(mg.saleUpdates.map(u => u.Sub_Code)).size, 102);
});

test('payments carry over the collected money exactly', () => {
  const mg = Core.migrate.planMigration(makeState());
  assert.equal(mg.payments.length, 90);
  assert.equal(Math.round(mg.payments.reduce((a, p) => a + p.Amount, 0)), 33787);
  assert.ok(mg.payments.every(p => p.Source === 'Migrated' && p.Date === '' && p.Method === ''));
  assert.equal(mg.payments[0].Payment_ID, 'PM-00001');
});

test('migrated state keeps the Dashboard totals', () => {
  const m = makeMigratedState();
  const revenue = m.sales.reduce((a, x) => a + Core.ledger.saleRevenue(x, m.products), 0);
  const outstanding = m.sales.reduce((a, x) => a + Math.max(0, Core.ledger.saleBalance(x, m)), 0);
  assert.equal(Math.round(revenue), 35147);
  assert.equal(r2(outstanding), 1360);
  assert.ok(m.sales.every(x => x.Customer_ID && x.Sub_Code));
  assert.equal(m.sales[0].Amount_Paid, undefined, 'Amount_Paid is derived from Payments after migration');
});

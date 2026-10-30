const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

const products = makeState().products;

test('saleRevenue multiplies price by qty and months, zero when void or refunded', () => {
  const { saleRevenue } = Core.ledger;
  assert.equal(saleRevenue({ Unit_Price: 290, Qty: 1, Months: 3, Record_Status: 'Active' }, products), 870);
  assert.equal(saleRevenue({ Unit_Price: 290, Qty: '', Months: '', Record_Status: 'Renewed' }, products), 290);
  assert.equal(saleRevenue({ Unit_Price: 290, Record_Status: 'Void' }, products), 0);
  assert.equal(saleRevenue({ Unit_Price: 290, Record_Status: 'Refunded' }, products), 0);
});

test('saleRevenue keeps a typed 0 price and falls back to the catalog only when blank', () => {
  const { saleRevenue } = Core.ledger;
  assert.equal(saleRevenue({ Product_ID: 'NETFLIX', Unit_Price: 0, Record_Status: 'Active' }, products), 0);
  assert.equal(saleRevenue({ Product_ID: 'NETFLIX', Unit_Price: '', Record_Status: 'Active' }, products), 290);
});

function kabirState() {
  const s = makeState();
  s.sales.forEach(x => { x.Customer_ID = x.Customer === 'Kabir' ? 'CU-0001' : 'CU-0099'; });
  s.sales.find(x => x.Sale_ID === 90).Customer_ID = 'CU-0001';            // give Kabir a second due for the test
  s.payments = s.sales.filter(x => x.Amount_Paid > 0).map((x, i) => ({
    Payment_ID: 'PM-' + i, Customer_ID: x.Customer_ID, Sale_ID: x.Sale_ID, Amount: x.Amount_Paid, Source: 'Migrated' }));
  return s;
}

test('saleBalance and customerBalance subtract payments', () => {
  const s = kabirState();
  assert.equal(Core.ledger.saleBalance(s.sales.find(x => x.Sale_ID === 54), s), 300);
  assert.equal(Core.ledger.saleBalance(s.sales.find(x => x.Sale_ID === 9), s), 0);
  assert.equal(Core.ledger.customerBalance(s, 'CU-0001'), 470);
  s.payments.push({ Payment_ID: 'PM-X', Customer_ID: 'CU-0001', Sale_ID: '', Amount: 500, Source: 'App' });
  assert.equal(Core.ledger.customerBalance(s, 'CU-0001'), -30);
});

test('openDues lists unpaid sales oldest first', () => {
  const s = kabirState();
  assert.deepEqual(Core.ledger.openDues(s, 'CU-0001'),
    [{ saleId: 54, balance: 300, since: '2026-10-09' }, { saleId: 90, balance: 170, since: '2026-10-19' }]);
});

test('allocate fills the oldest due first and returns the rest', () => {
  const { allocate } = Core.ledger;
  const dues = [{ saleId: 54, balance: 300, since: '2026-10-09' }, { saleId: 90, balance: 170, since: '2026-10-19' }];
  assert.deepEqual(allocate(500, dues), { applied: [{ saleId: 54, amount: 300 }, { saleId: 90, amount: 170 }], rest: 30 });
  assert.deepEqual(allocate(100, dues), { applied: [{ saleId: 54, amount: 100 }], rest: 0 });
  assert.deepEqual(allocate(50, []), { applied: [], rest: 50 });
});

test('whole-business totals equal the Dashboard after migration', () => {
  const { makeMigratedState, cid } = require('./fixtures');
  const m = makeMigratedState();
  const revenue = m.sales.reduce((a, x) => a + Core.ledger.saleRevenue(x, m.products), 0);
  const owed = m.customers.reduce((a, c) => a + Math.max(0, Core.ledger.customerBalance(m, c.Customer_ID)), 0);
  assert.equal(Math.round(revenue), 35147);
  assert.equal(Math.round(owed), 1360);
  assert.equal(Core.ledger.customerBalance(m, cid(m, 'Kabir')), 300);
});

test('saleCostBdt converts USDT to BDT using live rate', () => {
  const state = {
    liveRates: [{ ID: 'usdt_bdt', Rate: 123.5, Fetched_At: new Date().toISOString() }],
    suppliers: [{ Supplier_ID: 'SUP-01', Markup_Percent: 0 }],
    products: [{ Product_ID: 'TEST', Supplier_ID: 'SUP-01' }],
    sales: [],
    settings: {}
  };
  const sale = { Buy_Price_USDT: 10, Buy_Currency: 'USDT', Product_ID: 'TEST', Cost_Snapshot: '' };
  assert.equal(Core.ledger.saleCostBdt(sale, state), 1235);
});

test('saleCostBdt applies supplier markup', () => {
  const state = {
    liveRates: [{ ID: 'usdt_bdt', Rate: 100, Fetched_At: new Date().toISOString() }],
    suppliers: [{ Supplier_ID: 'SUP-01', Markup_Percent: 10 }],
    products: [{ Product_ID: 'TEST', Supplier_ID: 'SUP-01' }],
    sales: [],
    settings: {}
  };
  const sale = { Buy_Price_USDT: 10, Buy_Currency: 'USDT', Product_ID: 'TEST', Cost_Snapshot: '' };
  assert.equal(Core.ledger.saleCostBdt(sale, state), 1100);
});

test('saleCostBdt falls back to Cost_Snapshot when no USDT fields', () => {
  const state = { liveRates: [], suppliers: [], products: [], sales: [], settings: {} };
  const sale = { Cost_Snapshot: 500, Buy_Currency: 'BDT', Product_ID: 'X' };
  assert.equal(Core.ledger.saleCostBdt(sale, state), 500);
});

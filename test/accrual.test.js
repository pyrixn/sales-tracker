const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

const A = () => Core.accrual;
const sum = o => Math.round(Object.values(o).reduce((a, b) => a + b, 0) * 100) / 100;

// Synthetic state: no real names. STREAM is a monthly seat product, RENT a 1-day product.
function base(extra) {
  return Object.assign({
    today: '2026-10-20', settings: {},
    products: [
      { Product_ID: 'STREAM', Product_Name: 'Streaming A', Billing_Cycle_Days: 30, Default_Price: 300, Unit_Cost: 0 },
      { Product_ID: 'RENT', Product_Name: 'Day rent', Billing_Cycle_Days: 1, Default_Price: 50, Unit_Cost: 0 },
      { Product_ID: 'KEYS', Product_Name: 'Keys', Billing_Cycle_Days: 0, Default_Price: 150, Unit_Cost: 40 }
    ],
    accounts: [], sales: [], purchases: [], payments: [], suppliers: [], liveRates: []
  }, extra || {});
}
let nextId = 1;
const acct = (id, slots, extra) => Object.assign({ Account_ID: id, Product_ID: 'STREAM', Account_Label: 'Label ' + id, Slots: slots, Account_Status: 'Active' }, extra || {});
const sale = (extra) => Object.assign({ Sale_ID: nextId++, Sale_Date: '2026-10-01', Product_ID: 'STREAM', Account_ID: '', Code_ID: '', Qty: 1, Unit_Price: 300,
  Months: 1, Paid_Till: '2026-11-01', Covers_From: '2026-10-01', Record_Status: 'Active', Cost_Snapshot: 0 }, extra || {});
const purchase = (accountId, amount, coversUntil, date) => ({ Purchase_ID: 'P-' + nextId++, Date: date || '', Account_ID: accountId, Amount: amount, Covers_Until: coversUntil });
const month = (res, m) => res.months.find(x => x.month === m);

test('spread: 900 over three whole months gives 300 each', () => {
  assert.deepEqual(A().spread(900, '2026-10-01', '2027-01-01'), { '2026-10': 300, '2026-11': 300, '2026-12': 300 });
});

test('spread: a single day (blank end) lands wholly in its month', () => {
  assert.deepEqual(A().spread(50, '2026-10-31', ''), { '2026-10': 50 });
  assert.deepEqual(A().spread(50, '2026-10-31', '2026-11-01'), { '2026-10': 50 });
});

test('spread: a period across a month boundary weighs the share of each calendar month', () => {
  assert.deepEqual(A().spread(600, '2026-10-16', '2026-11-16'), { '2026-10': 304.76, '2026-11': 295.24 });
});

test('spread: parts always sum exactly to the amount', () => {
  const ranges = [['2026-10-01', '2027-01-01'], ['2026-10-16', '2026-11-16'], ['2026-10-31', '2026-11-02'], ['2026-01-15', '2026-12-09'],
    ['2026-02-27', '2026-03-03'], ['2026-10-05', '2026-10-06'], ['2026-11-30', '2027-03-01'], ['2026-10-01', '']];
  for (const amount of [900, 100, 333.33, 0.01, 1234.57, 7, 2000]) {
    for (const [a, b] of ranges) assert.equal(sum(A().spread(amount, a, b)), amount, amount + ' ' + a + '..' + b);
  }
});

test('saleCoverage: Covers_From wins, else Paid_Till minus Months cycles, else a single day, else null', () => {
  const p = base().products;
  assert.deepEqual(A().saleCoverage(sale({ Covers_From: '2026-10-05', Paid_Till: '2026-11-05' }), p), { start: '2026-10-05', end: '2026-11-05' });
  assert.deepEqual(A().saleCoverage(sale({ Covers_From: '', Months: 3, Paid_Till: '2027-01-01' }), p), { start: '2026-10-01', end: '2027-01-01' });
  assert.deepEqual(A().saleCoverage(sale({ Covers_From: '', Product_ID: 'RENT', Months: 1, Paid_Till: '2026-10-16' }), p), { start: '2026-10-15', end: '2026-10-16' });
  assert.deepEqual(A().saleCoverage(sale({ Covers_From: '', Paid_Till: '', Sale_Date: '2026-10-09' }), p), { start: '2026-10-09', end: '' });
  assert.equal(A().saleCoverage(sale({ Covers_From: '', Paid_Till: '', Sale_Date: '' }), p), null);
  // A start on or after the end falls back to one day before the end.
  assert.deepEqual(A().saleCoverage(sale({ Covers_From: '2026-12-01', Paid_Till: '2026-11-01' }), p), { start: '2026-10-31', end: '2026-11-01' });
});

test('a 3-month sale splits into three months and the months sum to the all-time revenue', () => {
  const s = base({ accounts: [acct('A1', 4)], sales: [sale({ Account_ID: 'A1', Unit_Price: 300, Months: 3, Sale_Date: '2026-10-01', Covers_From: '', Paid_Till: '2027-01-01' })] });
  const r = A().monthly(s, { from: '2026-09', to: '2027-02' });
  assert.deepEqual(r.months.map(m => [m.month, m.revenue]), [['2026-09', 0], ['2026-10', 300], ['2026-11', 300], ['2026-12', 300], ['2027-01', 0], ['2027-02', 0]]);
  assert.equal(r.months.reduce((a, m) => a + m.revenue, 0), Core.ledger.saleRevenue(s.sales[0], s.products));
});

test('a 1-day rent lands wholly in the month of its day', () => {
  const s = base({ accounts: [acct('A1', 4)], sales: [sale({ Product_ID: 'RENT', Account_ID: 'A1', Unit_Price: 50, Months: 1, Sale_Date: '2026-10-31', Covers_From: '', Paid_Till: '2026-11-01' })] });
  const r = A().monthly(s, { from: '2026-10', to: '2026-11' });
  assert.deepEqual(r.months.map(m => m.revenue), [50, 0]);
});

test('months sum to the all-time revenue over mixed periods, void and refunded excluded', () => {
  const s = base({ accounts: [acct('A1', 4)], sales: [
    sale({ Account_ID: 'A1', Unit_Price: 333, Months: 2, Covers_From: '2026-10-16', Paid_Till: '2026-12-16' }),
    sale({ Account_ID: 'A1', Unit_Price: 301, Months: 1, Covers_From: '2026-11-20', Paid_Till: '2026-12-20' }),
    sale({ Product_ID: 'RENT', Account_ID: 'A1', Unit_Price: 45, Covers_From: '', Paid_Till: '2026-10-31', Sale_Date: '2026-10-30' }),
    sale({ Product_ID: 'KEYS', Unit_Price: 150, Paid_Till: '', Covers_From: '', Sale_Date: '2026-11-03', Cost_Snapshot: 40 }),
    sale({ Account_ID: 'A1', Record_Status: 'Void' }),
    sale({ Account_ID: 'A1', Record_Status: 'Refunded' })
  ] });
  const r = A().monthly(s, { from: '2026-09', to: '2027-02' });
  const all = s.sales.reduce((a, x) => a + Core.ledger.saleRevenue(x, s.products), 0);
  assert.equal(all, 666 + 301 + 45 + 150);
  assert.equal(Math.round(r.months.reduce((a, m) => a + m.revenue, 0) * 100) / 100, all);
});

test('void and refunded sales give 0 revenue and 0 cost', () => {
  const s = base({ accounts: [acct('A1', 4)], sales: [
    sale({ Account_ID: 'A1', Record_Status: 'Void', Cost_Snapshot: 80 }),
    sale({ Account_ID: 'A1', Record_Status: 'Refunded', Cost_Snapshot: 80 })
  ] });
  const m = month(A().monthly(s, { from: '2026-10', to: '2026-10' }), '2026-10');
  assert.deepEqual([m.revenue, m.cost, m.profit], [0, 0, 0]);
  assert.deepEqual(m.byAccount, []);
});

test('a full account and a half-empty account with the same sales and cost give the same profit: empty seats count as cost', () => {
  const sales = id => [sale({ Account_ID: id, Cost_Snapshot: 100 }), sale({ Account_ID: id, Cost_Snapshot: 100 })];
  const s = base({
    accounts: [acct('FULL', 2), acct('HALF', 4)],
    sales: sales('FULL').concat(sales('HALF')),
    purchases: [purchase('FULL', 400, '2026-11-01', '2026-10-01'), purchase('HALF', 400, '2026-11-01', '2026-10-01')]
  });
  const m = month(A().monthly(s, { from: '2026-10', to: '2026-10' }), '2026-10');
  const full = m.byAccount.find(a => a.accountId === 'FULL'), half = m.byAccount.find(a => a.accountId === 'HALF');
  // Per-seat cost (Cost_Snapshot 100) would give the half-empty account 600 - 200 = 400; the account cost gives 200 for both.
  assert.deepEqual([full.revenue, full.cost, full.profit, full.seats, full.seatsUsed], [600, 400, 200, 2, 2]);
  assert.deepEqual([half.revenue, half.cost, half.profit, half.seats, half.seatsUsed], [600, 400, 200, 4, 2]);
  assert.deepEqual([m.revenue, m.cost, m.profit], [1200, 800, 400]);
  assert.deepEqual(A().monthly(s, { from: '2026-10', to: '2026-10' }).costMissing, []);
});

test('a half-empty account with one seat sold shows a loss, not seat-cost profit', () => {
  const s = base({ accounts: [acct('HALF', 4)], sales: [sale({ Account_ID: 'HALF', Cost_Snapshot: 100 })],
    purchases: [purchase('HALF', 400, '2026-11-01', '2026-10-01')] });
  const m = month(A().monthly(s, { from: '2026-10', to: '2026-10' }), '2026-10');
  assert.deepEqual([m.revenue, m.cost, m.profit], [300, 400, -100]);
});

test('a purchase spread across a month boundary splits its cost; chained purchases start at the previous end', () => {
  const s = base({ accounts: [acct('A1', 4)], purchases: [
    purchase('A1', 600, '2026-11-16', '2026-10-17'),
    purchase('A1', 600, '2026-12-16', '2026-11-16')
  ] });
  const periods = A().purchasePeriods(s).map(x => [x.start, x.end]);
  assert.deepEqual(periods, [['2026-10-16', '2026-11-16'], ['2026-11-16', '2026-12-16']]);
  const r = A().monthly(s, { from: '2026-10', to: '2026-12' });
  assert.deepEqual(A().spread(600, '2026-11-16', '2026-12-16'), { '2026-11': 304.92, '2026-12': 295.08 });
  assert.deepEqual(r.months.map(m => m.cost), [304.76, 600.16, 295.08]);
  assert.equal(Math.round(r.months.reduce((a, m) => a + m.cost, 0) * 100) / 100, 1200);
});

test('a purchase with no Covers_Until covers one cycle from its Date', () => {
  const s = base({ accounts: [acct('A1', 4)], purchases: [purchase('A1', 300, '', '2026-10-01')] });
  assert.deepEqual(A().purchasePeriods(s).map(x => [x.start, x.end]), [['2026-10-01', '2026-11-01']]);
  assert.equal(month(A().monthly(s, { from: '2026-10', to: '2026-10' }), '2026-10').cost, 300);
});

test('an account with no purchase falls back to Cost_Snapshot and is listed in costMissing; custom and code sales are not', () => {
  const s = base({ accounts: [acct('NOBUY', 4), acct('HASBUY', 4)], sales: [
    sale({ Account_ID: 'NOBUY', Cost_Snapshot: 100 }),
    sale({ Account_ID: 'HASBUY', Cost_Snapshot: 100 }),
    sale({ Product_ID: 'CUSTOM', Unit_Price: 70, Paid_Till: '', Covers_From: '', Cost_Snapshot: 20, Sale_Date: '2026-10-10' }),
    sale({ Product_ID: 'KEYS', Unit_Price: 150, Paid_Till: '', Covers_From: '', Cost_Snapshot: 40, Sale_Date: '2026-10-11' })
  ], purchases: [purchase('HASBUY', 400, '2026-11-01', '2026-10-01')] });
  const r = A().monthly(s, { from: '2026-10', to: '2026-10' });
  assert.deepEqual(r.costMissing, ['NOBUY']);
  const m = month(r, '2026-10');
  // NOBUY 100 + HASBUY account cost 400 (its seat's own cost is not added) + custom 20 + code 40.
  assert.equal(m.cost, 560);
  assert.equal(m.revenue, 300 + 300 + 70 + 150);
  assert.equal(m.byAccount.find(a => a.accountId === 'HASBUY').cost, 400);
  assert.equal(m.byAccount.find(a => a.accountId === 'NOBUY').cost, 100);
});

test('collected counts payments dated in the month and excludes Source Credit', () => {
  const s = base({ payments: [
    { Payment_ID: 'PM-1', Date: '2026-10-05', Amount: 300, Source: 'App' },
    { Payment_ID: 'PM-2', Date: '2026-10-31', Amount: 200, Source: 'bKash' },
    { Payment_ID: 'PM-3', Date: '2026-10-06', Amount: 500, Source: 'Credit' },
    { Payment_ID: 'PM-4', Date: '2026-11-01', Amount: 120, Source: 'App' },
    { Payment_ID: 'PM-5', Date: '', Amount: 999, Source: 'App' },
    { Payment_ID: 'PM-6', Date: '2026-08-01', Amount: 77, Source: 'App' }
  ] });
  const r = A().monthly(s, { from: '2026-10', to: '2026-11' });
  assert.deepEqual(r.months.map(m => m.collected), [500, 120]);
});

test('range validation: from after to, more than 24 months, bad format', () => {
  const s = base();
  assert.throws(() => A().monthly(s, { from: '2026-12', to: '2026-10' }), /From must not be after to\./);
  assert.throws(() => A().monthly(s, { from: '2024-01', to: '2026-01' }), /at most 24 months/);
  assert.equal(A().monthly(s, { from: '2024-01', to: '2025-12' }).months.length, 24);
  for (const bad of [{ from: '2026-1', to: '2026-10' }, { from: '2026-10', to: '10/2026' }, { from: '2026-10-01', to: '2026-11' }, { from: 'abc', to: '2026-10' }]) {
    assert.throws(() => A().monthly(s, bad), /From and to must be months like 2026-10\./, JSON.stringify(bad));
  }
});

test('the default range is the last 6 months to the current month', () => {
  const r = A().monthly(base(), {});
  assert.deepEqual([r.from, r.to, r.months.length], ['2026-05', '2026-10', 6]);
});

// Core.money.insights: billed vs collected figures, renewal rate, retention, forecast; ties to profitByFamily and the Book.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

const I = (st, o) => Core.money.insights(st, o);
const cust = (id, name) => ({ Customer_ID: id, Name: name || 'N' + id, Channel: '', Handle: '', Discord_User_ID: '', Notes: '', Created: '2026-01-01' });
const sale = (id, cid, extra) => Object.assign({ Sale_ID: id, Sale_Date: '2026-10-01', Customer: 'N' + cid, Contact: '', Product_ID: 'NETFLIX',
  Account_ID: 'NFX-03', Code_ID: '', Qty: 1, Unit_Price: 300, Paid_Till: '2026-11-01', Record_Status: 'Active', Notes: '', Customer_ID: cid, Months: 1,
  Sub_Code: 'N' + id, Cost_Snapshot: 100 }, extra || {});
const pay = (id, cid, saleId, amount, extra) => Object.assign({ Payment_ID: id, Date: '2026-10-02', Customer_ID: cid, Sale_ID: saleId, Amount: amount,
  Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' }, extra || {});
const base = extra => makeState(Object.assign({ customers: [cust('C-1'), cust('C-2')], sales: [], payments: [], remindersLog: [] }, extra || {}));
const OCT = { from: '2026-10-01', to: '2026-10-31' };

test('empty state: zeros everywhere, no NaN, month list covers the range', () => {
  const r = I(base(), { from: '2026-08-01', to: '2026-10-18' });
  assert.deepEqual(r.range, { from: '2026-08-01', to: '2026-10-18' });
  assert.deepEqual(r.months.map(m => m.month), ['2026-08', '2026-09', '2026-10']);
  assert.ok(r.months.every(m => m.revenue === 0 && m.cost === 0 && m.profit === 0 && m.collected === 0 && m.payments === 0));
  const k = r.kpis;
  ['revenue', 'profit', 'marginPct', 'arpu', 'renewalRatePct', 'collectionRatePct', 'avgDaysLate', 'churnedLines', 'undatedPayments'].forEach(f => assert.equal(k[f], 0, f));
  assert.deepEqual([r.byCategory, r.topCustomers, r.retention, r.methodMix], [[], [], [], []]);
  assert.deepEqual(r.forecast, { next30Expected: 0, next30Lines: [] });
});

test('default range is the 12 full months before this month plus the current one', () => {
  const r = I(base());
  assert.equal(r.range.from, '2025-10-01');
  assert.equal(r.range.to, '2026-10-18');
  assert.equal(r.months.length, 13);
});

test('one month: billed revenue, cost, profit, margin, collected and ARPU', () => {
  const st = base({ sales: [sale(1, 'C-1'), sale(2, 'C-2', { Unit_Price: 200, Cost_Snapshot: 50 })], payments: [pay('PM-1', 'C-1', 1, 300), pay('PM-2', 'C-2', 2, 100, { Method: 'Nagad' })] });
  const r = I(st, OCT);
  const m = r.months.find(x => x.month === '2026-10');
  assert.deepEqual([m.revenue, m.cost, m.profit, m.collected, m.payments], [500, 150, 350, 400, 2]);
  assert.equal(r.kpis.revenue, 500);
  assert.equal(r.kpis.profit, 350);
  assert.equal(r.kpis.marginPct, 70);
  assert.equal(r.kpis.collected, 400);
  assert.equal(r.kpis.arpu, 250);
  assert.equal(r.kpis.activeLines, 2);
  assert.equal(r.kpis.activeCustomers, 2);
  assert.deepEqual(r.methodMix.map(x => [x.method, x.amount, x.share]), [['bKash', 300, 75], ['Nagad', 100, 25]]);
  // 200 still unpaid on sale 2: collection = 400 / (400 + 100)
  assert.equal(r.kpis.collectionRatePct, 80);
  assert.equal(r.topCustomers[0].customerId, 'C-1');
  assert.deepEqual(r.topCustomers.map(c => [c.revenue, c.profit, c.owes]), [[300, 200, 0], [200, 150, 100]]);
});

test('a lapse with a renewal within 7 days counts as renewed; one without counts as churn; a young one is pending', () => {
  const st = base({
    sales: [
      sale(1, 'C-1', { Sale_Date: '2026-08-10', Paid_Till: '2026-09-10', Record_Status: 'Renewed', Sub_Code: 'A' }),
      sale(2, 'C-1', { Sale_Date: '2026-09-12', Paid_Till: '2026-10-12', Sub_Code: 'A' }),
      sale(3, 'C-2', { Sale_Date: '2026-08-10', Paid_Till: '2026-09-10', Sub_Code: 'B' }),
      sale(4, 'C-2', { Sale_Date: '2026-09-15', Paid_Till: '2026-10-15', Sub_Code: 'C' })
    ] });
  const r = I(st, { from: '2026-09-01', to: '2026-10-18' });
  // reached: 1 (renewed 09-12), 2 (renewed? no later sale, 10-12 + 7 = 10-19 > today -> pending), 3 (lapsed), 4 (pending: 10-22)
  assert.equal(r.kpis.renewalRatePct, 50);
  assert.equal(r.kpis.churnedLines, 1);
  const sep = r.months.find(m => m.month === '2026-09');
  assert.equal(sep.renewals, 1, 'sale 2 is the renewal of line A');
});

test('undated payments stay out of the series and are counted', () => {
  const st = base({ sales: [sale(1, 'C-1')], payments: [pay('PM-1', 'C-1', 1, 300), pay('PM-2', 'C-1', 1, 40, { Date: '' }), pay('PM-3', 'C-1', '', 10, { Source: 'Credit' })] });
  const r = I(st, OCT);
  assert.equal(r.kpis.undatedPayments, 1);
  assert.equal(r.kpis.collected, 300);
  assert.equal(r.months.find(m => m.month === '2026-10').payments, 1);
});

test('ties to profitByFamily and the Book for the same month', () => {
  const st = base({
    customers: [cust('C-1'), cust('C-2'), cust('C-3')],
    sales: [sale(1, 'C-1'), sale(2, 'C-2', { Product_ID: 'EXITLAG', Account_ID: 'EXL-01', Unit_Price: 450, Cost_Snapshot: 120, Months: 2 }),
      sale(3, 'C-3', { Sale_Date: '2026-09-20', Unit_Price: 280 }), sale(4, 'C-3', { Record_Status: 'Void' })],
    payments: [pay('PM-1', 'C-1', 1, 300), pay('PM-2', 'C-2', 2, 600, { Method: 'Nagad' }), pay('PM-3', 'C-3', 3, 280, { Date: '2026-09-21' })] });
  for (const [month, range] of [['2026-10', OCT], ['2026-09', { from: '2026-09-01', to: '2026-09-30' }]]) {
    const r = I(st, range), fam = Core.views.profitByFamily(st, month);
    assert.ok(fam.length > 0);
    assert.deepEqual(r.byCategory.map(c => [c.category, c.revenue, c.profit]), fam.map(f => [f.category, f.revenue, f.profit]), month + ' byCategory');
    const sum = k => Math.round(fam.reduce((a, f) => a + f[k], 0) * 100) / 100;
    assert.equal(r.kpis.revenue, sum('revenue'));
    assert.equal(r.kpis.profit, sum('profit'));
    assert.equal(r.months.find(m => m.month === month).revenue, sum('revenue'));
    assert.equal(r.months.find(m => m.month === month).collected, Core.views.bookData(st, month).in, month + ' collected = Book in');
  }
});

test('an Ended line keeps its billed revenue but is not counted as owed in the collection rate', () => {
  const st = base({ sales: [sale(1, 'C-1', { Record_Status: 'Ended' })], payments: [pay('PM-1', 'C-1', 1, 100)] });
  const r = I(st, OCT);
  assert.equal(r.kpis.revenue, 300);
  assert.equal(r.kpis.collectionRatePct, 100);
  assert.equal(r.topCustomers[0].owes, 0);
});

test('average days late runs over lines that still owe', () => {
  const st = base({ sales: [sale(1, 'C-1', { Paid_Till: '2026-10-08' }), sale(2, 'C-2', { Paid_Till: '2026-10-14' }), sale(3, 'C-2', { Sub_Code: 'Z' })],
    payments: [pay('PM-1', 'C-2', 3, 300)] });
  assert.equal(I(st, OCT).kpis.avgDaysLate, 7); // (10 + 4) / 2
});

test('forecast lists active lines renewing in the next 30 days with the monthly price', () => {
  const st = base({ sales: [sale(1, 'C-1', { Paid_Till: '2026-10-20' }), sale(2, 'C-2', { Paid_Till: '2026-11-16', Unit_Price: 250 }), sale(3, 'C-2', { Paid_Till: '2026-11-17' }), sale(4, 'C-1', { Paid_Till: '2026-10-10' })] });
  const f = I(st).forecast;
  assert.deepEqual(f.next30Lines.map(l => [l.saleId, l.date, l.amount, l.name, l.productName.length > 0]), [[1, '2026-10-20', 300, 'NC-1', true], [2, '2026-11-16', 250, 'NC-2', true]]);
  assert.equal(f.next30Expected, 550);
  // the 14-day overview forecast is built from the same lines
  assert.deepEqual(Core.money.overview(st, '2026-10').forecast, [{ date: '2026-10-20', amount: 300, count: 1 }]);
});

test('retention: cohort by first sale month, kept when Paid_Till reaches the step, null while too young', () => {
  const st = base({
    customers: [cust('C-1'), cust('C-2'), cust('C-3')],
    sales: [sale(1, 'C-1', { Sale_Date: '2026-07-05', Paid_Till: '2026-09-20' }), sale(2, 'C-2', { Sale_Date: '2026-07-06', Paid_Till: '2026-07-30' }),
      sale(3, 'C-3', { Sale_Date: '2026-10-01', Paid_Till: '2026-11-01' })] });
  const r = I(st, { from: '2026-07-01', to: '2026-10-18' });
  const jul = r.retention.find(c => c.cohort === '2026-07'), oct = r.retention.find(c => c.cohort === '2026-10');
  assert.equal(jul.size, 2);
  assert.deepEqual(jul.kept, [50, 50, 0, null]);   // C-1 paid up to 09-20: kept at 1 and 2 months, not at 3 (10-05)
  assert.deepEqual(oct.kept, [null, null, null, null]);
  assert.equal(r.months.find(m => m.month === '2026-07').newCustomers, 2);
});

test('rateMissing carries through when a USDT cost has no rate, and the cost uses the rate when there is one', () => {
  const st = base({ sales: [sale(1, 'C-1', { Buy_Currency: 'USDT', Buy_Price_USDT: 5, Cost_Snapshot: 0 })], liveRates: [] });
  assert.equal(I(st, OCT).kpis.rateMissing, true);
  assert.equal(I(st, OCT).kpis.profit, 300);
  st.settings.usdt_bdt_manual = 120;
  const r = I(st, OCT);
  assert.equal(r.kpis.rateMissing, false);
  assert.equal(r.kpis.profit, 300 - 600);
  assert.equal(r.months.find(m => m.month === '2026-10').profit, Core.views.profitByFamily(st, '2026-10')[0].profit);
});

test('renewal rate ignores lines whose 7-day window is still open, renewed or not', () => {
  const st = base({ sales: [
    sale(1, 'C-1', { Sale_Date: '2026-09-10', Paid_Till: '2026-10-15', Sub_Code: 'X', Record_Status: 'Renewed' }),
    sale(2, 'C-1', { Sale_Date: '2026-10-14', Paid_Till: '2026-11-14', Sub_Code: 'X' }),
    sale(3, 'C-2', { Sale_Date: '2026-09-10', Paid_Till: '2026-10-15', Sub_Code: 'Y' })] });
  const r = I(st, { from: '2026-10-01', to: '2026-10-18' });
  assert.equal(r.kpis.renewalRatePct, 0);
  assert.equal(r.kpis.churnedLines, 0);
});

test('active lines count live timed lines only: not game codes, custom sales or lapsed-without-date rows', () => {
  const st = base({ sales: [sale(1, 'C-1'), sale(2, 'C-1', { Product_ID: 'CUSTOM', Paid_Till: '' }), sale(3, 'C-2', { Paid_Till: '' }),
    sale(4, 'C-2', { Product_ID: 'GC', Paid_Till: '' })] });
  const r = I(st, OCT);
  assert.equal(r.kpis.activeLines, 1);
  assert.equal(r.kpis.activeCustomers, 1);
});

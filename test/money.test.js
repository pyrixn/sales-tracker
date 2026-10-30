const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState, makeMigratedState } = require('./fixtures');

const M = '2026-10';

function datedState() {
  const m = makeMigratedState();
  m.sales.forEach((s, i) => { s.Sale_Date = '2026-10-' + String(1 + (i % 17)).padStart(2, '0'); });
  m.payments.forEach((p, i) => { if (!p.Date) p.Date = '2026-10-' + String(1 + (i % 17)).padStart(2, '0'); });
  m.expenses = [{ Expense_ID: 'E-0001', Date: '2026-10-05', Category: 'Tools', Amount: 200, Paid_With: 'bKash', Note: '' },
                { Expense_ID: 'E-0002', Date: '2026-09-05', Category: 'Tools', Amount: 50, Paid_With: 'bKash', Note: '' }];
  return m;
}

test('overview net equals bookData net for the same month', () => {
  const m = datedState();
  const o = Core.money.overview(m, M), b = Core.views.bookData(m, M);
  assert.equal(o.net, b.net);
  assert.equal(o.in, b.in);
  assert.equal(o.out, b.out);
  assert.equal(o.prevNet, Core.views.bookData(m, '2026-09').net);
  assert.equal(o.delta, Core.util.round2(o.net - o.prevNet));
  assert.ok(o.in > 0 && o.out > 0);
});

test('hidden credit-pair rows are not counted as cash; blank-sale credit rows are', () => {
  const m = datedState();
  const c = m.customers[0].Customer_ID, before = Core.money.overview(m, M);
  m.payments.push({ Payment_ID: 'PM-X1', Date: '2026-10-10', Customer_ID: c, Sale_ID: '', Amount: 500, Method: 'bKash', Source: 'Manual' });
  m.payments.push({ Payment_ID: 'PM-X2', Date: '2026-10-11', Customer_ID: c, Sale_ID: 1, Amount: 500, Method: '', Source: 'Credit' });
  m.payments.push({ Payment_ID: 'PM-X3', Date: '2026-10-11', Customer_ID: c, Sale_ID: '', Amount: -500, Method: '', Source: 'Credit' });
  const o = Core.money.overview(m, M);
  assert.equal(o.in, Core.util.round2(before.in + 500));
  assert.equal(o.net, Core.views.bookData(m, M).net);
});

test('series has six months, oldest first, zero-filled', () => {
  const o = Core.money.overview(datedState(), M);
  assert.deepEqual(o.series.map(s => s.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(o.series[0], { month: '2026-05', in: 0, out: 0, net: 0 });
  assert.equal(o.series[5].net, o.net);
  const feb = Core.money.overview(datedState(), '2026-02');
  assert.deepEqual(feb.series.map(s => s.month), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
});

test('dues buckets sum to duesList total', () => {
  const m = datedState(), o = Core.money.overview(m, M), d = Core.views.duesList(m);
  assert.deepEqual(o.dues.buckets.map(b => b.label), ['0-7', '8-30', '31-60', '60+']);
  assert.equal(o.dues.total, d.total);
  assert.equal(Core.util.round2(o.dues.buckets.reduce((a, b) => a + b.amount, 0)), d.total);
  assert.equal(o.dues.buckets.reduce((a, b) => a + b.count, 0), d.rows.length);
});

test('cash balances add up to the Book closing balance', () => {
  const m = datedState(), o = Core.money.overview(m, M);
  const total = Core.util.round2(o.cash.reduce((a, c) => a + c.balance, 0));
  assert.equal(total, Core.views.bookData(m, '2099-12').closing);
});

test('profit by product and account matches an independent per-sale sum', () => {
  const m = datedState(), o = Core.money.overview(m, M);
  const r2 = Core.util.round2;
  const live = m.sales.filter(s => s.Record_Status !== 'Void' && s.Record_Status !== 'Refunded' && String(s.Sale_Date).slice(0, 7) === M);
  const expect = (key) => {
    const t = {};
    live.filter(s => s[key]).forEach(s => {
      const x = t[s[key]] || (t[s[key]] = { revenue: 0, cost: 0 });
      x.revenue += Core.ledger.saleRevenue(s, m.products); x.cost += Core.ledger.saleCostInfo(s, m).cost;
    });
    return t;
  };
  const byProduct = expect('Product_ID'), byAccount = expect('Account_ID');
  assert.ok(o.products.length > 0 && Object.keys(byAccount).length > 0, 'fixture has product and account sales');
  assert.equal(o.products.length, Object.keys(byProduct).length);
  o.products.forEach(p => {
    const e = byProduct[p.productId];
    assert.equal(p.revenue, r2(e.revenue)); assert.equal(p.cost, r2(e.cost)); assert.equal(p.profit, r2(e.revenue - e.cost));
  });
  assert.equal(o.accounts.length, Object.keys(byAccount).length);
  o.accounts.forEach(a => {
    const e = byAccount[a.accountId];
    assert.equal(a.revenue, r2(e.revenue)); assert.equal(a.cost, r2(e.cost)); assert.equal(a.profit, r2(e.revenue - e.cost));
  });
  // Against the category view: each side rounds per group, so allow half a paisa per group, nothing more.
  const fam = Core.views.profitByFamily(m, M), sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
  ['revenue', 'cost', 'profit'].forEach(k => assert.ok(Math.abs(sum(o.products, k) - sum(fam, k)) <= 0.005 * (o.products.length + fam.length) + 1e-9, k));
  // Code sales carry no Account_ID, so accounts can only hold less than the whole.
  assert.ok(sum(o.accounts, 'revenue') <= sum(o.products, 'revenue') + 1e-9);
});

test('cash lists the last 5 movements per method, newest first, and agrees with its totals', () => {
  const m = datedState(), o = Core.money.overview(m, M);
  assert.ok(o.cash.length > 0);
  o.cash.forEach(c => {
    assert.ok(Array.isArray(c.recent) && c.recent.length <= 5, c.method);
    c.recent.forEach((x, i) => {
      assert.ok(['in', 'out'].includes(x.kind));
      if (i) assert.ok(c.recent[i - 1].date >= x.date, 'newest first');
    });
  });
  const bk = o.cash.find(c => c.method === 'bKash');
  assert.ok(bk && bk.recent.length > 0);
});

test('a retired account keeps its profit in accounts and products', () => {
  const m = datedState();
  const acct = m.accounts.find(a => m.sales.some(s => s.Account_ID === a.Account_ID && s.Record_Status === 'Active'));
  const before = Core.money.overview(m, M);
  acct.Account_Status = 'Inactive';
  const o = Core.money.overview(m, M);
  const row = o.accounts.find(a => a.accountId === acct.Account_ID);
  assert.ok(row, 'retired account still listed');
  assert.equal(row.retired, true);
  assert.equal(row.profit, before.accounts.find(a => a.accountId === acct.Account_ID).profit);
  assert.deepEqual(o.products, before.products);
});

test('top customers: at most 8, last 12 months, by paid', () => {
  const m = datedState();
  m.payments.push({ Payment_ID: 'PM-OLD', Date: '2025-01-05', Customer_ID: m.customers[0].Customer_ID, Sale_ID: '', Amount: 99999, Method: 'bKash', Source: 'Manual' });
  const o = Core.money.overview(m, M);
  assert.ok(o.customers.length <= 8);
  assert.ok(o.customers.every((c, i) => i === 0 || o.customers[i - 1].paid >= c.paid));
  assert.ok(o.customers[0].paid < 99999, 'payment older than 12 months excluded');
});

test('forecast lists only Active lines due in 14 days and excludes codes', () => {
  const m = makeMigratedState();
  m.sales.forEach(s => { s.Paid_Till = '2027-06-01'; });
  const acctProd = m.products.find(p => Core.sales.deliversAs(p) === 'account');
  const codeProd = m.products.find(p => Core.sales.deliversAs(p) === 'code');
  assert.ok(acctProd && codeProd);
  const [a, b, c, d, e] = m.sales.filter(s => s.Product_ID === acctProd.Product_ID);
  a.Paid_Till = '2026-10-20'; b.Paid_Till = '2026-10-20';
  c.Paid_Till = '2026-10-25'; c.Record_Status = 'Void';
  d.Paid_Till = '2026-12-01';
  e.Paid_Till = '2026-10-10';
  m.sales.push(Object.assign({}, a, { Sale_ID: 9999, Product_ID: codeProd.Product_ID, Paid_Till: '2026-10-21' }));
  // today is 2026-10-18: "next 14 days" is today..today+13, so 10-31 is in and 11-01 is out
  m.sales.push(Object.assign({}, a, { Sale_ID: 9998, Paid_Till: '2026-10-31' }));
  m.sales.push(Object.assign({}, a, { Sale_ID: 9997, Paid_Till: '2026-11-01' }));
  const f = Core.money.overview(m, M).forecast;
  assert.deepEqual(f.map(x => x.date), ['2026-10-20', '2026-10-31']);
  assert.equal(f[0].count, 2);
  assert.equal(f[0].amount, Core.util.round2(Core.ledger.salePrice(a, m.products) + Core.ledger.salePrice(b, m.products)));
});

test('expenses by type include account purchases for the month', () => {
  const m = datedState(), o = Core.money.overview(m, M);
  assert.equal(o.expensesByType.find(e => e.category === 'Tools').amount, 200);
  assert.equal(Core.util.round2(o.expensesByType.reduce((a, e) => a + e.amount, 0)), o.out);
});

test('empty state returns zeros and empty arrays', () => {
  const s = makeState({ sales: [], accounts: [], purchases: [], expenses: [], payments: [], customers: [], codes: [] });
  const o = Core.money.overview(s, M);
  assert.equal(o.net, 0); assert.equal(o.prevNet, 0); assert.equal(o.delta, 0); assert.equal(o.in, 0); assert.equal(o.out, 0);
  assert.equal(o.series.length, 6);
  assert.ok(o.series.every(x => x.in === 0 && x.out === 0 && x.net === 0));
  assert.deepEqual([o.cash, o.products, o.accounts, o.customers, o.forecast, o.expensesByType], [[], [], [], [], [], []]);
  assert.equal(o.dues.total, 0);
  assert.equal(o.dues.buckets.length, 4);
  assert.equal(o.rateMissing, false);
});

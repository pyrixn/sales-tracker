const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

test('profitByFamily groups sales by product category', () => {
  const m = makeMigratedState();
  const rows = Core.views.profitByFamily(m);
  assert.ok(rows.some(r => r.category === 'Subscription'));
  assert.ok(rows.every(r => typeof r.revenue === 'number' && r.revenue >= 0));
  assert.ok(rows.every(r => typeof r.profit === 'number'));
  assert.ok(rows.every(r => typeof r.marginPct === 'number'));
});

test('profitByFamily excludes Void and Refunded sales', () => {
  const m = makeMigratedState();
  const before = Core.views.profitByFamily(m);
  const sub = before.find(r => r.category === 'Subscription');
  m.sales[0].Record_Status = 'Void';
  const after = Core.views.profitByFamily(m);
  const subAfter = after.find(r => r.category === 'Subscription');
  assert.ok(subAfter.revenue < sub.revenue);
});

test('profitByFamily sorts by profit descending', () => {
  const m = makeMigratedState();
  const rows = Core.views.profitByFamily(m);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].profit >= rows[i].profit);
  }
});

test('profitByFamily lists the products of each category and they add up to it', () => {
  const rows = Core.views.profitByFamily(makeMigratedState());
  rows.forEach(r => {
    assert.ok(r.products.length > 0);
    const rev = r.products.reduce((a, p) => a + p.revenue, 0);
    assert.ok(Math.abs(rev - r.revenue) < 0.05, r.category + ' revenue adds up');
  });
});

test('panel buildTree orders exactly like Core.tree.build', async () => {
  const { buildTree } = await import('../web/src/lib/tree.js');
  const fx = [
    ['A1', 'Zeta-2', 'b cat', ''], ['A2', 'alpha 10', 'b cat', ''], ['A3', 'alpha 9', 'B cat', ''], ['A4', 'Émile', 'Ünder', ''],
    ['A5', 'zeta', 'ünder', ''], ['V1', 'v-b', 'b cat', 'A1'], ['V2', 'V-a', 'b cat', 'A1'], ['O1', 'orphan', 'b cat', 'GONE'], ['P1', '_under', '1st', '']
  ];
  const core = Core.tree.build(fx.map(f => ({ Product_ID: f[0], Product_Name: f[1], Category: f[2], Parent_ID: f[3] })));
  const web = buildTree(fx.map(f => ({ id: f[0], name: f[1], category: f[2], parentId: f[3] })));
  const flat = t => t.map(g => g.category + ':' + g.products.map(x => (x.product.Product_ID || x.product.id) + '[' + x.variants.map(v => v.Product_ID || v.id).join(',') + ']').join(','));
  assert.deepEqual(flat(web), flat(core));
});

// ---- uncollected / collectedProfit (uplift 2.4) ----
const { makeState } = require('./fixtures');
const mkSale = (id, cid, extra) => Object.assign({ Sale_ID: id, Sale_Date: '2026-10-01', Customer: 'N' + cid, Contact: '', Product_ID: 'NETFLIX',
  Account_ID: 'NFX-03', Code_ID: '', Qty: 1, Unit_Price: 300, Paid_Till: '2026-11-01', Record_Status: 'Active', Notes: '', Customer_ID: cid, Months: 1,
  Sub_Code: 'N' + id, Cost_Snapshot: 100 }, extra || {});
const mkPay = (id, cid, saleId, amount) => ({ Payment_ID: id, Date: '2026-10-02', Customer_ID: cid, Sale_ID: saleId, Amount: amount, Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' });
const mk = (sales, payments) => makeState({ customers: [{ Customer_ID: 'C-1', Name: 'One', Channel: '', Handle: '', Created: '2026-10-01' }], sales, payments, remindersLog: [] });
const fam = st => Core.views.profitByFamily(st, '2026-10')[0];

test('no dues: uncollected is 0 and collectedProfit equals profit', () => {
  const f = fam(mk([mkSale(1, 'C-1')], [mkPay('PM-1', 'C-1', 1, 300)]));
  assert.equal(f.uncollected, 0);
  assert.equal(f.collectedProfit, f.profit);
  assert.equal(f.products[0].uncollected, 0);
});

test('a part-paid line: uncollected is price minus paid and collectedProfit drops by it', () => {
  const f = fam(mk([mkSale(1, 'C-1')], [mkPay('PM-1', 'C-1', 1, 100)]));
  assert.equal(f.profit, 200);
  assert.equal(f.uncollected, 200);
  assert.equal(f.collectedProfit, 0);
  assert.equal(f.products[0].uncollected, 200);
  assert.equal(f.products[0].collectedProfit, 0);
});

test('an Ended part-paid line still counts as uncollected, and profit does not move', () => {
  const st = mk([mkSale(1, 'C-1')], [mkPay('PM-1', 'C-1', 1, 100)]);
  const before = fam(st);
  st.sales[0].Record_Status = 'Ended';
  const after = fam(st);
  assert.equal(after.uncollected, 200);
  assert.equal(after.profit, before.profit);
});

test('Void and Refunded lines are never counted as uncollected', () => {
  for (const status of ['Void', 'Refunded']) {
    const st = mk([mkSale(1, 'C-1', { Record_Status: status }), mkSale(2, 'C-1')], [mkPay('PM-1', 'C-1', 2, 300)]);
    const f = fam(st);
    assert.equal(f.uncollected, 0, status);
    assert.equal(f.revenue, 300);
  }
});

test('an overpaid line never gives a negative uncollected amount', () => {
  const f = fam(mk([mkSale(1, 'C-1')], [mkPay('PM-1', 'C-1', 1, 500)]));
  assert.equal(f.uncollected, 0);
});

test('profitTotals equals the sum of families, and every family equals the sum of its products', () => {
  const st = makeMigratedState();
  st.sales.forEach((s, i) => { s.Sale_Date = '2026-10-0' + (1 + i % 8); });
  const rows = Core.views.profitByFamily(st, '2026-10');
  const t = Core.views.profitTotals(rows);
  for (const k of ['revenue', 'cost', 'profit', 'uncollected', 'collectedProfit']) {
    assert.ok(Math.abs(t[k] - rows.reduce((a, r) => a + r[k], 0)) < 0.011, k);
  }
  assert.ok(rows.some(r => r.uncollected > 0), 'the migrated fixture has unpaid lines');
  rows.forEach(r => {
    assert.ok(Math.abs(r.uncollected - r.products.reduce((a, p) => a + p.uncollected, 0)) < 0.011);
    assert.ok(Math.abs(r.collectedProfit - (r.profit - r.uncollected)) < 0.011);
  });
});

test('the overview product and account splits carry uncollected and collectedProfit', () => {
  const st = mk([mkSale(1, 'C-1')], [mkPay('PM-1', 'C-1', 1, 100)]);
  const o = Core.money.overview(st, '2026-10');
  assert.equal(o.products[0].uncollected, 200);
  assert.equal(o.products[0].collectedProfit, 0);
  assert.equal(o.accounts[0].uncollected, 200);
  assert.equal(o.products[0].profit, fam(st).profit);
});

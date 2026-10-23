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

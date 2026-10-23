const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

test('planSupplier creates a supplier with defaults', () => {
  const state = makeState({ suppliers: [] });
  const plan = Core.sales.planSupplier(state, { name: 'Supplier A', contact: 'Telegram: @supa', currency: 'USDT', markup_percent: 5 });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].tab, 'Suppliers');
  assert.equal(plan.ops[0].values.Name, 'Supplier A');
  assert.equal(plan.ops[0].values.Currency, 'USDT');
  assert.equal(plan.ops[0].values.Markup_Percent, 5);
  assert.ok(plan.result.supplierId);
});

test('planSupplier rejects duplicate name (case-insensitive)', () => {
  const state = makeState({ suppliers: [{ Supplier_ID: 'SUP-0001', Name: 'Supplier A', Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '' }] });
  const plan = Core.sales.planSupplier(state, { name: 'supplier a', contact: 'x', currency: 'BDT', markup_percent: 0 });
  assert.ok(plan.errors.length > 0);
  assert.match(plan.errors[0], /already exists/);
});

test('planSupplier rejects empty name and defaults currency to BDT', () => {
  const state = makeState({ suppliers: [] });
  const bad = Core.sales.planSupplier(state, { name: '  ' });
  assert.ok(bad.errors.length > 0);
  const plan = Core.sales.planSupplier(state, { name: 'B', currency: 'INVALID' });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.ops[0].values.Currency, 'BDT');
});

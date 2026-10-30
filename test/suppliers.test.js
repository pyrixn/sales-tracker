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

test('contact channel is validated on create and edit', () => {
  const state = makeState({ suppliers: [{ Supplier_ID: 'SUP-0001', Name: 'A', Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '', Contact_Channel: '' }] });
  const ok = Core.sales.planSupplier(state, { name: 'B', contactChannel: 'Telegram' });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.ops[0].values.Contact_Channel, 'Telegram');
  assert.equal(Core.sales.planSupplier(state, { name: 'C' }).ops[0].values.Contact_Channel, '');
  assert.match(Core.sales.planSupplier(state, { name: 'D', contactChannel: 'Fax' }).errors[0], /channel/i);
  const ed = Core.sales.planSupplierEdit(state, { supplierId: 'SUP-0001', contactChannel: 'WhatsApp' });
  assert.equal(ed.ops[0].values.Contact_Channel, 'WhatsApp');
  assert.equal(Core.sales.planSupplierEdit(state, { supplierId: 'SUP-0001', contactChannel: '' }).errors.length, 0);
  assert.match(Core.sales.planSupplierEdit(state, { supplierId: 'SUP-0001', contactChannel: 'Pigeon' }).errors[0], /channel/i);
});

test('lookups list each supplier with its channel and products', () => {
  const state = makeState({ suppliers: [{ Supplier_ID: 'SUP-0001', Name: 'A', Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '', Contact_Channel: 'Email' },
                                        { Supplier_ID: 'SUP-0002', Name: 'B', Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '' }] });
  state.products = (state.products || []).slice(0, 2).map((p, i) => Object.assign({}, p, { Supplier_ID: i === 0 ? 'SUP-0001' : '' }));
  const l = Core.views.lookups(state);
  const a = l.suppliers.find(s => s.id === 'SUP-0001'), b = l.suppliers.find(s => s.id === 'SUP-0002');
  assert.equal(a.contactChannel, 'Email');
  assert.deepEqual(a.products, [{ id: state.products[0].Product_ID, name: state.products[0].Product_Name }]);
  assert.equal(b.contactChannel, '');
  assert.deepEqual(b.products, []);
});

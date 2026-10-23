const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

const S = () => Core.sales;
const sup = (id, name) => ({ Supplier_ID: id, Name: name, Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '' });
const code = (id, batch, status, tag) => ({ Code_ID: id, Product_ID: 'STEAM', Code: status === 'Sold' ? 'AAAA' : '', 'Source / Batch': tag || batch, Date_Added: '2026-10-18', Manual_Flag: '', Status: status, Batch_ID: batch });

test('planAddCodesBatch sets Batch_ID as well as the tag', () => {
  const state = makeState({ products: [{ Product_ID: 'STEAM', Category: 'Gift_Card' }], codes: [] });
  const plan = S().planAddCodesBatch(state, { productId: 'STEAM', quantity: 2, batchId: 'B-1' });
  assert.deepEqual(plan.errors, []);
  plan.ops.forEach(o => { assert.equal(o.values.Batch_ID, 'B-1'); assert.equal(o.values['Source / Batch'], 'B-1'); });
});

test('planSupplierEdit updates only given fields', () => {
  const state = makeState({ suppliers: [sup('SUP-0001', 'A'), sup('SUP-0002', 'B')] });
  const plan = S().planSupplierEdit(state, { supplierId: 'SUP-0001', name: 'A2', currency: 'USDT', markupPercent: 7.5 });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0], { op: 'update', tab: 'Suppliers', id: 'SUP-0001', values: { Name: 'A2', Currency: 'USDT', Markup_Percent: 7.5 } });
});

test('planSupplierEdit rejects unknown id, empty name, duplicate (not self), bad currency', () => {
  const state = makeState({ suppliers: [sup('SUP-0001', 'A'), sup('SUP-0002', 'B')] });
  assert.match(S().planSupplierEdit(state, { supplierId: 'NOPE', name: 'x' }).errors[0], /Unknown supplier/);
  assert.match(S().planSupplierEdit(state, { supplierId: 'SUP-0001', name: '  ' }).errors[0], /name/i);
  assert.match(S().planSupplierEdit(state, { supplierId: 'SUP-0001', name: 'b' }).errors[0], /already exists/);
  assert.deepEqual(S().planSupplierEdit(state, { supplierId: 'SUP-0001', name: 'a' }).errors, []);
  assert.match(S().planSupplierEdit(state, { supplierId: 'SUP-0001', currency: 'EUR' }).errors[0], /USDT or BDT/);
  assert.match(S().planSupplierEdit(state, { supplierId: 'SUP-0001', markupPercent: -1 }).errors[0], /markup/i);
});

test('planSupplierDelete is blocked while products use the supplier', () => {
  const state = makeState({ suppliers: [sup('SUP-0001', 'A')], products: [{ Product_ID: 'P1', Supplier_ID: 'SUP-0001' }, { Product_ID: 'P2', Supplier_ID: 'SUP-0001' }] });
  const plan = S().planSupplierDelete(state, { supplierId: 'SUP-0001' });
  assert.match(plan.errors[0], /2 products/);
  const free = makeState({ suppliers: [sup('SUP-0001', 'A')], products: [{ Product_ID: 'P1', Supplier_ID: '' }] });
  const ok = S().planSupplierDelete(free, { supplierId: 'SUP-0001' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ops, [{ op: 'clear', tab: 'Suppliers', id: 'SUP-0001' }]);
  assert.match(S().planSupplierDelete(free, { supplierId: 'NOPE' }).errors[0], /Unknown supplier/);
});

test('planBatchEdit retags only codes with that Batch_ID', () => {
  const state = makeState({ codes: [code('C-1', 'B-1', 'Pending'), code('C-2', 'B-1', 'Sold'), code('C-3', 'B-2', 'Pending'), code('C-4', '', 'Available', 'B-1')] });
  const plan = S().planBatchEdit(state, { batchId: 'B-1', tag: 'Steam Oct' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops.map(o => o.id), ['C-1', 'C-2']);
  plan.ops.forEach(o => assert.deepEqual(o.values, { 'Source / Batch': 'Steam Oct' }));
  assert.match(S().planBatchEdit(state, { batchId: 'NOPE', tag: 'x' }).errors[0], /Unknown batch/);
  assert.match(S().planBatchEdit(state, { batchId: 'B-1', tag: ' ' }).errors[0], /tag/i);
});

test('planBatchDelete removes the batch codes, blocked if any are Sold, legacy codes untouched', () => {
  const state = makeState({ codes: [code('C-1', 'B-1', 'Pending'), code('C-2', 'B-1', 'Sold'), code('C-3', 'B-2', 'Pending'), code('C-4', '', 'Available', 'B-1')] });
  assert.match(S().planBatchDelete(state, { batchId: 'B-1' }).errors[0], /1 .*sold/i);
  const plan = S().planBatchDelete(state, { batchId: 'B-2' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'clear', tab: 'Code_Inventory', id: 'C-3' }]);
  assert.match(S().planBatchDelete(state, { batchId: '' }).errors[0], /Unknown batch/);
});

const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

test('edge: add, edit, delete supplier and batch round-trip through the db', async () => {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const edge = loadEdge(db);
  const a = await edge.api('addSupplier', { name: 'Edge Sup', currency: 'BDT' });
  assert.equal(a.ok, true, a.error);
  const id = a.data.supplierId;
  const e = await edge.api('editSupplier', { supplierId: id, name: 'Edge Sup 2', markupPercent: 3 });
  assert.equal(e.ok, true, e.error);
  assert.equal(tables.suppliers.get(id).name, 'Edge Sup 2');
  const d = await edge.api('deleteSupplier', { supplierId: id });
  assert.equal(d.ok, true, d.error);
  assert.equal(tables.suppliers.has(id), false);

  const prod = makeUiState().products[0].Product_ID;
  const b = await edge.api('addCodesBatch', { productId: prod, quantity: 2, batchId: 'EB-1' });
  assert.equal(b.ok, true, b.error);
  assert.equal((await edge.api('editBatch', { batchId: 'EB-1', tag: 'Tagged' })).ok, true);
  const left = [...tables.codes.values()].filter(c => c.batch_id === 'EB-1');
  assert.equal(left.length, 2);
  left.forEach(c => assert.equal(c.source_batch, 'Tagged'));
  assert.equal((await edge.api('deleteBatch', { batchId: 'EB-1' })).ok, true);
  assert.equal([...tables.codes.values()].filter(c => c.batch_id === 'EB-1').length, 0);
});

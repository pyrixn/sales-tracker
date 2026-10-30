const test = require('node:test');
const assert = require('node:assert');
const Undo = require('../src/core/undo.js');

const batch = {
  batchId: 'B1',
  lines: [
    { Tab: 'Suppliers', Row_Key: 'SUP-1', Field: '(deleted row)', Old: '', New: '', Action: 'deleteSupplier' },
    { Tab: 'Suppliers', Row_Key: 'SUP-1', Field: 'Name', Old: 'Acme', New: '', Action: 'deleteSupplier' },
    { Tab: 'Suppliers', Row_Key: 'SUP-1', Field: 'Markup_Percent', Old: '12', New: '', Action: 'deleteSupplier' },
    { Tab: 'Suppliers', Row_Key: 'SUP-1', Field: 'Notes', Old: '', New: '', Action: 'deleteSupplier' }
  ]
};

test('planUndo restores a deleted row from its old values', () => {
  const plan = Undo.planUndo(batch, () => undefined);
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.ops.length, 1);
  assert.deepStrictEqual(plan.ops[0], {
    op: 'append', tab: 'Suppliers',
    values: { Supplier_ID: 'SUP-1', Name: 'Acme', Markup_Percent: '12', Notes: '' }
  });
});

test('undo of a delete is refused when a row with that key exists again', () => {
  const plan = Undo.planUndo(batch, (tab, id, field) => (field === 'Supplier_ID' ? 'SUP-1' : 'x'));
  assert.strictEqual(plan.ops.length, 0);
  assert.match(plan.errors[0], /Suppliers SUP-1 was changed after that action/);
});

test('(new row) undo still clears the row', () => {
  const b = { batchId: 'B2', lines: [{ Tab: 'Payments', Row_Key: 'P1', Field: '(new row)', Old: '', New: '', Action: 'pay' }] };
  const plan = Undo.planUndo(b, () => undefined);
  assert.deepStrictEqual(plan.ops, [{ op: 'clear', tab: 'Payments', key: 'Payment_ID', id: 'P1' }]);
});

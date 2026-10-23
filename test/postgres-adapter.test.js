const test = require('node:test');
const assert = require('node:assert/strict');
const Adapter = require('../src/adapters/postgres.js');
const { makeFakeDb } = require('./support/fake-db');

test('Postgres adapter: readState shape', async () => {
  const { db } = makeFakeDb();
  const st = await Adapter.readState(db, '2026-10-21');
  assert.equal(st.today, '2026-10-21');
  assert.equal(st.settings.bkash_number, '01711111111');
  assert.equal(st.settings.reminder_days_before, 3);
  assert.equal(st.accounts.length, 1);
  assert.equal(st.accounts[0].Cost_Per_Slot, 400);
});

test('Postgres adapter: append, update, clear, change_log', async () => {
  const { db, tables } = makeFakeDb();
  await Adapter.applyOps(db, [
    { op: 'append', tab: 'Customers', values: { Customer_ID: 'CU-0001', Name: 'Alice', Channel: 'WhatsApp', Handle: '01700000001', Created: '2026-10-21' } }
  ], { batchId: 'b1', action: 'newCustomer' });
  assert.equal(tables.customers.size, 1);
  assert.equal(tables.customers.get('CU-0001').name, 'Alice');

  await Adapter.applyOps(db, [
    { op: 'update', tab: 'Customers', id: 'CU-0001', values: { Name: 'Alice Updated' } }
  ], { batchId: 'b2', action: 'editCust' });
  assert.equal(tables.customers.get('CU-0001').name, 'Alice Updated');

  assert.equal(tables.change_log.length, 2);

  await Adapter.applyOps(db, [
    { op: 'clear', tab: 'Customers', id: 'CU-0001' }
  ], { batchId: 'b3', action: 'undo' });
  assert.equal(tables.customers.size, 0);
});

test('Postgres adapter: readLastBatch finds the newest batch that was not undone', async () => {
  const { db } = makeFakeDb();
  await Adapter.applyOps(db, [{ op: 'append', tab: 'Customers', values: { Customer_ID: 'CU-0002', Name: 'farid', Channel: 'WhatsApp', Handle: '01711111111' } }],
    { batchId: 'b0', action: 'seed' });
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: 'CU-0002', values: { Channel: 'Discord' } }], { batchId: 'b7', action: 'edit' });
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: 'CU-0002', values: { Handle: 'farid#1' } }], { batchId: 'b8', action: 'edit' });
  let last = await Adapter.readLastBatch(db);
  assert.equal(last.batchId, 'b8');
  assert.deepEqual(last.lines, [{ Batch_ID: 'b8', Action: 'edit', Tab: 'Customers', Row_Key: 'CU-0002', Field: 'Handle', Old: '01711111111', New: 'farid#1' }]);
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: 'CU-0002', values: { Handle: '01711111111' } }], { batchId: 'u1', action: 'undo:b8' });
  last = await Adapter.readLastBatch(db);
  assert.equal(last.batchId, 'b7');
});

test('Postgres adapter: log:false writes no change_log line; skipAuto ignores automatic batches', async () => {
  const { db, tables } = makeFakeDb();
  await Adapter.applyOps(db, [{ op: 'append', tab: 'Customers', values: { Customer_ID: 'CU-0002', Name: 'farid' } }], { batchId: 'r1', action: 'remindSent', log: false });
  assert.equal(tables.change_log.length, 0);
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: 'CU-0002', values: { Channel: 'Discord' } }], { batchId: 'b1', action: 'edit' });
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: 'CU-0002', values: { Notes: 'auto' } }], { batchId: 'a1', action: 'auto-match' });
  assert.equal((await Adapter.readLastBatch(db)).batchId, 'a1');
  assert.equal((await Adapter.readLastBatch(db, { skipAuto: true })).batchId, 'b1');
  assert.equal(await Adapter.readLastBatch(makeFakeDb().db), null);
});

test('Postgres adapter: every changed cell is written to change_log under one batch id', async () => {
  const { db, tables } = makeFakeDb();
  await Adapter.applyOps(db, [{ op: 'append', tab: 'Sales_Log', values: { Sale_ID: 44, Customer: 'Farid', Product_ID: 'NETFLIX', Record_Status: 'Active', Paid_Till: '2026-12-12' } }],
    { batchId: 'b0', action: 'seed', log: false });
  const out = await Adapter.applyOps(db, [{ op: 'update', tab: 'Sales_Log', id: 44, values: { Record_Status: 'Renewed', Paid_Till: '2027-01-12' } }],
    { batchId: 'b6', action: 'renew' });
  assert.equal(out.changes, 1, 'counts operations; change_log has one line per cell');
  assert.deepEqual(tables.change_log.map(r => [r.batch_id, r.action, r.tab, r.row_key, r.field, r.old, r.new]), [
    ['b6', 'renew', 'Sales_Log', '44', 'Record_Status', 'Active', 'Renewed'],
    ['b6', 'renew', 'Sales_Log', '44', 'Paid_Till', '2026-12-12', '2027-01-12']]);
});

test('Postgres adapter: a missing row or unknown field is refused', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(Adapter.applyOps(db, [{ op: 'update', tab: 'Sales_Log', id: 999, values: { Notes: 'x' } }], { batchId: 'b4', action: 'x' }),
    /Not found: Sales_Log 999/);
  await assert.rejects(Adapter.applyOps(db, [{ op: 'clear', tab: 'Sales_Log', id: 999 }], { batchId: 'b4', action: 'x' }),
    /Not found: Sales_Log 999/);
  await assert.rejects(Adapter.applyOps(db, [{ op: 'append', tab: 'Sales_Log', values: { Revenue: 1 } }], { batchId: 'b5', action: 'x' }),
    /Unknown field Sales_Log\.Revenue/);
});

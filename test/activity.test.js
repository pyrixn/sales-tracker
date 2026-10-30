// Core.views.activityBatches and the bounded Change_Log read behind the Activity and Undo screen (uplift plan 4.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeFakeDb } = require('./support/fake-db');
const Adapter = require('../src/adapters/postgres.js');

// One batch as Change_Log lines in the capitalised shape Adapter.readRecentChangeLog returns. changes: [tab, rowKey, field].
const batch = (id, action, time, changes) => changes.map(c => ({ Time: time, Batch_ID: id, Action: action, Tab: c[0], Row_Key: c[1], Field: c[2], Old: '', New: '' }));
// The lines of batches given oldest first, newest first as the read returns them.
const newestFirst = batches => batches.slice().reverse().reduce((acc, b) => acc.concat(b.slice().reverse()), []);
const T = i => new Date(Date.UTC(2026, 9, 1) + i * 3600e3).toISOString();

test('batches come newest first, with a plain label, the rows they touched and the fields that changed', () => {
  const log = newestFirst([
    batch('B-1', 'newSale', T(1), [['Sales_Log', '9101', '(new row)'], ['Payments', 'PM-1', '(new row)']]),
    batch('B-2', 'editPayment', T(2), [['Payments', 'PM-1', 'Amount'], ['Payments', 'PM-1', 'Note']]),
    batch('B-3', 'undo:B-2', T(3), [['Payments', 'PM-1', 'Amount'], ['Payments', 'PM-1', 'Note']]),
    batch('B-4', 'autoMatch', T(4), [['Payment_Inbox', 'AUTOTRXA', 'Status']]),
    batch('B-5', 'pay', T(5), [['Payments', 'PM-2', '(new row)']])
  ]);
  const { batches } = Core.views.activityBatches(log);
  assert.deepEqual(batches.map(b => b.batchId), ['B-5', 'B-4', 'B-3', 'B-2', 'B-1']);
  assert.deepEqual(batches[0], { batchId: 'B-5', at: T(5), action: 'Got paid', summary: 'Payment PM-2', rows: 1, undone: false,
    undoable: true, automatic: false, reversal: false });
  assert.equal(batches[1].action, 'Automatic match');
  assert.equal(batches[1].automatic, true);
  assert.equal(batches[1].undoable, false, 'an automatic batch is never the one Undo reverses');
  assert.equal(batches[1].summary, 'Message AUTOTRXA (status)');
  assert.equal(batches[2].action, 'Undo');
  assert.equal(batches[2].reversal, true);
  assert.equal(batches[2].summary, 'Reversed: Payment edited', 'the reversal names what it undid');
  assert.equal(batches[3].undone, true, 'B-2 has an Undo after it');
  assert.equal(batches[3].rows, 1, 'two fields on one row are one row');
  assert.equal(batches[3].summary, 'Payment PM-1 (amount, note)', 'fields are listed in words');
  assert.equal(batches[4].rows, 2);
  assert.equal(batches[4].summary, 'Sale 9101 · Payment PM-1', 'new rows name their table and key, not their fields');
  assert.equal(batches[4].undone, false);
  assert.equal(batches[4].undoable, false, 'only the newest reversible batch is undoable');
});

test('after an Undo, the next older batch is the one Undo would reverse', () => {
  const log = newestFirst([
    batch('B-1', 'renew', T(1), [['Sales_Log', '9101', 'Paid_Till']]),
    batch('B-2', 'editPayment', T(2), [['Payments', 'PM-1', 'Amount']]),
    batch('B-3', 'undo:B-2', T(3), [['Payments', 'PM-1', 'Amount']])
  ]);
  const { batches } = Core.views.activityBatches(log);
  assert.deepEqual(batches.map(b => [b.batchId, b.undoable, b.undone]), [['B-3', false, false], ['B-2', false, true], ['B-1', true, false]]);
});

test('a line with no batch id is not a batch, and an empty log has no batches and no undoable one', () => {
  const log = newestFirst([batch('B-1', 'settings', T(1), [['Settings', 'bkash_number', 'Value']])]).concat([
    { Time: T(9), Batch_ID: '', Action: 'stray', Tab: 'Payments', Row_Key: 'PM-9', Field: 'Amount', Old: '', New: '' }]);
  const res = Core.views.activityBatches(log);
  assert.deepEqual(res.batches.map(b => b.batchId), ['B-1']);
  assert.equal(res.batches[0].action, 'Settings saved', 'a known action has its owner label');
  assert.deepEqual(Core.views.activityBatches([]), { batches: [] });
});

test('an action this list does not know reads as words, so a new write still shows', () => {
  const res = Core.views.activityBatches(batch('B-1', 'editWidgetLayout', T(1), [['Settings', 'money_layout', 'Value']]));
  assert.equal(res.batches[0].action, 'Edit widget layout');
  assert.equal(res.batches[0].summary, 'Setting money_layout (value)');
});

test('the list holds at most 100 batches, newest first; limit picks fewer, and a bad limit is refused', () => {
  const batches = [];
  for (let i = 1; i <= 150; i++) batches.push(batch('B-' + i, 'editPayment', T(i), [['Payments', 'PM-' + i, 'Amount'], ['Payments', 'PM-' + i, 'Note']]));
  const log = newestFirst(batches);
  const all = Core.views.activityBatches(log).batches;
  assert.equal(all.length, 100, 'the 100-batch bound');
  assert.equal(all[0].batchId, 'B-150');
  assert.equal(all[99].batchId, 'B-51');
  assert.equal(Core.views.activityBatches(log, { limit: 5 }).batches.length, 5);
  assert.equal(Core.views.activityBatches(log, { limit: '7' }).batches.length, 7, 'a limit given as text is read as a number');
  const refused = limit => assert.throws(() => Core.views.activityBatches(log, { limit: limit }), /Limit must be a whole number from 1 to 100\./);
  refused(0); refused(101); refused(2.5); refused('many');
});

test('a full read that stopped inside its oldest batch leaves that batch out, so no batch shows missing rows', () => {
  const batches = [];
  for (let i = 1; i <= 60; i++) batches.push(batch('B-' + i, 'pay', T(i), [['Payments', 'PM-' + i, '(new row)'], ['Sales_Log', 'S-' + i, '(new row)']]));
  const log = newestFirst(batches);
  assert.equal(Core.views.activityBatches(log, { truncated: false }).batches.length, 60);
  const cut = Core.views.activityBatches(log, { truncated: true }).batches;
  assert.equal(cut.length, 59);
  assert.equal(cut.some(b => b.batchId === 'B-1'), false, 'the oldest batch may be partial, so it is dropped');
});

test('readRecentChangeLog reads only the newest rows: 1500 of 3000 come back, newest first, with ISO times', async () => {
  const { db, tables } = makeFakeDb();
  for (let i = 1; i <= 3000; i++) {
    tables.change_log.push({ id: i, time: new Date(Date.UTC(2026, 0, 1) + i * 1000), batch_id: 'B' + i, action: 'edit', tab: 'Payments',
      row_key: 'PM-' + i, field: 'Amount', old: '', new: '' });
  }
  db.resetStats();
  const lines = await Adapter.readRecentChangeLog(db, 1500);
  assert.equal(db.stats.statements, 1, 'one statement');
  assert.equal(db.stats.rows, 1500, 'the database returns the window, not the whole log');
  assert.equal(lines.length, 1500);
  assert.equal(lines[0].Batch_ID, 'B3000');
  assert.equal(lines[1499].Batch_ID, 'B1501');
  assert.equal(lines[0].Time, new Date(Date.UTC(2026, 0, 1) + 3000 * 1000).toISOString(), 'a timestamp comes back as ISO text');
  assert.equal(lines[0].Row_Key, 'PM-3000');
});

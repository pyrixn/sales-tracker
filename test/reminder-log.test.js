// Core.views.reminderLog (uplift plan 4.2): the Reminders screen's Sent and Skipped lists, bounded to 60 days.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

const TODAY = '2026-10-18';

// A state with the migrated fixture's first two sales (imran, sadia) and the given Reminders_Log rows.
function stateWith(log, extra) {
  const m = makeMigratedState();
  m.today = TODAY;
  m.remindersLog = log;
  return Object.assign(m, extra || {});
}
const entry = (saleId, customerId, o) => Object.assign({ Date: TODAY, Sale_ID: saleId, Customer_ID: customerId, Kind: 'on_day', Channel: 'WhatsApp', Status: 'sent' }, o);

test('reminderLog window: sent and skipped rows within 60 days, newest first, queued and older rows out', () => {
  const m = stateWith([
    entry(1, 'CU-0001', { Date: '2026-10-10', Kind: 'before', Status: 'sent' }),
    entry(2, 'CU-0002', { Date: TODAY, Kind: 'on_day', Status: 'skipped', Channel: '' }),
    entry(1, 'CU-0001', { Date: '2026-08-19', Kind: 'after', Status: 'sent' }),   // exactly 60 days back: in
    entry(2, 'CU-0002', { Date: '2026-08-18', Kind: 'after', Status: 'sent' }),   // 61 days back: out
    entry(2, 'CU-0002', { Date: TODAY, Kind: 'due', Status: 'queued' })           // never sent or skipped: out
  ]);
  const res = Core.views.reminderLog(m);
  assert.deepEqual(res.rows.map(r => [r.date, r.saleId, r.status]), [[TODAY, 2, 'skipped'], ['2026-10-10', 1, 'sent'], ['2026-08-19', 1, 'sent']]);
  assert.deepEqual(res.counts, { sent: 2, skipped: 1 });
  assert.equal(res.matching, 3);
  assert.equal(res.truncated, false);
  assert.equal(res.status, 'all');
  assert.equal(res.rows[0].channel, '', 'a blank channel stays blank');
});

test('reminderLog names the customer and the product, and a custom sale shows its note', () => {
  const m = stateWith([entry(1, 'CU-0001'), entry(2, 'CU-0002', { Kind: 'due' })]);
  m.sales[1] = Object.assign({}, m.sales[1], { Product_ID: 'CUSTOM', Notes: 'Tinder Premium', Sub_Code: '' });
  const rows = Core.views.reminderLog(m).rows;
  const first = rows.find(r => r.saleId === 1), second = rows.find(r => r.saleId === 2);
  assert.equal(first.name, 'imran');
  assert.equal(first.productName, m.products.find(p => p.Product_ID === m.sales[0].Product_ID).Product_Name);
  assert.equal(first.subCode, m.sales[0].Sub_Code);
  assert.equal(second.productName, 'Tinder Premium');
  assert.equal(second.kind, 'due');
  assert.equal(second.customerId, 'CU-0002');
});

test('reminderLog status filter narrows the rows, and the counts stay the whole window', () => {
  const m = stateWith([entry(1, 'CU-0001'), entry(2, 'CU-0002', { Status: 'skipped' }), entry(1, 'CU-0001', { Date: '2026-09-01', Status: 'skipped' })]);
  const sent = Core.views.reminderLog(m, { status: 'sent' });
  assert.deepEqual(sent.rows.map(r => r.status), ['sent']);
  assert.deepEqual(sent.counts, { sent: 1, skipped: 2 }, 'a chip shows the window, not the filter');
  assert.equal(sent.status, 'sent');
  const skipped = Core.views.reminderLog(m, { status: 'skipped' });
  assert.deepEqual(skipped.rows.map(r => [r.saleId, r.date]), [[2, TODAY], [1, '2026-09-01']]);
  assert.equal(Core.views.reminderLog(m, { status: 'all' }).matching, 3);
});

test('reminderLog days: a shorter window moves the cut-off; a bad days value or status is refused', () => {
  const m = stateWith([entry(1, 'CU-0001', { Date: '2026-09-25' }), entry(2, 'CU-0002', { Date: '2026-10-10' })]);
  assert.equal(Core.views.reminderLog(m, { days: 30 }).matching, 2, 'the row from 23 days back is inside a 30-day window');
  assert.deepEqual(Core.views.reminderLog(m, { days: 10 }).rows.map(r => r.saleId), [2], 'a 10-day window keeps only the row from 8 days back');
  assert.equal(Core.views.reminderLog(m, { days: '60' }).matching, 2, 'days may come as text');
  assert.throws(() => Core.views.reminderLog(m, { days: 61 }), /Days must be a whole number from 1 to 60\./);
  assert.throws(() => Core.views.reminderLog(m, { days: 0 }), /Days must be a whole number from 1 to 60\./);
  assert.throws(() => Core.views.reminderLog(m, { days: 2.5 }), /Days must be a whole number from 1 to 60\./);
  assert.throws(() => Core.views.reminderLog(m, { status: 'queued' }), /Unknown reminder status queued\./);
});

test('reminderLog cuts a long list at 300 rows and says so', () => {
  const log = [];
  for (let i = 0; i < 305; i++) log.push(entry(1, 'CU-0001', { Date: '2026-10-01', Status: i % 2 ? 'sent' : 'skipped' }));
  const res = Core.views.reminderLog(stateWith(log));
  assert.equal(res.rows.length, 300);
  assert.equal(res.truncated, true);
  assert.equal(res.matching, 305);
  assert.deepEqual(res.counts, { sent: 152, skipped: 153 });
});

test('a custom sale with a balance never gets a reminder in the plan', () => {
  const m = makeMigratedState();
  m.today = TODAY;
  const maxId = Math.max(...m.sales.map(s => Number(s.Sale_ID)));
  const base = m.sales.find(s => s.Customer_ID === 'CU-0001');
  m.sales.push(Object.assign({}, base, { Sale_ID: maxId + 1, Product_ID: 'CUSTOM', Notes: 'Tinder Premium', Unit_Price: 600, Months: 1, Paid_Till: '', Sub_Code: '', Pay_Token: '' }));
  const planned = Core.reminders.planReminders(m).filter(r => r.saleId === maxId + 1);
  assert.deepEqual(planned, [], 'custom sales never auto-remind (owner decision 2026-10-26)');
  assert.ok(Core.views.duesList(m).rows.some(r => r.saleId === maxId + 1 && r.custom === true && r.amount === 600), 'it is still owed in Dues');
});

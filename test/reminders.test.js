const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');

test('renderTemplate fills every placeholder', () => {
  assert.equal(Core.reminders.renderTemplate('Hi {name}, send {price} to {bkash} ref {ref} by {date} for {product}',
    { name: 'Farid', price: '৳290', bkash: '01700000000', ref: 'N44', date: '2026-12-12', product: 'Netflix' }),
    'Hi Farid, send ৳290 to 01700000000 ref N44 by 2026-12-12 for Netflix');
});

test('waLink and messengerLink', () => {
  assert.equal(Core.reminders.waLink('01711111111', 'hi'), 'https://wa.me/8801711111111?text=hi');
  assert.equal(Core.reminders.waLink('+880 1711-111111', 'a b'), 'https://wa.me/8801711111111?text=a%20b');
  assert.equal(Core.reminders.waLink('', 'x'), '');
  assert.equal(Core.reminders.messengerLink('farid.k'), 'https://m.me/farid.k');
  assert.equal(Core.reminders.messengerLink('https://facebook.com/farid.k'), 'https://m.me/farid.k');
});

test('planReminders: renewal and due reminders with ready messages', () => {
  const m = makeMigratedState();
  const nas = m.customers.find(c => c.Name === 'jamilhq');
  nas.Channel = 'WhatsApp'; nas.Handle = '01711111111';
  const items = Core.reminders.planReminders(m);
  const n = items.find(i => i.customerId === nas.Customer_ID);
  assert.equal(n.kind, 'before');
  assert.equal(n.message, 'Hi jamilhq, your Spotify Premium Family slot ends on 2026-10-19. To renew for 1 month, send ৳100 by bKash Send Money to 01700000000 with Reference S73. Thanks!');
  assert.ok(n.link.startsWith('https://wa.me/8801711111111?text=Hi%20jamilhq'));
  const tariq = items.find(i => i.customerId === cid(m, 'tariq') && i.kind === 'due');
  assert.match(tariq.message, /৳300 is still due for Netflix Premium profile/);
  assert.ok(!items.some(i => /^Unlogged payment/.test(i.name)), 'placeholders are never reminded');
  assert.ok(items.some(i => i.saleId === 46 && i.kind === 'after') === false, 'tariq expired 14 days ago: past the after-window');
});

test('a reminder already sent is not offered again; due repeats after N days', () => {
  const m = makeMigratedState();
  const first = Core.reminders.planReminders(m);
  const nas = first.find(i => i.name === 'jamilhq');
  m.remindersLog.push({ Date: '2026-10-18', Sale_ID: nas.saleId, Customer_ID: nas.customerId, Kind: 'before', Channel: '', Status: 'sent' });
  m.remindersLog.push({ Date: '2026-10-15', Sale_ID: 54, Customer_ID: cid(m, 'Kabir'), Kind: 'due', Channel: '', Status: 'sent' });
  m.remindersLog.push({ Date: '2026-10-12', Sale_ID: 46, Customer_ID: cid(m, 'tariq'), Kind: 'due', Channel: '', Status: 'sent' });
  const again = Core.reminders.planReminders(m);
  assert.ok(!again.some(i => i.saleId === nas.saleId && i.kind === 'before'));
  assert.ok(!again.some(i => i.saleId === 54 && i.kind === 'due'), 'sent 3 days ago');
  assert.ok(again.some(i => i.saleId === 46 && i.kind === 'due'), 'sent 6 days ago, every 5 days');
});

test('Bangla messages when language is bn', () => {
  const m = makeMigratedState();
  m.settings.language = 'bn';
  const n = Core.reminders.planReminders(m).find(i => i.name === 'jamilhq');
  assert.match(n.message, /^হাই jamilhq/);
});

test('due reminder repeats every 14 days by default', () => {
  const m = makeMigratedState();
  m.settings.due_reminder_every_days = 14;
  m.remindersLog.push({ Date: '2026-10-04', Sale_ID: 46, Customer_ID: cid(m, 'tariq'), Kind: 'due', Channel: '', Status: 'sent' });
  const items = Core.reminders.planReminders(m);
  assert.ok(items.some(i => i.saleId === 46 && i.kind === 'due'), 'sent 14 days ago, eligible again');
});

test('due reminder repeat gap falls back to 5 days when the setting is missing', () => {
  const m4 = makeMigratedState();
  delete m4.settings.due_reminder_every_days;
  m4.remindersLog.push({ Date: '2026-10-14', Sale_ID: 46, Customer_ID: cid(m4, 'tariq'), Kind: 'due', Channel: '', Status: 'sent' });
  assert.ok(!Core.reminders.planReminders(m4).some(i => i.saleId === 46 && i.kind === 'due'), 'sent 4 days ago, not yet');
  const m5 = makeMigratedState();
  delete m5.settings.due_reminder_every_days;
  m5.remindersLog.push({ Date: '2026-10-13', Sale_ID: 46, Customer_ID: cid(m5, 'tariq'), Kind: 'due', Channel: '', Status: 'sent' });
  assert.ok(Core.reminders.planReminders(m5).some(i => i.saleId === 46 && i.kind === 'due'), 'sent 5 days ago, eligible again');
});

test('product-specific template overrides global', () => {
  const m = makeMigratedState();
  m.settings['msg_renew_NETFLIX_en'] = 'Netflix renewal: {name}, pay {price}';
  const items = Core.reminders.planReminders(m);
  const nfx = items.find(i => i.productName === 'Netflix Premium profile' && i.kind === 'before');
  assert.match(nfx.message, /^Netflix renewal:/);
});

test('toCsv quotes commas, quotes and new lines', () => {
  assert.equal(Core.exporter.toCsv([{ a: 'x,"y"', b: 1 }, { a: 'line\nbreak', b: '' }], ['a', 'b']),
    'a,b\r\n"x,""y""",1\r\n"line\nbreak",');
});

test('planUndo reverses a batch only when nothing changed since', () => {
  const batch = { batchId: 'b1', lines: [
    { Tab: 'Sales_Log', Row_Key: 44, Field: 'Record_Status', Old: 'Active', New: 'Renewed', Action: 'renew' },
    { Tab: 'Sales_Log', Row_Key: 103, Field: '(new row)', Old: '', New: '', Action: 'renew' },
    { Tab: 'Payments', Row_Key: 'PM-00091', Field: '(new row)', Old: '', New: '', Action: 'renew' }] };
  const cur = { 'Sales_Log|44|Record_Status': 'Renewed' };
  const get = (tab, id, f) => cur[tab + '|' + id + '|' + f];
  const r = Core.undo.planUndo(batch, get);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.ops, [
    { op: 'clear', tab: 'Payments', key: 'Payment_ID', id: 'PM-00091' },
    { op: 'clear', tab: 'Sales_Log', key: 'Sale_ID', id: 103 },
    { op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: 44, values: { Record_Status: 'Active' } }]);
  cur['Sales_Log|44|Record_Status'] = 'Void';
  assert.deepEqual(Core.undo.planUndo(batch, get).errors, ["Can't undo: Sales_Log 44 was changed after that action."]);
  assert.deepEqual(Core.undo.planUndo(null, get).errors, ['Nothing to undo.']);
});

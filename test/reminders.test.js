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

// ---- Phase 2 Task 1: message builder and default templates ----
function blankTemplates(m) {
  ['msg_renew_en', 'msg_due_en', 'msg_renew_bn', 'msg_due_bn'].forEach(k => { m.settings[k] = ''; });
  return m;
}
function spotifySale(m) {
  const nas = m.customers.find(c => c.Name === 'jamilhq');
  const s = m.sales.find(x => x.Customer_ID === nas.Customer_ID && /SPOTIFY/i.test(x.Product_ID) && x.Paid_Till);
  s.Contact = 'Fahim S'; s.Pay_Token = 'tok123';
  return { nas, s };
}

test('message names customer, product, profile, expiry and link', () => {
  const m = blankTemplates(makeMigratedState());
  m.settings.pay_base_url = 'https://pay.example.com/';
  const { nas, s } = spotifySale(m);
  const r = Core.reminders.buildMessage(m, s, 'before');
  assert.match(r.message, /jamilhq/);
  assert.match(r.message, /Spotify/);
  assert.match(r.message, /Fahim S/);
  assert.match(r.message, /2026-10-19/);
  assert.match(r.message, /https:\/\/pay\.example\.com\/pay\/tok123/);
  assert.equal(r.vars.profile, 'Fahim S');
  assert.equal(r.vars.status, 'expires in 1 day');
  assert.equal(r.lang, 'en');
  assert.ok(r.template.length > 0);
  assert.ok(!('login' in r.vars) && !('password' in r.vars));
});

test('due message states balance and not full price', () => {
  const m = blankTemplates(makeMigratedState());
  const tariq = Core.reminders.planReminders(m).find(i => i.customerId === cid(m, 'tariq') && i.kind === 'due');
  const s = m.sales.find(x => x.Sale_ID === tariq.saleId);
  m.payments.push({ Payment_ID: 'PM-T1', Sale_ID: s.Sale_ID, Customer_ID: s.Customer_ID, Amount: 100 });
  const full = Core.ledger.salePrice(s, m.products);
  const r = Core.reminders.buildMessage(m, s, 'due');
  assert.equal(r.vars.balance, '৳200');
  assert.equal(r.vars.status, 'owes ৳200');
  assert.match(r.message, /৳200/);
  assert.equal(Core.reminders.money(full), '৳300');
  assert.ok(!r.message.includes(Core.reminders.money(full)));
});

test('link appended when template has none; {nolink} suppresses it and is stripped', () => {
  const m = makeMigratedState();
  m.settings.pay_base_url = 'https://pay.example.com';
  const { s } = spotifySale(m);
  m.settings.msg_renew_en = 'Hi {name}, renew {price}';
  const a = Core.reminders.buildMessage(m, s, 'before');
  assert.equal(a.message, 'Hi jamilhq, renew ৳100\nPay: https://pay.example.com/pay/tok123');
  const b = Core.reminders.buildMessage(m, s, 'before', { template: 'Hi {name} {nolink}' });
  assert.equal(b.message, 'Hi jamilhq');
  const c = Core.reminders.buildMessage(m, s, 'before', { template: 'Go {link}' });
  assert.equal(c.message, 'Go https://pay.example.com/pay/tok123');
});

test('blank pay_base_url gives no Pay line', () => {
  const m = blankTemplates(makeMigratedState());
  m.settings.pay_base_url = '';
  const { s } = spotifySale(m);
  const r = Core.reminders.buildMessage(m, s, 'before');
  assert.ok(!/Pay:|https?:/.test(r.message));
  delete s.Pay_Token; m.settings.pay_base_url = 'https://pay.example.com';
  assert.ok(!/Pay:|https?:/.test(Core.reminders.buildMessage(m, s, 'before').message));
});

test('Bangla default substitutes variables', () => {
  const m = blankTemplates(makeMigratedState());
  m.settings.pay_base_url = 'https://pay.example.com';
  m.settings.language = 'bn';
  const { s } = spotifySale(m);
  const r = Core.reminders.buildMessage(m, s, 'before');
  assert.equal(r.lang, 'bn');
  assert.ok(!/\{[a-z]+\}/.test(r.message), 'no raw placeholders');
  assert.match(r.message, /jamilhq/);
  assert.match(r.message, /Fahim S/);
  assert.match(r.message, /এখানে পেমেন্ট করুন: https:\/\/pay\.example\.com\/pay\/tok123/);
  assert.equal(Core.reminders.buildMessage(m, s, 'before', { lang: 'en' }).lang, 'en');
});

test('customer with no channel still builds; no-profile default has no empty brackets', () => {
  const m = blankTemplates(makeMigratedState());
  const { nas, s } = spotifySale(m);
  nas.Channel = ''; nas.Handle = ''; s.Contact = '';
  const r = Core.reminders.buildMessage(m, s, 'before');
  assert.equal(r.channel, '');
  assert.equal(r.link, '');
  assert.ok(r.message.length > 0);
  assert.ok(!/\(\s*\)|\{/.test(r.message));
});

test('WhatsApp link encodes special characters, copied text stays raw', () => {
  const m = blankTemplates(makeMigratedState());
  const { nas, s } = spotifySale(m);
  nas.Channel = 'WhatsApp'; nas.Handle = '01711111111'; s.Contact = 'A&B $5\nx';
  const r = Core.reminders.buildMessage(m, s, 'before');
  assert.ok(r.message.includes('A&B $5\nx'));
  assert.ok(r.link.includes(encodeURIComponent('A&B $5\nx')));
});

test('planReminders items carry lang and template', () => {
  const m = makeMigratedState();
  const it = Core.reminders.planReminders(m)[0];
  assert.equal(it.lang, 'en');
  assert.equal(typeof it.template, 'string');
});

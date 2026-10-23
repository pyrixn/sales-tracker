const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { appendOf, appendsOf, updateOf } = require('./helpers');

const match = (m, row, manual) => Core.matching.planInboxMatch(m, row, manual);
const base = { Received: '2026-10-18', Sender: '16247', Type: 'Received', Amount: 580, Transaction_ID: 'T1', Reference: 'N44', Raw_SMS: '', Status: 'Pending' };
const inboxUpdate = x => x.ops.find(o => o.tab === 'Payment_Inbox');

test('a real bKash payment with a valid reference renews automatically', () => {
  const m = makeMigratedState();
  const x = match(m, base);
  assert.equal(x.status, 'auto');
  const sale = appendOf(x, 'Sales_Log').values;
  assert.equal(sale.Paid_Till, '2027-02-12');
  assert.equal(sale.Months, 2);
  assert.deepEqual(updateOf(x, 44).values, { Record_Status: 'Renewed' });
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount, o.values.Source, o.values.Transaction_ID, o.values.Method]),
    [[103, 580, 'Auto', 'T1', 'bKash']]);
  assert.deepEqual(inboxUpdate(x), { op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: 'T1', values: { Status: 'Matched', Matched_Sale_ID: 103 } });
});

test('forwarded or test messages are never applied automatically', () => {
  const m = makeMigratedState();
  const x = match(m, Object.assign({}, base, { Sender: '+8801756999991' }));
  assert.equal(x.status, 'pending'); assert.equal(x.ops.length, 0);
  assert.equal(match(m, Object.assign({}, base, { Type: 'Unrecognised' })).status, 'pending');
});

test('the iPhone may report the bKash sender by name instead of 16247', () => {
  const m = makeMigratedState();
  for (const s of ['bKash', 'BKASH', ' bkash ']) assert.equal(match(m, Object.assign({}, base, { Sender: s })).status, 'auto', s);
  for (const s of ['bKash Agent', 'discord.user@example.com', '']) assert.equal(match(m, Object.assign({}, base, { Sender: s })).status, 'pending', s);
});

test('a reference typed loosely or only inside the SMS still matches', () => {
  const m = makeMigratedState();
  assert.equal(match(m, Object.assign({}, base, { Reference: '', Raw_SMS: 'You have received Tk 580.00 from 01711111111. Ref n-44. Fee Tk 0.00. TrxID T1' })).status, 'auto');
  assert.equal(match(m, Object.assign({}, base, { Reference: 'ref N 44 netflix' })).status, 'auto');
  assert.equal(match(m, Object.assign({}, base, { Reference: 'netflix' })).status, 'pending');
});

test('dues are paid first, then a renewal, then credit', () => {
  const m = makeMigratedState();
  let x = match(m, Object.assign({}, base, { Amount: 600, Reference: 'N54', Transaction_ID: 'T2' }));
  assert.equal(x.status, 'auto');
  assert.equal(appendOf(x, 'Sales_Log').values.Paid_Till, '2026-11-18');
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount]), [[54, 300], [103, 300]]);

  x = match(m, Object.assign({}, base, { Amount: 590, Reference: 'N54', Transaction_ID: 'T3' }));
  assert.equal(appendsOf(x, 'Sales_Log').length, 0);
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount]), [[54, 300], ['', 290]]);
  assert.equal(inboxUpdate(x).values.Matched_Sale_ID, 54);

  x = match(m, Object.assign({}, base, { Amount: 2000, Transaction_ID: 'T4' }));
  assert.equal(appendOf(x, 'Sales_Log').values.Months, 6);
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount]), [[103, 1740], ['', 260]]);
});

test('renewing never goes past 12 months; the rest is credit', () => {
  const m = makeMigratedState();
  const x = match(m, Object.assign({}, base, { Amount: 4000 }));
  assert.equal(appendOf(x, 'Sales_Log').values.Months, 12);
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount]), [[103, 3480], ['', 520]]);
});

test('a reference to an already-renewed row follows to the newest row', () => {
  const m = makeMigratedState();
  const old = m.sales.find(s => s.Sale_ID === 44);
  old.Record_Status = 'Renewed';
  m.sales.push(Object.assign({}, old, { Sale_ID: 103, Record_Status: 'Active', Paid_Till: '2027-01-12' }));
  m.payments.push({ Payment_ID: 'PM-00091', Customer_ID: old.Customer_ID, Sale_ID: 103, Amount: 290, Transaction_ID: 'OLD', Source: 'App' });
  const x = match(m, base);
  assert.equal(x.status, 'auto');
  assert.deepEqual(updateOf(x, 103).values, { Record_Status: 'Renewed' });
  assert.equal(appendOf(x, 'Sales_Log').values.Paid_Till, '2027-03-12');
});

test('void lines, banned accounts and long-expired lines wait for the owner', () => {
  let m = makeMigratedState();
  m.sales.find(s => s.Sale_ID === 44).Record_Status = 'Void';
  assert.equal(match(m, base).status, 'pending');
  m = makeMigratedState();
  m.accounts.find(a => a.Account_ID === 'NFX-01').Account_Status = 'Banned';
  assert.equal(match(m, base).status, 'pending');
  m = makeMigratedState();
  assert.equal(match(m, Object.assign({}, base, { Reference: 'S64', Amount: 80 })).status, 'pending', 'expired 33 days ago');
  assert.equal(match(m, Object.assign({}, base, { Reference: 'S62', Amount: 100 })).status, 'auto', 'expired 14 days ago');
});

test('a transaction already recorded is marked matched and nothing else', () => {
  const m = makeMigratedState();
  m.payments.push({ Payment_ID: 'PM-00091', Customer_ID: 'CU-0001', Sale_ID: 1, Amount: 580, Transaction_ID: 'T1', Source: 'App' });
  const x = match(m, base);
  assert.equal(x.status, 'duplicate');
  assert.deepEqual(x.ops, [{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: 'T1', values: { Status: 'Matched' } }]);
});

test('Match by hand works for forwarded texts and can renew a chosen line', () => {
  const m = makeMigratedState();
  const kabir = cid(m, 'Kabir');
  const row = Object.assign({}, base, { Sender: '+8801756999991', Reference: '', Amount: 400, Transaction_ID: 'T5' });
  let x = match(m, row, { customerId: kabir });
  assert.equal(x.status, 'manual');
  assert.deepEqual(appendsOf(x, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount, o.values.Source]), [[54, 300, 'App'], ['', 100, 'App']]);
  x = match(m, Object.assign({}, row, { Amount: 600 }), { customerId: kabir, subCode: 'N54' });
  assert.equal(appendOf(x, 'Sales_Log').values.Sub_Code, 'N54');
  assert.deepEqual(match(m, Object.assign({}, row, { Transaction_ID: '' }), { customerId: kabir }).errors, ['This message has no transaction ID, so it cannot be matched.']);
});

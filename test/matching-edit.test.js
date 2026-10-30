// Task 7: match sheet backend (overrides, new customer, suggestions, why, ignore, delete).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const M = () => Core.matching;
const row = extra => Object.assign({ Received: '2026-10-18 14:05', Type: 'Received', Method: 'bKash', Sender: '+8801756999991', Amount: 500,
  Transaction_ID: 'TX1', Counterparty: '', Reference: '', Raw_SMS: '', Status: 'Pending', Matched_Sale_ID: '' }, extra || {});
const withRow = r => { const st = makeMigratedState(); st.inbox = [r]; return st; };
const payOp = x => x.ops.find(o => o.op === 'append' && o.tab === 'Payments');
const inboxOp = x => x.ops.find(o => o.tab === 'Payment_Inbox');

test('manual match with amount override records that amount, inbox row untouched but Matched', () => {
  const st = withRow(row()); const c = st.customers[0].Customer_ID;
  const x = M().planInboxMatch(st, st.inbox[0], { customerId: c, amount: 200 });
  assert.deepEqual(x.errors, []);
  assert.equal(x.status, 'manual');
  const total = x.ops.filter(o => o.op === 'append' && o.tab === 'Payments').reduce((a, o) => a + Number(o.values.Amount), 0);
  assert.equal(total, 200);
  assert.equal(inboxOp(x).values.Status, 'Matched');
  assert.equal(inboxOp(x).values.Amount, undefined, 'inbox keeps SMS amount');
  assert.equal(st.inbox[0].Amount, 500);
});

test('date, method and note overrides land on the payment', () => {
  const st = withRow(row()); const c = st.customers[0].Customer_ID;
  const x = M().planInboxMatch(st, st.inbox[0], { customerId: c, date: '2026-10-10', method: ' Nagad ', note: ' cash drop ' });
  assert.deepEqual(x.errors, []);
  const p = x.ops.filter(o => o.op === 'append' && o.tab === 'Payments');
  assert.ok(p.length);
  p.forEach(o => { assert.equal(o.values.Date, '2026-10-10'); assert.equal(o.values.Method, 'Nagad'); assert.equal(o.values.Note, 'cash drop'); });
});

test('bad overrides are refused', () => {
  const st = withRow(row()); const c = st.customers[0].Customer_ID;
  const bad = o => M().planInboxMatch(st, st.inbox[0], Object.assign({ customerId: c }, o));
  for (const a of [0, -5, NaN, Infinity, 1000000, 'abc']) assert.ok(bad({ amount: a }).errors.length, 'amount ' + a);
  assert.match(bad({ date: '18/10/2026' }).errors[0], /Date/);
  assert.ok(bad({ method: 'Carrier pigeon' }).errors.length);
  assert.ok(bad({ method: '' }).errors.length);
});

test('newCustomer creates the customer and matches to it', () => {
  const st = withRow(row());
  const x = M().planInboxMatch(st, st.inbox[0], { newCustomer: { name: '  Rafi   Khan ', channel: 'WhatsApp', handle: '01711000000' } });
  assert.deepEqual(x.errors, []);
  const ca = x.ops.find(o => o.op === 'append' && o.tab === 'Customers');
  assert.equal(ca.values.Name, 'Rafi Khan');
  assert.equal(ca.values.Handle, '01711000000');
  assert.equal(ca.values.Channel, 'WhatsApp');
  assert.equal(payOp(x).values.Customer_ID, ca.values.Customer_ID);
  assert.equal(x.result.customerId, ca.values.Customer_ID);
  assert.ok(x.ops.indexOf(ca) < x.ops.indexOf(payOp(x)));
});

test('newCustomer refuses a name clash or empty name', () => {
  const st = withRow(row());
  const name = st.customers[0].Name.toUpperCase();
  assert.match(M().planInboxMatch(st, st.inbox[0], { newCustomer: { name } }).errors[0], /already exists/);
  assert.ok(M().planInboxMatch(st, st.inbox[0], { newCustomer: { name: '  ' } }).errors.length);
});

test('old payload shape {customerId, subCode} still works', () => {
  const st = withRow(row({ Amount: 580, Reference: 'N44' }));
  const sale = st.sales.find(s => s.Sub_Code === 'N44');
  const x = M().planInboxMatch(st, st.inbox[0], { customerId: sale.Customer_ID, subCode: 'N44' });
  assert.deepEqual(x.errors, []);
  assert.equal(x.status, 'manual');
  assert.equal(inboxOp(x).values.Status, 'Matched');
});

test('whyNotAuto: unknown reference note, empty when auto', () => {
  const st = withRow(row({ Sender: '16247', Reference: 'N9999' }));
  assert.match(M().whyNotAuto(st, st.inbox[0]), /N9999/);
  const ok = withRow(row({ Sender: '16247', Amount: 580, Reference: 'N44' }));
  assert.equal(M().whyNotAuto(ok, ok.inbox[0]), '');
  const fwd = withRow(row());
  assert.match(M().whyNotAuto(fwd, fwd.inbox[0]), /Not sent by bKash/);
});

test('suggest: counterparty match first, +880 and 01 forms equal', () => {
  const st = withRow(row({ Counterparty: '+8801711222333' }));
  st.customers[3].Handle = '01711222333';
  const s = M().suggest(st, st.inbox[0]);
  assert.equal(s[0].customerId, st.customers[3].Customer_ID);
  assert.match(s[0].why, /number/i);
  const st2 = withRow(row({ Counterparty: '01711222333' }));
  st2.customers[3].Handle = '+8801711222333';
  assert.equal(M().suggest(st2, st2.inbox[0])[0].customerId, st2.customers[3].Customer_ID);
  assert.ok(s.length <= 6);
  assert.equal(new Set(s.map(x => x.customerId)).size, s.length);
});

test('suggest: reference owner next, then name matches with query', () => {
  const st = withRow(row({ Reference: 'N44', Counterparty: '' }));
  const owner = st.sales.find(s => s.Sub_Code === 'N44').Customer_ID;
  const s = M().suggest(st, st.inbox[0]);
  assert.equal(s[0].customerId, owner);
  const nm = st.customers[2].Name;
  const q = M().suggest(st, st.inbox[0], nm.slice(0, 3).toLowerCase());
  assert.ok(q.some(x => x.customerId === st.customers[2].Customer_ID));
  assert.ok(q.length <= 6);
});

test('ignore: sets Ignored; re-ignore and Matched are errors', () => {
  const st = withRow(row());
  const x = Core.sales.planIgnoreInbox(st, { trx: 'tx1' });
  assert.deepEqual(x.errors, []);
  assert.deepEqual(x.ops, [{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: 'TX1', values: { Status: 'Ignored' } }]);
  st.inbox[0].Status = 'Ignored';
  assert.ok(Core.sales.planIgnoreInbox(st, { trx: 'TX1' }).errors.length);
  st.inbox[0].Status = 'Matched';
  assert.ok(Core.sales.planIgnoreInbox(st, { trx: 'TX1' }).errors.length);
  assert.ok(Core.sales.planIgnoreInbox(st, { trx: 'NOPE' }).errors.length);
});

test('delete: clears row; Matched refused', () => {
  const st = withRow(row());
  const x = Core.sales.planDeleteInbox(st, { trx: 'TX1' });
  assert.deepEqual(x.ops, [{ op: 'clear', tab: 'Payment_Inbox', key: 'Transaction_ID', id: 'TX1' }]);
  st.inbox[0].Status = 'Matched';
  assert.match(Core.sales.planDeleteInbox(st, { trx: 'TX1' }).errors[0], /matched/i);
});

test('homeData unmatched rows carry why', () => {
  const st = withRow(row({ Sender: '16247', Reference: 'N9999' }));
  const h = Core.views.homeData(st);
  assert.match(h.unmatched[0].why, /N9999/);
});

// ---- edge
const all = t => (Array.isArray(t) ? t : Array.from(t.values()));
const one = (t, col, v) => all(t).filter(r => String(r[col]) === String(v))[0];
async function boot() {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  await seedDb(db, tables, m);
  return { db, tables, m, edge: loadEdge(db) };
}

test('edge: deleteInbox then undo restores the row', async () => {
  const { edge, tables } = await boot();
  assert.ok(one(tables.payment_inbox, 'transaction_id', 'TESTTRX1'));
  const r = await edge.api('deleteInbox', { requestId: 'di1', trx: 'TESTTRX1' });
  assert.equal(r.ok, true, r.error);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'TESTTRX1'), undefined);
  const u = await edge.api('undo', { requestId: 'di2' });
  assert.equal(u.ok, true, u.error);
  assert.ok(one(tables.payment_inbox, 'transaction_id', 'TESTTRX1'));
});

test('edge: match with overrides + newCustomer, suggestCustomers, then ignore/delete refused', async () => {
  const { edge, tables, m } = await boot();
  const s = await edge.api('suggestCustomers', { trx: 'TESTTRX1', query: m.customers[0].Name.slice(0, 3) });
  assert.equal(s.ok, true, s.error);
  assert.ok(Array.isArray(s.data) && s.data.length <= 6);
  const mt = await edge.api('match', { requestId: 'm1', trx: 'TESTTRX1', amount: 100, date: '2026-10-12', newCustomer: { name: 'Brand New Person' } });
  assert.equal(mt.ok, true, mt.error);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'TESTTRX1').status, 'Matched');
  assert.ok(all(tables.customers).some(c => c.name === 'Brand New Person'));
  assert.equal((await edge.api('ignoreInbox', { requestId: 'ig1', trx: 'TESTTRX1' })).ok, false);
  assert.equal((await edge.api('deleteInbox', { requestId: 'dl1', trx: 'TESTTRX1' })).ok, false);
});

test('edge: old match payload and ignore', async () => {
  const { edge, m } = await boot();
  const r = await edge.api('match', { requestId: 'o1', trx: 'TESTTRX1', customerId: m.customers[0].Customer_ID });
  assert.equal(r.ok, true, r.error);
  const b = await boot();
  const ig = await b.edge.api('ignoreInbox', { requestId: 'ig2', trx: 'TESTTRX1' });
  assert.equal(ig.ok, true, ig.error);
  assert.equal(one(b.tables.payment_inbox, 'transaction_id', 'TESTTRX1').status, 'Ignored');
});

test('whyNotAuto mentions the auto-match limit; raising it clears; blank only when auto-matchable', () => {
  const st = withRow(row({ Sender: '16247', Amount: 5001, Reference: 'N44' }));
  assert.match(M().whyNotAuto(st, st.inbox[0]), /above the auto-match limit \(৳5000\)/);
  st.settings.auto_match_max_bdt = '10000';
  assert.equal(M().whyNotAuto(st, st.inbox[0]), '');
  st.settings.auto_match_max_bdt = '';
  assert.equal(M().autoCap(st), 5000);
  for (const r of [row(), row({ Sender: '16247', Reference: 'N9999' }), row({ Type: 'Sent' })]) {
    const s2 = withRow(r); assert.notEqual(M().whyNotAuto(s2, s2.inbox[0]), '');
  }
});

test('suggest skips placeholders in the recent fill and ended lines for the reference owner', () => {
  const st = withRow(row({ Reference: 'N44' }));
  st.customers.push({ Customer_ID: 'C-PH', Name: 'Unlogged payment 1', Channel: '', Handle: '', Created: '2026-10-01' });
  st.payments.push({ Payment_ID: 'PM-PH', Date: '2026-10-17', Customer_ID: 'C-PH', Sale_ID: '', Amount: 1, Method: '', Transaction_ID: '', Source: 'App', Note: '' });
  assert.ok(!M().suggest(st, st.inbox[0]).some(x => x.customerId === 'C-PH'));
  const line = st.sales.find(s => s.Sub_Code === 'N44');
  st.accounts.find(a => a.Account_ID === line.Account_ID).Account_Status = 'Deleted';
  const owner = line.Customer_ID;
  assert.notEqual(M().suggest(st, st.inbox[0])[0].why, 'Owns N44');
  void owner;
});

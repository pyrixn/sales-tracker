// Server behaviour tests: the real Edge Function router (src/server/edge.js) over the fake database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { cid } = require('./fixtures');

async function boot(mutate) {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  if (mutate) mutate(m);
  await seedDb(db, tables, m);
  return { db, tables, m, edge: loadEdge(db) };
}
const all = tbl => (Array.isArray(tbl) ? tbl : Array.from(tbl.values()));
const where = (tbl, col, v) => all(tbl).filter(r => String(r[col]) === String(v));
const one = (tbl, col, v) => where(tbl, col, v)[0];

test('reads go through the adapter and match the Dashboard', async () => {
  const { edge } = await boot();
  const r = await edge.api('home', {});
  assert.equal(r.ok, true);
  assert.equal(Math.round(r.data.owed), 1360);
  assert.equal(r.data.renewSoon[0].name, 'jamilhq');
  const l = await edge.api('lookups', {});
  assert.ok(l.data.accounts.some(a => a.id === 'NFX-03' && a.free === 2));
});

test('the same requestId saves once and returns the first answer', async () => {
  const { edge, tables, m } = await boot();
  const payload = { requestId: 'r1', productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'Kabir'), paidNow: { amount: 290, method: 'bKash' } };
  const a = await edge.api('newSale', payload), b = await edge.api('newSale', payload);
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(b, a);
  assert.equal(where(tables.sales, 'sale_id', 103).length, 1);
  assert.equal(where(tables.sales, 'sale_id', 104).length, 0);
});

test('errors come back as plain messages and write nothing', async () => {
  const { edge, tables, m } = await boot();
  const before = all(tables.sales).length;
  const r = await edge.api('newSale', { requestId: 'r2', productId: 'EXITLAG', accountId: 'EXL-01', customerId: cid(m, 'Kabir') });
  assert.deepEqual(r, { ok: false, error: 'EXL-01 has no free slot. Pick another account or add one.' });
  assert.equal(all(tables.sales).length, before);
  assert.deepEqual(await edge.api('nope', {}), { ok: false, error: 'Unknown action nope' });
});

test('pay then undo clears the payment and logs the undo', async () => {
  const { edge, tables, m } = await boot();
  const p = await edge.api('pay', { requestId: 'r3', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal(p.ok, true, p.error);
  assert.ok(one(tables.payments, 'payment_id', 'PM-00091'));
  const u = await edge.api('undo', { requestId: 'r4' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.payments, 'payment_id', 'PM-00091'), undefined);
  assert.ok(tables.change_log.some(r => /^undo:/.test(r.action)));
  assert.equal((await edge.api('undo', { requestId: 'r5' })).error, 'Nothing to undo.');
});

test('undo refuses when the row was edited by hand afterwards', async () => {
  const { edge, tables } = await boot();
  assert.equal((await edge.api('renew', { requestId: 'r6', subCode: 'N44', months: 1 })).ok, true);
  one(tables.sales, 'sale_id', 44).record_status = 'Void';                     // owner edits the row directly
  assert.deepEqual(await edge.api('undo', { requestId: 'r7' }), { ok: false, error: "Can't undo: Sales_Log 44 was changed after that action." });
});

test('reminder logging is not something Undo reverses', async () => {
  const { edge, tables, m } = await boot();
  await edge.api('pay', { requestId: 'r8', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal((await edge.api('remindSent', { requestId: 'r9', saleId: 73, customerId: cid(m, 'jamilhq'), kind: 'before', channel: 'WhatsApp' })).ok, true);
  assert.equal(all(tables.reminders_log).length, 1);
  assert.ok(one(tables.payments, 'payment_id', 'PM-00091'), 'the payment exists before undo');
  await edge.api('undo', { requestId: 'r10' });
  assert.equal(one(tables.payments, 'payment_id', 'PM-00091'), undefined, 'the payment was undone');
  assert.equal(all(tables.reminders_log).length, 1, 'the reminder stays logged');
});

test('matchInbox: a pending bKash SMS is matched by hand through the edge and can be undone', async () => {
  const { edge, tables, m } = await boot(s => {
    s.inbox = [
      { Received: '2026-10-18 14:05', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 580, Transaction_ID: 'T1', Reference: 'N44', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'x' },
      { Received: '2026-10-18 14:06', Type: 'Received', Method: 'bKash', Sender: '+8801756999991', Amount: 300, Transaction_ID: 'T2', Reference: 'N54', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'y' }];
  });
  const customerId = m.sales.find(s => s.Sale_ID === 54).Customer_ID;
  const man = await edge.api('match', { requestId: 'r12', trx: 'T2', customerId });
  assert.equal(man.ok, true, man.error);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'T2').status, 'Matched');
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'T1').status, 'Pending', 'the other message is untouched');
  const u = await edge.api('undo', { requestId: 'r11' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'T2').status, 'Pending', 'undo puts the message back');
  assert.equal((await edge.api('match', { requestId: 'r14', trx: 'NOPE', customerId })).error, 'That payment message is no longer in the inbox.');
});

test('a relayed bKash SMS lands in the inbox once and then matches', async () => {
  const { edge, tables, m } = await boot();
  const seeded = all(tables.payment_inbox).length;
  const body = { sender: '16247', text: 'You have received Tk 580.00 from 01756999991. Ref ZZ44. TrxID ABC123XYZ at 18/10/2026 14:05' };
  const r = await edge.relayIngest(body, 'bkash');
  assert.equal(r.result, 'stored');
  assert.equal(r.trxId, 'ABC123XYZ');
  const row = one(tables.payment_inbox, 'transaction_id', 'ABC123XYZ');
  assert.equal(row.status, 'Pending');
  assert.equal(row.reference, 'ZZ44');
  assert.equal(Number(row.amount), 580);
  assert.equal((await edge.relayIngest(body, 'bkash')).result, 'duplicate ABC123XYZ');
  assert.equal(all(tables.payment_inbox).length, seeded + 1);
  const customerId = m.sales.find(s => s.Sale_ID === 44).Customer_ID;
  const man = await edge.api('match', { requestId: 'r15', trx: 'ABC123XYZ', customerId, subCode: 'N44' });
  assert.equal(man.ok, true, man.error);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'ABC123XYZ').status, 'Matched');
});

const hasReminder = (res, saleId, kind) => res.data.reminders.some(x => x.saleId === saleId && x.kind === kind);

test('a renewal reminder shows on home, stops showing once marked sent, and stays gone', async () => {
  const { db, tables, edge } = await boot();
  const before = await edge.api('home', {});
  assert.equal(before.ok, true, before.error);
  const target = before.data.reminders.find(x => x.kind !== 'due');
  assert.ok(target, 'the seeded state has a renewal reminder due today');
  assert.equal((await edge.api('remindSent', { requestId: 'r20', saleId: target.saleId, customerId: target.customerId, kind: target.kind, channel: target.channel })).ok, true);
  assert.equal(all(tables.reminders_log).length, 1);
  assert.equal(hasReminder(await edge.api('home', {}), target.saleId, target.kind), false);
  const same = loadEdge(db, { today: '2026-10-18' });
  assert.equal(hasReminder(await same.api('home', {}), target.saleId, target.kind), false, 'a later read still hides it');
});

test('a due reminder comes back after it was sent and the repeat gap passed', async () => {
  const { db, edge } = await boot();
  const first = await edge.api('home', {});
  const due = first.data.reminders.find(x => x.kind === 'due');
  assert.ok(due, 'the seeded state has an unpaid balance');
  assert.equal((await edge.api('remindSent', { requestId: 'r21', saleId: due.saleId, customerId: due.customerId, kind: 'due', channel: due.channel })).ok, true);
  assert.equal(hasReminder(await edge.api('home', {}), due.saleId, 'due'), false, 'hidden the day it was sent');
  const gapMinus1 = loadEdge(db, { today: '2026-10-22' });   // sent 2026-10-18, repeat gap is 5 days
  assert.equal(hasReminder(await gapMinus1.api('home', {}), due.saleId, 'due'), false, 'still hidden at gap - 1 days');
  const gap = loadEdge(db, { today: '2026-10-23' });
  assert.equal(hasReminder(await gap.api('home', {}), due.saleId, 'due'), true, 'listed again at gap days');
});

test('addProduct adds the catalog row', async () => {
  const { edge, tables } = await boot();
  const r = await edge.api('addProduct', { requestId: 'r13', name: 'Disney+', category: 'Subscription', cycleDays: 30, accountCost: 1000, slots: 4, price: 350, letter: 'D' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.productId, 'DISNEY');
  assert.ok(one(tables.products, 'product_id', 'DISNEY'));
});

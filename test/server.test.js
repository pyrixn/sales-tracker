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

test('deletePayment of an auto payment resets the inbox row; undo restores the payment', async () => {
  const { edge, tables, m } = await boot(s => {
    const customerId = s.sales.find(x => x.Sale_ID === 54).Customer_ID;
    s.payments.push({ Payment_ID: 'PM-AUTO1', Date: '2026-10-18', Customer_ID: customerId, Sale_ID: 54, Amount: 300, Method: 'bKash',
      Transaction_ID: 'TAUTO1', Source: 'Auto', Note: '' });
    s.inbox = [{ Received: '2026-10-18 14:06', Type: 'Received', Method: 'bKash', Sender: '+8801756999991', Amount: 300, Transaction_ID: 'TAUTO1',
      Reference: 'N54', Status: 'Matched', Matched_Sale_ID: 54, Raw_SMS: 'y' }];
  });
  const d = await edge.api('deletePayment', { requestId: 'dp1', paymentId: 'PM-AUTO1' });
  assert.equal(d.ok, true, d.error);
  assert.equal(one(tables.payments, 'payment_id', 'PM-AUTO1'), undefined, 'payment gone');
  const inb = one(tables.payment_inbox, 'transaction_id', 'TAUTO1');
  assert.equal(inb.status, 'Pending');
  assert.ok(!inb.matched_sale_id, 'matched sale cleared');
  const u = await edge.api('undo', { requestId: 'dp2' });
  assert.equal(u.ok, true, u.error);
  const back = one(tables.payments, 'payment_id', 'PM-AUTO1');
  assert.ok(back, 'undo restores the payment');
  assert.equal(Number(back.amount), 300);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'TAUTO1').status, 'Matched');
  assert.equal((await edge.api('deletePayment', { requestId: 'dp3', paymentId: 'NOPE' })).error, 'Unknown payment NOPE.');
});

test('edge: editPayment, editExpense and deleteExpense round-trip', async () => {
  const { edge, tables, m } = await boot();
  const ex = await edge.api('addExpense', { requestId: 'ex1', category: 'VPN', amount: 100 });
  assert.equal(ex.ok, true, ex.error);
  const id = all(tables.expenses)[0].expense_id;
  assert.equal((await edge.api('editExpense', { requestId: 'ex2', expenseId: id, amount: 150 })).ok, true);
  assert.equal(Number(one(tables.expenses, 'expense_id', id).amount), 150);
  assert.equal((await edge.api('deleteExpense', { requestId: 'ex3', expenseId: id })).ok, true);
  assert.equal(one(tables.expenses, 'expense_id', id), undefined);
});

test('edge: entry read returns the audit lines of an edited payment', async () => {
  const { edge, tables } = await boot();
  const ex = await edge.api('addExpense', { requestId: 'en1', category: 'VPN', amount: 100 });
  assert.equal(ex.ok, true, ex.error);
  const id = all(tables.expenses)[0].expense_id;
  assert.equal((await edge.api('editExpense', { requestId: 'en2', expenseId: id, amount: 150 })).ok, true);
  const r = await edge.api('entry', { kind: 'expense', id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.row.Expense_ID, id);
  const amt = r.data.audit.find(a => a.field === 'Amount');
  assert.equal(amt.old, '100'); assert.equal(amt.new, '150'); assert.equal(amt.action, 'editExpense');
  assert.ok(r.data.audit.some(a => a.field === '(new row)'));
  assert.ok(r.data.audit.every(a => a.when !== undefined));
  assert.equal((await edge.api('entry', { kind: 'payment', id: 'NOPE' })).error, 'Unknown payment NOPE.');
});

test('edge: entry read of an edited payment shows its audit', async () => {
  const { edge, tables } = await boot();
  const pm = all(tables.payments).find(p => p.source !== 'Credit');
  const r0 = await edge.api('editPayment', { requestId: 'ep1', paymentId: pm.payment_id, amount: Number(pm.amount) - 1 });
  assert.equal(r0.ok, true, r0.error);
  const r = await edge.api('entry', { kind: 'payment', id: pm.payment_id });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.audit.some(a => a.field === 'Amount' && a.action === 'editPayment'));
});

test('reminderMessage returns the built message for a due sale', async () => {
  const { edge } = await boot();
  const due = (await edge.api('dues', {})).data.rows[0];
  const r = await edge.api('reminderMessage', { saleId: due.saleId, kind: 'due' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.message.includes('৳') || r.data.message.includes(String(due.amount)), r.data.message);
  assert.equal(r.data.vars.balance.replace('৳', ''), String(due.amount));
  assert.equal(r.data.lang, 'en');
  const def = await edge.api('reminderMessage', { saleId: due.saleId });
  assert.equal(def.data.template, r.data.template || def.data.template);
  const bn = await edge.api('reminderMessage', { saleId: due.saleId, kind: 'due', lang: 'bn' });
  assert.equal(bn.data.lang, 'bn');
});

test('reminderMessage rejects an unknown sale', async () => {
  const { edge } = await boot();
  const r = await edge.api('reminderMessage', { saleId: 99999 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Unknown sale 99999.');
});

test('saveTemplate stores global text that the next message uses; unknown variables are allowed', async () => {
  const { edge, tables } = await boot();
  const due = (await edge.api('dues', {})).data.rows[0];
  const s = await edge.api('saveTemplate', { requestId: 't1', scope: 'global', kind: 'due', lang: 'en', text: 'Yo {name} {nope} owes {balance}' });
  assert.equal(s.ok, true, s.error);
  assert.equal(tables.settings.get('msg_due_en'), 'Yo {name} {nope} owes {balance}');
  const r = await edge.api('reminderMessage', { saleId: due.saleId, kind: 'due' });
  assert.ok(r.data.message.startsWith('Yo ' + due.name + ' {nope} owes'), r.data.message);
});

test('saveTemplate writes a product template and validates input', async () => {
  const { edge, tables } = await boot();
  const pid = all(tables.products)[0].product_id;
  const s = await edge.api('saveTemplate', { requestId: 't2', scope: 'product', kind: 'renew', lang: 'en', productId: pid, text: 'P {name}' });
  assert.equal(s.ok, true, s.error);
  assert.equal(one(tables.products, 'product_id', pid).template_renew, 'P {name}');
  const long = await edge.api('saveTemplate', { requestId: 't3', scope: 'global', kind: 'due', lang: 'en', text: 'x'.repeat(1501) });
  assert.equal(long.ok, false);
  assert.match(long.error, /1500/);
  const ok = await edge.api('saveTemplate', { requestId: 't4', scope: 'global', kind: 'due', lang: 'en', text: 'x'.repeat(1500) });
  assert.equal(ok.ok, true, ok.error);
  assert.equal((await edge.api('saveTemplate', { requestId: 't5', scope: 'product', kind: 'due', lang: 'en', productId: 'NOPE', text: 'a' })).ok, false);
  assert.equal((await edge.api('saveTemplate', { requestId: 't6', scope: 'x', kind: 'due', lang: 'en', text: 'a' })).ok, false);
  assert.equal((await edge.api('saveTemplate', { requestId: 't7', scope: 'global', kind: 'renew', lang: 'fr', text: 'a' })).ok, false);
});

// ---- pay requests, delivery, receipt ------------------------------------------------------------
const withCodeProduct = m => {
  m.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  m.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-AAAA-1111', Status: 'Available' });
};
const payGet = (edge, path) => edge.handle(new Request('https://x.test/functions/v1/api' + path));
const smsR = (amount, ref, trx) => 'You have received Tk ' + amount + '.00 from 01756999991. Ref ' + ref + '. TrxID ' + trx + ' at 18/10/2026 14:05';

test('createPayRequest returns id, token and url; client nowMs and _gen are ignored; string amount works', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  const r = await edge.api('createPayRequest', { requestId: 'q1', title: 'Gift card', amount: '500', productId: 'GC', nowMs: 1000, _gen: { request: () => 'R999', requestToken: () => 'evil-token-0123456789' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.requestId, 'R1');
  assert.notEqual(r.data.token, 'evil-token-0123456789');
  const row = tables.pay_requests.get('R1');
  assert.equal(Number(row.amount), 500);
  assert.ok(Date.parse(row.expires) > Date.now(), 'expiry is from the server clock, not the client nowMs');
  assert.equal(tables.codes.get('GC-0001').status, 'Reserved');
});

test('public pay routes: /status never has the code, /receipt is 404 until Paid and then has the code', async () => {
  const { edge } = await boot(withCodeProduct);
  const c = await edge.api('createPayRequest', { requestId: 'q2', title: 'Gift card', amount: 500, productId: 'GC' });
  const t = c.data.token;
  const open = await payGet(edge, '/pay/' + t + '/status');
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('cache-control'), 'no-store');
  const ob = await open.json();
  assert.equal(ob.stage, 'created');
  assert.equal(ob.paid, false);
  const rc0 = await payGet(edge, '/pay/' + t + '/receipt');
  assert.equal(rc0.status, 404);
  assert.ok(!(await rc0.text()).includes('SECRET-AAAA-1111'));
  assert.equal((await payGet(edge, '/pay/nosuchtoken0123456789/receipt')).status, 404);
  const g = await edge.api('gotPaidRequest', { requestId: 'q3', id: 'R1', trx: 'GOTP0001', method: 'bKash', amount: 500 });
  assert.equal(g.ok, true, g.error);
  const st = await payGet(edge, '/pay/' + t + '/status');
  const text = await st.text();
  assert.ok(!text.includes('SECRET-AAAA-1111'), 'status never carries the code');
  const sb = JSON.parse(text);
  assert.equal(sb.stage, 'confirmed');
  assert.equal(sb.paid, true);
  assert.equal(sb.delivered, true);
  const rc = await payGet(edge, '/pay/' + t + '/receipt');
  assert.equal(rc.status, 200);
  assert.equal(rc.headers.get('cache-control'), 'no-store');
  const rb = await rc.json();
  assert.equal(rb.code, 'SECRET-AAAA-1111');
  assert.ok(Array.isArray(rb.lines) && Array.isArray(rb.links) && 'tos' in rb);
  assert.ok(!(await (await payGet(edge, '/pay/' + t)).text()).includes('SECRET-AAAA-1111'), 'the page itself never carries the code');
});

test('gotPaidRequest twice with the same trx makes one sale; a different requestId is a no-op too', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  await edge.api('createPayRequest', { requestId: 'q4', title: 'Gift card', amount: 500, productId: 'GC' });
  const sales0 = tables.sales.size;
  const a = await edge.api('gotPaidRequest', { requestId: 'q5', id: 'R1', trx: 'GOTP0002', method: 'bKash', amount: '500' });
  assert.equal(a.ok, true, a.error);
  const b = await edge.api('gotPaidRequest', { requestId: 'q6', id: 'R1', trx: 'GOTP0002', method: 'bKash', amount: 500 });
  assert.equal(b.ok, true, b.error);
  assert.equal(tables.sales.size, sales0 + 1);
  assert.equal(tables.pay_requests.get('R1').status, 'Paid');
  assert.equal(tables.codes.get('GC-0001').status, 'Sold');
});

test('gotPaidRequest marks the inbox row with that trx Matched', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  await edge.api('createPayRequest', { requestId: 'q7', title: 'Gift card', amount: 500, productId: 'GC' });
  const r = await edge.relayIngest({ sender: '16247', text: smsR(500, 'WRONG', 'GOTP0003') }, 'bkash');
  assert.equal(r.matched, false);
  assert.equal(tables.payment_inbox.get('GOTP0003').status, 'Pending');
  assert.equal((await edge.api('gotPaidRequest', { requestId: 'q8', id: 'R1', trx: 'GOTP0003', method: 'bKash', amount: 500 })).ok, true);
  assert.equal(tables.payment_inbox.get('GOTP0003').status, 'Matched');
});

test('an expired link answers with an expired stage, the sweep frees its code and Got paid is refused', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  const c = await edge.api('createPayRequest', { requestId: 'q9', title: 'Gift card', amount: 500, productId: 'GC' });
  tables.pay_requests.get('R1').expires = new Date(Date.now() - 60000).toISOString();
  const st = await (await payGet(edge, '/pay/' + c.data.token + '/status')).json();
  assert.equal(st.stage, 'expired');
  assert.equal(st.paid, false);
  const g = await edge.api('gotPaidRequest', { requestId: 'q10', id: 'R1', trx: 'GOTP0004', method: 'bKash', amount: 500 });
  assert.equal(g.ok, false);
  assert.match(g.error, /R1 is Expired/);
  assert.equal(tables.pay_requests.get('R1').status, 'Expired');
  assert.equal(tables.codes.get('GC-0001').status, 'Available');
  assert.ok(tables.change_log.some(l => l.action === 'autoExpire'));
  const again = tables.change_log.length;
  await edge.api('payRequests', {});
  assert.equal(tables.change_log.length, again, 'a second sweep writes nothing');
  const rc = await payGet(edge, '/pay/' + c.data.token + '/receipt');
  assert.equal(rc.status, 404);
});

test('payRequests lists with status, stage, url and delivery; deliveries lists without the code', async () => {
  const { edge } = await boot(m => { withCodeProduct(m); m.settings.pay_base_url = 'https://shop.example'; });
  const c = await edge.api('createPayRequest', { requestId: 'q11', title: 'Gift card', amount: 500, productId: 'GC' });
  await edge.api('gotPaidRequest', { requestId: 'q12', id: 'R1', trx: 'GOTP0005', method: 'bKash', amount: 500 });
  const l = await edge.api('payRequests', {});
  assert.equal(l.ok, true, l.error);
  const row = l.data.rows[0];
  assert.equal(row.id, 'R1');
  assert.equal(row.status, 'Paid');
  assert.equal(row.stage, 'confirmed');
  assert.equal(row.url, 'https://shop.example/pay/' + c.data.token);
  assert.equal(row.ref, 'R1');
  assert.equal(row.deliveryStatus, 'Delivered');
  assert.ok(!JSON.stringify(l.data).includes('SECRET-AAAA-1111'));
  const d = await edge.api('deliveries', { status: 'Delivered' });
  assert.equal(d.ok, true, d.error);
  assert.equal(d.data.rows.length, 1);
  assert.ok(!JSON.stringify(d.data).includes('SECRET-AAAA-1111'));
  assert.equal((await edge.api('deliveries', { status: 'Failed' })).data.rows.length, 0);
});

test('cancelPayRequest releases the code so a second request for the product succeeds', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  assert.equal((await edge.api('createPayRequest', { requestId: 'q13', title: 'Gift card', amount: 500, productId: 'GC' })).ok, true);
  const second = await edge.api('createPayRequest', { requestId: 'q14', title: 'Gift card 2', amount: 500, productId: 'GC' });
  assert.equal(second.error, 'Out of stock');
  const c = await edge.api('cancelPayRequest', { requestId: 'q15', id: 'R1' });
  assert.equal(c.ok, true, c.error);
  assert.equal(tables.codes.get('GC-0001').status, 'Available');
  const third = await edge.api('createPayRequest', { requestId: 'q16', title: 'Gift card 2', amount: 500, productId: 'GC' });
  assert.equal(third.ok, true, third.error);
  const tok = tables.pay_requests.get('R1').token;
  assert.equal((await (await payGet(edge, '/pay/' + tok + '/status')).json()).stage, 'cancelled');
});

test('setDelivery changes a seat delivery status and ignores a client nowMs', async () => {
  const { edge, tables } = await boot(m => {
    m.products.push({ Product_ID: 'SEAT', Product_Name: 'Seat thing', Category: 'Streaming', Delivers_As: 'account', Letter: 'S', Default_Price: 300, Billing_Cycle_Days: 30, Active: 'Yes' });
    m.accounts.push({ Account_ID: 'SEAT-01', Product_ID: 'SEAT', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100, Cycle_Cost: 400 });
  });
  await edge.api('createPayRequest', { requestId: 'q17', title: 'Seat', amount: 300, productId: 'SEAT' });
  const g = await edge.api('gotPaidRequest', { requestId: 'q18', id: 'R1', trx: 'GOTP0006', method: 'bKash', amount: 300 });
  assert.equal(g.ok, true, g.error);
  assert.equal(tables.deliveries.get('D1').status, 'Pending');
  const s = await edge.api('setDelivery', { requestId: 'q19', id: 'D1', status: 'Delivered', note: 'sent', nowMs: 5 });
  assert.equal(s.ok, true, s.error);
  assert.equal(tables.deliveries.get('D1').status, 'Delivered');
  assert.ok(Date.parse(tables.deliveries.get('D1').delivered_at) > Date.now() - 60000, 'client nowMs ignored');
  assert.equal((await edge.api('setDelivery', { requestId: 'q20', id: 'D1', status: 'Nope' })).ok, false);
});

test('relay: an SMS with the R-reference auto-confirms the request and delivers the code', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  const c = await edge.api('createPayRequest', { requestId: 'q21', title: 'Gift card', amount: 500, productId: 'GC' });
  const r = await edge.relayIngest({ sender: '16247', text: smsR(500, 'R1', 'RSMS0001') }, 'bkash');
  assert.equal(r.matched, true, JSON.stringify(r));
  assert.equal(tables.pay_requests.get('R1').status, 'Paid');
  assert.equal(tables.payment_inbox.get('RSMS0001').status, 'Matched');
  assert.equal(tables.codes.get('GC-0001').status, 'Sold');
  assert.ok(tables.change_log.some(l => l.action === 'autoMatch'));
  assert.equal((await payGet(edge, '/pay/' + c.data.token + '/receipt')).status, 200);
});

test('relay sweeps expired requests before matching: an R-SMS for an expired link is not confirmed', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  await edge.api('createPayRequest', { requestId: 'q22', title: 'Gift card', amount: 500, productId: 'GC' });
  tables.pay_requests.get('R1').expires = new Date(Date.now() - 60000).toISOString();
  const r = await edge.relayIngest({ sender: '16247', text: smsR(500, 'R1', 'RSMS0002') }, 'bkash');
  assert.equal(r.matched, false);
  assert.equal(tables.pay_requests.get('R1').status, 'Expired');
  assert.equal(tables.codes.get('GC-0001').status, 'Available');
  assert.equal(tables.payment_inbox.get('RSMS0002').status, 'Pending');
});

test('auto-match applies a duplicate: an inbox row whose trx is already recorded becomes Matched', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  await edge.api('createPayRequest', { requestId: 'q23', title: 'Gift card', amount: 500, productId: 'GC' });
  await edge.api('gotPaidRequest', { requestId: 'q24', id: 'R1', trx: 'DUPE0001', method: 'bKash', amount: 500 });
  const pay0 = tables.payments.size;
  const r = await edge.relayIngest({ sender: '16247', text: smsR(500, 'R1', 'DUPE0001') }, 'bkash');
  assert.equal(r.result, 'stored');
  assert.equal(tables.payment_inbox.get('DUPE0001').status, 'Matched');
  assert.equal(tables.payments.size, pay0);
  assert.ok(tables.change_log.some(l => l.action === 'autoMatch'));
});

test('task5: /receipt is 200 for any Paid request (code only when live), 404 otherwise; /status carries delivery, never the code', async () => {
  const { edge, tables } = await boot(m => {
    withCodeProduct(m);
    m.products.push({ Product_ID: 'SEAT', Product_Name: 'Seat thing', Category: 'Streaming', Delivers_As: 'account', Letter: 'S', Default_Price: 300, Billing_Cycle_Days: 30, Active: 'Yes' });
    m.accounts.push({ Account_ID: 'SEAT-01', Product_ID: 'SEAT', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100, Cycle_Cost: 400 });
  });
  const code = await edge.api('createPayRequest', { requestId: 't5a', title: 'Gift card', amount: 500, productId: 'GC' });
  const seat = await edge.api('createPayRequest', { requestId: 't5b', title: 'Seat', amount: 300, productId: 'SEAT' });
  const plain = await edge.api('createPayRequest', { requestId: 't5c', title: 'Custom', amount: 80 });
  const stat = async t => (await payGet(edge, '/pay/' + t + '/status')).json();
  for (const t of [code.data.token, seat.data.token, plain.data.token]) {
    assert.equal((await payGet(edge, '/pay/' + t + '/receipt')).status, 404, 'not Paid');
    assert.equal((await stat(t)).delivery, '');
  }
  await edge.api('gotPaidRequest', { requestId: 't5d', id: 'R1', trx: 'T5TRX001', method: 'bKash', amount: 500 });
  await edge.api('gotPaidRequest', { requestId: 't5e', id: 'R2', trx: 'T5TRX002', method: 'bKash', amount: 300 });
  await edge.api('gotPaidRequest', { requestId: 't5f', id: 'R3', trx: 'T5TRX003', method: 'bKash', amount: 80 });
  assert.equal((await stat(code.data.token)).delivery, 'delivered');
  assert.equal((await stat(seat.data.token)).delivery, 'pending');
  assert.equal((await stat(plain.data.token)).delivery, '');
  // The owner marks the seat Delivered: status settles on 'delivered', still no code, receipt still 200.
  const sd = await edge.api('setDelivery', { requestId: 't5s', id: 'D2', status: 'Delivered' });
  assert.equal(sd.ok, true, sd.error);
  assert.equal((await stat(seat.data.token)).delivery, 'delivered');
  assert.equal((await (await payGet(edge, '/pay/' + seat.data.token + '/receipt')).json()).code, undefined);
  // A code delivery that goes back to Pending hides its code.
  tables.deliveries.get('D1').status = 'Pending';
  assert.equal((await stat(code.data.token)).delivery, 'pending');
  assert.equal((await (await payGet(edge, '/pay/' + code.data.token + '/receipt')).json()).code, undefined);
  tables.deliveries.get('D1').status = 'Delivered';
  const rc = await (await payGet(edge, '/pay/' + code.data.token + '/receipt')).json();
  assert.equal(rc.code, 'SECRET-AAAA-1111');
  for (const t of [seat.data.token, plain.data.token]) {
    const r = await payGet(edge, '/pay/' + t + '/receipt');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.code, undefined);
    assert.ok(Array.isArray(b.lines) && Array.isArray(b.links) && 'tos' in b);
  }
  // A failed code delivery: status says failed, receipt has no code.
  tables.deliveries.get('D1').status = 'Failed';
  const failed = await stat(code.data.token);
  assert.equal(failed.delivery, 'failed');
  assert.ok(!JSON.stringify(failed).includes('SECRET-AAAA-1111'));
  const rf = await payGet(edge, '/pay/' + code.data.token + '/receipt');
  assert.equal(rf.status, 200);
  assert.equal((await rf.json()).code, undefined);
  // A token that is a sale token or unknown is still 404; a Cancelled request never shows a code.
  assert.equal((await payGet(edge, '/pay/nosuchtoken0123456789/receipt')).status, 404);
});

test('task5: auto-match applies a duplicate even above the auto-match cap', async () => {
  const { edge, tables } = await boot(m => { withCodeProduct(m); m.settings.auto_match_max_bdt = '100'; });
  await edge.api('createPayRequest', { requestId: 't5g', title: 'Gift card', amount: 500, productId: 'GC' });
  await edge.api('gotPaidRequest', { requestId: 't5h', id: 'R1', trx: 'DUPE0099', method: 'bKash', amount: 500 });
  const pay0 = tables.payments.size;
  await edge.relayIngest({ sender: '16247', text: smsR(500, 'R1', 'DUPE0099') }, 'bkash');
  assert.equal(tables.payment_inbox.get('DUPE0099').status, 'Matched');
  assert.equal(tables.payments.size, pay0);
});

// ---- Phase 4: money dashboard actions ----
test('saveGoal, deleteGoal round-trip through the router; undo of saveGoal removes the goal', async () => {
  const { edge, tables } = await boot();
  const g = { requestId: 'g1', title: 'Q4 revenue', metric: 'revenue', target: 50000, start: '2026-10-01', end: '2026-12-31' };
  const a = await edge.api('saveGoal', g);
  assert.equal(a.ok, true, a.error);
  assert.ok(a.data.goalId);
  assert.ok(one(tables.goals, 'goal_id', a.data.goalId));
  const mo = await edge.api('moneyOverview', {});
  assert.equal(mo.data.goals.length, 1);
  assert.equal(mo.data.goals[0].goal.Goal_ID, a.data.goalId);
  assert.equal(typeof mo.data.goals[0].progress.pct, 'number');
  const u = await edge.api('undo', { requestId: 'g2' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.goals, 'goal_id', a.data.goalId), undefined);
  const b = await edge.api('saveGoal', Object.assign({}, g, { requestId: 'g3' }));
  const d = await edge.api('deleteGoal', { requestId: 'g4', goalId: b.data.goalId });
  assert.equal(d.ok, true, d.error);
  assert.equal(one(tables.goals, 'goal_id', b.data.goalId), undefined);
});

test('a goal with an impossible calendar date is refused', async () => {
  const { edge, tables } = await boot();
  const r = await edge.api('saveGoal', { requestId: 'g5', title: 'x', metric: 'revenue', target: 10, start: '2026-13-45', end: '2026-12-31' });
  assert.equal(r.ok, false);
  assert.match(r.error, /real calendar dates/);
  assert.equal(all(tables.goals).length, 0);
});

test('saveBudget and deleteBudget round-trip; moneyOverview shows budget progress', async () => {
  const { edge, tables } = await boot();
  const a = await edge.api('saveBudget', { requestId: 'b1', category: 'Account purchases', monthlyLimit: 5000 });
  assert.equal(a.ok, true, a.error);
  assert.ok(one(tables.budgets, 'budget_id', a.data.budgetId));
  const mo = await edge.api('moneyOverview', { month: '2026-10' });
  assert.equal(mo.data.budgets.length, 1);
  assert.equal(mo.data.budgets[0].progress.limit, 5000);
  const d = await edge.api('deleteBudget', { requestId: 'b2', budgetId: a.data.budgetId });
  assert.equal(d.ok, true, d.error);
  assert.equal(all(tables.budgets).length, 0);
});

test('a payload cannot inject nowMs or _gen into the planners', async () => {
  const { edge } = await boot();
  const r = await edge.api('saveGoal', { requestId: 'g6', title: 'x', metric: 'revenue', target: 10, start: '2026-10-01', end: '2026-12-31', nowMs: 1, _gen: { goal: 'nope' } });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.goalId, /^G\d+/);
});

test('moneyOverview with no month works and returns widgets, layout, goals, budgets', async () => {
  const { edge } = await boot();
  const r = await edge.api('moneyOverview', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.month, '2026-10');
  assert.deepEqual(r.data.layout, ['net', 'trend', 'cash', 'dues', 'products', 'forecast']);
  assert.ok(r.data.widgets.some(w => w.id === 'goals'));
  assert.deepEqual(r.data.goals, []);
  assert.deepEqual(r.data.budgets, []);
  assert.ok(Array.isArray(r.data.months) && r.data.months.includes('2026-10'));
  assert.deepEqual(r.data.months, (await edge.api('book', { month: '2026-10' })).data.months);
  const bad = await edge.api('moneyOverview', { month: '2026-1' });
  assert.deepEqual(bad, { ok: false, error: 'Month must look like 2026-10.' });
});

test('saveLayout saves the order; garbage in the setting falls back to the default', async () => {
  const { edge, tables } = await boot();
  const r = await edge.api('saveLayout', { requestId: 'l1', widgets: ['goals', 'net', 'bogus', 'net'] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual((await edge.api('moneyOverview', {})).data.layout, ['goals', 'net']);
  tables.settings.set('money_layout', 'bogus,,nothing');
  assert.deepEqual((await edge.api('moneyOverview', {})).data.layout, ['net', 'trend', 'cash', 'dues', 'products', 'forecast']);
  tables.settings.set('money_layout', '');
  assert.deepEqual((await edge.api('moneyOverview', {})).data.layout, ['net', 'trend', 'cash', 'dues', 'products', 'forecast']);
});

test('moneyExport returns RFC 4180 csv for each tab', async () => {
  const { edge } = await boot(m => { m.expenses.push({ Expense_ID: 'EX-9', Date: '2026-10-05', Category: 'Other', Amount: 10, Paid_With: 'bKash', Note: 'tea, "good"\nline2' }); });
  const book = await edge.api('moneyExport', { tab: 'book' });
  assert.equal(book.ok, true, book.error);
  assert.equal(book.data.filename, 'sales-tracker-book-2026-10.csv');
  assert.ok(book.data.csv.includes('"Other · tea, ""good""\nline2"'), book.data.csv);
  assert.ok(!book.data.csv.startsWith('﻿'));
  assert.ok(book.data.csv.split('\r\n')[0].startsWith('Date,'));
  const ov = await edge.api('moneyExport', { tab: 'overview', month: '2026-09' });
  assert.equal(ov.data.filename, 'sales-tracker-overview-2026-09.csv');
  const cash = await edge.api('moneyExport', { tab: 'cash' });
  assert.equal(cash.ok, true, cash.error);
  assert.equal(cash.data.csv.split('\r\n')[0], 'Method,In,Out,Balance');
  assert.equal((await edge.api('moneyExport', { tab: 'nope' })).ok, false);
});

test('moneyExport neutralises spreadsheet formulas in text but leaves numbers alone', async () => {
  const { edge } = await boot(m => {
    const c = m.customers.find(x => x.Name === 'jamilhq'); c.Name = '=HYPERLINK("x")';
    m.payments.push({ Payment_ID: 'PM-F1', Date: '2026-10-06', Customer_ID: c.Customer_ID, Sale_ID: '', Amount: 100, Method: 'bKash', Source: 'Manual' });
    m.expenses.push({ Expense_ID: 'EX-F2', Date: '2026-10-07', Category: 'Other', Amount: 450, Paid_With: 'bKash', Note: '' });
    ['-evil', '@x', '+1', ' =x', 'plain'].forEach((n, i) => m.expenses.push({ Expense_ID: 'EX-G' + i, Date: '2026-10-08', Category: n, Amount: 5, Paid_With: 'bKash', Note: '' }));
  });
  const csv = (await edge.api('moneyExport', { tab: 'book' })).data.csv;
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), csv);
  assert.ok(csv.includes(",'-evil,"), csv);
  assert.ok(csv.includes(",'@x,"), csv);
  assert.ok(csv.includes(",'+1,"), csv);
  assert.ok(csv.includes(",' =x,"), csv);
  assert.ok(csv.includes(',plain,'), csv);
  assert.ok(!/'\d/.test(csv.replace(/'[=+@-]/g, '')), 'no quote before plain numbers');
  const ov = (await edge.api('moneyExport', { tab: 'cash' })).data.csv;
  assert.ok(!/'-/.test(ov), 'negative numeric balances stay numbers');
  const ex = require('./load-core').Core;
  assert.equal(ex.exporter.safeCell(-450), -450);
  assert.equal(ex.exporter.safeCell('ok'), 'ok');
});

test('deleteGoal and deleteBudget can be undone', async () => {
  const { edge, tables } = await boot();
  const g = await edge.api('saveGoal', { requestId: 'u1', title: 'T', metric: 'revenue', target: 10, start: '2026-10-01', end: '2026-12-31' });
  const b = await edge.api('saveBudget', { requestId: 'u2', category: 'Account purchases', monthlyLimit: 100 });
  await edge.api('deleteGoal', { requestId: 'u3', goalId: g.data.goalId });
  assert.equal(one(tables.goals, 'goal_id', g.data.goalId), undefined);
  assert.equal((await edge.api('undo', { requestId: 'u4' })).ok, true);
  assert.ok(one(tables.goals, 'goal_id', g.data.goalId), 'goal restored');
  await edge.api('deleteBudget', { requestId: 'u5', budgetId: b.data.budgetId });
  assert.equal(one(tables.budgets, 'budget_id', b.data.budgetId), undefined);
  assert.equal((await edge.api('undo', { requestId: 'u6' })).ok, true);
  assert.ok(one(tables.budgets, 'budget_id', b.data.budgetId), 'budget restored');
});

test('saveLayout is not audited: Undo after a payment and a layout move still reverts the payment', async () => {
  const { edge, tables, m } = await boot();
  const p = await edge.api('pay', { requestId: 'ul1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal(p.ok, true, p.error);
  const logBefore = tables.change_log.length;
  const l = await edge.api('saveLayout', { requestId: 'ul2', widgets: ['goals', 'net'] });
  assert.equal(l.ok, true, l.error);
  assert.equal(tables.change_log.length, logBefore, 'layout writes no change_log line');
  const u = await edge.api('undo', { requestId: 'ul3' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.payments, 'payment_id', 'PM-00091'), undefined, 'the payment was reverted');
  assert.deepEqual((await edge.api('moneyOverview', {})).data.layout, ['goals', 'net'], 'the layout stays');
});

test('cash export is named for all time, without a month', async () => {
  const { edge } = await boot();
  const a = await edge.api('moneyExport', { tab: 'cash' });
  const b = await edge.api('moneyExport', { tab: 'cash', month: '2026-09' });
  assert.equal(a.data.filename, 'sales-tracker-cash-all-time.csv');
  assert.equal(b.data.filename, 'sales-tracker-cash-all-time.csv');
});

// ---- Fuse checks: phase 3 pay links against phase 1 rules, phase 4 money against Deleted accounts ----
test('fuse: a payment that confirmed a Paid pay link cannot be deleted by hand', async () => {
  const { edge, tables } = await boot(withCodeProduct);
  await edge.api('createPayRequest', { requestId: 'fz1', title: 'Gift card', amount: 500, productId: 'GC' });
  assert.equal((await edge.api('gotPaidRequest', { requestId: 'fz2', id: 'R1', trx: 'FUSE0001', method: 'bKash', amount: 500 })).ok, true);
  const pm = all(tables.payments).find(p => p.transaction_id === 'FUSE0001');
  const d = await edge.api('deletePayment', { requestId: 'fz3', paymentId: pm.payment_id });
  assert.equal(d.ok, false);
  assert.match(d.error, /confirmed pay link R1/);
  assert.ok(one(tables.payments, 'payment_id', pm.payment_id), 'payment kept');
});

test('fuse: Got paid for a seat product refuses a Deleted account', async () => {
  const { edge, tables } = await boot(m => {
    m.products.push({ Product_ID: 'SEAT', Product_Name: 'Seat thing', Category: 'Streaming', Delivers_As: 'account', Letter: 'S', Default_Price: 300, Unit_Cost: 100, Active: 'Yes' });
    m.accounts.push({ Account_ID: 'SEAT-01', Product_ID: 'SEAT', Slots: 4, Account_Status: 'Deleted', Cost_Per_Slot: 100, Cycle_Cost: 400 });
  });
  await edge.api('createPayRequest', { requestId: 'fz4', title: 'Seat', amount: 300, productId: 'SEAT' });
  const g = await edge.api('gotPaidRequest', { requestId: 'fz5', id: 'R1', trx: 'FUSE0002', method: 'bKash', amount: 300 });
  assert.equal(g.ok, false);
  assert.match(g.error, /No free seat/);
  assert.equal(tables.pay_requests.get('R1').status, 'Open');
});

test('fuse: deleting an account leaves money product profit unchanged and marks its row retired', async () => {
  const { edge, tables } = await boot(m => { m.sales.filter(x => x.Account_ID && x.Record_Status === 'Active').forEach(x => { x.Sale_Date = m.today; }); });
  const before = await edge.api('moneyOverview', {});
  assert.equal(before.ok, true, before.error);
  const row = (before.data.accounts || [])[0];
  assert.ok(row, 'the seed month has a profit-by-account row');
  tables.accounts.get(row.accountId).account_status = 'Deleted';
  const after = await edge.api('moneyOverview', {});
  assert.equal(after.ok, true, after.error);
  assert.equal(JSON.stringify(after.data.products), JSON.stringify(before.data.products));
  assert.equal(after.data.accounts.find(x => x.accountId === row.accountId).retired, true);
});

test('a client-sent _gen and nowMs are ignored on an old write action', async () => {
  const { edge, m } = await boot();
  const r = await edge.api('newSale', { requestId: 'gen1', productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'Kabir'), paidNow: { amount: 290, method: 'bKash' }, _gen: 'boom', nowMs: 1 });
  assert.equal(r.ok, true, r.error);
});

// ---- version token and notModified (init / home) ----
const versionOf = async (edge, action) => (await edge.api(action || 'init', {})).data.version;
const postIntent = (edge, token, body) => edge.handle(new Request('https://x.test/functions/v1/api/pay/' + token + '/intent',
  { method: 'POST', body: JSON.stringify(body) }));

test('version: init and home carry a version, and a repeated read keeps it', async () => {
  const { edge } = await boot();
  const a = await versionOf(edge), b = await versionOf(edge);
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.equal(a, b);
  assert.equal(await versionOf(edge, 'home'), a);
});

test('version: init with a matching ifNone issues exactly one statement and answers notModified', async () => {
  const { edge, db } = await boot();
  const v = await versionOf(edge);
  db.resetStats();
  const r = await edge.api('init', { ifNone: v });
  assert.deepEqual(r, { ok: true, data: { notModified: true, version: v } });
  assert.equal(db.stats.statements, 1);
  db.resetStats();
  assert.deepEqual((await edge.api('home', { ifNone: v })).data, { notModified: true, version: v });
  assert.equal(db.stats.statements, 1);
});

test('version: a stale or foreign ifNone gets the full answer with the current version', async () => {
  const { edge } = await boot();
  const r = await edge.api('init', { ifNone: 'not-the-version' });
  assert.equal(r.ok, true);
  assert.equal(r.data.notModified, undefined);
  assert.ok(r.data.lookups && r.data.home);
  assert.equal(r.data.version, await versionOf(edge));
  const h = await edge.api('home', { ifNone: 'x' });
  assert.ok(Array.isArray(h.data.renewSoon));
  assert.equal(typeof h.data.version, 'string');
});

test('version: a write through commit_ changes it (newSale, and log:false writes too)', async () => {
  const { edge, m } = await boot();
  const v0 = await versionOf(edge);
  const s = await edge.api('newSale', { requestId: 'v1', productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'Kabir'), paidNow: { amount: 290, method: 'bKash' } });
  assert.equal(s.ok, true, s.error);
  const v1 = await versionOf(edge);
  assert.notEqual(v1, v0);
  assert.notEqual((await edge.api('init', { ifNone: v0 })).data.notModified, true);
  // remindSent and saveLayout are logged with log:false, so change_log alone would miss them.
  const sale = m.sales.find(x => x.Customer_ID === cid(m, 'Kabir'));
  const r = await edge.api('remindSent', { requestId: 'v2', saleId: sale.Sale_ID, customerId: sale.Customer_ID, kind: 'before' });
  assert.equal(r.ok, true, r.error);
  const v2 = await versionOf(edge);
  assert.notEqual(v2, v1);
  const l = await edge.api('saveLayout', { requestId: 'v3', widgets: ['net'] });
  assert.equal(l.ok, true, l.error);
  assert.notEqual(await versionOf(edge), v2);
});

test('version: undo changes it', async () => {
  const { edge, m } = await boot();
  await edge.api('pay', { requestId: 'u1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  const v1 = await versionOf(edge);
  assert.equal((await edge.api('undo', { requestId: 'u2' })).ok, true);
  assert.notEqual(await versionOf(edge), v1);
});

test('version: a relay insert changes it', async () => {
  const { edge } = await boot();
  const v0 = await versionOf(edge);
  const r = await edge.relayIngest({ sender: '16247', text: smsR(250, 'ZZZ', 'VERS0001') }, 'bkash');
  assert.equal(r.result, 'stored');
  assert.notEqual(await versionOf(edge), v0);
});

test('version: a settings save changes it, even to a same-length value', async () => {
  const { edge } = await boot();
  const v0 = await versionOf(edge);
  assert.equal((await edge.api('settings', { requestId: 'vs1', values: { bkash_number: '01722222222' } })).ok, true);
  const v1 = await versionOf(edge);
  assert.notEqual(v1, v0);
  assert.equal((await edge.api('settings', { requestId: 'vs2', values: { bkash_number: '01733333333' } })).ok, true);
  assert.notEqual(await versionOf(edge), v1);
});

test('version: a pay-intent POST changes it, and so does a second one in the same minute', async () => {
  const { edge } = await boot(withCodeProduct);
  const made = await edge.api('createPayRequest', { requestId: 'vi0', title: 'Gift card', amount: 500, productId: 'GC' });
  assert.equal(made.ok, true, made.error);
  const v0 = await versionOf(edge);
  const a = await postIntent(edge, made.data.token, { method: 'bkash', number: '01711223344' });
  assert.equal(a.status, 200);
  const v1 = await versionOf(edge);
  assert.notEqual(v1, v0);
  const b = await postIntent(edge, made.data.token, { method: 'bkash', number: '01711223344', claimed: true, trx: 'CLAIM001' });
  assert.equal(b.status, 200);
  assert.notEqual(await versionOf(edge), v1);
});

test('version: a rate refresh changes it', async () => {
  const { db, tables } = await boot();
  const edge = loadEdge(db, { fetchAds: async () => [{ price: '120' }, { price: '121' }, { price: '122' }] });
  const v0 = await versionOf(edge, 'home');
  const r = await edge.api('refreshRate', {});
  assert.equal(r.ok, true, r.error);
  assert.ok(tables.live_rates.get('usdt_bdt'));
  assert.notEqual(await versionOf(edge, 'home'), v0);
});

test('version: it cannot be reused across a Dhaka date change', async () => {
  const { db } = await boot();
  const day1 = loadEdge(db, { today: '2026-10-18' }), day2 = loadEdge(db, { today: '2026-10-19' });
  const v1 = await versionOf(day1);
  assert.notEqual(await versionOf(day2), v1);
  assert.notEqual((await day2.api('init', { ifNone: v1 })).data.notModified, true);
});

test('version: time-based inputs change it (open request expiry, rate going stale)', async () => {
  const { db, tables, edge } = await boot(withCodeProduct);
  const Adapter = require('../src/adapters/postgres.js');
  const made = await edge.api('createPayRequest', { requestId: 'vt0', title: 'Gift card', amount: 500, productId: 'GC' });
  assert.equal(made.ok, true, made.error);
  const exp = Date.parse(tables.pay_requests.get('R1').expires);
  const ctx = ms => ({ today: '2026-10-18', nowMs: ms, freshMs: 300000 });
  assert.equal(await Adapter.readVersion(db, ctx(exp - 1000)), await Adapter.readVersion(db, ctx(exp - 500)));
  assert.notEqual(await Adapter.readVersion(db, ctx(exp - 1000)), await Adapter.readVersion(db, ctx(exp + 1000)));
  const at = Date.now();
  tables.live_rates.set('usdt_bdt', { id: 'usdt_bdt', rate: 125, fetched_at: new Date(at).toISOString() });
  assert.notEqual(await Adapter.readVersion(db, ctx(at + 60000)), await Adapter.readVersion(db, ctx(at + 600000)));
  const b = (Math.floor((at + 600000) / 300000) + 1) * 300000;   // inside one retry bucket, stale stays stable
  assert.equal(await Adapter.readVersion(db, ctx(b + 1000)), await Adapter.readVersion(db, ctx(b + 2000)));
});

test('version: other reads ignore ifNone and carry no version', async () => {
  const { edge } = await boot();
  const r = await edge.api('dues', { ifNone: 'anything' });
  assert.equal(r.ok, true);
  assert.equal(r.data.notModified, undefined);
  assert.equal(r.data.version, undefined);
});

// ---- init does the housekeeping itself (snapshot-if-due, stale-rate refresh), once ----
test('init: refreshes a stale rate once, returns it in lookups and housekeeping, and the version moves with it', async () => {
  const { db, tables } = await boot();
  let fetches = 0;
  const edge = loadEdge(db, { fetchAds: async () => { fetches++; return [{ price: '120' }, { price: '121' }, { price: '122' }]; } });
  const r = await edge.api('init', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(fetches, 1);
  assert.equal(r.data.housekeeping.rate.refreshed, true);
  assert.equal(r.data.lookups.rate.rate, 121);
  assert.equal(r.data.lookups.rate.stale, false);
  assert.ok(tables.live_rates.get('usdt_bdt'));
  // The returned version is the one AFTER the refresh: sending it back is a hit, and nothing is fetched again.
  const again = await edge.api('init', { ifNone: r.data.version });
  assert.deepEqual(again.data, { notModified: true, version: r.data.version });
  const third = await edge.api('init', {});
  assert.equal(fetches, 1);
  assert.equal(third.data.version, r.data.version);
  assert.equal(third.data.housekeeping.rate.refreshed, false);
});

test('init: a failed rate fetch still answers, and a manual rate is never fetched', async () => {
  const { db } = await boot();
  let fetches = 0;
  const bad = loadEdge(db, { fetchAds: async () => { fetches++; throw new Error('down'); } });
  const r = await bad.api('init', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(fetches, 1);
  assert.equal(r.data.housekeeping.rate.refreshed, false);
  assert.ok(r.data.lookups && r.data.home && typeof r.data.version === 'string');
  const { db: db2 } = await boot(m => { m.settings = Object.assign({}, m.settings, { usdt_bdt_manual: '130' }); });
  const manual = loadEdge(db2, { fetchAds: async () => { fetches++; return []; } });
  await manual.api('init', {});
  assert.equal(fetches, 1);
});

test('init: snapshot-if-due runs inside init and reports it; a second init does not create another', async () => {
  const { db, tables } = await boot();
  const r = await loadEdge(db).api('init', {});
  assert.equal(r.ok, true, r.error);
  const hs = r.data.housekeeping.snapshot;
  assert.equal(typeof hs.month, 'string');
  const n = tables.profit_snapshots ? tables.profit_snapshots.size : 0;
  const r2 = await loadEdge(db).api('init', {});
  assert.equal(r2.data.housekeeping.snapshot.created, false);
  assert.equal(tables.profit_snapshots ? tables.profit_snapshots.size : 0, n);
});

test('init: a notModified answer does no housekeeping and fetches nothing', async () => {
  const { db } = await boot();
  let fetches = 0;
  const edge = loadEdge(db, { fetchAds: async () => { fetches++; return [{ price: '120' }]; } });
  const v = (await edge.api('init', {})).data.version;
  fetches = 0;
  db.resetStats();
  const r = await edge.api('init', { ifNone: v });
  assert.equal(r.data.notModified, true);
  assert.equal(fetches, 0);
  assert.equal(db.stats.statements, 1);
});

test('version: the build stamp is part of it (different stamps differ, same stamp is stable, default is dev)', async () => {
  const { db } = await boot();
  const Adapter = require('../src/adapters/postgres.js');
  const ctx = build => Object.assign({ today: '2026-10-18', nowMs: 1000, freshMs: 300000 }, build === undefined ? {} : { build });
  const a = await Adapter.readVersion(db, ctx('aaa'));
  assert.equal(a, await Adapter.readVersion(db, ctx('aaa')));
  assert.notEqual(a, await Adapter.readVersion(db, ctx('bbb')));
  assert.equal(await Adapter.readVersion(db, ctx()), await Adapter.readVersion(db, ctx('dev')));
});

test('version: a stale rate is retried about every freshMs, a fresh one is not', async () => {
  const { db, tables } = await boot();
  const Adapter = require('../src/adapters/postgres.js');
  const ctx = ms => ({ today: '2026-10-18', nowMs: ms, freshMs: 300000 });
  tables.live_rates.clear();
  const t = 10 * 300000;
  assert.equal(await Adapter.readVersion(db, ctx(t + 1000)), await Adapter.readVersion(db, ctx(t + 2000)));
  assert.notEqual(await Adapter.readVersion(db, ctx(t + 1000)), await Adapter.readVersion(db, ctx(t + 300000 + 1000)));
});

// Stage 1 (inline-edit design D3): a write response says whether it wrote a change_log batch, so the panel offers Undo only for real changes.
test('a write response reports changed: true when it wrote a batch, false for a no-op or an unlogged write', async () => {
  const { edge, m } = await boot();
  const c = m.customers.find(x => x.Name === 'jamilhq');
  const first = await edge.api('edit', { requestId: 'chg-1', kind: 'customer', id: c.Customer_ID, values: { Name: 'renamed-chg' } });
  assert.equal(first.ok, true);
  assert.equal(first.data.changed, true);
  const same = await edge.api('edit', { requestId: 'chg-2', kind: 'customer', id: c.Customer_ID, values: {} });
  assert.equal(same.ok, true);
  assert.equal(same.data.changed, false, 'a no-op edit writes no batch');
  const layout = await edge.api('saveLayout', { requestId: 'chg-3', widgets: ['net'] });
  assert.equal(layout.ok, true);
  assert.equal(layout.data.changed, false, 'saveLayout is not logged, so there is nothing to undo');
});

// Stage 1b (review item 5): applyOps says whether it wrote a change_log batch, which decides `changed` for a write.
test('applyOps reports logged only when a change_log batch was written', async () => {
  const { db, m } = await boot();
  const Adapter = require('../src/adapters/postgres.js');
  const c = m.customers.find(x => x.Name === 'jamilhq');
  const empty = await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: c.Customer_ID, values: {} }], { batchId: 'e1', action: 'edit', log: true });
  assert.deepEqual(empty, { changes: 0, logged: false }, 'an update with no fields writes nothing and logs nothing');
  const real = await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: c.Customer_ID, values: { Name: 'logged-name' } }], { batchId: 'e2', action: 'edit', log: true });
  assert.deepEqual(real, { changes: 1, logged: true });
  const unlogged = await Adapter.applyOps(db, [{ op: 'update', tab: 'Customers', id: c.Customer_ID, values: { Name: 'quiet-name' } }], { batchId: 'e3', action: 'edit', log: false });
  assert.deepEqual(unlogged, { changes: 1, logged: false }, 'log:false writes the row and no batch');
});

// Stage 1c: batch-scoped Undo. A logged write answers with the batchId it wrote; Undo with that batchId reverts only
// while that batch is still the newest one that Undo can reverse, and otherwise refuses without changing anything.
const STALE_UNDO = 'Something else changed since. Open the history to undo it.';
test('a logged write answers with the batchId it wrote; a no-op or unlogged write has none', async () => {
  const { edge, tables, m } = await boot();
  const c = m.customers.find(x => x.Name === 'jamilhq');
  const first = await edge.api('edit', { requestId: 'bid-1', kind: 'customer', id: c.Customer_ID, values: { Name: 'bid-name' } });
  assert.equal(first.ok, true, first.error);
  assert.equal(typeof first.data.batchId, 'string');
  assert.ok(first.data.batchId.length > 0);
  assert.ok(all(tables.change_log).some(r => r.batch_id === first.data.batchId), 'the batchId is the one written to change_log');
  const same = await edge.api('edit', { requestId: 'bid-2', kind: 'customer', id: c.Customer_ID, values: {} });
  assert.equal(same.data.batchId, undefined, 'a no-op writes no batch, so it has no batchId');
  const layout = await edge.api('saveLayout', { requestId: 'bid-3', widgets: ['net'] });
  assert.equal(layout.data.batchId, undefined, 'an unlogged write has no batchId');
});

test('undo with the batchId of the newest batch reverts exactly that batch', async () => {
  const { edge, tables, m } = await boot();
  const p = await edge.api('pay', { requestId: 'ub-1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal(p.ok, true, p.error);
  assert.ok(one(tables.payments, 'payment_id', 'PM-00091'));
  const u = await edge.api('undo', { requestId: 'ub-2', batchId: p.data.batchId });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.payments, 'payment_id', 'PM-00091'), undefined, 'the matching batch is reverted');
});

test('undo with a stale batchId refuses and changes nothing', async () => {
  const { edge, tables, m } = await boot();
  const p = await edge.api('pay', { requestId: 'us-1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal(p.ok, true, p.error);
  const other = await edge.api('edit', { requestId: 'us-2', kind: 'customer', id: cid(m, 'jamilhq'), values: { Notes: 'written after the pay' } });
  assert.equal(other.ok, true, other.error);
  const logBefore = all(tables.change_log).length;
  const u = await edge.api('undo', { requestId: 'us-3', batchId: p.data.batchId });
  assert.deepEqual(u, { ok: false, error: STALE_UNDO });
  assert.ok(one(tables.payments, 'payment_id', 'PM-00091'), 'the payment is still there: no partial revert');
  assert.equal(all(tables.change_log).length, logBefore, 'nothing was written to the log');
});

test('a batchId that was already undone refuses; so does one when nothing is left to undo', async () => {
  const { edge, m } = await boot();
  const p = await edge.api('pay', { requestId: 'ud-1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  assert.equal((await edge.api('undo', { requestId: 'ud-2', batchId: p.data.batchId })).ok, true);
  assert.deepEqual(await edge.api('undo', { requestId: 'ud-3', batchId: p.data.batchId }), { ok: false, error: STALE_UNDO });
  assert.deepEqual(await edge.api('undo', { requestId: 'ud-4', batchId: p.data.batchId }), { ok: false, error: STALE_UNDO });
});

test('a replayed write returns the stored response, batchId included', async () => {
  const { edge, m } = await boot();
  const payload = { requestId: 'ur-1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' };
  const a = await edge.api('pay', payload);
  const b = await edge.api('pay', payload);
  assert.ok(a.data.batchId, 'the first answer carries a batchId');
  assert.equal(b.data.batchId, a.data.batchId, 'the replay carries the same batchId');
  assert.deepEqual(b, a);
});

test('a plain undo without a batchId still reverts the newest batch (the Today button)', async () => {
  const { edge, tables, m } = await boot();
  await edge.api('pay', { requestId: 'up-1', customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' });
  await edge.api('edit', { requestId: 'up-2', kind: 'customer', id: cid(m, 'jamilhq'), values: { Notes: 'newest' } });
  const u = await edge.api('undo', { requestId: 'up-3' });
  assert.equal(u.ok, true, u.error);
  assert.ok(one(tables.payments, 'payment_id', 'PM-00091'), 'the newest batch (the note) was the one reverted, not the payment');
});

test('editPayment that splits a credit row: one Undo reverts the payment and the split-off credit row together', async () => {
  const { edge, tables } = await boot(s => {
    const sale54 = s.sales.find(x => x.Sale_ID === 54);
    s.sales.push(Object.assign({}, sale54, { Sale_ID: 990, Unit_Price: 300, Qty: 1, Months: 1, Record_Status: 'Active', Code_ID: '' }));
    s.payments.push({ Payment_ID: 'PM-CR1', Date: '2026-10-18', Customer_ID: sale54.Customer_ID, Sale_ID: '', Amount: 800, Method: 'bKash',
      Transaction_ID: '', Source: 'App', Note: '' });
  });
  const customerId = one(tables.payments, 'payment_id', 'PM-CR1').customer_id;
  const credits = () => all(tables.payments).filter(p => String(p.customer_id) === String(customerId) && !p.sale_id && Number(p.amount) > 0);
  const before = credits().length;
  const e = await edge.api('editPayment', { requestId: 'sp1', paymentId: 'PM-CR1', saleId: 990 });
  assert.equal(e.ok, true, e.error);
  assert.equal(String(one(tables.payments, 'payment_id', 'PM-CR1').sale_id), '990');
  assert.equal(Number(one(tables.payments, 'payment_id', 'PM-CR1').amount), 300, 'the sale takes 300');
  assert.equal(credits().length, before, 'the 500 excess is a new credit row (the old row is now on the sale)');
  assert.equal(credits().filter(p => Number(p.amount) === 500).length, 1);
  const u = await edge.api('undo', { requestId: 'sp2' });
  assert.equal(u.ok, true, u.error);
  const back = one(tables.payments, 'payment_id', 'PM-CR1');
  assert.ok(!back.sale_id, 'the payment is credit again');
  assert.equal(Number(back.amount), 800, 'the amount is restored');
  assert.equal(credits().filter(p => Number(p.amount) === 500).length, 0, 'the split-off credit row is gone');
  assert.equal(credits().length, before);
});

// ---------------------------------------------------------------- split match and custom sale (split-match plan, Task 5)

/** Netflix line N44 (Unit_Price 300, paid till 2026-10-09) and inbox row DJP2JBSWHA = 1,200 Tk, received 2026-10-25. */
async function splitBoot(extra) {
  return boot(m => {
    const line = m.sales.find(s => s.Sub_Code === 'N44');
    line.Unit_Price = 300;
    line.Paid_Till = '2026-10-09';
    m.inbox.push({ Received: '2026-10-25 21:06', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 1200,
      Transaction_ID: 'DJP2JBSWHA', Reference: '', Status: 'Pending', Matched_Sale_ID: '',
      Raw_SMS: 'Cash In Tk 1,200.00 from 01XXXXXXXXX successful TrxID DJP2JBSWHA' });
    if (extra) extra(m);
  });
}
const splitPayload = (m, over) => Object.assign({ trx: 'DJP2JBSWHA', customerId: m.sales.find(s => s.Sub_Code === 'N44').Customer_ID,
  targets: [{ kind: 'renew', subCode: 'N44', months: 2, price: 300, from: 'oldPaidTill', paidTill: '2026-11-09' },
    { kind: 'custom', title: 'Tinder Premium', price: 600, cost: 450 }], creditRest: false }, over || {});

test('split match: one payment covers a renewal and a custom item, in one batch', async () => {
  const { edge, tables, m } = await splitBoot();
  const r = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm1' }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.changed, true);
  assert.deepEqual(r.data.renewedSubCodes, ['N44']);
  assert.equal(r.data.saleIds.length, 2);
  assert.equal(r.data.credit, 0);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'DJP2JBSWHA').status, 'Matched');
  const pays = where(tables.payments, 'transaction_id', 'DJP2JBSWHA');
  assert.equal(pays.length, 2);
  assert.equal(pays.reduce((a, p) => a + Number(p.amount), 0), 1200);
  assert.deepEqual(new Set(all(tables.change_log).map(x => x.batch_id)), new Set([r.data.batchId]), 'every line is in one batch');
});

test('split match: a repeated requestId answers the first time and writes nothing again', async () => {
  const { edge, tables, m } = await splitBoot();
  const a = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm2' }));
  const b = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm2' }));
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(b, a);
  assert.equal(where(tables.payments, 'transaction_id', 'DJP2JBSWHA').length, 2);
});

test('split match: the same payment with a different requestId is Already recorded, not booked twice', async () => {
  const { edge, tables, m } = await splitBoot();
  assert.equal((await edge.api('splitMatch', splitPayload(m, { requestId: 'sm3a' }))).ok, true);
  const again = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm3b' }));
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.message, 'Already recorded');
  assert.equal(where(tables.payments, 'transaction_id', 'DJP2JBSWHA').length, 2);
});

test('split match: an unassigned remainder fails and leaves every table unchanged', async () => {
  const { edge, tables, m } = await splitBoot();
  const salesBefore = all(tables.sales).length, paysBefore = all(tables.payments).length;
  const r = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm4', targets: [{ kind: 'custom', title: 'Tinder Premium', price: 450 }] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /৳750 of the payment is not assigned/);
  assert.equal(all(tables.sales).length, salesBefore);
  assert.equal(all(tables.payments).length, paysBefore);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'DJP2JBSWHA').status, 'Pending');
});

test('split match: one undo reverts the renewal, custom item, payments and inbox together', async () => {
  const { edge, tables, m } = await splitBoot();
  const oldSale = m.sales.find(s => s.Sub_Code === 'N44').Sale_ID;
  const r = await edge.api('splitMatch', splitPayload(m, { requestId: 'sm5' }));
  assert.equal(r.ok, true, r.error);
  const u = await edge.api('undo', { requestId: 'sm5u', batchId: r.data.batchId });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.sales, 'sale_id', oldSale).record_status, 'Active');
  assert.equal(where(tables.sales, 'sub_code', 'N44').length, 1, 'the renewal row is gone');
  assert.equal(where(tables.sales, 'product_id', 'CUSTOM').length, 0, 'the custom row is gone');
  assert.equal(where(tables.payments, 'transaction_id', 'DJP2JBSWHA').length, 0);
  assert.equal(one(tables.payment_inbox, 'transaction_id', 'DJP2JBSWHA').status, 'Pending');
});

test('split match: a new customer is created in the same batch and removed by one undo', async () => {
  const { edge, tables } = await splitBoot();
  const payload = { trx: 'DJP2JBSWHA', newCustomer: { name: 'Split Newbie' }, creditRest: false,
    targets: [{ kind: 'custom', title: 'Tinder Premium', price: 600 }, { kind: 'custom', title: 'Spotify', price: 600 }], requestId: 'sm6' };
  const r = await edge.api('splitMatch', payload);
  assert.equal(r.ok, true, r.error);
  assert.equal(where(tables.customers, 'name', 'Split Newbie').length, 1);
  const u = await edge.api('undo', { requestId: 'sm6u', batchId: r.data.batchId });
  assert.equal(u.ok, true, u.error);
  assert.equal(where(tables.customers, 'name', 'Split Newbie').length, 0);
});

test('split match: an unknown payment message is refused', async () => {
  const { edge, m } = await splitBoot();
  const r = await edge.api('splitMatch', splitPayload(m, { trx: 'NOPE1', requestId: 'sm7' }));
  assert.deepEqual(r, { ok: false, error: 'That payment message is no longer in the inbox.' });
});

test('custom sale: saved with its payment, and one undo removes both', async () => {
  const { edge, tables, m } = await boot();
  const r = await edge.api('customSale', { requestId: 'cs1', customerId: cid(m, 'Kabir'), title: 'Tinder Premium', price: 600, cost: 450,
    date: '2026-10-25', paidNow: { amount: 600, method: 'bKash', trxId: 'TXC1' } });
  assert.equal(r.ok, true, r.error);
  const sale = one(tables.sales, 'sale_id', r.data.saleId);
  assert.equal(sale.product_id, 'CUSTOM');
  assert.equal(sale.notes, 'Tinder Premium');
  assert.equal(where(tables.payments, 'sale_id', r.data.saleId).length, 1);
  const u = await edge.api('undo', { requestId: 'cs1u' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(tables.sales, 'sale_id', r.data.saleId), undefined);
  assert.equal(where(tables.payments, 'transaction_id', 'TXC1').length, 0);
});

test('a client-sent _rand is dropped before the planner runs', async () => {
  const { edge, tables, m } = await boot();
  const r = await edge.api('customSale', { requestId: 'cs2', title: 'Rand item', price: 100, _rand: () => 0,
    newCustomer: { name: 'Rand Buyer' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(where(tables.customers, 'name', 'Rand Buyer').length, 1);
  assert.ok(m);
});

// ---- migration panel actions ----
const STAGE_ROWS = [
  { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', collected: 300, cost: 900, renewalDate: '2026-11-20', slots: 3 } },
  { id: 'imp:S:L1', kind: 'line', sheet: 'S', ref: 'L1', data: { accountRef: 'imp:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20' } }
];
const stage = (edge, extra) => edge.api('importStage', Object.assign({ requestId: 'stage1', batch: 'imp', rows: STAGE_ROWS }, extra));
const approveAll = (edge) => edge.api('importStatus', { requestId: 'appr1', rowIds: STAGE_ROWS.map(r => r.id), status: 'Approved' });

test('migration actions need the app secret', async () => {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const guarded = loadEdge(db, { env: { APP_SECRET: 'unit-secret' } });
  const post = (headers) => guarded.handle(new Request('https://x.test/functions/v1/api/', { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify({ action: 'importStage', payload: { batch: 'x', rows: STAGE_ROWS } }) }));
  assert.equal((await post()).status, 401);
  assert.equal((await post({ 'X-App-Secret': 'wrong' })).status, 401);
  assert.equal(tables.import_rows.size, 0);
  assert.equal((await post({ 'X-App-Secret': 'unit-secret' })).status, 200);
  assert.equal(tables.import_rows.size, 2);
});

test('importStage then importReview shows the rows, and staging twice adds nothing', async () => {
  const { edge, tables } = await boot();
  const a = await stage(edge);
  assert.equal(a.ok, true, a.error);
  assert.equal(a.data.added, 2);
  const again = await stage(edge, { requestId: 'stage2' });
  assert.equal(again.data.added, 0);
  assert.equal(again.data.skipped, 2);
  assert.equal(tables.import_rows.size, 2);
  const r = await edge.api('importReview', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.batch, 'imp');
  assert.deepEqual(r.data.batches, [{ batch: 'imp', rows: 2, applied: 0 }]);
  assert.equal(r.data.accounts.length, 1);
  assert.equal(r.data.accounts[0].lines[0].data.name, 'Synthetic Person');
  assert.equal(r.data.accounts[0].sheetCollected, 300);
});

test('importStage refuses more than 2000 rows and credentials', async () => {
  const { edge, tables } = await boot();
  const many = Array.from({ length: 2001 }, (_, i) => ({ id: 'm' + i, kind: 'code', data: { code: 'C' + i } }));
  assert.deepEqual(await edge.api('importStage', { batch: 'big', rows: many }), { ok: false, error: 'Send at most 2000 rows at a time.' });
  const cred = await edge.api('importStage', { batch: 'c', rows: [{ id: 'c1', kind: 'line', data: { name: 'x', login: 'someone@example.test' } }] });
  assert.equal(cred.ok, false);
  assert.match(cred.error, /never staged/);
  assert.equal(tables.import_rows.size, 0);
});

test('Approved rows apply into a customer and a sale, and are marked Applied', async () => {
  const { edge, tables } = await boot();
  await stage(edge);
  const customersBefore = all(tables.customers).length, salesBefore = all(tables.sales).length;
  const ap = await approveAll(edge);
  assert.equal(ap.ok, true, ap.error);
  const r = await edge.api('importApply', { requestId: 'apply1', batch: 'imp' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.message, 'Applied 2 rows');
  assert.equal(all(tables.customers).length, customersBefore + 1);
  assert.equal(all(tables.sales).length, salesBefore + 1);
  assert.equal(where(tables.customers, 'name', 'Synthetic Person').length, 1);
  assert.deepEqual(all(tables.import_rows).map(x => x.status), ['Applied', 'Applied']);
  assert.ok(r.data.changed && r.data.batchId);
});

test('importApply with the same requestId applies once', async () => {
  const { edge, tables } = await boot();
  await stage(edge); await approveAll(edge);
  const a = await edge.api('importApply', { requestId: 'apply-same', batch: 'imp' });
  const salesAfter = all(tables.sales).length, custAfter = all(tables.customers).length;
  const b = await edge.api('importApply', { requestId: 'apply-same', batch: 'imp' });
  assert.deepEqual(b, a);
  assert.equal(all(tables.sales).length, salesAfter);
  assert.equal(all(tables.customers).length, custAfter);
  // a new request id finds nothing left to apply
  const c = await edge.api('importApply', { requestId: 'apply-other', batch: 'imp' });
  assert.deepEqual(c, { ok: false, error: 'No approved rows to apply.' });
});

test('undo after importApply removes the created sale and returns the rows to Approved', async () => {
  const { edge, tables } = await boot();
  await stage(edge); await approveAll(edge);
  const customersBefore = all(tables.customers).length, salesBefore = all(tables.sales).length, paymentsBefore = all(tables.payments).length;
  const ap = await edge.api('importApply', { requestId: 'apply-undo', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  assert.equal(all(tables.sales).length, salesBefore + 1);
  const u = await edge.api('undo', { requestId: 'undo1', batchId: ap.data.batchId });
  assert.equal(u.ok, true, u.error);
  assert.equal(all(tables.sales).length, salesBefore);
  assert.equal(all(tables.customers).length, customersBefore);
  assert.equal(all(tables.payments).length, paymentsBefore);
  assert.deepEqual(all(tables.import_rows).map(x => x.status), ['Approved', 'Approved']);
});

test('importEdit, importAdd and importDelete change the staged rows', async () => {
  const { edge, tables } = await boot();
  await stage(edge);
  const e = await edge.api('importEdit', { requestId: 'e1', rowId: 'imp:S:L1', data: { amount: 250 }, note: 'checked' });
  assert.equal(e.ok, true, e.error);
  assert.equal(JSON.parse(one(tables.import_rows, 'row_id', 'imp:S:L1').data).amount, 250);
  assert.equal(one(tables.import_rows, 'row_id', 'imp:S:L1').note, 'checked');
  const bad = await edge.api('importEdit', { requestId: 'e2', rowId: 'imp:S:L1', match: { customerId: 'NOPE' } });
  assert.equal(bad.ok, false);
  const ad = await edge.api('importAdd', { requestId: 'a1', batch: 'imp', kind: 'extra', data: { accountRef: 'imp:S:A1', amount: 40 } });
  assert.equal(ad.ok, true, ad.error);
  assert.equal(ad.data.rowId, 'imp:manual-1');
  assert.equal(tables.import_rows.size, 3);
  const d = await edge.api('importDelete', { requestId: 'd1', rowId: 'imp:manual-1' });
  assert.equal(d.ok, true, d.error);
  assert.equal(tables.import_rows.size, 2);
});

test('profitMonthly: bad range answers with the core text, a good one has the month shape', async () => {
  const { edge } = await boot();
  assert.deepEqual(await edge.api('profitMonthly', { from: 'oct', to: '2026-10' }), { ok: false, error: 'From and to must be months like 2026-10.' });
  assert.deepEqual(await edge.api('profitMonthly', { from: '2026-10', to: '2026-08' }), { ok: false, error: 'From must not be after to.' });
  assert.deepEqual(await edge.api('profitMonthly', { from: '2024-01', to: '2026-10' }), { ok: false, error: 'A range can cover at most 24 months.' });
  const ok = await edge.api('profitMonthly', { from: '2026-08', to: '2026-10' });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.data.months.map(x => x.month), ['2026-08', '2026-09', '2026-10']);
  const m = ok.data.months[2];
  for (const k of ['revenue', 'cost', 'profit', 'collected']) assert.equal(typeof m[k], 'number', k);
  assert.ok(Array.isArray(m.byProduct) && Array.isArray(m.byAccount) && Array.isArray(ok.data.costMissing));
});

test('insights: needs the secret, rejects bad ranges with plain text, and answers the documented shape', async () => {
  const { makeFakeDb: mk } = require('./support/fake-db');
  const { db, tables } = mk();
  await seedDb(db, tables, makeUiState());
  const guarded = loadEdge(db, { env: { APP_SECRET: 's3cret-value' } });
  const req = (body, secret) => new Request('https://x.test/functions/v1/api/', { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, secret ? { 'X-App-Secret': secret } : {}), body: JSON.stringify(body) });
  assert.equal((await guarded.handle(req({ action: 'insights', payload: {} }))).status, 401);
  const good = await guarded.handle(req({ action: 'insights', payload: {} }, 's3cret-value'));
  assert.equal(good.status, 200);

  const { edge } = await boot();
  const err = async p => { const r = await edge.api('insights', p); assert.equal(r.ok, false); return r.error; };
  assert.equal(await err({ from: 'soon', to: '2026-10-18' }), 'From must be a date like 2026-10-18.');
  assert.equal(await err({ from: '2026-02-31', to: '2026-10-18' }), 'From must be a date like 2026-10-18.');
  assert.equal(await err({ from: '2026-09-01', to: '10/18/2026' }), 'To must be a date like 2026-10-18.');
  assert.equal(await err({ from: '2026-10-18', to: '2026-10-01' }), 'From must not be after To.');
  assert.equal(await err({ from: '2024-01-01', to: '2026-10-18' }), 'Pick a range of 24 months or less.');

  const ok = await edge.api('insights', { from: '2026-09-01', to: '2026-10-31' });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(Object.keys(ok.data), ['range', 'months', 'kpis', 'byCategory', 'topCustomers', 'forecast', 'retention', 'methodMix']);
  assert.deepEqual(ok.data.range, { from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual(ok.data.months.map(m => m.month), ['2026-09', '2026-10']);
  const dflt = await edge.api('insights', {});
  assert.equal(dflt.ok, true);
  assert.equal(dflt.data.months.length, 13);
});

test('inbox: rows are bounded to open messages and the last 90 days, newest first, with the counts', async () => {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  const base = st.inbox[0];
  const msg = (trx, received, status) => Object.assign({}, base, { Transaction_ID: trx, Received: received, Status: status, Raw_SMS: 'sms ' + trx });
  st.inbox = st.inbox.concat([
    msg('NEW1', '2026-10-17 09:00', 'Matched'),
    msg('OLD-MATCH', '2026-06-01 09:00', 'Matched'),
    msg('OLD-OPEN', '2026-06-01 09:00', 'Pending'),
    msg('EDGE90', '2026-07-20 09:00', 'Matched')
  ]);
  st.payments.push(Object.assign({}, st.payments[0], { Payment_ID: 'PM-AUTO1', Transaction_ID: 'NEW1', Source: 'Auto', Date: '2026-10-17' }));
  await seedDb(db, tables, st);
  const edge = loadEdge(db);

  const r = await edge.api('inbox', {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.data).sort(), ['counts', 'matching', 'rows', 'truncated']);
  assert.deepEqual(r.data.rows.map(x => x.trx), ['TESTTRX1', 'NEW1', 'EDGE90', 'OLD-OPEN'], 'newest first; OLD-MATCH is past 90 days and not open');
  assert.deepEqual(r.data.counts, { total: 4, Pending: 2, Review: 0, Matched: 1, 'Auto-matched': 1, Ignored: 0 });
  assert.equal(r.data.matching, 4);
  assert.equal(r.data.truncated, false);
  assert.equal(r.data.rows.find(x => x.trx === 'NEW1').status, 'Auto-matched');
  assert.equal(r.data.rows.find(x => x.trx === 'TESTTRX1').matchable, true);
  assert.equal(JSON.stringify(r.data).indexOf('sms '), -1, 'the raw SMS is not sent in the list');

  const trxsOf = async p => (await edge.api('inbox', p)).data.rows.map(x => x.trx);
  assert.deepEqual(await trxsOf({ days: 30 }), ['TESTTRX1', 'NEW1', 'OLD-OPEN'], 'a 30-day window drops EDGE90');
  assert.deepEqual(await trxsOf({ status: 'Auto-matched' }), ['NEW1']);
  assert.deepEqual(await trxsOf({ q: 'old', days: '365' }), ['OLD-OPEN', 'OLD-MATCH'], 'days may come as text; the window reaches OLD-MATCH');
  assert.deepEqual(await trxsOf({ q: 'old' }), ['OLD-OPEN'], 'the 90-day window hides OLD-MATCH from a search too');
  assert.deepEqual(await trxsOf({ q: '290' }), ['TESTTRX1', 'NEW1', 'EDGE90', 'OLD-OPEN'], 'amount search: every seeded message is 290');
});

test('inbox: a long list is cut at 300 rows and says so; the payload is checked', async () => {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  const base = st.inbox[0];
  for (let i = 0; i < 305; i++) st.inbox.push(Object.assign({}, base, { Transaction_ID: 'LIST' + i, Received: '2026-10-10 10:00', Status: 'Ignored' }));
  await seedDb(db, tables, st);
  const edge = loadEdge(db);
  const r = await edge.api('inbox', {});
  assert.equal(r.data.rows.length, 300);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.matching, 306);
  assert.equal(r.data.counts.total, 306);
  const err = async p => { const x = await edge.api('inbox', p); assert.equal(x.ok, false); return x.error; };
  assert.equal(await err({ status: 'Lost' }), 'Status must be all, Pending, Review, Matched, Auto-matched or Ignored.');
  assert.equal(await err({ q: 'x'.repeat(81) }), 'Search must be 80 characters or fewer.');
  assert.equal(await err({ days: 0 }), 'Days must be a whole number from 1 to 365.');
  assert.equal(await err({ days: 'soon' }), 'Days must be a whole number from 1 to 365.');
  assert.equal(await err({ days: 366 }), 'Days must be a whole number from 1 to 365.');
  assert.equal((await edge.api('inbox', { q: 'x'.repeat(80) })).ok, true, '80 characters is allowed');
});

test('reminderLog: rows are the sent and skipped reminders of the last 60 days, with names; the payload is checked', async () => {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  const s0 = st.sales[0];
  const name = st.customers.find(c => c.Customer_ID === s0.Customer_ID).Name;
  const log = (date, status, kind) => ({ Date: date, Sale_ID: s0.Sale_ID, Customer_ID: s0.Customer_ID, Kind: kind || 'before', Channel: 'WhatsApp', Status: status });
  st.remindersLog = [log('2026-10-18', 'sent', 'on_day'), log('2026-10-16', 'skipped'), log('2026-08-19', 'sent', 'after'), log('2026-08-17', 'sent', 'after'), log('2026-10-17', 'queued')];
  await seedDb(db, tables, st);
  const edge = loadEdge(db);

  const r = await edge.api('reminderLog', {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.data).sort(), ['counts', 'matching', 'rows', 'status', 'truncated']);
  assert.deepEqual(r.data.rows.map(x => [x.date, x.status]), [['2026-10-18', 'sent'], ['2026-10-16', 'skipped'], ['2026-08-19', 'sent']], 'newest first; queued and 61-day-old rows are out');
  assert.deepEqual(r.data.counts, { sent: 2, skipped: 1 });
  assert.equal(r.data.rows[0].name, name, 'the name comes from Customers');
  assert.equal(r.data.rows[0].kind, 'on_day');
  assert.equal(r.data.rows[0].channel, 'WhatsApp');
  assert.equal(r.data.truncated, false);

  const trxsOf = async p => (await edge.api('reminderLog', p)).data.rows.map(x => x.date);
  assert.deepEqual(await trxsOf({ status: 'skipped' }), ['2026-10-16']);
  assert.deepEqual(await trxsOf({ status: 'sent', days: '30' }), ['2026-10-18'], 'days may come as text; 30 days drops the August row');
  assert.equal((await edge.api('reminderLog', { status: 'all', days: 60 })).ok, true, '60 days is allowed');

  const err = async p => { const x = await edge.api('reminderLog', p); assert.equal(x.ok, false); return x.error; };
  assert.equal(await err({ status: 'queued' }), 'Status must be all, sent or skipped.');
  assert.equal(await err({ days: 0 }), 'Days must be a whole number from 1 to 60.');
  assert.equal(await err({ days: 61 }), 'Days must be a whole number from 1 to 60.');
  assert.equal(await err({ days: 'soon' }), 'Days must be a whole number from 1 to 60.');
  assert.equal(await err({ days: 7.5 }), 'Days must be a whole number from 1 to 60.');
});

test('activity: real saves show newest first, the newest one is undoable, Undo reverses it, and the read is bounded to its window', async () => {
  const { db, tables, m, edge } = await boot();
  assert.deepEqual(edge.needs.activity, [], 'activity reads Change_Log only: no state table');
  assert.deepEqual((await edge.api('activity', {})).data.batches, [], 'nothing saved yet');

  const kabir = cid(m, 'Kabir');
  assert.equal((await edge.api('edit', { requestId: 'act-1', kind: 'customer', id: kabir, values: { Notes: 'first note' } })).ok, true);
  assert.equal((await edge.api('edit', { requestId: 'act-2', kind: 'customer', id: kabir, values: { Notes: 'second note' } })).ok, true);
  const first = (await edge.api('activity', {})).data.batches;
  assert.equal(first.length, 2);
  assert.equal(first[0].action, 'Edit');
  assert.equal(first[0].undoable, true, 'the newest save is the one Undo reverses');
  assert.equal(first[1].undoable, false, 'an older save waits its turn');
  assert.match(first[0].summary, /^Customer /);
  const newest = first[0].batchId;
  assert.ok(newest.length > 0, 'the batch id is the handle Undo takes');

  const undo = await edge.api('undo', { requestId: 'act-undo', batchId: newest });
  assert.equal(undo.ok, true, undo.error);
  const after = (await edge.api('activity', {})).data.batches;
  assert.equal(after.length, 3, 'the Undo is itself a batch');
  assert.equal(after[0].reversal, true);
  assert.equal(after[0].undoable, false);
  assert.equal(after[1].batchId, newest);
  assert.equal(after[1].undone, true, 'the reversed save is marked undone');
  assert.equal(after[1].undoable, false);
  assert.equal(after[2].undoable, true, 'the save before it is now the one Undo would reverse');
  assert.equal(all(tables.customers).find(c => c.customer_id === kabir).notes, 'first note');

  const err = async p => { const r = await edge.api('activity', p); assert.equal(r.ok, false); return r.error; };
  assert.equal(await err({ limit: 0 }), 'Limit must be a whole number from 1 to 100.');
  assert.equal(await err({ limit: 101 }), 'Limit must be a whole number from 1 to 100.');
  assert.equal(await err({ limit: 1.5 }), 'Limit must be a whole number from 1 to 100.');
  assert.equal((await edge.api('activity', { limit: '2' })).data.batches.length, 2, 'a limit of 2 keeps the newest two');

  // A long history: 3000 Change_Log lines. The read takes the newest 1500 only, and returns 100 batches.
  for (let i = 1; i <= 3000; i++) {
    tables.change_log.push({ id: 1000 + i, time: '2026-10-20 10:00:00+00', batch_id: 'L' + i, action: 'editPayment', tab: 'Payments',
      row_key: 'PM-00001', field: 'Amount', old: '1', new: '2' });
  }
  db.resetStats();
  const big = await edge.api('activity', {});
  assert.equal(big.ok, true, big.error);
  assert.equal(big.data.batches.length, 100, 'at most 100 batches');
  assert.equal(db.stats.rows, tables.settings.size + 1500, 'the change_log read is capped at 1500 lines');
});

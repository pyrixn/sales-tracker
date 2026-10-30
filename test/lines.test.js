// Task 6: end a line, delete an account (keep the money), merge customers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const S = () => Core.sales;
const cust = (id, name, notes) => ({ Customer_ID: id, Name: name || 'N' + id, Channel: '', Handle: '', Discord_User_ID: '', Notes: notes || '', Created: '2026-10-01' });
const sale = (id, cid, extra) => Object.assign({ Sale_ID: id, Sale_Date: '2026-10-01', Customer: 'N' + cid, Contact: '', Product_ID: 'NETFLIX',
  Account_ID: 'NFX-03', Code_ID: '', Qty: 1, Unit_Price: 300, Paid_Till: '2026-11-01', Record_Status: 'Active', Notes: '', Customer_ID: cid, Months: 1,
  Sub_Code: 'N' + id, Cost_Snapshot: 100 }, extra || {});
const pay = (id, cid, saleId, amount, extra) => Object.assign({ Payment_ID: id, Date: '2026-10-02', Customer_ID: cid, Sale_ID: saleId, Amount: amount,
  Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' }, extra || {});
const base = extra => makeState(Object.assign({
  customers: [cust('C-1'), cust('C-2', 'Second', 'vip')],
  sales: [sale(1, 'C-1'), sale(2, 'C-2')],
  payments: [pay('PM-1', 'C-1', 1, 300), pay('PM-2', 'C-1', 1, 50), pay('PM-3', 'C-2', 2, 300)],
  purchases: [{ Purchase_ID: 'P-1', Date: '2026-10-01', Account_ID: 'NFX-03', Paid_With: 'UNKNOWN', Amount: 700, Covers_Until: '', Notes: '' }],
  remindersLog: [] }, extra || {}));

/** Apply planner ops to the state in place (update / clear / append only). */
const KEY = { Sales_Log: ['sales', 'Sale_ID'], Customers: ['customers', 'Customer_ID'], Accounts: ['accounts', 'Account_ID'],
  Payments: ['payments', 'Payment_ID'], Reminders_Log: ['remindersLog', 'Sale_ID'] };
function apply(st, plan) {
  assert.deepEqual(plan.errors, []);
  for (const o of plan.ops) {
    const [field, key] = KEY[o.tab];
    const rows = st[field];
    if (o.op === 'update') rows.filter(r => String(r[o.key || key]) === String(o.id)).forEach(r => Object.assign(r, o.values));
    else if (o.op === 'clear') rows.splice(rows.findIndex(r => String(r[key]) === String(o.id)), 1);
    else rows.push(Object.assign({}, o.values));
  }
  return st;
}

test('ending a line sets Ended and Paid_Till and reports collected, cost and net', () => {
  const st = base();
  const plan = S().planEndLine(st, { saleId: 1, date: '2026-10-10' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: 1, values: { Record_Status: 'Ended', Paid_Till: '2026-10-10' } }]);
  assert.deepEqual(plan.result, { saleId: 1, collected: 350, cost: 100, net: 250 });
});

test('ending a line refuses a second end, void or refunded lines, a bad date and an unknown sale', () => {
  const st = base();
  apply(st, S().planEndLine(st, { saleId: 1, date: '2026-10-10' }));
  assert.match(S().planEndLine(st, { saleId: 1, date: '2026-10-11' }).errors[0], /ended/i);
  st.sales[1].Record_Status = 'Void';
  assert.equal(S().planEndLine(st, { saleId: 2, date: '2026-10-10' }).errors.length, 1);
  st.sales[1].Record_Status = 'Refunded';
  assert.equal(S().planEndLine(st, { saleId: 2, date: '2026-10-10' }).errors.length, 1);
  st.sales[1].Record_Status = 'Active';
  assert.match(S().planEndLine(st, { saleId: 2, date: 'soon' }).errors[0], /date/i);
  assert.match(S().planEndLine(st, { saleId: 99, date: '2026-10-10' }).errors[0], /99/);
});

test('planEdit accepts Ended for a sale and Deleted for an account', () => {
  const st = base();
  assert.deepEqual(S().planEdit(st, { kind: 'sale', id: 1, values: { Record_Status: 'Ended' } }).errors, []);
  assert.deepEqual(S().planEdit(st, { kind: 'account', id: 'NFX-03', values: { Account_Status: 'Deleted' } }).errors, []);
  assert.ok(S().STATUSES.includes('Ended') && S().ACCOUNT_STATUSES.includes('Deleted'));
});

test('an ended line holds no seat, is not renewable, not reminded and not on the pay links tab', () => {
  const st = base({ today: '2026-10-30' });          // sale 1 ends 2026-11-01: inside the reminder window
  const acct = st.accounts.find(a => a.Account_ID === 'NFX-03');
  const before = S().freeSlots(st, acct);
  assert.ok(Core.reminders.planReminders(st).some(r => r.saleId === 1 && r.kind === 'before'));
  assert.ok(Core.paylinks.list(st).rows.some(r => r.saleId === 1));
  assert.ok(Core.views.homeData(st).renewSoon.some(r => r.saleId === 1));
  apply(st, S().planEndLine(st, { saleId: 1, date: '2026-11-05' }));   // Paid_Till is in the future, still not a live line
  assert.equal(S().freeSlots(st, acct), before + 1, 'the seat is freed');
  assert.match(S().planRenew(st, { subCode: 'N1' }).errors[0], /No active/);
  assert.ok(!Core.reminders.planReminders(st).some(r => r.saleId === 1 && r.kind !== 'due'), 'no renewal reminder');
  assert.ok(!Core.paylinks.list(st).rows.some(r => r.saleId === 1));
  assert.ok(!Core.views.homeData(st).renewSoon.some(r => r.saleId === 1));
});

test('an ended line still counts in profit and shows in the Retired log by product', () => {
  const st = base();
  const fam0 = Core.views.profitByFamily(st);
  apply(st, S().planEndLine(st, { saleId: 1, date: '2026-10-10' }));
  assert.deepEqual(Core.views.profitByFamily(st), fam0, 'profit unchanged by ending');
  const ov = Core.views.accountsOverview(st);
  const g = ov.endedLines.find(x => x.productId === 'NETFLIX');
  assert.ok(g);
  assert.equal(g.lines.length, 1);
  assert.deepEqual({ collected: g.collected, cost: g.cost, net: g.net }, { collected: 350, cost: 100, net: 250 });
  assert.equal(g.lines[0].saleId, 1);
  assert.equal(g.lines[0].endedOn, '2026-10-10');
  const acc = ov.groups.flatMap(x => x.accounts).find(a => a.id === 'NFX-03');
  assert.ok(!acc.rows.some(r => r.saleId === 1), 'not listed as a live row');
});

test('deleting an account is refused while a live seat is in use and names the count', () => {
  const st = base();
  const r = S().planDeleteAccount(st, { accountId: 'NFX-03' });
  assert.match(r.errors[0], /2 /);
  assert.deepEqual(r.ops, []);
  apply(st, S().planEndLine(st, { saleId: 1, date: '2026-10-10' }));
  assert.match(S().planDeleteAccount(st, { accountId: 'NFX-03' }).errors[0], /1 /);
  assert.match(S().planDeleteAccount(st, { accountId: 'NOPE' }).errors[0], /NOPE/);
});

test('deleting an account hides it everywhere but keeps its money in profit and the book', () => {
  const st = base();
  apply(st, S().planEndLine(st, { saleId: 1, date: '2026-10-10' }));
  st.sales[1].Paid_Till = '2026-10-17';              // expired yesterday: no live seat
  const fam0 = Core.views.profitByFamily(st), book0 = Core.views.bookData(st, '2026-10');
  const plan = S().planDeleteAccount(st, { accountId: 'NFX-03' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Accounts', key: 'Account_ID', id: 'NFX-03', values: { Account_Status: 'Deleted' } },
    { op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: 2, values: { Record_Status: 'Ended' } }], 'expired Active lines are ended, Paid_Till kept');
  apply(st, plan);
  assert.equal(st.sales[1].Paid_Till, '2026-10-17');
  const acct = st.accounts.find(a => a.Account_ID === 'NFX-03');
  assert.equal(S().freeSlots(st, acct), 0);
  assert.ok(!Core.views.lookups(st).accounts.some(a => a.id === 'NFX-03'));
  assert.ok(!Core.views.accountsOverview(st).groups.some(g => g.accounts.some(a => a.id === 'NFX-03')));
  assert.ok(!Core.paylinks.list(st).rows.some(r => r.accountId === 'NFX-03'));
  assert.ok(!Core.views.productList(st, 'NETFLIX').some(x => x.account.id === 'NFX-03'));
  assert.deepEqual(Core.views.profitByFamily(st), fam0, 'profit still counts');
  assert.deepEqual(Core.views.bookData(st, '2026-10'), book0, 'book still counts');
  assert.ok(fam0.length > 0 && fam0[0].revenue > 0);
});

test('merging customers moves sales, payments and reminders; keeps amounts; notes the source; clears it', () => {
  const st = base({ remindersLog: [{ Date: '2026-10-01', Sale_ID: 2, Customer_ID: 'C-2', Kind: 'before', Channel: 'WhatsApp', Status: 'sent' }] });
  const total = st.payments.reduce((n, p) => n + p.Amount, 0);
  const plan = S().planMergeCustomers(st, { fromId: 'C-2', intoId: 'C-1' });
  assert.deepEqual(plan.errors, []);
  const upd = (tab, id) => plan.ops.find(o => o.tab === tab && String(o.id) === String(id));
  assert.deepEqual(upd('Sales_Log', 2).values, { Customer_ID: 'C-1', Customer: 'NC-1' });
  assert.deepEqual(upd('Payments', 'PM-3').values, { Customer_ID: 'C-1' });
  assert.deepEqual(upd('Reminders_Log', 2).values, { Customer_ID: 'C-1' });
  assert.equal(upd('Customers', 'C-1').values.Notes, 'Merged from Second (C-2)', 'no contact details to carry');
  assert.deepEqual(plan.ops[plan.ops.length - 1], { op: 'clear', tab: 'Customers', key: 'Customer_ID', id: 'C-2' });
  apply(st, plan);
  assert.equal(st.payments.reduce((n, p) => n + p.Amount, 0), total, 'amounts kept');
  assert.ok(st.payments.every(p => p.Customer_ID === 'C-1'));
  assert.ok(st.sales.every(s => s.Customer_ID === 'C-1'));
  assert.equal(st.customers.length, 1);
});

test('merging appends to existing target notes and refuses same or unknown ids', () => {
  const st = base();
  st.customers[0].Notes = 'first';
  const plan = S().planMergeCustomers(st, { fromId: 'C-2', intoId: 'C-1' });
  assert.equal(plan.ops.find(o => o.tab === 'Customers' && o.op === 'update').values.Notes, 'first · Merged from Second (C-2)');
  assert.equal(S().planMergeCustomers(st, { fromId: 'C-1', intoId: 'C-1' }).errors.length, 1);
  assert.match(S().planMergeCustomers(st, { fromId: 'C-9', intoId: 'C-1' }).errors[0], /C-9/);
  assert.match(S().planMergeCustomers(st, { fromId: 'C-1', intoId: 'C-9' }).errors[0], /C-9/);
});

test('merging carries the source contact details into the target note', () => {
  const st = base();
  Object.assign(st.customers[1], { Channel: 'WhatsApp', Handle: '01711111111', Discord_User_ID: 'd123' });
  const plan = S().planMergeCustomers(st, { fromId: 'C-2', intoId: 'C-1' });
  assert.equal(plan.ops.find(o => o.tab === 'Customers' && o.op === 'update').values.Notes, 'Merged from Second (C-2) · WhatsApp 01711111111 · Discord d123');
});

test('a Deleted account cannot be renewed, sold onto, auto-matched or assigned to a sale', () => {
  const st = base();
  st.sales[0].Paid_Till = '2026-10-17';
  st.sales[1].Paid_Till = '2026-10-17';
  apply(st, S().planDeleteAccount(st, { accountId: 'NFX-03' }));
  // a line left Active by hand (status edited directly) must still be refused
  st.sales[1].Record_Status = 'Active';
  const acct = st.accounts.find(a => a.Account_ID === 'NFX-03');
  assert.equal(acct.Account_Status, 'Deleted');
  assert.match(S().planRenew(st, { subCode: 'N2' }).errors[0], /Deleted/);
  assert.match(S().planNewSale(st, { customerId: 'C-1', productId: 'NETFLIX', accountId: 'NFX-03', allowFull: true, price: 300 }).errors[0], /Deleted/);
  st.accounts.push(Object.assign({}, acct, { Account_ID: 'NFX-04', Account_Status: 'Active' }));
  const other = st.accounts.find(a => a.Account_ID === 'NFX-04');
  assert.match(S().planEdit(st, { kind: 'sale', id: 2, values: { Account_ID: 'NFX-03' } }).errors[0], /deleted/);
  assert.deepEqual(S().planEdit(st, { kind: 'sale', id: 2, values: { Account_ID: other.Account_ID } }).errors, []);
  const row = { Received: '2026-10-18 14:05', Type: 'Received', Method: 'bKash', Sender: '16247', Amount: 300, Transaction_ID: 'TDEL1', Reference: 'N2', Status: 'Pending' };
  const m = Core.matching.planInboxMatch(st, row);
  assert.equal(m.status, 'pending');
  assert.equal(m.result.note, 'NFX-03 is Deleted.');
});

test('deleting an account ends its expired lines so the customer sheet no longer lists them as live', () => {
  const st = base();
  st.sales[0].Paid_Till = '2026-10-10';
  st.sales[1].Paid_Till = '2026-10-10';
  assert.equal(Core.views.customerData(st, 'C-1').lines.length, 1);
  apply(st, S().planDeleteAccount(st, { accountId: 'NFX-03' }));
  assert.equal(Core.views.customerData(st, 'C-1').lines.length, 0);
  assert.equal(Core.views.customerData(st, 'C-1').history.length, 1, 'still in history');
  assert.match(S().planRenew(st, { subCode: 'N1' }).errors[0], /No active/);
});

test('customer notes use planEdit kind customer', () => {
  const st = base();
  const p = S().planEdit(st, { kind: 'customer', id: 'C-1', values: { Notes: 'pays late' } });
  assert.deepEqual(p.ops, [{ op: 'update', tab: 'Customers', key: 'Customer_ID', id: 'C-1', values: { Notes: 'pays late' } }]);
});

// ---- edge route
const all = t => (Array.isArray(t) ? t : Array.from(t.values()));
const one = (t, col, v) => all(t).filter(r => String(r[col]) === String(v))[0];
async function boot() {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  await seedDb(db, tables, m);
  return { db, tables, m, edge: loadEdge(db) };
}

test('edge: mergeCustomers moves the data and undo restores the cleared customer', async () => {
  const { edge, tables, m } = await boot();
  const from = m.customers.find(c => m.sales.some(s => s.Customer_ID === c.Customer_ID && s.Record_Status === 'Active'));
  const into = m.customers.find(c => c.Customer_ID !== from.Customer_ID);
  const fromSales = m.sales.filter(s => s.Customer_ID === from.Customer_ID).map(s => s.Sale_ID);
  const r = await edge.api('mergeCustomers', { requestId: 'mc1', fromId: from.Customer_ID, intoId: into.Customer_ID });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.message, /merged/i);
  assert.equal(one(tables.customers, 'customer_id', from.Customer_ID), undefined, 'source cleared');
  for (const id of fromSales) assert.equal(one(tables.sales, 'sale_id', id).customer_id, into.Customer_ID);
  const u = await edge.api('undo', { requestId: 'mc2' });
  assert.equal(u.ok, true, u.error);
  const back = one(tables.customers, 'customer_id', from.Customer_ID);
  assert.ok(back, 'undo restores the customer');
  assert.equal(back.name, from.Name);
  for (const id of fromSales) assert.equal(one(tables.sales, 'sale_id', id).customer_id, from.Customer_ID);
});

test('edge: endLine and deleteAccount respond and refuse bad input', async () => {
  const { edge, m } = await boot();
  const live = m.sales.find(s => s.Record_Status === 'Active' && s.Account_ID);
  const e = await edge.api('endLine', { requestId: 'el1', saleId: live.Sale_ID, date: '2026-10-18' });
  assert.equal(e.ok, true, e.error);
  assert.equal(e.data.saleId, live.Sale_ID);
  assert.equal((await edge.api('endLine', { requestId: 'el2', saleId: live.Sale_ID, date: '2026-10-18' })).ok, false);
  const bad = await edge.api('deleteAccount', { requestId: 'da1', accountId: 'NOPE' });
  assert.equal(bad.ok, false);
});

test('edge: deleteAccount ends expired lines and undo restores their status', async () => {
  const { edge, tables, m } = await boot();
  const acct = m.sales.find(s => s.Record_Status === 'Active' && s.Account_ID).Account_ID;
  const ids = m.sales.filter(s => s.Account_ID === acct && s.Record_Status === 'Active').map(s => s.Sale_ID);
  // expire every live line of that account so the delete is allowed
  const { db, tables: t2 } = makeFakeDb();
  const m2 = makeUiState();
  m2.sales.forEach(s => { if (s.Account_ID === acct && s.Record_Status === 'Active') s.Paid_Till = '2026-01-01'; });
  await seedDb(db, t2, m2);
  const e2 = loadEdge(db);
  const d = await e2.api('deleteAccount', { requestId: 'da2', accountId: acct });
  assert.equal(d.ok, true, d.error);
  assert.equal(one(t2.accounts, 'account_id', acct).account_status, 'Deleted');
  for (const id of ids) assert.equal(one(t2.sales, 'sale_id', id).record_status, 'Ended');
  const u = await e2.api('undo', { requestId: 'da3' });
  assert.equal(u.ok, true, u.error);
  assert.equal(one(t2.accounts, 'account_id', acct).account_status, 'Active');
  for (const id of ids) assert.equal(one(t2.sales, 'sale_id', id).record_status, 'Active');
});

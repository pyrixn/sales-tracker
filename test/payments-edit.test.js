const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeState } = require('./fixtures');

const S = () => Core.sales;
const cust = id => ({ Customer_ID: id, Name: 'N' + id, Channel: '', Handle: '', Discord_User_ID: '', Notes: '', Created: '2026-10-01' });
const sale = (id, cid, price, extra) => Object.assign({ Sale_ID: id, Sale_Date: '2026-10-01', Customer: 'N' + cid, Contact: '', Product_ID: 'VALORANT',
  Account_ID: '', Code_ID: '', Qty: 1, Unit_Price: price, Paid_Till: '2026-11-01', Record_Status: 'Active', Notes: '', Customer_ID: cid, Months: 1,
  Sub_Code: 'V' + id, Cost_Snapshot: 0 }, extra || {});
const pay = (id, cid, saleId, amount, extra) => Object.assign({ Payment_ID: id, Date: '2026-10-02', Customer_ID: cid, Sale_ID: saleId, Amount: amount,
  Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' }, extra || {});
const base = overrides => makeState(Object.assign({ customers: [cust('C-1')], sales: [sale(1, 'C-1', 2290), sale(2, 'C-1', 500)], payments: [] }, overrides || {}));

test('edit amount 2290 -> 2180 updates exactly one row', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 2290)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', amount: 2180 });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Amount: 2180 } }]);
});

test('edit date, method and transaction id (uppercased)', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 2290)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', date: '2026-10-05', method: 'Nagad', transactionId: ' abc1 ' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops[0].values, { Date: '2026-10-05', Method: 'Nagad', Transaction_ID: 'ABC1' });
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', date: 'nope' }).errors[0], /Date/);
});

test('re-apply a credit to a sale: sale payment, no leftover credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', '', 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', saleId: 2 });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Sale_ID: 2 } }]);
});

test('overpay: part goes to the sale, the rest becomes a credit row', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', '', 800)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', saleId: 2 });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops.length, 2);
  assert.deepEqual(plan.ops[0], { op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Sale_ID: 2, Amount: 500 } });
  assert.equal(plan.ops[1].op, 'append');
  assert.equal(plan.ops[1].values.Sale_ID, '');
  assert.equal(plan.ops[1].values.Amount, 300);
  assert.equal(plan.ops[1].values.Customer_ID, 'C-1');
  assert.equal(plan.result.credit, 300);
});

test('raising a sale payment above the balance splits the excess into credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 2, 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', amount: 700 });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops.length, 1, 'the sale row keeps 500; only the credit row is added');
  assert.equal(plan.ops[0].op, 'append');
  assert.equal(plan.ops[0].values.Amount, 200);
  assert.equal(plan.ops[0].values.Sale_ID, '');
});

test('moving a credit onto a fully paid sale is refused (no negative balance)', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', '', 300), pay('PM-2', 'C-1', 2, 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', saleId: 2 });
  assert.match(plan.errors[0], /nothing left to pay/);
  assert.deepEqual(plan.ops, []);
});

test('moving a sale payment to credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 2, 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', saleId: '' });
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Sale_ID: '' } }]);
});

test('clashing transaction id fails; keeping its own id is fine', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 100, { Transaction_ID: 'AAA' }), pay('PM-2', 'C-1', 1, 100, { Transaction_ID: 'BBB' })] });
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', transactionId: 'bbb' }).errors[0], /BBB is already recorded/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', transactionId: 'aaa', amount: 90 }).errors, []);
});

test('payment edit rejects bad amount, other customers sale, unknown sale', () => {
  const st = base({ customers: [cust('C-1'), cust('C-2')], sales: [sale(1, 'C-1', 2290), sale(3, 'C-2', 100)], payments: [pay('PM-1', 'C-1', 1, 100)] });
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', amount: 0 }).errors[0], /Amount/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', saleId: 3 }).errors[0], /does not belong/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', saleId: 99 }).errors[0], /does not belong/);
});

test('deleting an auto payment resets its Matched inbox row to Pending', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 2290, { Transaction_ID: 'T9', Source: 'Auto' })],
    inbox: [{ Transaction_ID: 'T9', Status: 'Matched', Matched_Sale_ID: 1 }, { Transaction_ID: 'T8', Status: 'Matched', Matched_Sale_ID: 2 }] });
  const plan = S().planDeletePayment(st, { paymentId: 'PM-1' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [
    { op: 'clear', tab: 'Payments', key: 'Payment_ID', id: 'PM-1' },
    { op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: 'T9', values: { Status: 'Pending', Matched_Sale_ID: '' } }]);
});

test('deleting a plain payment only clears the row', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 2290, { Transaction_ID: 'T9' })], inbox: [{ Transaction_ID: 'T9', Status: 'Pending', Matched_Sale_ID: '' }] });
  assert.deepEqual(S().planDeletePayment(st, { paymentId: 'PM-1' }).ops, [{ op: 'clear', tab: 'Payments', key: 'Payment_ID', id: 'PM-1' }]);
});

test('credit-used rows are protected from edit and delete', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', '', -300, { Source: 'Credit' }), pay('PM-2', 'C-1', 2, 300, { Source: 'Credit' })] });
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', amount: 10 }).errors[0], /Credit/);
  assert.match(S().planDeletePayment(st, { paymentId: 'PM-2' }).errors[0], /Credit/);
});

test('Cost_Snapshot is editable on a sale (2050 VP sale gets cost 2180)', () => {
  const st = base({ sales: [sale(7, 'C-1', 2050)] });
  const plan = S().planEdit(st, { kind: 'sale', id: 7, values: { Cost_Snapshot: 2180 } });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: 7, values: { Cost_Snapshot: 2180 } }]);
  assert.match(S().planEdit(st, { kind: 'sale', id: 7, values: { Cost_Snapshot: -1 } }).errors[0], /Cost/);
  assert.match(S().planEdit(st, { kind: 'sale', id: 7, values: { Cost_Snapshot: 'x' } }).errors[0], /Cost/);
});

test('expense edit and delete', () => {
  const st = base({ expenses: [{ Expense_ID: 'EX-1', Date: '2026-10-03', Category: 'VPN', Amount: 100, Paid_With: 'UNKNOWN', Note: '' }] });
  const plan = S().planEditExpense(st, { expenseId: 'EX-1', category: 'Ads', amount: 150, note: ' hi ' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Expenses', key: 'Expense_ID', id: 'EX-1', values: { Category: 'Ads', Amount: 150, Note: 'hi' } }]);
  assert.match(S().planEditExpense(st, { expenseId: 'EX-1', category: 'Lunch' }).errors[0], /Category must be one of/);
  assert.match(S().planEditExpense(st, { expenseId: 'EX-1', paidWith: 'NOPE' }).errors[0], /Unknown wallet/);
  assert.match(S().planEditExpense(st, { expenseId: 'EX-1', amount: -5 }).errors[0], /Amount/);
  assert.deepEqual(S().planDeleteExpense(st, { expenseId: 'EX-1' }).ops, [{ op: 'clear', tab: 'Expenses', key: 'Expense_ID', id: 'EX-1' }]);
});

test('purchase edit and delete', () => {
  const st = base({ purchases: [{ Purchase_ID: 'P-1', Date: '2026-10-03', Account_ID: 'NFX-03', Paid_With: 'UNKNOWN', Amount: 100, Covers_Until: '2026-11-03', Notes: '' }],
    accounts: [{ Account_ID: 'NFX-03', Product_ID: 'NETFLIX' }, { Account_ID: 'NFX-04', Product_ID: 'NETFLIX' }] });
  const plan = S().planEditPurchase(st, { purchaseId: 'P-1', accountId: 'NFX-04', amount: 120, coversUntil: '2026-12-01', notes: 'n' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Purchases', key: 'Purchase_ID', id: 'P-1',
    values: { Account_ID: 'NFX-04', Amount: 120, Covers_Until: '2026-12-01', Notes: 'n' } }]);
  assert.match(S().planEditPurchase(st, { purchaseId: 'P-1', accountId: 'ZZZ' }).errors[0], /Unknown account/);
  assert.match(S().planEditPurchase(st, { purchaseId: 'P-1', coversUntil: 'x' }).errors[0], /Covers until/);
  assert.deepEqual(S().planDeletePurchase(st, { purchaseId: 'P-1' }).ops, [{ op: 'clear', tab: 'Purchases', key: 'Purchase_ID', id: 'P-1' }]);
});

test('every plan returns errors and no ops for unknown ids', () => {
  const st = base();
  [['planEditPayment', { paymentId: 'X' }], ['planDeletePayment', { paymentId: 'X' }], ['planEditExpense', { expenseId: 'X' }],
   ['planDeleteExpense', { expenseId: 'X' }], ['planEditPurchase', { purchaseId: 'X' }], ['planDeletePurchase', { purchaseId: 'X' }]].forEach(([fn, input]) => {
    const plan = S()[fn](st, input);
    assert.equal(plan.errors.length, 1, fn);
    assert.deepEqual(plan.ops, [], fn);
  });
});

// ---- fix round 1
const usedCreditState = () => base({ sales: [sale(1, 'C-1', 2290), sale(2, 'C-1', 2290)], payments: [
  pay('PM-1', 'C-1', '', 2290), pay('PM-2', 'C-1', '', -2290, { Source: 'Credit' }), pay('PM-3', 'C-1', 2, 2290, { Source: 'Credit' })] });

test('credit already used: move, shrink and delete are refused', () => {
  const st = usedCreditState();
  const move = S().planEditPayment(st, { paymentId: 'PM-1', saleId: 1 });
  assert.match(move.errors[0], /^৳2290 of this credit is already used; undo that first\.$/);
  assert.deepEqual(move.ops, []);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', amount: 2180 }).errors[0], /৳110 of this credit is already used/);
  assert.match(S().planDeletePayment(st, { paymentId: 'PM-1' }).errors[0], /৳2290 of this credit is already used/);
});

test('unused credit can still be moved, shrunk and deleted', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', '', 500)] });
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', amount: 400 }).errors, []);
  assert.deepEqual(S().planDeletePayment(st, { paymentId: 'PM-1' }).errors, []);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', saleId: 2 }).errors, []);
});

test('date-only edit on a void sale payment does not detach it', () => {
  const st = base({ sales: [sale(1, 'C-1', 2290, { Record_Status: 'Void' })], payments: [pay('PM-1', 'C-1', 1, 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', date: '2026-10-09' });
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Date: '2026-10-09' } }]);
});

test('method-only edit on an overpaid sale writes only Method', () => {
  const st = base({ sales: [sale(1, 'C-1', 400)], payments: [pay('PM-1', 'C-1', 1, 500)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', method: 'Nagad' });
  assert.deepEqual(plan.ops, [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-1', values: { Method: 'Nagad' } }]);
  assert.equal(plan.result.credit, 0);
});

test('raising the amount on the same sale splits only the increase', () => {
  const st = base({ sales: [sale(1, 'C-1', 1000)], payments: [pay('PM-1', 'C-1', 1, 800)] });
  const plan = S().planEditPayment(st, { paymentId: 'PM-1', amount: 1300 });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops[0].values.Amount, 1000);
  assert.equal(plan.ops[1].values.Amount, 300);
  assert.equal(plan.ops[1].values.Sale_ID, '');
  // existing overpayment is not redistributed: sale 400, payment 500, raise to 600 -> only the extra 100 is credit
  const over = base({ sales: [sale(1, 'C-1', 400)], payments: [pay('PM-1', 'C-1', 1, 500)] });
  const p2 = S().planEditPayment(over, { paymentId: 'PM-1', amount: 600 });
  assert.deepEqual(p2.ops.map(o => o.op), ['append']);
  assert.equal(p2.ops[0].values.Amount, 100);
});

test('moving a sale payment to credit reports the credit', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 2, 500)] });
  assert.equal(S().planEditPayment(st, { paymentId: 'PM-1', saleId: '' }).result.credit, 500);
});

test('unchanged expense and purchase edits yield no ops; amounts are rounded', () => {
  const st = base({ expenses: [{ Expense_ID: 'EX-1', Date: '2026-10-03', Category: 'VPN', Amount: 100, Paid_With: 'UNKNOWN', Note: 'a' }],
    purchases: [{ Purchase_ID: 'P-1', Date: '2026-10-03', Account_ID: 'NFX-03', Paid_With: 'UNKNOWN', Amount: 100, Covers_Until: '2026-11-03', Notes: 'a' }],
    accounts: [{ Account_ID: 'NFX-03', Product_ID: 'NETFLIX' }] });
  assert.deepEqual(S().planEditExpense(st, { expenseId: 'EX-1', date: '2026-10-03', category: 'VPN', amount: 100, paidWith: 'UNKNOWN', note: 'a' }).ops, []);
  assert.deepEqual(S().planEditPurchase(st, { purchaseId: 'P-1', date: '2026-10-03', accountId: 'NFX-03', paidWith: 'UNKNOWN', amount: 100, coversUntil: '2026-11-03', notes: 'a' }).ops, []);
  assert.equal(S().planEditExpense(st, { expenseId: 'EX-1', amount: 10.456 }).ops[0].values.Amount, 10.46);
  assert.equal(S().planEditPurchase(st, { purchaseId: 'P-1', amount: 10.456 }).ops[0].values.Amount, 10.46);
});

test('Code_ID edit keeps an explicit Cost_Snapshot', () => {
  const st = base({ sales: [sale(7, 'C-1', 50, { Product_ID: 'STEAM' })], products: [{ Product_ID: 'STEAM', Unit_Cost: 30 }],
    codes: [{ Code_ID: 'C-9', Product_ID: 'STEAM', Code: 'x', Status: 'Available' }] });
  const plan = S().planEdit(st, { kind: 'sale', id: 7, values: { Code_ID: 'C-9', Cost_Snapshot: 44 } });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops[0].values.Cost_Snapshot, 44);
});

// ---------------------------------------------------------------- confirming payment of a Paid pay link
const linkState = () => base({
  sales: [sale(1, 'C-1', 2000), sale(2, 'C-1', 500)],
  payRequests: [{ Request_ID: 'R1', Status: 'Paid', Sale_ID: 1, Amount: 500 }],
  payments: [pay('PM-1', 'C-1', 1, 500, { Transaction_ID: 'TRX1', Note: 'Pay link R1' }), pay('PM-2', 'C-1', 1, 700, { Transaction_ID: 'TRX2' })] });

test('delete: only the payment that confirmed a Paid link is refused; a later payment on that sale is allowed', () => {
  const st = linkState();
  const later = S().planDeletePayment(st, { paymentId: 'PM-2' });
  assert.deepEqual(later.errors, []); assert.equal(later.ops[0].op, 'clear');
  const first = S().planDeletePayment(st, { paymentId: 'PM-1' });
  assert.match(first.errors[0], /confirmed pay link R1.*Undo/);
});

test('delete: old row without a link note falls back to the earliest payment with a transaction id', () => {
  const st = linkState(); st.payments[0].Note = '';
  assert.match(S().planDeletePayment(st, { paymentId: 'PM-1' }).errors[0], /confirmed pay link R1/);
  assert.deepEqual(S().planDeletePayment(st, { paymentId: 'PM-2' }).errors, []);
});

test('edit: confirming payment keeps amount, sale and transaction id; date, method and note edits stay allowed', () => {
  const st = linkState();
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', amount: 400 }).errors[0], /Confirmed pay link R1.*Undo/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', saleId: 2 }).errors[0], /confirmed pay link R1/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', transactionId: 'NEW1' }).errors[0], /confirmed pay link R1/);
  const ok = S().planEditPayment(st, { paymentId: 'PM-1', amount: 500, saleId: 1, transactionId: 'trx1', date: '2026-10-05', method: 'Nagad' });
  assert.deepEqual(ok.errors, []); assert.deepEqual(ok.ops[0].values, { Date: '2026-10-05', Method: 'Nagad' });
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-2', amount: 600 }).errors, []);
});

// ---------------------------------------------------------------- note edit and the locked map read by the panel
test('edit: note saves trimmed; a blank note clears it; an unchanged note sends nothing', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 500, { Note: 'old' })] });
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', note: '  new note ' }).ops[0].values, { Note: 'new note' });
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', note: '' }).ops[0].values, { Note: '' });
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', note: 'old' }).ops, []);
});

test('paymentLocks: a plain payment has no locks; a credit-used row locks every field with one reason', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 500), pay('PM-9', 'C-1', '', -100, { Source: 'App' })] });
  assert.deepEqual(S().paymentLocks(st, st.payments[0]), {});
  const locks = S().paymentLocks(st, st.payments[1]);
  assert.deepEqual(Object.keys(locks).sort(), ['amount', 'date', 'method', 'note']);
  assert.match(locks.amount, /Credit-used entries cannot be edited/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-9', date: '2026-10-05' }).errors[0], /Credit-used/);
});

test('paymentLocks: a confirmed pay link locks only the amount, with the link id in the reason', () => {
  const st = linkState();
  const locks = S().paymentLocks(st, st.payments[0]);
  assert.deepEqual(Object.keys(locks), ['amount']);
  assert.match(locks.amount, /R1/);
  assert.match(locks.amount, /Undo/);
  assert.deepEqual(S().paymentLocks(st, st.payments[1]), {});
});

test('views: customer payments and book payment rows carry note and locked (only when asked); book expense and purchase rows carry their raw fields', () => {
  assert.equal(Core.views.customerData(linkState(), 'C-1').payments[0].locked, undefined, 'no locks unless withLocks');
  assert.equal(Core.views.bookData(linkState(), linkState().today.slice(0, 7)).entries[0].locked, undefined, 'no locks unless withLocks');
  const st = linkState();
  st.expenses = [{ Expense_ID: 'EX-1', Date: st.today.slice(0, 7) + '-03', Category: 'VPN', Amount: 150, Paid_With: 'W1', Note: 'annual' }];
  st.purchases = [{ Purchase_ID: 'P-1', Date: st.today.slice(0, 7) + '-04', Account_ID: 'NFX-04', Paid_With: 'W1', Amount: 120, Covers_Until: '2026-12-01', Notes: 'n' }];
  const cd = Core.views.customerData(st, 'C-1', { withLocks: true });
  const p1 = cd.payments.find(p => p.paymentId === 'PM-1');
  assert.deepEqual(Object.keys(p1.locked), ['amount']);
  assert.deepEqual(cd.payments.find(p => p.paymentId === 'PM-2').locked, {});
  const b = Core.views.bookData(st, st.today.slice(0, 7), { withLocks: true });
  const row = b.entries.find(e => e.id === 'PM-1');
  assert.equal(row.note, 'Pay link R1');
  assert.deepEqual(Object.keys(row.locked), ['amount']);
  const ex = b.entries.find(e => e.id === 'EX-1');
  assert.equal(ex.category, 'VPN'); assert.equal(ex.note, 'annual'); assert.equal(ex.locked, undefined);
  const pu = b.entries.find(e => e.id === 'P-1');
  assert.equal(pu.accountId, 'NFX-04'); assert.equal(pu.coversUntil, '2026-12-01'); assert.equal(pu.notes, 'n');
});

// ---------------------------------------------------------------- note links (fix wave, I1)
// Four kinds of link: a sale (R1, Sale_ID 1), a no-product pay link row (R2, note only), an overpaid credit row (R3, note only), and a forged note.
const noteState = () => base({
  customers: [cust('C-1')],
  sales: [sale(1, 'C-1', 2290), sale(2, 'C-1', 500)],
  payRequests: [
    { Request_ID: 'R1', Status: 'Paid', Sale_ID: 1, Amount: 2290, Customer_ID: 'C-1' },
    { Request_ID: 'R2', Status: 'Paid', Sale_ID: '', Amount: 300, Customer_ID: '' },
    { Request_ID: 'R3', Status: 'Paid', Sale_ID: '', Amount: 200, Customer_ID: 'C-1' }],
  payments: [
    pay('PM-1', 'C-1', 1, 2290, { Transaction_ID: 'T1', Note: '' }),
    pay('PM-2', 'C-1', '', 300, { Customer_ID: '', Transaction_ID: 'T2', Note: 'Pay link R2: Gift card' }),
    pay('PM-3', 'C-1', '', 200, { Transaction_ID: 'T3', Note: 'Overpaid on R3' }),
    pay('PM-4', 'C-1', 2, 100, { Note: 'Pay link R1: forged' }),
    pay('PM-5', 'C-1', 2, 100, { Note: 'Lunch' })]
});

test('note: a no-product pay-link row is linked by its note alone, so the note is locked and a note edit is refused', () => {
  const st = noteState();
  const locks = S().paymentLocks(st, st.payments[1]);
  assert.match(locks.note, /pay link R2/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-2', note: 'Gift' }).errors[0], /pay link R2/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-2', note: 'Pay link R2: Gift card' }).errors, [], 'an unchanged note sends nothing');
});

test('note: an overpaid credit row is linked by its note, so clearing the note is refused', () => {
  const st = noteState();
  assert.match(S().paymentLocks(st, st.payments[2]).note, /pay link R3/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-3', note: '' }).errors[0], /pay link R3/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-3', note: 'Overpaid on R3' }).ops, []);
});

test('note: a forged "Pay link" prefix on an unrelated payment locks its note; a fresh payment cannot be given one', () => {
  const st = noteState();
  // PM-4 sits on sale 2, not R1's sale: only its note links it to R1, so the note is locked; its amount is free.
  assert.match(S().paymentLocks(st, st.payments[3]).note, /pay link R1/);
  assert.equal(S().paymentLocks(st, st.payments[3]).amount, undefined);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Pay link R1: x' }).errors[0], /pay link record/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Pay link R9:' }).errors[0], /pay link record/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Overpaid on R3, x' }).errors[0], /pay link record/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Overpaid on R3' }).errors[0], /pay link record/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Overpaid on last month' }).ops,
    [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: 'PM-5', values: { Note: 'Overpaid on last month' } }]);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-5', note: 'Pay link via bKash' }).errors, []);
});

test('note: a Sale_ID-linked payment keeps its note editable (its amount is still fixed)', () => {
  const st = noteState();
  assert.equal(S().paymentLocks(st, st.payments[0]).note, undefined);
  assert.match(S().paymentLocks(st, st.payments[0]).amount, /Confirmed pay link R1/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', note: 'Paid by Nagad' }).ops[0].values, { Note: 'Paid by Nagad' });
});

// ---------------------------------------------------------------- planner and paymentLocks agree (fix wave, I2)
test('planEditPayment refuses exactly the fields paymentLocks locks, with the same reason; every other field is accepted', () => {
  const st = noteState();
  st.payments.push(pay('PM-9', 'C-1', '', -100, { Source: 'Credit' }));   // a credit-used row
  const values = { amount: cur => Number(cur.Amount) + 10, date: () => '2026-10-09', method: () => 'Nagad', note: () => 'a new note' };
  const seen = [];
  st.payments.forEach(cur => {
    const locks = S().paymentLocks(st, cur);
    Object.keys(values).forEach(field => {
      const input = { paymentId: cur.Payment_ID }; input[field] = values[field](cur);
      const plan = S().planEditPayment(st, input);
      if (locks[field]) {
        assert.deepEqual(plan.errors, [locks[field]], cur.Payment_ID + ' ' + field + ' must be refused with the lock reason');
        assert.deepEqual(plan.ops, [], cur.Payment_ID + ' ' + field + ' sends nothing');
        seen.push(cur.Payment_ID + ':' + field);
      } else {
        assert.deepEqual(plan.errors, [], cur.Payment_ID + ' ' + field + ' must be accepted');
      }
    });
  });
  // pins the policy, so a change to the lock rules shows here
  assert.deepEqual(seen, ['PM-1:amount', 'PM-2:amount', 'PM-2:note', 'PM-3:amount', 'PM-3:note', 'PM-4:note', 'PM-9:amount', 'PM-9:date', 'PM-9:method', 'PM-9:note']);
});

// ---------------------------------------------------------------- real calendar dates for payment, expense and purchase dates (fix wave, M)
test('payment, expense and purchase dates must be real calendar dates (2026-02-30 is refused)', () => {
  const st = base({ payments: [pay('PM-1', 'C-1', 1, 500)],
    expenses: [{ Expense_ID: 'EX-1', Date: '2026-10-03', Category: 'VPN', Amount: 100, Paid_With: '', Note: '' }],
    purchases: [{ Purchase_ID: 'P-1', Date: '2026-10-03', Account_ID: 'NFX-03', Paid_With: '', Amount: 100, Covers_Until: '', Notes: '' }],
    accounts: [{ Account_ID: 'NFX-03', Product_ID: 'NETFLIX' }] });
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', date: '2026-02-30' }).errors[0], /Date must be like/);
  assert.match(S().planEditPayment(st, { paymentId: 'PM-1', date: '2026-13-01' }).errors[0], /Date must be like/);
  assert.match(S().planEditExpense(st, { expenseId: 'EX-1', date: '2026-02-30' }).errors[0], /Date must be like/);
  assert.match(S().planEditPurchase(st, { purchaseId: 'P-1', date: '2026-02-30' }).errors[0], /Date must be like/);
  assert.deepEqual(S().planEditPayment(st, { paymentId: 'PM-1', date: '2028-02-29' }).errors, [], 'a leap day is real');
  assert.deepEqual(S().planEditExpense(st, { expenseId: 'EX-1', date: '2026-10-31' }).errors, []);
  assert.deepEqual(S().planEditPurchase(st, { purchaseId: 'P-1', date: '2026-10-31' }).errors, []);
});

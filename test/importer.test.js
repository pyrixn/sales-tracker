const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

const TABS = { Customers: ['customers', 'Customer_ID'], Sales_Log: ['sales', 'Sale_ID'], Payments: ['payments', 'Payment_ID'],
  Accounts: ['accounts', 'Account_ID'], Purchases: ['purchases', 'Purchase_ID'], Code_Inventory: ['codes', 'Code_ID'],
  Payment_Inbox: ['inbox', 'Transaction_ID'], Import_Rows: ['importRows', 'Row_ID'] };

// Applies planner ops to a state copy (append, update, clear), like the adapter would.
function applyOps(state, ops) {
  const s = Object.assign({}, state);
  Object.values(TABS).forEach(t => { s[t[0]] = (state[t[0]] || []).map(r => Object.assign({}, r)); });
  ops.forEach(o => {
    const [f, key] = TABS[o.tab];
    if (o.op === 'append') s[f].push(Object.assign({}, o.values));
    else if (o.op === 'update') { const r = s[f].find(x => x[o.key || key] === o.id); Object.assign(r, o.values); }
    else if (o.op === 'clear') s[f] = s[f].filter(x => x[o.key || key] !== o.id);
  });
  return s;
}
const ok = r => { assert.deepEqual(r.errors, []); return r; };
const run = (state, r) => applyOps(state, ok(r).ops);

function base() {
  return {
    today: '2026-10-20', settings: {},
    products: [
      { Product_ID: 'NFX', Product_Name: 'Netflix 4K', Billing_Cycle_Days: 30, Default_Price: 500, Letter: 'N', Delivers_As: 'account', Active: 'Yes' },
      { Product_ID: 'XL', Product_Name: 'Xlag', Billing_Cycle_Days: 90, Default_Price: 900, Letter: 'X', Delivers_As: 'account', Active: 'Yes' },
      { Product_ID: 'XLR', Product_Name: 'Xlag rent 1D', Billing_Cycle_Days: 1, Default_Price: 50, Letter: 'XR', Parent_ID: 'XL', Delivers_As: 'account', Active: 'Yes' },
      { Product_ID: 'XLK', Product_Name: 'Xlag key', Billing_Cycle_Days: 30, Default_Price: 100, Letter: 'K', Delivers_As: 'code', Active: 'Yes' }
    ],
    accounts: [{ Account_ID: 'NFX-01', Product_ID: 'NFX', Account_Label: 'Family  One', Cycle_Cost: 1000, Slots: 4, Renewal_Date: '2026-11-01', Account_Status: 'Active', Cost_Per_Slot: 250 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Test Alpha', Handle: 'alpha_h' }],
    sales: [{ Sale_ID: 1, Sale_Date: '2026-10-01', Customer: 'Test Alpha', Contact: '', Product_ID: 'NFX', Account_ID: 'NFX-01', Code_ID: '', Qty: 1,
      Unit_Price: 500, Paid_Till: '2026-11-01', Record_Status: 'Active', Customer_ID: 'CU-0001', Months: 1, Sub_Code: 'N1', Cost_Snapshot: 0 }],
    payments: [{ Payment_ID: 'PM-00001', Date: '2026-10-01', Customer_ID: 'CU-0001', Sale_ID: 1, Amount: 200, Transaction_ID: 'TRX0' }],
    purchases: [{ Purchase_ID: 'P-0001', Date: '2026-10-01', Account_ID: 'NFX-01', Amount: 1000, Covers_Until: '2026-11-01' }],
    codes: [{ Code_ID: 'C-0001', Product_ID: 'XLK', Code: 'KEY-OLD', Status: 'Available' }],
    inbox: [{ Transaction_ID: 'TRXOLD', Status: 'Pending' }], wallets: [], expenses: [], importRows: []
  };
}

const row = (id, kind, data, extra) => Object.assign({ id, kind, sheet: 'Tab', ref: id, data }, extra);
function stage(state, rows) { return run(state, Core.importer.planStage(state, { batch: 'b1', rows })); }
function approveAll(state) {
  return run(state, Core.importer.planSetStatus(state, { rowIds: state.importRows.map(r => r.Row_ID), status: 'Approved' }));
}
const rowOf = (s, id) => s.importRows.find(r => r.Row_ID === id);

test('planStage is idempotent and validates', () => {
  const s0 = base(), rows = [row('r1', 'account', { productHint: 'netflix', label: 'x' })];
  const r1 = ok(Core.importer.planStage(s0, { batch: 'b1', rows }));
  assert.deepEqual(r1.result, { added: 1, skipped: 0 });
  assert.equal(r1.ops[0].values.Status, 'Review');
  const s1 = applyOps(s0, r1.ops);
  assert.deepEqual(ok(Core.importer.planStage(s1, { batch: 'b1', rows })).result, { added: 0, skipped: 1 });
  assert.ok(Core.importer.planStage(s0, { batch: 'b1', rows: [row('', 'line', {})] }).errors.length);
  assert.ok(Core.importer.planStage(s0, { batch: 'b1', rows: [row('x'.repeat(201), 'line', {})] }).errors.length);
  assert.ok(Core.importer.planStage(s0, { batch: 'b1', rows: [row('r', 'nope', {})] }).errors.length);
  assert.ok(Core.importer.planStage(s0, { batch: 'b1', rows: [row('r', 'line', 'text')] }).errors.length);
});

test('planStage rejects "@" and names the row', () => {
  const r = Core.importer.planStage(base(), { batch: 'b1', rows: [row('bad-1', 'account', { label: 'a@b.c' })] });
  assert.equal(r.ops.length, 0);
  assert.match(r.errors[0], /bad-1/);
});

test('review matches product, account label, customer, existing line, code, inbox', () => {
  let s = stage(base(), [
    row('a1', 'account', { productHint: 'netflix', label: ' family one ', collected: 700, cost: 1000, renewalDate: '2026-12-01', slots: 4 }),
    row('l1', 'line', { accountRef: 'a1', name: 'test  alpha', status: 'Paid', amount: 500, paidTill: '2026-12-01' }),
    row('l2', 'line', { accountRef: 'a1', name: 'Test Beta', status: 'Paid', amount: 200, paidTill: '2026-12-01' }),
    row('c1', 'code', { productHint: 'xlag key', code: 'key-old' }),
    row('c2', 'code', { productHint: 'xlag key', code: 'KEY-NEW' }),
    row('i1', 'inbox', { Transaction_ID: 'trxold', Amount: 10 })
  ]);
  const rv = Core.importer.review(s, { batch: 'b1' });
  const acc = rv.accounts[0];
  assert.equal(acc.match.product.id, 'NFX');
  assert.equal(acc.match.account.id, 'NFX-01');
  assert.ok(acc.match.candidates.accounts.length <= 5);
  const l1 = acc.lines.find(l => l.id === 'l1'), l2 = acc.lines.find(l => l.id === 'l2');
  assert.equal(l1.match.customer.id, 'CU-0001');
  assert.equal(l1.match.sale.saleId, 1);
  assert.equal(l1.match.sale.difference, 300);
  assert.equal(l2.match.customer, null);
  assert.equal(l2.match.sale, null);
  assert.equal(acc.sheetCollected, 700);
  assert.equal(acc.stagedTotal, 700);
  assert.equal(acc.difference, 0);
  assert.equal(rv.codes.find(c => c.id === 'c1').match.code.id, 'C-0001');
  assert.equal(rv.codes.find(c => c.id === 'c2').match.code, null);
  assert.equal(rv.inbox[0].match.inInbox, true);
  assert.equal(rv.counts.line.Review, 2);
});

test('review shows a difference for a missing line and matches customer by handle', () => {
  const s = stage(base(), [
    row('a1', 'account', { productHint: 'netflix', label: 'Family One', collected: 900, cost: 1000, slots: 4 }),
    row('l1', 'line', { accountRef: 'a1', name: 'ALPHA_H', status: 'Paid', amount: 500, paidTill: '2026-12-01' })
  ]);
  const acc = Core.importer.review(s, { batch: 'b1' }).accounts[0];
  assert.equal(acc.difference, 400);
  assert.equal(acc.lines[0].match.customer.id, 'CU-0001');
});

test('review issues', () => {
  const s = stage(base(), [
    row('a1', 'account', { productHint: 'nothing', label: '', cost: 10, slots: 2, flags: ['label-hidden'] }),
    row('a2', 'account', { productHint: 'netflix', label: 'Other', cost: 10, slots: 2 }),
    row('l1', 'line', { accountRef: 'a2', name: 'Test Gamma', status: 'Paid', amount: '', paidTill: '2026-09-01' }),
    row('l2', 'line', { accountRef: 'a2', name: 'test gamma', status: 'Paid', amount: '220-250', paidTill: '2026-12-01' })
  ]);
  const rv = Core.importer.review(s, { batch: 'b1' });
  const a1 = rv.accounts.find(a => a.row.id === 'a1');
  assert.ok(a1.issues.some(i => /No product/.test(i)));
  assert.ok(a1.issues.some(i => /hidden/.test(i)));
  const a2 = rv.accounts.find(a => a.row.id === 'a2');
  const l1 = a2.lines.find(l => l.id === 'l1'), l2 = a2.lines.find(l => l.id === 'l2');
  assert.ok(l1.issues.some(i => /Amount is blank/.test(i)));
  assert.ok(l1.issues.some(i => /past/.test(i)));
  assert.ok(l1.issues.some(i => /Another line/.test(i)));
  assert.ok(l2.issues.some(i => /text/.test(i)));
});

test('planEditRow whitelists fields, stores the match, refuses Applied', () => {
  let s = stage(base(), [row('l1', 'line', { accountRef: 'a1', name: 'Test Beta', amount: 100 })]);
  const r = ok(Core.importer.planEditRow(s, { rowId: 'l1', data: { amount: 250, bogus: 'x', use: { customerId: 'CU-0001' } }, note: 'hi', match: { customerId: 'CU-0001' } }));
  s = applyOps(s, r.ops);
  const d = JSON.parse(rowOf(s, 'l1').Data);
  assert.equal(d.amount, 250);
  assert.equal(d.bogus, undefined);
  assert.deepEqual(d.use, { customerId: 'CU-0001' });
  assert.equal(rowOf(s, 'l1').Note, 'hi');
  assert.ok(Core.importer.planEditRow(s, { rowId: 'l1', match: { customerId: 'CU-9999' } }).errors.length);
  assert.ok(Core.importer.planEditRow(s, { rowId: 'l1', data: { name: 'a@b.c' } }).errors.length);
  s.importRows[0].Status = 'Applied';
  assert.match(Core.importer.planEditRow(s, { rowId: 'l1', data: { amount: 1 } }).errors[0], /applied/);
  assert.ok(Core.importer.planDeleteRow(s, { rowId: 'l1' }).errors.length);
  assert.ok(Core.importer.planSetStatus(s, { rowIds: ['l1'], status: 'Skipped' }).errors.length);
});

test('planAddRow ids, delete and status', () => {
  let s = stage(base(), [row('r1', 'code', { code: 'K' })]);
  s = run(s, Core.importer.planAddRow(s, { batch: 'b1', kind: 'code', data: { code: 'K2', junk: 1 } }));
  s = run(s, Core.importer.planAddRow(s, { batch: 'b1', kind: 'code', data: { code: 'K3' } }));
  assert.ok(rowOf(s, 'b1:manual-1') && rowOf(s, 'b1:manual-2'));
  assert.equal(JSON.parse(rowOf(s, 'b1:manual-1').Data).junk, undefined);
  s = run(s, Core.importer.planSetStatus(s, { rowIds: ['r1'], status: 'Skipped' }));
  assert.equal(rowOf(s, 'r1').Status, 'Skipped');
  s = run(s, Core.importer.planDeleteRow(s, { rowId: 'b1:manual-1' }));
  assert.equal(rowOf(s, 'b1:manual-1'), undefined);
  assert.ok(Core.importer.planSetStatus(s, { rowIds: ['r1'], status: 'Applied' }).errors.length);
});

test('apply: new account then a line on it, new customer reused, dependency order', () => {
  let s = stage(base(), [
    // staged out of order on purpose: lines before the account
    row('l1', 'line', { accountRef: 'a9', name: 'Test Delta', profile: 'P1', status: 'Paid', amount: 400, paidTill: '2026-12-15' }),
    row('l2', 'line', { accountRef: 'a9', name: 'test  delta', status: 'Due', amount: 300, paidTill: '2026-12-15', coversFrom: '2026-11-15' }),
    row('a9', 'account', { productHint: 'Netflix', label: 'Fresh Acc', cost: 800, slots: 2, renewalDate: '2026-12-15' })
  ]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.result.applied, 3);
  assert.deepEqual(r.result.created, { customers: 1, sales: 2, payments: 1, accounts: 1, purchases: 1, codes: 0, inbox: 0 });
  const tabs = r.ops.filter(o => o.tab !== 'Import_Rows').map(o => o.tab);
  assert.ok(tabs.indexOf('Accounts') < tabs.indexOf('Sales_Log'));
  const sale1 = r.ops.find(o => o.tab === 'Sales_Log').values;
  assert.equal(sale1.Account_ID, 'NFX-02');
  assert.equal(sale1.Covers_From, '2026-11-15');
  assert.equal(sale1.Sale_Date, '2026-11-15');
  assert.equal(sale1.Unit_Price, 400);
  assert.equal(sale1.Months, 1);
  assert.equal(sale1.Cost_Snapshot, 0);
  assert.equal(sale1.Record_Status, 'Active');
  assert.ok(sale1.Sub_Code && sale1.Pay_Token);
  const pay = r.ops.find(o => o.tab === 'Payments').values;
  assert.equal(pay.Amount, 400);
  assert.equal(pay.Source, 'Migration');
  assert.equal(pay.Note, 'Tab!l1');
  assert.equal(pay.Date, '2026-11-15');
  const sales = r.ops.filter(o => o.tab === 'Sales_Log');
  assert.equal(sales[0].values.Customer_ID, sales[1].values.Customer_ID);
  const s2 = applyOps(s, r.ops);
  assert.equal(rowOf(s2, 'l1').Status, 'Applied');
  assert.ok(JSON.parse(rowOf(s2, 'a9').Applied).accounts.length === 1);
  assert.match(JSON.parse(rowOf(s2, 'l1').Applied).sales[0] + '', /\d+/);
  // already applied: nothing left to do
  assert.ok(Core.importer.planApply(s2, { batch: 'b1' }).errors.length);
});

test('apply: default coversFrom is paidTill minus one cycle; ended flag', () => {
  let s = stage(base(), [
    row('a1', 'account', { productHint: 'xlag', label: 'X acc', cost: 900, slots: 3, renewalDate: '2027-01-10' }),
    row('l1', 'line', { accountRef: 'a1', name: 'Test Eps', status: 'Paid', amount: 900, paidTill: '2027-01-10', ended: true })
  ]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  const sale = r.ops.find(o => o.tab === 'Sales_Log').values;
  assert.equal(sale.Covers_From, '2026-10-12'); // 90-day cycle
  assert.equal(sale.Record_Status, 'Ended');
});

test('apply: existing account updates and adds a purchase; existing line adds only the difference', () => {
  let s = stage(base(), [
    row('a1', 'account', { productHint: 'netflix', label: 'family one', cost: 1100, slots: 5, renewalDate: '2026-12-01' }),
    row('l1', 'line', { accountRef: 'a1', name: 'Test Alpha', status: 'Paid', amount: 500, paidTill: '2026-11-01' })
  ]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.tab === 'Accounts' && o.op === 'append').length, 0);
  assert.equal(r.ops.filter(o => o.tab === 'Purchases').length, 1);
  assert.equal(r.ops.find(o => o.tab === 'Purchases').values.Covers_Until, '2026-12-01');
  assert.ok(r.ops.some(o => o.tab === 'Accounts' && o.values.Slots === 5));
  assert.equal(r.ops.filter(o => o.tab === 'Sales_Log' && o.op === 'append').length, 0);
  const pays = r.ops.filter(o => o.tab === 'Payments');
  assert.equal(pays.length, 1);
  assert.equal(pays[0].values.Amount, 300);
  assert.equal(pays[0].values.Sale_ID, 1);
  assert.equal(r.ops.filter(o => o.tab === 'Sales_Log').length, 0); // Paid_Till never touched
  assert.equal(r.result.created.customers, 0);
});

test('apply: extras use Unlogged payment customer once and the rent product', () => {
  let s = stage(base(), [
    row('a1', 'account', { productHint: 'xlag', label: 'X acc', cost: 900, slots: 3, renewalDate: '2027-01-10' }),
    row('e1', 'extra', { accountRef: 'a1', amount: 50, coversFrom: '2026-10-05', paidTill: '2026-10-06' }),
    row('e2', 'extra', { accountRef: 'a1', amount: 240, label: 'Custom' })
  ]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.tab === 'Customers').length, 1);
  assert.equal(r.ops.find(o => o.tab === 'Customers').values.Name, 'Unlogged payment');
  const sales = r.ops.filter(o => o.tab === 'Sales_Log').map(o => o.values);
  assert.equal(sales[0].Product_ID, 'XLR');
  assert.equal(sales[0].Covers_From, '2026-10-05');
  assert.equal(sales[1].Notes, 'Custom');
  assert.equal(r.ops.filter(o => o.tab === 'Payments').length, 2);
  // second apply on a later state reuses the customer
  const s2 = applyOps(s, r.ops);
  s2.importRows = s2.importRows.map(x => x.Row_ID === 'e1' ? x : x);
  const s3 = run(s2, Core.importer.planStage(s2, { batch: 'b2', rows: [row('b2e', 'extra', { accountRef: 'NFX-01', amount: 20 }, {})] }));
  const s4 = run(s3, Core.importer.planSetStatus(s3, { rowIds: ['b2e'], status: 'Approved' }));
  const r2 = ok(Core.importer.planApply(s4, { batch: 'b2' }));
  assert.equal(r2.ops.filter(o => o.tab === 'Customers').length, 0);
  assert.equal(r2.ops.find(o => o.tab === 'Sales_Log').values.Product_ID, 'NFX');
});

test('apply: codes and inbox', () => {
  let s = stage(base(), [
    row('c1', 'code', { productHint: 'Xlag key', code: 'KEY-A', family: 'HONE', redeemed: true }),
    row('c2', 'code', { productHint: 'Xlag key', code: 'key-old' }),
    row('i1', 'inbox', { Transaction_ID: 'trxnew', Amount: 120, Status: 'Matched', Method: 'bKash' }),
    row('i2', 'inbox', { Transaction_ID: 'TRXOLD', Amount: 5 })
  ]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  const codes = r.ops.filter(o => o.tab === 'Code_Inventory');
  assert.equal(codes.length, 1);
  assert.equal(codes[0].values.Status, 'Sold');
  const inbox = r.ops.filter(o => o.tab === 'Payment_Inbox');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].values.Transaction_ID, 'TRXNEW');
  assert.equal(inbox[0].values.Status, 'Matched');
  assert.equal(r.result.applied, 4);
  assert.deepEqual([r.result.created.codes, r.result.created.inbox], [1, 1]);
});

test('apply: only approved rows; a bad row is skipped, the rest apply', () => {
  let s = stage(base(), [
    row('a1', 'account', { productHint: 'netflix', label: 'Good', cost: 500, slots: 2 }),
    row('a2', 'account', { productHint: 'nothing-here', label: 'Bad', cost: 500, slots: 2 }),
    row('a3', 'account', { productHint: 'netflix', label: 'Idle', cost: 500, slots: 2 })
  ]);
  s = run(s, Core.importer.planSetStatus(s, { rowIds: ['a1', 'a2'], status: 'Approved' }));
  const r = Core.importer.planApply(s, { batch: 'b1' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.result.applied, 1);
  assert.equal(r.result.skipped.length, 1);
  assert.equal(r.result.skipped[0].rowId, 'a2');
  assert.match(r.result.skipped[0].error, /No product matches/);
  s = run(s, Core.importer.planSetStatus(s, { rowIds: ['a2'], status: 'Skipped' }));
  const ok2 = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(ok2.result.applied, 1);
  assert.ok(!ok2.ops.some(o => o.id === 'a3'));
  // explicit ids must be approved
  assert.ok(Core.importer.planApply(s, { batch: 'b1', rowIds: ['a3'] }).errors.length);
});

test('apply: line with no usable account fails with the row id', () => {
  let s = stage(base(), [row('l1', 'line', { accountRef: 'nowhere', name: 'Test Zed', amount: 5, paidTill: '2026-12-01' })]);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.result.applied, 0);
  assert.equal(r.result.skipped[0].rowId, 'l1');
  assert.match(r.result.skipped[0].error, /No account row matches/);
});

// ---- blocking issues, partial apply, overrides
const pt = (extra) => [
  row('a1', 'account', { productHint: 'netflix', label: 'Acc', cost: 500, slots: 4 }),
  row('l1', 'line', Object.assign({ accountRef: 'a1', name: 'Test Pt', status: 'Paid', amount: 100 }, extra || {})),
  row('l2', 'line', { accountRef: 'a1', name: 'Test Ok', status: 'Paid', amount: 100, paidTill: '2026-12-01' })
];
const viewOf = (s, id) => { const r = Core.importer.review(s, { batch: 'b1' }); return r.accounts[0].lines.find(l => l.id === id); };

test('review flags a blank paid till as blocking with fixes, and the computed one', () => {
  const s = stage(base(), pt());
  const v = viewOf(s, 'l1');
  assert.ok(v.blocks);
  assert.ok(v.issues.some(t => /Paid till is blank/.test(t)));
  assert.equal(v.blocking[0].severity, 'blocks apply');
  assert.equal(v.blocking[0].field, 'paidTill');
  const c = v.fixes.find(f => f.id === 'paidTill-computed');
  assert.equal(c.value, '2026-11-20');   // today + 1 month
  assert.ok(v.fixes.find(f => f.picker));
  assert.equal(viewOf(s, 'l2').blocks, false);
  assert.equal(viewOf(s, 'l2').blocking.length, 0);
});

test('apply: one bad row is skipped (stays Approved), the rest applies in one batch', () => {
  const s = approveAll(stage(base(), pt()));
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.result.applied, 2);
  assert.deepEqual(r.result.skipped.map(x => x.rowId), ['l1']);
  assert.match(r.result.skipped[0].error, /Paid till is blank/);
  assert.equal(r.result.skipped[0].ref, 'Tab!l1');
  const s2 = applyOps(s, r.ops);
  assert.equal(rowOf(s2, 'l1').Status, 'Approved');
  assert.equal(rowOf(s2, 'l2').Status, 'Applied');
  assert.equal(s2.customers.filter(c => c.Name === 'Test Pt').length, 0);   // nothing of the bad row leaks
});

test('apply: children of a skipped parent are skipped too', () => {
  const s = approveAll(stage(base(), [
    row('a1', 'account', { productHint: 'nothing-here', label: 'Bad', cost: 500, slots: 2 }),
    row('l1', 'line', { accountRef: 'a1', name: 'Test Kid', status: 'Paid', amount: 100, paidTill: '2026-12-01' }),
    row('x1', 'extra', { accountRef: 'a1', amount: 50 }),
    row('c1', 'code', { code: 'KEY-NEW', productHint: 'xlag key' })
  ]));
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.result.applied, 1);
  const by = Object.fromEntries(r.result.skipped.map(x => [x.rowId, x.error]));
  assert.match(by.a1, /No product matches/);
  assert.equal(by.l1, 'Account Tab!a1 could not be applied.');
  assert.equal(by.x1, 'Account Tab!a1 could not be applied.');
});

test('override: setting paid till (computed fix) lets the row apply', () => {
  let s = stage(base(), pt());
  const fix = viewOf(s, 'l1').fixes.find(f => f.id === 'paidTill-computed');
  s = run(s, Core.importer.planEditRow(s, { rowId: 'l1', data: fix.values }));
  assert.equal(viewOf(s, 'l1').blocks, false);
  s = approveAll(s);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.deepEqual(r.result.skipped, []);
  const out = applyOps(s, r.ops);
  const sale = out.sales.find(x => x.Customer === 'Test Pt');
  assert.equal(sale.Paid_Till, fix.value);
  assert.equal(sale.Sale_Date, '2026-10-20');
});

// ---- duplicate guards: the live DB may already hold what the sheet shows
function applied(state, rows) { return approveAll(stage(state, rows)); }
const line = (extra) => row('l1', 'line', Object.assign({ accountRef: 'NFX-01', name: 'Test Alpha', status: 'Paid', amount: 500, paidTill: '2026-11-01' }, extra));
const noRowOps = r => r.ops.filter(o => o.tab !== 'Import_Rows');

test('line with a later paid-till is a renewal: new sale + payment, old marked Renewed, no in-place extension', () => {
  const s = applied(base(), [line({ paidTill: '2026-12-01', amount: 500 })]);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  const old = r.ops.find(o => o.op === 'update' && o.tab === 'Sales_Log');
  assert.deepEqual(old.values, { Record_Status: 'Renewed' });
  const sale = r.ops.find(o => o.op === 'append' && o.tab === 'Sales_Log').values;
  assert.equal(sale.Paid_Till, '2026-12-01');
  assert.equal(sale.Sub_Code, 'N1');
  assert.equal(sale.Customer_ID, 'CU-0001');
  const pay = r.ops.find(o => o.tab === 'Payments').values;
  assert.equal(pay.Amount, 500);
  assert.equal(pay.Sale_ID, sale.Sale_ID);
  assert.ok(!r.ops.some(o => o.op === 'update' && o.tab === 'Sales_Log' && 'Paid_Till' in o.values));
  // staging the same line again after applying changes nothing
  const s2 = applyOps(s, r.ops);
  const s3 = run(s2, Core.importer.planStage(s2, { batch: 'b2', rows: [Object.assign(line({ paidTill: '2026-12-01' }), { id: 'l2' })] }));
  const s4 = run(s3, Core.importer.planSetStatus(s3, { rowIds: ['l2'], status: 'Approved' }));
  assert.deepEqual(noRowOps(ok(Core.importer.planApply(s4, { batch: 'b2' }))), []);
});

test('renewal with status Due creates the sale but no payment', () => {
  const s = applied(base(), [line({ paidTill: '2026-12-01', status: 'Due' })]);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.op === 'append' && o.tab === 'Sales_Log').length, 1);
  assert.equal(r.ops.filter(o => o.tab === 'Payments').length, 0);
});

test('line with paid-till at or before the panel tops up only that sale row, never extends', () => {
  const s = applied(base(), [line({ paidTill: '2026-10-15', amount: 500 })]);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.tab === 'Sales_Log').length, 0);
  const pays = r.ops.filter(o => o.tab === 'Payments');
  assert.equal(pays.length, 1);
  assert.equal(pays[0].values.Amount, 300);
  assert.equal(pays[0].values.Sale_ID, 1);
});

test('Ended line matches the existing sale instead of being recreated', () => {
  const st = base();
  st.sales[0].Record_Status = 'Ended';
  const s = applied(st, [line({ paidTill: '2026-11-01', amount: 200, ended: true })]);
  const rv = Core.importer.review(s, { batch: 'b1' });
  assert.equal(rv.orphans[0].match.sale.saleId, 1);
  assert.ok(rv.orphans[0].issues.some(i => /Already in the panel: 1/.test(i)));
  assert.deepEqual(noRowOps(ok(Core.importer.planApply(s, { batch: 'b1' }))), []);
});

function withExtra(st) {
  st.customers.push({ Customer_ID: 'CU-0002', Name: 'Unlogged payment' });
  st.sales.push({ Sale_ID: 2, Sale_Date: '2026-10-05', Customer: 'Unlogged payment', Product_ID: 'NFX', Account_ID: 'NFX-01', Qty: 1,
    Unit_Price: 50, Paid_Till: '2026-10-06', Covers_From: '2026-10-05', Record_Status: 'Active', Customer_ID: 'CU-0002', Months: 1, Notes: 'Rent or custom amount' });
  return st;
}
const extraRow = (data, use) => row('e1', 'extra', Object.assign({ accountRef: 'NFX-01', amount: 50, coversFrom: '2026-10-05', paidTill: '2026-10-06' }, data, use ? { use } : {}));

test('extra already in the panel is flagged and skipped on apply, creating nothing', () => {
  const s = applied(withExtra(base()), [extraRow()]);
  const e = Core.importer.review(s, { batch: 'b1' }).orphans[0];
  assert.ok(e.issues.some(i => /Already in the panel: 2/.test(i)));
  assert.equal(e.match.sale.saleId, 2);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.deepEqual(noRowOps(r), []);
  const mark = r.ops.find(o => o.tab === 'Import_Rows').values;
  assert.equal(mark.Status, 'Applied');
  assert.match(mark.Applied, /already in the panel as 2/);
});

test('extra differing in amount or date is not a duplicate; owner can force create-new', () => {
  let s = applied(withExtra(base()), [extraRow({ amount: 60 })]);
  assert.equal(ok(Core.importer.planApply(s, { batch: 'b1' })).ops.filter(o => o.tab === 'Sales_Log').length, 1);
  s = applied(withExtra(base()), [extraRow({ coversFrom: '2026-10-07', paidTill: '2026-10-08' })]);
  assert.equal(ok(Core.importer.planApply(s, { batch: 'b1' })).ops.filter(o => o.tab === 'Sales_Log').length, 1);
  s = stage(withExtra(base()), [extraRow()]);
  s = run(s, Core.importer.planEditRow(s, { rowId: 'e1', match: { saleId: 'new' } }));
  s = approveAll(s);
  const rv = Core.importer.review(s, { batch: 'b1' }).orphans[0];
  assert.ok(!rv.issues.some(i => /Already in the panel/.test(i)));
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.tab === 'Sales_Log' && o.op === 'append').length, 1);
  assert.equal(r.ops.filter(o => o.tab === 'Payments').length, 1);
});

test('two renewal rows for one line in one apply chain: original Renewed, first Renewed, last Active', () => {
  const s = applied(base(), [line({ paidTill: '2026-12-01' }), Object.assign(line({ paidTill: '2027-01-01' }), { id: 'l2' })]);
  const out = applyOps(s, ok(Core.importer.planApply(s, { batch: 'b1' })).ops);
  const by = id => out.sales.find(x => x.Sale_ID === id);
  const added = out.sales.filter(x => x.Sale_ID !== 1).sort((a, b) => a.Sale_ID - b.Sale_ID);
  assert.equal(added.length, 2);
  assert.equal(by(1).Record_Status, 'Renewed');
  assert.equal(added[0].Paid_Till, '2026-12-01');
  assert.equal(added[0].Record_Status, 'Renewed');
  assert.equal(added[1].Paid_Till, '2027-01-01');
  assert.equal(added[1].Record_Status, 'Active');
  assert.equal(out.sales.filter(x => x.Record_Status === 'Active').length, 1);
});

test('two identical extra rows in one batch: second is flagged and skipped', () => {
  const s = applied(base(), [extraRow(), Object.assign(extraRow(), { id: 'e2' })]);
  const rv = Core.importer.review(s, { batch: 'b1' });
  assert.ok(JSON.stringify(rv).includes('Duplicate of row e1 in this batch'));
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  assert.equal(r.ops.filter(o => o.op === 'append' && o.tab === 'Sales_Log').length, 1);
  assert.equal(r.ops.filter(o => o.tab === 'Payments').length, 1);
  const mark = r.ops.find(o => o.tab === 'Import_Rows' && o.id === 'e2').values;
  assert.match(mark.Applied, /Duplicate of row e1 in this batch/);
});

test('existing customer, two seats P1/P2 paid to same date: one renewal + one new sale, two payments', () => {
  const s = applied(base(), [line({ profile: 'P1', paidTill: '2026-12-01' }), Object.assign(line({ profile: 'P2', paidTill: '2026-12-01' }), { id: 'l2' })]);
  const r = ok(Core.importer.planApply(s, { batch: 'b1' }));
  const out = applyOps(s, r.ops);
  const added = out.sales.filter(x => x.Sale_ID !== 1).sort((a, b) => a.Sale_ID - b.Sale_ID);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map(x => x.Contact), ['P1', 'P2']);
  assert.equal(out.sales.find(x => x.Sale_ID === 1).Record_Status, 'Renewed');
  assert.equal(r.ops.filter(o => o.tab === 'Payments').length, 2);
  assert.equal(out.payments.filter(p => p.Source === 'Migration').length, 2);
});

test('existing seat with a different non-blank profile is never matched; same profile is', () => {
  const b = base(); b.sales[0].Contact = 'P1';
  const s = applied(b, [line({ profile: 'P2', paidTill: '2026-12-01' })]);
  const out = applyOps(s, ok(Core.importer.planApply(s, { batch: 'b1' })).ops);
  assert.equal(out.sales.find(x => x.Sale_ID === 1).Record_Status, 'Active');
  assert.equal(out.sales.length, 2);
  const s2 = applied(b, [line({ profile: 'P1', paidTill: '2026-12-01' })]);
  const out2 = applyOps(s2, ok(Core.importer.planApply(s2, { batch: 'b1' })).ops);
  assert.equal(out2.sales.find(x => x.Sale_ID === 1).Record_Status, 'Renewed');
});

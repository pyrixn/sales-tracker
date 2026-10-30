const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { appendsOf, appendOf, ok } = require('./helpers');

const S = () => Core.sales;

// Copy the rows a planner appends into a state copy, so later planners see them.
function commit(state, r) {
  appendsOf(r, 'Customers').forEach(o => state.customers.push(o.values));
  appendsOf(r, 'Sales_Log').forEach(o => state.sales.push(o.values));
  appendsOf(r, 'Payments').forEach(o => state.payments.push(o.values));
  return state;
}

function tinder(state, extra) {
  return S().planCustomSale(state, Object.assign({ customerId: cid(state, 'Kabir'), title: 'Tinder Premium',
    price: 600, cost: 450, date: '2026-10-25' }, extra || {}));
}

test('custom sale: one Sales_Log append, no product, account, code or schedule', () => {
  const m = makeMigratedState();
  const r = ok(tinder(m));
  const sale = appendOf(r, 'Sales_Log').values;
  assert.equal(sale.Product_ID, 'CUSTOM');
  assert.equal(sale.Notes, 'Tinder Premium');
  assert.equal(sale.Unit_Price, 600);
  assert.equal(sale.Cost_Snapshot, 450);
  assert.equal(sale.Months, 1);
  assert.equal(sale.Qty, 1);
  assert.equal(sale.Paid_Till, '');
  assert.equal(sale.Account_ID, '');
  assert.equal(sale.Code_ID, '');
  assert.equal(sale.Sub_Code, '');
  assert.equal(sale.Pay_Token, '');
  assert.equal(sale.Sale_Date, '2026-10-25');
  assert.equal(sale.Customer_ID, cid(m, 'Kabir'));
  assert.equal(sale.Record_Status, 'Active');
  assert.equal(appendsOf(r, 'Payments').length, 0);
  assert.equal(r.result.customerId, cid(m, 'Kabir'));
  assert.equal(r.result.saleId, appendOf(r, 'Sales_Log').values.Sale_ID);
});

test('custom sale with paidNow adds one payment on the new sale', () => {
  const m = makeMigratedState();
  const r = ok(tinder(m, { paidNow: { amount: 600, method: 'bKash', trxId: 'tx9' } }));
  const pays = appendsOf(r, 'Payments');
  assert.equal(pays.length, 1);
  assert.equal(pays[0].values.Sale_ID, r.result.saleId);
  assert.equal(pays[0].values.Amount, 600);
  assert.equal(pays[0].values.Transaction_ID, 'TX9');
  assert.equal(pays[0].values.Date, '2026-10-25');
});

test('custom sale with a new customer appends the customer first', () => {
  const m = makeMigratedState();
  const max = Math.max(...m.customers.map(c => Number(c.Customer_ID.slice(3))));
  const r = ok(S().planCustomSale(m, { newCustomer: { name: 'Fresh Buyer' }, title: 'Tinder Premium', price: 600 }));
  const cust = appendOf(r, 'Customers');
  assert.equal(r.ops[0].tab, 'Customers');
  assert.equal(cust.values.Customer_ID, 'CU-' + String(max + 1).padStart(4, '0'));
  assert.equal(cust.values.Name, 'Fresh Buyer');
  assert.equal(appendOf(r, 'Sales_Log').values.Customer_ID, cust.values.Customer_ID);
  assert.equal(appendOf(r, 'Sales_Log').values.Customer, 'Fresh Buyer');
  const dup = S().planCustomSale(m, { newCustomer: { name: 'Kabir' }, title: 'Tinder Premium', price: 600 });
  assert.deepEqual(dup.errors, ['A customer named "Kabir" already exists. Pick them from the list.']);
});

test('custom sale validation refuses bad input and writes nothing', () => {
  const m = makeMigratedState();
  const kabir = cid(m, 'Kabir');
  const base = { customerId: kabir, title: 'Tinder Premium', price: 600, cost: 450, date: '2026-10-25' };
  const t = (over) => S().planCustomSale(m, Object.assign({}, base, over));
  const cases = [
    [{ title: '   ' }, 'Give the item a name (up to 80 characters).'],
    [{ title: 'x'.repeat(81) }, 'Give the item a name (up to 80 characters).'],
    [{ price: 0 }, 'Amount must be more than 0.'],
    [{ price: 'x' }, 'Amount must be more than 0.'],
    [{ cost: -1 }, 'Cost must be 0 or more.'],
    [{ cost: 1000000 }, 'Cost must be less than 1,000,000.'],
    [{ date: '2026-02-30' }, 'Date must be like 2026-10-18.'],
    [{ customerId: undefined }, 'Pick a customer or type a new name.'],
    [{ customerId: 'CU-9999' }, 'Unknown customer CU-9999.'],
    [{ paidNow: { amount: 0, method: 'bKash' } }, 'Amount must be more than 0.'],
  ];
  cases.forEach(([over, err]) => {
    const r = t(over);
    assert.deepEqual(r.errors, [err], JSON.stringify(over));
    assert.deepEqual(r.ops, []);
  });
  m.payments.push({ Payment_ID: 'PM-99999', Sale_ID: 1, Amount: 1, Transaction_ID: 'TX9' });
  assert.deepEqual(t({ paidNow: { amount: 600, method: 'bKash', trxId: 'tx9' } }).errors, ['Transaction TX9 is already recorded.']);
});

test('custom sale revenue, cost, price and balance read as the planner intends', () => {
  const m = makeMigratedState();
  const r = ok(tinder(m));
  const row = appendOf(r, 'Sales_Log').values;
  assert.equal(Core.ledger.saleRevenue(row, m.products), 600);
  assert.equal(Core.ledger.saleCostBdt(row, commit(m, r)), 450);
  assert.equal(Core.ledger.salePrice(row, m.products), 600);
});

test('CUSTOM is reserved for custom sales in the product planner', () => {
  const m = makeMigratedState();
  const base = { name: 'Custom', category: 'Subscription', letter: 'CU', price: 100, cycleDays: 30, slots: 1, accountCost: 10 };
  assert.deepEqual(S().planProduct(m, base).errors, ['CUSTOM is reserved for custom sales.']);
  assert.deepEqual(S().planProduct(m, Object.assign({}, base, { name: 'Other', productId: 'custom' })).errors,
    ['CUSTOM is reserved for custom sales.']);
});

test('planEdit on a custom sale: notes and price yes, end date and account refused', () => {
  const m = makeMigratedState();
  const r = ok(tinder(m));
  commit(m, r);
  const id = r.result.saleId;
  assert.deepEqual(ok(S().planEdit(m, { kind: 'sale', id, values: { Notes: 'Tinder Premium x2' } })).ops.length, 1);
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id, values: { Paid_Till: '2026-12-01' } }).errors, ['A custom sale has no end date.']);
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id, values: { Account_ID: 'NFX-01' } }).errors, ['A custom sale has no account or code.']);
  assert.equal(ok(S().planEdit(m, { kind: 'sale', id, values: { Unit_Price: 650 } })).ops.length, 1);
});

// ---------------------------------------------------------------- Task 2: views, profit and reminders

/** Fixture plus the Tinder custom sale (and optionally its 600 payment), committed into the state. */
function withCustom(paid) {
  const m = makeMigratedState();
  const r = ok(tinder(m, paid ? { paidNow: { amount: 600, method: 'bKash', trxId: 'TX-T1' } } : {}));
  commit(m, r);
  return { state: m, saleId: r.result.saleId, customerId: r.result.customerId };
}

test('customer page: custom sale leaves the lines and shows under customSales', () => {
  const { state, saleId, customerId } = withCustom(false);
  const d = Core.views.customerData(state, customerId);
  assert.equal(d.lines.some(l => l.saleId === saleId), false);
  assert.equal(d.customSales.length, 1);
  assert.equal(d.customSales[0].productName, 'Tinder Premium');
  assert.equal(d.customSales[0].custom, true);
  assert.equal(d.history.some(h => h.saleId === saleId), true);
});

test('profit: custom sales fall in the Custom category; Subscription totals unchanged', () => {
  const base = makeMigratedState();
  const { state } = withCustom(false);
  const cat = (rows, name) => rows.find(f => f.category === name);
  const custom = cat(Core.views.profitByFamily(state), 'Custom');
  assert.deepEqual([custom.revenue, custom.cost, custom.profit], [600, 450, 150]);
  assert.deepEqual(custom.products[0], { productId: 'CUSTOM', name: 'Custom sales', revenue: 600, cost: 450, profit: 150, uncollected: 600, collectedProfit: -450 });
  const before = Core.views.profitByFamily(base).filter(f => f.category !== 'Custom');
  const after = Core.views.profitByFamily(state).filter(f => f.category !== 'Custom');
  assert.deepEqual(after, before);
});

test('money overview: CUSTOM product row with revenue and profit, no extra account row', () => {
  const base = makeMigratedState();
  const { state } = withCustom(false);
  const o = Core.money.overview(state, '2026-10');
  const row = o.products.find(p => p.productId === 'CUSTOM');
  assert.equal(row.name, 'Custom sales');
  assert.equal(row.category, 'Custom');
  assert.deepEqual([row.revenue, row.profit], [600, 150]);
  assert.equal(o.accounts.length, Core.money.overview(base, '2026-10').accounts.length);
});

test('accounts and seats are identical with and without the custom sale', () => {
  const base = makeMigratedState();
  const { state } = withCustom(false);
  assert.deepEqual(Core.views.accountsOverview(state), Core.views.accountsOverview(base));
  state.accounts.forEach(a => {
    assert.equal(Core.sales.freeSlots(state, a), Core.sales.freeSlots(base, base.accounts.find(b => b.Account_ID === a.Account_ID)));
  });
});

test('home and reminders: no renew or due item for a custom sale, paid or unpaid', () => {
  for (const paid of [false, true]) {
    const { state, saleId } = withCustom(paid);
    const home = Core.views.homeData(state);
    [...home.renewSoon, ...home.expired].forEach(r => assert.notEqual(r.productName, 'Tinder Premium'));
    const items = Core.reminders.planReminders(state);
    assert.equal(items.some(i => i.saleId === saleId), false, 'paid=' + paid);
  }
});

test('dues: an unpaid custom sale shows with its title and no ref; not in paylinks or lookups', () => {
  const { state, saleId } = withCustom(false);
  const row = Core.views.duesList(state).rows.find(r => r.saleId === saleId);
  assert.equal(row.amount, 600);
  assert.equal(row.productName, 'Tinder Premium');
  assert.equal(row.subCode, '');
  const links = Core.paylinks.list(state);
  assert.equal((Array.isArray(links) ? links : links.rows || []).some(l => l.saleId === saleId), false);
  assert.equal(Core.views.lookups(state).lines.some(l => l.saleId === saleId), false);
});

test('book: the custom sale payment shows as cash in', () => {
  const { state } = withCustom(true);
  const book = Core.views.bookData(state, '2026-10');
  const entry = book.entries.find(e => e.kind === 'in' && e.amount === 600);
  assert.ok(entry, 'expected a 600 cash-in entry');
  assert.equal(entry.label, 'Kabir');
});

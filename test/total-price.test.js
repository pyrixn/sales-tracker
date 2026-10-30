const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

function st() {
  return {
    today: '2026-10-20', settings: {},
    products: [{ Product_ID: 'NFX', Product_Name: 'Streaming A', Billing_Cycle_Days: 30, Default_Price: 150, Letter: 'N', Delivers_As: 'account', Active: 'Yes' }],
    accounts: [{ Account_ID: 'NFX-02', Product_ID: 'NFX', Account_Label: 'B', Cycle_Cost: 1000, Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 250 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Test Alpha' }],
    sales: [{ Sale_ID: 1, Sale_Date: '2026-04-01', Customer: 'Test Alpha', Product_ID: 'NFX', Account_ID: 'NFX-02', Code_ID: '', Qty: 1, Unit_Price: 150,
      Paid_Till: '2026-10-25', Record_Status: 'Active', Customer_ID: 'CU-0001', Months: 6, Sub_Code: 'N1' }],
    payments: [], purchases: [], codes: [], wallets: [], expenses: [], importRows: [], inbox: []
  };
}
const base = { productId: 'NFX', customerId: 'CU-0001', accountId: 'NFX-02' };
const appended = (plan, tab) => plan.ops.filter(o => o.op === 'append' && o.tab === tab).map(o => o.values);
const newSale = extra => Core.sales.planNewSale(st(), Object.assign({}, base, extra));
const renew = extra => Core.sales.planRenew(st(), Object.assign({ subCode: 'N1' }, extra));

test('new sale: 6 months for 800 total bills exactly 800 and paid-now 800 clears it', () => {
  const p = newSale({ months: 6, total: 800, paidNow: { amount: 800, method: 'bKash', trxId: 'TRXT1' } });
  assert.deepEqual(p.errors, []);
  const s = appended(p, 'Sales_Log')[0];
  assert.equal(s.Months, 6);
  assert.equal(Core.ledger.saleRevenue(s, st().products), 800);
  const pays = appended(p, 'Payments');
  assert.equal(pays.length, 1);
  assert.equal(pays[0].Amount, 800);
  assert.equal(pays[0].Sale_ID, s.Sale_ID);
});

test('new sale: total spreads about 133.33 a month and sums to 800', () => {
  const p = newSale({ months: 6, total: 800 });
  const s = appended(p, 'Sales_Log')[0];
  const state = Object.assign(st(), { sales: [Object.assign({ Covers_From: s.Covers_From }, s)] });
  const res = Core.accrual.monthly(state, { from: '2026-10', to: '2027-04' });
  const rev = res.months.map(m => m.revenue);
  assert.ok(rev.filter(x => x > 0).length >= 6);
  assert.equal(Math.round(rev.reduce((a, b) => a + b, 0) * 100) / 100, 800);
  const full = rev.filter(x => x > 120 && x < 145);
  assert.ok(full.length >= 4, 'full months near 133.33: ' + rev.join(','));
});

test('new sale: per-month price mode unchanged', () => {
  const s = appended(newSale({ months: 6, price: 150 }), 'Sales_Log')[0];
  assert.equal(s.Unit_Price, 150);
  assert.equal(Core.ledger.saleRevenue(s, st().products), 900);
});

test('total must be more than 0', () => {
  assert.deepEqual(newSale({ months: 2, total: 0 }).errors, ['Total must be more than 0.']);
  assert.deepEqual(newSale({ months: 2, total: '800' }).errors, ['Total must be more than 0.']);
});

test('renew: total 800 for 6 months bills 800, credit/paid-now against it', () => {
  const p = renew({ months: 6, total: 800, paidNow: { amount: 800, method: 'bKash', trxId: 'TRXT2' } });
  assert.deepEqual(p.errors, []);
  const s = appended(p, 'Sales_Log')[0];
  assert.equal(Core.ledger.saleRevenue(s, st().products), 800);
  assert.equal(appended(p, 'Payments')[0].Amount, 800);
});

test('odd quotient: 100 over 3 months bills exactly 100', () => {
  const s = appended(newSale({ months: 3, total: 100 }), 'Sales_Log')[0];
  assert.equal(Core.ledger.saleRevenue(s, st().products), 100);
});

for (const role of ['staff', 'viewer']) {
  test(role + ': custom total refused, catalog total allowed', () => {
    const PRICE = 'Only the owner can set a custom price.';
    assert.deepEqual(newSale({ months: 6, total: 800, _role: role }).errors, [PRICE]);
    assert.deepEqual(newSale({ months: 6, total: 900, _role: role }).errors, []);
    assert.deepEqual(renew({ months: 6, total: 800, _role: role }).errors, [PRICE]);
    assert.deepEqual(renew({ months: 6, total: 900, _role: role }).errors, []);
  });
}

// ---- edit and split
const edit = (values, extra) => Core.sales.planEdit(st(), Object.assign({ kind: 'sale', id: 1, values }, extra));

test('edit: Total + Months sets Unit_Price so revenue is the total', () => {
  const p = edit({ Total: 800, Months: 6 });
  assert.deepEqual(p.errors, []);
  const v = p.ops[0].values;
  assert.equal(v.Months, 6);
  assert.ok(!('Total' in v));
  assert.equal(Core.ledger.saleRevenue(Object.assign({ Qty: 1 }, v), []), 800);
});

test('edit: Total alone uses the sale Months (6)', () => {
  const v = edit({ Total: 600 }).ops[0].values;
  assert.equal(v.Unit_Price, 100);
});

test('edit: Total refused for staff, and not with Unit_Price', () => {
  assert.deepEqual(edit({ Total: 800 }, { _role: 'staff' }).errors.length, 1);
  assert.equal(edit({ Total: 800, Unit_Price: 100 }).errors.length, 1);
  assert.deepEqual(edit({ Total: 0 }).errors, ['Total must be more than 0.']);
});

test('split: newSale and renew items take their total', () => {
  const row = { Transaction_ID: 'TRXS1', Amount: 1600, Received: '2026-10-20 10:00', Type: 'Received', Sender: '16247', Status: 'Pending', Method: 'bKash' };
  const state = Object.assign(st(), { inbox: [row] });
  const p = Core.matching.planSplitMatch(state, row, { customerId: 'CU-0001', targets: [
    { kind: 'newSale', productId: 'NFX', accountId: 'NFX-02', months: 6, total: 800 },
    { kind: 'renew', subCode: 'N1', months: 6, total: 800 }] });
  assert.deepEqual(p.errors, []);
  const sales = p.ops.filter(o => o.op === 'append' && o.tab === 'Sales_Log').map(o => o.values);
  assert.equal(sales.length, 2);
  sales.forEach(s => assert.equal(Core.ledger.saleRevenue(s, state.products), 800));
  assert.equal(p.ops.filter(o => o.tab === 'Payments').reduce((a, o) => a + o.values.Amount, 0), 1600);
});

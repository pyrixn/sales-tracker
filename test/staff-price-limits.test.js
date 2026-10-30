const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

function st() {
  return {
    today: '2026-10-20', settings: {},
    products: [{ Product_ID: 'NFX', Product_Name: 'Netflix', Billing_Cycle_Days: 30, Default_Price: 500, Letter: 'N', Delivers_As: 'account', Active: 'Yes' }],
    accounts: [{ Account_ID: 'NFX-01', Product_ID: 'NFX', Account_Label: 'A', Cycle_Cost: 1000, Slots: 1, Account_Status: 'Active', Cost_Per_Slot: 250 },
      { Account_ID: 'NFX-02', Product_ID: 'NFX', Account_Label: 'B', Cycle_Cost: 1000, Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 250 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Test Alpha' }],
    sales: [{ Sale_ID: 1, Sale_Date: '2026-10-01', Customer: 'Test Alpha', Product_ID: 'NFX', Account_ID: 'NFX-01', Code_ID: '', Qty: 1, Unit_Price: 500,
      Paid_Till: '2026-11-01', Record_Status: 'Active', Customer_ID: 'CU-0001', Months: 1, Sub_Code: 'N1' }],
    payments: [], purchases: [], codes: [], wallets: [], expenses: [], importRows: [],
    inbox: [{ Transaction_ID: 'TRXA', Amount: 500, Received: '2026-10-20 10:00', Type: 'Received', Sender: '16247', Status: 'Pending' }]
  };
}
const sale = (role, extra) => Core.sales.planNewSale(st(), Object.assign({ productId: 'NFX', customerId: 'CU-0001', accountId: 'NFX-02', _role: role }, extra));
const renew = (role, extra) => Core.sales.planRenew(st(), Object.assign({ subCode: 'N1', _role: role }, extra));
const PRICE = 'Only the owner can set a custom price.';

for (const role of ['staff', 'viewer']) {
  test(role + ': newSale custom price, cost, allowFull refused', () => {
    assert.deepEqual(sale(role, { price: 100 }).errors, [PRICE]);
    assert.deepEqual(sale(role, { cost: 10 }).errors, ['Only the owner can set a custom cost.']);
    assert.deepEqual(sale(role, { accountId: 'NFX-01', allowFull: true }).errors, ['Only the owner can add past a full account.']);
  });
  test(role + ': newSale catalog price ok', () => {
    assert.deepEqual(sale(role, {}).errors, []);
    assert.deepEqual(sale(role, { price: 500 }).errors, []);
  });
  test(role + ': renew custom price and paidTill refused, default ok', () => {
    assert.deepEqual(renew(role, { price: 100 }).errors, [PRICE]);
    assert.deepEqual(renew(role, { paidTill: '2027-01-01' }).errors, ['Only the owner can set a custom Paid_Till.']);
    assert.deepEqual(renew(role, {}).errors, []);
    assert.deepEqual(renew(role, { price: 500 }).errors, []);
  });
  test(role + ': customSale refused', () => {
    const r = Core.sales.planCustomSale(st(), { customerId: 'CU-0001', title: 'x', price: 10, _role: role });
    assert.deepEqual(r.errors, ['Only the owner can add a custom sale.']);
  });
  test(role + ': edit Paid_Till may shorten, not extend', () => {
    const e = (v) => Core.sales.planEdit(st(), { kind: 'sale', id: 1, values: { Paid_Till: v }, _role: role }).errors;
    assert.deepEqual(e('2026-10-25'), []);
    assert.deepEqual(e('2026-11-01'), []);
    assert.deepEqual(e('2026-11-02'), ['Only the owner can extend Paid_Till.']);
  });
  test(role + ': match amount override refused, same amount ok', () => {
    const base = { customerId: 'CU-0001', subCode: 'N1', _role: role };
    const row = st().inbox[0];
    assert.deepEqual(Core.matching.planInboxMatch(st(), row, Object.assign({ amount: 1000 }, base)).errors, ['Only the owner can override the amount.']);
    assert.deepEqual(Core.matching.planInboxMatch(st(), row, Object.assign({ amount: 500 }, base)).errors, []);
    assert.deepEqual(Core.matching.planInboxMatch(st(), row, base).errors, []);
  });
  test(role + ': splitMatch custom, amount override, custom price refused', () => {
    const row = st().inbox[0];
    const sp = (extra) => Core.matching.planSplitMatch(st(), row, Object.assign({ customerId: 'CU-0001', creditRest: true, _role: role }, extra));
    assert.match(sp({ targets: [{ kind: 'custom', title: 'x', price: 100 }] }).errors[0], /Only the owner can add a custom sale/);
    assert.deepEqual(sp({ amount: 900, targets: [{ kind: 'renew', subCode: 'N1' }] }).errors, ['Only the owner can override the amount.']);
    assert.match(sp({ targets: [{ kind: 'renew', subCode: 'N1', price: 100 }] }).errors[0], new RegExp(PRICE));
    assert.match(sp({ targets: [{ kind: 'newSale', productId: 'NFX', accountId: 'NFX-02', price: 100 }] }).errors[0], new RegExp(PRICE));
    assert.deepEqual(sp({ targets: [{ kind: 'renew', subCode: 'N1' }] }).errors, []);
  });
}

test('owner and direct call keep custom price, cost, customSale, paidTill, overrides', () => {
  for (const role of ['owner', undefined]) {
    assert.deepEqual(sale(role, { price: 100, cost: 10 }).errors, []);
    assert.deepEqual(sale(role, { accountId: 'NFX-01', allowFull: true }).errors, []);
    assert.deepEqual(renew(role, { price: 100, paidTill: '2027-01-01' }).errors, []);
    assert.deepEqual(Core.sales.planCustomSale(st(), { customerId: 'CU-0001', title: 'x', price: 10, _role: role }).errors, []);
    assert.deepEqual(Core.sales.planEdit(st(), { kind: 'sale', id: 1, values: { Paid_Till: '2027-01-01' }, _role: role }).errors, []);
    assert.deepEqual(Core.matching.planInboxMatch(st(), st().inbox[0], { customerId: 'CU-0001', subCode: 'N1', amount: 1000, _role: role }).errors, []);
  }
});

test('permissions: customSale and ignoreInbox are owner only', () => {
  for (const a of ['customSale', 'ignoreInbox']) {
    assert.equal(Core.permissions.canDo('owner', a), true);
    assert.equal(Core.permissions.canDo('staff', a), false);
    assert.equal(Core.permissions.canDo('viewer', a), false);
  }
});

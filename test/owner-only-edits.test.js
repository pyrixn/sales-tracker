const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

function st() {
  return {
    today: '2026-10-20', settings: {},
    products: [{ Product_ID: 'NFX', Product_Name: 'Netflix', Billing_Cycle_Days: 30, Default_Price: 500, Letter: 'N', Delivers_As: 'account', Active: 'Yes' }],
    accounts: [{ Account_ID: 'NFX-01', Product_ID: 'NFX', Account_Label: 'A', Cycle_Cost: 1000, Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 250 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Test Alpha' }, { Customer_ID: 'CU-0002', Name: 'Test Beta' }],
    sales: [
      { Sale_ID: 1, Sale_Date: '2026-10-01', Customer: 'Test Alpha', Product_ID: 'NFX', Account_ID: 'NFX-01', Code_ID: '', Qty: 1, Unit_Price: 500, Paid_Till: '2026-11-01', Record_Status: 'Active', Customer_ID: 'CU-0001', Months: 1 },
      { Sale_ID: 2, Sale_Date: '2026-10-01', Customer: 'Test Beta', Product_ID: 'NFX', Account_ID: 'NFX-01', Code_ID: '', Qty: 1, Unit_Price: 500, Paid_Till: '2026-11-01', Record_Status: 'Active', Customer_ID: 'CU-0002', Months: 1 },
      { Sale_ID: 3, Sale_Date: '2026-09-01', Customer: 'Test Beta', Product_ID: 'NFX', Account_ID: 'NFX-01', Code_ID: '', Qty: 1, Unit_Price: 500, Paid_Till: '2026-10-01', Record_Status: 'Void', Customer_ID: 'CU-0002', Months: 1 }
    ],
    payments: [
      { Payment_ID: 'PM-00001', Date: '2026-10-01', Customer_ID: 'CU-0001', Sale_ID: 1, Amount: 200, Transaction_ID: 'TRX1', Method: 'bKash' },
      { Payment_ID: 'PM-00002', Date: '2026-10-01', Customer_ID: 'CU-0002', Sale_ID: 2, Amount: 500, Transaction_ID: 'TRX2', Method: 'bKash' }
    ],
    purchases: [], codes: [], inbox: [], wallets: [], expenses: [], importRows: []
  };
}
const edit = (role, id, values) => Core.sales.planEdit(st(), { kind: 'sale', id, values, _role: role });

for (const role of ['staff', 'viewer']) {
  for (const f of ['Months', 'Sale_Date', 'Covers_From']) {
    test(role + ' cannot edit ' + f, () => {
      const r = edit(role, 1, { [f]: f === 'Months' ? 2 : '2026-09-01' });
      assert.deepEqual(r.errors, ['Only the owner can change ' + f + '.']);
    });
  }
  test(role + ' cannot un-void', () => {
    assert.deepEqual(edit(role, 3, { Record_Status: 'Active' }).errors, ['Only the owner can change Record_Status.']);
  });
}
test('owner and direct call can edit Months, Sale_Date and un-void', () => {
  assert.deepEqual(edit('owner', 1, { Months: 2, Sale_Date: '2026-09-01' }).errors, []);
  assert.deepEqual(edit('owner', 3, { Record_Status: 'Active' }).errors, []);
  assert.deepEqual(edit(undefined, 1, { Months: 2 }).errors, []);
});
test('staff can still edit notes', () => {
  assert.deepEqual(edit('staff', 1, { Notes: 'hi' }).errors, []);
});

test('staff cannot end a line that owes, in planEdit or planEndLine', () => {
  assert.deepEqual(edit('staff', 1, { Record_Status: 'Ended' }).errors, ['Only the owner can end a line that still owes 300.']);
  assert.deepEqual(Core.sales.planEndLine(st(), { saleId: 1, date: '2026-10-20', _role: 'staff' }).errors, ['Only the owner can end a line that still owes 300.']);
  assert.deepEqual(Core.sales.planEndLine(st(), { saleId: 1, date: '2026-10-20', _role: 'owner' }).errors, []);
  assert.deepEqual(Core.sales.planEndLine(st(), { saleId: 1, date: '2026-10-20' }).errors, []);
});
test('staff can end a fully paid line', () => {
  assert.deepEqual(edit('staff', 2, { Record_Status: 'Ended' }).errors, []);
  assert.deepEqual(Core.sales.planEndLine(st(), { saleId: 2, date: '2026-10-20', _role: 'staff' }).errors, []);
});

test('staff cannot change payment amount or move it; owner can; notes allowed', () => {
  const ep = (role, extra) => Core.sales.planEditPayment(st(), Object.assign({ paymentId: 'PM-00001', _role: role }, extra));
  assert.deepEqual(ep('staff', { amount: 100 }).errors, ['Only the owner can change Amount.']);
  assert.deepEqual(ep('staff', { saleId: '' }).errors, ['Only the owner can change Sale_ID.']);
  assert.deepEqual(ep('viewer', { saleId: 2 }).errors, ['Only the owner can change Sale_ID.']);
  assert.deepEqual(ep('staff', { amount: 200, note: 'ref' }).errors, []);
  assert.deepEqual(ep('owner', { amount: 100 }).errors, []);
  assert.deepEqual(ep(undefined, { amount: 100 }).errors, []);
});

test('staff cannot change Customer_ID or move a sale out of Refunded or Renewed', () => {
  const s = st();
  s.sales[0].Record_Status = 'Refunded'; s.sales[1].Record_Status = 'Renewed';
  const e = (id, values) => Core.sales.planEdit(s, { kind: 'sale', id, values, _role: 'staff' }).errors;
  assert.deepEqual(e(2, { Customer_ID: 'CU-0001' }), ['Only the owner can change Customer_ID.']);
  assert.deepEqual(e(1, { Record_Status: 'Active' }), ['Only the owner can change Record_Status.']);
  assert.deepEqual(e(2, { Record_Status: 'Active' }), ['Only the owner can change Record_Status.']);
  assert.deepEqual(Core.sales.planEdit(s, { kind: 'sale', id: 2, values: { Customer_ID: 'CU-0001' }, _role: 'owner' }).errors, []);
  assert.deepEqual(Core.sales.planEdit(s, { kind: 'sale', id: 1, values: { Record_Status: 'Active' }, _role: 'owner' }).errors, []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { opsFor, appendsOf, appendOf, updateOf, ok } = require('./helpers');

const S = () => Core.sales;

test('new customer Netflix sale, paid in part', () => {
  const m = makeMigratedState();
  const r = ok(S().planNewSale(m, { productId: 'NETFLIX', accountId: 'NFX-03',
    newCustomer: { name: 'Rahim', channel: 'WhatsApp', handle: '01711111111' }, profile: 'Rahim', months: 1,
    paidNow: { amount: 200, method: 'bKash' } }));
  assert.equal(r.result.saleId, 103);
  assert.equal(r.result.customerId, 'CU-0065');
  assert.equal(r.result.subCode, 'N103');
  const cust = appendOf(r, 'Customers').values;
  assert.equal(cust.Name, 'Rahim'); assert.equal(cust.Channel, 'WhatsApp'); assert.equal(cust.Created, '2026-10-18');
  const sale = appendOf(r, 'Sales_Log').values;
  assert.equal(sale.Paid_Till, '2026-11-18');
  assert.equal(sale.Sale_Date, '2026-10-18');
  assert.equal(sale.Unit_Price, 290);
  assert.equal(sale.Cost_Snapshot, 160);
  assert.equal(sale.Customer, 'Rahim');
  assert.equal(sale.Contact, 'Rahim');
  const pay = appendsOf(r, 'Payments');
  assert.equal(pay.length, 1);
  assert.deepEqual([pay[0].values.Payment_ID, pay[0].values.Sale_ID, pay[0].values.Amount, pay[0].values.Source], ['PM-00091', 103, 200, 'App']);
});

test('a 3-month sale bills three months and moves Paid_Till three months', () => {
  const m = makeMigratedState();
  const r = ok(S().planNewSale(m, { productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'Kabir'), months: 3,
    paidNow: { amount: 870, method: 'bKash' } }));
  assert.equal(appendOf(r, 'Sales_Log').values.Paid_Till, '2027-01-18');
  assert.equal(appendOf(r, 'Sales_Log').values.Months, 3);
  assert.equal(appendsOf(r, 'Payments').length, 1, 'all 870 lands on the new sale');
});

test('overpaying a new sale leaves the extra as credit', () => {
  const m = makeMigratedState();
  const r = ok(S().planNewSale(m, { productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'farid'),
    paidNow: { amount: 300, method: 'bKash' } }));
  assert.deepEqual(appendsOf(r, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount]), [[103, 290], ['', 10]]);
});

test('game code sale needs an Available code and has no Paid_Till', () => {
  const m = makeMigratedState();
  const r = ok(S().planNewSale(m, { productId: 'HONE', codeId: 'C-0001', customerId: cid(m, 'farid'), price: 150 }));
  const sale = appendOf(r, 'Sales_Log').values;
  assert.equal(sale.Code_ID, 'C-0001'); assert.equal(sale.Paid_Till, ''); assert.equal(sale.Account_ID, '');
  assert.equal(sale.Sub_Code, 'G103');
  m.sales.push(Object.assign({}, m.sales[0], { Sale_ID: 200, Product_ID: 'HONE', Code_ID: 'C-0002' }));
  assert.deepEqual(S().planNewSale(m, { productId: 'HONE', codeId: 'C-0002', customerId: cid(m, 'farid') }).errors, ['C-0002 is already sold.']);
  assert.deepEqual(S().planNewSale(m, { productId: 'HONE', codeId: 'C-0011', customerId: cid(m, 'farid') }).errors, ['C-0011 is not a HONE code.']);
});

test('validation refuses bad input and writes nothing', () => {
  const m = makeMigratedState();
  const kabir = cid(m, 'Kabir');
  const bad = (input, msg) => {
    const r = S().planNewSale(m, input);
    assert.deepEqual(r.errors, [msg]); assert.deepEqual(r.ops, []);
  };
  bad({ productId: 'EXITLAG', accountId: 'EXL-01', customerId: kabir }, 'EXL-01 has no free slot. Pick another account or add one.');
  bad({ productId: 'NETFLIX', accountId: 'EXL-02', customerId: kabir }, 'EXL-02 is not a NETFLIX account.');
  bad({ productId: 'NETFLIX', accountId: 'NFX-03', customerId: kabir, months: 13 }, 'Months must be a whole number from 1 to 12.');
  bad({ productId: 'NETFLIX', accountId: 'NFX-03', customerId: kabir, paidNow: { amount: 0, method: 'bKash' } }, 'Amount must be more than 0.');
  bad({ productId: 'NETFLIX', accountId: 'NFX-03' }, 'Pick a customer or type a new name.');
  bad({ productId: 'NETFLIX', accountId: 'NFX-03', newCustomer: { name: ' kabir ' } }, 'A customer named "Kabir" already exists. Pick them from the list.');
  bad({ productId: 'NOPE', customerId: kabir }, 'Unknown product NOPE.');
  bad({ productId: 'NETFLIX', customerId: kabir }, 'Pick an account.');
  const allowed = S().planNewSale(m, { productId: 'EXITLAG', accountId: 'EXL-01', customerId: kabir, allowFull: true });
  assert.deepEqual(allowed.errors, []);
});

test('renewing Farid for 2 months continues from his Paid_Till', () => {
  const m = makeMigratedState();
  const r = ok(S().planRenew(m, { subCode: 'N44', months: 2, paidNow: { amount: 580, method: 'bKash', trxId: 'TX1' } }));
  assert.deepEqual(updateOf(r, 44).values, { Record_Status: 'Renewed' });
  const sale = appendOf(r, 'Sales_Log').values;
  assert.equal(sale.Paid_Till, '2027-02-12');
  assert.equal(sale.Sub_Code, 'N44');
  assert.equal(sale.Customer_ID, cid(m, 'farid'));
  assert.equal(sale.Account_ID, 'NFX-01');
  assert.equal(sale.Unit_Price, 290);
  assert.deepEqual(appendsOf(r, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount, o.values.Transaction_ID]), [[103, 580, 'TX1']]);
  assert.equal(r.result.saleId, 103);
});

test('renewing an expired line starts today', () => {
  const m = makeMigratedState();
  const r = ok(S().planRenew(m, { subCode: 'N54' }));
  assert.equal(appendOf(r, 'Sales_Log').values.Paid_Till, '2026-11-18');
});

test('renewal uses existing credit with a Credit pair', () => {
  const m = makeMigratedState();
  const farid = cid(m, 'farid');
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-01', Customer_ID: farid, Sale_ID: '', Amount: 100, Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' });
  const r = ok(S().planRenew(m, { subCode: 'N44', paidNow: { amount: 190, method: 'bKash' } }));
  const pays = appendsOf(r, 'Payments').map(o => [o.values.Sale_ID, o.values.Amount, o.values.Source]);
  assert.deepEqual(pays, [['', -100, 'Credit'], [103, 100, 'Credit'], [103, 190, 'App']]);
});

test('renew refuses unknown codes and banned accounts', () => {
  const m = makeMigratedState();
  assert.deepEqual(S().planRenew(m, { subCode: 'N999' }).errors, ['No active subscription has the code N999.']);
  m.accounts.find(a => a.Account_ID === 'NFX-01').Account_Status = 'Banned';
  assert.deepEqual(S().planRenew(m, { subCode: 'N44' }).errors, ['NFX-01 is marked Banned. Move the customer to another account first.']);
});

test('payment with nothing specified pays oldest dues, the rest is credit', () => {
  const m = makeMigratedState();
  const r = ok(S().planPayment(m, { customerId: cid(m, 'Kabir'), amount: 600, method: 'bKash' }));
  assert.deepEqual(r.ops.map(o => [o.values.Sale_ID, o.values.Amount]), [[54, 300], ['', 300]]);
  assert.deepEqual(r.result, { applied: [{ saleId: 54, amount: 300 }], credit: 300, paymentIds: ['PM-00091', 'PM-00092'] });
});

test('payment to a chosen sale and duplicate transaction ids', () => {
  const m = makeMigratedState();
  const tariq = cid(m, 'tariq');
  const r = ok(S().planPayment(m, { customerId: tariq, amount: 100, method: 'Cash', saleId: 46 }));
  assert.deepEqual(r.ops.map(o => [o.values.Sale_ID, o.values.Amount]), [[46, 100]]);
  m.payments.push({ Payment_ID: 'PM-00091', Customer_ID: tariq, Sale_ID: 46, Amount: 10, Transaction_ID: 'DUP1', Source: 'App' });
  assert.deepEqual(S().planPayment(m, { customerId: tariq, amount: 10, method: 'bKash', trxId: 'dup1' }).errors, ['Transaction DUP1 is already recorded.']);
  assert.deepEqual(S().planPayment(m, { customerId: 'CU-9999', amount: 10, method: 'bKash' }).errors, ['Unknown customer CU-9999.']);
  assert.deepEqual(S().planPayment(m, { customerId: tariq, amount: 2000000, method: 'bKash' }).errors, ['Amount must be less than 1,000,000.']);
});

test('edit changes only allowed fields and keeps cost in step with the account', () => {
  const m = makeMigratedState();
  let r = ok(S().planEdit(m, { kind: 'sale', id: 54, values: { Unit_Price: 250, Account_ID: 'NFX-01' } }));
  assert.deepEqual(updateOf(r, 54).values, { Unit_Price: 250, Account_ID: 'NFX-01', Cost_Snapshot: 160 });
  r = ok(S().planEdit(m, { kind: 'customer', id: cid(m, 'Kabir'), values: { Channel: 'Discord', Handle: 'kabir#1' } }));
  assert.equal(r.ops[0].tab, 'Customers');
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, values: { Sale_Date: '2026-01-01' } }).errors, ["Sale_Date can't be edited here."]);
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, values: { Record_Status: 'Gone' } }).errors, ['Status must be Active, Renewed, Refunded or Void.']);
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, values: { Paid_Till: '18/10/2026' } }).errors, ['Paid_Till must be a date like 2026-10-18.']);
  r = ok(S().planEdit(m, { kind: 'sale', id: 54, values: { Customer_ID: cid(m, 'tariq') } }));
  assert.deepEqual(updateOf(r, 54).values, { Customer_ID: cid(m, 'tariq'), Customer: 'tariq' });
});

test('expenses, accounts, purchases, products, codes and settings', () => {
  const m = makeMigratedState();
  let r = ok(S().planExpense(m, { category: 'VPN', amount: 350, paidWith: 'UNKNOWN', note: 'Oct' }));
  assert.deepEqual(appendOf(r, 'Expenses').values, { Expense_ID: 'EX-0001', Date: '2026-10-18', Category: 'VPN', Amount: 350, Paid_With: 'UNKNOWN', Note: 'Oct' });
  assert.deepEqual(S().planExpense(m, { category: 'Food', amount: 1 }).errors, ['Category must be one of: VPN, Phone, Ads, Tools, Other.']);

  r = ok(S().planAccount(m, { productId: 'NETFLIX', label: 'new@mail.com', cycleCost: 800, slots: 5, paidWith: 'UNKNOWN', renewalDate: '2026-11-18' }));
  assert.equal(appendOf(r, 'Accounts').values.Account_ID, 'NFX-04');
  assert.equal(appendOf(r, 'Accounts').values.Account_Status, 'Active');
  assert.deepEqual([appendOf(r, 'Purchases').values.Purchase_ID, appendOf(r, 'Purchases').values.Amount], ['P-0018', 800]);

  r = ok(S().planPurchase(m, { accountId: 'NFX-01', amount: 800, paidWith: 'UNKNOWN', coversUntil: '2026-11-30' }));
  assert.equal(appendOf(r, 'Purchases').values.Account_ID, 'NFX-01');
  assert.deepEqual(updateOf(r, 'NFX-01').values, { Renewal_Date: '2026-11-30', Cycle_Cost: 800 });

  r = ok(S().planProduct(m, { name: 'Disney+', category: 'Subscription', cycleDays: 30, accountCost: 1000, slots: 4, price: 350, letter: 'd' }));
  assert.deepEqual([r.result.productId, appendOf(r, 'Product_Catalog').values.Letter], ['DISNEY', 'D']);
  assert.deepEqual(S().planProduct(m, { name: 'Nord', category: 'Subscription', cycleDays: 30, accountCost: 1, slots: 1, price: 1, letter: 'N' }).errors,
    ['Letter N is already used by NETFLIX.']);
  assert.deepEqual(S().planProduct(m, { name: 'netflix', category: 'Subscription', cycleDays: 30, accountCost: 1, slots: 1, price: 1, letter: 'Q' }).errors,
    ['A product NETFLIX already exists.']);

  r = ok(S().planAddCodes(m, { productId: 'HONE', codes: ['NEWCODE1', 'ljwc565', ' NEWCODE1 ', ''] }));
  assert.deepEqual(appendsOf(r, 'Code_Inventory').map(o => [o.values.Code_ID, o.values.Code]), [['C-0031', 'NEWCODE1']]);
  assert.deepEqual(r.result.skipped, ['ljwc565', 'NEWCODE1']);

  r = ok(S().planSettings(m, { bkash_number: '01812345678' }));
  assert.deepEqual(r.ops, [{ op: 'update', tab: 'Settings', key: 'Key', id: 'bkash_number', values: { Value: '01812345678' } }]);
  assert.deepEqual(S().planSettings(m, { hack: 1 }).errors, ['Unknown setting hack.']);
});

test('a shared id generator keeps ids unique across planners', () => {
  const m = makeMigratedState();
  const gen = Core.ids.IdGen(m);
  const a = S().planPayment(m, { customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash', _gen: gen });
  const b = S().planRenew(m, { subCode: 'N44', paidNow: { amount: 290, method: 'bKash' }, _gen: gen });
  assert.equal(a.ops[0].values.Payment_ID, 'PM-00091');
  assert.equal(appendOf(b, 'Payments').values.Payment_ID, 'PM-00092');
});

test('planWallet adds a card or bKash number by its last digits', () => {
  const m = makeMigratedState();
  const r = ok(S().planWallet(m, { label: 'City Bank card', type: 'Card', last4: '7017' }));
  assert.deepEqual(appendOf(r, 'Wallets').values, { Wallet_ID: 'CARD-7017', Label: 'City Bank card', Type: 'Card', Notes: '' });
  assert.deepEqual(S().planWallet(m, { label: 'x', type: 'Card', last4: '12345678' }).errors, ['Enter only the last 4 digits.']);
  assert.deepEqual(S().planWallet(m, { label: 'x', type: 'Gold', last4: '1234' }).errors, ['Type must be one of: Card, bKash, Nagad, Supplier credit, Cash, Other.']);
  m.wallets.push({ Wallet_ID: 'CARD-7017', Label: 'old' });
  assert.deepEqual(S().planWallet(m, { label: 'x', type: 'Card', last4: '7017' }).errors, ['Wallet CARD-7017 already exists.']);
});

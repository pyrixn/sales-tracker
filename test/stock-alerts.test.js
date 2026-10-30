// Stock and capacity alerts (uplift 4.8): Core.views.stockAlerts, the low_stock_threshold setting, and the home and lookups reads that carry them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

const TODAY = '2026-10-18';
const plusDays = n => Core.util.isoAddDays(TODAY, n);
const sale = (id, extra) => Object.assign({ Sale_ID: id, Customer_ID: 'CU-1', Customer: 'x', Product_ID: 'NET', Account_ID: 'NF-1', Record_Status: 'Active',
  Paid_Till: plusDays(10), Code_ID: '', Sub_Code: 'S' + id, Months: 1, Unit_Price: 100 }, extra || {});
const account = (id, extra) => Object.assign({ Account_ID: id, Product_ID: 'NET', Account_Label: 'Acct ' + id, Slots: 2, Cycle_Cost: 100,
  Renewal_Date: '', Account_Status: 'Active' }, extra || {});

// A small shop: one code product with codes, one with none, an inactive code product, and one subscription product.
function shop(over) {
  return Object.assign({
    today: TODAY, settings: {},
    products: [
      { Product_ID: 'HONE', Product_Name: 'Hone code', Category: 'Game Code', Active: 'Yes' },
      { Product_ID: 'GANK', Product_Name: 'Gank code', Category: 'Game Code', Active: 'Yes' },
      { Product_ID: 'OLD', Product_Name: 'Retired code', Category: 'Game Code', Active: 'No' },
      { Product_ID: 'NET', Product_Name: 'Netflix', Category: 'Subscription', Active: 'Yes' }
    ],
    accounts: [], sales: [], codes: []
  }, over || {});
}
const ofKind = (list, kind) => list.filter(a => a.kind === kind);

test('code_low: counts unsold available codes; a sold code, a pending code or a code held only by a void sale is judged on its own', () => {
  const codes = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((id, i) => ({ Code_ID: id, Product_ID: 'HONE', Code: 'X' + i, Status: 'Available' }));
  codes[5].Status = 'Pending';   // C6 is not available
  const held = [sale(1, { Account_ID: '', Product_ID: 'HONE', Code_ID: 'C5' }), sale(2, { Account_ID: '', Product_ID: 'HONE', Code_ID: 'C7', Record_Status: 'Void' })];
  // C1..C4 and C7 are unsold and available: 5 codes, above the default threshold of 3, so no alert yet.
  const five = shop({ codes, sales: held });
  assert.deepEqual(ofKind(Core.views.stockAlerts(five, five.settings), 'code_low'), [
    { kind: 'code_low', id: 'GANK', label: 'Gank code', count: 0, tab: 'accounts' }
  ]);
  // Two more codes sold: C3, C4 and C7 are left, so Hone is at the threshold and alerts with 3.
  const three = shop({ codes, sales: held.concat([sale(3, { Account_ID: '', Product_ID: 'HONE', Code_ID: 'C1' }), sale(4, { Account_ID: '', Product_ID: 'HONE', Code_ID: 'C2' })]) });
  assert.deepEqual(ofKind(Core.views.stockAlerts(three, three.settings), 'code_low'), [
    { kind: 'code_low', id: 'HONE', label: 'Hone code', count: 3, tab: 'accounts' },
    { kind: 'code_low', id: 'GANK', label: 'Gank code', count: 0, tab: 'accounts' }
  ]);
});

test('code_low: an inactive code product never alerts, and a subscription product is not a code product', () => {
  const st = shop({ codes: [] });
  const ids = Core.views.stockAlerts(st, st.settings).map(a => a.id);
  assert.ok(!ids.includes('OLD'), 'inactive product');
  assert.ok(!ids.includes('NET'), 'subscription product with no codes');
});

test('the threshold setting: default 3, a custom value, and blank or invalid values fall back to 3', () => {
  assert.equal(Core.views.LOW_STOCK_DEFAULT, 3);
  assert.equal(Core.views.lowStockThreshold({}), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: '' }), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: '  ' }), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: 'many' }), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: '-2' }), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: '2.5' }), 3);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: '1' }), 1);
  assert.equal(Core.views.lowStockThreshold({ low_stock_threshold: 0 }), 0, 'zero is a real threshold: alert only when none are left');
});

test('the threshold setting changes which products alert: custom 1 keeps a product with 2 codes quiet and alerts at 1', () => {
  const codes = [{ Code_ID: 'C1', Product_ID: 'HONE', Code: 'A', Status: 'Available' }, { Code_ID: 'C2', Product_ID: 'HONE', Code: 'B', Status: 'Available' }];
  const st = shop({ codes, settings: { low_stock_threshold: '1' } });
  assert.deepEqual(ofKind(Core.views.stockAlerts(st, st.settings), 'code_low').map(a => a.id), ['GANK'], 'two codes is above 1');
  st.codes = [codes[0]];
  assert.deepEqual(ofKind(Core.views.stockAlerts(st, st.settings), 'code_low').map(a => [a.id, a.count]), [['HONE', 1], ['GANK', 0]]);
  st.settings = { low_stock_threshold: '0' };
  assert.deepEqual(ofKind(Core.views.stockAlerts(st, st.settings), 'code_low').map(a => a.id), ['GANK'], 'zero: only the empty product');
});

test('account_full: an Active account of a timed product with no free seat; expired seats are free, other statuses and code products never count', () => {
  const st = shop({
    accounts: [
      account('F1', { Slots: 2 }),                                           // two live seats, both taken
      account('F2', { Slots: 2 }),                                           // one taken: one free
      account('F3', { Slots: 2, Account_Status: 'Banned' }),                 // not Active: not a stock alert
      account('F4', { Slots: 2, Product_ID: 'OLD' }),                        // product inactive
      account('F5', { Slots: 1 }),                                           // its only seat lapsed yesterday, so it is free
      account('F6', { Slots: 1, Product_ID: 'HONE' }),                       // a code product has no seats to sell
      account('F7', { Slots: 2, Account_Status: 'Deleted' })                 // deleted
    ],
    sales: [sale(1, { Account_ID: 'F1' }), sale(2, { Account_ID: 'F1' }), sale(3, { Account_ID: 'F2' }),
      sale(4, { Account_ID: 'F4' }), sale(5, { Account_ID: 'F4' }), sale(6, { Account_ID: 'F5', Paid_Till: plusDays(-1) }),
      sale(7, { Account_ID: 'F7' }), sale(8, { Account_ID: 'F7' })]
  });
  const full = ofKind(Core.views.stockAlerts(st, st.settings), 'account_full');
  assert.deepEqual(full, [{ kind: 'account_full', id: 'F1', label: 'Acct F1', count: 1, tab: 'accounts' }]);
});

test('account_full: a host seat counts as taken (host_seats), so one sale on a two-slot account with a host seat is full', () => {
  const st = shop({ accounts: [account('H1', { Slots: 2 })], sales: [sale(1, { Account_ID: 'H1' })], settings: { host_seats: 'NET' } });
  assert.deepEqual(ofKind(Core.views.stockAlerts(st, st.settings), 'account_full').map(a => a.id), ['H1']);
});

test('account_renewing: Renewal_Date 0 to 5 days after today, Active accounts only', () => {
  const st = shop({
    accounts: [
      account('R0', { Renewal_Date: plusDays(0) }),
      account('R5', { Renewal_Date: plusDays(5) }),
      account('R6', { Renewal_Date: plusDays(6) }),
      account('RM1', { Renewal_Date: plusDays(-1) }),
      account('RBLANK', { Renewal_Date: '' }),
      account('RIN', { Renewal_Date: plusDays(2), Account_Status: 'Inactive' }),
      account('RDEL', { Renewal_Date: plusDays(2), Account_Status: 'Deleted' })
    ]
  });
  assert.deepEqual(ofKind(Core.views.stockAlerts(st, st.settings), 'account_renewing'), [
    { kind: 'account_renewing', id: 'R0', label: 'Acct R0', count: 1, tab: 'accounts' },
    { kind: 'account_renewing', id: 'R5', label: 'Acct R5', count: 1, tab: 'accounts' }
  ]);
});

test('every entry has the shape the screens read, and the order is code products, then full accounts, then renewing accounts', () => {
  const st = shop({
    codes: [{ Code_ID: 'C1', Product_ID: 'HONE', Code: 'A', Status: 'Available' }],
    accounts: [account('A1', { Slots: 1, Renewal_Date: plusDays(1) })],
    sales: [sale(1, { Account_ID: 'A1' })]
  });
  const list = Core.views.stockAlerts(st, st.settings);
  assert.deepEqual(list.map(a => a.kind), ['code_low', 'code_low', 'account_full', 'account_renewing']);
  list.forEach(a => assert.deepEqual(Object.keys(a).sort(), ['count', 'id', 'kind', 'label', 'tab']));
  assert.ok(list.every(a => a.tab === 'accounts'));
});

test('the code count matches the codes lookups lists for every active code product (one rule, two readers)', () => {
  const m = makeMigratedState();
  const lookupCodes = {};
  Core.views.lookups(m).codes.forEach(c => { lookupCodes[c.productId] = (lookupCodes[c.productId] || 0) + 1; });
  const all = Core.views.stockAlerts(m, { low_stock_threshold: '100000' }).filter(a => a.kind === 'code_low');
  assert.ok(all.length > 0, 'the fixture has code products');
  all.forEach(a => assert.equal(a.count, lookupCodes[a.id] || 0, a.id));
});

test('homeData carries the alerts as stock and leaves the attention counts as they were', () => {
  const m = makeMigratedState();
  const home = Core.views.homeData(m);
  assert.deepEqual(home.stock, Core.views.stockAlerts(m, m.settings));
  assert.deepEqual(Object.keys(home.attention).sort(), ['budgets', 'deliveries', 'payLinks', 'payments']);
});

test('lookups carries low_stock_threshold on its settings, 3 when unset, so the All settings editor lists it', () => {
  const m = makeMigratedState();
  assert.equal(Core.views.lookups(m).settings.low_stock_threshold, 3);
  m.settings.low_stock_threshold = '1';
  assert.equal(Core.views.lookups(m).settings.low_stock_threshold, '1');
});

test('planSettings: low_stock_threshold is a whole number from 0, or blank', () => {
  const st = { settings: {} };
  ['abc', '-1', '2.5'].forEach(v => assert.match(Core.sales.planSettings(st, { low_stock_threshold: v }).errors[0], /Low stock threshold/, v));
  ['0', '5', ''].forEach(v => assert.deepEqual(Core.sales.planSettings(st, { low_stock_threshold: v }).errors, [], v));
});

test('planSettings: a key with no row yet is inserted, a stored key is updated (the threshold is saved before any row exists)', () => {
  const plan = Core.sales.planSettings({ settings: { grace_days: 3 } }, { low_stock_threshold: '1', grace_days: '4' });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops, [
    { op: 'append', tab: 'Settings', id: 'low_stock_threshold', values: { Key: 'low_stock_threshold', Value: '1' } },
    { op: 'update', tab: 'Settings', key: 'Key', id: 'grace_days', values: { Value: '4' } }
  ]);
});

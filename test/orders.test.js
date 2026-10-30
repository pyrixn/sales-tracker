// Core.orders: creating an order (catalog price check, pay request), status moves, fulfilment into a sale, and catalog fields.
// Each test works on a small state; ops are applied to it by a tiny reducer so the flow runs end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { ok } = require('./helpers');

const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const TAB_STATE = { Customers: 'customers', Sales_Log: 'sales', Payments: 'payments', Code_Inventory: 'codes', Payment_Inbox: 'inbox',
  Pay_Requests: 'payRequests', Deliveries: 'deliveries', Accounts: 'accounts', Orders: 'orders', Product_Catalog: 'products' };
const TAB_KEY = { Customers: 'Customer_ID', Sales_Log: 'Sale_ID', Payments: 'Payment_ID', Code_Inventory: 'Code_ID', Payment_Inbox: 'Transaction_ID',
  Pay_Requests: 'Request_ID', Deliveries: 'Delivery_ID', Accounts: 'Account_ID', Orders: 'Order_ID', Product_Catalog: 'Product_ID' };

/** Applies planner ops to a state in place (append, update). */
function apply(st, ops) {
  ops.forEach(op => {
    const rows = st[TAB_STATE[op.tab]], key = TAB_KEY[op.tab];
    if (op.op === 'append') rows.push(Object.assign({}, op.values));
    else if (op.op === 'update') {
      const r = rows.find(x => String(x[key]) === String(op.id));
      if (!r) throw new Error('no row ' + op.tab + ' ' + op.id);
      Object.assign(r, op.values);
    } else throw new Error('unexpected op ' + op.op);
  });
  return st;
}
/** Runs a planner, applies its ops when it succeeds, and returns the planner result. */
function run(st, plan) {
  const r = plan(st);
  if (!r.errors.length) apply(st, r.ops);
  return r;
}

function mk(extra) {
  return Object.assign({
    today: '2026-10-28', nowMs: NOW,
    settings: { pay_link_expiry_hours: '24', pay_base_url: 'https://shop.example', pay_methods: 'bkash', ref_style: 'legacy' },
    products: [
      { Product_ID: 'NF', Product_Name: 'Netflix', Category: 'Streaming', Delivers_As: 'account', Letter: 'N', Default_Price: 300,
        Billing_Cycle_Days: 30, Active: 'Yes', Slug: 'netflix', Public: true, Public_Price: 350, Sort_Order: 1 },
      { Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500,
        Active: 'Yes', Slug: '', Public: false, Public_Price: '' }
    ],
    accounts: [{ Account_ID: 'NF-01', Product_ID: 'NF', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100 }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'Rafi', Channel: '', Handle: '', Created: '2026-10-01' }],
    sales: [], payments: [], inbox: [], payIntents: [], payRequests: [], orders: [], deliveries: [],
    codes: [{ Code_ID: 'C-0001', Product_ID: 'GC', Code: 'XXXX', Status: 'Available' }, { Code_ID: 'C-0002', Product_ID: 'GC', Code: 'YYYY', Status: 'Available' }]
  }, extra || {});
}
const rnd = () => 0;   // deterministic account pick
const ids = st => Core.ids.IdGen(st);

test('catalog price: the public price when set, the default price when blank', () => {
  assert.equal(Core.orders.catalogPrice({ Default_Price: 300, Public_Price: 350 }), 350);
  assert.equal(Core.orders.catalogPrice({ Default_Price: 300, Public_Price: '' }), 300);
  assert.equal(Core.orders.catalogPrice({ Default_Price: 300, Public_Price: 0 }), 0);
});

test('isPublic: switched on, with a web address, and not inactive', () => {
  assert.equal(Core.orders.isPublic({ Public: true, Slug: 'a', Active: 'Yes' }), true);
  assert.equal(Core.orders.isPublic({ Public: false, Slug: 'a', Active: 'Yes' }), false);
  assert.equal(Core.orders.isPublic({ Public: true, Slug: '', Active: 'Yes' }), false);
  assert.equal(Core.orders.isPublic({ Public: true, Slug: 'a', Active: 'No' }), false);
});

test('planCreateOrder (panel): opens a product-less pay request at the catalog price times months, and reserves no code', () => {
  const st = mk();
  const r = ok(Core.orders.planCreateOrder(st, { source: 'panel', productId: 'NF', months: 2, customerId: 'CU-0001', nowMs: NOW, _rand: rnd }));
  const rq = r.ops.find(o => o.tab === 'Pay_Requests' && o.op === 'append').values;
  assert.equal(rq.Amount, 700);                       // 350 public price x 2 months
  assert.equal(rq.Product_ID, '');                    // nothing reserved, nothing sold yet
  assert.equal(rq.Customer_ID, 'CU-0001');
  assert.ok(!r.ops.some(o => o.tab === 'Code_Inventory' || o.tab === 'Sales_Log'));
  const order = r.ops.find(o => o.tab === 'Orders' && o.op === 'append').values;
  assert.equal(order.Order_ID, 'O-00001');
  assert.equal(order.Status, 'New');
  assert.equal(order.Total, 700);
  assert.equal(order.Unit_Price, 350);
  assert.equal(order.Pay_Request_ID, rq.Request_ID);
  assert.equal(r.result.total, 700);
  assert.ok(r.result.token.length >= 30);
});

test('planCreateOrder (panel): a typed name for a new customer goes on the request and the order', () => {
  const st = mk();
  const r = ok(Core.orders.planCreateOrder(st, { source: 'panel', productId: 'NF', customerName: 'New Person', contact: '01711111111', nowMs: NOW }));
  const order = r.ops.find(o => o.tab === 'Orders').values;
  assert.equal(order.Customer_ID, '');
  assert.equal(order.Customer_Name, 'New Person');
  assert.equal(r.ops.find(o => o.tab === 'Pay_Requests').values.Customer_Name, 'New Person');
});

test('planCreateOrder (website): refuses products that are not public and prices that moved', () => {
  const st = mk();
  assert.match(Core.orders.planCreateOrder(st, { source: 'website', productId: 'GC', customerName: 'A', contact: 'a@b.c', price: 500 }).errors[0], /not on sale/);
  const stale = Core.orders.planCreateOrder(st, { source: 'website', productId: 'NF', customerName: 'A', contact: 'a@b.c', price: 300, months: 1 });
  assert.equal(stale.code, 'price_changed');
  assert.match(stale.errors[0], /350/);
  const fresh = ok(Core.orders.planCreateOrder(st, { source: 'website', productId: 'NF', customerName: 'A', contact: 'a@b.c', price: 350, months: 1, nowMs: NOW }));
  assert.equal(fresh.result.total, 350);
});

test('planCreateOrder (website): needs the price shown and a way to reach the customer', () => {
  const st = mk();
  assert.equal(Core.orders.planCreateOrder(st, { source: 'website', productId: 'NF', customerName: 'A', contact: 'a@b.c' }).code, 'price_missing');
  assert.match(Core.orders.planCreateOrder(st, { source: 'website', productId: 'NF', customerName: 'A', price: 350 }).errors[0], /reach you/);
});

test('planCreateOrder: input limits and unknown references', () => {
  const st = mk();
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NOPE', customerName: 'A' }).errors[0], /Unknown product/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerId: 'CU-9999' }).errors[0], /Unknown customer/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF' }).errors[0], /Pick a customer/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerName: 'A', months: 13 }).errors[0], /Months/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerName: 'A', months: 1.5 }).errors[0], /Months/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerName: 'A', price: 'abc' }).errors[0], /number/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerName: 'A', note: 'x'.repeat(501) }).errors[0], /500/);
  assert.match(Core.orders.planCreateOrder(st, { productId: 'NF', customerName: 'Rafi' }).errors[0], /already exists/);
});

test('planCreateOrder: a zero price is refused (nothing to pay)', () => {
  const st = mk({ products: [{ Product_ID: 'FREE', Product_Name: 'Free', Category: 'X', Delivers_As: 'account', Letter: 'F', Default_Price: 0, Active: 'Yes' }] });
  assert.match(Core.orders.planCreateOrder(st, { productId: 'FREE', customerName: 'A' }).errors[0], /no price/);
});

test('planOrderStatus: New to AwaitingPayment, and Paid only when the pay link is paid', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', customerId: 'CU-0001', nowMs: NOW }));
  const id = 'O-00001';
  assert.equal(Core.orders.planOrderStatus(st, { id, status: 'AwaitingPayment' }).errors.length, 0);
  assert.equal(Core.orders.planOrderStatus(st, { id, status: 'Fulfilled' }).code, 'use_fulfil');
  assert.equal(Core.orders.planOrderStatus(st, { id, status: 'Nonsense' }).errors.length, 1);
  const early = Core.orders.planOrderStatus(st, { id, status: 'Paid' });
  assert.equal(early.code, 'not_paid');
  assert.match(early.errors[0], /Mark the pay link/);
  assert.equal(Core.orders.planOrderStatus(st, { id: 'O-99999', status: 'Paid' }).code, 'unknown_order');
});

test('planOrderStatus: cancelling cancels the open pay link; a paid order cannot be cancelled', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', customerId: 'CU-0001', nowMs: NOW }));
  const c = ok(Core.orders.planOrderStatus(st, { id: 'O-00001', status: 'Cancelled' }));
  assert.ok(c.ops.some(o => o.tab === 'Pay_Requests' && o.values.Status === 'Cancelled'));
  apply(st, c.ops);
  assert.equal(Core.orders.planOrderStatus(st, { id: 'O-00001', status: 'Paid' }).code, 'bad_transition');   // terminal

  const st2 = mk();
  run(st2, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', customerId: 'CU-0001', nowMs: NOW }));
  run(st2, s => Core.delivery.planConfirmRequest(s, { id: 'R1', method: 'bkash', amount: 350, trx: 'TRX1', nowMs: NOW }));
  assert.equal(Core.orders.planOrderStatus(st2, { id: 'O-00001', status: 'Paid' }).errors.length, 0);
  apply(st2, Core.orders.planOrderStatus(st2, { id: 'O-00001', status: 'Paid' }).ops);
  assert.match(Core.orders.planOrderStatus(st2, { id: 'O-00001', status: 'Cancelled' }).errors[0], /Paid|cannot/);
});

test('full flow: order, pay link confirmed, fulfilment makes the sale and attaches the payment', () => {
  const st = mk();
  const created = run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', months: 1, customerId: 'CU-0001', nowMs: NOW }));
  assert.equal(created.result.orderId, 'O-00001');
  // The owner marks the pay link paid (no product on it, so only a payment is recorded).
  const paid = run(st, s => Core.delivery.planConfirmRequest(s, { id: created.result.requestId, method: 'bkash', amount: 350, trx: 'TRXFLOW1', nowMs: NOW }));
  assert.equal(paid.errors.length, 0);
  const linkPay = st.payments.find(p => p.Transaction_ID === 'TRXFLOW1');
  assert.equal(linkPay.Sale_ID, '');
  assert.equal(linkPay.Customer_ID, 'CU-0001');   // booked to the link's customer before a sale existed

  run(st, s => Core.orders.planOrderStatus(s, { id: 'O-00001', status: 'Paid' }));
  const f = run(st, s => Core.orders.planFulfil(s, { orderId: 'O-00001', accountId: 'NF-01', _rand: rnd, nowMs: NOW }));
  assert.equal(f.errors.length, 0, f.errors.join(' | '));
  const sale = st.sales[0];
  assert.equal(sale.Product_ID, 'NF');
  assert.equal(sale.Customer_ID, 'CU-0001');
  assert.equal(sale.Months, 1);
  assert.equal(sale.Unit_Price, 350);
  assert.equal(sale.Account_ID, 'NF-01');
  assert.equal(linkPay.Sale_ID, sale.Sale_ID);             // the payment now belongs to the sale and the customer
  assert.equal(linkPay.Customer_ID, 'CU-0001');
  const o = st.orders[0];
  assert.equal(o.Status, 'Fulfilled');
  assert.equal(o.Sale_ID, sale.Sale_ID);
  assert.equal(st.payRequests[0].Sale_ID, sale.Sale_ID);
  assert.equal(st.deliveries[0].Kind, 'seat');
  assert.equal(st.deliveries[0].Status, 'Pending');
  assert.equal(f.result.saleId, sale.Sale_ID);
});

test('fulfilment: a new customer from the order is created with the sale; a second fulfil is refused', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'website', productId: 'NF', customerName: 'Nasim Web', contact: '01700000000',
    contactChannel: 'WhatsApp', price: 350, months: 3, nowMs: NOW }));
  run(st, s => Core.delivery.planConfirmRequest(s, { id: 'R1', method: 'bkash', amount: 1050, trx: 'TRXWEB1', nowMs: NOW }));
  run(st, s => Core.orders.planOrderStatus(s, { id: 'O-00001', status: 'Paid' }));
  const f = run(st, s => Core.orders.planFulfil(s, { orderId: 'O-00001', accountId: 'NF-01', _rand: rnd }));
  assert.equal(f.errors.length, 0, f.errors.join(' | '));
  const cust = st.customers.find(c => c.Name === 'Nasim Web');
  assert.ok(cust, 'customer created');
  assert.equal(cust.Handle, '01700000000');
  assert.equal(cust.Channel, 'WhatsApp');
  assert.equal(st.sales[0].Customer_ID, cust.Customer_ID);
  assert.equal(st.sales[0].Months, 3);
  assert.equal(st.payments.find(p => p.Transaction_ID === 'TRXWEB1').Customer_ID, cust.Customer_ID);
  assert.match(Core.orders.planFulfil(st, { orderId: 'O-00001', accountId: 'NF-01', _rand: rnd }).errors[0], /Fulfilled/);
});

test('fulfilment needs a paid order and a paid pay link', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', customerId: 'CU-0001', nowMs: NOW }));
  assert.match(Core.orders.planFulfil(st, { orderId: 'O-00001', _rand: rnd }).errors[0], /New. Mark it paid/);
  assert.match(Core.orders.planFulfil(st, { orderId: 'O-00009', _rand: rnd }).errors[0], /Unknown order/);
});

test('fulfilment of a code product needs a code and marks it Sold, with a delivered key', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'GC', customerId: 'CU-0001', nowMs: NOW }));
  run(st, s => Core.delivery.planConfirmRequest(s, { id: 'R1', method: 'bkash', amount: 500, trx: 'TRXGC1', nowMs: NOW }));
  run(st, s => Core.orders.planOrderStatus(s, { id: 'O-00001', status: 'Paid' }));
  assert.match(Core.orders.planFulfil(st, { orderId: 'O-00001' }).errors[0], /code/i);
  const f = run(st, s => Core.orders.planFulfil(s, { orderId: 'O-00001', codeId: 'C-0001', _rand: rnd }));
  assert.equal(f.errors.length, 0, f.errors.join(' | '));
  assert.equal(st.codes.find(c => c.Code_ID === 'C-0001').Status, 'Sold');
  assert.equal(st.deliveries[0].Kind, 'code');
  assert.equal(st.deliveries[0].Status, 'Delivered');
  assert.equal(st.deliveries[0].Code_ID, 'C-0001');
});

test('list: newest first, with the status of the pay link and its URL', () => {
  const st = mk();
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'NF', customerId: 'CU-0001', nowMs: NOW }));
  run(st, s => Core.orders.planCreateOrder(s, { source: 'panel', productId: 'GC', customerId: 'CU-0001', nowMs: NOW }));
  const rows = Core.orders.list(st);
  assert.deepEqual(rows.map(r => r.id), ['O-00002', 'O-00001']);
  assert.equal(rows[0].productName, 'Gift card');
  assert.equal(rows[0].payRequestStatus, 'Open');
  assert.match(rows[0].payUrl, /^https:\/\/shop\.example\/pay\//);
  assert.equal(rows[0].saleId, '');
});

test('planEditPublic: web address rules, uniqueness, and publishing needs an address and an active product', () => {
  const st = mk();
  assert.match(Core.orders.planEditPublic(st, { productId: 'GC', public: true }).errors[0], /web address/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'GC', slug: 'Bad Slug!' }).errors[0], /web address/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'GC', slug: 'netflix' }).errors[0], /already uses/);
  const ok1 = ok(Core.orders.planEditPublic(st, { productId: 'GC', slug: 'gift-cards', public: true }));
  assert.deepEqual(ok1.ops[0].values, { Slug: 'gift-cards', Public: true });
  const inactive = mk({ products: [{ Product_ID: 'X', Product_Name: 'X', Delivers_As: 'account', Letter: 'X', Active: 'No', Slug: '' }] });
  assert.match(Core.orders.planEditPublic(inactive, { productId: 'X', slug: 'x', public: true }).errors[0], /inactive/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NF', public: 'yes' }).errors[0], /on or off/);
});

test('planEditPublic: description, image path, sort order and public price; blank price clears it; only given fields change', () => {
  const st = mk();
  const r = ok(Core.orders.planEditPublic(st, { productId: 'NF', description: '  Streaming for one month  ', imagePath: 'products/netflix.png',
    sortOrder: '3', publicPrice: 399.456 }));
  assert.deepEqual(r.ops[0].values, { Description: 'Streaming for one month', Image_Path: 'products/netflix.png', Sort_Order: 3, Public_Price: 399.46 });
  const cleared = ok(Core.orders.planEditPublic(st, { productId: 'NF', publicPrice: '' }));
  assert.deepEqual(cleared.ops[0].values, { Public_Price: '' });
  assert.equal(Core.orders.planEditPublic(st, { productId: 'NF' }).ops.length, 0);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NF', imagePath: '../secret.png' }).errors[0], /storage path/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NF', imagePath: 'a b.png' }).errors[0], /storage path/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NF', sortOrder: 1.5 }).errors[0], /Sort order/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NF', publicPrice: -1 }).errors[0], /0 or more/);
  assert.match(Core.orders.planEditPublic(st, { productId: 'NOPE', description: 'x' }).errors[0], /Unknown product/);
});

test('ids: order ids count up from the highest existing order', () => {
  const st = mk({ orders: [{ Order_ID: 'O-00007' }] });
  assert.equal(ids(st).order(), 'O-00008');
});

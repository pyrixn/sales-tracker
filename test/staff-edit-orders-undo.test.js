// Staff edit allowlist (planEdit with _role), code-order months, and undo of order batches. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');
const { ok } = require('./helpers');

const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const S = () => Core.sales;

test('staff edit: money, status and account cost/status fields are owner only', () => {
  const m = makeMigratedState();
  const owner = 'Only the owner can change ';
  for (const f of ['Unit_Price', 'Cost_Snapshot', 'Qty']) {
    const v = f === 'Qty' ? 2 : 100;
    assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, _role: 'staff', values: { [f]: v } }).errors, [owner + f + '.']);
  }
  for (const st of ['Void', 'Refunded']) {
    assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, _role: 'staff', values: { Record_Status: st } }).errors, [owner + 'Record_Status.']);
  }
  const acc = m.accounts[0].Account_ID;
  assert.deepEqual(S().planEdit(m, { kind: 'account', id: acc, _role: 'staff', values: { Account_Status: 'Deleted' } }).errors, [owner + 'Account_Status.']);
  assert.deepEqual(S().planEdit(m, { kind: 'account', id: acc, _role: 'staff', values: { Cycle_Cost: 1 } }).errors, [owner + 'Cycle_Cost.']);
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, _role: 'viewer', values: { Unit_Price: 1 } }).errors, [owner + 'Unit_Price.']);
});

test('staff edit: customer fields and sale notes/paid-till still work; owner is unchanged', () => {
  const m = makeMigratedState();
  ok(S().planEdit(m, { kind: 'customer', id: cid(m, 'Kabir'), _role: 'staff', values: { Channel: 'Discord', Handle: 'k#1', Notes: 'x' } }));
  ok(S().planEdit(m, { kind: 'sale', id: 54, _role: 'staff', values: { Notes: 'hi', Paid_Till: '2026-10-05' } }));
  assert.deepEqual(S().planEdit(m, { kind: 'sale', id: 54, _role: 'staff', values: { Paid_Till: '2026-12-01' } }).errors, ['Only the owner can extend Paid_Till.']);
  assert.match(S().planEdit(m, { kind: 'sale', id: 54, _role: 'staff', values: { Record_Status: 'Ended' } }).errors[0], /Only the owner can end a line that still owes/);
  ok(S().planEdit(m, { kind: 'sale', id: 54, _role: 'owner', values: { Unit_Price: 250, Record_Status: 'Void' } }));
  ok(S().planEdit(m, { kind: 'sale', id: 54, values: { Unit_Price: 250 } }));
});

function orderState() {
  return {
    today: '2026-10-28', nowMs: NOW,
    settings: { pay_link_expiry_hours: '24', pay_base_url: 'https://shop.example', pay_methods: 'bkash', ref_style: 'legacy' },
    products: [{ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500,
      Active: 'Yes', Slug: '', Public: false, Public_Price: '' }],
    accounts: [], customers: [{ Customer_ID: 'CU-0001', Name: 'Rafi', Channel: '', Handle: '', Created: '2026-10-01' }],
    sales: [], payments: [], inbox: [], payIntents: [], payRequests: [], orders: [], deliveries: [],
    codes: [{ Code_ID: 'C-0001', Product_ID: 'GC', Code: 'XXXX', Status: 'Available' }]
  };
}
const STATE = { Customers: 'customers', Sales_Log: 'sales', Payments: 'payments', Code_Inventory: 'codes', Pay_Requests: 'payRequests',
  Deliveries: 'deliveries', Orders: 'orders' };
const find = (st, tab, id) => st[STATE[tab]].find(r => String(r[Core.undo.KEYS[tab]]) === String(id));
/** Applies ops to st and returns the Change_Log lines they would write. */
function applyLogged(st, ops, action) {
  const lines = [];
  ops.forEach(op => {
    const rows = st[STATE[op.tab]];
    if (op.op === 'append') {
      const key = Core.undo.KEYS[op.tab];
      rows.push(Object.assign({}, op.values));
      lines.push({ Tab: op.tab, Row_Key: String(op.values[key]), Field: '(new row)', Old: '', New: '', Action: action });
    } else {
      const r = find(st, op.tab, op.id);
      Object.keys(op.values).forEach(f => {
        if (String(r[f]) !== String(op.values[f])) lines.push({ Tab: op.tab, Row_Key: String(op.id), Field: f, Old: r[f] === undefined ? '' : r[f], New: op.values[f], Action: action });
      });
      Object.assign(r, op.values);
    }
  });
  return { batchId: 'B', lines };
}
const current = st => (tab, id, field) => { const r = find(st, tab, id); return r ? r[field] : undefined; };

test('code order: months above 1 refused, 1 accepted', () => {
  const st = orderState();
  const bad = Core.orders.planCreateOrder(st, { source: 'panel', productId: 'GC', months: 3, customerId: 'CU-0001', nowMs: NOW, _rand: () => 0 });
  assert.deepEqual(bad.errors, ['Codes are sold one at a time; months must be 1.']);
  ok(Core.orders.planCreateOrder(st, { source: 'panel', productId: 'GC', months: 1, customerId: 'CU-0001', nowMs: NOW, _rand: () => 0 }));
});

test('undo knows the Orders tab', () => {
  assert.equal(Core.undo.KEYS.Orders, 'Order_ID');
});

test('undo of orderStatus and fulfilOrder batches reverses through the planner', () => {
  const st = orderState();
  const c = ok(Core.orders.planCreateOrder(st, { source: 'panel', productId: 'GC', months: 1, customerId: 'CU-0001', nowMs: NOW, _rand: () => 0 }));
  applyLogged(st, c.ops, 'createOrder');
  const orderId = st.orders[0].Order_ID;
  st.payRequests[0].Status = 'Paid';
  const s1 = ok(Core.orders.planOrderStatus(st, { id: orderId, status: 'Paid' }));
  const b1 = applyLogged(st, s1.ops, 'orderStatus');
  const u1 = Core.undo.planUndo(b1, current(st));
  assert.deepEqual(u1.errors, []);
  const o1 = u1.ops.find(o => o.tab === 'Orders');
  assert.equal(o1.key, 'Order_ID');
  assert.equal(o1.id, orderId);
  assert.equal(o1.values.Status, b1.lines.find(l => l.Field === 'Status').Old);

  const f = ok(Core.orders.planFulfil(st, { orderId, codeId: 'C-0001', nowMs: NOW, _rand: () => 0 }));
  const b2 = applyLogged(st, f.ops, 'fulfilOrder');
  const u2 = Core.undo.planUndo(b2, current(st));
  assert.deepEqual(u2.errors, []);
  assert.ok(u2.ops.some(o => o.tab === 'Orders' && o.op === 'update' && o.values.Status === 'Paid'));
  assert.ok(u2.ops.some(o => o.tab === 'Sales_Log' && o.op === 'clear'));
  assert.ok(u2.ops.some(o => o.tab === 'Deliveries' && o.op === 'clear'));
  st.orders[0].Status = 'Cancelled';
  assert.match(Core.undo.planUndo(b2, current(st)).errors[0], /was changed after that action/);
});

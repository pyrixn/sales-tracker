// Core.permissions.redactFor: which money fields a non-owner never sees. Pure, no I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const P = Core.permissions;

const sample = () => ({
  lookups: {
    rate: 125.5,
    suppliers: [{ id: 'S1', markup: 10 }],
    expenseCategories: ['Tools'],
    products: [{ id: 'P1', price: 800, cycle: 30 }],
    accounts: [{ id: 'A1', cost: 1700, slots: 5 }]
  },
  home: { owed: 300, attention: { budgets: 2, payments: 1 }, renewSoon: [{ name: 'x', costSnapshot: 90, profile: 'p1' }] },
  accounts: { groups: [{ accounts: [{ id: 'A1', cost: 1700, collected: 1860, net: 160, due: 0, rows: [{ name: 'c', unitPrice: 800 }] }] }],
    totals: { net: 160, collected: 1860 } },
  rows: [{ expenses: 5, purchases: 6, profit: 7, margin: 1 }]
});

function keysDeep(v, out) {
  out = out || new Set();
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.add(k); keysDeep(v[k], out); }
  return out;
}

test('the owner gets the data unchanged (same object)', () => {
  const d = sample();
  assert.equal(P.redactFor('owner', 'init', d), d);
});

test('staff and viewer lose every money key at any depth', () => {
  for (const role of ['staff', 'viewer']) {
    const out = P.redactFor(role, 'init', sample());
    const left = keysDeep(out);
    for (const k of P.MONEY_KEYS) assert.equal(left.has(k), false, role + ' still has ' + k);
  }
});

test('non-money fields stay for staff: prices, cycle days, the rate in use, owed, slots', () => {
  const out = P.redactFor('staff', 'init', sample());
  assert.equal(out.lookups.rate, 125.5);
  assert.equal(out.lookups.products[0].price, 800);
  assert.equal(out.lookups.products[0].cycle, 30);
  assert.equal(out.home.owed, 300);
  assert.equal(out.lookups.accounts[0].slots, 5);
  assert.equal(out.home.attention.payments, 1);
  assert.equal(out.accounts.groups[0].accounts[0].rows[0].unitPrice, 800);
});

test('redaction does not mutate the input', () => {
  const d = sample();
  P.redactFor('viewer', 'accounts', d);
  assert.equal(d.lookups.accounts[0].cost, 1700);
  assert.equal(d.accounts.totals.net, 160);
});

test('an unknown role gets the most restricted view', () => {
  const out = P.redactFor('admin', 'init', sample());
  assert.equal(keysDeep(out).has('cost'), false);
});

test('scalars and null pass through', () => {
  assert.equal(P.redactFor('staff', 'me', 'x'), 'x');
  assert.equal(P.redactFor('staff', 'me', null), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Core } = require('./load-core');
const P = Core.permissions;

test('owner may run every listed action', () => {
  for (const action of Object.keys(P.ACTIONS)) assert.equal(P.canDo('owner', action), true, action);
});

test('staff: sales, payments and customers yes; settings, delete, money and staff admin no', () => {
  for (const a of ['newSale', 'renew', 'pay', 'edit', 'editPayment', 'mergeCustomers', 'createPayRequest', 'match', 'home', 'customer', 'accounts']) {
    assert.equal(P.canDo('staff', a), true, a);
  }
  for (const a of ['settings', 'deletePayment', 'deleteAccount', 'deleteInbox', 'moneyOverview', 'moneyExport', 'book', 'profit', 'addExpense',
    'saveBudget', 'undo', 'export', 'importApply', 'staffList', 'staffInvite', 'staffUpdate', 'addCodes']) {
    assert.equal(P.canDo('staff', a), false, a);
  }
});

test('viewer: reads only, no money', () => {
  for (const a of ['me', 'init', 'home', 'lookups', 'customer', 'dues', 'payRequests', 'deliveries', 'product']) assert.equal(P.canDo('viewer', a), true, a);
  for (const a of ['newSale', 'pay', 'editPayment', 'settings', 'moneyOverview', 'accounts', 'staffList']) assert.equal(P.canDo('viewer', a), false, a);
});

test('every role may ask who it is', () => {
  for (const role of P.ROLES) assert.equal(P.canDo(role, 'me'), true, role);
});

test('an unlisted action is owner only (default deny)', () => {
  assert.equal(P.canDo('owner', 'someNewAction'), true);
  assert.equal(P.canDo('staff', 'someNewAction'), false);
  assert.equal(P.canDo('viewer', 'someNewAction'), false);
  assert.equal(P.canDo('staff', 'constructor'), false, 'inherited names are not actions');
  assert.equal(P.canDo('owner', 'toString'), true, 'an inherited name is owner only like any unlisted action');
});

test('unknown, empty or non-string role is refused for every action', () => {
  for (const role of [undefined, null, '', 'admin', 'Owner', 'secret', 'constructor', ['owner'], { toString: () => 'owner' }]) {
    assert.equal(P.canDo(role, 'me'), false, String(role));
    assert.equal(P.canDo(role, 'home'), false, String(role));
  }
  assert.equal(P.isRole('owner'), true);
  assert.equal(P.isRole('__proto__'), false);
});

test('every API action in edge.js is classified here (no silent drift)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'edge.js'), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^  ([a-zA-Z]+): async function/gm)) names.add(m[1]);
  const missing = [...names].filter(n => !Object.prototype.hasOwnProperty.call(P.ACTIONS, n));
  assert.deepEqual(missing, [], 'actions in edge.js with no entry in src/core/permissions.js');
});

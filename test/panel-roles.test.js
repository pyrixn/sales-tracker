// Panel role gate (web/src/lib/roles.js), UI-free: the module is plain ESM with no imports, so the test loads it with the
// export keywords stripped and checks the rule. The server remains the real gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'lib', 'roles.js'), 'utf8').replace(/^export /gm, '');
const { canOpenSheet, VIEW_ONLY_SHEETS } = new Function(src + '\nreturn { canOpenSheet: canOpenSheet, VIEW_ONLY_SHEETS: VIEW_ONLY_SHEETS };')();

test('a viewer opens no sale, payment or edit sheet', () => {
  for (const name of ['newSale', 'pay', 'renew', 'editSale', 'editPayment', 'endLine', 'payRequest', 'gotPaidRequest']) {
    assert.equal(canOpenSheet('viewer', name), false, name);
  }
  assert.ok(VIEW_ONLY_SHEETS.length >= 8);
});

test('a viewer may still open read sheets (customer card, reminder message)', () => {
  assert.equal(canOpenSheet('viewer', 'customer'), true);
  assert.equal(canOpenSheet('viewer', 'message'), true);
});

test('staff, owner and the not-yet-known role are not restricted here', () => {
  for (const role of ['owner', 'staff', '']) {
    assert.equal(canOpenSheet(role, 'newSale'), true, role);
    assert.equal(canOpenSheet(role, 'pay'), true, role);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { appendsOf } = require('./helpers');

const match = (m, row, manual) => Core.matching.planInboxMatch(m, row, manual);
const base = { Received: '2026-10-18', Type: 'Received', Amount: 580, Reference: 'N44', Raw_SMS: '', Status: 'Pending' };

test('Upay sender 16268 auto-matches and records method as Upay', () => {
  const m = makeMigratedState();
  const row = Object.assign({}, base, { Sender: '16268', Transaction_ID: 'UP1' });
  const x = match(m, row);
  assert.equal(x.status, 'auto');
  const pay = appendsOf(x, 'Payments')[0].values;
  assert.equal(pay.Method, 'Upay');
  assert.equal(pay.Transaction_ID, 'UP1');
});

test('Upay sender by name auto-matches', () => {
  const m = makeMigratedState();
  for (const s of ['Upay', 'UPAY', ' upay ']) {
    const row = Object.assign({}, base, { Sender: s, Transaction_ID: 'UP-' + s.trim() });
    assert.equal(match(m, row).status, 'auto', s);
  }
});

test('Nagad sender 16167 auto-matches and records method as Nagad', () => {
  const m = makeMigratedState();
  const row = Object.assign({}, base, { Sender: '16167', Transaction_ID: 'NG1' });
  const x = match(m, row);
  assert.equal(x.status, 'auto');
  const pay = appendsOf(x, 'Payments')[0].values;
  assert.equal(pay.Method, 'Nagad');
  assert.equal(pay.Transaction_ID, 'NG1');
});

test('Nagad sender by name auto-matches', () => {
  const m = makeMigratedState();
  for (const s of ['Nagad', 'NAGAD', ' nagad ']) {
    const row = Object.assign({}, base, { Sender: s, Transaction_ID: 'NG-' + s.trim() });
    assert.equal(match(m, row).status, 'auto', s);
  }
});

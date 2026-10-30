const test = require('node:test');
const assert = require('node:assert/strict');
const { makeState } = require('./fixtures');

test('fixture holds the real 2026-10-18 sheet', () => {
  const s = makeState();
  assert.equal(s.today, '2026-10-18');
  assert.equal(s.sales.length, 102);
  assert.equal(s.accounts.length, 17);
  assert.equal(s.products.length, 10);
  assert.equal(s.codes.length, 30);
  assert.equal(s.sales.find(x => x.Sale_ID === 54).Customer, 'Kabir');
  assert.equal(s.sales.find(x => x.Sale_ID === 44).Paid_Till, '2026-12-12');
  assert.equal(s.sales.find(x => x.Sale_ID === 102).Paid_Till, '2026-02-28');
  assert.deepEqual(s.sales.filter(x => !(x.Amount_Paid > 0)).map(x => x.Sale_ID),
    [15, 40, 46, 51, 52, 54, 58, 71, 74, 90, 93, 94]);
  assert.equal(s.sales.find(x => x.Sale_ID === 15).Unit_Price, 0);
  assert.equal(s.payments.length, 0);
  assert.equal(s.settings.grace_days, 3);
  assert.equal(s.accounts.find(a => a.Account_ID === 'SPT-02').Cost_Per_Slot, 250 / 6);
});

test('makeState returns an independent copy each call', () => {
  const a = makeState(); a.sales[0].Customer = 'changed';
  assert.equal(makeState().sales[0].Customer, 'imran');
});

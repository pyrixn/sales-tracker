const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

test('addCycle uses calendar months for 30-day products and clamps month ends', () => {
  const { addCycle } = Core.util;
  assert.equal(addCycle('2026-10-18', 1, 30), '2026-11-18');
  assert.equal(addCycle('2026-01-31', 1, 30), '2026-02-28');
  assert.equal(addCycle('2026-10-18', 3, 30), '2027-01-18');
  assert.equal(addCycle('2026-10-18', 2, 7), '2026-11-01');
});

test('renewalStart continues from Paid_Till inside the grace window, else today', () => {
  const { renewalStart } = Core.util;
  assert.equal(renewalStart('2026-10-30', '2026-10-18', 3), '2026-10-30');
  assert.equal(renewalStart('2026-10-16', '2026-10-18', 3), '2026-10-16');
  assert.equal(renewalStart('2026-10-09', '2026-10-18', 3), '2026-10-18');
  assert.equal(renewalStart('', '2026-10-18', 3), '2026-10-18');
});

test('suggestPaidTill moves the end date by the change in Months and leaves a blank alone', () => {
  const { suggestPaidTill } = Core.util;
  assert.equal(suggestPaidTill('2026-11-18', 1, 3, 30), '2027-01-18');
  assert.equal(suggestPaidTill('2026-11-18', 1, 1, 30), '2026-11-18');
  assert.equal(suggestPaidTill('2026-11-18', 3, 1, 30), '2026-09-18');
  assert.equal(suggestPaidTill('2026-11-01', 2, 4, 7), '2026-11-15');
  assert.equal(suggestPaidTill('', 1, 3, 30), '');
});

test('daysBetween, round2, isoCompare, isoAddDays', () => {
  const u = Core.util;
  assert.equal(u.daysBetween('2026-10-09', '2026-10-18'), 9);
  assert.equal(u.daysBetween('2026-10-18', '2026-10-09'), -9);
  assert.equal(u.round2(0.1 + 0.2), 0.3);
  assert.equal(u.isoCompare('', '2026-01-01'), 1);
  assert.equal(u.isoCompare('2026-01-01', ''), -1);
  assert.equal(u.isoCompare('2026-01-01', '2026-01-01'), 0);
  assert.equal(u.isoAddDays('2026-12-30', 3), '2027-01-02');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../web/src/lib/format.js?t=' + Date.now());
// 2026-10-25 10:00 Dhaka is 04:00 UTC.
const NOW = Date.parse('2026-10-25T04:00:00Z');

test('timeMs reads the naive Dhaka inbox stamp as Dhaka time and ISO stamps as given', async () => {
  const { timeMs } = await load();
  assert.equal(timeMs('2026-10-25 09:30'), Date.parse('2026-10-25T03:30:00Z'));
  assert.equal(timeMs('2026-10-25 09:30:15'), Date.parse('2026-10-25T03:30:15Z'));
  assert.equal(timeMs('2026-10-25T03:30:00.000Z'), Date.parse('2026-10-25T03:30:00Z'));
  assert.ok(Number.isNaN(timeMs('')));
});

test('relTime: just now, minutes, hours, days, then the Dhaka date', async () => {
  const { relTime } = await load();
  assert.equal(relTime('2026-10-25 09:59:40', NOW), 'just now');
  assert.equal(relTime('2026-10-25 09:59', NOW), '1 min ago');
  assert.equal(relTime('2026-10-25 09:30', NOW), '30 min ago');
  assert.equal(relTime('2026-10-25 07:00', NOW), '3 h ago');
  assert.equal(relTime('2026-10-24 09:00', NOW), '1 day ago');
  assert.equal(relTime('2026-10-22 09:00', NOW), '3 days ago');
  assert.equal(relTime('2026-10-10 09:00', NOW), '10 Oct');
  assert.equal(relTime('', NOW), '');
});

test('relTime for a future time (pay link expiry) reads "in"', async () => {
  const { relTime } = await load();
  assert.equal(relTime('2026-10-25 12:00', NOW), 'in 2 h');
  assert.equal(relTime('2026-10-25 10:40', NOW), 'in 40 min');
  assert.equal(relTime('2026-10-25 10:00:30', NOW), 'just now', 'a few seconds ahead reads as now');
});

test('exactTime shows the Dhaka wall clock, 24-hour, for both stamp kinds', async () => {
  const { exactTime } = await load();
  assert.equal(exactTime('2026-10-25 09:30'), '25 Oct 2026, 09:30 Dhaka time');
  assert.equal(exactTime('2026-10-25T03:30:00.000Z'), '25 Oct 2026, 09:30 Dhaka time');
  assert.equal(exactTime('2026-10-24T18:05:00.000Z'), '25 Oct 2026, 00:05 Dhaka time', 'just after midnight in Dhaka is 00:05, never 24:05');
  assert.equal(exactTime('not a time'), 'not a time');
});

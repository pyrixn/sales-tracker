const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const J = Core.jobs;

const NOW = Date.parse('2026-10-28T12:00:00Z');
const H = 60 * 60 * 1000;

test('the five jobs are the only ones the route accepts', () => {
  assert.deepEqual(J.JOBS, ['match-sweep', 'rate', 'backup', 'cleanup', 'relay-check', 'webhooks', 'notify']);
  assert.ok(J.isJob('backup'));
  assert.ok(!J.isJob('reminders'));
  assert.ok(!J.isJob('__proto__'));
  assert.ok(!J.isJob('constructor'));
});

test('match-sweep picks Pending payment rows with a TrxID, oldest first, skipping the rest', () => {
  const st = { inbox: [
    { Transaction_ID: 'C3', Received: '2026-10-28 11:00', Status: 'Pending', Type: 'Received' },
    { Transaction_ID: 'A1', Received: '2026-10-28 09:00', Status: 'Pending', Type: 'Received' },
    { Transaction_ID: 'B2', Received: '2026-10-28 10:00', Status: 'Matched', Type: 'Received' },
    { Transaction_ID: '', Received: '2026-10-28 08:00', Status: 'Pending', Type: 'Received' },
    { Transaction_ID: 'U5', Received: '2026-10-28 07:00', Status: 'Pending', Type: 'Unrecognised' },
    { Transaction_ID: 'T6', Received: '2026-10-28 06:00', Status: 'Pending', Type: 'TopUp' }
  ] };
  assert.deepEqual(J.planMatchSweep(st), ['A1', 'C3']);
});

test('match-sweep caps the batch and tolerates an empty inbox', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ Transaction_ID: 'T' + String(100 + i), Received: '2026-10-28 ' + String(10 + (i % 10)).padStart(2, '0') + ':00', Status: 'Pending', Type: 'Received' });
  assert.equal(J.planMatchSweep({ inbox: rows }).length, J.MATCH_SWEEP_LIMIT);
  assert.equal(J.planMatchSweep({ inbox: rows }, 3).length, 3);
  assert.deepEqual(J.planMatchSweep({}), []);
});

test('rate: stale cached rate is refreshed; fresh or manual is not', () => {
  const stale = { liveRates: [{ ID: 'usdt_bdt', Rate: 120, Fetched_At: new Date(NOW - 2 * H).toISOString() }], settings: {} };
  const fresh = { liveRates: [{ ID: 'usdt_bdt', Rate: 120, Fetched_At: new Date(NOW - 60000).toISOString() }], settings: {} };
  const manual = { liveRates: [{ ID: 'usdt_bdt', Rate: 120, Fetched_At: new Date(NOW - 2 * H).toISOString() }], settings: { usdt_bdt_manual: '125' } };
  assert.deepEqual(J.planRate(stale, NOW), { refresh: true });
  assert.deepEqual(J.planRate({ liveRates: [], settings: {} }, NOW), { refresh: true }, 'no row at all is stale');
  assert.deepEqual(J.planRate(fresh, NOW), { refresh: false });
  assert.deepEqual(J.planRate(manual, NOW), { refresh: false });
});

test('backup name uses the Dhaka date, so 20:00 UTC is already the next day', () => {
  assert.equal(J.backupName(Date.parse('2026-10-28T10:00:00Z')), 'sales-tracker-2026-10-28.json');
  assert.equal(J.backupName(Date.parse('2026-10-28T20:00:00Z')), 'sales-tracker-2026-10-29.json');
  assert.equal(J.backupName(Date.parse('2026-10-28T17:59:00Z')), 'sales-tracker-2026-10-28.json');
});

test('backup prune keeps the newest 30 of its own files and never lists other objects', () => {
  const mine = [];
  for (let d = 1; d <= 35; d++) mine.push('sales-tracker-2026-09-' + String(d).padStart(2, '0') + '.json');
  const names = mine.concat(['notes.txt', 'sales-tracker-2026-10-01.csv']);
  const old = J.planBackupPrune(names, 30);
  assert.equal(old.length, 5);
  assert.ok(old.includes('sales-tracker-2026-09-01.json'));
  assert.ok(old.includes('sales-tracker-2026-09-05.json'));
  assert.ok(!old.includes('sales-tracker-2026-09-06.json'));
  assert.ok(!old.some(n => n === 'notes.txt' || n.endsWith('.csv')));
  assert.deepEqual(J.planBackupPrune(mine.slice(0, 3), 30), []);
  assert.equal(J.planBackupPrune(mine, undefined).length, 5, 'default keep is BACKUP_KEEP');
});

test('backup document wraps the whole state with format, version and export time', () => {
  const st = { today: '2026-10-28', settings: { a: '1' }, sales: [{ Sale_ID: 1 }] };
  const doc = J.backupDocument(st, '2026-10-28T10:00:00.000Z');
  assert.equal(doc.format, 'sales-tracker-backup');
  assert.equal(doc.version, 1);
  assert.equal(doc.exported, '2026-10-28T10:00:00.000Z');
  assert.deepEqual(doc.state, st);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)).state.sales, [{ Sale_ID: 1 }]);
});

test('cleanup cuts request_log and job_runs at 30 days, in ISO text', () => {
  const c = J.planCleanup(NOW);
  assert.equal(c.requestLogBefore, '2026-09-28T12:00:00.000Z');
  assert.equal(c.jobRunsBefore, '2026-09-28T12:00:00.000Z');
});

test('relay-check: alert when no SMS and no heartbeat for the window; quiet but checking in is healthy', () => {
  const old = '2026-10-28 01:00';      // 01:00 Dhaka is 19:00 UTC the day before: 17 hours before NOW
  const recent = '2026-10-28 15:00';   // 09:00 UTC: 3 hours before NOW
  assert.equal(J.planRelayCheck({ inbox: [{ Received: old }], settings: {} }, NOW).alert, true);
  assert.equal(J.planRelayCheck({ inbox: [{ Received: recent }], settings: {} }, NOW).alert, false, 'a recent SMS is enough');
  assert.equal(J.planRelayCheck({ inbox: [{ Received: old }], settings: { relay_heartbeat: new Date(NOW - H).toISOString() } }, NOW).alert, false, 'a recent heartbeat is enough');
  assert.equal(J.planRelayCheck({ inbox: [{ Received: old }], settings: { relay_heartbeat: new Date(NOW - 7 * H).toISOString() } }, NOW).alert, true);
  assert.equal(J.planRelayCheck({ inbox: [], settings: { relay_heartbeat: '' } }, NOW).alert, true, 'nothing ever seen alerts');
  assert.equal(J.planRelayCheck({ settings: {} }, NOW).alert, true);
});

test('relay-check window is configurable and reads Dhaka wall time', () => {
  // 2026-10-28 05:00 Dhaka is 23:00 UTC on 27 Oct: 13 hours before NOW.
  const st = { inbox: [{ Received: '2026-10-28 05:00' }], settings: {} };
  assert.equal(J.planRelayCheck(st, NOW).alert, true);
  assert.equal(J.planRelayCheck(st, NOW, 24).alert, false);
  assert.equal(J.planRelayCheck(st, NOW).hours, J.RELAY_HOURS);
});

test('summarize: one entry per known job in order, latest run, failed flag, never-run is not failed', () => {
  const rows = [
    { job: 'backup', started_at: '2026-10-27T21:00:00.000Z', finished_at: '2026-10-27T21:00:02.000Z', ok: true, detail: 'ok' },
    { job: 'rate', started_at: '2026-10-28T11:30:00.000Z', finished_at: '2026-10-28T11:30:01.000Z', ok: false, detail: 'Rate fetch failed' },
    { job: 'not-a-job', started_at: '', finished_at: '', ok: true, detail: '' }
  ];
  const out = J.summarize(rows);
  assert.deepEqual(out.map(x => x.job), J.JOBS);
  const rate = out.find(x => x.job === 'rate');
  assert.equal(rate.failed, true);
  assert.deepEqual(rate.lastRun, { startedAt: '2026-10-28T11:30:00.000Z', finishedAt: '2026-10-28T11:30:01.000Z', ok: false, detail: 'Rate fetch failed' });
  const sweep = out.find(x => x.job === 'match-sweep');
  assert.equal(sweep.lastRun, null);
  assert.equal(sweep.failed, false);
  assert.equal(out.find(x => x.job === 'backup').failed, false);
  assert.deepEqual(J.summarize([]).map(x => x.lastRun), [null, null, null, null, null, null, null]);
});

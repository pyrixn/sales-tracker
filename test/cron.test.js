const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { Core } = require('./load-core');

const TOKEN = 'cron-token-test-value';
const SECRET = 'app-secret-test-value';
const RELAY = 'relay-token-test-value';
const SB = { SUPABASE_URL: 'https://proj.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'srk-test-value' };

async function host(env, opts) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const edge = loadEdge(db, Object.assign({}, opts || {}, { env: Object.assign({ APP_SECRET: SECRET, CRON_TOKEN: TOKEN, RELAY_TOKEN: RELAY }, env || {}) }));
  return { tables, edge };
}
const cron = (job, token, method) => new Request('https://x.test/functions/v1/api/cron/' + job, {
  method: method || 'POST', headers: token === undefined ? {} : { 'X-Cron-Token': token } });
const call = async (edge, req) => { const r = await edge.handle(req); return { status: r.status, body: await r.json() }; };
const runsOf = (tables, job) => tables.job_runs.filter(r => r.job === job);
const jsonReq = (path, body, headers) => new Request('https://x.test/functions/v1/api' + path, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });

// Replaces global fetch for one test and returns the calls it saw.
function stubFetch(handler) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return handler(String(url), init);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

// ---- the route: authentication and dispatch --------------------------------------------------------------------------

test('cron route with CRON_TOKEN unset is 503, runs nothing and records nothing', async () => {
  const { edge, tables } = await host({ CRON_TOKEN: '' });
  const r = await call(edge, cron('cleanup', TOKEN));
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
  assert.equal(tables.job_runs.length, 0);
});

test('cron route: missing or wrong X-Cron-Token is 401, and the APP_SECRET does not open it', async () => {
  const { edge, tables } = await host();
  assert.equal((await call(edge, cron('cleanup', undefined))).status, 401);
  assert.equal((await call(edge, cron('cleanup', TOKEN + 'x'))).status, 401);
  assert.equal((await call(edge, cron('cleanup', SECRET))).status, 401);
  assert.equal(tables.job_runs.length, 0);
});

test('cron route: a right token for an unknown job is 404 and writes nothing', async () => {
  const { edge, tables } = await host();
  const r = await call(edge, cron('reminders', TOKEN));
  assert.equal(r.status, 404);
  assert.equal(tables.job_runs.length, 0);
});

test('cron route: GET is not a cron call (404), even with the token', async () => {
  const { edge, tables } = await host();
  assert.equal((await edge.handle(cron('cleanup', TOKEN, 'GET'))).status, 404);
  assert.equal(tables.job_runs.length, 0);
});

test('cron route: wrong tokens share the sign-in brake (429 after 10 failures)', async () => {
  const { edge } = await host({ CRON_TOKEN: 'brake-token-value', APP_SECRET: SECRET });
  const req = () => new Request('https://x.test/functions/v1/api/cron/cleanup', { method: 'POST', headers: { 'X-Cron-Token': 'wrong-' + Math.random(), 'cf-connecting-ip': '198.51.100.7' } });
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await edge.handle(req())).status;
  assert.equal(last, 429);
});

// ---- cleanup -------------------------------------------------------------------------------------------------------

test('cleanup job: prunes request_log and job_runs older than 30 days, keeps recent rows, records the run', async () => {
  const { edge, tables } = await host();
  tables.request_log.set('old-1', { request_id: 'old-1', response: '{}', created_at: '2000-01-01T00:00:00.000Z' });
  tables.request_log.set('new-1', { request_id: 'new-1', response: '{}', created_at: new Date().toISOString() });
  tables.job_runs.push({ id: 1, job: 'rate', started_at: '2000-01-01T00:00:00.000Z', finished_at: '', ok: true, detail: '' });
  tables.job_runs.push({ id: 2, job: 'rate', started_at: new Date().toISOString(), finished_at: '', ok: true, detail: '' });
  const r = await call(edge, cron('cleanup', TOKEN));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.job, 'cleanup');
  assert.equal(r.body.detail, 'removed 1 request_log, 1 job_runs');
  assert.ok(!tables.request_log.has('old-1'));
  assert.ok(tables.request_log.has('new-1'));
  assert.equal(tables.job_runs.length, 2, 'the old run is gone, the recent one kept, this run recorded');
  assert.ok(!tables.job_runs.some(x => String(x.started_at).startsWith('2000')));
  const mine = runsOf(tables, 'cleanup');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].ok, true);
  assert.ok(mine[0].started_at && mine[0].finished_at);
});

// ---- match-sweep ---------------------------------------------------------------------------------------------------

test('match-sweep job: a Pending row that matches is matched; one that does not stays Pending; both counted', async () => {
  const { edge, tables } = await host();
  tables.payment_inbox.clear();   // the seed has its own Pending rows: count only these two
  const row = (trx, ref) => ({ transaction_id: trx, received: '18/10/2026 14:05', type: 'Received', method: 'bKash', sender: '16247', amount: 580,
    counterparty: '01756999991', reference: ref, raw_sms: 'sweep ' + trx, status: 'Pending', matched_sale_id: '' });
  tables.payment_inbox.set('SWEEP000001', row('SWEEP000001', 'N44'));
  tables.payment_inbox.set('SWEEP000002', row('SWEEP000002', 'ZZ999'));
  const r = await call(edge, cron('match-sweep', TOKEN));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.detail, 'checked 2, matched 1');
  assert.equal(tables.payment_inbox.get('SWEEP000001').status, 'Matched');
  assert.equal(tables.payment_inbox.get('SWEEP000002').status, 'Pending');
  assert.ok(tables.change_log.some(l => /^auto/.test(l.action)), 'the match is logged under an auto action, so Undo skips it');
});

test('match-sweep job with nothing Pending is a clean, recorded no-op', async () => {
  const { edge, tables } = await host();
  tables.payment_inbox.clear();
  const payments = tables.payments.size;
  const r = await call(edge, cron('match-sweep', TOKEN));
  assert.equal(r.status, 200);
  assert.equal(r.body.detail, 'checked 0, matched 0');
  assert.equal(tables.payments.size, payments);
  assert.equal(runsOf(tables, 'match-sweep')[0].ok, true);
});

// ---- rate ----------------------------------------------------------------------------------------------------------

test('rate job refreshes a stale rate through the Bybit fetch and records the new rate', async () => {
  const { edge, tables } = await host({}, { fetchAds: async () => [{ price: '121.00' }, { price: '122.00' }, { price: '123.00' }] });
  tables.live_rates.set('usdt_bdt', { id: 'usdt_bdt', rate: 110, fetched_at: '2000-01-01T00:00:00.000Z' });
  const r = await call(edge, cron('rate', TOKEN));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.detail, 'rate 122');
  assert.equal(Number(tables.live_rates.get('usdt_bdt').rate), 122);
});

test('rate job does nothing when the rate is fresh or manual, and never fetches then', async () => {
  let fetched = 0;
  const { edge, tables } = await host({}, { fetchAds: async () => { fetched++; return [{ price: 120 }]; } });
  tables.live_rates.set('usdt_bdt', { id: 'usdt_bdt', rate: 120, fetched_at: new Date().toISOString() });
  let r = await call(edge, cron('rate', TOKEN));
  assert.equal(r.status, 200);
  assert.equal(r.body.detail, 'rate current or manual');
  tables.settings.set('usdt_bdt_manual', '125');
  tables.live_rates.set('usdt_bdt', { id: 'usdt_bdt', rate: 120, fetched_at: '2000-01-01T00:00:00.000Z' });
  r = await call(edge, cron('rate', TOKEN));
  assert.equal(r.body.detail, 'rate current or manual');
  assert.equal(fetched, 0);
});

test('rate job: a failed fetch is a failed run in job_runs with the reason, and the old rate stays', async () => {
  const { edge, tables } = await host({}, { fetchAds: async () => { throw new Error('offline'); } });
  tables.live_rates.set('usdt_bdt', { id: 'usdt_bdt', rate: 110, fetched_at: '2000-01-01T00:00:00.000Z' });
  const r = await call(edge, cron('rate', TOKEN));
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  assert.match(r.body.detail, /Rate fetch failed: offline/);
  assert.equal(Number(tables.live_rates.get('usdt_bdt').rate), 110);
  assert.equal(runsOf(tables, 'rate')[0].ok, false);
});

// ---- backup --------------------------------------------------------------------------------------------------------

test('backup job uploads the state as JSON to the backups bucket and prunes to the newest 30 of its own files', async () => {
  const old = [];
  for (let d = 1; d <= 31; d++) old.push({ name: 'sales-tracker-2026-08-' + String(d).padStart(2, '0') + '.json' });
  old.push({ name: 'readme.txt' });
  const f = stubFetch((url, init) => {
    if (init.method === 'POST' && /\/object\/list\//.test(url)) return json(old.concat([]));
    return json({ Key: 'ok' });
  });
  try {
    const { edge, tables } = await host(SB);
    const r = await call(edge, cron('backup', TOKEN));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const name = Core.jobs.backupName(Date.now());
    assert.match(r.body.detail, new RegExp('^' + name.replace(/\./g, '\\.') + ', removed 1 old$'));
    const upload = f.seen[0];
    assert.equal(upload.method, 'POST');
    assert.equal(upload.url, 'https://proj.supabase.test/storage/v1/object/backups/' + name);
    assert.equal(upload.headers['x-upsert'], 'true');
    assert.equal(upload.headers.Authorization, 'Bearer srk-test-value');
    const doc = JSON.parse(upload.body);
    assert.equal(doc.format, 'sales-tracker-backup');
    assert.ok(doc.state.settings && Array.isArray(doc.state.sales), 'the whole state is in the file');
    assert.ok(Array.isArray(doc.account_secrets) && Array.isArray(doc.delivery_templates), 'vault ciphertext and templates are in the file');
    const del = f.seen.find(c => c.method === 'DELETE');
    assert.ok(del, 'old backups are deleted');
    assert.equal(del.url, 'https://proj.supabase.test/storage/v1/object/backups');
    assert.deepEqual(JSON.parse(del.body), { prefixes: ['sales-tracker-2026-08-01.json'] });
    assert.equal(tables.job_runs[0].ok, true);
    assert.ok(!r.body.detail.includes('srk-test-value'));
  } finally { f.restore(); }
});

test('backup job without a service role is a failed run that names no secret', async () => {
  const { edge, tables } = await host({ SUPABASE_URL: 'https://proj.supabase.test' });
  const r = await call(edge, cron('backup', TOKEN));
  assert.equal(r.status, 500);
  assert.equal(r.body.detail, 'Storage is not configured.');
  assert.equal(runsOf(tables, 'backup')[0].ok, false);
});

test('backup job: a Storage error is a failed run with the route and status only', async () => {
  const f = stubFetch(() => json({ message: 'bucket not found' }, 404));
  try {
    const { edge, tables } = await host(SB);
    const r = await call(edge, cron('backup', TOKEN));
    assert.equal(r.status, 500);
    assert.equal(r.body.detail, 'Storage POST object/backups failed: HTTP 404');
    assert.ok(!r.body.detail.includes('srk-test-value'));
    assert.equal(runsOf(tables, 'backup')[0].ok, false);
    assert.equal(f.seen.length, 1, 'nothing else is called after the failed upload');
  } finally { f.restore(); }
});

// ---- relay heartbeat and relay-check -------------------------------------------------------------------------------

test('relay heartbeat: a text "heartbeat" stores the time, writes no inbox row and no change_log entry', async () => {
  const { edge, tables } = await host();
  const inbox = tables.payment_inbox.size, log = tables.change_log.length;
  const before = Date.now();
  const r = await call(edge, jsonReq('/relay?src=bkash', { token: RELAY, sender: '16247', text: 'Heartbeat' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'heartbeat');
  assert.equal(tables.payment_inbox.size, inbox);
  assert.equal(tables.change_log.length, log);
  const stored = Date.parse(tables.settings.get('relay_heartbeat'));
  assert.ok(stored >= before && stored <= Date.now());
});

test('relay heartbeat still needs the relay token', async () => {
  const { edge, tables } = await host();
  const r = await call(edge, jsonReq('/relay', { token: 'nope', text: 'heartbeat' }));
  assert.equal(r.status, 401);
  assert.ok(!tables.settings.get('relay_heartbeat'), 'no heartbeat stored');
});

test('relay-check: no SMS and no heartbeat raises the flag and fails the run; a heartbeat clears it', async () => {
  const { edge, tables } = await host();
  tables.payment_inbox.clear();
  tables.settings.set('relay_heartbeat', '');
  let r = await call(edge, cron('relay-check', TOKEN));
  assert.equal(r.status, 500);
  assert.match(r.body.detail, /No relay SMS or heartbeat in 6 h/);
  assert.equal(tables.settings.get('relay_alert'), 'on');
  assert.equal(runsOf(tables, 'relay-check')[0].ok, false);

  await call(edge, jsonReq('/relay', { token: RELAY, text: 'heartbeat' }));
  r = await call(edge, cron('relay-check', TOKEN));
  assert.equal(r.status, 200);
  assert.equal(r.body.detail, 'relay reporting');
  assert.equal(tables.settings.get('relay_alert'), 'off');
  assert.equal(runsOf(tables, 'relay-check').length, 2);
});

test('relay-check: a recent SMS alone keeps the relay healthy', async () => {
  const { edge, tables } = await host();
  tables.payment_inbox.clear();
  tables.payment_inbox.set('RECENT0001', { transaction_id: 'RECENT0001', received: todayDhaka(), type: 'Received', method: 'bKash',
    sender: '16247', amount: 1, counterparty: '', reference: '', raw_sms: 'recent', status: 'Matched', matched_sale_id: '' });
  tables.settings.set('relay_heartbeat', '');
  const r = await call(edge, cron('relay-check', TOKEN));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(tables.settings.get('relay_alert'), 'on', 'nothing raised, nothing written as on');
});

function todayDhaka() {
  // Dhaka wall time now, in the inbox format ('YYYY-MM-DD HH:MM').
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return parts.replace(', ', ' ');
}

// ---- the Jobs card read --------------------------------------------------------------------------------------------

test('jobs read: latest run per job, failures flagged, the relay flag from settings', async () => {
  const { edge, tables } = await host();
  tables.job_runs.push({ id: 1, job: 'backup', started_at: '2026-10-27T21:00:00.000Z', finished_at: '2026-10-27T21:00:03.000Z', ok: true, detail: 'ok' });
  tables.job_runs.push({ id: 2, job: 'backup', started_at: '2026-10-28T21:00:00.000Z', finished_at: '2026-10-28T21:00:04.000Z', ok: false, detail: 'Storage POST object/backups failed: HTTP 500' });
  tables.settings.set('relay_alert', 'on');
  const r = await edge.api('jobs', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.jobs.map(j => j.job), Core.jobs.JOBS);
  const backup = r.data.jobs.find(j => j.job === 'backup');
  assert.equal(backup.failed, true);
  assert.equal(backup.lastRun.detail, 'Storage POST object/backups failed: HTTP 500');
  assert.equal(r.data.jobs.find(j => j.job === 'cleanup').lastRun, null);
  assert.deepEqual(r.data.relay, { alert: true, heartbeat: '', hours: Core.jobs.RELAY_HOURS });
});

test('jobs read over HTTP needs the panel secret like every read', async () => {
  const { edge } = await host();
  assert.equal((await call(edge, jsonReq('/', { action: 'jobs' }))).status, 401);
  const ok = await call(edge, jsonReq('/', { action: 'jobs' }, { 'X-App-Secret': SECRET }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.jobs.length, 7);
});

// ---- webhooks and notify jobs ----------------------------------------------------------------------------------------

test('cron webhooks: two overlapping runs deliver one event once (atomic claim with a lease)', async () => {
  const { edge, tables } = await host();
  tables.webhook_endpoints.set('wh_1', { id: 'wh_1', url: 'https://hooks.shop.example/x', secret: 'whsec_test', events: ['order.paid'], active: true,
    created_at: '2026-10-01T00:00:00.000Z' });
  tables.webhook_deliveries.set('evt_1', { id: 'evt_1', endpoint_id: 'wh_1', event: 'order.paid', payload: { orderId: 'O1' }, attempts: 0,
    status: 'pending', next_try_at: '2000-01-01T00:00:00.000Z', last_error: '', created_at: '2026-10-27T00:00:00.000Z', delivered_at: null });
  const f = stubFetch(async () => { await new Promise(r => setTimeout(r, 20)); return json({}, 200); });
  try {
    const [a, b] = await Promise.all([call(edge, cron('webhooks', TOKEN)), call(edge, cron('webhooks', TOKEN))]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(f.seen.filter(c => c.url === 'https://hooks.shop.example/x').length, 1, 'sent once');
    assert.equal(tables.webhook_deliveries.get('evt_1').status, 'delivered');
    assert.equal(tables.webhook_deliveries.get('evt_1').attempts, 1);
    assert.equal(runsOf(tables, 'webhooks').length, 2);
  } finally { f.restore(); }
});

test('cron notify runs the notification sender and records the run', async () => {
  const { edge, tables } = await host();
  const f = stubFetch(async () => json({}, 200));
  try {
    const r = await call(edge, cron('notify', TOKEN));
    assert.equal(r.status, 200);
    assert.match(r.body.detail, /^queued \d+, sent \d+/);
    assert.equal(runsOf(tables, 'notify').length, 1);
  } finally { f.restore(); }
});

test('relay-check: the alert flag change goes through the audit log as autoRelayAlert', async () => {
  const { edge, tables } = await host();
  tables.payment_inbox.clear();
  tables.settings.set('relay_heartbeat', '');
  await call(edge, cron('relay-check', TOKEN));
  assert.equal(tables.settings.get('relay_alert'), 'on');
  const lines = tables.change_log.filter(l => l.action === 'autoRelayAlert');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tab, 'Settings');
  assert.equal(lines[0].row_key, 'relay_alert');
});

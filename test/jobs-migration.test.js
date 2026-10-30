const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'supabase', 'migrations', '017_jobs.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const flat = sql.replace(/\s+/g, ' ');
// The SQL that runs: every line that is not a comment.
const live = sql.split(/\r?\n/).filter(l => !/^\s*--/.test(l)).join('\n').replace(/\s+/g, ' ');

test('017 enables pg_cron in pg_catalog and pg_net in extensions', () => {
  assert.ok(live.includes('create extension if not exists pg_cron with schema pg_catalog;'));
  assert.ok(live.includes('create extension if not exists pg_net with schema extensions;'));
});

test('job_runs has the columns the runner writes, RLS on and no policies', () => {
  assert.ok(live.includes('create table if not exists job_runs ('));
  for (const c of ['id bigserial primary key', 'job text not null', "started_at text not null default ''", "finished_at text not null default ''",
    'ok boolean not null default false', "detail text not null default ''"]) {
    assert.ok(live.includes(c), 'column ' + c);
  }
  assert.ok(live.includes('alter table job_runs enable row level security'));
  assert.ok(!/create policy/i.test(live), 'RLS with no policies');
});

test('017 adds the F4 indexes for the public pay-page reads and the change_log row lookup', () => {
  assert.ok(live.includes('create index if not exists payment_inbox_reference_upper_idx on payment_inbox (upper(reference));'));
  assert.ok(live.includes('create index if not exists payment_inbox_counterparty_idx on payment_inbox (counterparty);'));
  assert.ok(live.includes('create index if not exists payments_transaction_upper_idx on payments (upper(transaction_id));'));
  assert.ok(live.includes('create index if not exists change_log_row_idx on change_log (tab, row_key, id desc);'));
  for (const m of live.matchAll(/create index [^;]*;/g)) {
    assert.ok(m[0].includes('if not exists'), 'idempotent: ' + m[0]);
  }
});

test('017 seeds the relay_heartbeat settings row without overwriting it', () => {
  assert.ok(live.includes("insert into settings (key, value) values ('relay_heartbeat', '') on conflict (key) do nothing;"));
});

test('the example schedules are comments only, POST to /cron/<job> with X-Cron-Token, and never name a service-role key', () => {
  const cron = sql.split(/\r?\n/).filter(l => /cron\.schedule/.test(l));
  assert.equal(cron.length, 7, 'one example per job the route runs');
  for (const job of ['match-sweep', 'rate', 'backup', 'cleanup', 'relay-check', 'webhooks', 'notify']) {
    assert.ok(flat.includes("'" + job + "'"), 'schedule for ' + job);
    assert.ok(flat.includes('/functions/v1/api/cron/' + job), 'URL for ' + job);
  }
  assert.ok(flat.includes("'X-Cron-Token', '<CRON_TOKEN>'"));
  assert.ok(!/service[_ -]?role/i.test(live), 'no service-role key in the SQL');
  assert.ok(!/^\s*select cron\.schedule/m.test(sql), 'no schedule runs on apply');
  // Cron times are UTC: backup 03:00 Dhaka is 21:00 UTC, reminders 09:00 Dhaka would be 03:00 UTC.
  assert.ok(flat.includes("cron.schedule('backup', '0 21 * * *'"));
});

test('the migration name sorts after 014 and no earlier number is reused', () => {
  const files = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => /^\d{3}_/.test(f)).sort();
  assert.ok(files.includes('017_jobs.sql'));
  assert.equal(files.filter(f => f.startsWith('017_')).length, 1);
});

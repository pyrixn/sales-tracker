const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { planMigrations, guardDestructive, runApply } = require('../tools/lib/migrations');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'migrate-schema.js');
const BLOCK = path.join(__dirname, 'support', 'block-fetch.js');
const NO_ENV = path.join(__dirname, 'support', 'no-such.env');

function runCli(env, args) {
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MIGRATE_ENV_FILE: NO_ENV };
  return spawnSync(process.execPath, [SCRIPT].concat(args || []), {
    cwd: ROOT, env: Object.assign(base, env), encoding: 'utf8'
  });
}

test('runs unapplied files in filename order', () => {
  const p = planMigrations(['002_b.sql', '001_a.sql'], []);
  assert.deepStrictEqual(p.toRun, ['001_a.sql', '002_b.sql']);
});

test('skips applied', () => {
  const p = planMigrations(['002_b.sql', '001_a.sql'], ['001_a.sql']);
  assert.deepStrictEqual(p.toRun, ['002_b.sql']);
});

test('baseline marks without running', () => {
  const p = planMigrations(['001_a.sql', '002_b.sql'], [], { baseline: ['001_a.sql', '002_b.sql'] });
  assert.deepStrictEqual(p.toRun, []);
  assert.deepStrictEqual(p.toBaseline, ['001_a.sql', '002_b.sql']);
});

test('unknown baseline name is an error', () => {
  const p = planMigrations(['001_a.sql'], [], { baseline: ['009_x.sql'] });
  assert.ok(p.errors.some(e => e.includes('009_x.sql')));
});

test('applied name missing from files is an error', () => {
  const p = planMigrations(['001_a.sql'], ['005_gone.sql']);
  assert.ok(p.errors.some(e => e.includes('005_gone.sql')));
});

test('drop table is refused when history is unknown', () => {
  assert.match(guardDestructive('drop table if exists x cascade;', true), /baseline/);
});

test('guardDestructive allows a drop table file on an empty db and safe sql on a populated db', () => {
  assert.strictEqual(guardDestructive('create table t();', true), null);
  assert.strictEqual(guardDestructive('create table t();', false), null);
  assert.strictEqual(guardDestructive('drop table x;', false), null);
  assert.match(guardDestructive('DROP TABLE x;', true), /baseline/);
});

test('dry run makes no network call', () => {
  const r = runCli({
    SUPABASE_PROJECT_REF: 'ref', SUPABASE_ACCESS_TOKEN: 'test-token',
    NODE_OPTIONS: `--require "${BLOCK.split(path.sep).join('/')}"`
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.match(r.stdout, /001_schema\.sql/);
  assert.ok(!r.stdout.includes('test-token'));
});

test('missing variable is one plain line', () => {
  const r = runCli({});
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.ok(r.stderr.includes('SUPABASE_PROJECT_REF'));
  assert.ok(!/\bat /.test(r.stderr));
});

test('missing token names SUPABASE_ACCESS_TOKEN in one line', () => {
  const r = runCli({ SUPABASE_PROJECT_REF: 'ref' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('SUPABASE_ACCESS_TOKEN'));
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.ok(!/\bat /.test(r.stderr));
});

// `populated: true` is shorthand for a db holding the settings and sales tables.
// information_schema probes are answered from the SQL text, not blindly.
function fakeDb({ applied = [], populated = false, tables = null } = {}) {
  const existing = tables || (populated ? ['settings', 'sales'] : []);
  const calls = [];
  const runQuery = async sql => {
    calls.push(sql);
    if (/information_schema\.tables/.test(sql)) {
      const named = /table_name\s*=\s*'([^']+)'/.exec(sql);
      if (named) return existing.includes(named[1]) ? [{ found: 1 }] : [];
      if (/table_name\s*<>\s*'schema_migrations'/.test(sql)) {
        return existing.some(t => t !== 'schema_migrations') ? [{ found: 1 }] : [];
      }
      throw new Error(`unhandled SQL in fake: ${sql}`);
    }
    if (/^select name from schema_migrations/.test(sql)) return applied.map(name => ({ name }));
    return [];
  };
  return { calls, runQuery };
}
const FILES = [
  { name: '001_schema.sql', sql: 'drop table if exists a cascade; create table a();' },
  { name: '002_more.sql', sql: 'alter table a add column b int;' }
];

test('apply creates the record table, runs files in order, records names', async () => {
  const db = fakeDb();
  const r = await runApply(FILES.slice().reverse(), db.runQuery);
  assert.match(db.calls[0], /create table if not exists schema_migrations/);
  assert.match(db.calls[1], /^alter table schema_migrations enable row level security$/);
  assert.deepStrictEqual(r.ran, ['001_schema.sql', '002_more.sql']);
  const tail = db.calls.slice(4);
  assert.strictEqual(tail[0], FILES[0].sql);
  assert.match(tail[1], /insert into schema_migrations.*001_schema\.sql/);
  assert.strictEqual(tail[2], FILES[1].sql);
  assert.match(tail[3], /insert into schema_migrations.*002_more\.sql/);
});

test('apply skips applied files', async () => {
  const db = fakeDb({ applied: ['001_schema.sql'], populated: true });
  const r = await runApply(FILES, db.runQuery);
  assert.deepStrictEqual(r.ran, ['002_more.sql']);
  assert.ok(!db.calls.includes(FILES[0].sql));
});

test('apply refuses the drop table file on a populated db with unknown history', async () => {
  const db = fakeDb({ populated: true });
  await assert.rejects(() => runApply(FILES, db.runQuery), /baseline/);
  assert.ok(!db.calls.includes(FILES[0].sql));
  assert.ok(!db.calls.some(c => /^insert into/.test(c)));
});

test('apply with baseline records without running', async () => {
  const db = fakeDb({ populated: true });
  const r = await runApply(FILES, db.runQuery, { baseline: ['001_schema.sql'] });
  assert.deepStrictEqual(r.baselined, ['001_schema.sql']);
  assert.deepStrictEqual(r.ran, ['002_more.sql']);
  assert.ok(!db.calls.includes(FILES[0].sql));
  assert.ok(db.calls.some(c => /insert into schema_migrations.*001_schema\.sql/.test(c)));
});

test('apply refuses 001 when only a non-settings table exists', async () => {
  const db = fakeDb({ tables: ['sales'] });
  await assert.rejects(() => runApply(FILES, db.runQuery), /baseline/);
  assert.ok(!db.calls.includes(FILES[0].sql));
  assert.ok(!db.calls.some(c => /^insert into/.test(c)));
});

test('apply refuses 001 when the record holds only 002 on a populated db', async () => {
  const db = fakeDb({ applied: ['002_more.sql'], populated: true });
  await assert.rejects(() => runApply(FILES, db.runQuery), /baseline/);
  assert.ok(!db.calls.includes(FILES[0].sql));
  assert.ok(!db.calls.some(c => /^insert into/.test(c)));
});

test('baselining 001 does not excuse a later file with drop table', async () => {
  const db = fakeDb({ populated: true });
  const files = FILES.concat([{ name: '003_bad.sql', sql: 'drop table a;' }]);
  await assert.rejects(() => runApply(files, db.runQuery, { baseline: ['001_schema.sql'] }), /003_bad\.sql/);
  assert.ok(!db.calls.includes('drop table a;'));
  assert.ok(!db.calls.some(c => /^insert into/.test(c)));
});

// A response of the wrong shape must stop the run before any migration SQL is sent or recorded.
function shapeDb({ applied, populated }) {
  const calls = [];
  const runQuery = async sql => {
    calls.push(sql);
    if (/^select name from schema_migrations/.test(sql)) return applied;
    if (/information_schema\.tables/.test(sql)) return populated;
    return [];
  };
  return { calls, runQuery };
}

async function assertShapeRefused(db, which) {
  await assert.rejects(() => runApply(FILES, db.runQuery), new RegExp(`unexpected response shape from ${which} query`));
  for (const f of FILES) assert.ok(!db.calls.includes(f.sql));
  assert.ok(!db.calls.some(c => /^insert into/.test(c)));
}

test('apply refuses when the populated probe returns an object', async () => {
  await assertShapeRefused(shapeDb({ applied: [], populated: {} }), 'populated');
});

test('apply refuses when the populated probe returns text', async () => {
  await assertShapeRefused(shapeDb({ applied: [], populated: 'text' }), 'populated');
});

test('apply refuses when the applied query returns an object', async () => {
  await assertShapeRefused(shapeDb({ applied: {}, populated: [] }), 'applied');
});

test('migration 010 adds delivers_as, parent_id, contact_channel and backfills delivers_as from category', () => {
  const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '010_phase1.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes("alter table products add column if not exists delivers_as text not null default 'account'"));
  assert.ok(sql.includes("add column if not exists parent_id text not null default ''"));
  assert.ok(sql.includes("alter table suppliers add column if not exists contact_channel text not null default ''"));
  assert.ok(sql.includes("update products set delivers_as = 'code' where category = 'Game Code';"));
  assert.ok(sql.includes("alter table products alter column letter type text; alter table products add constraint products_letter_format check (letter ~ '^[A-Z]{1,3}$');"));
});

test('migration 011 creates pay_requests and deliveries with RLS and inserts the five settings rows', () => {
  const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '011_pay_requests_delivery.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes('create table if not exists pay_requests ('));
  assert.ok(sql.includes('create table if not exists deliveries ('));
  assert.ok(sql.includes('request_id text primary key'));
  assert.ok(sql.includes('delivery_id text primary key'));
  assert.ok(sql.includes('alter table pay_requests enable row level security'));
  assert.ok(sql.includes('alter table deliveries enable row level security'));
  assert.ok(!/create policy/i.test(sql), 'RLS with no policies');
  for (const k of ['tos_text', 'review_discord_url', 'review_facebook_url', 'pay_link_expiry_hours', 'delivery_note']) {
    assert.ok(sql.includes("('" + k + "',"), 'settings row ' + k);
  }
  assert.ok(sql.includes("('pay_link_expiry_hours', '24')"));
  assert.ok(sql.includes('on conflict (key) do nothing'));
  assert.ok(sql.includes("create unique index if not exists pay_requests_token_idx on pay_requests (token) where token <> ''")
  && sql.includes('create index if not exists deliveries_sale_idx on deliveries (sale_id)') && sql.includes('create index if not exists deliveries_request_idx on deliveries (request_id)'));
  const A = require('../src/adapters/postgres.js');
  assert.deepEqual(A.TABS.Pay_Requests, { key: 'Request_ID', state: 'payRequests' });
  assert.deepEqual(A.TABS.Deliveries, { key: 'Delivery_ID', state: 'deliveries' });
  assert.equal(A.SPEC.Pay_Requests.table, 'pay_requests');
  assert.equal(A.SPEC.Deliveries.table, 'deliveries');
});

test('fake-db round-trips pay_requests and deliveries through the Adapter (append, read by Token, update)', async () => {
  const Adapter = require('../src/adapters/postgres.js');
  const { makeFakeDb } = require('./support/fake-db');
  const { db } = makeFakeDb();
  await Adapter.applyOps(db, [
    { op: 'append', tab: 'Pay_Requests', values: { Request_ID: 'R1', Token: 'tok123', Title: 'Game', Amount: 500, Status: 'Open', Created: '2026-10-24 10:00', Expires: '2026-10-25 10:00', Sale_ID: '' } },
    { op: 'append', tab: 'Deliveries', values: { Delivery_ID: 'D1', Sale_ID: 7, Request_ID: 'R1', Kind: 'code', Status: 'Pending' } }
  ], { batchId: 'b1', action: 'test' });
  let rows = await Adapter.readTabWhere(db, 'Pay_Requests', 'Token', 'tok123');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Request_ID, 'R1');
  assert.equal(rows[0].Amount, 500);
  assert.equal(rows[0].Sale_ID, '');
  assert.equal((await Adapter.readTabWhere(db, 'Pay_Requests', 'Token', 'nope')).length, 0);
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Pay_Requests', id: 'R1', values: { Status: 'Paid', Sale_ID: 7 } }], { batchId: 'b2', action: 'test' });
  rows = await Adapter.readTab(db, 'Pay_Requests');
  assert.equal(rows[0].Status, 'Paid');
  assert.equal(rows[0].Sale_ID, 7);
  const d = await Adapter.readTab(db, 'Deliveries');
  assert.equal(d.length, 1);
  assert.equal(d[0].Delivery_ID, 'D1');
  assert.equal(d[0].Sale_ID, 7);
  const st = await Adapter.readState(db, '2026-10-24');
  assert.equal(st.payRequests.length, 1);
  assert.equal(st.deliveries.length, 1);
});

test('migration 012 creates goals and budgets with RLS and inserts money_layout', () => {
  const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '012_goals_budgets.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes('create table if not exists goals ('));
  assert.ok(sql.includes('goal_id text primary key'));
  assert.ok(sql.includes('alter table goals enable row level security'));
  assert.ok(sql.includes('create table if not exists budgets ('));
  assert.ok(sql.includes('budget_id text primary key'));
  assert.ok(sql.includes('alter table budgets enable row level security'));
  assert.ok(sql.includes("('money_layout', 'net,trend,cash,dues,products,forecast')"));
  assert.ok(sql.includes('on conflict (key) do nothing'));
  assert.ok(!/create policy/i.test(sql));
});

test('migration 013 sets ref_style to random and adds pay_requests.ref with a unique index, additive only', () => {
  const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '013_references.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes("insert into settings (key, value) values ('ref_style', 'random') on conflict (key) do update set value = 'random'"));
  assert.ok(sql.includes("alter table pay_requests add column if not exists ref text not null default ''"));
  assert.ok(sql.includes('create unique index if not exists pay_requests_ref_idx on pay_requests (upper(ref)) where ref <> \'\''));
  assert.ok(!/\bdrop\b/i.test(sql), 'no drop');
  const A = require('../src/adapters/postgres.js');
  assert.equal(A.SPEC.Pay_Requests.cols.Ref, 'ref');
});

test('migration 014 adds sales.covers_from and creates import_rows with RLS, no policies, additive only', () => {
  const sql = require('fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '014_import_rows.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes("alter table sales add column if not exists covers_from text not null default ''"));
  assert.ok(sql.includes('create table if not exists import_rows ('));
  assert.ok(sql.includes('row_id text primary key'));
  assert.ok(sql.includes("status text not null default 'Review'"));
  assert.ok(sql.includes('alter table import_rows enable row level security'));
  assert.ok(sql.includes('create index if not exists import_rows_batch_kind_idx on import_rows (batch, kind)'));
  assert.ok(!/create policy/i.test(sql), 'RLS with no policies');
  assert.ok(!/\bdrop\b/i.test(sql), 'no drop');
  const A = require('../src/adapters/postgres.js');
  assert.deepEqual(A.TABS.Import_Rows, { key: 'Row_ID', state: 'importRows' });
  assert.equal(A.SPEC.Import_Rows.table, 'import_rows');
  assert.deepEqual(Object.keys(A.SPEC.Import_Rows.cols), ['Row_ID', 'Batch', 'Kind', 'Sheet', 'Ref', 'Data', 'Status', 'Note', 'Applied', 'Created']);
  assert.equal(A.SPEC.Sales_Log.cols.Covers_From, 'covers_from');
});

test('fake-db round-trips import_rows and sales.Covers_From through the Adapter', async () => {
  const Adapter = require('../src/adapters/postgres.js');
  const { makeFakeDb } = require('./support/fake-db');
  const { db } = makeFakeDb();
  await Adapter.applyOps(db, [
    { op: 'append', tab: 'Import_Rows', values: { Row_ID: 'b1:Sheet:A1', Batch: 'b1', Kind: 'line', Sheet: 'Sheet', Ref: 'A1', Data: '{"amount":300}', Status: 'Review', Note: '', Applied: '', Created: '2026-10-28' } },
    { op: 'append', tab: 'Sales_Log', values: { Sale_ID: 7, Sale_Date: '2026-10-01', Covers_From: '2026-10-01', Paid_Till: '2026-11-01', Unit_Price: 300 } }
  ], { batchId: 'b1', action: 'test' });
  await Adapter.applyOps(db, [{ op: 'update', tab: 'Import_Rows', id: 'b1:Sheet:A1', values: { Status: 'Approved' } }], { batchId: 'b2', action: 'test' });
  const st = await Adapter.readState(db, '2026-10-28');
  assert.equal(st.importRows.length, 1);
  assert.equal(st.importRows[0].Status, 'Approved');
  assert.equal(st.importRows[0].Data, '{"amount":300}');
  assert.equal(st.sales[0].Covers_From, '2026-10-01');
});


test('migration file numbers are unique, and 014 and 016 to 020 are all present', () => {
  const fs = require('fs');
  const files = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => /\.sql$/.test(f));
  const nums = files.map(f => { const m = /^(\d{3})_/.exec(f); assert.ok(m, 'bad migration name ' + f); return m[1]; });
  assert.deepStrictEqual(nums.filter((n, i) => nums.indexOf(n) !== i), [], 'duplicate migration numbers');
  for (const n of ['014', '016', '017', '018', '019', '020']) assert.ok(nums.includes(n), 'missing migration ' + n);
});


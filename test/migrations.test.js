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

'use strict';
// Pure migration planning plus the apply flow. All I/O goes through the
// injected runQuery(sql) function, so tests never touch a network.

function planMigrations(files, applied, opts) {
  const baseline = (opts && opts.baseline) || [];
  const sorted = files.slice().sort();
  const appliedSet = new Set(applied);
  const fileSet = new Set(sorted);
  const errors = [];
  for (const name of baseline) {
    if (!fileSet.has(name)) errors.push(`baseline file not found: ${name}`);
  }
  for (const name of applied) {
    if (!fileSet.has(name)) errors.push(`applied migration missing from files: ${name}`);
  }
  const toBaseline = baseline.filter(n => fileSet.has(n) && !appliedSet.has(n));
  const baseSet = new Set(toBaseline);
  const toRun = sorted.filter(n => !appliedSet.has(n) && !baseSet.has(n));
  return { toRun, toBaseline, errors };
}

// Keyword guard for this project's own migrations, not a general
// destructive-SQL detector. Called only for files about to RUN (files recorded
// via --baseline are never passed in). dbPopulated: the database already holds
// any public base table other than schema_migrations. A file containing
// drop table is refused on a populated database, whatever the record table holds.
function guardDestructive(sqlText, dbPopulated) {
  if (/\bdrop\s+table\b/i.test(sqlText) && dbPopulated) {
    return 'refusing to run a file with drop table on a database that already has tables. ' +
      'If the file is already applied, record it with --baseline <file>[,<file>] instead.';
  }
  return null;
}

const CREATE_RECORD =
  'create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())';
const ENABLE_RLS = 'alter table schema_migrations enable row level security';
const SELECT_APPLIED = 'select name from schema_migrations order by name';
const CHECK_POPULATED =
  "select 1 as found from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'schema_migrations' limit 1";

function esc(name) { return String(name).replace(/'/g, "''"); }

// files: [{ name, sql }]. Returns { ran, baselined }. Throws on any error.
async function runApply(files, runQuery, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  await runQuery(CREATE_RECORD);
  // RLS with no policies, like every other table: only the service role reaches it.
  await runQuery(ENABLE_RLS);
  // Fail closed: anything but an array of rows is an unknown API shape, so nothing runs.
  const rows = await runQuery(SELECT_APPLIED);
  if (!Array.isArray(rows)) throw new Error('unexpected response shape from applied query');
  const applied = rows.map(r => r.name);
  const populatedRows = await runQuery(CHECK_POPULATED);
  if (!Array.isArray(populatedRows)) throw new Error('unexpected response shape from populated query');
  const populated = populatedRows.length > 0;

  const plan = planMigrations(files.map(f => f.name), applied, { baseline: o.baseline || [] });
  if (plan.errors.length) throw new Error(plan.errors.join('; '));
  const byName = new Map(files.map(f => [f.name, f.sql]));

  // Check every guard before running anything.
  for (const name of plan.toRun) {
    const err = guardDestructive(byName.get(name), populated);
    if (err) throw new Error(`${name}: ${err}`);
  }
  const record = name => runQuery(`insert into schema_migrations (name) values ('${esc(name)}') on conflict do nothing`);
  for (const name of plan.toBaseline) {
    await record(name);
    log(`baselined ${name}`);
  }
  for (const name of plan.toRun) {
    await runQuery(byName.get(name));
    await record(name);
    log(`applied ${name}`);
  }
  return { ran: plan.toRun, baselined: plan.toBaseline };
}

module.exports = { planMigrations, guardDestructive, runApply };

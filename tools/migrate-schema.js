#!/usr/bin/env node
// Usage: node tools/migrate-schema.js [--apply] [--baseline <file>[,<file>]]
// Without --apply this is a dry run: no network call is made.
const fs = require('fs');
const path = require('path');
const { runApply } = require('./lib/migrations');

const MIGRATIONS_DIR = path.join(__dirname, '../supabase/migrations');

function loadEnv() {
  const envPath = process.env.MIGRATE_ENV_FILE || path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
}

function parseArgs(argv) {
  const out = { apply: false, baseline: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--baseline') {
      out.baseline = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function makeRunQuery(ref, token) {
  return async function runQuery(sql) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: sql })
    });
    const text = await res.text();
    // Response bodies are never included in errors: they can echo input.
    if (!res.ok) throw new Error(`query failed (HTTP ${res.status})`);
    try { return JSON.parse(text); } catch { throw new Error(`query returned a non-JSON body (HTTP ${res.status})`); }
  };
}

async function main() {
  loadEnv();
  for (const v of ['SUPABASE_PROJECT_REF', 'SUPABASE_ACCESS_TOKEN']) {
    if (!process.env[v]) fail(`missing environment variable: ${v}`);
  }
  const args = parseArgs(process.argv.slice(2));
  const names = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  if (!args.apply) {
    console.log(`dry run: would apply ${names.join(', ')}`);
    console.log('note: applied state is unknown offline, so the full list is shown; applied files are skipped at --apply time.');
    console.log('--apply needs the user\'s approval and changes the remote project.');
    console.log('if the database already has tables but no record, use --baseline <file>[,<file>] to record files without running them.');
    return;
  }

  const files = names.map(name => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
  const runQuery = makeRunQuery(process.env.SUPABASE_PROJECT_REF, process.env.SUPABASE_ACCESS_TOKEN);
  await runApply(files, runQuery, { baseline: args.baseline, log: m => console.log(m) });
}

main().catch(err => fail(`Error: ${err.message}`));

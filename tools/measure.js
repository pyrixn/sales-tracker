// Baseline measurement: runs every read action and the main write actions through the real Edge router
// over a seeded fake db, and reports statements, returned rows, response bytes and time.
//   node tools/measure.js          measure, print, and rewrite the "Baseline" table in docs/perf.md
//   node tools/measure.js --check  measure and print only
// Fake-db numbers count what the adapter asks for, not server latency. They are for comparing before/after.
const fs = require('fs');
const path = require('path');
const { makeFakeDb } = require('../test/support/fake-db');
const { seedDb, makeUiState } = require('../test/support/seed');
const { loadEdge } = require('../test/support/edge-host');
const { cid } = require('../test/fixtures');

const PERF = path.join(__dirname, '..', 'docs', 'perf.md');
const EDGE = path.join(__dirname, '..', 'src', 'server', 'edge.js');
const TARGET = { customers: 64, sales: 110, payments: 100, inbox: 300 };
const WRITES = ['newSale', 'pay', 'renew', 'match', 'editPayment'];

// Reads that need a payload; everything else takes {}.
function readPayload(name, m) {
  const customerId = cid(m, 'jamilhq');
  const sale = m.sales.find(s => s.Customer_ID === customerId);
  return ({
    customer: { id: customerId },
    reminderMessage: { saleId: sale.Sale_ID },
    entry: { kind: 'payment', id: m.payments[0].Payment_ID },
    product: { productId: 'EXITLAG' },
    suggestCustomers: { trx: 'TESTTRX1' },
    moneyExport: { tab: 'overview' }
  })[name] || {};
}

// The seeded state: the migrated fixture (64 customers, 102 sales, 90 payments, 1 inbox row) topped up to TARGET.
function buildState() {
  const m = makeUiState();
  const base = m.sales.filter(s => s.Record_Status === 'Active');
  let sid = Math.max(...m.sales.map(s => Number(s.Sale_ID))) + 1;
  while (m.sales.length < TARGET.sales) {
    const t = Object.assign({}, base[m.sales.length % base.length]);
    t.Sale_ID = sid++; t.Sub_Code = 'X' + t.Sale_ID;
    m.sales.push(t);
  }
  let pid = m.payments.length + 1;
  while (m.payments.length < TARGET.payments) {
    const t = Object.assign({}, m.payments[m.payments.length % 90]);
    t.Payment_ID = 'PM-' + String(pid++).padStart(5, '0'); t.Transaction_ID = '';
    m.payments.push(t);
  }
  while (m.inbox.length < TARGET.inbox) {
    const n = m.inbox.length;
    m.inbox.push({ Received: '2026-10-1' + (n % 9) + ' 10:00', Type: 'Received', Method: 'bKash', Sender: '+88017569' + String(10000 + n),
      Amount: 100 + (n % 7) * 50, Transaction_ID: 'SEEDTRX' + n, Reference: '', Status: n % 5 === 0 ? 'Matched' : 'Pending',
      Matched_Sale_ID: '', Raw_SMS: 'Seed message ' + n });
  }
  return m;
}

// The base seed has no Reminders_Log rows. reminderLog is measured with 320 sent or skipped rows over the last 60 days (more than
// its 300-row cap), so the budget row is the most the Reminders screen can get back, not the empty case.
function addReminderLog(m) {
  const sales = m.sales.filter(s => s.Record_Status === 'Active');
  const [y, mo, d] = m.today.split('-').map(Number);
  m.remindersLog = [];
  for (let i = 0; i < 320; i++) {
    const s = sales[i % sales.length];
    const date = new Date(Date.UTC(y, mo - 1, d - (i % 60))).toISOString().slice(0, 10);
    m.remindersLog.push({ Date: date, Sale_ID: s.Sale_ID, Customer_ID: s.Customer_ID, Kind: ['before', 'on_day', 'after', 'due'][i % 4],
      Channel: s.Customer_ID ? 'WhatsApp' : '', Status: i % 3 ? 'sent' : 'skipped' });
  }
}

// The base seed has no Change_Log rows. activity is measured with 160 batches of 10 lines (1600 lines): more than its 1500-line read window,
// so the row count is the window and the response is the newest 100 batches, the most the Activity screen can get back. Every ninth
// batch is an Undo of the one before it, so the undone and reversal paths are both timed.
function addChangeLog(m) {
  const pid = i => 'PM-' + String(i % 100 + 1).padStart(5, '0');
  const fields = ['Amount', 'Date', 'Method', 'Note', 'Customer_ID', 'Sale_ID', 'Transaction_ID', 'Source', 'Amount', 'Note'];
  m.changeLog = [];
  let id = 1;
  for (let b = 0; b < 160; b++) {
    const batch = 'M-' + String(b).padStart(4, '0');
    const at = new Date(Date.UTC(2026, 0, 1) + b * 3600e3).toISOString();
    const action = b % 9 === 8 ? 'undo:M-' + String(b - 1).padStart(4, '0') : 'editPayment';
    for (let j = 0; j < 10; j++) m.changeLog.push({ id: id++, time: at, batch_id: batch, action: action, tab: 'Payments', row_key: pid(b), field: fields[j], old: 'a', new: 'b' });
  }
}

// Valid payloads for the measured writes, built from the seed.
function writePayload(name, m) {
  const c = cid(m, 'Kabir');
  return ({
    newSale: { productId: 'NETFLIX', accountId: 'NFX-03', customerId: c, paidNow: { amount: 290, method: 'bKash' } },
    pay: { customerId: c, amount: 300, method: 'bKash' },
    renew: { subCode: 'N44', months: 1 },
    match: { trx: 'TESTTRX1', customerId: c },
    editPayment: { paymentId: m.payments[0].Payment_ID, amount: Number(m.payments[0].Amount) - 1 }
  })[name];
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

// Each run uses a fresh seeded db so one write never changes the next. Returns { queries, roundTrips, rows, bytes, ms } or { error }.
async function measureAction(name, opts) {
  const runs = (opts && opts.runs) || 5;
  const isWrite = WRITES.indexOf(name) >= 0;
  const times = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    const { db, tables } = makeFakeDb();
    const m = buildState();
    if (name === 'reminderLog') addReminderLog(m);
    if (name === 'activity') addChangeLog(m);
    await seedDb(db, tables, m);
    const edge = loadEdge(db);
    const payload = isWrite ? Object.assign({ requestId: 'measure-' + name + '-' + i }, writePayload(name, m)) : readPayload(name, m);
    db.resetStats();
    const t0 = process.hrtime.bigint();
    let res;
    try { res = await edge.api(name, payload); } catch (e) { return { error: String((e && e.message) || e) }; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!res.ok) return { error: String(res.error) };
    times.push(ms);
    last = { queries: db.stats.statements, roundTrips: db.stats.roundTrips, rows: db.stats.rows, bytes: Buffer.byteLength(JSON.stringify(res)) };
  }
  last.ms = Math.round(median(times) * 10) / 10;
  return last;
}

function readNames() {
  const src = fs.readFileSync(EDGE, 'utf8');
  const a = src.indexOf('var READS_ = {'), b = src.indexOf('var WRITES_ = {');
  const names = [];
  src.slice(a, b).split('\n').forEach(l => { const x = l.match(/^  ([a-zA-Z]+): async function/); if (x) names.push(x[1]); });
  return names;
}
function writeNames() {
  const src = fs.readFileSync(EDGE, 'utf8');
  return WRITES.filter(n => new RegExp('^  ' + n + ': async function', 'm').test(src));
}

async function measureAll() {
  const out = [];
  for (const n of readNames().concat(writeNames())) out.push(Object.assign({ action: n }, await measureAction(n)));
  return out;
}

function table(rows, withMs) {
  const head = '| action | queries | rows | bytes |' + (withMs ? ' roundTrips | ms |' : '');
  const sep = '|---|---:|---:|---:|' + (withMs ? '---:|---:|' : '');
  const lines = rows.map(r => r.error
    ? '| ' + r.action + ' | error: ' + String(r.error).replace(/\|/g, '/') + ' | | |' + (withMs ? ' | |' : '')
    : '| ' + r.action + ' | ' + r.queries + ' | ' + r.rows + ' | ' + r.bytes + ' |' + (withMs ? ' ' + r.roundTrips + ' | ' + r.ms + ' |' : ''));
  return [head, sep].concat(lines).join('\n');
}

async function main() {
  const rows = await measureAll();
  const good = rows.filter(r => !r.error);
  console.log(table(rows, true));
  if (process.argv.indexOf('--check') >= 0) return;
  const prev = fs.existsSync(PERF) ? fs.readFileSync(PERF, 'utf8') : '';
  const bi = prev.indexOf('## Budgets');
  const budgets = bi >= 0 ? prev.slice(bi)
    : '## Budgets\n\nThe most an action may use. `test/perf-budget.test.js` fails when an action exceeds its row. ms is never gated.\n' +
      'Started equal to the baseline; lower a row after a speed-up lands. Edit by hand (this tool keeps an existing table).\n\n' + table(good, false) + '\n';
  const doc = '# Performance\n\n' +
    'Measured by `node tools/measure.js` through the real Edge router over a seeded fake db: ' +
    TARGET.customers + ' customers, ' + TARGET.sales + ' sales, ' + TARGET.payments + ' payments, ' + TARGET.inbox + ' inbox rows.\n\n' +
    'queries = SQL statements, rows = rows returned by them, bytes = JSON response size, roundTrips = statements plus BEGIN/COMMIT per transaction, ' +
    'ms = median of 5 runs (fake db, so only comparable run to run). These count what the adapter asks the database for, not network or Postgres time.\n' +
    'An action that errors under the seed shows as an error row and has no budget.\n\n## Baseline\n\n' + table(rows, true) + '\n\n' + budgets;
  fs.writeFileSync(PERF, doc);
}

module.exports = { measureAction, measureAll, buildState, readPayload, writePayload };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

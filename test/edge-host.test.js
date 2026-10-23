const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

async function seededHost(opts) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  return { db, tables, edge: loadEdge(db, opts) };
}

test('home read on the seeded state shows what is owed', async () => {
  const { edge } = await seededHost();
  const res = await edge.api('home', {});
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.owed, 1360);
  assert.equal(res.data.today, '2026-10-18');
});

test('unsupported SQL fails loudly', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(db.query('DROP TABLE sales'), /unhandled SQL/);
});

test('fake db: INSERT INTO settings stores key/value pairs readable by SELECT key, value', async () => {
  const { db, tables } = makeFakeDb();
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['language', 'bn']);
  assert.equal(tables.settings.get('language'), 'bn');
  const res = await db.query('SELECT key, value FROM settings');
  assert.deepEqual(res.rows.find(r => r.key === 'language'), { key: 'language', value: 'bn' });
});

test('seedDb round-trips the UI state through Adapter.readState', async () => {
  const Adapter = require('../src/adapters/postgres.js');
  const { db } = await seededHost();
  const want = makeUiState();
  const got = await Adapter.readState(db, '2026-10-18');
  for (const k of ['customers', 'sales', 'payments', 'accounts', 'products', 'codes', 'purchases', 'wallets', 'inbox']) {
    assert.equal(got[k].length, want[k].length, k);
  }
  assert.equal(got.settings.bkash_number, want.settings.bkash_number);
  assert.equal(got.settings.grace_days, 3);
  const nasim = got.customers.find(c => c.Name === 'jamilhq');
  assert.equal(nasim.Channel, 'WhatsApp');
  assert.equal(nasim.Handle, '01711111111');
  assert.equal(got.inbox[0].Transaction_ID, 'TESTTRX1');
  assert.equal(got.inbox[0].Amount, 290);
});

test('two edge hosts keep separate data', async () => {
  const a = await seededHost();
  const b = await seededHost();
  const before = b.tables.expenses.size;
  const res = await a.edge.api('addExpense', { date: '2026-10-18', category: 'Other', amount: 100, paidWith: 'UNKNOWN', note: 'host A only' });
  assert.equal(res.ok, true, res.error);
  assert.equal(a.tables.expenses.size, before + 1);
  assert.equal(b.tables.expenses.size, before);
  const bookA = await a.edge.api('book', { month: '2026-10' });
  const bookB = await b.edge.api('book', { month: '2026-10' });
  assert.equal(bookA.ok, true, bookA.error);
  assert.equal(bookB.ok, true, bookB.error);
  assert.notDeepEqual(bookA.data, bookB.data);
});

test('loadEdge pins today_ per instance', async () => {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const x = loadEdge(db, { today: '2026-11-01' });
  const y = loadEdge(db);
  assert.equal((await x.api('home', {})).data.today, '2026-11-01');
  assert.equal((await y.api('home', {})).data.today, '2026-10-18');
});

test('fake db: request_log insert is DO NOTHING on conflict and select returns the stored response', async () => {
  const { db } = makeFakeDb();
  const ins = 'INSERT INTO request_log (request_id, response) VALUES ($1, $2) ON CONFLICT (request_id) DO NOTHING';
  assert.deepEqual((await db.query('SELECT response FROM request_log WHERE request_id = $1', ['r1'])).rows, []);
  await db.query(ins, ['r1', '{"ok":true,"n":1}']);
  await db.query(ins, ['r1', '{"ok":true,"n":2}']);
  assert.deepEqual((await db.query('SELECT response FROM request_log WHERE request_id = $1', ['r1'])).rows, [{ response: '{"ok":true,"n":1}' }]);
});

test('fake db: settings upsert overwrites an existing key', async () => {
  const { db, tables } = makeFakeDb();
  const up = 'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
  await db.query(up, ['language', 'bn']);
  await db.query(up, ['language', 'en']);
  await db.query(up, ['brand_new', 'x']);
  assert.equal(tables.settings.get('language'), 'en');
  assert.equal(tables.settings.get('brand_new'), 'x');
});

test('fake db: SELECT * FROM change_log ORDER BY id returns rows in insert order with ids', async () => {
  const { db } = makeFakeDb();
  const ins = 'INSERT INTO change_log (time, batch_id, action, tab, row_key, field, old, new) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
  await db.query(ins, ['t', 'b1', 'a', 'Customers', 'C1', 'Name', '', 'x']);
  await db.query(ins, ['t', 'b2', 'a', 'Customers', 'C1', 'Name', 'x', 'y']);
  const res = await db.query('SELECT * FROM change_log ORDER BY id');
  assert.deepEqual(res.rows.map(r => [r.id, r.batch_id]), [[1, 'b1'], [2, 'b2']]);
});

test('fake db: selected rows are copies, and reminders_log keeps many rows per sale', async () => {
  const { db, tables } = makeFakeDb();
  await db.query('INSERT INTO customers (customer_id, name) VALUES ($1,$2)', ['C1', 'a']);
  const got = (await db.query('SELECT * FROM customers')).rows[0];
  await db.query('UPDATE customers SET name = $1 WHERE customer_id = $2', ['b', 'C1']);
  assert.equal(got.name, 'a');
  const ins = 'INSERT INTO reminders_log (date, sale_id, kind) VALUES ($1,$2,$3)';
  await db.query(ins, ['2026-10-18', 5, 'before']);
  await db.query(ins, ['2026-10-18', 5, 'due']);
  assert.equal(tables.reminders_log.length, 2);
});

test('fake db: payment_inbox is keyed on transaction_id and SELECT 1 finds duplicates', async () => {
  const { db, tables } = makeFakeDb();
  const ins = 'INSERT INTO payment_inbox (received, type, transaction_id) VALUES ($1,$2,$3)';
  await db.query(ins, ['2026-10-18 10:00', 'Received', 'A1']);
  await db.query(ins, ['2026-10-18 10:00', 'Received', 'A2']);
  assert.equal(tables.payment_inbox.size, 2);
  const q = 'SELECT 1 FROM payment_inbox WHERE transaction_id = $1 LIMIT 1';
  assert.equal((await db.query(q, ['A1'])).rows.length, 1);
  assert.equal((await db.query(q, ['ZZ'])).rows.length, 0);
});

test('loadEdge exposes relayIngest bound to the same db', async () => {
  const { db, tables } = makeFakeDb();
  const edge = loadEdge(db);
  const r = await edge.relayIngest({ sender: '16247', text: 'You have received Tk 100.00 from 01756999991. TrxID QWERTY1234' }, 'bkash');
  assert.equal(r.result, 'stored');
  assert.ok(tables.payment_inbox.get('QWERTY1234'));
});

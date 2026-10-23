const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const SMS = 'You have received Tk 120.00 from 01712345678. TrxID ZZ1234567 at 18/10/2026 14:17';

async function host(env, st) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, st || makeUiState());
  return { db, tables, edge: loadEdge(db, { env: env || {} }) };
}
const post = (body, headers) => new Request('https://x.test/functions/v1/api/', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
const get = (p) => new Request('https://x.test/functions/v1/api' + p);

test('bulkImport is gone: the router and the deployed bundle do not know it', async () => {
  const { edge } = await host();
  const r = await edge.api('bulkImport', { tabs: { customers: [{ Customer_ID: 'X', Name: 'x' }] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown action/);
  assert.ok(!/bulkImport/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'edge.js'), 'utf8')));
});

test('a database error is hidden from the panel; a plain error keeps its message', async () => {
  const { db, edge } = await host();
  const query = db.query;
  const log = console.error; console.error = () => {};
  try {
    db.query = async (text, params) => {
      if (/^\s*INSERT INTO expenses/i.test(text)) throw Object.assign(new Error('null value in column "x" violates not-null constraint'), { code: '23502' });
      return query(text, params);
    };
    const hidden = await edge.api('addExpense', { category: 'Other', amount: 10, date: '2026-10-18', paidWith: '', note: 'x' });
    assert.equal(hidden.ok, false);
    assert.ok(!/null value|constraint/.test(hidden.error), hidden.error);
  } finally { console.error = log; }
  const plain = await edge.api('customer', { id: 'NOPE' });
  assert.match(plain.error, /Unknown customer NOPE/);
});

test('every write takes the write lock; reads do not', async () => {
  const { db, edge } = await host();
  await edge.api('home', {});
  assert.equal(db.lockCalls || 0, 0);
  const r = await edge.api('addExpense', { category: 'Other', amount: 10, date: '2026-10-18', paidWith: '', note: 'x' });
  assert.equal(r.ok, true, r.error);
  assert.equal(db.lockCalls, 1);
});

test('a repeated requestId returns the first response and writes once', async () => {
  const { tables, edge } = await host();
  const p = { requestId: 'req-1', category: 'Other', amount: 10, date: '2026-10-18', paidWith: '', note: 'x' };
  const a = await edge.api('addExpense', p);
  const n = tables.expenses.size;
  const b = await edge.api('addExpense', p);
  assert.deepEqual(b, a);
  assert.equal(tables.expenses.size, n);
});

test('relay stores under the write lock', async () => {
  const { db, edge, tables } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'b' });
  const r = await edge.relayIngest({ sender: '16247', text: SMS }, 'bkash');
  assert.equal(r.result, 'stored');
  assert.ok(db.lockCalls >= 1);
  assert.ok(tables.payment_inbox.has('ZZ1234567'));
});

test('relay: a duplicate that slips past the check is reported as duplicate, not an error', async () => {
  const { db, edge } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'b' });
  const query = db.query;
  db.query = async (text, params) => {
    if (/^\s*INSERT INTO payment_inbox/i.test(text)) throw new Error('duplicate key value violates unique constraint "payment_inbox_trx_idx"');
    return query(text, params);
  };
  const r = await edge.relayIngest({ sender: '16247', text: SMS }, 'bkash');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'duplicate ZZ1234567');
});

test('relay: any other storage error is reported, not thrown', async () => {
  const { db, edge } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'b' });
  const query = db.query;
  db.query = async (text, params) => {
    if (/^\s*INSERT INTO payment_inbox/i.test(text)) throw new Error('connection reset');
    return query(text, params);
  };
  const r = await edge.relayIngest({ sender: '16247', text: SMS }, 'bkash');
  assert.equal(r.ok, false);
  assert.match(r.error, /connection reset/);
});

test('pay page and status read only rows that match, never whole tables', async () => {
  const st = makeUiState();
  st.sales.forEach(s => { s.Pay_Token = s.Sub_Code ? 'TOK-' + s.Sub_Code + '-abcdefghijklmnop' : ''; });
  const { db, edge } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'b' }, st);
  const line = st.sales.find(s => s.Sub_Code);
  const seen = [];
  const query = db.query;
  db.query = async (text, params) => { seen.push(text.replace(/\s+/g, ' ').trim()); return query(text, params); };
  assert.equal((await edge.handle(get('/pay/' + line.Pay_Token))).status, 200);
  assert.equal((await edge.handle(get('/pay/' + line.Pay_Token + '/status'))).status, 200);
  const wide = seen.filter(q => /^SELECT \* FROM [a-z_]+$/i.test(q));
  assert.deepEqual(wide, []);
});

test('pay status sees a payment whose reference is typed in another case', async () => {
  const st = makeUiState();
  st.sales.forEach(s => { s.Pay_Token = s.Sub_Code ? 'TOK-' + s.Sub_Code + '-abcdefghijklmnop' : ''; });
  const { tables, edge } = await host({ APP_SECRET: 'a', RELAY_TOKEN: 'b' }, st);
  const line = st.sales.find(s => s.Sub_Code);
  const url = '/pay/' + line.Pay_Token + '/status';
  assert.equal((await (await edge.handle(get(url))).json()).paid, false);
  tables.payment_inbox.set('PAYCASE01', { transaction_id: 'PAYCASE01', reference: line.Sub_Code.toLowerCase(), amount: 100,
    received: '2026-10-18 10:00', status: 'Pending', type: 'Received', method: 'bKash', sender: '16247', raw_sms: '', counterparty: '', matched_sale_id: '' });
  assert.equal((await (await edge.handle(get(url))).json()).paid, true);
});

test('ten failed sign-ins from one client block that client; others and the right secret from elsewhere still work', async () => {
  const { edge } = await host({ APP_SECRET: 'right', RELAY_TOKEN: 'tok' });
  const as = (ip, secret) => post({ action: 'home' }, { 'X-Forwarded-For': ip, 'X-App-Secret': secret });
  for (let i = 0; i < 10; i++) assert.equal((await edge.handle(as('1.1.1.1', 'wrong' + i))).status, 401);
  assert.equal((await edge.handle(as('1.1.1.1', 'right'))).status, 429);
  assert.equal((await edge.handle(post({ token: 'tok', sender: '16247', text: SMS }, { 'X-Forwarded-For': '1.1.1.1' }))).status, 429);
  assert.equal((await edge.handle(as('2.2.2.2', 'right'))).status, 200);
});

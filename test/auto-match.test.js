const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const all = tbl => Array.from(tbl.values());
async function boot(env, mutate) {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  if (mutate) mutate(m);
  await seedDb(db, tables, m);
  return { tables, m, edge: loadEdge(db, { env: env || {} }) };
}
const sms = (amount, ref, trx) => 'You have received Tk ' + amount + '.00 from 01756999991. Ref ' + ref + '. TrxID ' + trx + ' at 18/10/2026 14:05';

test('relay auto-matches a clear bKash payment: payment written, inbox Matched, audit action starts with auto', async () => {
  const { edge, tables } = await boot();
  const paymentsBefore = tables.payments.size;
  const r = await edge.relayIngest({ sender: '16247', text: sms(580, 'N44', 'AUTO0000001') }, 'bkash');
  assert.equal(r.result, 'stored');
  assert.equal(r.matched, true, JSON.stringify(r));
  assert.equal(tables.payment_inbox.get('AUTO0000001').status, 'Matched');
  assert.ok(tables.payments.size > paymentsBefore);
  assert.ok(tables.change_log.some(l => /^auto/.test(l.action)));
});

test('auto-match skips and leaves Pending: unknown reference, no reference', async () => {
  const { edge, tables } = await boot();
  for (const [ref, trx] of [['ZZ999', 'AUTO0000002'], ['', 'AUTO0000003']]) {
    const text = ref ? sms(290, ref, trx) : 'You have received Tk 290.00 from 01756999991. TrxID ' + trx + ' at 18/10/2026 14:05';
    const r = await edge.relayIngest({ sender: '16247', text }, 'bkash');
    assert.equal(r.result, 'stored');
    assert.equal(r.matched, false);
    assert.equal(tables.payment_inbox.get(trx).status, 'Pending');
  }
});

test('auto-match does not run for Upay (Review) rows', async () => {
  const { edge, tables } = await boot();
  const before = tables.payments.size;
  const r = await edge.relayIngest({ sender: '16268', text: 'Tk 290.00 has been received. Ref : N44. TrxID UPAYAUTO001 at 21/10/2026 09:00' }, 'upay');
  assert.equal(r.matched, false);
  assert.equal(tables.payment_inbox.get('UPAYAUTO001').status, 'Review');
  assert.equal(tables.payments.size, before);
});

test('auto-match is skipped above the cap (default 5000) and left Pending', async () => {
  const { edge, tables } = await boot();
  const before = tables.payments.size;
  const r = await edge.relayIngest({ sender: '16247', text: sms(5001, 'N44', 'AUTO0000004') }, 'bkash');
  assert.equal(r.matched, false);
  assert.match(r.autoNote, /above the auto-match limit/);
  assert.equal(tables.payment_inbox.get('AUTO0000004').status, 'Pending');
  assert.equal(tables.payments.size, before);
});

test('cap can be raised with the auto_match_max_bdt setting', async () => {
  const { edge } = await boot({}, m => { m.settings.auto_match_max_bdt = '10000'; });
  const r = await edge.relayIngest({ sender: '16247', text: sms(5800, 'N44', 'AUTO0000005') }, 'bkash');
  assert.equal(r.matched, true, JSON.stringify(r));
});

test('a duplicate TrxID is not matched twice', async () => {
  const { edge, tables } = await boot();
  await edge.relayIngest({ sender: '16247', text: sms(290, 'N44', 'AUTO0000006') }, 'bkash');
  const n = tables.payments.size;
  const again = await edge.relayIngest({ sender: '16247', text: sms(290, 'N44', 'AUTO0000006') }, 'bkash');
  assert.equal(again.result, 'duplicate AUTO0000006');
  assert.equal(tables.payments.size, n);
});

test('a planning or write error leaves the row Pending and reports it', async () => {
  const { edge, tables } = await boot();
  const Adapter = require('../src/adapters/postgres.js');
  const orig = Adapter.applyOps;
  Adapter.applyOps = async () => { throw new Error('disk full'); };
  try {
    const r = await edge.relayIngest({ sender: '16247', text: sms(290, 'N44', 'AUTO0000007') }, 'bkash');
    assert.equal(r.result, 'stored');
    assert.equal(r.matched, false);
    assert.match(r.autoNote, /disk full/);
    assert.equal(tables.payment_inbox.get('AUTO0000007').status, 'Pending');
  } finally { Adapter.applyOps = orig; }
});

test('through /relay: a wrong token never reaches the matcher', async () => {
  const { edge, tables } = await boot({ APP_SECRET: 'a', RELAY_TOKEN: 'good-token' });
  const before = tables.payment_inbox.size;
  const res = await edge.handle(new Request('https://x.test/functions/v1/api/relay?src=bkash', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'bad', sender: '16247', text: sms(580, 'N44', 'AUTO0000008') }) }));
  assert.equal(res.status, 401);
  assert.equal(tables.payment_inbox.size, before);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const samples = require('./fixtures/sms-upay-nagad');

async function host() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  return { tables, edge: loadEdge(db) };
}

for (const s of samples) {
  test('relay: ' + s.name, async () => {
    const { edge, tables } = await host();
    const before = tables.payment_inbox.size;
    const r = await edge.relayIngest({ sender: s.sender, text: s.text }, s.src);
    if (s.want.skip) {
      assert.equal(r.result, 'skipped: ' + s.want.skip);
      assert.equal(tables.payment_inbox.size, before);
      return;
    }
    assert.equal(r.result, 'stored');
    const row = tables.payment_inbox.get(s.want.trxId);
    assert.ok(row, 'row stored under its TrxID');
    assert.equal(row.type, s.want.type);
    assert.equal(row.method, s.want.method);
    assert.equal(Number(row.amount), s.want.amount);
    assert.equal(row.counterparty, s.want.counterparty);
    assert.equal(row.reference, s.want.reference);
    assert.equal(row.status, s.want.status);
  });
}

test('relay: source is found from the sender when the ?src tag is missing', async () => {
  const { edge, tables } = await host();
  await edge.relayIngest({ sender: '16268', text: samples[0].text }, '');
  assert.equal(tables.payment_inbox.get('UPAY1A2B3C').method, 'Upay');
});

test('relay: bKash parsing is unchanged', async () => {
  const { edge, tables } = await host();
  const r = await edge.relayIngest({ sender: '16247', text: 'You have received Tk 580.00 from 01756999991. Ref ZZ44. TrxID ABC123XYZ at 18/10/2026 14:05' }, 'bkash');
  assert.equal(r.result, 'stored');
  const row = tables.payment_inbox.get('ABC123XYZ');
  assert.equal(row.reference, 'ZZ44'); assert.equal(row.counterparty, '01756999991'); assert.equal(row.status, 'Pending'); assert.equal(row.method, 'bKash');
});

const test = require('node:test');
const assert = require('node:assert/strict');

// The palette's record search is plain data (no React), kept in web/src/lib so the panel and tests share it.
const load = () => import('../web/src/lib/palette.js?t=' + Date.now());

const data = {
  customers: [{ id: 'C1', name: 'Jamil Hossain', handle: '01756999991' }, { id: 'C2', name: 'Arman Mallik', handle: 'arman_m' }, { id: 'C3', name: 'Sadia', handle: '' }],
  lines: [{ subCode: 'S65', customerId: 'C1', name: 'Jamil Hossain' }, { subCode: 'N44', customerId: 'C2', name: 'Arman Mallik' }],
  unmatched: [{ trx: 'TX9K2M4P7Q', amount: 290, sender: '16247' }],
  autoToCheck: [{ trx: 'AUTO0001', customerId: 'C2', name: 'Arman Mallik', amount: 580, date: '2026-10-25' }]
};

test('the palette searches records only from three characters', async () => {
  const { recordMatches, MIN_QUERY } = await load();
  assert.equal(MIN_QUERY, 3);
  for (const q of ['', ' ', 'ja', ' Ja ']) {
    const r = recordMatches(q, data);
    assert.deepEqual([r.customers, r.subCodes, r.transactions], [[], [], []], JSON.stringify(q));
  }
});

test('customers match by name or handle, case-insensitively', async () => {
  const { recordMatches } = await load();
  assert.deepEqual(recordMatches('JAMIL', data).customers.map(c => c.id), ['C1']);
  assert.deepEqual(recordMatches('arman_m', data).customers.map(c => c.id), ['C2']);
  assert.deepEqual(recordMatches('0175699', data).customers.map(c => c.id), ['C1']);
  assert.deepEqual(recordMatches('zzz', data).customers, []);
});

test('sub-codes and transaction ids are found too, with the customer to open', async () => {
  const { recordMatches } = await load();
  assert.deepEqual(recordMatches('s65', data).subCodes.map(l => [l.subCode, l.customerId]), [['S65', 'C1']]);
  assert.deepEqual(recordMatches('tx9k2', data).transactions.map(t => [t.trx, t.pending]), [['TX9K2M4P7Q', true]]);
  assert.deepEqual(recordMatches('auto000', data).transactions.map(t => [t.trx, t.pending, t.customerId]), [['AUTO0001', false, 'C2']]);
});

test('results are capped so a one-letter-wide match cannot flood the list', async () => {
  const { recordMatches, LIMIT } = await load();
  const many = { customers: Array.from({ length: 400 }, (_, i) => ({ id: 'C' + i, name: 'Customer ' + i, handle: '' })), lines: [], unmatched: [], autoToCheck: [] };
  assert.equal(recordMatches('custo', many).customers.length, LIMIT);
  assert.ok(LIMIT >= 50 && LIMIT <= 200);
});

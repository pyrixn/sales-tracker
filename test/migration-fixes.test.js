// Migration panel fixes: numeric Due is an amount still owed, and a line brings its account row into the same apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

async function boot() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  return { db, tables, edge: loadEdge(db) };
}
const all = tbl => Array.from(tbl.values ? tbl.values() : tbl);
const ACC = { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', collected: 300, cost: 900, renewalDate: '2026-11-20', slots: 3 } };
const line = (id, extra) => ({ id, kind: 'line', sheet: 'S', ref: id.slice(-2), data: Object.assign({ accountRef: 'imp:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20' }, extra) });
async function stageAll(edge, rows) {
  assert.equal((await edge.api('importStage', { requestId: 's1', batch: 'imp', rows })).ok, true);
}
const approve = (edge, ids) => edge.api('importStatus', { requestId: 'ap-' + ids.join(','), rowIds: ids, status: 'Approved' });

test('review reads a numeric Due as dueAmount: no date issue, and rows staged before need no re-staging', async () => {
  const { edge } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', { due: '585' }), line('imp:S:L2', { due: 405, name: 'Other Person' })]);
  const r = await edge.api('importReview', {});
  const lines = r.data.accounts[0].lines;
  assert.equal(lines[0].data.dueAmount, 585);
  assert.equal(lines[0].data.due, '');
  assert.equal(lines[1].data.dueAmount, 405);
  lines.forEach(l => assert.ok(!l.issues.some(i => /Due|not a date/.test(i)), l.issues.join(' | ')));
});

test('apply: sale price is amount plus dueAmount, the payment is the amount only', async () => {
  const { edge, tables } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', { due: 585 })]);
  await approve(edge, ['imp:S:A1', 'imp:S:L1']);
  const ap = await edge.api('importApply', { requestId: 'x1', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  const sale = all(tables.sales).find(s => s.customer === 'Synthetic Person');
  assert.equal(Number(sale.unit_price), 885);
  const pays = all(tables.payments).filter(p => String(p.sale_id) === String(sale.sale_id));
  assert.deepEqual(pays.map(p => Number(p.amount)), [300]);
});

test('apply: an unpaid line with dueAmount makes the sale and no payment', async () => {
  const { edge, tables } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', { status: 'Unpaid', amount: 0, dueAmount: 585 })]);
  await approve(edge, ['imp:S:A1', 'imp:S:L1']);
  const ap = await edge.api('importApply', { requestId: 'x1', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  const sale = all(tables.sales).find(s => s.customer === 'Synthetic Person');
  assert.equal(Number(sale.unit_price), 585);
  assert.equal(all(tables.payments).filter(p => String(p.sale_id) === String(sale.sale_id)).length, 0);
});

test('applying a line alone skips it; with includeParents its account row comes along in one batch', async () => {
  const { edge, tables } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', {})]);
  await approve(edge, ['imp:S:L1']);
  const alone = await edge.api('importApply', { requestId: 'x1', batch: 'imp' });
  assert.equal(alone.ok, true, alone.error);
  assert.equal(alone.data.applied, 0);
  assert.match(alone.data.skipped[0].error, /not applied yet/);
  assert.match((await edge.api('importApply', { requestId: 'x3', batch: 'imp', includeParents: true })).error, /Approve account A1 first, or approve both/);
  const both = await edge.api('importApply', { requestId: 'x2', batch: 'imp', includeParents: true, approveParents: true });
  assert.equal(both.ok, true, both.error);
  assert.deepEqual(both.data.alsoApplied, ['imp:S:A1']);
  assert.equal(both.data.applied, 2);
  assert.equal(tables.import_rows.get('imp:S:A1').status, 'Applied');
  assert.equal(tables.import_rows.get('imp:S:L1').status, 'Applied');
  // One Undo reverses all of it.
  const undone = await edge.api('undo', { batchId: both.data.batchId });
  assert.equal(undone.ok, true, undone.error);
  assert.equal(tables.import_rows.get('imp:S:A1').status, 'Review');
  assert.equal(all(tables.sales).filter(s => s.customer === 'Synthetic Person').length, 0);
});

test('includeParents leaves a Skipped account row alone', async () => {
  const { edge } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', {})]);
  await edge.api('importStatus', { requestId: 'sk', rowIds: ['imp:S:A1'], status: 'Skipped' });
  await approve(edge, ['imp:S:L1']);
  const r = await edge.api('importApply', { requestId: 'x1', batch: 'imp', includeParents: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.applied, 0);
  assert.equal(r.data.skipped.length, 1);
});

test('a 6-month line with 800 total: Months 6, unit price total/months, revenue 800 exactly, accrual spreads 800', async () => {
  const { edge, db, tables } = await boot();
  const { Core } = require('./load-core');
  const Adapter = require('../src/adapters/postgres.js');
  await stageAll(edge, [ACC, line('imp:S:L1', { months: 6, amount: 800, paidTill: '2026-11-20', coversFrom: '' })]);
  const rv = await edge.api('importReview', {});
  assert.deepEqual(rv.data.accounts[0].lines[0].issues, []);
  await approve(edge, ['imp:S:A1', 'imp:S:L1']);
  const ap = await edge.api('importApply', { requestId: 'x1', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  const row = all(tables.sales).find(s => s.customer === 'Synthetic Person');
  assert.equal(Number(row.months), 6);
  assert.ok(Math.abs(Number(row.unit_price) - 133.333333) < 1e-6);
  assert.ok(row.covers_from && row.covers_from < '2026-11-20');
  const st = await Adapter.readState(db, '2026-11-25');
  const sale = st.sales.find(s => s.Customer === 'Synthetic Person');
  assert.equal(Core.ledger.saleRevenue(sale, st.products), 800);
  const m = Core.accrual.monthly(st, { from: row.covers_from.slice(0, 7), to: '2026-11' });
  // Revenue of this sale alone: the months with it minus the months without it.
  const without = Core.accrual.monthly(Object.assign({}, st, { sales: st.sales.filter(s => s !== sale) }), { from: row.covers_from.slice(0, 7), to: '2026-11' });
  const per = m.months.map((x, i) => Math.round((x.revenue - without.months[i].revenue) * 100) / 100);
  const rev = per.reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(rev - 800) < 0.05, 'accrued ' + rev);
  assert.ok(per.filter(x => x > 0).length >= 6, per.join(','));
});

test('months must be a whole number 1 to 24', async () => {
  const { edge } = await boot();
  await stageAll(edge, [ACC, line('imp:S:L1', { months: 30 })]);
  const rv = await edge.api('importReview', {});
  assert.ok(rv.data.accounts[0].lines[0].issues.some(i => /Months/.test(i)));
  await approve(edge, ['imp:S:A1', 'imp:S:L1']);
  assert.ok(rv.data.accounts[0].lines[0].blocks);
  const ap = await edge.api('importApply', { requestId: 'x1', batch: 'imp' });
  assert.equal(ap.data.skipped.length, 1);
  assert.match(ap.data.skipped[0].error, /Months/);
});

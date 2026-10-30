const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const state = () => ({ today: '2026-11-01', settings: { usdt_bdt_manual: '100' }, liveRates: [], suppliers: [],
  products: [{ Product_ID: 'A', Category: 'AI_Account' }, { Product_ID: 'S', Category: 'Subscription' }],
  sales: [
    { Sale_ID: 1, Sale_Date: '2026-10-05', Product_ID: 'A', Record_Status: 'Active', Unit_Price: 500, Months: 1, Buy_Currency: 'USDT', Buy_Price_USDT: 3, Cost_Snapshot: 0 },
    { Sale_ID: 2, Sale_Date: '2026-10-20', Product_ID: 'S', Record_Status: 'Active', Unit_Price: 200, Months: 2, Buy_Currency: 'BDT', Cost_Snapshot: 150 },
    { Sale_ID: 3, Sale_Date: '2026-09-30', Product_ID: 'S', Record_Status: 'Active', Unit_Price: 999, Months: 1, Buy_Currency: 'BDT', Cost_Snapshot: 1 },
    { Sale_ID: 4, Sale_Date: '2026-10-11', Product_ID: 'S', Record_Status: 'Void', Unit_Price: 999, Months: 1, Buy_Currency: 'BDT', Cost_Snapshot: 1 }] });

test('profitByFamily(state, month) only counts sales made in that month', () => {
  const rows = Core.views.profitByFamily(state(), '2026-10');
  const total = rows.reduce((a, r) => a + r.revenue, 0);
  assert.equal(total, 500 + 400);
});

test('profitSnapshotRow sums the month: revenue, cost (USDT at the resolved rate), profit', () => {
  const row = Core.views.profitSnapshotRow(state(), '2026-10');
  assert.deepEqual(row, { month: '2026-10', revenue_bdt: 900, cost_bdt: 300 + 150, profit_bdt: 450 });
});

test('previousMonth handles year change and Dhaka date strings', () => {
  assert.equal(Core.views.previousMonth('2026-11-01'), '2026-10');
  assert.equal(Core.views.previousMonth('2026-01-15'), '2025-12');
});

async function host(st) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, st || makeUiState());
  return { tables, edge: loadEdge(db, { today: '2026-11-03' }) };
}

test('snapshotIfDue inserts the previous month once and is idempotent', async () => {
  const { edge, tables } = await host();
  const a = await edge.api('snapshotIfDue', {});
  assert.equal(a.ok, true, a.error);
  assert.equal(a.data.month, '2026-10');
  assert.equal(a.data.created, true);
  assert.equal(tables.profit_snapshots.size, 1);
  const first = JSON.stringify(tables.profit_snapshots.get('2026-10'));
  const b = await edge.api('snapshotIfDue', {});
  assert.equal(b.data.created, false);
  assert.equal(tables.profit_snapshots.size, 1);
  assert.equal(JSON.stringify(tables.profit_snapshots.get('2026-10')), first);
});

test('snapshotIfDue does nothing when the month already has a row', async () => {
  const st = makeUiState();
  st.profitSnapshots = [{ Month: '2026-10', Revenue_BDT: 1, Cost_BDT: 1, Profit_BDT: 0, Generated_At: '2026-11-01T00:00:00Z' }];
  const { edge, tables } = await host(st);
  const r = await edge.api('snapshotIfDue', {});
  assert.equal(r.data.created, false);
  assert.equal(Number(tables.profit_snapshots.get('2026-10').revenue_bdt), 1);
});

test('snapshotIfDue waits while a USDT cost has no rate, so it never stores understated costs', async () => {
  const st = makeUiState();
  st.sales.push({ Sale_ID: 9001, Sale_Date: '2026-10-09', Customer: 'x', Contact: '', Product_ID: st.products[0].Product_ID, Account_ID: '', Code_ID: '',
    Qty: 1, Unit_Price: 500, Paid_Till: '', Record_Status: 'Active', Notes: '', Customer_ID: '', Months: 1, Sub_Code: '',
    Cost_Snapshot: 0, Buy_Price_USDT: 3, Buy_Currency: 'USDT' });
  const { edge, tables } = await host(st);
  const r = await edge.api('snapshotIfDue', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.created, false);
  assert.equal(r.data.reason, 'rate missing');
  assert.equal(tables.profit_snapshots.size, 0);
});

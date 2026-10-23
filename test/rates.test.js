const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const R = () => Core.rates;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const row = (rate, minutesAgo) => ({ ID: 'usdt_bdt', Rate: rate, Fetched_At: new Date(NOW - minutesAgo * 60000).toISOString() });

test('pickRate: median of the 5 cheapest positive prices, 2 decimals', () => {
  const ads = [130, 126, 127, 128, 129, 400, 500].map(p => ({ price: String(p) }));
  assert.equal(R().pickRate(ads), 128);
  assert.equal(R().pickRate([{ price: '127.1' }, { price: '128.2' }]), 127.65);
  assert.equal(R().pickRate([{ price: '128' }]), 128);
});

test('pickRate ignores zero, negative, non-numeric; null when nothing usable', () => {
  assert.equal(R().pickRate([{ price: '0' }, { price: 'abc' }, { price: '-3' }, {}, null]), null);
  assert.equal(R().pickRate([]), null);
  assert.equal(R().pickRate(undefined), null);
  assert.equal(R().pickRate([{ price: '0' }, { price: '127' }]), 127);
});

test('resolveRate: manual override wins', () => {
  const r = R().resolveRate({ liveRates: [row(125, 1)], settings: { usdt_bdt_manual: '131.5' } }, NOW);
  assert.deepEqual(r, { rate: 131.5, source: 'manual', fetchedAt: '', stale: false });
});

test('resolveRate: fresh bybit row, stale bybit row, none', () => {
  let r = R().resolveRate({ liveRates: [row(125, 4)], settings: {} }, NOW);
  assert.equal(r.rate, 125); assert.equal(r.source, 'bybit'); assert.equal(r.stale, false);
  r = R().resolveRate({ liveRates: [row(125, 6)], settings: { usdt_bdt_manual: '' } }, NOW);
  assert.equal(r.rate, 125); assert.equal(r.source, 'bybit'); assert.equal(r.stale, true);
  r = R().resolveRate({ liveRates: [], settings: {} }, NOW);
  assert.deepEqual(r, { rate: null, source: 'none', fetchedAt: '', stale: true });
  r = R().resolveRate({ liveRates: [{ ID: 'usdt_bdt', Rate: 0, Fetched_At: '' }], settings: { usdt_bdt_manual: '0' } }, NOW);
  assert.equal(r.source, 'none');
});

test('saleCostBdt: no 120 fallback; missing rate converts USDT at 0 and flags it', () => {
  const sale = { Buy_Price_USDT: 10, Buy_Currency: 'USDT', Product_ID: 'T', Cost_Snapshot: 999 };
  const none = { liveRates: [], suppliers: [], products: [{ Product_ID: 'T' }], settings: {} };
  assert.equal(Core.ledger.saleCostBdt(sale, none), 0);
  assert.deepEqual(Core.ledger.saleCostInfo(sale, none), { cost: 0, rateMissing: true });
  const manual = Object.assign({}, none, { settings: { usdt_bdt_manual: '128' } });
  assert.deepEqual(Core.ledger.saleCostInfo(sale, manual), { cost: 1280, rateMissing: false });
  const bdt = { Buy_Currency: 'BDT', Product_ID: 'T', Cost_Snapshot: 50 };
  assert.deepEqual(Core.ledger.saleCostInfo(bdt, none), { cost: 50, rateMissing: false });
});

test('profitByFamily carries rateMissing per category', () => {
  const state = { today: '2026-10-23', settings: {}, liveRates: [], suppliers: [],
    products: [{ Product_ID: 'T', Category: 'AI_Account', Default_Price: 500 }, { Product_ID: 'U', Category: 'Subscription', Default_Price: 100 }],
    sales: [
      { Sale_ID: 1, Product_ID: 'T', Record_Status: 'Active', Unit_Price: 500, Months: 1, Buy_Price_USDT: 3, Buy_Currency: 'USDT', Cost_Snapshot: 0 },
      { Sale_ID: 2, Product_ID: 'U', Record_Status: 'Active', Unit_Price: 100, Months: 1, Buy_Currency: 'BDT', Cost_Snapshot: 60 }] };
  const rows = Core.views.profitByFamily(state);
  assert.equal(rows.find(r => r.category === 'AI_Account').rateMissing, true);
  assert.equal(rows.find(r => r.category === 'Subscription').rateMissing, false);
});

test('lookups expose the resolved rate object', () => {
  const state = makeUiState();
  state.liveRates = [{ ID: 'usdt_bdt', Rate: 127, Fetched_At: new Date().toISOString() }];
  const l = Core.views.lookups(state);
  assert.equal(l.rate.rate, 127); assert.equal(l.rate.source, 'bybit'); assert.equal(l.rate.stale, false);
});

test('planSettings accepts usdt_bdt_manual: blank or a positive number only', () => {
  const st = { settings: {} };
  assert.deepEqual(Core.sales.planSettings(st, { usdt_bdt_manual: '' }).errors, []);
  assert.deepEqual(Core.sales.planSettings(st, { usdt_bdt_manual: '128.5' }).errors, []);
  assert.match(Core.sales.planSettings(st, { usdt_bdt_manual: '-1' }).errors[0], /rate/i);
  assert.match(Core.sales.planSettings(st, { usdt_bdt_manual: 'abc' }).errors[0], /rate/i);
});

// ---- Edge: refreshRate (network stubbed through loadEdge opts.fetchAds) ----
async function host(fetchAds) {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  await seedDb(db, tables, st);
  return { tables, edge: loadEdge(db, { fetchAds }) };
}
const ads = (...p) => async () => p.map(x => ({ price: String(x) }));

test('refreshRate stores the median and returns it', async () => {
  const { edge, tables } = await host(ads(126, 127, 128, 129, 130, 300));
  const r = await edge.api('refreshRate', {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.rate, 128);
  assert.equal(Number(tables.live_rates.get('usdt_bdt').rate), 128);
});

test('refreshRate: failure, timeout, empty list, no positive price write nothing', async () => {
  const cases = [async () => { throw new Error('boom'); }, async () => { throw new Error('timeout'); }, ads(), ads(0, 'x')];
  for (const f of cases) {
    const { edge, tables } = await host(f);
    const r = await edge.api('refreshRate', {});
    assert.equal(r.ok, false);
    assert.equal(tables.live_rates.size, 0);
  }
});

test('refreshRate skips the network while the cached row is under 5 minutes old', async () => {
  let calls = 0;
  const { edge, tables } = await host(async () => { calls++; return [{ price: '130' }]; });
  await edge.api('refreshRate', {});
  assert.equal(calls, 1);
  const again = await edge.api('refreshRate', {});
  assert.equal(calls, 1);
  assert.equal(again.ok, true);
  assert.equal(again.data.source, 'bybit');
  const forced = await edge.api('refreshRate', { force: true });
  assert.equal(calls, 2);
  assert.equal(forced.ok, true);
  assert.equal(Number(tables.live_rates.get('usdt_bdt').rate), 130);
});

test('edge rejects bad usdt_bdt_manual through saveSettings', async () => {
  const { edge } = await host(ads(127));
  const bad = await edge.api('settings', { values: { usdt_bdt_manual: '-5' } });
  assert.equal(bad.ok, false);
});

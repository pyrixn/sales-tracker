const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { appendOf, ok } = require('./helpers');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

test('IdGen.payToken is long, url-safe and unique', () => {
  const gen = Core.ids.IdGen({ sales: [] });
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = gen.payToken();
    assert.match(t, /^[A-Za-z0-9_-]{22,}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
});

test('new sale gets a pay token; renewal keeps the line token', () => {
  const m = makeMigratedState();
  const r = ok(Core.sales.planNewSale(m, { productId: 'NETFLIX', accountId: 'NFX-03',
    newCustomer: { name: 'Rahim', channel: 'WhatsApp', handle: '01711111111' }, profile: 'Rahim', months: 1 }));
  const sale = appendOf(r, 'Sales_Log').values;
  assert.match(sale.Pay_Token, /^[A-Za-z0-9_-]{22,}$/);
  assert.notEqual(sale.Pay_Token, sale.Sub_Code);

  const m2 = makeMigratedState();
  m2.sales.filter(s => s.Sub_Code === 'N44').forEach(s => { s.Pay_Token = 'TOKEN-OF-LINE-N44-xxxxxxxx'; });
  const rn = ok(Core.sales.planRenew(m2, { subCode: 'N44' }));
  assert.equal(appendOf(rn, 'Sales_Log').values.Pay_Token, 'TOKEN-OF-LINE-N44-xxxxxxxx');
});

test('renewal of a legacy line without a token mints one', () => {
  const m = makeMigratedState();
  const rn = ok(Core.sales.planRenew(m, { subCode: 'N44' }));
  assert.match(appendOf(rn, 'Sales_Log').values.Pay_Token, /^[A-Za-z0-9_-]{22,}$/);
});

test('reminder pay link uses the token, never the sub code', () => {
  const m = makeMigratedState();
  m.settings.pay_base_url = 'https://pay.example.test';
  m.sales.forEach(s => { if (s.Sub_Code) s.Pay_Token = 'TOK-' + s.Sub_Code + '-abcdefghijklmnop'; });
  const items = Core.reminders.planReminders(m).filter(i => i.subCode && i.message.includes('/pay/'));
  const tpl = m.settings;
  tpl.msg_renew_en = 'Pay: {link}'; tpl.msg_due_en = 'Pay: {link}'; tpl.language = 'en';
  const all = Core.reminders.planReminders(m).filter(i => i.subCode);
  assert.ok(all.length > 0);
  all.forEach(i => {
    assert.ok(i.message.includes('/pay/TOK-' + i.subCode + '-'), i.message);
    assert.ok(!i.message.includes('/pay/' + i.subCode));
  });
  m.sales.forEach(s => { s.Pay_Token = ''; });
  Core.reminders.planReminders(m).filter(i => i.subCode).forEach(i => assert.ok(!i.message.includes('/pay/')));
});

test('planBackfillPayTokens gives each line without a token one shared token', () => {
  const m = makeMigratedState();
  const plan = Core.sales.planBackfillPayTokens(m);
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.ops.length > 0);
  const byLine = {};
  plan.ops.forEach(o => {
    assert.equal(o.op, 'update'); assert.equal(o.tab, 'Sales_Log');
    const sale = m.sales.find(s => s.Sale_ID === o.id);
    (byLine[sale.Sub_Code] = byLine[sale.Sub_Code] || new Set()).add(o.values.Pay_Token);
  });
  Object.values(byLine).forEach(set => assert.equal(set.size, 1));
  const again = Core.sales.planBackfillPayTokens(Object.assign({}, m, { sales: m.sales.map(s => Object.assign({}, s, { Pay_Token: 'x'.repeat(22) })) }));
  assert.equal(again.ops.length, 0);
});

function get(path) { return new Request('https://x.test/functions/v1/api' + path); }

async function host() {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  st.sales.forEach(s => { s.Pay_Token = s.Sub_Code ? 'TOK-' + s.Sub_Code + '-abcdefghijklmnop' : ''; });
  await seedDb(db, tables, st);
  return { st, edge: loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } }) };
}

test('/pay/<token> renders the page; /pay/<subCode> is not found', async () => {
  const { st, edge } = await host();
  const line = st.sales.find(s => s.Sub_Code);
  const good = await edge.handle(get('/pay/' + line.Pay_Token));
  assert.equal(good.status, 200);
  const html = await good.text();
  assert.ok(html.includes(line.Sub_Code));
  const bad = await edge.handle(get('/pay/' + line.Sub_Code));
  assert.equal(bad.status, 404);
  const none = await edge.handle(get('/pay/does-not-exist-0123456789'));
  assert.equal(none.status, 404);
  assert.equal(await none.text(), await bad.text());
});

test('/pay/<token>/status answers by token only', async () => {
  const { st, edge } = await host();
  const line = st.sales.find(s => s.Sub_Code);
  const ok1 = await edge.handle(get('/pay/' + line.Pay_Token + '/status'));
  assert.equal(ok1.status, 200);
  assert.equal((await ok1.json()).ok, true);
  const bad = await edge.handle(get('/pay/' + line.Sub_Code + '/status'));
  assert.equal(bad.status, 404);
});

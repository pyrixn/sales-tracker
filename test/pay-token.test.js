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

function data(html) {
  const m = /<script type="application\/json" id="pay-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page carries its data block');
  return JSON.parse(m[1]);
}
async function hostWith(settings) {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  st.sales.forEach(s => { s.Pay_Token = s.Sub_Code ? 'TOK-' + s.Sub_Code + '-abcdefghijklmnop' : ''; });
  Object.assign(st.settings, settings || {});
  await seedDb(db, tables, st);
  return { st, db, tables, edge: loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } }) };
}
const post = (p, body) => new Request('http://x' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('pay page: ships the order and the enabled methods as data, not markup', async () => {
  const { st, edge } = await hostWith({ bkash_number: '01711223344', pay_methods: 'bkash,nagad,bank', nagad_number: '01811223344', bank_account_number: '123456' });
  const line = st.sales.find(s => s.Sub_Code);
  const html = await (await edge.handle(get('/pay/' + line.Pay_Token))).text();
  const d = data(html);
  assert.equal(d.ref, line.Sub_Code);
  assert.deepEqual(d.methods.map(m => [m.id, m.ready]), [['bkash', true], ['nagad', true], ['bank', true]]);
  assert.equal(d.intent, null);
  assert.equal(d.status.stage, 'created');
  assert.ok(html.includes('id="app"'));
  assert.ok(!html.includes('</script><script>alert'), 'data cannot close its own block');
});

test('pay page: a method with no number is listed but not ready; the default is bKash only', async () => {
  const { st, edge } = await hostWith({ bkash_number: '' });
  const line = st.sales.find(s => s.Sub_Code);
  const d = data(await (await edge.handle(get('/pay/' + line.Pay_Token))).text());
  assert.deepEqual(d.methods.map(m => [m.id, m.ready]), [['bkash', false]]);
});

test('pay page follows the reminder language setting', async () => {
  const { st, edge } = await hostWith({ language: 'bn' });
  const line = st.sales.find(s => s.Sub_Code);
  const html = await (await edge.handle(get('/pay/' + line.Pay_Token))).text();
  assert.ok(html.includes('lang="bn"'));
  assert.equal(data(html).t.chooseTitle, 'কীভাবে পেমেন্ট করবেন?');
});

test('POST /pay/<token>/intent stores the method and number, then the order is waiting', async () => {
  const { st, edge, tables } = await hostWith({ bkash_number: '01711223344' });
  const line = st.sales.find(s => s.Sub_Code);
  const res = await edge.handle(post('/pay/' + line.Pay_Token + '/intent', { method: 'bkash', number: '+8801911223344' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.intent, { method: 'bkash', number: '01911223344', claimed: false, trx: '' });
  assert.equal(body.status.stage, 'waiting');
  assert.equal(tables.pay_intents.size, 1);
  const again = await edge.handle(post('/pay/' + line.Pay_Token + '/intent', { method: 'bkash', number: '01911223344', claimed: true, trx: 'ABC123XY' }));
  assert.equal((await again.json()).status.stage, 'claimed');
  assert.equal(tables.pay_intents.size, 1, 'one row per token');
  const status = await (await edge.handle(get('/pay/' + line.Pay_Token + '/status'))).json();
  assert.equal(status.stage, 'claimed');
  assert.equal(status.paid, false);
});

test('POST /pay/<token>/intent refuses bad input and unknown tokens, without writing', async () => {
  const { st, edge, tables } = await hostWith({ bkash_number: '01711223344' });
  const line = st.sales.find(s => s.Sub_Code);
  const url = '/pay/' + line.Pay_Token + '/intent';
  const bad = [{ method: 'bkash', number: '12345' }, { method: 'paypal', number: '01711223344' }, { method: 'nagad', number: '01711223344' },
    { method: 'bkash', number: '01711223344', trx: '<script>' }];
  for (const b of bad) {
    const r = await edge.handle(post(url, b));
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal((await r.json()).ok, false);
  }
  assert.equal((await edge.handle(post('/pay/does-not-exist-0123456789/intent', { method: 'bkash', number: '01711223344' }))).status, 404);
  assert.equal((await edge.handle(post('/pay/' + line.Sub_Code + '/intent', { method: 'bkash', number: '01711223344' }))).status, 404, 'a sub code is not a token');
  assert.equal(tables.pay_intents.size, 0);
});

test('the order moves to received then confirmed when the payment arrives by number', async () => {
  const { st, edge, db } = await hostWith({ bkash_number: '01711223344' });
  const line = st.sales.find(s => s.Sub_Code);
  const price = Core.ledger.salePrice(line, st.products);
  await edge.handle(post('/pay/' + line.Pay_Token + '/intent', { method: 'bkash', number: '01911223344' }));
  const status = async () => (await edge.handle(get('/pay/' + line.Pay_Token + '/status'))).json();
  assert.equal((await status()).stage, 'waiting');
  // Sent from that number with no reference: found by number, amount covers the price.
  await db.query('INSERT INTO payment_inbox (received, type, method, sender, amount, transaction_id, counterparty, reference, status, raw_sms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['2099-01-01 10:00', 'Received', 'bKash', '16247', price, 'TRXNUM0001', '+8801911223344', '', 'Pending', 'sms']);
  assert.equal((await status()).stage, 'received');
  await db.query('UPDATE payment_inbox SET status = $1 WHERE transaction_id = $2', ['Matched', 'TRXNUM0001']);
  const final = await status();
  assert.equal(final.stage, 'confirmed');
  assert.equal(final.paid, true);
  assert.equal(final.until, line.Paid_Till);
});

test('a payment from another number, or for less than the price, does not move the order', async () => {
  const { st, edge, db } = await hostWith({ bkash_number: '01711223344' });
  const line = st.sales.find(s => s.Sub_Code);
  const price = Core.ledger.salePrice(line, st.products);
  await edge.handle(post('/pay/' + line.Pay_Token + '/intent', { method: 'bkash', number: '01911223344' }));
  const add = (trx, cp, amt) => db.query('INSERT INTO payment_inbox (received, type, method, sender, amount, transaction_id, counterparty, reference, status, raw_sms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['2099-01-01 10:00', 'Received', 'bKash', '16247', amt, trx, cp, '', 'Pending', 'sms']);
  await add('TRXOTHER01', '01555555555', price);
  await add('TRXSHORT01', '01911223344', price - 1);
  const stage = (await (await edge.handle(get('/pay/' + line.Pay_Token + '/status'))).json()).stage;
  assert.equal(stage, 'waiting');
});

// GET /portal/<pay token>: the customer portal through the real Edge router over the fake db. Token isolation (one customer's token
// never shows another's lines or payments), unknown tokens, no cost fields, the CSP header and no script, trust lines from settings,
// Bangla, escaping, and the per-client limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const TODAY = '2026-10-28';
const TOK_JAMIL = 'tokJAMILjamil000000';
const TOK_OTHER = 'tokOTHERother000000';

/** Two customers, each with an active line and a payment. Jamil owes money on his line; the other customer has paid. */
function portalState(opts) {
  const st = makeUiState();
  const jamil = st.customers.find(c => c.Name === 'jamilhq');
  const base = st.sales.find(s => s.Customer_ID === jamil.Customer_ID && s.Record_Status === 'Active') || st.sales[0];
  const maxId = Math.max(...st.sales.map(s => Number(s.Sale_ID)));
  const jamilSale = Object.assign({}, base, { Sale_ID: base.Sale_ID, Pay_Token: TOK_JAMIL, Record_Status: 'Active', Paid_Till: '2026-11-20', Cost_Snapshot: 31337 });
  st.sales = st.sales.map(s => (s.Sale_ID === base.Sale_ID ? jamilSale : s));
  const other = { Customer_ID: 'CZZ1', Name: opts && opts.otherName ? opts.otherName : 'Secret Buyer', Channel: 'Phone', Handle: '', Discord_User_ID: '', Notes: '', Created: '2026-10-01' };
  st.customers.push(other);
  st.sales.push(Object.assign({}, base, { Sale_ID: maxId + 1, Customer_ID: 'CZZ1', Customer: other.Name, Sub_Code: 'ZZ-1', Pay_Token: TOK_OTHER,
    Record_Status: 'Active', Paid_Till: '2026-12-01', Cost_Snapshot: 4242 }));
  st.payments.push({ Payment_ID: 'PZZ1', Date: '2026-10-05', Customer_ID: 'CZZ1', Sale_ID: maxId + 1, Amount: 300, Method: 'bKash', Transaction_ID: 'TRXZZ1', Source: 'Manual', Note: '' });
  return st;
}

async function host(opts) {
  const { db, tables } = makeFakeDb();
  const st = portalState(opts);
  await seedDb(db, tables, st);
  tables.settings.set('pay_base_url', 'https://pay.example');
  tables.settings.set('bkash_number', '01711114321');
  tables.settings.set('bkash_account_name', 'Example Shop');
  if (opts && opts.language) tables.settings.set('language', opts.language);
  const edge = loadEdge(db, { today: TODAY, env: {} });
  return { db, tables, edge };
}
let ipSeq = 0;
const ip = () => '198.51.100.' + (++ipSeq % 250);
async function portal(h, token, o) {
  const res = await h.edge.handle(new Request('https://api.example/functions/v1/api/portal/' + encodeURIComponent(token), {
    method: 'GET', headers: { 'cf-connecting-ip': (o && o.ip) || ip() } }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('the portal shows the customer subscriptions, amount owed, payment history and a pay link', async () => {
  const h = await host();
  const r = await portal(h, TOK_JAMIL);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type'), /text\/html/);
  assert.match(r.text, /jamilhq/);
  assert.match(r.text, /Subscriptions/);
  assert.match(r.text, /Amount owed/);
  assert.match(r.text, /Next renewal/);
  assert.match(r.text, /href="https:\/\/pay\.example\/pay\/tokJAMILjamil000000"/);
  assert.match(r.text, /Payment history/);
});

test('token isolation: each token shows only its own customer, and a name is escaped', async () => {
  const h = await host({ otherName: '<img src=x onerror=alert(1)>' });
  const jamil = await portal(h, TOK_JAMIL);
  const other = await portal(h, TOK_OTHER);
  assert.ok(!jamil.text.includes('Secret Buyer') && !jamil.text.includes('TRXZZ1') && !jamil.text.includes('ZZ-1'));
  assert.ok(!other.text.includes('jamilhq'), 'the other customer does not see jamil');
  assert.ok(other.text.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is escaped');
  assert.ok(!other.text.includes('<img'), 'no raw markup from the name');
  // The other customer's payment shows on their own page only.
  assert.match(other.text, /300/);
  assert.ok(!jamil.text.includes('৳300') && !jamil.text.includes('300.00'));
});

test('unknown and too-short tokens are a 404 with no customer data', async () => {
  const h = await host();
  const unknown = await portal(h, 'tokNOSUCHTOKEN000000');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, 'Payment link not found.');
  const short = await portal(h, 'short');
  assert.equal(short.status, 404);
  assert.ok(!short.text.includes('jamilhq'));
});

test('no cost, profit, supplier or USDT fields reach the portal', async () => {
  const h = await host();
  const r = await portal(h, TOK_JAMIL);
  assert.ok(!/cost|profit|supplier|usdt|buy_price|Account_ID|31337|4242/i.test(r.text), 'no cost fields');
});

test('the response carries the strict CSP, no-store, noindex, and the page runs no script', async () => {
  const h = await host();
  const r = await portal(h, TOK_JAMIL);
  const csp = r.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('X-Robots-Tag'), 'noindex');
  assert.ok(!/<script/i.test(r.text), 'no script');
  assert.ok(!/src=|<link|@import/i.test(r.text), 'no external assets');
});

test('trust lines: never a PIN or OTP request, and the receiver last 4 digits and name from settings', async () => {
  const h = await host();
  const r = await portal(h, TOK_JAMIL);
  assert.match(r.text, /We never ask for your PIN or OTP\./);
  assert.match(r.text, /The confirm screen should show: Example Shop, number ending 4321\./);
});

test('Bangla when the language setting is bn, English otherwise', async () => {
  const bn = await portal(await host({ language: 'bn' }), TOK_JAMIL);
  assert.match(bn.text, /<html lang="bn">/);
  assert.match(bn.text, /আপনার সাবস্ক্রিপশন/);
  assert.match(bn.text, /আমরা কখনো আপনার PIN বা OTP চাই না/);
  const en = await portal(await host(), TOK_JAMIL);
  assert.match(en.text, /<html lang="en">/);
});

test('the portal is rate limited per client; a 31st request in a minute gets a 429', async () => {
  const h = await host();
  const client = '203.0.113.' + (++ipSeq);
  let last = null;
  for (let i = 0; i < 31; i++) last = await portal(h, TOK_JAMIL, { ip: client });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('Retry-After'));
  const other = await portal(h, TOK_JAMIL, { ip: '203.0.113.' + (++ipSeq) });
  assert.equal(other.status, 200, 'another client is not blocked');
});

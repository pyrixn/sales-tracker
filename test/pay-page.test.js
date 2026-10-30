// Task 5: the redesigned pay page, checked through the real edge host's rendered HTML (no DOM library is available;
// the page's behaviour in a browser is covered by the Playwright smoke in test/ui/app.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const get = path => new Request('https://x.test/functions/v1/api' + path);
const post = (p, body) => new Request('http://x' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function data(html) {
  const m = /<script type="application\/json" id="pay-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page carries its data block');
  return JSON.parse(m[1]);
}
const scriptOf = html => /<script>\(([\s\S]*?)\)\(\);<\/script>/.exec(html)[1];
const pageOf = async (edge, token) => (await edge.handle(get('/pay/' + token))).text();

async function reqHost(settings) {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  st.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  st.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-PAGE-7788', Status: 'Available' });
  Object.assign(st.settings, { bkash_number: '01711223344', tos_text: 'No refunds after delivery.', review_discord_url: 'https://discord.gg/abc', review_facebook_url: 'https://facebook.com/shop' }, settings || {});
  st.sales.forEach(s => { s.Pay_Token = s.Sub_Code ? 'TOK-' + s.Sub_Code + '-abcdefghijklmnop' : ''; });
  await seedDb(db, tables, st);
  const edge = loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } });
  const made = await edge.api('createPayRequest', { requestId: 'pg1', title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Rafi' });
  assert.equal(made.ok, true, made.error);
  return { st, edge, tables, token: made.data.token };
}

test('page: one style block, one inline script, and nothing that parses markup', async () => {
  const { st, edge, token } = await reqHost();
  const html = await pageOf(edge, token);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<script /g) || []).length, 1, 'plus the JSON data block');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc']) {
    assert.ok(!html.includes(bad), bad + ' must not appear on the pay page');
  }
  assert.ok(!/<(img|iframe|link|object|embed)[\s>]/i.test(html), 'no extra resources, so the CSP needs nothing more');
  assert.ok(!/https?:\/\//.test(scriptOf(html).replace(/'https:\/\/'/g, '')), 'the script names no origin');
  const line = st.sales.find(s => s.Sub_Code);
  assert.ok(!(await pageOf(edge, line.Pay_Token)).includes('innerHTML'), 'the subscription page too');
});

test('page: data names the order, kind, expiry and delivery, and never the code', async () => {
  const { st, edge, token } = await reqHost();
  const open = await pageOf(edge, token);
  const d = data(open);
  assert.deepEqual([d.kind, d.title, d.customerName, d.ref, d.amount, d.status.stage, d.status.delivery], ['request', 'Gift card', 'Rafi', 'R1', 500, 'created', '']);
  assert.ok(Date.parse(d.expires) > Date.now());
  assert.ok(Math.abs(d.now - Date.now()) < 60000);
  assert.ok(!open.includes('SECRET-PAGE-7788'));
  const g = await edge.api('gotPaidRequest', { requestId: 'pg2', id: 'R1', trx: 'PGTRX001', method: 'bKash', amount: 500 });
  assert.equal(g.ok, true, g.error);
  const paid = await pageOf(edge, token);
  assert.ok(!paid.includes('SECRET-PAGE-7788'), 'even a confirmed page carries no code in its markup or data');
  assert.deepEqual([data(paid).status.stage, data(paid).status.delivery], ['confirmed', 'delivered']);
  assert.ok(!(await (await edge.handle(get('/pay/' + token + '/status'))).text()).includes('SECRET-PAGE-7788'));
  assert.equal((await (await edge.handle(get('/pay/' + token + '/receipt'))).json()).code, 'SECRET-PAGE-7788', 'only the receipt fetch has it');
  const line = st.sales.find(s => s.Sub_Code);
  assert.equal(data(await pageOf(edge, line.Pay_Token)).kind, 'sale', 'a subscription link is still a sale page');
});

test('page: expired and cancelled links show their stage; the script hides payment steps for them', async () => {
  const { edge, token, tables } = await reqHost();
  tables.pay_requests.get('R1').expires = new Date(Date.now() - 60000).toISOString();
  const exp = await pageOf(edge, token);
  assert.equal(data(exp).status.stage, 'expired');
  const made = await edge.api('createPayRequest', { requestId: 'pg3', title: 'Other', amount: 90 });
  await edge.api('cancelPayRequest', { requestId: 'pg4', id: 'R2' });
  assert.equal(data(await pageOf(edge, made.data.token)).status.stage, 'cancelled');
  const d = data(exp);
  for (const lang of ['en', 'bn']) {
    for (const k of ['tExpired', 'tCancelled', 'mExpired', 'mCancelled']) assert.ok(String(d.all[lang][k]).length > 5, lang + '.' + k);
  }
  assert.match(d.all.en.mExpired, /contact the seller/i);
  assert.match(d.all.en.mCancelled, /contact the seller/i);
  const js = scriptOf(exp);
  assert.ok(js.includes('expired: T.mExpired') && js.includes('cancelled: T.mCancelled'), 'a message per closed stage');
  for (const lang of ['en', 'bn']) assert.ok(String(d.all[lang].mClosed).length > 5, lang + '.mClosed');
  assert.ok(js.includes("sg === 'confirmed' ? T.m3") && js.includes('T.mClosed'), 'a Paid link is not shown as cancelled');

  assert.ok(/else if \(!closed\(\)\)\s*\{\s*app\.appendChild\(chooser\(\)\)/.test(js), 'method tiles and steps only render while the link is open');
  assert.equal((await edge.handle(post('/pay/' + token + '/intent', { method: 'bkash', number: '01911223344' }))).status, 400, 'a stale tab cannot reopen it');
});

test('page: every label has a Bangla string, and every label the script uses exists', async () => {
  const { edge, token } = await reqHost();
  const html = await pageOf(edge, token);
  const d = data(html);
  const en = Object.keys(d.all.en).sort(), bn = Object.keys(d.all.bn).sort();
  assert.deepEqual(bn, en, 'EN and BN dictionaries have the same keys');
  const ph = s => (String(s).match(/\{\w+\}/g) || []).sort().join();
  en.forEach(k => {
    assert.ok(String(d.all.en[k]).length && String(d.all.bn[k]).length, k);
    if (!['numberPlaceholder', 'cdH', 'cdM', 'cdS'].includes(k)) assert.notEqual(d.all.bn[k], d.all.en[k], k + ' is translated');
    assert.equal(ph(d.all.bn[k]), ph(d.all.en[k]), k + ' keeps its placeholders');
  });
  const js = scriptOf(html), used = new Set();
  let m;
  const re = /\bT\.(\w+)/g;
  while ((m = re.exec(js))) used.add(m[1]);
  ['t0', 't1', 't2', 't3', 'm1', 'm1b'].forEach(k => used.add(k));
  used.forEach(k => assert.ok(en.includes(k), 'T.' + k + ' is defined'));
  assert.ok(js.includes('setLang') && js.includes('document.documentElement.lang = st.lang'), 'language toggle');
  assert.deepEqual(d.t, d.all.en, 'the page opens in the settings language');
});

test('page: poll backs off 5s 10s 20s 30s, resets on change or action, and pauses while hidden', async () => {
  const { edge, token } = await reqHost();
  const js = scriptOf(await pageOf(edge, token));
  assert.ok(js.includes('[5000, 10000, 20000, 30000]'));
  assert.ok(js.includes('POLL[Math.min(step, POLL.length - 1)]'), 'stays at 30s');
  assert.ok(js.includes('visibilitychange'));
  assert.ok(/if \(document\.hidden \|\| settled\(\)\) return;/.test(js), 'no timer while hidden');
  assert.ok(/if \(document\.hidden\) \{ clearTimeout\(pollTimer\)/.test(js) && /step = 0; poll\(\);/.test(js), 'one immediate poll when visible again');
  assert.ok(js.includes('function restart() { step = 0; schedule(); }') && /render\(\); restart\(\);/.test(js), 'a user action resets to 5s');
  assert.ok(/step = 0; render\(\);/.test(js), 'a stage change resets to 5s');
  assert.ok(!js.includes('setInterval(poll'), 'no fixed-rate poll');
  assert.ok(js.includes("BASE + '/receipt'") && js.includes("BASE + '/status'") && js.includes("BASE + '/intent'"), 'only its own routes');
});

test('page: review links need https, open safely, and the receipt route drops other schemes', async () => {
  const bad = await reqHost({ review_discord_url: 'javascript:alert(1)', review_facebook_url: 'http://facebook.com/shop' });
  await bad.edge.api('gotPaidRequest', { requestId: 'pg5', id: 'R1', trx: 'PGTRX002', method: 'bKash', amount: 500 });
  const rc = await (await bad.edge.handle(get('/pay/' + bad.token + '/receipt'))).json();
  assert.deepEqual(rc.links, []);
  assert.equal(rc.code, 'SECRET-PAGE-7788');
  const js = scriptOf(await pageOf(bad.edge, bad.token));
  assert.ok(js.includes("l.url.indexOf('https://') === 0"), 'the client re-checks the scheme');
  assert.ok(js.includes("a.rel = 'noopener noreferrer'") && js.includes("a.target = '_blank'"));
  assert.ok(js.includes('a.href = l.url'), 'the url goes to href only, never into markup');
  const good = await reqHost();
  await good.edge.api('gotPaidRequest', { requestId: 'pg6', id: 'R1', trx: 'PGTRX003', method: 'bKash', amount: 500 });
  const links = (await (await good.edge.handle(get('/pay/' + good.token + '/receipt'))).json()).links;
  assert.deepEqual(links.map(l => l.url), ['https://discord.gg/abc', 'https://facebook.com/shop']);
});

test('page: receipt and delivered panels have copy and print; dark mode and reduced motion are in the stylesheet', async () => {
  const { edge, token } = await reqHost();
  const html = await pageOf(edge, token);
  const js = scriptOf(html);
  assert.ok(js.includes('window.print()'));
  for (const k of ['T.rCopy', 'T.rPrint', 'T.dCode', 'T.dTos', 'T.dPending', 'T.dFailed']) assert.ok(js.includes(k), k);
  assert.match(data(html).all.en.dPending, /Payment confirmed — your seller will deliver your order shortly/);
  assert.ok(/prefers-color-scheme:dark/.test(html));
  assert.ok(/prefers-reduced-motion:reduce/.test(html));
  for (const cls of ['.m-bkash', '.m-nagad', '.m-upay', '.m-bank']) assert.ok(html.includes(cls), cls);
});

test('page: delivered seat, retry, closed-link errors, copy fallback, language memory and system fonts', async () => {
  const { edge, token } = await reqHost();
  const html = await pageOf(edge, token);
  const js = scriptOf(html);
  assert.match(data(html).all.en.dDelivered, /^Delivered/);
  assert.ok(js.includes('T.dDelivered'), 'delivered without a code says check your messages');
  assert.ok(js.includes('if (!st.rcpt && st.rcptTries < 4) return false;'), 'a failed receipt fetch keeps polling and retries, capped');
  assert.ok(/expired\/i\.test\(why\) \? T\.mExpired/.test(js) && /render\(\); step = 0; poll\(\);/.test(js), 'closed link errors are localized and re-poll');
  assert.ok(js.includes('.then(done, fallback)') && js.includes('a.readOnly = true') && js.includes("a.className = 'offscreen'"), 'copy falls back when the clipboard rejects');
  assert.ok(js.includes("localStorage.setItem('payLang', l)") && js.includes("localStorage.getItem('payLang')"), 'language is remembered');
  assert.ok(js.includes('dateStyle') && !js.includes("toLocaleString(st.lang === 'bn' ? 'bn-BD' : 'en-GB')"), 'one time format');
  for (const f of ['Fraunces', 'Bricolage', 'JetBrains']) assert.ok(!html.includes(f), f + ' cannot load under the CSP');
});

test('pay page: the stored language is accepted only when it is en or bn', async () => {
  const { edge, token } = await reqHost();
  assert.match(scriptOf(await pageOf(edge, token)), /saved === 'en' \|\| saved === 'bn'/);
});

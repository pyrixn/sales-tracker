const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const P = () => Core.paylinks;

test('numbers are normalised from any Bangladesh spelling and refused otherwise', () => {
  for (const v of ['01711223344', '+8801711223344', '8801711223344', ' 017-1122 3344 ']) assert.equal(P().normalizeNumber(v), '01711223344', v);
  for (const v of ['', '12345', '0171122334', '017112233445', '02711223344', 'abc']) assert.equal(P().normalizeNumber(v), '', v);
  assert.deepEqual(P().numberForms('01711223344'), ['01711223344', '+8801711223344', '8801711223344']);
  assert.deepEqual(P().numberForms('nope'), []);
});

test('methods: bKash by default, fixed order, ready only when the number or account is set', () => {
  assert.deepEqual(P().methods({ bkash_number: '01711223344' }).map(m => [m.id, m.ready]), [['bkash', true]]);
  const m = P().methods({ pay_methods: 'bank, upay,bkash,junk', bkash_number: '', upay_number: '01911223344', bank_account_number: '' });
  assert.deepEqual(m.map(x => [x.id, x.ready]), [['bkash', false], ['upay', true], ['bank', false]]);
  assert.deepEqual(P().methods({ pay_methods: '' }), [], 'an empty list enables nothing');
  const bank = P().methods({ pay_methods: 'bank', bank_name: 'City', bank_account_name: 'Nadif', bank_account_number: '1234', bank_branch: 'Dhaka', bank_note: 'Use remarks' })[0];
  assert.deepEqual([bank.bankName, bank.accountName, bank.accountNumber, bank.branch, bank.note, bank.ready], ['City', 'Nadif', '1234', 'Dhaka', 'Use remarks', true]);
});

test('planIntent accepts an enabled method with a valid number and claims', () => {
  const s = { pay_methods: 'bkash,nagad', bkash_number: '01711223344' };
  assert.deepEqual(P().planIntent(s, { method: 'BKASH', number: '+8801911223344' }).values,
    { Method: 'bkash', Payer_Number: '01911223344', Claim_Trx: '', Claimed: '' });
  assert.deepEqual(P().planIntent(s, { method: 'nagad', number: '01911223344', claimed: true, trx: ' ab12 ' }).values,
    { Method: 'nagad', Payer_Number: '01911223344', Claim_Trx: 'ab12', Claimed: 'Yes' });
  assert.ok(P().planIntent(s, { method: 'upay', number: '01911223344' }).error, 'method not enabled');
  assert.ok(P().planIntent(s, { method: 'bkash', number: '123' }).error, 'bad number');
  assert.ok(P().planIntent(s, { method: 'bkash', number: '01911223344', trx: '<b>' }).error, 'bad transaction id');
});

test('orderStatus: created, waiting, claimed, received and confirmed, by reference or by number', () => {
  const intent = { Method: 'bkash', Payer_Number: '01911223344', Created: '2026-10-18 09:00', Claimed: '' };
  const row = (o) => Object.assign({ Type: 'Received', Amount: 300, Received: '2026-10-18 10:00', Status: 'Pending', Reference: '', Counterparty: '' }, o);
  assert.equal(P().orderStatus('N46', 300, null, []).stage, 'created');
  assert.equal(P().orderStatus('N46', 300, intent, []).stage, 'waiting');
  assert.equal(P().orderStatus('N46', 300, Object.assign({}, intent, { Claimed: 'Yes' }), []).stage, 'claimed');
  assert.equal(P().orderStatus('N46', 300, null, [row({ Reference: 'n46' })]).stage, 'received', 'reference matches without an intent, any case');
  assert.equal(P().orderStatus('N46', 300, intent, [row({ Counterparty: '+8801911223344' })]).stage, 'received');
  assert.equal(P().orderStatus('N46', 300, intent, [row({ Counterparty: '01911223344', Status: 'Matched' })]).stage, 'confirmed');
  // Not this order: another number, too little, sent before the link was used, or not a received payment.
  for (const r of [row({ Counterparty: '01555555555' }), row({ Counterparty: '01911223344', Amount: 299 }), row({ Counterparty: '01911223344', Received: '2026-10-17 10:00' }), row({ Counterparty: '01911223344', Type: 'Unrecognised' })]) {
    assert.equal(P().orderStatus('N46', 300, intent, [r]).stage, 'waiting', JSON.stringify(r));
  }
});

test('list: one row per live line, needs-attention first, counts links still to generate', () => {
  const m = makeMigratedState();
  m.settings.pay_methods = 'bkash,bank';
  const sales = m.sales.filter(s => s.Sub_Code && s.Record_Status === 'Active');
  const one = sales[0], two = sales[1];
  m.sales.forEach(s => { s.Pay_Token = ''; });
  one.Pay_Token = 'TOKEN-ONE-aaaaaaaaaaaaaaaa';
  two.Pay_Token = 'TOKEN-TWO-aaaaaaaaaaaaaaaa';
  m.payIntents = [{ Token: two.Pay_Token, Method: 'bkash', Payer_Number: '01911223344', Claim_Trx: 'X1', Claimed: 'Yes', Created: '2026-10-18 09:00', Updated: '2026-10-18 09:05' }];
  const out = P().list(m);
  assert.deepEqual(out.methods.map(x => x.id), ['bkash', 'bank']);
  assert.equal(new Set(out.rows.map(r => r.subCode)).size, out.rows.length, 'one row per line');
  assert.equal(out.rows[0].token, two.Pay_Token, 'a claimed order comes first');
  assert.equal(out.rows[0].stage, 'claimed');
  assert.equal(out.rows[0].payer, '01911223344');
  assert.equal(out.rows[0].claimTrx, 'X1');
  assert.equal(out.rows.find(r => r.token === one.Pay_Token).stage, 'created');
  const without = out.rows.filter(r => !r.token);
  assert.ok(without.length > 0 && without.every(r => r.stage === 'none'));
  assert.equal(out.missing, without.length);
  assert.ok(out.rows.every(r => r.price >= 0 && r.owes >= 0));
});

test('settings: pay methods and wallet numbers are validated', () => {
  const m = makeMigratedState();
  const ok = Core.sales.planSettings(m, { pay_methods: 'bkash,nagad,bank', nagad_number: '01811223344', upay_number: '', bank_name: 'City Bank' });
  assert.deepEqual(ok.errors, []);
  assert.ok(Core.sales.planSettings(m, { pay_methods: 'bkash,paypal' }).errors[0].includes('paypal'));
  assert.ok(Core.sales.planSettings(m, { nagad_number: '12345' }).errors[0].includes('Nagad'));
  assert.ok(Core.sales.planSettings(m, { upay_number: 'abc' }).errors[0].includes('Upay'));
});

test('verification: bKash is automatic by default; Nagad and bank are by hand until the owner says otherwise', () => {
  const s = { pay_methods: 'bkash,nagad,upay,bank', bkash_number: '01711223344', nagad_number: '01811223344', upay_number: '01911223344', bank_account_number: '1' };
  assert.deepEqual(P().methods(s).map(m => [m.id, m.auto]), [['bkash', true], ['nagad', false], ['upay', false], ['bank', false]]);
  const set = Object.assign({ pay_auto_verify: 'bkash,upay,bank' }, s);
  assert.deepEqual(P().methods(set).map(m => [m.id, m.auto]), [['bkash', true], ['nagad', false], ['upay', true], ['bank', false]], 'a bank transfer is never automatic');
});

test('a manual method needs a transaction id with "I have paid"; an automatic one does not', () => {
  const s = { pay_methods: 'bkash,nagad,bank', pay_auto_verify: 'bkash', bkash_number: '01711223344', nagad_number: '01811223344', bank_account_number: '1' };
  const claim = (method, trx) => P().planIntent(s, { method, number: '01911223344', claimed: true, trx });
  assert.ok(claim('nagad', '').error.includes('transaction ID'));
  assert.ok(claim('bank', '  ').error.includes('transaction ID'));
  assert.equal(claim('nagad', 'NG123456').values.Claimed, 'Yes');
  assert.equal(claim('bkash', '').values.Claimed, 'Yes');
  assert.equal(P().planIntent(s, { method: 'nagad', number: '01911223344' }).values.Claimed, '', 'choosing a method needs no id');
});

test('a payment the owner records by hand confirms a claimed order', () => {
  const intent = { Method: 'nagad', Payer_Number: '01911223344', Created: '2026-10-18 09:00', Claimed: 'Yes', Claim_Trx: 'ng123456' };
  const pay = o => Object.assign({ Date: '2026-10-18', Amount: 300, Transaction_ID: '' }, o);
  assert.equal(P().orderStatus('N46', 300, intent, [], []).stage, 'claimed');
  assert.equal(P().orderStatus('N46', 300, intent, [], [pay({ Transaction_ID: 'NG123456' })]).stage, 'confirmed', 'same transaction id, any case');
  assert.equal(P().orderStatus('N46', 300, intent, [], [pay({ Date: '2026-10-19' })]).stage, 'confirmed', 'recorded for this line after the claim');
  assert.equal(P().orderStatus('N46', 300, intent, [], [pay({ Date: '2026-10-01' })]).stage, 'claimed', 'an older payment is not this order');
  assert.equal(P().orderStatus('N46', 300, Object.assign({}, intent, { Claimed: '' }), [], [pay({})]).stage, 'waiting', 'no claim, no date rule: a same-day payment from the sale itself is not enough');
});

test('settings: pay_auto_verify takes wallet methods only', () => {
  const m = makeMigratedState();
  assert.deepEqual(Core.sales.planSettings(m, { pay_auto_verify: 'bkash,upay' }).errors, []);
  assert.ok(Core.sales.planSettings(m, { pay_auto_verify: 'bkash,bank' }).errors[0].includes('Bank'));
  assert.ok(Core.sales.planSettings(m, { pay_auto_verify: 'cash' }).errors[0].includes('cash'));
  assert.deepEqual(Core.sales.planSettings(m, { bank_routing: '170272689' }).errors, []);
});

test('settings: delivery fields validate https links and expiry hours', () => {
  const m = makeMigratedState();
  assert.deepEqual(Core.sales.planSettings(m, { review_discord_url: 'https://discord.gg/x', review_facebook_url: '', tos_text: 'T', delivery_note: 'N', pay_link_expiry_hours: '24' }).errors, []);
  assert.ok(Core.sales.planSettings(m, { review_discord_url: 'http://x' }).errors[0].includes('Discord'));
  assert.ok(Core.sales.planSettings(m, { review_facebook_url: 'javascript:alert(1)' }).errors[0].includes('Facebook'));
  ['0', '721', '1.5', 'abc', ''].forEach(h => assert.ok(Core.sales.planSettings(m, { pay_link_expiry_hours: h }).errors[0].includes('1 to 720'), h));
  ['1', '720'].forEach(h => assert.deepEqual(Core.sales.planSettings(m, { pay_link_expiry_hours: h }).errors, []));
});

test('settings: review links are stored trimmed and must have a host', () => {
  const m = makeMigratedState();
  const padded = Core.sales.planSettings(m, { review_discord_url: '  https://discord.gg/x  ', review_facebook_url: ' https://facebook.com/p ', pay_link_expiry_hours: ' 24 ' });
  assert.deepEqual(padded.errors, []);
  const byKey = {};
  padded.ops.forEach(o => { byKey[o.id] = o.values.Value; });
  assert.equal(byKey.review_discord_url, 'https://discord.gg/x');
  assert.equal(byKey.review_facebook_url, 'https://facebook.com/p');
  assert.equal(byKey.pay_link_expiry_hours, '24');
  assert.ok(Core.sales.planSettings(m, { review_discord_url: 'https://' }).errors[0].includes('Discord'));
  assert.ok(Core.sales.planSettings(m, { review_facebook_url: 'https:// evil' }).errors[0].includes('Facebook'));
});

// The status poll: an ETag over stage, rows and until, 304 while unchanged, and the page script that polls with it.
const get = (p, headers) => new Request('https://x.test/functions/v1/api' + p, { headers: headers || {} });
async function payHost() {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  st.products.push({ Product_ID: 'GC', Product_Name: 'Gift card', Category: 'Game Code', Delivers_As: 'code', Letter: 'G', Default_Price: 500, Unit_Cost: 400, Active: 'Yes' });
  st.codes.push({ Code_ID: 'GC-0001', Product_ID: 'GC', Code: 'SECRET-POLL-1', Status: 'Available' });
  Object.assign(st.settings, { bkash_number: '01711223344' });
  await seedDb(db, tables, st);
  const edge = loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } });
  const made = await edge.api('createPayRequest', { requestId: 'poll1', title: 'Gift card', amount: 500, productId: 'GC', customerName: 'Rafi' });
  assert.equal(made.ok, true, made.error);
  return { edge, token: made.data.token, tables };
}

test('status: 304 with no body while the stage is unchanged, 200 with a new ETag after a stage change', async () => {
  const { edge, token } = await payHost();
  const first = await edge.handle(get('/pay/' + token + '/status'));
  assert.equal(first.status, 200);
  const body = await first.json();
  const etag = first.headers.get('etag');
  assert.match(etag, new RegExp('^W/"' + body.stage + '\|' + body.rows.length + '\|' + (body.until || '') + '\|' + (body.delivery || '') + '\|[0-9a-z]+"$'));
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(body).includes('SECRET-POLL-1'), 'the status never carries a code');

  const same = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }));
  assert.equal(same.status, 304);
  assert.equal(await same.text(), '');
  assert.equal(same.headers.get('etag'), etag);
  assert.equal(same.headers.get('cache-control'), 'no-store');

  const paid = await edge.api('gotPaidRequest', { requestId: 'poll2', id: 'R1', trx: 'PGTRX002', method: 'bKash', amount: 500 });
  assert.equal(paid.ok, true, paid.error);
  const changed = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }));
  assert.equal(changed.status, 200, 'a stage change is not unchanged');
  assert.equal((await changed.json()).stage, 'confirmed');
  assert.notEqual(changed.headers.get('etag'), etag);
});

test('status: a delivery change alone (Pending to Delivered, stage still confirmed) is a 200 with a new ETag', async () => {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  st.products.push({ Product_ID: 'SEAT', Product_Name: 'Seat thing', Category: 'Streaming', Delivers_As: 'account', Letter: 'S', Default_Price: 300, Billing_Cycle_Days: 30, Active: 'Yes' });
  st.accounts.push({ Account_ID: 'SEAT-01', Product_ID: 'SEAT', Slots: 4, Account_Status: 'Active', Cost_Per_Slot: 100, Cycle_Cost: 400 });
  Object.assign(st.settings, { bkash_number: '01711223344' });
  await seedDb(db, tables, st);
  const edge = loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } });
  const made = await edge.api('createPayRequest', { requestId: 'dl1', title: 'Seat', amount: 300, productId: 'SEAT', customerName: 'Rafi' });
  assert.equal(made.ok, true, made.error);
  const token = made.data.token;
  const paid = await edge.api('gotPaidRequest', { requestId: 'dl2', id: 'R1', trx: 'DLTRX001', method: 'bKash', amount: 300 });
  assert.equal(paid.ok, true, paid.error);

  const first = await edge.handle(get('/pay/' + token + '/status'));
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.stage, 'confirmed');
  assert.equal(body.delivery, 'pending');
  const etag = first.headers.get('etag');
  assert.match(etag, new RegExp('^W/"confirmed\|' + body.rows.length + '\|' + (body.until || '') + '\|pending\|[0-9a-z]+"$'));

  const same = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }));
  assert.equal(same.status, 304, 'nothing changed: still unchanged');

  const [deliveryId] = Array.from(tables.deliveries.entries()).find(([, d]) => Object.values(d).includes('R1'));
  const sd = await edge.api('setDelivery', { requestId: 'dl3', id: deliveryId, status: 'Delivered' });
  assert.equal(sd.ok, true, sd.error);

  const after = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }));
  assert.equal(after.status, 200, 'a delivery change is not unchanged');
  const afterBody = await after.json();
  assert.equal(afterBody.stage, 'confirmed');
  assert.equal(afterBody.delivery, 'delivered');
  assert.ok(!JSON.stringify(afterBody).includes('SECRET'), 'no code in the status');
  assert.notEqual(after.headers.get('etag'), etag);
  assert.match(after.headers.get('etag'), /^W\/"confirmed\|\d+\|[^|]*\|delivered\|[0-9a-z]+"$/);

  const again = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': after.headers.get('etag') }));
  assert.equal(again.status, 304, 'unchanged after the delivery change');
});

test('HTML and receipt answers carry no ETag', async () => {
  const { edge, token } = await payHost();
  const page = await edge.handle(get('/pay/' + token));
  assert.equal(page.headers.get('etag'), null);
  const rc = await edge.handle(get('/pay/' + token + '/receipt'));
  assert.equal(rc.headers.get('etag'), null);
});

test('page script: backoff 5, 10, 20, 30 then 30 seconds, a visibility handler that polls at once and resets, and 304 as unchanged', async () => {
  const { edge, token } = await payHost();
  const html = await (await edge.handle(get('/pay/' + token))).text();
  const s = /<script>\(([\s\S]*?)\)\(\);<\/script>/.exec(html)[1];
  assert.ok(s.includes('[5000, 10000, 20000, 30000]'), 'the poll schedule');
  assert.ok(s.includes('POLL[Math.min(step, POLL.length - 1)]'), 'the schedule holds the last delay');
  const vis = /addEventListener\('visibilitychange', function \(\) \{([\s\S]*?)\n  \}\);/.exec(s);
  assert.ok(vis, 'the visibility handler');
  assert.ok(vis[1].includes('document.hidden'), 'paused while hidden');
  assert.ok(/step = 0;\s*poll\(\);/.test(vis[1]), 'shown: reset the backoff and poll once at once');
  assert.ok(/r\.status === 304/.test(s), 'a 304 is read as unchanged');
  assert.ok(s.includes("'If-None-Match'"), 'the page sends its ETag back');
  assert.ok(/catch\(function \(\) \{ step\+\+; \}\)\.then\(schedule\)/.test(s), 'a network error still schedules the next poll');
});

test('status: a payment edit that keeps the row count changes the ETag; unchanged stays 304', async () => {
  const { edge, token, tables } = await payHost();
  tables.payment_inbox.set('ETTRX001', { transaction_id: 'ETTRX001', reference: 'r1', type: 'Received', amount: 500, status: 'Pending', received: '2026-10-24 10:05' });
  const first = await edge.handle(get('/pay/' + token + '/status'));
  const etag = first.headers.get('etag');
  const n = (await first.json()).rows.length;
  assert.equal(n, 1);
  assert.equal((await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }))).status, 304);
  tables.payment_inbox.get('ETTRX001').amount = 450;
  const after = await edge.handle(get('/pay/' + token + '/status', { 'If-None-Match': etag }));
  assert.equal(after.status, 200, 'an amount edit with the same count is not unchanged');
  assert.equal((await after.json()).rows.length, n);
  assert.notEqual(after.headers.get('etag'), etag);
});

// An amount is the only thing a link needs: no title, customer or product. A clashing typed name comes back tagged.
test('edge: createPayRequest with an amount alone makes a link titled Payment; a clashing typed name is tagged', async () => {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  Object.assign(st.settings, { bkash_number: '01711223344', pay_base_url: 'https://shop.example' });
  await seedDb(db, tables, st);
  const edge = loadEdge(db, { env: { APP_SECRET: 'a', RELAY_TOKEN: 'b' } });
  const made = await edge.api('createPayRequest', { requestId: 'amt1', amount: 500 });
  assert.equal(made.ok, true, made.error);
  assert.match(made.data.url, /^https:\/\/shop\.example\/pay\/[A-Za-z0-9_-]+$/);
  const row = ((await edge.api('payRequests', {})).data.rows || []).find(r => r.id === made.data.requestId);
  assert.ok(row, 'the link is listed');
  assert.equal(row.title, 'Payment');
  assert.equal(Number(row.amount), 500);
  const clash = await edge.api('createPayRequest', { requestId: 'amt2', amount: 500, customerName: st.customers[0].Name.toUpperCase() });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'customer_name_taken');
  assert.match(clash.error, /Pick them from the list/);
});

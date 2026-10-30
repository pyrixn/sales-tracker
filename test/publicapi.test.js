// Core.publicapi: the pure rules of the public API. Crypto is checked against Node's own implementation and published vectors;
// projections are checked by what they must never contain (cost, code, supplier and account fields).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Core } = require('./load-core');

const P = Core.publicapi;
const bytes = n => new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256);

test('SHA-256 matches the published vectors and Node for every length near a block boundary', () => {
  assert.equal(P.hex(P.sha256(P.utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(P.hex(P.sha256(P.utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(P.hex(P.sha256(P.utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  for (let n = 0; n <= 300; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(P.hex(P.sha256(new Uint8Array(b))), crypto.createHash('sha256').update(b).digest('hex'), 'length ' + n);
  }
});

test('HMAC-SHA256 matches RFC 4231 test cases 1, 2 and 6 (a key longer than the block)', () => {
  assert.equal(P.hex(P.hmacSha256(new Uint8Array(20).fill(0x0b), P.utf8('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(P.hex(P.hmacSha256(P.utf8('Jefe'), P.utf8('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(P.hex(P.hmacSha256(new Uint8Array(131).fill(0xaa), P.utf8('Test Using Larger Than Block-Size Key - Hash Key First'))),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
});

test('webhook signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>, the same as Node for a fixed vector', () => {
  const body = '{"a":1}';
  const want = crypto.createHmac('sha256', 'whsec_test').update('1700000000.' + body).digest('hex');
  assert.equal(P.signatureHeader('whsec_test', 1700000000, body), 't=1700000000,v1=' + want);
  assert.equal(P.signatureHeader('whsec_test', 1700000000, body), 't=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789');
});

test('verifySignature: accepts the right secret and body, refuses stale, tampered, wrong-secret and malformed headers', () => {
  const body = '{"id":"e1","type":"order.created"}';
  const now = 1700000100;
  const h = P.signatureHeader('whsec_a', now, body);
  assert.deepEqual(P.verifySignature('whsec_a', h, body, now), { ok: true });
  assert.equal(P.verifySignature('whsec_a', h, body + ' ', now).reason, 'mismatch');
  assert.equal(P.verifySignature('whsec_b', h, body, now).reason, 'mismatch');
  assert.equal(P.verifySignature('whsec_a', h, body, now + P.SIG_TOLERANCE_S + 1).reason, 'stale');
  assert.deepEqual(P.verifySignature('whsec_a', h, body, now + P.SIG_TOLERANCE_S), { ok: true }, 'the tolerance edge is still accepted');
  assert.equal(P.verifySignature('whsec_a', 'v1=abc', body, now).reason, 'bad_format');
  assert.equal(P.verifySignature('whsec_a', 't=x,v1=abc', body, now).reason, 'bad_format');
  assert.equal(P.verifySignature('whsec_a', undefined, body, now).reason, 'bad_format');
});

test('verifySignature accepts any v1 value (a secret being rotated sends two)', () => {
  const body = '{}', now = 1700000000;
  const good = P.signatureHeader('whsec_new', now, body).split('v1=')[1];
  const header = 't=' + now + ',v1=' + 'ab'.repeat(32) + ',v1=' + good;
  assert.deepEqual(P.verifySignature('whsec_new', header, body, now), { ok: true });
});

test('timingSafeEqual: equal strings match, different strings and lengths do not', () => {
  assert.equal(P.timingSafeEqual('abc', 'abc'), true);
  assert.equal(P.timingSafeEqual('abc', 'abd'), false);
  assert.equal(P.timingSafeEqual('abc', 'abcd'), false);
});

test('keys: st_live_ plus 32 base62 characters from random bytes; too few bytes give null; bytes at 248 and above are skipped', () => {
  const k = P.makeApiKey(bytes(256));
  assert.match(k, /^st_live_[0-9A-Za-z]{32}$/);
  assert.equal(P.makeApiKey(bytes(256)), k, 'the same bytes give the same key');
  assert.equal(P.makeApiKey(new Uint8Array(20).fill(7)), null, 'too few usable bytes');
  assert.equal(P.makeApiKey(new Uint8Array(256).fill(255)), null, 'bytes at or above 248 are dropped, so none are usable');
  assert.match(P.makeKeyId(bytes(64)), /^ak_[0-9A-Za-z]{8}$/);
  assert.match(P.makeOrderToken(bytes(256)), /^ot_[0-9A-Za-z]{40}$/);
  assert.match(P.makeToken('whsec_', bytes(256), 40), /^whsec_[0-9A-Za-z]{40}$/);
});

test('a key is stored only as its SHA-256 hash, and the hash is not the key', () => {
  const raw = P.makeApiKey(bytes(256));
  const h = P.keyHash(raw);
  assert.equal(h.length, 64);
  assert.equal(h, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.notEqual(h, raw);
  assert.ok(!h.includes(raw));
});

test('Authorization header: only a Bearer key of the right shape is read', () => {
  const raw = 'st_live_' + 'a1'.repeat(16);
  assert.equal(P.bearerKey('Bearer ' + raw), raw);
  assert.equal(P.bearerKey('bearer ' + raw), raw, 'the scheme name is case-insensitive');
  assert.equal(P.bearerKey('Basic ' + raw), '');
  assert.equal(P.bearerKey('Bearer st_test_' + 'a'.repeat(32)), '');
  assert.equal(P.bearerKey('Bearer st_live_short'), '');
  assert.equal(P.bearerKey(''), '');
  assert.equal(P.bearerKey(undefined), '');
});

test('scopes: known ones only, at least one, duplicates folded', () => {
  assert.deepEqual(P.checkScopes(['catalog:read', 'orders:write', 'catalog:read']), { ok: true, scopes: ['catalog:read', 'orders:write'] });
  assert.equal(P.checkScopes(['admin:all']).ok, false);
  assert.equal(P.checkScopes([]).ok, false);
  assert.equal(P.checkScopes('catalog:read').ok, false);
  assert.equal(P.hasScope({ scopes: ['catalog:read'] }, 'orders:write'), false);
  assert.equal(P.hasScope({ scopes: ['catalog:read'] }, 'catalog:read'), true);
});

test('origins: lower-case https sites and local http only; no paths, wildcards or plain http', () => {
  assert.equal(P.normalizeOrigin('https://Shop.Example'), 'https://shop.example');
  assert.equal(P.normalizeOrigin('https://a.b.c:8443'), 'https://a.b.c:8443');
  assert.equal(P.normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(P.normalizeOrigin('http://shop.example'), null);
  assert.equal(P.normalizeOrigin('https://shop.example/'), null);
  assert.equal(P.normalizeOrigin('https://shop.example/path'), null);
  assert.equal(P.normalizeOrigin('*'), null);
  assert.equal(P.normalizeOrigin(''), null);
  assert.deepEqual(P.checkOrigins(['https://shop.example', 'https://SHOP.example']), { ok: true, origins: ['https://shop.example'] });
  assert.equal(P.checkOrigins(['*']).ok, false);
});

test('originAllowed: a server call (no Origin) passes; a browser origin must be listed by the key', () => {
  const key = { origins: ['https://shop.example'] };
  assert.equal(P.originAllowed(key, ''), true);
  assert.equal(P.originAllowed(key, 'https://shop.example'), true);
  assert.equal(P.originAllowed(key, 'https://SHOP.example'), true);
  assert.equal(P.originAllowed(key, 'https://evil.example'), false);
  assert.equal(P.originAllowed({ origins: [] }, 'https://shop.example'), false);
});

test('rate limits: one-minute windows, a limit of 60 per key and 20 per IP for POST, separate buckets', () => {
  const t = Date.UTC(2026, 9, 28, 10, 0, 30);
  assert.equal(P.windowStart(t), Date.UTC(2026, 9, 28, 10, 0, 0));
  assert.equal(P.retryAfterSeconds(t), 30);
  assert.equal(P.retryAfterSeconds(Date.UTC(2026, 9, 28, 10, 0, 59)), 1);
  assert.equal(P.overLimit(60, P.LIMITS.keyPerMinute), false);
  assert.equal(P.overLimit(61, P.LIMITS.keyPerMinute), true);
  assert.equal(P.ipLimit('POST'), 20);
  assert.equal(P.ipLimit('GET'), P.LIMITS.ipReadPerMinute);
  assert.notEqual(P.ipBucket('1.2.3.4', 'POST'), P.ipBucket('1.2.3.4', 'GET'));
  assert.notEqual(P.keyBucket('ak_1'), P.ipBucket('ak_1', 'GET'));
});

// ---- projections ----
const sentinelProduct = {
  Product_ID: 'NETFLIX', Product_Name: 'Netflix', Category: 'Streaming', Slug: 'netflix', Public: true, Active: 'Yes',
  Description: 'Streaming plan', Image_Path: 'products/netflix.png', Sort_Order: 2, Public_Price: 320, Default_Price: 290,
  Account_Cost: 123457, Code_Unit_Cost: 987651, Supplier_ID: 'SUP-SECRET', Template_Renew: 'Renew {name}', Template_Due: 'Due {name}',
  Letter: 'N', Billing_Cycle_Days: 30, Delivers_As: 'account'
};
function stateWith(extra) {
  return Object.assign({ today: '2026-10-28', settings: {}, products: [sentinelProduct], accounts: [], codes: [], sales: [], customers: [], payments: [] }, extra);
}

test('productView: exactly the public fields; no cost, code, supplier, template or account data', () => {
  const st = stateWith({ accounts: [{ Account_ID: 'NFX-01', Product_ID: 'NETFLIX', Slots: 5, Cycle_Cost: 1000, Account_Status: 'Active', Account_Label: 'secret-login' }] });
  const v = P.productView(st, sentinelProduct);
  assert.deepEqual(Object.keys(v).sort(), ['available', 'currency', 'description', 'image_path', 'name', 'public_price', 'slug'].sort());
  assert.deepEqual({ slug: v.slug, name: v.name, public_price: v.public_price, available: v.available, image_path: v.image_path },
    { slug: 'netflix', name: 'Netflix', public_price: 320, available: true, image_path: 'products/netflix.png' });
  const text = JSON.stringify(v);
  for (const leak of ['123457', '987651', 'SUP-SECRET', 'Renew', 'secret-login', 'NFX-01']) assert.ok(!text.includes(leak), 'leaks ' + leak);
});

test('productView: the public price falls back to the default price when none is set', () => {
  const p = Object.assign({}, sentinelProduct, { Public_Price: '' });
  assert.equal(P.productView(stateWith({}), p).public_price, 290);
});

test('catalogView: public products only, in sort order then name', () => {
  const hidden = Object.assign({}, sentinelProduct, { Product_ID: 'HID', Slug: 'hidden', Public: false, Product_Name: 'Hidden' });
  const b = Object.assign({}, sentinelProduct, { Product_ID: 'B', Slug: 'b', Product_Name: 'Beta', Sort_Order: 1 });
  const a = Object.assign({}, sentinelProduct, { Product_ID: 'A', Slug: 'a', Product_Name: 'Alpha', Sort_Order: 1 });
  const off = Object.assign({}, sentinelProduct, { Product_ID: 'OFF', Slug: 'off', Product_Name: 'Off', Active: 'No' });
  const list = P.catalogView(stateWith({ products: [sentinelProduct, hidden, b, a, off] }));
  assert.deepEqual(list.map(x => x.slug), ['a', 'b', 'netflix']);
});

test('isAvailable: a code product needs an unsold code; an account product needs a free seat in its pool', () => {
  const code = { Product_ID: 'HONE', Product_Name: 'Hone', Category: 'Game Code', Delivers_As: 'code', Slug: 'hone', Public: true, Active: 'Yes', Letter: 'G' };
  const codes = [{ Code_ID: 'C1', Product_ID: 'HONE', Status: 'Available' }];
  assert.equal(P.isAvailable(stateWith({ products: [code], codes: codes }), code), true);
  assert.equal(P.isAvailable(stateWith({ products: [code], codes: codes, sales: [{ Sale_ID: 1, Code_ID: 'C1', Record_Status: 'Active' }] }), code), false);
  assert.equal(P.isAvailable(stateWith({ products: [code], codes: [] }), code), false);
  const acc = [{ Account_ID: 'NFX-01', Product_ID: 'NETFLIX', Slots: 1, Account_Status: 'Active', Cycle_Cost: 0 }];
  assert.equal(P.isAvailable(stateWith({ accounts: acc }), sentinelProduct), true);
  const full = [{ Account_ID: 'NFX-01', Product_ID: 'NETFLIX', Slots: 1, Account_Status: 'Active', Cycle_Cost: 0 }];
  const used = [{ Sale_ID: 5, Account_ID: 'NFX-01', Record_Status: 'Active', Paid_Till: '2026-12-01', Product_ID: 'NETFLIX' }];
  assert.equal(P.isAvailable(stateWith({ accounts: full, sales: used }), sentinelProduct), false);
  const banned = [{ Account_ID: 'NFX-01', Product_ID: 'NETFLIX', Slots: 3, Account_Status: 'Banned', Cycle_Cost: 0 }];
  assert.equal(P.isAvailable(stateWith({ accounts: banned }), sentinelProduct), false);
});

test('orderView and keyView never carry a hash, a raw key or contact details', () => {
  const order = { Order_ID: 'O-00007', Status: 'New', Created: '2026-10-28T10:00:00.000Z', Product_ID: 'NETFLIX', Months: 2, Total: 640,
    Contact: '01711111111', Customer_Name: 'Rahim', Access_Token: 'ot_secret', Idem_Key: 'idem-secret' };
  const v = P.orderView(order, sentinelProduct, { Status: 'Open' }, 'https://pay.example/pay/T');
  const text = JSON.stringify(v);
  for (const leak of ['01711111111', 'Rahim', 'ot_secret', 'idem-secret']) assert.ok(!text.includes(leak), 'leaks ' + leak);
  assert.deepEqual(v.payment, { status: 'Open', url: 'https://pay.example/pay/T' });
  const k = P.keyView({ key_id: 'ak_12345678', name: 'Shop', hash: 'deadbeef', scopes: ['catalog:read'], origins: [], active: true, created_at: 'x' });
  assert.ok(!JSON.stringify(k).includes('deadbeef'));
  assert.equal(k.id, 'ak_12345678');
});

test('portalView: the given lines, the total owed, no customer name or contact', () => {
  const v = P.portalView([{ productName: 'Netflix', paidTill: '2026-11-20', owes: 120.5 }, { productName: 'Spotify', paidTill: '2026-10-30', owes: 0 }]);
  assert.deepEqual(v, { lines: [{ product: 'Netflix', paid_till: '2026-11-20', owes: 120.5 }, { product: 'Spotify', paid_till: '2026-10-30', owes: 0 }],
    owes: 120.5, currency: 'BDT' });
  assert.deepEqual(P.portalView([]), { lines: [], owes: 0, currency: 'BDT' });
});

// ---- order input ----
const goodOrder = { product: 'netflix', months: 2, price: 640, customer: { name: '  Rahim   Uddin ', contact: '01711111111', channel: 'WhatsApp' }, note: 'gift' };

test('orderRequest: a good order is read and tidied', () => {
  const r = P.orderRequest(goodOrder);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value, { product: 'netflix', months: 2, price: 640, customer: { name: 'Rahim Uddin', contact: '01711111111', channel: 'WhatsApp' }, note: 'gift' });
  assert.equal(P.orderRequest({ product: 'netflix', price: '290', customer: { name: 'A', contact: 'a@x.test' }, months: '3' }).value.months, 3);
  assert.equal(P.orderRequest({ product: 'netflix', price: 290, customer: { name: 'A', contact: 'a@x.test' } }).value.months, 1, 'months default to 1');
});

test('orderRequest: each bad field is named, and nothing else is accepted', () => {
  const cases = [
    [null, /JSON object/],
    [Object.assign({}, goodOrder, { product: '' }), /product is required/],
    [Object.assign({}, goodOrder, { months: 13 }), /months must be/],
    [Object.assign({}, goodOrder, { months: 1.5 }), /months must be/],
    [Object.assign({}, goodOrder, { price: undefined }), /price is required/],
    [Object.assign({}, goodOrder, { price: -1 }), /price must be/],
    [Object.assign({}, goodOrder, { price: 'abc' }), /price must be/],
    [Object.assign({}, goodOrder, { customer: undefined }), /customer is required/],
    [Object.assign({}, goodOrder, { customer: { name: 'x'.repeat(121), contact: '1' } }), /customer.name is required/],
    [Object.assign({}, goodOrder, { customer: { name: 'A' } }), /customer.contact is required/],
    [Object.assign({}, goodOrder, { customer: { name: 'A', contact: '1', email: 'x' } }), /Unknown field customer.email/],
    [Object.assign({}, goodOrder, { note: 'n'.repeat(501) }), /note must be/],
    [Object.assign({}, goodOrder, { admin: true }), /Unknown field admin/]
  ];
  for (const [body, re] of cases) {
    const r = P.orderRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.code, 'validation_failed');
    assert.ok(r.errors.some(e => re.test(e)), 'expected ' + re + ' in ' + JSON.stringify(r.errors));
  }
});

test('idempotencyKey: 8 to 128 safe characters, else empty', () => {
  assert.equal(P.idempotencyKey('order-2026-10-28-0001'), 'order-2026-10-28-0001');
  assert.equal(P.idempotencyKey('  abcdefgh  '), 'abcdefgh');
  assert.equal(P.idempotencyKey('short'), '');
  assert.equal(P.idempotencyKey('has space here'), '');
  assert.equal(P.idempotencyKey('x'.repeat(129)), '');
  assert.equal(P.idempotencyKey(undefined), '');
});

test('fingerprint: the same body in another key order is the same; a changed value is not', () => {
  const a = { product: 'netflix', months: 2, customer: { name: 'A', contact: '1' } };
  const b = { customer: { contact: '1', name: 'A' }, months: 2, product: 'netflix' };
  assert.equal(P.fingerprint(a), P.fingerprint(b));
  assert.notEqual(P.fingerprint(a), P.fingerprint(Object.assign({}, a, { months: 3 })));
  assert.equal(P.fingerprint(a).length, 64);
});

// ---- webhooks ----
test('eventBody: id, type, created in Unix seconds, data, in a fixed order', () => {
  const body = P.eventBody('evt-1', 'order.paid', Date.UTC(2026, 9, 28, 10, 0, 0, 999), { orderId: 'O-00001' });
  assert.equal(body, '{"id":"evt-1","type":"order.paid","created":' + Math.floor(Date.UTC(2026, 9, 28, 10) / 1000) + ',"data":{"orderId":"O-00001"}}');
  assert.equal(P.isEvent('order.created') && P.isEvent('subscription.ended') && !P.isEvent('order.deleted'), true);
});

test('subscribers: only switched-on endpoints that asked for the event', () => {
  const eps = [
    { id: 'a', active: true, events: ['order.created'] },
    { id: 'b', active: false, events: ['order.created'] },
    { id: 'c', active: true, events: ['order.paid'] },
    { id: 'd', active: true, events: ['order.created', 'order.paid'] }
  ];
  assert.deepEqual(P.subscribers(eps, 'order.created').map(e => e.id), ['a', 'd']);
});

test('retryPlan: 60 s, then 120 s, doubling, capped at 6 h; failed after 8 sends', () => {
  const now = 1000000;
  assert.deepEqual(P.retryPlan(1, now), { status: 'pending', nextTryMs: now + 60000 });
  assert.deepEqual(P.retryPlan(2, now), { status: 'pending', nextTryMs: now + 120000 });
  assert.equal(P.retryPlan(7, now).nextTryMs - now, 60000 * 64);
  assert.equal(P.retryPlan(P.MAX_ATTEMPTS, now).status, 'failed');
});

test('webhookUrl: https anywhere, http only for localhost, no user name or password, bounded length', () => {
  assert.equal(P.webhookUrl('https://shop.example/hooks/tracker'), 'https://shop.example/hooks/tracker');
  assert.equal(P.webhookUrl('http://localhost:8788/x'), 'http://localhost:8788/x');
  assert.equal(P.webhookUrl('http://shop.example/hook'), null);
  assert.equal(P.webhookUrl('https://user:pw@shop.example/hook'), null);
  assert.equal(P.webhookUrl('ftp://shop.example/hook'), null);
  assert.equal(P.webhookUrl('not a url'), null);
  assert.equal(P.webhookUrl('https://shop.example/' + 'a'.repeat(500)), null);
  assert.equal(P.webhookUrl(''), null);
});

test('the four webhook events are the roadmap ones', () => {
  assert.deepEqual(P.EVENTS, ['order.created', 'order.paid', 'subscription.renewed', 'subscription.ended']);
});

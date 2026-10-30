// Staff login tokens on an ES256 (asymmetric signing keys) project: verified against the JWKS, no SUPABASE_JWT_SECRET needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { signJwt, b64url } = require('./support/jwt');

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const URL_ = 'https://proj.supabase.test';
const subtle = nodeCrypto.webcrypto.subtle;

async function newKey(kid) {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  return { priv: kp.privateKey, jwk: Object.assign({}, jwk, { kid, alg: 'ES256', use: 'sig' }), kid };
}
async function signEs(key, over, hdr) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({ sub: STAFF_ID, email: 'staff@example.test', aud: 'authenticated', iat: now, exp: now + 3600, app_role: 'staff' }, over || {});
  const h = b64url(JSON.stringify(Object.assign({ alg: 'ES256', typ: 'JWT', kid: key.kid }, hdr || {})));
  const p = b64url(JSON.stringify(claims));
  const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.priv, Buffer.from(h + '.' + p)));
  return { token: h + '.' + p + '.' + b64url(sig), h, p, sig };
}
async function boot(env) {
  const { db, tables } = makeFakeDb();
  const m = makeUiState();
  await seedDb(db, tables, m);
  tables.staff.set(STAFF_ID, { user_id: STAFF_ID, email: 'staff@example.test', role: 'staff', active: true, created_at: '2026-10-02' });
  return loadEdge(db, { env: Object.assign({ SUPABASE_URL: URL_ }, env || {}) });
}
const me = async (edge, token) => {
  const r = await edge.handle(new Request('https://x.test/functions/v1/api/', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'me' }) }));
  return r.status;
};
function stubFetch(getKeys) {
  const orig = globalThis.fetch, calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); const keys = getKeys(); if (keys === null) throw new Error('down');
    return new Response(JSON.stringify({ keys }), { status: 200 }); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('valid ES256 token accepted; JWKS fetched once for two requests', async () => {
  const k = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try {
    const edge = await boot();
    const { token } = await signEs(k);
    assert.equal(await me(edge, token), 200);
    assert.equal(await me(edge, token), 200);
    assert.deepEqual(f.calls, [URL_ + '/auth/v1/.well-known/jwks.json']);
  } finally { f.restore(); }
});

test('token signed by a different key with the same kid is refused', async () => {
  const k = await newKey('k1'), evil = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try { assert.equal(await me(await boot(), (await signEs(evil)).token), 401); } finally { f.restore(); }
});

test('HS256 token with only JWKS configured is refused', async () => {
  const k = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try {
    const now = Math.floor(Date.now() / 1000);
    const t = signJwt({ sub: STAFF_ID, aud: 'authenticated', exp: now + 3600, app_role: 'staff' }, 'anything', { alg: 'HS256', typ: 'JWT', kid: 'k1' });
    assert.equal(await me(await boot(), t), 401);
  } finally { f.restore(); }
});

test('alg none and alg/key mismatch are refused', async () => {
  const k = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try {
    const edge = await boot();
    const s = await signEs(k);
    const none = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'k1' })) + '.' + s.p + '.';
    assert.equal(await me(edge, none), 401);
    const rs = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })) + '.' + s.p + '.' + b64url(s.sig);
    assert.equal(await me(edge, rs), 401);
  } finally { f.restore(); }
});

test('unknown kid triggers one refetch, then is refused (and not refetched again within a minute)', async () => {
  const k = await newKey('k1'), other = await newKey('zzz'), f = stubFetch(() => [k.jwk]);
  try {
    const edge = await boot();
    assert.equal(await me(edge, (await signEs(k)).token), 200);
    assert.equal(f.calls.length, 1);
    assert.equal(await me(edge, (await signEs(other)).token), 401);
    assert.equal(f.calls.length, 2);
    assert.equal(await me(edge, (await signEs(other)).token), 401);
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test('tampered payload and expired token are refused', async () => {
  const k = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try {
    const edge = await boot();
    const s = await signEs(k);
    const p2 = b64url(JSON.stringify({ sub: STAFF_ID, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 9999, app_role: 'owner' }));
    assert.equal(await me(edge, s.h + '.' + p2 + '.' + b64url(s.sig)), 401);
    assert.equal(await me(edge, (await signEs(k, { exp: Math.floor(Date.now() / 1000) - 5 })).token), 401);
  } finally { f.restore(); }
});

test('JWKS fetch failure: refused, no crash', async () => {
  const k = await newKey('k1'), f = stubFetch(() => null);
  try { assert.equal(await me(await boot(), (await signEs(k)).token), 401); } finally { f.restore(); }
});

test('legacy HS256 still works when SUPABASE_JWT_SECRET is set alongside JWKS', async () => {
  const k = await newKey('k1'), f = stubFetch(() => [k.jwk]);
  try {
    const now = Math.floor(Date.now() / 1000);
    const t = signJwt({ sub: STAFF_ID, aud: 'authenticated', exp: now + 3600, app_role: 'staff' }, 'legacy-secret-0123456789');
    assert.equal(await me(await boot({ SUPABASE_JWT_SECRET: 'legacy-secret-0123456789' }), t), 200);
  } finally { f.restore(); }
});

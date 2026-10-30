// web/src/lib/api.js: init and home send ifNone once a version is held, and keep the cached value on notModified.
const test = require('node:test');
const assert = require('node:assert/strict');

function stub(replies) {
  const sent = [];
  globalThis.window = { API_BASE_URL: 'https://api.test' };
  globalThis.localStorage = { getItem: () => 's', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { status: 200, json: async () => replies.shift() };
  };
  return sent;
}

test('init sends ifNone after the first answer and returns the cached data on notModified', async () => {
  const { call } = await import('../web/src/lib/api.js?t=1');
  const full = { lookups: { a: 1 }, home: { b: 2 }, version: 'v1' };
  const sent = stub([{ ok: true, data: full }, { ok: true, data: { notModified: true, version: 'v1' } },
    { ok: true, data: { lookups: { a: 9 }, home: {}, version: 'v2' } }, { ok: true, data: { notModified: true, version: 'v2' } }]);
  const r1 = await call('init');
  assert.deepEqual(r1.data, full);
  assert.equal(sent[0].payload.ifNone, undefined);
  const r2 = await call('init');
  assert.equal(sent[1].payload.ifNone, 'v1');
  assert.deepEqual(r2, { ok: true, data: full });
  const r3 = await call('init');
  assert.equal(r3.data.version, 'v2');
  const r4 = await call('init');
  assert.equal(sent[3].payload.ifNone, 'v2');
  assert.equal(r4.data.lookups.a, 9);
});

test('other actions never send ifNone, and errors are not cached', async () => {
  const { call } = await import('../web/src/lib/api.js?t=2');
  const sent = stub([{ ok: true, data: { version: 'x' } }, { ok: true, data: { version: 'x' } }, { ok: false, error: 'boom' }, { ok: true, data: { version: 'y' } }]);
  await call('dues'); await call('dues');
  assert.equal(sent[1].payload.ifNone, undefined);
  await call('home');
  assert.equal(sent[2].payload.ifNone, undefined);
  await call('home');
  assert.equal(sent[3].payload.ifNone, undefined);
});

test('setSecret clears the version cache, so the next init sends no ifNone', async () => {
  const { call, setSecret } = await import('../web/src/lib/api.js?t=3');
  const sent = stub([{ ok: true, data: { lookups: {}, home: {}, version: 'v1' } }, { ok: true, data: { lookups: {}, home: {}, version: 'v2' } }]);
  await call('init');
  setSecret('other');
  await call('init');
  assert.equal(sent[1].payload.ifNone, undefined);
});

test('a late reply issued under an old secret does not write the version cache', async () => {
  const { call, setSecret } = await import('../web/src/lib/api.js?t=4');
  let secret = 's';
  const sent = [];
  globalThis.window = { API_BASE_URL: 'https://api.test' };
  globalThis.localStorage = { getItem: () => secret, setItem: (k, v) => { secret = v; }, removeItem() {} };
  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    if (sent.length === 1) await gate;
    return { status: 200, json: async () => ({ ok: true, data: { lookups: {}, home: {}, version: 'old' } }) };
  };
  const late = call('init');
  setSecret('new');
  release();
  await late;
  await call('init');
  assert.equal(sent[1].payload.ifNone, undefined, 'the old-secret answer was not cached');
});

// Stage 1 (inline-edit design A2): a read joins an in-flight identical read only when that read started after the last write finished.
// Resolves to the value, or to 'stuck' after 300 ms, so a joined read that waits on a gate fails the test instead of hanging it.
const within = p => Promise.race([p, new Promise(r => setTimeout(() => r({ stuck: true }), 300))]);

function scripted(handler) {
  const sent = [];
  globalThis.window = { API_BASE_URL: 'https://api.test' };
  globalThis.localStorage = { getItem: () => 's', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return { status: 200, json: () => handler(body, sent) };
  };
  return sent;
}

test('a read started before a write finished is not shared with a read started after it', async () => {
  const { call } = await import('../web/src/lib/api.js?t=5');
  let release;
  const gate = new Promise(r => { release = r; });
  const sent = scripted(async (body, all) => {
    if (body.action === 'edit') return { ok: true, data: { changed: true } };
    if (all.filter(x => x.action === 'dues').length === 1) { await gate; return { ok: true, data: { v: 'old' } }; }
    return { ok: true, data: { v: 'new' } };
  });
  const first = call('dues');
  await call('edit', { requestId: 'w1', kind: 'customer', id: 'C1', values: { Name: 'x' } });
  const second = call('dues');
  const got = await within(second);
  assert.equal(got.data && got.data.v, 'new', 'the read after the write is fresh, not the stale in-flight one');
  assert.equal(sent.filter(x => x.action === 'dues').length, 2, 'the second read was sent, not joined');
  release();
  assert.equal((await first).data.v, 'old', 'the first caller still gets its own answer');
});

test('identical reads with no write between them still share one request', async () => {
  const { call } = await import('../web/src/lib/api.js?t=6');
  let release;
  const gate = new Promise(r => { release = r; });
  const sent = scripted(async () => { await gate; return { ok: true, data: { v: 1 } }; });
  const a = call('dues');
  const b = call('dues');
  release();
  await Promise.all([a, b]);
  assert.equal(sent.filter(x => x.action === 'dues').length, 1);
});

test('invalidate() ends the sharing of reads already in flight', async () => {
  const { call, invalidate } = await import('../web/src/lib/api.js?t=7');
  let release;
  const gate = new Promise(r => { release = r; });
  const sent = scripted(async (body, all) => {
    if (all.filter(x => x.action === 'dues').length === 1) { await gate; return { ok: true, data: { v: 'old' } }; }
    return { ok: true, data: { v: 'new' } };
  });
  const first = call('dues');
  invalidate();
  const second = call('dues');
  assert.equal((await within(second)).data.v, 'new');
  assert.equal(sent.filter(x => x.action === 'dues').length, 2);
  release();
  await first;
});

test('a failed write also ends sharing, so a retry after it is not joined to older reads', async () => {
  const { call } = await import('../web/src/lib/api.js?t=8');
  let release;
  const gate = new Promise(r => { release = r; });
  const sent = scripted(async (body, all) => {
    if (body.action === 'edit') return { ok: false, error: 'nope' };
    if (all.filter(x => x.action === 'dues').length === 1) { await gate; return { ok: true, data: { v: 'old' } }; }
    return { ok: true, data: { v: 'new' } };
  });
  const first = call('dues');
  await call('edit', { requestId: 'w2' });
  assert.equal((await within(call('dues'))).data.v, 'new');
  release();
  await first;
  assert.equal(sent.filter(x => x.action === 'dues').length, 2);
});

// Stage 1b (review item 1): an answer to an older init request never replaces the cache entry of a newer one.
test('an older init answer that lands after a newer one does not overwrite the cache', async () => {
  const { call, invalidate } = await import('../web/src/lib/api.js?t=9');
  let release;
  const gate = new Promise(r => { release = r; });
  // The request number is taken when fetch is called (the two calls below are made in the same tick).
  const sent = [];
  let n = 0;
  globalThis.window = { API_BASE_URL: 'https://api.test' };
  globalThis.localStorage = { getItem: () => 's', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const mine = ++n;
    return { status: 200, json: async () => {
      if (mine === 1) { await gate; return { ok: true, data: { lookups: {}, home: {}, version: 'v1' } }; }
      return { ok: true, data: { lookups: {}, home: {}, version: 'v2' } };
    } };
  };
  const first = call('init');
  invalidate();   // the second init must not join the first one in flight
  await call('init');
  release();
  await first;
  await call('init');
  assert.equal(sent[2].payload.ifNone, 'v2', 'the cache keeps the newer answer, not the one that arrived last');
});

test('undo sends the batchId from the save toast in its payload, unchanged', async () => {
  const { call } = await import('../web/src/lib/api.js?t=undo');
  const sent = stub([{ ok: true, data: { message: 'Undone' } }]);
  await call('undo', { requestId: 'u-1', batchId: 'b-42' });
  assert.deepEqual(sent[0].payload, { requestId: 'u-1', batchId: 'b-42' });
});

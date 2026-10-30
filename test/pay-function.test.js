// functions/pay/[[path]].js: the Pages Function that serves the customer pay page as real HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = pathToFileURL(path.join(__dirname, '..', 'functions', 'pay', '[[path]].js')).href;
const TOKEN = 'abcdefghijklmnop1234';

async function run(params, upstream, env, reqHeaders) {
  const { onRequestGet } = await import(FILE);
  const calls = [];
  const heads = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); heads.push((init && init.headers) || {}); return upstream(String(url), init); };
  const request = new Request('https://x.test/pay', { headers: reqHeaders || {} });
  try { return { res: await onRequestGet({ params: { path: params }, env: env || {}, request }), calls, heads }; } finally { globalThis.fetch = real; }
}
// Supabase sends HTML as text/plain; the function must not pass that on.
const html = () => new Response('<h1>Pay</h1>', { status: 200, headers: { 'Content-Type': 'text/plain' } });

test('serves the pay page as HTML with its own security headers', async () => {
  const { res, calls } = await run([TOKEN], html);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(await res.text(), '<h1>Pay</h1>');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0], 'https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api/pay/' + TOKEN);
});

test('passes the polling status call through as JSON', async () => {
  const { res, calls } = await run([TOKEN, 'status'], () => new Response('{"ok":true,"paid":false}', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { ok: true, paid: false });
  assert.ok(calls[0].endsWith('/pay/' + TOKEN + '/status'));
});

test('uses API_BASE_URL from the environment when it is set', async () => {
  const { calls } = await run([TOKEN], html, { API_BASE_URL: 'https://api.example.test/v1/api/' });
  assert.equal(calls[0], 'https://api.example.test/v1/api/pay/' + TOKEN);
});

test('refuses anything that is not a pay token, without calling the API', async () => {
  for (const bad of [[], ['short'], ['has space 1234567890'], ['../etc/passwd'], [TOKEN, 'other'], [TOKEN, 'status', 'x']]) {
    const { res, calls } = await run(bad, html);
    assert.equal(res.status, 404, JSON.stringify(bad));
    assert.equal(calls.length, 0);
  }
});

test('an unknown link is a plain 404 and an API failure is a plain 502', async () => {
  assert.equal((await run([TOKEN], () => new Response('Payment link not found.', { status: 404 }))).res.status, 404);
  assert.equal((await run([TOKEN], () => new Response('boom', { status: 500 }))).res.status, 502);
  assert.equal((await run([TOKEN], () => { throw new Error('down'); })).res.status, 502);
});

async function runPost(params, body, upstream) {
  const { onRequestPost } = await import(FILE);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return upstream(String(url), init); };
  try { return { res: await onRequestPost({ params: { path: params }, env: {}, request: new Request('http://x/pay', { method: 'POST', body }) }), calls }; } finally { globalThis.fetch = real; }
}

test('POST /pay/<token>/intent forwards the customer choice and returns the answer', async () => {
  const reply = '{"ok":true,"intent":{"method":"bkash"}}';
  const { res, calls } = await runPost([TOKEN, 'intent'], '{"method":"bkash","number":"01711223344"}', () => new Response(reply, { status: 200 }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(await res.text(), reply);
  assert.equal(calls[0].url, 'https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api/pay/' + TOKEN + '/intent');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"method":"bkash","number":"01711223344"}');
});

test('POST passes validation errors through, and refuses other paths, big bodies and API failures', async () => {
  const bad = await runPost([TOKEN, 'intent'], '{}', () => new Response('{"ok":false,"error":"Enter your number"}', { status: 400 }));
  assert.equal(bad.res.status, 400);
  assert.equal((await bad.res.json()).error, 'Enter your number');
  for (const p of [[TOKEN], [TOKEN, 'status'], ['short', 'intent'], [TOKEN, 'intent', 'x'], []]) {
    const r = await runPost(p, '{}', () => new Response('{}'));
    assert.equal(r.res.status, 404, JSON.stringify(p));
    assert.equal(r.calls.length, 0);
  }
  const big = await runPost([TOKEN, 'intent'], 'x'.repeat(2001), () => new Response('{}'));
  assert.equal(big.res.status, 413);
  assert.equal(big.calls.length, 0);
  assert.equal((await runPost([TOKEN, 'intent'], '{}', () => new Response('boom', { status: 500 }))).res.status, 502);
  assert.equal((await runPost([TOKEN, 'intent'], '{}', () => { throw new Error('down'); })).res.status, 502);
});

test('GET /pay/<token>/receipt passes through as no-store JSON; other third segments are refused', async () => {
  const { res, calls } = await run([TOKEN, 'receipt'], () => new Response('{"lines":[],"code":"X"}', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { lines: [], code: 'X' });
  assert.ok(calls[0].endsWith('/pay/' + TOKEN + '/receipt'));
  for (const bad of [[TOKEN, 'receipts'], [TOKEN, 'Receipt'], [TOKEN, 'receipt', 'x'], ['short', 'receipt'], [TOKEN, 'intent']]) {
    const r = await run(bad, html);
    assert.equal(r.res.status, 404, JSON.stringify(bad));
    assert.equal(r.calls.length, 0);
  }
  assert.equal((await run([TOKEN, 'receipt'], () => new Response('nf', { status: 404 }))).res.status, 404);
  assert.equal((await run([TOKEN, 'receipt'], () => new Response('boom', { status: 500 }))).res.status, 502);
});

test('POST /pay/<token>/receipt is refused without calling the API', async () => {
  const r = await runPost([TOKEN, 'receipt'], '{}', () => new Response('{}'));
  assert.equal(r.res.status, 404);
  assert.equal(r.calls.length, 0);
});

test('status forwards If-None-Match, passes a 304 through with no body, and keeps no-store', async () => {
  const tag = 'W/"created|0|"';
  const { res, calls, heads } = await run([TOKEN, 'status'], () => new Response(null, { status: 304, headers: { ETag: tag } }), {}, { 'If-None-Match': tag });
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('etag'), tag);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(heads[0]['If-None-Match'], tag, 'the header reaches the API');
});

test('status passes a fresh 200 and its ETag through, still no-store', async () => {
  const { res, heads } = await run([TOKEN, 'status'], () => new Response('{"ok":true,"stage":"confirmed"}', { status: 200, headers: { 'Content-Type': 'application/json', ETag: 'W/"confirmed|1|"' } }), {}, { 'If-None-Match': 'W/"created|0|"' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), 'W/"confirmed|1|"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).stage, 'confirmed');
  assert.equal(heads[0]['If-None-Match'], 'W/"created|0|"');
});

test('a status call without If-None-Match sends no conditional header', async () => {
  const { heads } = await run([TOKEN, 'status'], () => new Response('{"ok":true}', { status: 200 }));
  assert.equal(heads[0]['If-None-Match'], undefined);
});

test('the page and the receipt never carry an ETag, even if the API sends one', async () => {
  const tagged = () => new Response('<h1>Pay</h1>', { status: 200, headers: { 'Content-Type': 'text/plain', ETag: 'W/"x"' } });
  const page = await run([TOKEN], tagged, {}, { 'If-None-Match': 'W/"x"' });
  assert.equal(page.res.headers.get('etag'), null);
  assert.equal(page.res.headers.get('cache-control'), 'no-store');
  assert.equal(page.heads[0]['If-None-Match'], undefined, 'only status is conditional');
  const rc = await run([TOKEN, 'receipt'], () => new Response('{"lines":[]}', { status: 200, headers: { ETag: 'W/"x"' } }), {}, { 'If-None-Match': 'W/"x"' });
  assert.equal(rc.res.headers.get('etag'), null);
  assert.equal(rc.res.headers.get('cache-control'), 'no-store');
});

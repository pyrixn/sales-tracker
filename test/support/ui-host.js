// Answers the built page's Edge Function calls inside Playwright, from the real edge router
// (test/support/edge-host.js) over a seeded fake db. The page POSTs {action, payload} to
// window.API_BASE_URL (dist/config.js); page.route intercepts that URL, so nothing reaches Supabase.
// Every other request that is not file:// or localhost is aborted.
const { makeFakeDb } = require('./fake-db');
const { seedDb, makeUiState } = require('./seed');
const { loadEdge } = require('./edge-host');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-app-secret'
};
const LOCAL = /^(file:|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/)/i;

/** startUiHost(page, { state? }) -> { db, tables, api }: seeds a fake db and routes the API to it. */
async function startUiHost(page, opts) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, (opts && opts.state) || makeUiState());
  // Never touch the network from UI tests: the rate fetch fails offline unless a test supplies its own.
  const offline = async () => { throw new Error('offline'); };
  const { api, handle } = loadEdge(db, { fetchAds: (opts && opts.fetchAds) || offline, env: { APP_SECRET: 'ui', RELAY_TOKEN: 'ui', VAULT_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' } });

  // Registered first, so the API route below (registered later) takes precedence for its URL.
  await page.route('**/*', route => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData() || '{}');
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(res) });
  });
  // The public customer pay page and its /status, /intent and /receipt calls, answered by the same router.
  await page.route('**/pay/**', async route => {
    const req = route.request(), u = new URL(req.url());
    const res = await handle(new Request('https://x.test/functions/v1/api' + u.pathname + u.search, { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.method() === 'POST' ? req.postData() : undefined }));
    return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || 'text/plain', body: await res.text() });
  });
  // "Another phone" sends an SMS to the relay route, as the bKash relay does: POST /relay?src=<source> with the token. The
  // row lands in the fake inbox and shows on the next live refresh.
  const relay = async (src, body) => {
    const res = await handle(new Request('https://x.test/functions/v1/api/relay?src=' + src, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: 'ui' }, body)) }));
    return { status: res.status, body: await res.json() };
  };
  return { db, tables, api, relay };
}

module.exports = { startUiHost };

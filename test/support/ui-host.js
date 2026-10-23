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
  const { api } = loadEdge(db, { fetchAds: (opts && opts.fetchAds) || offline });

  // Registered first, so the API route below (registered later) takes precedence for its URL.
  await page.route('**/*', route => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  await page.route('**/functions/v1/api', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData() || '{}');
    const res = await api(body.action, body.payload || {});
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(res) });
  });
  return { db, tables, api };
}

module.exports = { startUiHost };

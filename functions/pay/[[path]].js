// Cloudflare Pages Function: serves the customer pay page at https://<site>/pay/<token>.
// Supabase answers HTML from an Edge Function as text/plain inside a sandbox, so the page cannot
// render from supabase.co. This function fetches the same page from the Edge Function and hands it
// back as real HTML. Only these calls pass through:
//   GET  /pay/<token>          the page
//   GET  /pay/<token>/status   the order status the page polls
//   GET  /pay/<token>/receipt  the receipt of a paid request: terms, review links and, only while a live code exists, the code (404 before payment)
//   POST /pay/<token>/intent   the customer's chosen method and number
// Function responses do not get dist/_headers, so the page's own headers are set here.
const DEFAULT_API = 'https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api';
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY = 2000;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};
// The page carries one inline style block and one inline script, and calls only its own /status, /intent and /receipt (connect-src 'self'). No fonts or images load, so nothing else is allowed.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const plain = (status, text) => new Response(text, { status, headers: { ...SECURITY, 'Content-Type': 'text/plain; charset=utf-8' } });
const json = (status, body, extra) => new Response(body, { status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) } });
const apiBase = context => String((context.env && context.env.API_BASE_URL) || DEFAULT_API).replace(/\/+$/, '');
// Only the status poll is conditional: the API's weak ETag and a 304 pass through. The page and the receipt never get an ETag.
const etagOf = upstream => { const t = upstream.headers.get('ETag'); return t ? { ETag: t } : null; };

export async function onRequestGet(context) {
  const parts = [].concat(context.params.path || []);
  const token = parts[0];
  const sub = parts.length === 2 && (parts[1] === 'status' || parts[1] === 'receipt') ? parts[1] : '';
  const status = sub !== '';
  if (!token || !TOKEN.test(token) || (parts.length !== 1 && !status)) return plain(404, 'Payment link not found.');

  const conditional = sub === 'status';
  const inm = conditional && context.request ? context.request.headers.get('If-None-Match') : null;
  const headers = { Accept: status ? 'application/json' : 'text/html' };
  if (inm) headers['If-None-Match'] = inm;
  let upstream;
  try {
    upstream = await fetch(apiBase(context) + '/pay/' + encodeURIComponent(token) + (status ? '/' + sub : ''), { headers });
  } catch (e) {
    return plain(502, 'Payment page is unavailable. Try again in a minute.');
  }
  if (upstream.status === 404) return plain(404, 'Payment link not found.');
  // 304: the status is unchanged since the page's ETag. No body, so the page keeps what it shows.
  if (conditional && upstream.status === 304) return new Response(null, { status: 304, headers: { ...SECURITY, ...(etagOf(upstream) || {}) } });
  if (!upstream.ok) return plain(502, 'Payment page is unavailable. Try again in a minute.');

  const body = await upstream.text();
  if (status) return json(200, body, conditional ? etagOf(upstream) : null);
  return new Response(body, { status: 200, headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP } });
}

export async function onRequestPost(context) {
  const parts = [].concat(context.params.path || []);
  if (parts.length !== 2 || parts[1] !== 'intent' || !TOKEN.test(parts[0] || '')) return plain(404, 'Payment link not found.');
  const raw = await context.request.text();
  if (raw.length > MAX_BODY) return json(413, '{"ok":false,"error":"Request too large."}');
  let upstream;
  try {
    upstream = await fetch(apiBase(context) + '/pay/' + encodeURIComponent(parts[0]) + '/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  } catch (e) {
    return json(502, '{"ok":false,"error":"Could not reach the payment service. Try again."}');
  }
  const text = await upstream.text();
  if (upstream.status === 200 || upstream.status === 400 || upstream.status === 404) return json(upstream.status, text);
  return json(502, '{"ok":false,"error":"Could not reach the payment service. Try again."}');
}

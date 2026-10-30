# Public API v1

The website reads products and places orders through this API. It is served by the Supabase Edge Function `api`, under `/v1/`. The full contract is in [openapi.yaml](openapi.yaml). The rules live in `src/core/publicapi.js`, the routes in `src/server/edge.js`, and the tables in `supabase/migrations/019_public_api.sql`.

Call the API from your server only. A key in browser code is a key anyone can copy.

## Owner steps

1. **Migration.** Apply `019_public_api.sql`. Run `node tools/migrate-schema.js` (a dry run) first, then `--apply` once you have approved it. This changes the remote project.
2. **Deploy.** Run `node tools/build-edge.js`, then `supabase functions deploy api`. The `/v1` routes need `SUPABASE_DB_URL` (the Postgres connection); the fallback path without it cannot run their SQL.
3. **A key for the website.** In the panel, open **More > API keys > New key**. Give it a name, the scopes it needs, and the sites that may call it from a browser (for example `https://shop.example`). Copy the key when it is shown. It is not shown again. Keep it in the website's server environment.
4. **Webhooks.** In the panel, open **More > Webhooks > Add webhook**. Give an `https://` address and the events you want. Copy the signing secret when it is shown. It is not shown again.
5. **Sending webhooks.** There is no scheduled job yet, so press **Send queued** in the Webhooks screen. The same send is available to a scheduler: `POST` the Edge Function with the panel's `X-App-Secret` header and the JSON body `{"action":"sendWebhooks","payload":{}}`. A scheduled job is part of roadmap Phase 3 (pg_cron).

## Authentication and sites

- Send `Authorization: Bearer <key>`. A key that is malformed, unknown or revoked gets `401`.
- A call with an `Origin` header (a browser) must come from a site the key lists, or it gets `403 origin_not_allowed`. The response echoes that one origin in `Access-Control-Allow-Origin`, never `*`.
- A call with no `Origin` (your server) needs no site list.
- Each key has scopes. A call outside them gets `403 insufficient_scope`.

| Scope | Lets the key |
| --- | --- |
| `catalog:read` | read the public catalog |
| `orders:write` | place orders |
| `orders:read` | read an order with its token |
| `portal:read` | read a customer's own lines with a pay token |

Only a hash of each key is stored. The panel cannot show a key again. If a key leaks, revoke it and make a new one.

## Endpoints

| Method and path | Scope | What it does |
| --- | --- | --- |
| `GET /v1/products` | `catalog:read` | The public catalog, in sort order. Sends an `ETag`; send `If-None-Match` to get `304`. |
| `GET /v1/products/{slug}` | `catalog:read` | One public product. Other products are `404`. |
| `POST /v1/orders` | `orders:write` | Places an order and returns its pay link and a `token`. Needs an `Idempotency-Key`. |
| `GET /v1/orders/{id}?token=` | `orders:read` | The order's status, for the customer with the token. |
| `GET /v1/portal/{pay token}` | `portal:read` | The lines of one customer: product, paid till, owed. Nothing else about them. |

A product's answer has only these fields: `slug`, `name`, `description`, `public_price`, `currency`, `available` and `image_path`. Costs, codes, suppliers, templates and account details never leave the server.

### Placing an order

`POST /v1/orders` takes the price the customer saw. If the current price differs, the order is refused with `409 price_changed`, and the website shows the new price and asks again.

```json
{
  "product": "netflix",
  "months": 2,
  "price": 320,
  "customer": { "name": "Rahim Uddin", "contact": "01711111111", "channel": "WhatsApp" },
  "note": "Gift"
}
```

The answer (`201`) has the order, the pay link to show the customer, and the `token`:

```json
{ "ok": true, "order": { "id": "O-00007", "status": "New", "total": 640, "payment": { "status": "Open", "url": "https://.../pay/..." } }, "token": "ot_..." }
```

Store the `token` with the checkout. It is the only way to read the order's status later.

**Idempotency.** Send an `Idempotency-Key` that is unique to this checkout attempt (8 to 128 letters, digits, `-` or `_`). A retry with the same key and the same body returns the same order (`200`, header `Idempotent-Replayed: true`) and creates nothing new. The same key with a different body is `422 idempotency_conflict`. Keys are kept apart per API key, so two websites can use the same value.

## Errors and limits

Every error is JSON: `{ "ok": false, "code": "...", "error": "..." }`. Match on `code`, not on the message.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `idempotency_key_required` | `POST /v1/orders` without the header |
| 400 | `invalid_json` | the body is not JSON |
| 400 | `token_required` | `GET /v1/orders/{id}` without `?token=` |
| 401 | `unauthorized` | no, malformed, unknown or revoked key |
| 403 | `origin_not_allowed` | the browser's site is not on the key's list |
| 403 | `insufficient_scope` | the key lacks the route's scope |
| 404 | `not_found` | no such route, product, order or token |
| 404 | `product_not_found` | no product on sale has that web address |
| 405 | `method_not_allowed` | the method is wrong for the route |
| 409 | `price_changed` | the price moved since the customer saw it |
| 422 | `validation_failed` | the body is not valid; `errors` lists each field |
| 422 | `idempotency_conflict` | the key was used with another body |
| 422 | other order codes | the order rules refuse it, such as `not_public` or `no_price` |
| 429 | `rate_limited` | too many calls; wait for `Retry-After` seconds |
| 500 | `server_error` | something failed; nothing was changed |

Limits: 60 calls a minute per key, and per IP 20 a minute for `POST` and 120 a minute for `GET`. The IP limit is checked before the key, so guessing keys is slowed too.

## Webhooks

The tracker sends a signed `POST` when an order is created or paid, or when a subscription is renewed or ended. The body is JSON:

```json
{ "id": "3f2c...", "type": "order.created", "created": 1793000000, "data": { "orderId": "O-00007", "status": "New", "source": "website", "months": 2, "total": 640, "product": { "slug": "netflix", "name": "Netflix" } } }
```

Order events carry no contact details. Subscription events carry the sale id (and the sub code for a renewal).

Headers: `X-Signature`, `X-Event-Id` (the same as `id`), `Content-Type: application/json`.

**Verify every message.** The signature is `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`.

1. Read the raw body before parsing it.
2. Refuse a `t` more than 300 seconds from your clock (a replay).
3. Compare the HMAC with `timingSafeEqual`.
4. Dedupe on `id`. A slow answer makes the tracker resend the same event.

A message is retried with backoff (1 minute, then doubling, up to 6 hours) until it gets a `2xx` or 8 tries are used. Redirects are not followed. Use **Resend** in the panel to send a failed event again; it keeps its `id`. A secret cannot be shown again. To change it, add a new endpoint and switch the website to it.

## Next.js example (App Router, Node runtime)

Put these values in `.env.local`. None of them uses the `NEXT_PUBLIC_` prefix, so they stay on the server:

```
TRACKER_API_URL=https://your-project-ref.supabase.co/functions/v1/api
TRACKER_API_KEY=<the key from More > API keys>
TRACKER_WEBHOOK_SECRET=<the secret from More > Webhooks>
```

`lib/tracker.js`:

```js
export async function trackerFetch(path, init = {}) {
  const res = await fetch(process.env.TRACKER_API_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.TRACKER_API_KEY}`, ...(init.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status, code: data.code });
  return data;
}
```

The catalog, cached with ISR. Next.js re-fetches it at most once an hour; `tags` lets you purge it on demand:

```js
// app/shop/page.jsx
import { trackerFetch } from '@/lib/tracker';

export default async function Shop() {
  const { products } = await trackerFetch('/v1/products', { next: { revalidate: 3600, tags: ['products'] } });
  return (
    <ul>
      {products.map(p => (
        <li key={p.slug}>
          <a href={`/shop/${p.slug}`}>{p.name}</a> · {p.public_price} BDT a month{p.available ? '' : ' · sold out'}
        </li>
      ))}
    </ul>
  );
}
```

Placing an order from a Route Handler, so the key never reaches the browser. The browser sends the customer's details and a checkout id; the handler sends the order:

```js
// app/api/orders/route.js
import { NextResponse } from 'next/server';
import { trackerFetch } from '@/lib/tracker';

export async function POST(request) {
  const { checkoutId, ...order } = await request.json();   // checkoutId: your id for this checkout, reused on retries
  try {
    const data = await trackerFetch('/v1/orders', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `checkout-${checkoutId}` },
      body: JSON.stringify(order),
    });
    // Save data.token with the checkout in your own database. Do not send it to the browser.
    return NextResponse.json({ orderId: data.order.id, payUrl: data.order.payment.url }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status || 500 });
  }
}
```

Reading an order's status for the customer's page, on the server, with the token you saved:

```js
// app/orders/[id]/page.jsx
import { trackerFetch } from '@/lib/tracker';

export default async function OrderPage({ params, searchParams }) {
  const { id } = await params;
  const token = await lookupOrderToken(id);   // your database: the token saved at checkout
  const { order } = await trackerFetch(`/v1/orders/${id}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  return <p>Order {order.id}: {order.status}. <a href={order.payment.url}>Pay</a></p>;
}
```

Verifying a webhook, in a Route Handler that reads the raw body:

```js
// app/api/tracker-webhook/route.js
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

const TOLERANCE_S = 300;

function parseSignature(header) {
  let t = '';
  const v1 = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.push(v);
  }
  return { t: Number(t), v1 };
}

export async function POST(request) {
  const raw = await request.text();                                  // the raw body, before any parsing
  const { t, v1 } = parseSignature(request.headers.get('x-signature') || '');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(t) || Math.abs(now - t) > TOLERANCE_S) return NextResponse.json({ error: 'stale' }, { status: 400 });

  const expected = crypto.createHmac('sha256', process.env.TRACKER_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  const ok = v1.some(sig => sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 400 });

  const event = JSON.parse(raw);
  // Dedupe on event.id in your own table: a Map in memory is lost between serverless instances.
  if (await alreadyHandled(event.id)) return NextResponse.json({ ok: true, duplicate: true });
  await markHandled(event.id);

  if (event.type === 'order.paid') {
    // Send the customer their keys or start their subscription here.
  }
  return NextResponse.json({ ok: true });                            // answer fast; do slow work after the answer
}
```

`alreadyHandled` and `markHandled` are yours to write: a table in your own database with the event id as its key.

## Not in v1

- No scheduled sending yet (see owner step 5).
- One signing secret per endpoint. To rotate, add an endpoint and switch.
- Failed webhook deliveries are kept, not pruned.
- The Edge Function fallback without `SUPABASE_DB_URL` cannot run the `/v1` SQL.

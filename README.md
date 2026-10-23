# Sales Tracker (Supabase Edition)

A subscription sales tracker with bKash payment matching, WhatsApp and Discord reminder messages, and a full audit log with undo. The data lives in Supabase Postgres, a Supabase Edge Function serves the API, and the admin panel is a static single-page site.

## How the pieces fit together

- **Core** (`src/core/`): pure business logic with no input or output. It plans sales, payments, payment matching, reminders and undo, and builds the read models the screens use.
- **Adapter** (`src/adapters/postgres.js`): reads the database into one state object and writes the changes the core plans back to Postgres.
- **API** (`src/server/edge.js`): the Edge Function router (Deno). It wraps the core and the adapter, checks the `X-App-Secret` header, and answers `POST` requests of the form `{ action, payload }`.
- **Admin panel** (`src/ui/Index.html`): a vanilla JavaScript single-page app with no framework. `npm run build` turns it into a static site in `dist/`.
- **Database** (`supabase/migrations/`): the schema. Every table has row level security enabled with no policies, so only the service role can reach the data, and all traffic goes through the Edge Function.

## Project layout

```
src/
  core/          business logic (pure functions over the state object)
  adapters/      postgres.js, the storage adapter
  server/        edge.js, the Edge Function router
  ui/            Index.html, the admin panel
supabase/
  migrations/    001_schema.sql, 002_admin_panel_extensions.sql, 003_revoke_rls_auto_enable.sql
  functions/api/ index.ts, the built Edge Function (generated, do not hand-edit)
tools/
  build.js                 builds the static site into dist/
  build-edge.js            bundles core, adapter and router into the Edge Function
  migrate-schema.js        applies the SQL migrations (dry run by default)
  migrate-to-supabase.js   one-off data import from the old sheet (already run; payment total of 33,786.80 matched the snapshot on 2026-10-23)
  migrate-output.json      local-only snapshot of the old sheet data (git-ignored, real customer data), do not modify
  lib/                     helpers used by migrate-schema.js
test/            Node test runner tests, plus browser tests in test/ui/
reference_PaymentRelay_v9.gs   bKash relay script, read-only reference
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs every test, including the browser tests. |
| `npm run test:core` | Runs only the server, core, adapter and tooling tests in `test/*.test.js`. |
| `npm run test:ui` | Builds the static site and runs the Playwright browser tests in `test/ui/`. |
| `npm run setup:ui` | Downloads the Chromium browser that the UI tests need. Run it once per machine. |
| `npm run build` | Builds the static admin site into `dist/` (`index.html` and `config.js`). |
| `node tools/build-edge.js` | Rebuilds `supabase/functions/api/index.ts` from `src/`. |
| `node tools/migrate-schema.js` | Dry run of the schema migration. Makes no network call. |

The tests run the real Edge Function router (`src/server/edge.js`) against a fake in-memory database in `test/support/`, so they need no Supabase project and no network.

## Environment variables

The migration tools read a `.env` file in the project root (it is git-ignored). `tools/migrate-schema.js` needs:

- `SUPABASE_PROJECT_REF`: the project reference.
- `SUPABASE_ACCESS_TOKEN`: a Supabase access token for the Management API.

Never print these values, copy them into code, or commit them. `settings.json` and `.mcp.json` may also hold credentials and must stay out of commits.

The Edge Function reads its own secrets, which you set in the Supabase dashboard:

- `SUPABASE_DB_URL`: the Postgres connection string.
- `APP_SECRET` (**required**): every `POST` to the API must send a matching `X-App-Secret` header. If it is unset the API answers 503 and does nothing. The admin panel sends the value it finds in the browser's local storage under `sales_tracker_secret`.
- `ALLOWED_ORIGIN`: the one origin allowed to call the API from a browser (for example your Cloudflare Pages URL). When unset, no CORS header is sent and only same-origin pages can call the API. The API never answers `*`.
- `RELAY_TOKEN` (**required**): `POST /relay` requests must carry a matching `token` field in the body. If it is unset the relay answers 503.

The static site reads one build-time variable, `API_BASE_URL`, described in `README_CF_PAGES.md`.

## Database schema

Schema changes are applied only by `tools/migrate-schema.js`. It records which files in `supabase/migrations/` have run and skips those on later runs.

```bash
node tools/migrate-schema.js                           # dry run: lists the files, changes nothing
node tools/migrate-schema.js --apply                   # applies pending files to the remote project
node tools/migrate-schema.js --baseline 001_schema.sql # records a file as already applied without running it
```

Rules to keep in mind:

- `--apply` changes the remote Supabase project. Only run it with the project owner's approval.
- Use `--baseline <file>[,<file>]` when the database already has the tables but no migration record, so that existing files are recorded rather than run again.
- The runner refuses to run a migration that contains `drop table` against a database that already has tables (any public base table other than `schema_migrations`).
- Add schema changes as a new numbered migration file. Never edit a migration that has been applied.

## Build and deploy

1. Run `npm test` and make sure nothing fails.
2. Rebuild the Edge Function with `node tools/build-edge.js`. This writes `supabase/functions/api/index.ts`. Never edit that file by hand.
3. Deploy the function with `supabase functions deploy api` (needs the Supabase CLI and the owner's approval).
4. Build the static site with `npm run build`. Set `API_BASE_URL` first if the function lives somewhere other than the default project URL. The result in `dist/` is two files, `index.html` and `config.js`.
5. Publish `dist/` to Cloudflare Pages. See `README_CF_PAGES.md`.

The admin panel is the static site on Cloudflare Pages. It calls the Edge Function over HTTPS. The function's own `GET /` route is not a working admin page, so do not open the function URL in a browser to use the app.

## Features

- **Sales tracking**: products, accounts, codes, wallets, suppliers, customers, expenses and purchases.
- **Payment matching**: bKash messages posted to the API's `/relay` route (the shape the old relay script used) are stored in the inbox and, when the reference clearly names one active subscription, matched automatically (payment written, audit action starting with `auto`, so Undo skips it). Anything unclear, any Upay message, and any amount above `auto_match_max_bdt` (default 5000) stays for manual matching in the panel.
- **Pay pages**: `GET /pay/<sub code>` shows a customer the amount due for a subscription code.
- **Reminders**: the `home` action works out which renewal and overdue reminders are due, and the panel builds WhatsApp and Discord message text for them. By default an overdue reminder repeats every 5 days.
- **Undo**: every write is recorded in an audit log, and the `undo` action reverses the latest batch that was not automatic.
- **Idempotent writes**: each write carries a request ID, so a repeated request does not apply twice.
- **Export**: the `export` action returns all tables for download.
- **Live USDT-BDT rate**: cached only in the `live_rates` table.

## Known gaps

- **No scheduled jobs.** Reminders are computed each time the `home` action is read (`Core.reminders.planReminders`). Nothing in this repository runs on a timer. The old triggers for matching the inbox, building reminders and backing up were dropped when the previous script host was removed. If automatic matching or backups are needed, they must be added as a new piece of work.
- **The Edge Function's `GET /` page is not a working UI.** Use the static site instead.
- **The old sheet data is already in the live project.** A check on 2026-10-23 found 64 customers, 102 sales and 90 payments. `tools/migrate-to-supabase.js` and the snapshot `tools/migrate-output.json` are the old one-off import and are unverified. Do not run the script against the live project; it could duplicate or overwrite data.

## Migration from Google Sheets

The app used to run on Google Sheets. The snapshot of that data is `tools/migrate-output.json` (exported on 2026-10-18), and `supabase/migrations/001_schema.sql` mirrors the sheet's structure. The import itself has already been done on the live project, as described under Known gaps.

## The bKash relay

`reference_PaymentRelay_v9.gs` is the original relay script that receives bKash messages from the phone. It is kept as a read-only reference and must not be edited. `src/server/edge.js` contains a port of its logic behind `POST /relay?src=bkash`, with the body `{ token, sender, text }`.

## Security

- Row level security is on for every table, with no policies. The service role bypasses it, and only the Edge Function holds that role.
- There is no public anon-key path to the data. Do not add one.
- The API checks `X-App-Secret` on every POST and refuses to run when `APP_SECRET` is unset (fail closed). `/relay` does the same with `RELAY_TOKEN`.

## USDT to BDT rate

The panel shows one rate, in this order: the manual rate from Settings (`usdt_bdt_manual`), else the cached Bybit P2P rate in `live_rates`, else none.
- `refreshRate` takes the median of the five cheapest Bybit P2P ads and caches it. It skips the network while the cache is under 5 minutes old.
- The Bybit endpoint is unofficial. Whether Supabase's servers can reach it is only known after a deploy. If it is blocked, set a manual rate.
- With no rate, USDT costs count as 0 and the Profit tab says the profit is incomplete. There is no silent fallback rate.

## Payment relay

`POST <function URL>/relay?src=<bkash|upay|nagad>` with JSON `{ "token": "<RELAY_TOKEN>", "sender": "<SMS sender>", "text": "<message text>" }`.
- `sender` is what the phone shows as the SMS sender (bKash `16247`, Upay `16268`, Nagad `16167`). It identifies the provider, not the payer.
- Provider is found from `src`, then from `sender`, then (Nagad only) from the wording.
- Upay received messages are stored with status `Review` until real customer payments have been seen. Upay "Fund Transfer Successful" messages are skipped.
- Nagad Money Received and Cash In Received are stored `Pending`. For a cash-in, the `Uddokta:` number is the counterparty. A reference of `N/A` or an empty `Ref:` is stored empty.
- iPhone: Shortcuts, Automation, "Message" from the provider, action "Get Contents of URL" (POST, JSON body above, with the Shortcut variable "Sender" for `sender`).
- Android: an SMS-forwarding app such as MacroDroid or Tasker, same URL and body. No Android code is shipped.
- Upay and Nagad parsing was written from the described wording, not from real messages. Test with your own messages before relying on it (`test/fixtures/sms-upay-nagad.js` holds synthetic samples).

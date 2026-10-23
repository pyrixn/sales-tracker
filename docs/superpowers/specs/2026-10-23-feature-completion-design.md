# Feature Completion Design (sub-project 2 of 5)

## Context

The Sales Tracker is a private panel used by one person. Sub-project 1 (Foundation) made the repository consistent and safe. This sub-project closes the gaps found when the admin-panel plan (`docs/superpowers/plans/2026-10-23-admin-panel-implementation.md`) was audited against the code on 2026-10-23.

What already exists and is tested: suppliers (add only), gift-card batches (add only), the profit dashboard, multi-currency cost, per-product reminder templates, and Upay/Nagad sender recognition. What is missing or wrong:

1. The live USDT to BDT rate is never fetched. `Core.util.getLiveRate` only reads a cached row, `live_rates` is empty, and `Core.ledger.saleCostBdt` silently falls back to a hard-coded 120. A check on 2026-10-23 showed Bybit P2P ads at about 128, so USDT costs are understated by about 6 percent. The Bybit URL named in the old design (`/v5/market/tickers?category=linear&symbol=USDTBDT`) returns `symbol invalid`; USDT/BDT is not a Bybit market pair.
2. Nothing runs on a schedule. The Apps Script triggers (payment auto-match, reminder queue, backup) were removed with `main.js`, the monthly profit snapshot has never run (`profit_snapshots` is empty, and the project has no `pg_cron`), and the relay stores payment messages but never matches them.
3. Suppliers and batches cannot be edited or deleted. `supabase/functions/profit-snapshot/index.ts` carries its own copy of `profitByFamily`, which breaks the rule that domain logic lives only in `src/core/`.
4. Upay and Nagad messages are handled badly or not at all (details in part 4).

## Decisions made

- Scope: all four gaps above.
- Live rate: approach C. Fetch automatically, allow a manual override, and mark a stale rate as stale.
- Scheduled jobs: event-driven, no timers. No `pg_cron`, no `pg_net`.
- Upay and Nagad: the sender sent by the phone identifies the provider. The message wording is not trusted for Upay. Android gets a documented recipe, not an app.
- The API stays action-based (`POST` with `{ action, payload }`). The REST routes `/suppliers` and `/rates/usdt-bdt` from the old design are not built.

## Out of scope

The UI redesign (sub-project 3; the functional UI added here uses the current style), `pg_cron`, backups, an Android app, deploying the Edge Function, and removing the deployed `profit-snapshot` function from Supabase. If the Bybit endpoint turns out to be blocked from Supabase, the manual override covers it and no work-around is built.

## Part 1: Suppliers and batches

New planners in `src/core/sales.js`, each returning the usual `{ ops, result, errors }` so the audit log and Undo work:

- `planSupplierEdit(state, { supplierId, name?, contact?, currency?, markupPercent?, notes? })`. Errors for an unknown supplier, an empty name, a duplicate name (case-insensitive, other than itself), or a currency other than USDT or BDT.
- `planSupplierDelete(state, { supplierId })`. Errors for an unknown supplier, and when any product has this `Supplier_ID`, with a message naming how many products use it.
- `planBatchEdit(state, { batchId, tag })`. Changes the `Source / Batch` tag on every code in the batch. Errors for an unknown batch or an empty tag.
- `planBatchDelete(state, { batchId })`. Removes the batch's codes. Errors for an unknown batch, and when any code in the batch has status `Sold`; the message says how many are sold.

New Edge Function actions in `src/server/edge.js`: `editSupplier`, `deleteSupplier`, `editBatch`, `deleteBatch`. Each commits through the existing `commit_` helper, so writes stay idempotent and logged.

UI: edit and delete buttons in the Suppliers sheet and the batch list, using the existing sheet pattern. Delete asks for confirmation. No visual redesign here.

Duplicate logic: add `Core.views.profitSnapshotRow(state, month)` returning `{ month, revenue_bdt, cost_bdt, profit_bdt }` built on the existing `profitByFamily`. Delete `supabase/functions/profit-snapshot/` from the repository. The deployed function on Supabase is left alone and handled at release time with the user's approval.

## Part 2: Live rate

Core, new module `src/core/rates.js` (pure, no I/O):

- `pickRate(ads)`: takes the list of P2P ads (each with a numeric `price`), sorts ascending, takes the first 5, and returns their median rounded to 2 decimals. Returns null for an empty list or when no ad has a positive price.
- `resolveRate(state, now)`: returns `{ rate, source, fetchedAt, stale }`. Order: a manual override from the `usdt_bdt_manual` setting when it is greater than 0 (`source: 'manual'`); else the `live_rates` row when it is at most 5 minutes old (`source: 'bybit'`, `stale: false`); else the same row when older (`source: 'bybit'`, `stale: true`); else `{ rate: null, source: 'none', stale: true }`.
- `Core.util.getLiveRate` is replaced by `resolveRate`, and every caller (`ledger.js`, `views.js`) is updated.
- `Core.ledger.saleCostBdt` no longer falls back to 120. With no rate it converts USDT cost at 0 and the dashboards mark the result `rateMissing: true`. `profitByFamily` rows and the profit view carry that flag so the UI can say "rate missing, profit incomplete".

Edge Function:

- New action `refreshRate`. It fetches `POST https://api2.bybit.com/fiat/otc/item/online` with body `{ "tokenId": "USDT", "currencyId": "BDT", "side": "1", "size": "10", "page": "1", "amount": "" }` and a 5 second timeout, takes the prices of `result.items`, calls `Core.rates.pickRate`, and upserts the `live_rates` row `usdt_bdt` with the rate and `Fetched_At`. If the fetch fails, times out, returns a non-success code, or yields no usable price, the action returns `{ ok: false, error }` and writes nothing.
- The HTTP call goes through an injectable function (`fetchAds_`), so tests never use the network.
- The panel calls `refreshRate` in the background after load whenever `lookups.rate.stale` is true. A failure is silent apart from the stale label.

UI: Settings gets a manual rate field (blank means no override). The USDT calculator and the More tab row show the rate, its source (Bybit or manual), and its age, with a "stale" marker when applicable.

Known risk: the Bybit endpoint is unofficial and undocumented. It was reachable from a local machine on 2026-10-23, but reachability from Supabase's servers can only be confirmed after a deploy. The manual override is the fallback.

## Part 3: Event-driven jobs

- Auto-match at ingest. After `relayIngest` stores a row with status `Pending`, it reads the state and calls `Core.matching.planInboxMatch(state, row)` with no manual argument. If the plan's status is `auto`, it applies the ops through `Adapter.applyOps` with an action name beginning `auto` (so Undo skips it, as before). Rows with status `Review` (all Upay received messages) are never auto-matched. A planning or write error leaves the row as `Pending` and is returned in the relay result.
- Monthly snapshot. New action `snapshotIfDue`. It computes the previous calendar month in Asia/Dhaka. If `profit_snapshots` has no row for that month, it builds the row with `Core.views.profitSnapshotRow` for that month and inserts it. Otherwise it does nothing. The panel calls it once per load. It is idempotent because `Month` is the key. Months are valued at the current rate, so past snapshots are approximate; this is stated in the README.
- No timers, no `pg_cron`. Reminders remain computed on read.

## Part 4: Upay and Nagad relay

Contract (documented in the README): `POST <function URL>/relay?src=<bkash|upay|nagad>` with a JSON body `{ "token": "<RELAY_TOKEN>", "sender": "<SMS sender>", "text": "<message text>" }`. The sender comes from the phone, for example the iPhone Shortcut variable "Sender". It identifies the provider, not the payer.

Source detection, in order: the `src` query tag; then the sender (bKash `16247` or "bKash", Upay `16268` or "Upay", Nagad `16167` or "Nagad"); then, for Nagad only, the wording. `RELAY_SOURCES` gains `upay: { method: 'Upay', sender: '16268' }`.

Parsing, in `parseSms_` in `src/server/edge.js` (the messages are provider formats, not domain rules):

- Upay, "has been received" (and no phone number): type `Received`, counterparty empty, status `Review`. All Upay received messages are `Review`, because no real customer payment has been seen yet.
- Upay, "Fund Transfer Successful ... to <bank>": skipped with the reason "outgoing transfer".
- Nagad, "Money Received" and "Cash In Received": type `Received`, status `Pending`. For cash-ins the `Uddokta:` number is stored as the counterparty. The user decides whether each is a customer payment.
- The reference parser accepts `Ref:` and `Ref :` with a colon. A reference of `N/A` (any case) or an empty value is stored as empty.
- bKash parsing is unchanged, and its existing tests must still pass.

The six messages pasted by the user on 2026-10-23 become test fixtures in `test/fixtures/` (under a name such as `sms-upay-nagad.js`) with the phone numbers replaced by invented numbers, and each fixture asserts the stored type, method, amount, transaction ID, counterparty, reference and status.

README: a "Payment relay" section with the contract above, an iPhone Shortcut recipe (automation on received message from the provider, action "Get Contents of URL" with the JSON body), and an Android recipe using an SMS-forwarding app such as MacroDroid or Tasker with the same URL and body. No Android code is written.

## Testing

- All new core code has unit tests first (RED, then GREEN): `rates.js`, the four supplier and batch planners, `profitSnapshotRow`, `resolveRate`.
- Edge behavior is tested through `loadEdge` on the fake database from `test/support/`: the four new actions, `refreshRate` (fetch stubbed: success, failure, timeout, empty list, no positive prices), `snapshotIfDue` (due, not due, idempotent on a second call), auto-match at ingest, and the six relay samples.
- The existing 152 tests must keep passing. Tests that assume the 120 fallback or the old `getLiveRate` are updated, and each such change is stated in the commit.
- UI tests (mocked API) cover the supplier edit and delete flow, the manual rate field, and the stale label.

## Acceptance

- `npm test` passes with the new tests included.
- `node tools/build-edge.js` leaves the committed bundle consistent with `src/`.
- Nothing is deployed and no remote change is made by this work. Applying anything to Supabase, redeploying the `api` function, and deleting the deployed `profit-snapshot` function each need the user's explicit approval afterwards.

## Risks

- The Bybit endpoint may be blocked or change. Mitigation: the manual override and the stale label.
- Removing the silent 120 fallback changes displayed profit as soon as it ships. The profit view says when a rate is missing.
- Auto-match at ingest writes to the database from the relay path. It uses the same planner as manual matching and is skipped for Review rows, which limits the blast radius; the `auto` action name keeps it out of Undo, as it is today for automatic payments.
- Upay message formats are guessed from three samples that were not customer payments. All Upay received messages stay in `Review` until real customer payments have been seen.

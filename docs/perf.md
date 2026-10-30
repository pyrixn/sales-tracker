# Performance

Measured by `node tools/measure.js` through the real Edge router over a seeded fake db: 64 customers, 110 sales, 100 payments, 300 inbox rows.

queries = SQL statements, rows = rows returned by them, bytes = JSON response size, roundTrips = statements plus BEGIN/COMMIT per transaction, ms = median of 5 runs (fake db, so only comparable run to run). These count what the adapter asks the database for, not network or Postgres time.
An action that errors under the seed shows as an error row and has no budget.

## Baseline

| action | queries | rows | bytes | roundTrips | ms |
|---|---:|---:|---:|---:|---:|
| moneyOverview | 12 | 357 | 2490 | 1 | 2 |
| moneyExport | 10 | 357 | 469 | 1 | 1.3 |
| init | 20 | 690 | 117954 | 3 | 5.9 |
| home | 15 | 688 | 79431 | 2 | 3.1 |
| lookups | 11 | 371 | 38399 | 1 | 1.9 |
| customer | 6 | 323 | 1141 | 1 | 0.9 |
| reminderMessage | 5 | 323 | 897 | 1 | 0.6 |
| dues | 5 | 323 | 3708 | 1 | 0.6 |
| accounts | 8 | 340 | 32042 | 1 | 1 |
| payLinks | 8 | 640 | 25194 | 1 | 1.3 |
| orders | 6 | 143 | 32 | 1 | 0.3 |
| payRequests | 10 | 653 | 30 | 1 | 0.7 |
| deliveries | 7 | 253 | 30 | 1 | 0.4 |
| book | 7 | 230 | 3456 | 1 | 0.3 |
| entry | 9 | 631 | 731 | 2 | 0.7 |
| product | 6 | 340 | 18213 | 1 | 0.5 |
| profit | 7 | 323 | 775 | 1 | 0.6 |
| importReview | 9 | 670 | 394 | 1 | 0.7 |
| profitMonthly | 8 | 293 | 6023 | 1 | 1.6 |
| suggestCustomers | 7 | 640 | 368 | 1 | 1.1 |
| newSale | 14 | 374 | 181 | 12 | 0.9 |
| pay | 10 | 325 | 186 | 10 | 0.8 |
| renew | 14 | 281 | 225 | 14 | 0.9 |
| match | 31 | 694 | 121 | 14 | 1.2 |
| editPayment | 28 | 691 | 133 | 11 | 0.8 |

## Budgets

Raised by 8 rows on every action, and bytes on init, home and lookups (the settings rows they return) (2026-10-28): migration 020 adds 8 settings rows (notification switches, WhatsApp template names, bKash account name), and every action reads the settings table.

The most an action may use. `test/perf-budget.test.js` fails when an action exceeds its row. ms is never gated.
Set to the numbers measured after table-scoped reads (Task 2), +0%; roundTrips added after concurrent reads (Task 3), +0%; init and home raised by the version read (Task 4, one statement, one row, run before the state reads). Lower a row after a speed-up lands. Edit by hand (this tool keeps an existing table). Write responses now carry `changed` (inline-edit stage 1, `commit_` in src/server/edge.js): +15 bytes (`,"changed":true`) on every write, so the write rows newSale, pay, renew, match and editPayment rose by 15. Stage 1c: a logged write also carries `batchId` (the change_log batch, a 36-character UUID, the handle Undo takes): +49 bytes (`,"batchId":"<uuid>"`) on each of those rows. A no-op or unlogged write carries none. Stage 2.3: each dues row carries the sale paidTill and unitPrice for the inline Paid till and Price cells, so the dues budget rose from 3024 to 3554 bytes (+530 on the seeded fixture). Fix wave: each dues row also carries `months` (for the per-month price hint), +11 bytes a row, so the dues budget rose from 3554 to 3708 bytes. Stage 3 (inline edit for Payments and Book): each payment row carries `note` and `locked` (the per-field edit rules, from Core.sales.paymentLocks), so the customer budget rose from 1102 to 1124 bytes; each book row carries its raw fields (expense category and note, purchase account, covers-until and notes, payment note and locked), and the reads that build payment rows (customer, reminderMessage, book, moneyOverview, moneyExport) now read Pay_Requests for the pay-link lock, so book rose from 2584 to 3456 bytes and its query count from 6 to 7 (customer 5 to 6, reminderMessage 5 to 6, moneyOverview 12 to 13, moneyExport 10 to 11). Fix wave: the lock map is built only when asked (`withLocks`, set by the customer and book reads), so only those two read Pay_Requests for it. moneyOverview, moneyExport and reminderMessage went back to 12, 10 and 5 queries; the budget rows for them are lowered to match. QOL batch 1 (item A): `home` carries `topUps` (the wallet top-ups, listed apart from payments not matched), +12 bytes on the init response, so the init budget rose from 115784 to 115796 and home from 79149 to 79161. QOL batch 1 (item B): the Today needs-attention counts (`attention`) read Deliveries, Expenses, Purchases and Budgets as well, so init rose from 17 to 20 queries (+3 statements, +69 bytes) and home from 11 to 15 queries (+69 bytes, 678 rows measured on the seed). The budget counts need Expenses and Purchases for the same spend the Money tab shows, so the scoped read keeps them. Custom sales (split-match plan, Task 2): `customer` carries `customSales` (always an array, `[]` when there are none), +17 bytes (`,"customSales":[]`), so the customer budget rose from 1124 to 1141 bytes. Renew from and paid-till (split-match plan, Task 3): the renew response carries `paidTill` and `start` (+45 bytes, `,"paidTill":"2026-12-18","start":"2026-10-18"`), so the renew budget rose from 180 to 225 bytes. Rent product (rent-product plan, Task 8): each lookups product entry carries `poolId` (the account pool, +195 bytes on the seed), so lookups rose from 36544 to 36739 bytes and init (which includes lookups) from 115865 to 116060; the newSale response carries `accountId` (`,"accountId":"EXL-01"`, +21 bytes), so newSale rose from 160 to 181 bytes. Friendlier reminder templates (Task 12): the built-in default texts are longer and `lookups` carries `templateDefaults`, so lookups rose from 36739 to 37199 bytes and init from 116060 to 116520; the reminderMessage response carries the longer default text, so reminderMessage rose from 860 to 897 bytes. Random references (migration 013, `ref_style` setting row): every action that reads the settings table returns one more row, so every rows budget rose by 1; init and home also carry the setting in their bytes (+17 each, 116520 to 116537 and 79230 to 79247). Settings editor: lookups now carries every stored setting (`settings` is the full row set with the defaults on top), so init rose from 116537 to 116637 bytes (+100 on the seed) and lookups by the same amount; every settings-reading action is unchanged in rows. Migration panel (migration 014): the `migration_panel` setting row adds one row to every settings-reading action (every rows budget +1) and bytes to init (+42), home (+19), lookups (+23) and entry (+17); the new rows importReview (`{}` payload, so the newest batch, over a seed with no staged rows) and profitMonthly (`{}`, the last 6 months) are the numbers `node tools/measure.js --check` printed on 2026-10-28 over the standard seed (64 customers, 110 sales, 100 payments, 300 inbox rows), +0%. importReview grows with the number of staged rows, which the seed does not have, so re-measure with staged rows before trusting its bytes. Phase 4 orders (migration 018): each lookups product entry carries the catalog fields (slug, public, description, imagePath, sortOrder, publicPrice, +880 bytes on the seed), so lookups rose from 37322 to 38202 bytes and init from 116679 to 117559. readState loads every table for actions without a NEEDS_ entry, so the Orders table adds one query to match (30 to 31) and editPayment (27 to 28). Public API (phase 5): renew queues `subscription.renewed`, which reads the webhook endpoints once, so renew rose from 13 to 14 queries and round trips (the one extra statement of the write, +0 rows, +0 bytes). Staff accounts (phase 2): init carries `me` (+33 bytes on the seed), so the init budget rose from 117921 to 117954. Insights (uplift plan 2.2): new read `insights`, default range (12 full months plus the current), measured with `node tools/measure.js --check` over the same seed: 8 statements (Settings plus the seven tables in its NEEDS_ entry; Accounts was added so deleted accounts' lines are not counted as live), 331 rows, 5623 bytes, 1 round trip; the row is the measured numbers +0%. Profit with a collected figure (uplift plan 2.4): every profit family and product row carries `uncollected` and `collectedProfit`, and the `profit` response carries `totals`, so `profit` rose from 775 to 1173 bytes (+398 measured on the seed). The moneyOverview product and account rows carry the same two fields; on the seed the current month has no sales, so its measured size stayed 2490 and its budget is unchanged. Inbox (uplift plan 4.1): new read `inbox`, measured with `node tools/measure.js --check` over the same seed (300 inbox rows, all inside the 90-day window, so the 300-row limit applies): Settings plus the Payment_Inbox and Payments tables in its NEEDS_ entry, 3 statements, 430 rows, 57101 bytes, 1 round trip; the row is the measured numbers +0%. Reminders queue (uplift plan 4.2): new read `reminderLog`, measured with `node tools/measure.js --check` over the same seed plus 320 Reminders_Log rows over the last 60 days (the base seed has none, so `addReminderLog` in tools/measure.js adds them for this action only; 320 is more than the 300-row cap, so the cap applies and the row is the most the screen can get back): Settings plus the four tables in its NEEDS_ entry, 5 statements, 534 rows, 57417 bytes, 1 round trip; the row is the measured numbers +0%. Each dues row carries `custom` (true for a custom sale, so the Reminders and Dues actions are hidden on it), +15 bytes a row (`,"custom":false`), so the dues budget rose from 3708 to 3918 bytes on the seed (+210, measured). Activity (uplift plan 4.3): new read `activity`, the newest 100 change batches, measured with `node tools/measure.js --check` over the same seed plus 160 batches of 10 Change_Log lines (1600 lines, more than its 1500-line read window, so the window applies; `addChangeLog` in tools/measure.js adds them for this action only). Its NEEDS_ entry is empty because it reads Change_Log only, so readState loads Settings alone: 2 statements in 2 round trips (the settings read, then the change_log read), 1530 rows (30 settings and 1500 change lines), 21235 bytes; the row is the measured numbers +0%. Customer workspace (uplift plan 4.5): each history row of the customer read now carries `saleDate` (the Sale_Date, `"saleDate":""` when blank), so the timeline and the first-sale figure can be built from the read with no new read. On the seeded customer (one sale, no date) the customer budget rose from 1141 to 1155 bytes (+14, measured with `node tools/measure.js --check`); a dated row adds the date text. All other rows are unchanged. Stock and capacity alerts (uplift plan 4.8): `home` carries `stock` (one entry per code product at or below the low-stock threshold, and per full or renewing account), and `lookups` carries `low_stock_threshold` in its settings (3 unless set, so the All settings editor lists it). Measured with `node tools/measure.js --check` over the same seed: the seed gives 6 stock entries (one code product with 2 codes left, five full accounts), so home rose by 528 bytes, from 79247 to 79775, and lookups by 24 bytes, from 37299 to 37323; init carries both, so it rose by 552, from 116637 to 117189. No statement or row is added: the home read already loads Accounts, Code_Inventory, Product_Catalog and Sales_Log.

| action | queries | rows | bytes | roundTrips |
|---|---:|---:|---:|---:|
| moneyOverview | 12 | 357 | 2490 | 1 |
| moneyExport | 10 | 357 | 469 | 1 |
| init | 20 | 690 | 118506 | 3 |
| home | 15 | 688 | 79959 | 2 |
| lookups | 11 | 371 | 38423 | 1 |
| customer | 6 | 323 | 1155 | 1 |
| reminderMessage | 5 | 323 | 897 | 1 |
| dues | 5 | 323 | 3918 | 1 |
| accounts | 8 | 340 | 32042 | 1 |
| payLinks | 8 | 640 | 25194 | 1 |
| payRequests | 10 | 653 | 30 | 1 |
| deliveries | 7 | 253 | 30 | 1 |
| book | 7 | 230 | 3456 | 1 |
| entry | 9 | 631 | 731 | 2 |
| product | 6 | 340 | 18213 | 1 |
| profit | 7 | 323 | 1173 | 1 |
| importReview | 9 | 670 | 394 | 1 |
| profitMonthly | 8 | 293 | 6023 | 1 |
| insights | 8 | 340 | 5623 | 1 |
| inbox | 3 | 439 | 57101 | 1 |
| reminderLog | 5 | 543 | 57417 | 1 |
| activity | 2 | 1539 | 21235 | 2 |
| suggestCustomers | 7 | 640 | 368 | 1 |
| newSale | 14 | 374 | 181 | 12 |
| pay | 10 | 325 | 186 | 10 |
| renew | 14 | 281 | 225 | 14 |
| match | 31 | 694 | 121 | 14 |
| editPayment | 28 | 691 | 133 | 11 |

## Bundle budget (Task 6)

First load ships the shell and Today; the other seven screens are separate chunks fetched on first visit (retry, then an error state with a Retry button). Vendor code is split into `react`, `motion`, `lucide` and `radix` chunks. The initial set is whatever `dist/index.html` references (the entry script plus its modulepreloads), summed after gzip (`node tools/build.js` prints it).

Before: one chunk, 251195 bytes gzip (245.3 KB; measured with the gzip CLI, about 25 bytes more than node's zlib). After: entry 69997 + react 69425 + motion 47971 + radix 39610 + lucide 8080 = 235083 bytes (229.6 KB), 6.4% less; Customers, Dues, Money and the rest (about 25 KB gzip together) no longer load up front. Most of what remains is library code; the entry holds Today, the shell and the sheets.

Budget: initial JS gzip bytes <= 258591 (the measured 235083 + 10%). `test/build.test.js` enforces it. Raise it by hand only with a reason.

Settings as a screen (uplift plan 4.7): the initial set grew by 1137 bytes gzip, from 258200 at HEAD to 259337 on this branch (both measured with `node tools/build.js` and `gzipSizes`). The growth is in the first chunk because the shell now holds the leave-with-unsaved-edits guard and dialog (App.jsx, lib/navGuard.js), the theme now follows a change made in any toggle (lib/theme.js), and the settings fields moved out of sheets/misc.jsx into components/settings/ so that the Settings and Payment methods sheets and the Settings screen share one copy of each form. The Settings screen itself is a lazy chunk of about 2.0 KB gzip. The budget rises by exactly the measured 1137 bytes, from 258591 to 259728.

Renewals calendar (uplift plan 4.4): the initial set grew by 224 bytes gzip, from 259625 at HEAD to 259849 on this branch (both measured with the same `gzipSizes` call on `buildSite`). The growth is in the first chunk for two small reasons: AppShell and CommandPalette import the `CalendarDays` icon for the new Calendar entry, and App.jsx and the shortcut text carry one more tab. The calendar screen itself is a lazy chunk, and the shared calendar component only gains optional props. No new read, so no Budgets row. The budget rises by exactly the measured 224 bytes, from 259728 to 259952.

Customer workspace (uplift plan 4.5): the initial set grew by 1827 bytes gzip, from 259849 at HEAD to 261676 on this branch (both measured with the same `gzipSizes` call on `buildSite`). The growth is in the first chunk because `sheets/customer.jsx` now renders `CustomerDetail` (the body moved out of the sheet, unchanged), and `openers.jsx` imports the sheet eagerly, so the body is in the shell. That body also carries the workspace-only figures, timeline and ID chip (`web/src/lib/customerStats.js`, `CustomerDetail.jsx`), and the routing (`parseRoute` and the route state in `App.jsx`) and the list-focus rule in `AppShell.jsx` are in the shell too. The workspace list (`CustomerWorkspace.jsx`, Virtuoso) loads in the Customers chunk. The budget rises by exactly the measured 1827 bytes, from 259952 to 261779.

Header bell (uplift plan 4.6): the initial set grew by 300 bytes gzip, from 261676 at HEAD to 261976 on this branch (both measured with the same `gzipSizes` call on `buildSite`). The growth is the header slot that AppShell now renders: `NotificationBellSlot.jsx` (a disabled placeholder button, a Suspense boundary and the lazy import). The bell itself (the popover list, the attention hook and the unread store in `lib/attention.js`) is the `NotificationBell` chunk, about 1.6 KB gzip, fetched just after the shell paints and outside the initial set, so the list costs nothing on first load. The budget rises by exactly the measured 300 bytes, from 261779 to 262079.

Stock and capacity alerts (uplift plan 4.8): the initial set grew by 241 bytes gzip, from 261976 at the last recorded HEAD measurement (the bell step) to 262217 on this branch (both measured with `gzipSizes` on `buildSite`). The growth is in the first chunk because Today's AttentionStrip now renders the stock chips and imports `web/src/lib/stock.js` (a pure grouping helper, kept apart from `lib/attention.js` so Today does not pull the store-using bell module in), and the chips and their wording are in the shell. The Accounts "Low stock" chip is in the Accounts chunk, and the bell item in `lib/attention.js` is in the lazy bell chunk. The budget rises by exactly the measured 241 bytes, from 262079 to 262320.

Error boundaries and Retry (uplift plan 5.4): the initial set grew by 338 bytes gzip, from 262261 at HEAD (the density step, 5.3) to 262599 on this branch (both measured with `gzipSizes` on `buildSite`). The growth is in the first chunk because Today is now wrapped in `ScreenBoundary` (the same boundary the lazy screens use, and it lives in `lazyScreen.jsx`, which the shell already imports): the chunk-or-generic message, the `componentDidCatch` log, and the test-only crash probe that reads `window.__TEST_CRASH__`. The budget rises by exactly the measured 338 bytes, from 262320 to 262658.

Pull to refresh (uplift plan 5.5): the initial set grew by 456 bytes gzip, from 262599 at HEAD (the error boundaries step, 5.4) to 263055 on this branch (both measured with `gzipSizes` on `buildSite` with the API URL that `test/build.test.js` uses). The growth is in the first chunk because AppShell imports the pull hook (`web/src/lib/pullToRefresh.js`: a few passive window listeners, no library) and renders the Refreshing chip in the header. The one CSS rule (`overscroll-behavior-y: contain` on touch phones, so the browser's own pull-to-reload does not run) is CSS and is not counted in this number. The budget rises by exactly the measured 456 bytes, from 262658 to 263114.

bundle-budget-bytes: 272117

Integration merge (uplift UI branch into the staff, jobs, orders and public API branch): the initial set measured 270135 bytes gzip with both sets of screens, nav and shell code in the first chunk. The budget is the measured number; it was 263114 on the uplift branch and 258591 before it.

Migration-panel merge: initial set now 270525 bytes gzip (was 270135); the budget is the measured number.

Payment logos (ported from phase1-editing): the initial set grew by 405 bytes gzip, from 270525 to 270930 (icons.jsx and its uses in PayLinks and the shared settings fields land in the first chunk; the PNGs are public assets, not JS). The budget is the measured number.

Total-price mode and delivery/logins/vault UI: the initial set grew 1176 bytes gzip, from 270930 to 272106 (measured with `gzipSizes`). Part is the shared `PriceInput` (Per month | Total toggle) used by New sale, Renew, split-match and the sale edit form, which lives in the first chunk through the sheets. The budget is the measured number.

Integration merge (vault, delivery, price input): the initial set grew 11 bytes gzip, from 272106 to 272117 (measured with `gzipSizes`). The budget is the measured number.

# Data migration panel and monthly profit (design, 2026-10-28)

Owner decisions (2026-10-28): profit is spread by month; ExitLag keys are staged and reviewed; the sheet reaches the panel through a local script; work happens on branch `migration-panel` from `live-deploy-logos-settings`.

## 1. What the rules get wrong today

Checked in `src/core/ledger.js`, `src/core/views.js`, `src/core/sales.js`, `src/adapters/postgres.js`:

1. **Slot cost ignores time.** `Cost_Snapshot` defaults to `Cycle_Cost / Slots` (computed in the adapter, `Cost_Per_Slot`). A 3-month sale on a monthly Netflix account carries one month of cost; a 1-day ExitLag rent on a 90-day account carries a full 90-day seat cost.
2. **Empty seats cost nothing.** Profit is the sum over sold seats of price minus seat cost. The owner's sheet does collected minus the full account cost, so unsold seats reduce profit. The app overstates profit whenever an account is not full.
3. **Revenue lands in the sale month.** `profitByFamily(state, month)` filters by `Sale_Date`, so a 3-month prepayment counts entirely in one month and the next two months show nothing.
4. **Account-level extra collections have no home.** The sheet adds amounts like `+50+240+450` to an account's collected total (1-day and 1-month rents, custom amounts). The app can store them as rent or custom sales, but nothing ties them to the account's monthly result.

## 2. Monthly profit (new rule, `src/core/accrual.js`)

Pure functions over the state. Dates are Dhaka `YYYY-MM-DD`; a period is half-open `[start, end)`.

- **Sale coverage.** `end = Paid_Till`. `start = Covers_From` when set (new column), else `addCycle(Paid_Till, -Months, cycle)` where `cycle` is the product's `Billing_Cycle_Days`, else `Sale_Date`. Sales with no `Paid_Till` (codes, custom sales) are a single day on `Sale_Date`.
- **Revenue by month.** `saleRevenue` (unchanged) is spread over the coverage period; each month weighs the fraction of that calendar month covered, so a whole month counts 1 whatever its length (a 3-month payment of 900 from the 1st gives 300, 300, 300). Void and Refunded give 0, as today.
- **Account cost by month.** Each Purchases row (`Amount`, `Covers_Until`) is spread over `[start, Covers_Until)`, where `start` is the previous purchase's `Covers_Until` for the same account, else `Covers_Until` minus one account cycle (the account product's `Billing_Cycle_Days`), else the purchase `Date`. A purchase with no `Covers_Until` covers one cycle from its `Date`. This is the full account cost, so empty seats count.
- **Sale cost.** A sale on an account that has at least one purchase carries no cost of its own (the account cost covers it). Any other sale (codes, custom sales, accounts with no purchase yet) keeps today's `saleCostInfo` cost, spread over the same coverage as its revenue (a single day for codes and custom sales), and the account is listed under `costMissing` so the owner adds its purchase.
- **Output** `monthly(state, { from, to })`: `{ months: [{ month, revenue, cost, profit, collected, byProduct: [...], byAccount: [{ accountId, label, productId, revenue, cost, profit, seats, seatsUsed }] }], costMissing: [accountId], rateMissing }`. `collected` is payments dated in the month (cash), shown next to the accrued figures.
- New read action `profitMonthly` (`{ from, to }`, at most 24 months). The Money > Profit screen gains a month view with the per-account table the owner used to build by hand. The existing all-time `profit` read is unchanged.

Accepted trade-off: a sale edited to a shorter `Paid_Till` moves revenue between months. That is correct for accrual.

## 3. Migration staging

### Table (migration `014_import_rows.sql`)

`import_rows (row_id text primary key, batch text, kind text, sheet text, ref text, data text, status text default 'Review', note text, applied text, created text)`, RLS on, no policies. Also `alter table sales add column covers_from text not null default ''`.

Adapter tab `Import_Rows` (state `importRows`), so every staging write goes through `applyOps` and the audit log, with request ids like any write.

### Kinds and `data` (JSON text)

| kind | from | data |
| --- | --- | --- |
| `account` | a block header row | `productHint` (tab name), `label`, `collected` (sheet total), `cost`, `renewalDate`, `slots` |
| `line` | a seat row | `accountRef`, `name`, `profile`, `status` (Paid/Due/Unpaid), `amount`, `due`, `paidTill`, `renewalDate`, `coversFrom`, `months` |
| `extra` | each `+N` term in a collected formula | `accountRef`, `amount`, `label` (default "Rent or custom amount"), `coversFrom`, `paidTill` |
| `code` | a key cell in the ExitLag key table | `productHint`, `code`, `family` (HONE, GANKSTER, hellcase, liu kang), `redeemed` |
| `inbox` | a pasted inbox line | the Payment_Inbox fields |

Row ids are deterministic (`batch` + sheet + cell), so running the script twice never duplicates a row.

**Never staged:** passwords, login emails, PINs. The script drops any cell that looks like a credential (contains `@`, `pass`, `pin`, or a `user:secret` pair in a header) and replaces account labels that are emails with the sheet block position. The owner types a label in the panel.

### Core `src/core/importer.js`

- `planStage(state, { batch, rows })`: appends new rows, skips ids already present.
- `review(state, { batch })`: each row with parsed data, `issues` (blank amount, range like `220-250`, text in a number cell, past `paidTill` with status Paid, duplicate name on one account), and a `match`: account by label (case and space insensitive), customer by normalised name, existing active line by account plus customer, inbox row by transaction id, code by code text. Per account: sheet `collected` against the sum of its staged lines and extras, so a missing row shows as a difference.
- `planEditRow`, `planAddRow`, `planDeleteRow`, `planSetStatus` (Review, Approved, Skipped). Applied rows are read only.
- `planApply(state, { rowIds })`: turns Approved rows into the same ops the normal planners produce, in dependency order (account, then line and extra, then code and inbox), marking each row Applied with the ids it created. One batch per call, so Undo reverses it.
  - account: match found and `update` chosen, it updates `Cycle_Cost`, `Renewal_Date`, `Slots`; otherwise `planAccount`. Either way one Purchases row with the sheet cost and `Covers_Until = renewalDate` when none covers that date.
  - line: new customer or the matched one; a Sales_Log row with `Sale_Date = Covers_From = coversFrom`, `Paid_Till`, `Unit_Price = amount`, `Months = 1`, `Record_Status` Active (Ended when `paidTill` is past and the owner marks it so); a payment for the amount unless status is Due or Unpaid. When it matches an existing line, it only adds a payment for the difference between the sheet amount and what is already paid, and updates `Paid_Till`.
  - extra: a sale on the account (rent product if one exists, else the account's product) for customer "Unlogged payment" (already folded into the account's unattributed total by `accountsOverview`), paid in full.
  - code: `planAddCodes` into the product, status Sold when redeemed.
  - inbox: inserted only when the transaction id is new; status kept.

### Local script `tools/stage-tracking.js`

`node tools/stage-tracking.js <xlsx> [--inbox <tsv>] [--out file.json]` reads the workbook with a small built-in XLSX reader (zip + XML; no new dependency), finds blocks by the header row `User Name | Payment Status | Amount`, parses collected formulas for `+N` terms, strips credentials, and writes the staging JSON. `--send` posts it to the `importStage` action using the API URL and secret the owner pastes when asked (never read from `.env`, never printed). Default is a dry run that prints counts only.

### Panel: More > Data migration (`web/src/screens/Migration.jsx`, lazy)

Shown only while the setting `migration_panel` is `on`. Tabs: Accounts, Lines, Extras, Codes, Inbox, with counts per status. Each row: source cell, parsed fields as inline editable cells, the issue list, the match (pick another customer, account or line, or "create new"), and buttons Approve, Skip, Delete. Add row per tab. Each account shows sheet collected against staged total and the difference. Bottom bar: "Apply N approved" with a confirm dialog listing what will be created or updated. After apply, rows show the ids they created with a link to the customer.

## 4. Editing every data point

`planEdit` keeps its allow-lists. Added: `Sale_Date`, `Covers_From`, `Qty`, `Product_ID` (same pool only) on sales; `Covers_Until`, `Date` already on purchases. Inbox rows get an edit for `Reference`, `Counterparty`, `Status`. The customer sheet already edits payments, sales and customers.

## 5. Tests

`test/accrual.test.js`: a 3-month sale splits into three months; a 1-day rent lands in one day's share; a full account and a half-empty account give different profit for the same sales; a purchase spread across a month boundary; an account with no purchase falls back and is listed in `costMissing`; void and refunded give 0; months sum to the all-time revenue.
`test/importer.test.js`: staging is idempotent; credential cells never reach `data`; matches and issues on synthetic rows (no real names); apply creates the expected ops for each kind and marks rows Applied; apply on an existing line adds only the difference; Undo shape.
`test/stage-tracking.test.js`: block detection and `+N` parsing on a synthetic workbook built in the test.
UI test: the panel lists staged rows, an edit saves, Approve and Apply write rows to the fake DB.

# Feature Completion and Hardening: Final Execution Plan

**Supersedes:** `2026-10-23-admin-panel-implementation.md` (already built, 152 tests green) and fills the missing plan for `specs/2026-10-23-feature-completion-design.md` (sub-project 2).
**Adds:** security fixes from the 2026-10-23 review.
**Branch:** `feature-completion` (current). Run `git status` first; another session has been committing here. Do not start with a dirty tree you did not make.

## Global rules

- TDD: failing test, run (RED), implement, run (GREEN). One commit per task.
- Domain logic only in `src/core/`. Never hand-edit `supabase/functions/api/index.ts`; run `node tools/build-edge.js`.
- Never print, copy or commit token values. Never read `.env`, `.mcp.json`, `.claude/settings.local.json` values into output.
- **No remote action without the user's explicit yes:** no deploy, no `migrate-schema.js --apply`, no calls to the live Supabase URL, no deleting the deployed `profit-snapshot` function.
- Gate after every task: `npm run test:core` green. Final gate: `npm test` green.

## Issues found in the earlier plan/specs (and how this plan fixes them)

| # | Issue | Fix in task |
|---|---|---|
| 1 | Auto-match at ingest (spec Part 3) lets a relay request mark a sale paid. `sender` and `Reference` come from the request body, and sub codes are sequential (`N1`, `N2`). `/relay` is open when `RELAY_TOKEN` is unset. A forged SMS would then pay off real dues. | T1 must land before T9 |
| 2 | `APP_SECRET` and `RELAY_TOKEN` fail open (`if (secret && ...)`). README calls `APP_SECRET` "optional". | T1 |
| 3 | `/pay/:subCode` and `/pay/:subCode/status` are public; sequential codes leak customer name, product, bKash number, paid status. | T2 |
| 4 | `.claude/settings.local.json` holds a plaintext auth token and is not gitignored (only untracked by luck). `.codex/` same risk. | T0 |
| 5 | Tokens in `.mcp.json` / `settings.local.json` were exposed in a session transcript. Rotation is the user's job. | T0 (reminder only) |
| 6 | `Access-Control-Allow-Origin: *`. | T3 |
| 7 | Bybit `/v5/market/tickers?symbol=USDTBDT` in the old plan is invalid; spec already replaces it with the P2P endpoint. Keep the spec version. The P2P endpoint is unofficial: manual override is the real fallback. | T5 |
| 8 | `planAddCodesBatch` writes `'Source / Batch'` but never sets `Batch_ID`, though `codes.batch_id` exists. Batch edit/delete then key on a free-text tag that can collide with non-batch codes. | T4 |
| 9 | `snapshotIfDue` runs on every panel load: concurrent loads can race. | T7 (insert `ON CONFLICT DO NOTHING`) |
| 10 | Snapshot values past months at today's rate. | T7 (documented, not fixed) |
| 11 | `refreshRate` makes an outbound fetch per call. | T5 (skip if row is fresh; 5 s timeout) |
| 12 | `profit-snapshot` function has no auth check and duplicates `profitByFamily`. | T6 (delete from repo; remote delete needs approval) |
| 13 | Old plan's 14-day cadence and settings-cache rate. | Already overridden by foundation; do not reintroduce |

---

## T0. Secret hygiene (small, first)

Files: `.gitignore`, `test/repo-hygiene.test.js`.

1. Extend the hygiene test: `git check-ignore` must succeed for `.claude/settings.local.json`, `.claude/settings.json`, `.codex/` and `.mcp.json`. RED.
2. Append those paths to `.gitignore`. GREEN.
3. `git grep -nIE "sbp_[A-Za-z0-9]{10,}|<omniroute-prefix>|sk-[a-f0-9]{8,}"` returns nothing in tracked files (already true; keep as test).
4. Commit. **Tell the user:** rotate the Supabase PAT, the omniroute token and the `ANTHROPIC_AUTH_TOKEN`; I cannot do it.

## T1. Fail-closed auth (prerequisite for T9)

Files: `src/server/edge.js`, `test/server.test.js` (or `edge-host.test.js`).

Tests first (via `loadEdge`):
- POST `{action}` with `APP_SECRET` unset returns 503 `{ok:false,error:'Server not configured'}`; no DB write.
- With `APP_SECRET` set: missing/wrong `X-App-Secret` returns 401; correct returns 200.
- `/relay` with `RELAY_TOKEN` unset returns 503; wrong token 401; correct token proceeds.
- Comparison is constant-time (use a small `timingSafeEqual_` helper; compare equal-length digests).

Implement: replace `if (secret && ...)` and `if (relayToken && ...)` with fail-closed checks. `GET /health` stays open. Update README Deployment: `APP_SECRET` and `RELAY_TOKEN` are **required**. Rebuild edge. Commit.

## T2. Unguessable pay links

Files: `src/core/sales.js`/`ids.js`, `src/server/edge.js`, migration `004_sale_pay_token.sql`, tests.

- New migration (never edit applied ones): `alter table sales add column if not exists pay_token text not null default '';` plus a unique partial index where `pay_token <> ''`.
- Adapter SPEC: `Pay_Token: 'pay_token'` on `Sales_Log`.
- Core: new sales get a 16+ char random token injected through the IdGen (`gen.payToken()`; tests inject a deterministic one; production uses `crypto.getRandomValues`). Renewals reuse the line's token.
- Edge: `/pay/<token>` and `/pay/<token>/status` look up by token. Remove lookup by `Sub_Code`. Unknown token returns the same 404 body as not-found (no enumeration signal).
- Keep `Sub_Code` as the bKash **Reference** customers type; it is not the URL.
- Backfill: a one-off core planner `planBackfillPayTokens` + action, run only with user approval. Existing links stop working; tell the user.
- Escape `r.amount` in `payHtml_`.
- Commit.

## T3. CORS allow-list

`Access-Control-Allow-Origin` from env `ALLOWED_ORIGIN` (default: same-origin only, i.e. omit header). Test: disallowed origin gets no ACAO header; allowed origin is echoed exactly (never `*`). Update `README_CF_PAGES.md`. Commit.

## T4. Suppliers and batches: edit and delete (spec Part 1)

Files: `src/core/sales.js`, `src/server/edge.js`, `src/ui/Index.html`, tests.

- Fix issue 8 first: `planAddCodesBatch` also sets `Batch_ID: batchId`. Batch planners key on `Batch_ID`, not the free-text `Source / Batch`. Legacy codes with empty `Batch_ID` are never touched by batch edit/delete.
- Planners per spec: `planSupplierEdit`, `planSupplierDelete` (blocked while products reference it, message gives count), `planBatchEdit`, `planBatchDelete` (blocked if any `Sold`, message gives count). Case-insensitive duplicate-name check excludes self.
- Edge actions `editSupplier`, `deleteSupplier`, `editBatch`, `deleteBatch` via `commit_`.
- UI: edit/delete buttons with confirm, existing sheet pattern. UI tests with mocked API.
- Commit.

## T5. Live rate (spec Part 2)

Files: new `src/core/rates.js`, `util.js`, `ledger.js`, `views.js`, `edge.js`, UI, tests.

1. `Core.rates.pickRate(ads)`: ascending prices, first 5, median, 2 decimals; null when empty or no positive price. Tests: empty, one ad, ignores zero/NaN, even/odd counts.
2. `Core.rates.resolveRate(state, now)`: order manual (`usdt_bdt_manual` > 0) then fresh row then stale row then none. Replace `getLiveRate` everywhere; update tests that used it.
3. `saleCostBdt`: remove the hard-coded 120. No rate means USDT cost 0 and `rateMissing: true`, propagated through `profitByFamily` and the profit view.
4. Edge action `refreshRate` using injectable `fetchAds_`: skip fetch when the row is under 5 min old; 5 s timeout via `AbortController`; on any failure return `{ok:false}` and write nothing; validate `result.items[].price` is numeric before use; upsert `live_rates`.
5. UI: manual rate field in Settings, rate/source/age/stale label, background refresh when stale, "rate missing, profit incomplete" banner.
6. Commit. Note in README: endpoint is unofficial; reachability from Supabase is only known after deploy.

## T6. Remove duplicate snapshot logic (spec Part 1 tail)

Add `Core.views.profitSnapshotRow(state, month)` (built on `profitByFamily`, tests first). Delete `supabase/functions/profit-snapshot/` from the repo. Do **not** touch the deployed function; list "delete remote `profit-snapshot`" in the release checklist for the user's approval. Commit.

## T7. `snapshotIfDue` (spec Part 3)

Action `snapshotIfDue`: previous calendar month in Asia/Dhaka; if no `profit_snapshots` row, insert with `ON CONFLICT (month) DO NOTHING`. Tests: due, not due, second call idempotent, simulated concurrent calls write one row. Panel calls it once per load. Commit.

## T8. Upay/Nagad relay parsing (spec Part 4)

Files: `src/server/edge.js` (`parseSms_`, `RELAY_SOURCES`), `test/fixtures/sms-upay-nagad.js`, tests, README.

- Source detection: `src` tag, then sender, then Nagad wording. Add `upay`.
- Upay received: type `Received`, status `Review`, counterparty empty. Upay "Fund Transfer ... to bank": skipped. Nagad Money Received / Cash In Received: `Pending`; cash-in stores `Uddokta:` number as counterparty. `Ref:` with colon accepted; `N/A` or empty becomes empty.
- Fixtures: the six user-supplied messages with invented phone numbers. Assert type, method, amount, trxId, counterparty, reference, status. Existing bKash tests unchanged and green.
- README "Payment relay" section with iPhone and Android recipes. Commit.

## T9. Auto-match at ingest (spec Part 3) — only after T1

Extra safeguards beyond the spec:
- Auto-apply only if all hold: relay token verified (T1), row status `Pending`, source not Upay (`Review`), reference resolves to exactly one active line, amount > 0, TrxID new. Anything else stays `Pending`.
- Cap: skip auto-match and leave `Pending` when the amount exceeds a setting `auto_match_max_bdt` (default 5000). Test it.
- Action name starts with `auto` so Undo skips it (existing behavior). Errors leave the row `Pending` and are returned in the relay result.
- Tests via `loadEdge`: happy path, wrong token (no write), unknown ref, duplicate TrxID, over-cap, Upay stays Review.
- Commit.

## T10. Docs and release checklist

- README: required secrets, pay-link change, rate caveats, snapshot approximation, relay contract.
- `CLAUDE.md`: note `APP_SECRET`/`RELAY_TOKEN` required; `.claude/settings*.json` sensitive.
- Add `docs/release-checklist.md` listing **user-approved** steps: rotate leaked tokens; `node tools/migrate-schema.js` dry run then `--apply` (004); set `APP_SECRET`, `RELAY_TOKEN`, `ALLOWED_ORIGIN`, `SUPABASE_DB_URL`; deploy `api`; delete remote `profit-snapshot`; run pay-token backfill; update phone shortcut with the token; smoke-test `/health`.

## Final gate

1. `npm test` all green (core + UI).
2. `node tools/build-edge.js`; `git diff --stat supabase/functions/api/index.ts` shows only intended changes.
3. `git ls-files | grep -E "^\.(env|mcp\.json|claude|codex)"` empty; the token grep above empty.
4. `git log --oneline` shows one commit per task. Nothing pushed, deployed or applied remotely.

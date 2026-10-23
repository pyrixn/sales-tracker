# Foundation Design (sub-project 1 of 5)

## Context

The goal is a polished, complete Sales Tracker. The work is split into five sub-projects, built in this order, each with its own spec, plan and build:

1. Foundation (this spec)
2. Feature completion (admin-panel plan gaps)
3. Design system and UI redesign (DESIGN.md, all screens)
4. Data migration (sheet snapshot to Supabase)
5. Release (UI tests green, Cloudflare Pages and Edge Function deploy)

Foundation makes the repo consistent and safe so the later sub-projects build on one source of truth. It adds no features and does not change the look of the app.

## Decisions made

- Build approach: Supabase-only. The Apps Script output is removed.
- `due_reminder_every_days` default: 5 days, everywhere.
- Live USDT-BDT rate cache: the `live_rates` table only.
- The migrations in `supabase/migrations/` are the only schema source.

## Out of scope

Feature gaps, the UI redesign, the data migration, and any deploy or change to the remote Supabase project.

## 1. Security hygiene

- Add `.mcp.json` and `settings.json` to `.gitignore`. A scan found credential-like content in `.mcp.json`, and CLAUDE.md already treats `settings.json` as sensitive.
- Make no commit that includes `.env`, `.mcp.json` or `settings.json`.
- Scan `tools/` and `src/` for hardcoded tokens and report the result. The README mentions a hardcoded access token in `apply-schema.js`, but that file no longer exists. `ensure-schema.js` and `migrate-to-supabase.js` read `.env`, which is acceptable.
- Rotating any exposed token is the user's decision. The spec does not do it.

## 2. Single schema source and conflict fixes

- `supabase/migrations/` is the only place schema lives. The inline DDL in `tools/ensure-schema.js` is removed. The script applies the migration files in filename order and records which files it has applied.
- The script never runs against the remote project without explicit user approval. `001_schema.sql` begins with `drop table ... cascade`, so the script must refuse to re-run `001` once it is recorded as applied. A new migration file is used for any later schema change; applied migrations are not edited.
- Reminder default: change the fallback in `src/core/reminders.js` from 14 to 5. Correct the design spec `2026-10-23-admin-panel-design.md` to say 5. The schema, fixtures and adapter test already use 5. `test/reminders.test.js` sets 14 explicitly and stays valid.
- Live rate: the `live_rates` table is the only cache. The admin-panel design spec drops the `settings` keys `usdt_bdt_rate` and `usdt_bdt_ts`.

## 3. Supabase-only build

- Delete `src/adapters/sheets.js`, `src/server/main.js`, the Apps Script output (`Code.gs`, `appsscript.json`) and the fake-spreadsheet harness (`test/fakes/gas.js`, `test/load-gas.js`, `test/state-sheet.js`, plus the tests that depend on them).
- `tools/build.js` emits a static `dist/index.html`: `src/ui/Index.html` with `src/core/util.js` inlined at the `/*@@CORE_UTIL@@*/` marker. The Edge Function URL and the `X-App-Secret` header come from a small config object in the page, not from a hardcoded value.
- `test/ui/app.test.js` runs against the built page. Playwright route interception mocks the Edge Function API, and `test/fixtures` supplies the data.
- `tools/build-edge.js` and its output are unchanged. The build for `supabase/functions/api/index.ts` is rerun and checked for unintended diffs.

## 4. Docs and scripts

- Rewrite `README.md` and `README_CF_PAGES.md` so every command, file name and number matches the repo. `README_CF_PAGES.md` no longer mentions Apps Script.
- `package.json`: add `test:ui`. Move the Chromium download out of `postinstall` into an explicit `npm run setup:ui`.
- Update `PRODUCT.md`'s test count.
- Make the first commits on `main`, in three commits: tooling and build, tests, docs.

## Testing and acceptance

- `npm run test:core` passes. The count drops only by tests that existed solely for the Apps Script path.
- `npm run test:ui` passes against the mocked API.
- `node tools/build-edge.js` runs, and its diff from the current `supabase/functions/api/index.ts` contains only the intended removals.
- `npm run build` produces `dist/index.html` and no `Code.gs` or `appsscript.json`.
- `git status` shows no `.env`, `.mcp.json` or `settings.json` staged.
- No remote Supabase call is made at any point.

## Risks

- Removing the fake-spreadsheet harness changes how UI tests get their data. The mocked-API tests must keep covering the mobile viewport, dues lookup, renewal and undo flows listed in `PRODUCT.md`.
- `ensure-schema.js` is the only schema applier today. Rewriting it must keep it from touching the remote project unprompted.

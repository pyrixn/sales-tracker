# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo consistent and safe: one schema source, one build target (Supabase), no Apps Script leftovers, correct docs, and a clean first commit history.

**Architecture:** Core planners and the Postgres adapter stay untouched except one fallback value. The UI tests stop using a fake Google Sheet and instead run the real Edge Function router (`src/server/edge.js`) in Node against an in-memory fake database, exposed to Playwright through route interception. Schema changes move to a tested migration runner that is dry-run by default.

**Tech Stack:** Node >= 18 (`node --test`), Playwright (Chromium), vanilla JS, Supabase Edge Function (Deno) built by `tools/build-edge.js`.

**Spec:** `docs/superpowers/specs/2026-10-23-foundation-design.md`

## Global Constraints

- Build approach is Supabase-only: no `Code.gs`, `appsscript.json`, `sheets.js`, `main.js`, or fake-spreadsheet harness remains.
- `due_reminder_every_days` default is 5 everywhere.
- The `live_rates` table is the only USDT-BDT rate cache; no `usdt_bdt_rate` / `usdt_bdt_ts` settings keys.
- `supabase/migrations/` is the only schema source. Applied migrations are never edited. New schema goes in a new file.
- No remote Supabase call is made while executing this plan. Tests use fakes only. Never run the migration runner with `--apply`.
- Never print, copy or commit values from `.env`, `.mcp.json` or `settings.json`.
- Do not hand-edit `supabase/functions/api/index.ts`; regenerate it with `node tools/build-edge.js`.
- `reference_PaymentRelay_v9.gs` and `tools/migrate-output.json` are not modified.
- Core stays free of I/O; adapters and the server layer hold no domain rules.
- No emoji or visual redesign work here; the UI's look is unchanged.
- Commits: the repo has zero commits and a `master` branch. Work is staged per task but committed once, in Task 8, as three commits on `main` (tooling and build, tests, docs). Commit with explicit `git add <paths>` only; never `git add -A` (it would pick up `.env`, `.mcp.json`, tool folders).

## Review Focus

- A build run with `API_BASE_URL` containing a quote or `</script>` must still produce a valid page (value is JSON-encoded into `dist/config.js`, never spliced into HTML).
- The migration runner pointed at a database that already has the tables but no record table must refuse to run `001` (which drops tables) unless `--baseline` marks it applied first.
- The migration runner without `--apply` must make no network call and print what it would do.
- A missing `.env`, `SUPABASE_ACCESS_TOKEN` or `SUPABASE_PROJECT_REF` must produce one plain error line naming the missing variable, never a stack trace and never a value.
- The fake database must throw `unhandled SQL: ...` for SQL it does not support, so a UI test never passes on silently wrong data.

---

### Task 1: Security hygiene

**Files:**
- Modify: `.gitignore`
- Test: `test/repo-hygiene.test.js` (create)

**Interfaces:**
- Produces: nothing code-level; later tasks rely on `.mcp.json`, `settings.json`, `dist/` being ignored.

- [ ] **Step 1: Write the failing test** in `test/repo-hygiene.test.js`. Test `secret files are ignored` runs `git check-ignore` (via `child_process.spawnSync`) for `.env`, `.mcp.json`, `settings.json` and asserts exit status 0 for each. Test `no hardcoded token in tools or src` reads every file under `tools/` and `src/` (skip `tools/migrate-output.json`) and asserts none matches `/sbp_[A-Za-z0-9]{10,}/`, `/eyJ[A-Za-z0-9_-]{20,}/`, or `/postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/`.
- [ ] **Step 2: Run** `node --test test/repo-hygiene.test.js`. Expected: first test FAILS for `.mcp.json` and `settings.json`; second passes (the scan found no hardcoded token in `tools/` or `src/`).
- [ ] **Step 3: Append to `.gitignore`**: `.mcp.json`, `settings.json`, `dist/`, `.wrangler/`. Keep all existing entries.
- [ ] **Step 4: Run** the same command. Expected: PASS (2 tests).
- [ ] **Step 5: Stage** `git add .gitignore test/repo-hygiene.test.js` (no commit yet; see Global Constraints).

---

### Task 2: Reminder default 5

**Files:**
- Modify: `src/core/reminders.js:24`
- Modify: `docs/superpowers/specs/2026-10-23-admin-panel-design.md` (reminder cadence bullet and the `settings` rate-cache bullets)
- Test: `test/reminders.test.js`

**Interfaces:**
- Produces: `Core.reminders.planReminders` uses 5 when `st.due_reminder_every_days` is missing or 0.

- [ ] **Step 1: Write the failing test** in `test/reminders.test.js`, named `due reminder repeat gap falls back to 5 days when the setting is missing`. Build the state the way the existing tests in that file do, delete `settings.due_reminder_every_days`, add a sent due reminder 4 days before today and assert no new due reminder is queued; with the log entry 5 days old assert one is queued.
- [ ] **Step 2: Run** `node --test test/reminders.test.js`. Expected: new test FAILS (fallback is 14, so the 5-day-old reminder is not re-queued).
- [ ] **Step 3: Change** the `|| 14` fallback on line 24 of `src/core/reminders.js` to `|| 5`. Do not touch the existing test that sets 14 explicitly.
- [ ] **Step 4: Edit the admin-panel design spec**: replace "bi-weekly ... defaults to `14`" with "defaults to `5`"; delete the sentence that caches the rate in `settings` under `usdt_bdt_rate` and `usdt_bdt_ts` and say the rate is cached only in `live_rates`.
- [ ] **Step 5: Run** `npm run test:core`. Expected: all pass.
- [ ] **Step 6: Stage** the three files.

---

### Task 3: Edge test host (fake database, seed, router loader)

**Files:**
- Create: `test/support/fake-db.js`, `test/support/seed.js`, `test/support/edge-host.js`
- Modify: `test/postgres-adapter.test.js` (import `makeFakeDb` from the support file instead of defining it inline)
- Test: `test/edge-host.test.js` (create)

**Interfaces:**
- Produces:
  - `makeFakeDb(): { db: { query(text, params): Promise<{rows}>, transaction(fn): Promise<any> }, tables: Record<string, Map|Array> }` in `test/support/fake-db.js`. It is the existing helper moved verbatim, then extended only as later steps require. Unsupported SQL still throws `unhandled SQL: <text>`.
  - `seedDb(db, tables, state): Promise<void>` in `test/support/seed.js`. Writes a Core state object (as built by `test/fixtures.js` `makeMigratedState()`) into the fake tables using `Adapter.SPEC` column maps, so `Adapter.readState` returns an equivalent state.
  - `makeUiState(): State` in `test/support/seed.js`. `makeMigratedState()` plus the two mutations the old harness made: customer `jamilhq` gets `Channel 'WhatsApp'`, `Handle '01711111111'`, `Notes 'Example contact for testing'`; `inbox` gets one Pending row `{ Received:'2026-10-18 14:05', Type:'Received', Method:'bKash', Sender:'+8801756999991', Amount:290, Transaction_ID:'TESTTRX1', Reference:'', Status:'Pending', Matched_Sale_ID:'', Raw_SMS:'Example forwarded message' }`.
  - `loadEdge(db, opts?: { today?: string }): { api(action, payload): Promise<{ok, data?, error?}> }` in `test/support/edge-host.js`. Loads `src/core/*.js` (order from `test/load-core.js` `ORDER`), `src/adapters/postgres.js` and `src/server/edge.js` into one `vm` realm with globals `Core`, `Adapter`, `db`, `Deno` (stub: `{ env: { get: () => undefined } }`) and `crypto`. Edge reads the date from `today_()`, so when `opts.today` is given the loader overrides `globalThis.today_` after evaluation so tests are date-stable (default `'2026-10-18'`).

- [ ] **Step 1: Write the failing test** in `test/edge-host.test.js`:
  - `home read on the seeded state shows what is owed`: build `makeFakeDb()`, `seedDb(db, tables, makeUiState())`, `loadEdge(db)`, call `api('home', {})`, assert `ok` is true and `data.owed` (the field the UI's `today-owed` tile reads; check the name in `Core.views.homeData`) equals `1360`.
  - `unsupported SQL fails loudly`: `db.query('DROP TABLE sales')` rejects with `/unhandled SQL/`.
- [ ] **Step 2: Run** `node --test test/edge-host.test.js`. Expected: FAIL, modules not found.
- [ ] **Step 3: Create `test/support/fake-db.js`** by moving `makeFakeDb` out of `test/postgres-adapter.test.js`; export it; make `postgres-adapter.test.js` import it. Run `node --test test/postgres-adapter.test.js` to confirm the move is clean.
- [ ] **Step 4: Implement `seedDb`, `makeUiState`, `loadEdge`** as specified. `seedDb` inserts through `db.query('INSERT INTO <table> (cols) VALUES (...)', params)` using `Adapter.SPEC` so the SQL path is the same one production uses; settings go in as rows of `settings`.
- [ ] **Step 5: Run** `node --test test/edge-host.test.js`. Expected: PASS. If a `home` or `readState` call throws `unhandled SQL`, extend `makeFakeDb` for exactly that statement form (for example `ORDER BY`, `ON CONFLICT ... DO UPDATE`) and add one assertion for it to `edge-host.test.js`. Repeat until PASS.
- [ ] **Step 6: Stage** `test/support/`, `test/edge-host.test.js`, `test/postgres-adapter.test.js`.

---

### Task 4: Port the server tests off Apps Script

**Files:**
- Modify: `test/server.test.js` (rewrite to use `loadEdge`)
- Delete: `test/adapter.test.js`

**Interfaces:**
- Consumes: `makeFakeDb`, `seedDb`, `makeUiState`, `loadEdge` from Task 3.
- Produces: `test/server.test.js` with the same 12 behaviors, running against `edge.js` instead of `main.js`.

- [ ] **Step 1: Read** old `test/server.test.js` (12 tests) and `test/adapter.test.js` (10 tests). For each of the 12 server tests, keep the name and assertion intent and re-express it as `api(action, payload)` plus a check on `tables` (replace `rows(ss, 'Tab')` helpers with reads of the fake table map). Where a test relied on the sheet only (for example sheet formatting, header rows), drop it and list it in the commit message.
- [ ] **Step 2: Run** `node --test test/server.test.js`. Expected: FAIL until rewritten (the old file imports `load-gas`).
- [ ] **Step 3: Rewrite** the file. Each test builds its own `makeFakeDb()` + `seedDb` so tests stay independent. The idempotency test sends the same `requestId` twice and asserts one row written and the first answer returned.
- [ ] **Step 4: Delete `test/adapter.test.js`.** The Postgres adapter is covered by `postgres-adapter.test.js`, `supabase-adapter.test.js` and the new server tests. Before deleting, grep each of its 10 test names and confirm no behavior is lost that `postgres-adapter.test.js` does not cover; if one is, add that case to `postgres-adapter.test.js`.
- [ ] **Step 5: Run** `node --test test/server.test.js test/postgres-adapter.test.js test/supabase-adapter.test.js`. Expected: PASS.
- [ ] **Step 6: Stage** the changes.

---

### Task 5: Supabase-only build and UI tests on the mocked API

**Files:**
- Modify: `tools/build.js` (rewrite), `src/ui/Index.html` (remove `google.script.run` branch in `call()` at ~line 363-370, the `<!--@@HARNESS@@-->` marker at line 340, and the hardcoded URL fallback at ~line 377), `test/ui/app.test.js`, `package.json`
- Create: `test/support/ui-host.js`
- Test: `test/build.test.js` (create)

**Interfaces:**
- Consumes: Task 3 helpers.
- Produces:
  - `buildSite(opts?: { apiBaseUrl?: string, outDir?: string }): { files: string[] }` exported from `tools/build.js` (also runs on `node tools/build.js`). Writes `<outDir or dist>/index.html` (Index.html with `src/core/util.js` inlined at `/*@@CORE_UTIL@@*/`, comments stripped by the existing `strip()`, plus `<script src="config.js"></script>` before the app script) and `<outDir>/config.js` containing exactly `window.API_BASE_URL = <JSON.stringify(url)>;`. URL = `opts.apiBaseUrl`, else `process.env.API_BASE_URL`, else `https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api`. It writes no other files and deletes stale `Code.gs`, `Index.html` (capital I), `appsscript.json`, `harness.html` from `dist/` if present.
  - `startUiHost(page, opts?: { state?: State }): Promise<{ db, tables, api }>` in `test/support/ui-host.js`. Seeds a fake db with `makeUiState()` (or `opts.state`), calls `loadEdge`, and registers `page.route('**/functions/v1/api', ...)` that answers POST bodies `{action, payload}` with `JSON.stringify(await api(action, payload))` (status 200, content type JSON, CORS header `access-control-allow-origin: *`; handle the OPTIONS preflight with 204).

- [ ] **Step 1: Write the failing build test** `test/build.test.js` with three tests, each calling `buildSite({ outDir: <tmp dir from fs.mkdtempSync> })`:
  - `writes index.html and config.js only`: directory listing equals `['config.js', 'index.html']`; `index.html` contains no `google.script` and no `@@`.
  - `inlines Core.util`: `index.html` contains `Core.util` definition text (assert it includes the string `Core.util =` or whatever line 1 of `src/core/util.js` assigns).
  - `api url is JSON-encoded`: with `apiBaseUrl: 'https://x.test/a"b</script>'`, `config.js` evaluates via `new Function('window', text)` on a stub object without throwing and sets `window.API_BASE_URL` to the exact input string, and `index.html` does not contain `a"b`.
- [ ] **Step 2: Run** `node --test test/build.test.js`. Expected: FAIL (`buildSite` not exported).
- [ ] **Step 3: Rewrite `tools/build.js`** to export `buildSite` and call it when run as a script (`require.main === module`). Reuse the existing `strip()` and `buildIndex()`. Remove `buildCode`, `MANIFEST`, `buildHarness`. Print one line listing the files written.
- [ ] **Step 4: Edit `src/ui/Index.html`**: delete the `<!--@@HARNESS@@-->` marker; in `call()`, delete the `if (typeof google ...)` branch and make `apiBase` equal `window.API_BASE_URL` (if it is empty, return `{ ok: false, error: 'API URL not configured.' }`). Add `<script src="config.js"></script>` immediately before the first app `<script>` so it is present when serving `dist/`. Keep the `X-App-Secret` header logic unchanged.
- [ ] **Step 5: Run** `node --test test/build.test.js`. Expected: PASS.
- [ ] **Step 6: Implement `startUiHost`.** Then rewrite `test/ui/app.test.js`:
  - `open()` builds nothing itself; before-hook runs `buildSite()` once into `dist/`, launches Chromium, and each test opens a context at 360x740, calls `startUiHost(page)`, then `page.goto(pathToFileURL(dist/index.html))` (config.js sits beside it and defines `API_BASE_URL = '.../functions/v1/api'`, which the route intercepts).
  - Replace every `window.__harness.rows('<Sheet tab>')` with a server-side read of the matching fake table via `tables` (map tab name to table with `Adapter.SPEC[tab].table`; write a one-line helper `rows(tab)` in the test file).
  - Replace the UI's fixed "today" (`window.TEST_TODAY`) with the date the fake edge already uses (`'2026-10-18'`); delete any reference to `TEST_TODAY`.
  - Keep every one of the 12 existing test names and assertions; only the data access changes.
- [ ] **Step 7: Run** `npm run build && node --test test/ui/app.test.js`. Expected: 12 PASS, each with `errors` equal `[]`. If a UI action calls an Edge action that hits `unhandled SQL`, extend `makeFakeDb` with that statement form and a one-line assertion in `test/edge-host.test.js`.
- [ ] **Step 8: Update `package.json` scripts**: `"test": "node --test \"test/**/*.test.js\""` (unchanged), `"test:ui": "node tools/build.js && node --test test/ui/app.test.js"`, `"test:core": "node --test \"test/*.test.js\""` (unchanged), `"build": "node tools/build.js"`, `"setup:ui": "npx playwright install chromium"`; delete `postinstall`.
- [ ] **Step 9: Stage** the changes.

---

### Task 6: Remove Apps Script code

**Files:**
- Delete: `src/adapters/sheets.js`, `src/server/main.js`, `test/fakes/gas.js`, `test/load-gas.js`, `test/state-sheet.js`, `test/supabase-adapter.test.js` only if Step 1 shows it duplicates `postgres-adapter.test.js` (otherwise keep it)
- Modify: `test/load-core.js` (comment), `supabase/functions/api/index.ts` (regenerate)

**Interfaces:**
- Consumes: Tasks 4 and 5 (nothing may import the deleted files).

- [ ] **Step 1: Grep** for each deleted name (`sheets.js`, `main.js`, `load-gas`, `fakes/gas`, `state-sheet`, `Code.gs`, `appsscript`, `SpreadsheetApp`, `PropertiesService`) across `src/`, `tools/`, `test/`, `package.json`, `wrangler.toml`. Expected hits only in the files being deleted or in docs handled by Task 8. Fix any other hit.
- [ ] **Step 2: Delete** the files listed. In `test/load-core.js` change the first comment to describe loading every `src/core/*.js` into one global scope for tests (no Apps Script mention); do not change behavior.
- [ ] **Step 3: Regenerate** the Edge Function with `node tools/build-edge.js`. Expected: the build prints success, and `supabase/functions/api/index.ts` contains `|| 5` in the reminder fallback (the Task 2 change) and no `sheets` adapter code.
- [ ] **Step 4: Run** `npm test`. Expected: all tests pass, including `test/ui/app.test.js` (requires Chromium; if missing run `npm run setup:ui` first).
- [ ] **Step 5: Stage** the deletions and the regenerated `supabase/functions/api/index.ts`.

---

### Task 7: Migration runner (replaces `ensure-schema.js`)

**Files:**
- Create: `tools/lib/migrations.js`, `tools/migrate-schema.js`
- Delete: `tools/ensure-schema.js`
- Test: `test/migrations.test.js` (create)

**Interfaces:**
- Produces in `tools/lib/migrations.js`:
  - `planMigrations(files: string[], applied: string[], opts?: { baseline?: string[] }): { toRun: string[], toBaseline: string[], errors: string[] }`. `files` are migration filenames; order is ascending by filename. `applied` are recorded names. `toBaseline` = `opts.baseline` entries that exist in `files` and are not in `applied`. `toRun` = remaining unapplied files. Errors: a `baseline` name not in `files`; an applied name missing from `files`.
  - `guardDestructive(sqlText: string, appliedAny: boolean, hasRecordTable: boolean): string | null`. Returns an error string when the SQL contains `drop table` (case-insensitive) and the database already has tables (`hasRecordTable` false while `appliedAny` is false means unknown history). Returns `null` when safe.
- `tools/migrate-schema.js` CLI: `node tools/migrate-schema.js [--apply] [--baseline <file>[,<file>]]`.

- [ ] **Step 1: Write the failing tests** in `test/migrations.test.js`:
  - `runs unapplied files in filename order`: files `['002_b.sql','001_a.sql']`, applied `[]` gives `toRun` equal `['001_a.sql','002_b.sql']`.
  - `skips applied`: applied `['001_a.sql']` gives `toRun` equal `['002_b.sql']`.
  - `baseline marks without running`: `baseline: ['001_a.sql','002_b.sql']` gives empty `toRun` and `toBaseline` equal both.
  - `unknown baseline name is an error`: errors mention the name.
  - `drop table is refused when history is unknown`: `guardDestructive('drop table if exists x cascade;', false, false)` returns a string matching `/baseline/`.
  - `drop table is allowed on a recorded database for a file still to run`: not applicable, so assert `guardDestructive('create table t();', false, false)` returns `null`.
  - `dry run makes no network call`: spawn `node tools/migrate-schema.js` with env `SUPABASE_PROJECT_REF=ref` `SUPABASE_ACCESS_TOKEN=test-token` `NODE_OPTIONS=--require ./test/support/block-fetch.js` where that tiny file replaces `globalThis.fetch` with a function that throws `network blocked`; assert exit code 0 and stdout contains `dry run`.
  - `missing variable is one plain line`: spawn with an empty env; assert exit code 1, stderr is exactly one line containing `SUPABASE_ACCESS_TOKEN`, and contains no `at ` stack frames.
- [ ] **Step 2: Run** `node --test test/migrations.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `tools/lib/migrations.js`** with the two pure functions above.
- [ ] **Step 4: Implement `tools/migrate-schema.js`.** Behavior: load `.env` only if it exists (same line parser as the old script); read `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` from the environment, exit 1 with one line naming the first missing variable; list `supabase/migrations/*.sql`; without `--apply` print `dry run: would apply <files>` using only local data (no `applied` list is available offline, so treat it as unknown and print the full file list plus the baseline note) and exit 0 without any fetch; with `--apply` call the Management API `database/query` endpoint (same URL and bearer header shape as the old script) to create `schema_migrations(name text primary key, applied_at timestamptz default now())` with `if not exists`, read applied names, run `planMigrations` and `guardDestructive`, run each file inside its own request, insert its name after success, and print file names only. Never log the token or response bodies that could echo it.
- [ ] **Step 5: Create `test/support/block-fetch.js`** (3 lines) for the dry-run test.
- [ ] **Step 6: Run** `node --test test/migrations.test.js`. Expected: PASS.
- [ ] **Step 7: Delete `tools/ensure-schema.js`** and grep the repo for `ensure-schema` (README text is handled in Task 8).
- [ ] **Step 8: Stage** the changes. Do not run `--apply`.

---

### Task 8: Docs, scripts, final verification, commits

**Files:**
- Modify: `README.md`, `README_CF_PAGES.md`, `PRODUCT.md` (test count), `CLAUDE.md` (migration script and test notes), `wrangler.toml` only if it still references removed outputs
- Test: `test/repo-hygiene.test.js` (extend)

- [ ] **Step 1: Extend** `test/repo-hygiene.test.js` with `docs name only real scripts and files`: read `README.md`, `README_CF_PAGES.md`, `CLAUDE.md`; for every `npm run <name>` assert `<name>` exists in `package.json` scripts; for every `tools/<file>` mention assert the file exists; assert none of the three files contains `Apps Script`, `appsscript`, `Code.gs`, `apply-schema`, `ensure-schema`, `migrate-data`, except `reference_PaymentRelay_v9.gs` lines (allow the substring `reference_PaymentRelay`) and a single "Migration from Google Sheets" section in the README which may say "Google Sheets" but not the banned tokens. Run it: expected FAIL listing the stale mentions.
- [ ] **Step 2: Rewrite the docs** so each command and path is real: schema via `node tools/migrate-schema.js` (dry run) and `--apply` with approval; build via `npm run build` (static site) and `node tools/build-edge.js`; tests via `npm test`, `npm run test:core`, `npm run test:ui`, `npm run setup:ui`. README lists both migrations. `README_CF_PAGES.md` describes only the static `dist/index.html` + `config.js` and the `API_BASE_URL` build variable; remove the "Produces appsscript.json" line and the unsupported `fork_domain_list`/`[deploy]` snippet if `wrangler.toml` does not use them. In `CLAUDE.md`, replace the migration-script TODO line with: the data migration script is `tools/migrate-to-supabase.js`, still unverified, handled in a later sub-project. Update the `PRODUCT.md` evidence line to the real core-test count printed by `npm run test:core`.
- [ ] **Step 3: Run** the full gate: `npm test` (expect 0 failures), `npm run build` (dist contains only `index.html`, `config.js`), `node tools/build-edge.js` (succeeds), `git check-ignore .env .mcp.json settings.json dist` (all four printed).
- [ ] **Step 4: Rename the branch** `git branch -m master main`.
- [ ] **Step 5: Commit 1, tooling and build**: `git add .gitignore package.json package-lock.json wrangler.toml tools/build.js tools/build-edge.js tools/lib tools/migrate-schema.js tools/migrate-to-supabase.js tools/migrate-output.json src supabase reference_PaymentRelay_v9.gs`. Verify with `git diff --cached --name-only` that none of `.env`, `.mcp.json`, `settings.json`, `.agents`, `.claude`, `.codex` appear. Commit message: `chore: supabase-only build, migration runner, ignore secret files`.
- [ ] **Step 6: Commit 2, tests**: `git add test`. Message: `test: run server and UI tests on the edge router with a fake database`. List dropped Apps Script-only tests in the body.
- [ ] **Step 7: Commit 3, docs**: `git add README.md README_CF_PAGES.md PRODUCT.md CLAUDE.md docs`. Message: `docs: align readmes and specs with the supabase-only repo`.
- [ ] **Step 8: Verify** `git status --short` shows only the intentionally untracked tool folders (`.agents`, `.claude`, `.codex`, `.impeccable`, `.superpowers`, `image.png`, `skills-lock.json`, `.env`, `.mcp.json` shown as ignored or untracked) and `git log --oneline` shows three commits.

Every commit message ends with the attribution line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

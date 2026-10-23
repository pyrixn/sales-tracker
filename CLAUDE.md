# CLAUDE.md

Guidance for Claude Code working in this folder.

## Project

Sales Tracker (Supabase Edition): subscription sales tracker with bKash payment automation, Discord/WhatsApp reminders, and a full audit/undo system. See `README.md` for the full overview.

## Architecture

- `src/core/` — pure business logic, product-agnostic (sales, payments, matching, reminders, undo). Keep it free of I/O.
- `src/adapters/postgres.js` — the storage adapter (state ↔ Postgres).
- `src/server/edge.js` — Edge Function router (Deno), async wrapper over core + adapter.
- `src/ui/Index.html` — vanilla JS admin panel SPA. No framework.
- `supabase/migrations/` — schema. `supabase/functions/api/` — built Edge Function output.
- `tools/` — build and migration scripts.
- `test/` — Node test runner tests, plus Playwright UI tests in `test/ui/`.
- `reference_PaymentRelay_v9.gs` — bKash webhook relay, still on Google Apps Script. Read-only reference; do not edit.

## Commands

- Build Edge Function: `node tools/build-edge.js` (output `supabase/functions/api/index.ts`)
- Build static site (`dist/index.html` + `dist/config.js`, URL from `API_BASE_URL`): `npm run build`
- Test all: `npm test`
- Core tests only: `npm run test:core`
- UI tests: `npm run test:ui` (install the browser once with `npm run setup:ui`)
- Schema: `node tools/migrate-schema.js` is a dry run by default. `--apply` changes the remote project and needs approval. `--baseline <files>` records already-applied files. Needs `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`.
- Deploy: `supabase functions deploy api`

## Conventions

- Keep business logic in `src/core/`. Adapters and the server layer must not contain domain rules.
- Rebuild the Edge Function after changing `src/` before deploying. Do not hand-edit `supabase/functions/api/index.ts`.
- Schema changes go in a new migration file. Do not edit an applied migration.
- All tables use RLS with no policies. Service role bypasses RLS; all traffic goes through the Edge Function. Never add a public anon-key path.
- Writes must stay idempotent (request IDs). Preserve the audit log behaviour when touching write paths.

## Secrets

- `.env` and `settings.json` hold credentials. Never print their values, copy them into code, or commit them.
- `.gitignore` excludes `.env` but not `settings.json`. Treat `settings.json` as sensitive and keep it out of commits.
- Edge Function secrets: `SUPABASE_DB_URL`, `APP_SECRET`, `RELAY_TOKEN` (both required; set in Supabase dashboard). `.claude/settings*.json` and `.mcp.json` hold tokens: never commit.

## Skills

- Skills are kept in `.claude/skill-library/`, not loaded. `.claude/skills/` stays empty by default.
- At the start of each session, ask the user the purpose of the session before doing anything else. Then load only the matching skill groups below.
- To load: copy each chosen folder from `.claude/skill-library/` into `.claude/skills/`. Tell the user to restart the session if the skills do not appear.
- Do not copy skills the purpose does not need. Do not load a group the user did not ask for.

Purpose → skills:

- **Frontend design:** impeccable, design-taste-frontend, apple-design, emil-design-eng, break-ui, pick-ui-library, prototype, ask-sonner
- **Animation:** animate, animate-expo, animation-performance, animation-vocabulary, find-animation-opportunities, improve-animations, review-animations
- **Mobile:** mobile-native, write-swift
- **Database / Supabase:** supabase, supabase-postgres-best-practices, migration
- **Engineering discipline:** investigate-first, lean-build, safe-refactor, surgical-patch, verify-and-stop
- **Caveman output mode:** caveman, caveman-commit, caveman-review, caveman-help, cavecrew, ultracave, megacave (and other caveman-* skills in the library)

## Working here

- Run `npm test` after changes to `src/core/` or the adapters.
- Do not deploy, apply migrations to the remote project, or delete data without asking first.
- `tools/migrate-output.json` is a local, git-ignored snapshot of the old sheet (real customer data). Do not modify it or commit it.
- The old sheet data is already loaded in the live Supabase project (checked 2026-10-23: 64 customers, 102 sales, 90 payments). `tools/migrate-to-supabase.js` is the old one-off import script; its result was verified on 2026-10-23 (payment total matches the snapshot). Do not run it again against the remote project; it could duplicate or overwrite data.
- No scheduled jobs exist in this repo. Reminders are computed on read (`Core.reminders.planReminders`, via the `home` action).

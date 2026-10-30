# Release checklist

Every step here changes the remote project or a live service. Do each only with the owner's explicit yes, in this order.

1. **Rotate exposed tokens.** The Supabase access token, the omniroute token and the `ANTHROPIC_AUTH_TOKEN` were printed in a working session. Revoke them and issue new ones. Keep them only in ignored files (`.env`, `.mcp.json`, `.claude/settings.local.json`).
2. **Dry run the migrations:** `node tools/migrate-schema.js`. It lists what would be applied and touches nothing.
3. **Apply them:** `node tools/migrate-schema.js --apply`. New in this release: `004_sale_pay_token`, `005_manual_usdt_rate`, `006_auto_match_cap`. Never re-run `001` (it drops tables); the runner refuses.
4. **Set Edge Function secrets** in the Supabase dashboard: `SUPABASE_DB_URL`, `APP_SECRET`, `RELAY_TOKEN` (all three required: the API answers 503 without them) and `ALLOWED_ORIGIN` (the Cloudflare Pages URL).
5. **Build and deploy:** `node tools/build-edge.js`, then `supabase functions deploy api`.
5b. **Deploy the redesigned panel** to Cloudflare Pages: `npm run build`, then `npx wrangler pages deploy dist --project-name sales-tracker`. The function also serves the same page at its root URL, so redeploy `api` (step 5) first. The panel now asks for the password on first load and after a rotation (More, then Sign out, to forget it).
6. **Backfill pay tokens** once, from the panel or with `POST {action:'backfillPayTokens'}`. Until then no old pay link works and reminders carry no link. Send customers the new links.
7. **Update the phone shortcut** with the `RELAY_TOKEN` and, if used, the Upay and Nagad `src` values.
8. **Delete the old remote `profit-snapshot` function** (its code was removed from the repo; the panel now runs `snapshotIfDue`).
9. **Smoke test:** `GET <function URL>/health`; open the panel; check the Profit tab shows a rate or "No rate"; relay one test SMS and confirm the inbox row.
11. **Pay links (migration 008).** Apply `008_pay_intents` **before** deploying the Edge Function: every API call now reads the `pay_intents` table, so a function deployed first fails until the table exists. Then deploy `api` and the site (the site carries the Pages Function in `functions/pay/`). In the panel, open Pay links, then Methods, and add the Nagad, Upay and bank details you want customers to see.
10. **Real Upay and Nagad messages:** the parsers were written from described wording. Replace `test/fixtures/sms-upay-nagad.js` with real messages and adjust if any assertion fails.
12. **Phase 3: custom pay links and delivery (migration 011).** Order matters: apply `011_pay_requests_delivery` first (the function reads the new tables), then `node tools/build-edge.js` and `supabase functions deploy api`, then `npm run build` and deploy Pages. Afterwards open `/pay/<token>` for a new custom link and a `/receipt` for a paid one, and fill More, Payment methods, Delivery (terms, Discord and Facebook links, expiry hours).

- Supabase Auth: turn off public sign-ups (Authentication > Sign In / Providers > "Allow new users to sign up"). Staff are invited only; an open sign-up lets anyone pre-register an address.

Staff logins: the function verifies Supabase Auth tokens against the project's JWKS (`SUPABASE_URL`, provided automatically), so `SUPABASE_JWT_SECRET` is not needed on projects using asymmetric signing keys (ES256). Set it only for a legacy HS256 project.

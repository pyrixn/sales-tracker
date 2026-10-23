# Remaining checks

Release is complete (2026-10-23). Only optional items are left.

- [ ] Optional: replace `test/fixtures/sms-upay-nagad.js` with real Upay and Nagad messages.
- [ ] Optional: split `src/ui/Index.html` (1,493 lines); skipped because the build embeds it as one file and the panel works.

## Done

- [x] Function, Pages panel and migrations 001 to 007 deployed.
- [x] Payment `DJN6FVV982` (Tk 2290) matched.
- [x] Audit findings 1 to 5: `bulkImport` removed, writes locked, relay duplicate handled, public pay routes cheap, sign-in throttle, dead `undo` removed, raw database errors hidden.
- [x] Live write test after the hardened deploy (`EX-0001` saved with its change-log entry).
- [x] `APP_SECRET` and `RELAY_TOKEN` rotated; phone shortcut updated and confirmed working.
- [x] Old `profit-snapshot` function deleted.

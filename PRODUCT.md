# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary user**: Shop owner and billing administrator managing recurring digital subscriptions (Netflix, Spotify, YouTube Premium, Disney+, gaming keys, gift cards).
- **Operating reality**: Fast-paced customer service across WhatsApp, Messenger, and Discord. Receiving continuous bKash mobile financial service (MFS) payments. Needs sub-second lookups of dues, customer subscription lines, and renewal dates on desktop and mobile phones under bright daylight and low-light environments.

## Product Purpose

A streamlined subscription sales tracker, billing automation, and customer ledger system tailored for digital goods and recurring services in the Bangladesh market. It automates bKash payment matching, customer renewal reminders, and inventory allocation, backed by an immutable ledger and one-tap undo.

## Positioning

Unlike generic SaaS billing platforms (Stripe Billing, Chargebee) or disconnected manual spreadsheets, Sales Tracker pairs real-time bKash SMS payment matching with zero-friction WhatsApp/Discord renewal workflows and instant audit undo in a fast, dark-first interface inspired by Dark Mode Design and Godly modern admin aesthetics.

## Design Archetype & Aesthetic Direction

- **Style World**: Night Ledger. A dark-first, hairline-bordered admin in the spirit of darkmodedesign.com and godly.design: near-black ground, small precise type, one electric accent, and a large editorial figure that answers the day's first question (what am I owed). Technical, dense, calm.
- **Color Identity**: one dominant colour (warm ink `#080906` in the dark, paper `#f2efe6` in the light) and one sharp accent (lime `#cdf03c` / `#5f7a0a`). Money in reads as the accent or mint, amber means soon, coral means owed or overdue. No purple or blue gradients. Atmospheric depth comes from a faint lime glow and a 44px line grid behind the content.
- **Typography**: Fraunces for display (page titles at weight 800, hero figures at weight 200), Bricolage Grotesque for body, JetBrains Mono for money, references and labels, Noto Sans Bengali as the Bangla fallback. All self-hosted. Size jumps are large (11px labels against 150px figures). Floor of 11px for anything interactive.
- **Iconography**: lucide line icons only. No emoji in navigation, status or controls.
- **Components**: shadcn/ui primitives (Button, Sheet, Command, Select, Tabs, Sonner, AlertDialog) restyled through tokens in `web/src/index.css`. Tailwind classes only; no inline styles in our own components.
- **Motion**: one orchestrated reveal when Today loads, a short fade between screens, sheets slide in. Everything else is state feedback. `prefers-reduced-motion` turns it off.

## Operating Context

- Mobile and desktop responsive single-page application (`web/`).
- Strict mobile viewport budget: Fits 360px+ screens without sideways horizontal scrolling (`document.scrollingElement.scrollWidth <= 360`).
- Interacts with bKash webhook relay (`reference_PaymentRelay_v9.gs`) and Supabase Edge Functions.

## Capabilities and Constraints

- **Stack**: React 19 + Vite + Tailwind CSS 4 + shadcn/ui + Motion frontend (chosen by the owner on 2026-10-24, replacing the earlier vanilla single file), Supabase Edge Functions (Deno), PostgreSQL 17 database.
- **Payment Automation**: bKash SMS notification parsing, automatic reference matching, overpayment-to-credit allocation.
- **Ledger & Undo**: Change_Log audit trail with single-action undo capability for reversible transactions.
- **Communication**: Generated WhatsApp (`wa.me`) and Discord message templates for renewal and overdue reminders.
- **Security & Access**: All client traffic routes through Supabase Edge Function with service-role bypass; strict RLS on all tables.

## Brand Commitments

- **Tone**: Professional, crisp, dependable, ultra-fast, zero cognitive friction.
- **Currency**: Bangladeshi Taka (৳ / BDT).

## Evidence on Hand

- Playwright suite (`test/ui/app.test.js`) over the built site: mobile viewport, dues lookup and filters, renewal logic, undo, command palette, shortcuts, theme.
- Anonymized sheet fixtures (`test/fixtures/sheet-2026-10-18.js`): names, contacts and codes are made up.
- Complete backend logic suite (`test/*.test.js`) with 191 passing tests (`npm run test:core`). The Playwright UI suite is also run by `npm test`; `npm run test:ui` runs it alone.

## Product Principles

1. **Idempotence & Reliability**: Every write carries a unique request ID; double-click safe with automatic button de-bounce.
2. **Speed**: one API round trip (`init`) paints Today; the bundle is a single JS and CSS file served from Pages.
3. **Auditability**: Every mutation is logged in an immutable ledger; errors can be reversed with one click.
4. **Mobile Ergonomics**: Critical daily actions (Today's dues, Got Paid, Remind) are accessible in one tap on a phone screen.
5. **High Visual Hierarchy**: Critical alerts (overdue dues, expired accounts) pop with high-contrast pills, while clear states stay calm.

## Accessibility & Inclusion

- Responsive layout adhering to minimum 360px viewport widths with WCAG AA contrast (>4.5:1 for body text, >3:1 for large numbers) in both light and dark modes.
- High-contrast visual cues for payment status (overdue, due today, paid, credit) utilizing both color and text markers.
- Full keyboard and screen-reader accessibility for autocomplete suggestions and slide-over drawers.

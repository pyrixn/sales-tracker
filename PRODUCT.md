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

Unlike generic SaaS billing platforms (Stripe Billing, Chargebee) or disconnected manual spreadsheets, Sales Tracker pairs real-time bKash SMS payment matching with zero-friction WhatsApp/Discord renewal workflows and instant audit undo in a sub-second, zero-dependency interface inspired by Linear and Godly.design modern admin aesthetics.

## Design Archetype & Aesthetic Direction

- **Style World**: Godly-grade Minimalist Modern Admin. Technical, precise, dense, yet visually calm and elegant.
- **Color Identity (Purple-Bluish Admin Palette)**:
  - **Dark Mode (Default/Night)**: Obsidian midnight (`#080b12`), elevated card surface (`#0f1423`), razor-sharp borders (`#1a2238` / `rgba(255, 255, 255, 0.08)`), vivid indigo accent (`#6366f1`), violet secondary (`#8b5cf6`), glowing violet accents.
  - **Light Mode (Daylight)**: Crisp cool slate (`#f8fafc`), pure white card surfaces (`#ffffff`), subtle borders (`#e2e8f0`), deep indigo accent (`#5548eb`), deep obsidian ink (`#090d16`).
  - **Functional Accents**: Emerald status (`#059669` / `#34d399`), Amber warning (`#d97706` / `#fbbf24`), Rose overdue (`#dc2626` / `#f87171`).
- **Typography & Scale**:
  - System font stack with tabular numerals (`font-variant-numeric: tabular-nums`).
  - Monospace font for transaction hashes, currency values, and sub-codes.
  - Strict minimum font size floor of 11px for all interactive labels and meta-badges.
  - Tight heading tracking (`letter-spacing: -0.025em`) for modern digital tool feel.
- **Iconography**:
  - 100% geometric inline SVG icons (16–18px stroke icons, `stroke-width: 2px`).
  - Absolute ban on informal emojis in navigation, status, and control chrome.
- **Component Geometry & Feel**:
  - 10px card radius, 6px button radius, 9999px pill badges.
  - Customer initials avatar circles with subtle tinted background.
  - Frosted glass mobile bottom dock (`backdrop-filter: blur(16px)`).
  - Slide-over drawer with blurred backdrop overlay (`backdrop-filter: blur(8px)`).
  - Micro-interactions: Spring physics transitions (`cubic-bezier(0.16, 1, 0.3, 1)`), subtle hover lifts (`translateY(-2px)`), no bouncy keyframe effects.

## Operating Context

- Mobile and desktop responsive single-page application (`src/ui/Index.html`).
- Strict mobile viewport budget: Fits 360px+ screens without sideways horizontal scrolling (`document.scrollingElement.scrollWidth <= 360`).
- Interacts with bKash webhook relay (`reference_PaymentRelay_v9.gs`) and Supabase Edge Functions.

## Capabilities and Constraints

- **Stack**: Vanilla JavaScript frontend (zero external build dependencies, no React/Vue bloat), Supabase Edge Functions (Deno), PostgreSQL 17 database.
- **Payment Automation**: bKash SMS notification parsing, automatic reference matching, overpayment-to-credit allocation.
- **Ledger & Undo**: Change_Log audit trail with single-action undo capability for reversible transactions.
- **Communication**: Generated WhatsApp (`wa.me`) and Discord message templates for renewal and overdue reminders.
- **Security & Access**: All client traffic routes through Supabase Edge Function with service-role bypass; strict RLS on all tables.

## Brand Commitments

- **Tone**: Professional, crisp, dependable, ultra-fast, zero cognitive friction.
- **Currency**: Bangladeshi Taka (৳ / BDT).

## Evidence on Hand

- Verified Playwright test suite (`test/ui/app.test.js`) covering mobile viewport responsiveness, dues lookup, renewal logic, and undo flows.
- Anonymized sheet fixtures (`test/fixtures/sheet-2026-10-18.js`): names, contacts and codes are made up.
- Complete backend logic suite (`test/*.test.js`) with 191 passing tests (`npm run test:core`). The Playwright UI suite is also run by `npm test`; `npm run test:ui` runs it alone.

## Product Principles

1. **Idempotence & Reliability**: Every write carries a unique request ID; double-click safe with automatic button de-bounce.
2. **Speed & Zero Bloat**: Vanilla JS UI that renders instantaneously without framework runtime initialization delays.
3. **Auditability**: Every mutation is logged in an immutable ledger; errors can be reversed with one click.
4. **Mobile Ergonomics**: Critical daily actions (Today's dues, Got Paid, Remind) are accessible in one tap on a phone screen.
5. **High Visual Hierarchy**: Critical alerts (overdue dues, expired accounts) pop with high-contrast pills, while clear states stay calm.

## Accessibility & Inclusion

- Responsive layout adhering to minimum 360px viewport widths with WCAG AA contrast (>4.5:1 for body text, >3:1 for large numbers) in both light and dark modes.
- High-contrast visual cues for payment status (overdue, due today, paid, credit) utilizing both color and text markers.
- Full keyboard and screen-reader accessibility for autocomplete suggestions and slide-over drawers.

# Design system

Source of truth is `web/src/index.css` (tokens) and `web/src/components/` (kit and shadcn primitives). This file records what shipped; `PRODUCT.md` holds the direction.

Name: Night Ledger. Mode: Operate. A single owner works through dues, payments and reminders on a phone, often in daylight. Familiar controls, dense but calm, one loud number per screen.

## Colour

One dominant colour, one sharp accent. Every colour is a CSS variable; components use the Tailwind names (`bg-card`, `text-muted-foreground`, `text-ok`) and never raw hex.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#080906` | `#f2efe6` | page, under a faint lime glow and a 44px line grid |
| `--card` | `#0f110c` | `#faf8f2` | sections, sheets |
| `--foreground` | `#ecefe2` | `#14160f` | text |
| `--muted-foreground` | `#9ba091` | `#5d6153` | secondary text |
| `--border` | `#ecefe2` at 10% | `#14160f` at 12% | hairlines do most of the work |
| `--primary` | `#cdf03c` | `#151a0b` | the one accent: primary buttons, active nav, today's bar. Text on it is `--primary-foreground` |
| `--ok` / `--warn` / `--bad` | `#7ee08f` / `#f5bd45` / `#ff7a63` | `#2a6f3a` / `#8c5205` / `#a52b16` | paid, soon, owed or overdue. Always paired with a text label |

Dark is the default for the dark system setting; the theme follows `prefers-color-scheme` until the user picks System, Light or Dark (stored as `sales_tracker_theme`, applied by `theme-init.js` before paint).

## Type

All self-hosted through `@fontsource` packages (no third-party font host, which the CSP forbids).

- Display: Fraunces. `.page-title` is weight 800, tight tracking. `.hero-figure` is weight 200, 4.25rem to 9.5rem. The 11px to 150px range is deliberate.
- Body: Bricolage Grotesque. Emphasis is weight 700 to 800, never 600.
- Mono: JetBrains Mono for money (`.money`), references, transaction ids and the uppercase `.eyebrow` labels (11px, 0.14em tracking).
- Bangla falls back to Noto Sans Bengali. The taka sign comes from that font, so it is always set smaller and top-aligned next to a figure.
- Numbers are tabular everywhere. `tk()` formats money: whole taka without decimals, fractions with two, a real minus sign.

## Shape, depth, motion

- Radius `0.75rem` base. Sections `rounded-xl`, the Today and money heroes `rounded-2xl`, buttons and inputs `rounded-md`, pills and avatars fully round.
- Surfaces are translucent cards over the atmosphere, with `backdrop-blur`. The mobile dock and header are frosted.
- Motion: Today reveals once on load (staggered rise), screens cross-fade in 220ms, sheets slide. Reduced motion removes all of it.

## Layout

- Under 768px: sticky header (title, search, More, quick actions), floating dock with five destinations. Bottom sheets for forms.
- 768px and up: 15rem sidebar (nav in three groups, Operate, Money and System, with number shortcuts; New sale, Got paid, Renew, search, theme), right-hand sheets, Today as a 12-column bento at xl (hero 7 columns beside the runway; one column below, same order as the phone). `[` or the bottom toggle folds it to a 4rem icon rail (names stay on the buttons as aria-labels).
- Destinations: Today, Customers, Accounts, Dues, Money (Profit and Book as tabs), More. On a phone the dock holds the first five and More sits in the header. The hash (`#/dues`) keeps back and reload working.
- Must hold at 360px with no sideways scroll. Grids use `minmax(0, 1fr)` so one wide child cannot widen the page.

## Components

- shadcn primitives live in `web/src/components/ui/` (Button, Sheet, Command, Select/NativeSelect, Tabs, Sonner, AlertDialog, Progress and others). Do not hand-roll a control that exists there.
- `components/kit.jsx` is the app vocabulary: `SheetShell`, `Section`, `Row`, `Avatar`, `Pill`/`DaysPill`, `Field`, `Chip`, `Stepper`, `CustomerPicker`, `NoteBox`, `ErrorBox`.
- Forms use native selects (best on phones) and a type-ahead picker built from `Command`. Every field has a label joined by `id`. Saves go through `useSaver`: one request id per form, double-tap safe, undo toast.
- Delete is always an AlertDialog; the undo toast follows.

## Uplift additions (2026-10-28)

- Effects policy: one effect per screen, on the hero card only (Today: pointer spotlight plus a lime shine border while money is owed; Money Net card: spotlight only). In-house in `components/fx/`. No effect on lists, tables, sheets or forms; none runs on every refresh; reduced motion removes them.
- Figures: `components/Figure.jsx` rolls digits with NumberFlow (plain-text copy for screen readers and tests). `ProfitFigure` shows full billed profit big and, only while something is unpaid, a smaller gray "collected" figure.
- Data views: `DataTable` (TanStack Table v8, Virtuoso above 60 rows) at md and up on Customers and Money > Book; phones keep the card rows. `BulkBar` for selections (CSV export, copy list, reminder copy and Mark all sent; never delete). `SavedViews` keep filter, sort and columns per screen in localStorage.
- Screens added: Insights (charts, lazy), Inbox, Reminders, Calendar, Activity (Undo for the newest change only), Settings, customer workspace at `#/customers/<id>`. Notification bell in the header. Density (Comfortable or Compact) in Settings > Appearance, md and up only.
- Empty states use `EmptyArt` line drawings. Charts use `--chart-1` to `--chart-5` tokens and a text legend or table behind each chart.
- Colour tokens: light `--warn` and `--bad` were darkened so text on tinted pills passes 4.5:1.

## Features that shape the design

- Command palette (Ctrl or Cmd + K, or `/`): actions, screens, customers.
- Shortcuts when no field is focused: `N` new sale, `P` got paid, `R` renew, `1` to `9` screens in sidebar order, `[` collapses the sidebar.
- Today: owed figure, 14-day renewal runway, unmatched payments, reminders, auto-matched payments.
- Dues: aging chips (not late, 1 to 7, 8 to 30, 30+ days), search, sort, copy payment link, CSV export.
- Accounts: one card per shared account (login label, renewal countdown, slot meter, collected / cost / net / due, a row per user with status and paid-till, open slots with a Sell it shortcut). This replaces the old spreadsheet block per account.
- Customers: filter chips (owes, credit, expiring), sort, WhatsApp shortcut on the customer page.

## Pay page and Pay links

- The customer pay page (`src/server/pay-page.js`, served through `functions/pay/`) is a separate surface from the panel. It is a transaction on a phone, often opened from WhatsApp, so it is one card, large touch targets, and its own light and dark themes.
- Flow: order summary and a four-step order tracker (created, waiting, received, confirmed), then "How do you want to pay?" with one tile per enabled method, then the customer's number, then the steps for that method.
- Each method has its own colours (`.m-bkash` pink, `.m-nagad` orange, `.m-upay` teal, `.m-bank` navy) set as `--b`, `--bi`, `--bt` on the tile and its panel. Text on a brand fill stays at 4.5:1 or better.
- The page is built from a JSON data block with `textContent`, never `innerHTML`, so a customer name or bank note cannot become markup.
- Pay links tab (desktop sidebar, or More on a phone): one row per live line with its order status (Not opened, Waiting, Says paid, Payment in, Confirmed), Copy, Send on WhatsApp, Open, and Got paid when the customer says they paid. Methods sheet turns methods on and sets the numbers and bank account.

## Rules

- Colour is never the only signal: overdue, expiring and paid carry text.
- Nothing interactive below 11px type. Touch rows are at least 64px tall.
- Money and codes are mono. Names are Bricolage. Only figures and titles are Fraunces.
- No inline styles in our own components; no emoji as icons; no purple or blue gradients.

## Installable app

The panel installs to a home screen through a standalone web manifest (`web/public/manifest.webmanifest`, `display: standalone`, colours from the dark `--background`), with PNG icons drawn from the lime `L` mark (`web/public/icon.svg`). There is no service worker, on purpose: a cached copy of an authenticated API client could show stale money figures after a payment, and offline use is not a goal. The app needs the network for every figure it shows.

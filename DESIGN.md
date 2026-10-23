# Design system

Source of truth is `src/ui/Index.html` (tokens in the `:root` blocks at the top). This file records what shipped; `PRODUCT.md` holds the direction.

Mode: Operate. A single owner works through dues, payments and reminders on a phone, often in daylight. Familiar controls, dense but calm.

## Colour

`--accent` is for fills (primary buttons). `--accent-fg` is for text, links, active states and outlines. Both exist because the brand indigo alone fails AA as small text on dark surfaces.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f8fafc` | `#080b12` | page |
| `--panel` | `#ffffff` | `#0f1423` | cards, sheets, dock |
| `--ink` | `#090d16` | `#f1f5f9` | text |
| `--muted` | `#5b6678` | `#94a3b8` | secondary text (4.5:1 or better on `--bg`) |
| `--line` | `#e2e8f0` | `#1a2238` | borders |
| `--accent` | `#5548eb` | `#5558e6` | fills, white text on top |
| `--accent-fg` | `#4338ca` | `#a5b4fc` | indigo text and outlines |
| `--ok` / `--warn` / `--bad` | `#047857` / `#b45309` / `#dc2626` | `#34d399` / `#fbbf24` / `#f87171` | paid, soon, overdue (always with a text label) |

Both themes follow `prefers-color-scheme`. `data-theme` on `<html>` forces one.

## Type and numbers

System font stack with Noto Sans Bengali for Bangla. Tabular numerals everywhere. Monospace only for money and codes (`.num`, `.sum-val`). Body 14px, labels 12–13px, nothing interactive below 11px. Card headings are sentence case, 13px, weight 600.

Money: whole taka show no decimals, fractions always show two (`৳1,360`, `৳35,146.80`). Negatives read `−৳2,345`. Use `tk()`.

## Shape and depth

Cards 10px radius, buttons and inputs 6px, pills and avatars fully round. Hairline borders do most of the work; shadows are small and offset. The mobile dock is frosted (`backdrop-filter: blur(16px)`).

## Icons

One inline SVG sprite at the top of `<body>`: 24px grid, 2px round stroke, `currentColor`. Use `ic('name')` in script. Add a new icon by adding a `<symbol id="i-name">`. No emoji or text glyphs as icons.

## Components

- `.btn` (default, `.primary`, `.ghost`, `.sm`, `.icon-only`): 40px high, 34px for `.sm`. One primary action per row.
- `.row` (60px minimum) with `.avatar` (initials, five stable tints per name), `.who` (name over detail, `.wrap` lets detail wrap), `.pill`.
- `.summary` + `.sum-lines`: one headline figure with supporting lines. Used by Today, Profit and Book via `summaryCard()`.
- `.card` with `.card-head` (icon, title, count badge).
- Sheets slide in over the page. The Save button is sticky so it stays reachable on long forms.
- States: hover, focus-visible ring, disabled, error box. Selection, caret and scrollbars are themed.

## Rules

- Phone first: 360px with no sideways scroll. Rows must keep the customer name and reference readable at that width, so actions stack on the right and details wrap.
- Today puts payments waiting to be matched first, then reminders, then renewals.
- Colour is never the only signal: overdue, expiring and paid carry text.
- Motion is state only, 150–250ms, ease-out.

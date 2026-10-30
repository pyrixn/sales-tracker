# Third-party code

Licences checked in each package's `package.json` on 2026-10-28 (npm packages), versions as pinned by `package-lock.json`. Copied (vendored) components go in the second table once they exist.

## Libraries added by the uplift plan

| Library | Version | Licence | Source | Used in |
|---|---|---|---|---|
| recharts | 3.10.1 | MIT | https://github.com/recharts/recharts | Insights charts (task 2.3), lazy chunk only |
| @tanstack/react-table | 8.21.3 | MIT | https://github.com/TanStack/table | desktop tables: `web/src/components/DataTable.jsx` (task 3.1, lazy screens only). Pinned to v8; npm's default is v9, which has a different API |
| react-virtuoso | 4.18.19 | MIT | https://github.com/petyosi/react-virtuoso | `TableVirtuoso` inside `DataTable` above 60 rows (task 3.1) |
| react-day-picker | 10.0.2 | MIT | https://github.com/gpbl/react-day-picker | range picker on Insights (task 2.3) |
| date-fns | 4.4.0 | MIT | https://github.com/date-fns/date-fns | with react-day-picker |
| @number-flow/react | 0.6.2 | MIT | https://github.com/barvian/number-flow | animated figures: `web/src/components/Figure.jsx` (task 1.1), used by Today's owed figure, the Profit and Overview hero numbers. Ships in the first-load chunk (about 5.7 KB gzip) |

Already in the app before the plan: React, Vite, Tailwind, Radix (MIT), motion, cmdk, vaul, sonner, next-themes (MIT), lucide-react (ISC), class-variance-authority, clsx, tailwind-merge, the Fontsource fonts (OFL).

## Vendored components

| File | Library | Version or date | Licence | Source URL |
|---|---|---|---|---|
| `web/src/components/ui/*.jsx` | shadcn/ui (new-york) | copied before the plan | MIT | https://github.com/shadcn-ui/ui |
| `web/src/components/ui/chart.jsx` | shadcn/ui chart (wraps recharts) | copied 2026-10-28 with `shadcn add chart --view` (card.jsx not overwritten); local changes: `@/lib/utils` import, `valueFormat` prop on `ChartTooltipContent` | MIT | https://github.com/shadcn-ui/ui |
| `web/src/components/ui/calendar.jsx` | written here for react-day-picker v10 (the shadcn calendar targets v9 and would overwrite Button) | 2026-10-28 | own code | n/a |
| `web/src/components/fx/Spotlight.jsx`, `web/src/components/fx/ShineBorder.jsx` | written here (uplift 1.3); no library copy | 2026-10-28 | own code | n/a |

Before copying any component from a registry, open the library's LICENSE, confirm it allows commercial use and modification, and add a row above. If the licence is unclear or has a non-commercial clause, do not use it.

## Hygiene checklist for a vendored component

`test/vendored-hygiene.test.js` enforces the first two lines for `web/src/components/ui/` and `web/src/components/fx/`.

- Colours only through tokens (`bg-card`, `text-ok`); no `#hex`, `rgb(`, purple, violet, indigo or blue palette classes.
- No `style={{` except a numeric CSS variable with a comment; the pointer spotlight sets `--mx`/`--my` with `element.style.setProperty`.
- Honours reduced motion; keyboard operable.
- No remote image or font URL (the CSP forbids it, see `headers()` in `tools/build.js`).
- Drop any `"use client"` line; rename `.tsx` to `.jsx`.
- Non-shadcn effects live in `web/src/components/fx/` with a header comment: library, source URL, licence, date copied.

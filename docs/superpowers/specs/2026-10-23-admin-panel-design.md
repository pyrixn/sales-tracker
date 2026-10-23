---
name: admin-panel-design
description: Design spec for full admin panel covering AI accounts, subscriptions, gift cards, multi‑currency cost handling, supplier tracking, profit dashboards, reminders, and multi‑payment verification.
metadata:
  type: reference
---

# Admin Panel Design Spec

## Goal
Create an admin UI and backend to manage reselling AI accounts, streaming subscriptions, and gift‑card codes. Track buy price (USDT/BDT), sold price (BDT), per‑product margins, supplier costs, and automate renewal reminders via WhatsApp/Discord/Messenger. Support multiple payment providers (bKash, Upay, Nagad) and live USDT→BDT rates from Bybit P2P.

## Architecture
- **Frontend**: Vanilla JS SPA (`src/ui/Index.html`) extended with new tabs and forms.
- **Backend**: Supabase Edge Functions (`src/server/edge.js`) handling payment verification, live‑rate fetch, and supplier CRUD.
- **Database**: PostgreSQL schema extended (see `src/adapters/postgres.js` updates). All traffic goes through Edge Function using service‑role bypass.
- **External services**: Bybit P2P API for USDT→BDT rate, bKash/Upay/Nagad webhook relays.

## Global Constraints
- All tables retain RLS with no public anon access.
- All monetary values stored as `numeric(12,2)` in BDT; USDT amounts stored separately.
- Exchange rate fetched at most every 5 min, cached only in the `live_rates` table.
- Supplier records must include `name`, `contact`, `currency` (USDT/BDT), and `default_markup_percent`.
- Gift‑card codes may be bulk; `codes` table gains `batch_id` and `status` (`Available`, `Pending`, `Sold`).
- Payment verification supports `bKash`, `Upay`, `Nagad`. Each provider uses its own webhook table (`payment_inbox`) with a `source` column.

## Data Model Extensions
### New Tables
```sql
-- Suppliers
create table suppliers (
  supplier_id   text primary key,
  name          text not null,
  contact       text not null default '',
  currency      text not null default 'BDT',
  markup_percent numeric(5,2) not null default 0,
  notes         text not null default ''
);
create index suppliers_name_idx on suppliers(name);

-- USDT↔BDT live rate cache
create table live_rates (
  id            text primary key default 'usdt_bdt',
  rate          numeric(12,6) not null,
  fetched_at    timestamptz not null default now()
);

-- Profit snapshots (monthly)
create table profit_snapshots (
  month        text primary key, -- YYYY‑MM
  revenue_bdt  numeric(12,2) not null default 0,
  cost_bdt     numeric(12,2) not null default 0,
  profit_bdt   numeric(12,2) not null default 0,
  generated_at timestamptz not null default now()
);
```
### Existing Tables Modified
- **products**: add `category` values `AI_Account`, `Subscription`, `Gift_Card`.
- **sales**: add columns `buy_price_usdt numeric(12,6)`, `buy_currency text` (`USDT` or `BDT`). Existing `cost_snapshot` stays for backward compatibility.
- **codes**: add `batch_id text`, `status text default 'Available'`.
- **payments**: add `source text` already present, but now include values `bKash`, `Upay`, `Nagad`.

## Core Logic Additions
### 1. Live Rate Service (`src/core/util.js`)
Add function `getLiveRate()` that:
- Checks `live_rates` table for timestamp < 5 min → fetch from Bybit P2P API (`https://api.bybit.com/v5/market/tickers?category=linear&symbol=USDTBDT`), store `rate` and `fetched_at`.
- Returns `rate` as `Number`.
### 2. Supplier Cost Calculation (`src/core/ledger.js`)
- Extend `saleCost(sale, products)` to:
  - Retrieve supplier via `product.supplier_id`.
  - Convert `buy_price_usdt` to BDT using live rate if `buy_currency='USDT'`.
  - Apply `supplier.markup_percent` on top of base cost.
- Return total cost BDT for margin computation.
### 3. Profit Dashboard (`src/core/views.js`)
Add `profitByFamily(state)` that:
- Groups active sales by `product.category` → `AI_Account`, `Subscription`, `Gift_Card`.
- For each group computes:
  - `revenue = sum(sale_price * months)`
  - `cost = sum(computed_cost_bdt)`
  - `margin = revenue - cost`
- Returns array ordered by `margin` descending.
- UI renders a table with columns: Category, Revenue BDT, Cost BDT, Profit BDT, %Margin.
### 4. Supplier Management UI (`src/ui/Index.html`)
- New tab **Suppliers** with CRUD form.
- Fields: Name, Contact, Currency (select), Markup %.
- Save via Edge Function endpoint `/suppliers` (POST/GET/PUT/DELETE).
### 5. Gift‑Card Bulk Handling UI
- **Codes** tab adds *Batch* view: create batch (name, product, quantity). System generates placeholder rows with status `Pending`.
- When a code is sold, UI marks that row `Sold` and stores actual `code` string.
### 6. Multi‑Payment Verification (`src/core/matching.js`)
- Extend `planInboxMatch` to handle `source` values `bKash`, `Upay`, `Nagad`.
- Add provider‑specific sender check functions.
- Keep existing auto‑matching for bKash; others default to manual pending.
### 7. Reminder Templates and Cadence
- Reminder cadence: days-before / on-day / days-after expiration, plus a repeat due reminder every 5 days.
- Setting key `due_reminder_every_days` defaults to `5`.
- Extend `settings` with keys `msg_renew_<product_id>_en`, `msg_renew_<product_id>_bn` etc.
- `Core.reminders.planReminders` picks product‑specific template if exists, else fallback to global.
### 8. Monthly Profit Snapshot Job
- Edge Function `cron/profit_snapshot` runs on first day of month:
  - Calls `Core.views.profitByFamily(state)` for previous month.
  - Inserts row into `profit_snapshots`.
  - Emits log entry.
- Register via Supabase Scheduled Triggers.

## API Endpoints (Edge Function extensions)
| Path | Method | Purpose |
|------|--------|---------|
| `/suppliers` | GET | List suppliers |
| `/suppliers` | POST | Create supplier (body: {name,contact,currency,markup_percent}) |
| `/suppliers/:id` | PUT | Update supplier |
| `/suppliers/:id` | DELETE | Delete supplier |
| `/rates/usdt-bdt` | GET | Return cached rate, force refresh optional `?refresh=1` |
| `/profit-snapshot` | POST | Trigger immediate snapshot (admin only) |

## UI Flow Summary
1. **Dashboard** – shows profit by family, renewal alerts, pending codes.
2. **New Sale** – select product → auto‑populate buy price (USDT/BDT) from supplier defaults → enter sold price → submit.
3. **Codes** – create batch → view pending → mark sold with actual code.
4. **Suppliers** – manage list; each product links to a supplier.
5. **Reminders** – generate WhatsApp link with product‑specific template; one‑tap send.
6. **Settings** – UI for global `bkash_number`, `pay_base_url`, live rate timestamp, etc.

## Review Focus (5 likely failure points)
- **Live rate fetch**: network failure → fallback to last cached rate; UI must show “rate stale”.
- **Supplier‑cost loop**: circular reference if product points to nonexistent supplier.
- **Bulk code batch creation**: ensure batch size matches `quantity`; avoid duplicate `code_id`.
- **Multi‑payment source handling**: Upay/Nagad webhook payload format may differ; need mapping test.
- **Margin calculation**: rounding errors; use `Core.util.round2` consistently.

---
**Next step**: write the implementation plan (`docs/superpowers/plans/2026-10-23-admin-panel-implementation.md`). Await your permission to start.

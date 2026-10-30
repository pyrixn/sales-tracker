-- Admin Panel extensions: suppliers, live_rates, profit_snapshots + column additions
-- Extends 001_schema.sql. All traffic through Edge Function (service role bypasses RLS).

-- ── Suppliers ────────────────────────────────────────────────────────────────
create table if not exists suppliers (
  supplier_id    text primary key,
  name           text not null,
  contact        text not null default '',
  currency       text not null default 'BDT',
  markup_percent numeric(5,2) not null default 0,
  notes          text not null default ''
);
create index if not exists suppliers_name_idx on suppliers(name);

-- ── USDT↔BDT live rate cache ─────────────────────────────────────────────────
create table if not exists live_rates (
  id         text primary key default 'usdt_bdt',
  rate       numeric(12,6) not null,
  fetched_at timestamptz not null default now()
);

-- ── Profit snapshots (monthly) ───────────────────────────────────────────────
create table if not exists profit_snapshots (
  month        text primary key, -- YYYY-MM
  revenue_bdt  numeric(12,2) not null default 0,
  cost_bdt     numeric(12,2) not null default 0,
  profit_bdt   numeric(12,2) not null default 0,
  generated_at timestamptz not null default now()
);

-- ── Extend sales: buy price tracking ─────────────────────────────────────────
alter table sales add column if not exists buy_price_usdt numeric(12,6);
alter table sales add column if not exists buy_currency text not null default 'BDT';

-- ── Extend codes: batch tracking ─────────────────────────────────────────────
alter table codes add column if not exists batch_id text not null default '';

-- ── Extend products: supplier link + per-product templates ───────────────────
alter table products add column if not exists supplier_id text not null default '';
alter table products add column if not exists template_renew text not null default '';
alter table products add column if not exists template_due text not null default '';

-- ── RLS on new tables ────────────────────────────────────────────────────────
alter table suppliers         enable row level security;
alter table live_rates        enable row level security;
alter table profit_snapshots  enable row level security;
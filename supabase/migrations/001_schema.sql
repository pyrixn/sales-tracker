-- Sales Tracker schema for Supabase (PostgreSQL 17)
-- Mirrors the Google Sheets structure exactly so the migration is a straight INSERT.
-- Dates are stored as TEXT 'YYYY-MM-DD' because the core treats them as strings throughout.

-- ── Extensions ────────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── Reset (safe on a fresh project; drop in dependency order) ─────────────────
drop table if exists change_log, reminders_log, payment_inbox, codes, purchases,
  expenses, payments, sales, customers, wallets, accounts, products, settings cascade;

-- ── Settings ──────────────────────────────────────────────────────────────────
create table settings (
  key   text primary key,
  value text not null default ''
);
insert into settings (key, value) values
  ('bkash_number',             ''),
  ('language',                 'en'),
  ('pay_base_url',             ''),
  ('reminder_days_before',     '3'),
  ('reminder_days_after',      '2'),
  ('due_reminder_every_days',  '5'),
  ('grace_days',               '3'),
  ('discord_enabled',          'false'),
  ('msg_renew_en',             'Hi {name}, your {product} ends {date}. Renew: bkash {bkash} (ref {ref})'),
  ('msg_renew_bn',             'হ্যালো {name}, আপনার {product} {date} তারিখে শেষ হবে। রিনিউ: {bkash} (ref {ref})'),
  ('msg_due_en',               'Hi {name}, you owe {price} for {product}. Pay: {bkash} (ref {ref})'),
  ('msg_due_bn',               'হ্যালো {name}, {product}-এ আপনার {price} বাকি আছে। পেমেন্ট: {bkash} (ref {ref})')
on conflict do nothing;

-- ── Products ──────────────────────────────────────────────────────────────────
create table products (
  product_id         text primary key,
  product_name       text not null,
  category           text not null default 'Subscription',
  platform           text not null default '',
  billing_cycle_days int  not null default 30,
  account_cost       numeric(12,2) not null default 0,
  slots_per_account  int  not null default 5,
  code_unit_cost     numeric(12,2) not null default 0,
  default_price      numeric(12,2) not null default 0,
  active             text not null default 'Yes',
  letter             char(1) not null
);

-- ── Accounts ─────────────────────────────────────────────────────────────────
create table accounts (
  account_id     text primary key,
  product_id     text not null,
  account_label  text not null default '',
  cycle_cost     numeric(12,2) not null default 0,
  renewal_date   text not null default '',
  slots          int  not null default 5,
  notes          text not null default '',
  account_status text not null default 'Active'
);

-- ── Wallets ───────────────────────────────────────────────────────────────────
create table wallets (
  wallet_id text primary key,
  label     text not null,
  type      text not null default '',
  notes     text not null default ''
);

-- ── Customers ─────────────────────────────────────────────────────────────────
create table customers (
  customer_id     text primary key,
  name            text not null,
  channel         text not null default '',
  handle          text not null default '',
  discord_user_id text not null default '',
  notes           text not null default '',
  created         text not null default ''
);

-- ── Sales ─────────────────────────────────────────────────────────────────────
create table sales (
  sale_id         int  primary key,
  sale_date       text not null default '',
  customer        text not null default '',
  contact         text not null default '',
  product_id      text not null,
  account_id      text not null default '',
  code_id         text not null default '',
  qty             int  not null default 1,
  unit_price      numeric(12,2) not null default 0,
  paid_till       text not null default '',
  record_status   text not null default 'Active',
  notes           text not null default '',
  payment_method  text not null default '',
  transaction_id  text not null default '',
  cost_snapshot   numeric(12,2) not null default 0,
  customer_id     text not null,
  months          int  not null default 1,
  sub_code        text not null default ''
);
create index sales_customer_idx on sales(customer_id);
create index sales_sub_code_idx on sales(sub_code);
create index sales_status_idx   on sales(record_status);

-- ── Payments ─────────────────────────────────────────────────────────────────
create table payments (
  payment_id     text primary key,
  date           text not null default '',
  customer_id    text not null,
  sale_id        int,          -- null = credit / opening balance
  amount         numeric(12,2) not null,
  method         text not null default '',
  transaction_id text not null default '',
  source         text not null default '',
  note           text not null default ''
);
create index payments_customer_idx on payments(customer_id);
create index payments_sale_idx     on payments(sale_id);

-- ── Expenses ─────────────────────────────────────────────────────────────────
create table expenses (
  expense_id text primary key,
  date       text not null default '',
  category   text not null,
  amount     numeric(12,2) not null,
  paid_with  text not null default '',
  note       text not null default ''
);

-- ── Account purchases ─────────────────────────────────────────────────────────
create table purchases (
  purchase_id  text primary key,
  date         text not null default '',
  account_id   text not null,
  paid_with    text not null default '',
  amount       numeric(12,2) not null,
  covers_until text not null default '',
  notes        text not null default ''
);

-- ── Code inventory ────────────────────────────────────────────────────────────
create table codes (
  code_id      text primary key,
  product_id   text not null,
  code         text not null,
  source_batch text not null default '',
  date_added   text not null default '',
  manual_flag  text not null default '',
  status       text not null default 'Available'
);

-- ── Payment inbox (bKash relay) ───────────────────────────────────────────────
-- id serial (not transaction_id) as PK because unrecognised SMS rows have no TrxID.
create table payment_inbox (
  id              bigserial primary key,
  transaction_id  text not null default '',
  received        text not null default '',
  type            text not null default '',
  method          text not null default '',
  sender          text not null default '',
  amount          numeric(12,2) not null default 0,
  counterparty    text not null default '',
  reference       text not null default '',
  raw_sms         text not null default '',
  status          text not null default 'Pending',
  matched_sale_id text not null default ''
);
create unique index payment_inbox_trx_idx on payment_inbox(transaction_id) where transaction_id <> '';

-- ── Reminders log ─────────────────────────────────────────────────────────────
create table reminders_log (
  id          bigserial primary key,
  date        text not null default '',
  sale_id     int  not null,
  customer_id text not null,
  kind        text not null,
  channel     text not null default '',
  status      text not null default 'queued'
);
create index reminders_log_sale_idx on reminders_log(sale_id);

-- ── Change log (audit + undo) ─────────────────────────────────────────────────
create table change_log (
  id        bigserial primary key,
  time      timestamptz not null default now(),
  batch_id  text not null,
  action    text not null,
  tab       text not null,
  row_key   text not null,
  field     text not null,
  old       text not null default '',
  new       text not null default ''
);
create index change_log_batch_idx on change_log(batch_id);

-- ── Request log (idempotency) ─────────────────────────────────────────────────
create table request_log (
  request_id text primary key,
  response   text not null,
  created_at timestamptz not null default now()
);

-- ── Row-level security: deny direct anon access. All traffic goes through the
--    Edge Function, which connects with the service role (bypasses RLS). ────────
alter table settings      enable row level security;
alter table products      enable row level security;
alter table accounts      enable row level security;
alter table wallets       enable row level security;
alter table customers     enable row level security;
alter table sales         enable row level security;
alter table payments      enable row level security;
alter table expenses      enable row level security;
alter table purchases     enable row level security;
alter table codes         enable row level security;
alter table payment_inbox enable row level security;
alter table reminders_log enable row level security;
alter table change_log    enable row level security;
alter table request_log   enable row level security;

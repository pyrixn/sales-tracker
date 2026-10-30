-- Phase 4: website-ready catalog fields on products, and the orders table.
-- New data uses typed columns (timestamptz, numeric). Every table has RLS on and no policies: only the Edge Function (service role) reads or writes.

-- Catalog fields. Nothing is public until an owner switches `public` on.
alter table products add column if not exists slug text not null default '';
alter table products add column if not exists public boolean not null default false;
alter table products add column if not exists description text not null default '';
alter table products add column if not exists image_path text not null default '';
alter table products add column if not exists sort_order int not null default 0;
-- Blank (null) means "use Default_Price".
alter table products add column if not exists public_price numeric(12,2);
do $$ begin
  alter table products add constraint products_public_price_chk check (public_price is null or public_price >= 0);
exception when duplicate_object then null;
end $$;
create unique index if not exists products_slug_idx on products (slug) where slug <> '';

-- Orders: one product, one customer, a pay request, and the sale it becomes when fulfilled.
create table if not exists orders (
  order_id        text primary key,
  created_at      timestamptz not null default now(),
  source          text not null default 'panel',
  status          text not null default 'New',
  customer_id     text not null default '',
  customer_name   text not null default '',
  contact         text not null default '',
  contact_channel text not null default '',
  product_id      text not null default '',
  months          int  not null default 1,
  unit_price      numeric(12,2) not null default 0,
  total           numeric(12,2) not null default 0,
  pay_request_id  text not null default '',
  sale_id         numeric,
  note            text not null default '',
  fulfilled_at    timestamptz,
  constraint orders_source_chk check (source in ('panel', 'website')),
  constraint orders_status_chk check (status in ('New', 'AwaitingPayment', 'Paid', 'Fulfilled', 'Cancelled')),
  constraint orders_months_chk check (months between 1 and 12),
  constraint orders_total_chk check (total >= 0 and unit_price >= 0)
);
alter table orders enable row level security;
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_pay_request_idx on orders (pay_request_id);

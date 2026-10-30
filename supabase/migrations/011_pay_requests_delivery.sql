-- Phase 3: payment requests (a pay link not tied to a sale yet) and deliveries (what was handed over after payment).
-- Code_Inventory.status also gains the value 'Reserved' (a code held for an open request); status is plain text, so no schema change.
create table if not exists pay_requests (
  request_id     text primary key,
  token          text not null default '',
  title          text not null default '',
  amount         numeric,
  customer_id    text not null default '',
  customer_name  text not null default '',
  product_id     text not null default '',
  code_id        text not null default '',
  note           text not null default '',
  status         text not null default 'Open',
  created        text not null default '',
  expires        text not null default '',
  sale_id        numeric
);
alter table pay_requests enable row level security;
create unique index if not exists pay_requests_token_idx on pay_requests (token) where token <> '';

create table if not exists deliveries (
  delivery_id   text primary key,
  sale_id       numeric,
  request_id    text not null default '',
  customer_id   text not null default '',
  product_id    text not null default '',
  code_id       text not null default '',
  kind          text not null default '',
  status        text not null default 'Pending',
  delivered_at  text not null default '',
  note          text not null default ''
);
alter table deliveries enable row level security;
create index if not exists deliveries_sale_idx on deliveries (sale_id);
create index if not exists deliveries_request_idx on deliveries (request_id);

insert into settings (key, value) values
  ('tos_text',              ''),
  ('review_discord_url',    ''),
  ('review_facebook_url',   ''),
  ('pay_link_expiry_hours', '24'),
  ('delivery_note',         '')
on conflict (key) do nothing;

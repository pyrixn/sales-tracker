-- Phase 5: public API v1 (/v1/... in the Edge Function). Every table has RLS on and no policies: only the Edge Function (service role) reads or writes.

-- API keys: one per website or integration. Only a SHA-256 hash of the key is stored; the raw key is shown once, at creation.
create table if not exists api_keys (
  key_id       text primary key,
  name         text not null default '',
  hash         text not null,
  scopes       text[] not null default '{}',
  origins      text[] not null default '{}',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index if not exists api_keys_hash_idx on api_keys (hash);
alter table api_keys enable row level security;

-- Fixed-window counters for rate limiting (one row per bucket and minute). Disposable data: rows older than an hour are pruned.
create table if not exists rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (bucket, window_start)
);
alter table rate_limits enable row level security;

-- Outbound webhooks: where to send, the signing secret (sent to the owner once), and the events wanted.
create table if not exists webhook_endpoints (
  id         text primary key,
  url        text not null,
  secret     text not null,
  events     text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table webhook_endpoints enable row level security;

-- One row per event per endpoint. The id is the event id the receiver sees, so a resend keeps it and a receiver can dedupe.
create table if not exists webhook_deliveries (
  id           text primary key,
  endpoint_id  text not null references webhook_endpoints (id),
  event        text not null,
  payload      jsonb not null,
  attempts     int not null default 0,
  status       text not null default 'pending',
  next_try_at  timestamptz not null default now(),
  last_error   text not null default '',
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  constraint webhook_deliveries_status_chk check (status in ('pending', 'delivered', 'failed')),
  constraint webhook_deliveries_attempts_chk check (attempts >= 0)
);
create index if not exists webhook_deliveries_status_idx on webhook_deliveries (status, next_try_at);
alter table webhook_deliveries enable row level security;

-- Website orders: the API key that placed the order, the Idempotency-Key it came with, a hash of its body (a repeat with the
-- same key but another body is refused), and the token the customer uses to read the order.
alter table orders add column if not exists api_key_id text not null default '';
alter table orders add column if not exists idem_key text not null default '';
alter table orders add column if not exists request_hash text not null default '';
alter table orders add column if not exists access_token text not null default '';
create unique index if not exists orders_idem_idx on orders (api_key_id, idem_key) where idem_key <> '';

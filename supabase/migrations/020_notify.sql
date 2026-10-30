-- Notification outbox: messages waiting to be sent to customers (WhatsApp templates) and to the owner (Discord, Telegram).
-- Every table has RLS on and no policies: only the Edge Function (service role) reads or writes.

-- The id is the dedupe key the planner builds (for example remind:<sale>:<cycle>), so queuing the same message twice does nothing.
-- A row is claimed by moving it to 'sending' with a lease in next_try_at; only the claiming run sends it.
create table if not exists notify_outbox (
  id          text primary key,
  channel     text not null,
  to_ref      text not null default '',
  template    text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',
  attempts    int not null default 0,
  next_try_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  error       text not null default '',
  constraint notify_outbox_channel_chk check (channel in ('discord', 'whatsapp', 'telegram')),
  constraint notify_outbox_status_chk check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint notify_outbox_attempts_chk check (attempts >= 0)
);
create index if not exists notify_outbox_due_idx on notify_outbox (status, next_try_at);
alter table notify_outbox enable row level security;

-- Settings rows the Notifications card reads and saves. The settings planner only updates existing keys, so the rows exist first.
-- Switches start off; WhatsApp template names start blank (a blank name means that kind is not sent).
insert into settings (key, value) values
  ('notify_whatsapp_enabled', 'false'), ('notify_discord_enabled', 'false'), ('notify_telegram_enabled', 'false'),
  ('wa_tpl_before', ''), ('wa_tpl_on_day', ''), ('wa_tpl_after', ''), ('wa_tpl_due', ''), ('bkash_account_name', '')
on conflict (key) do nothing;

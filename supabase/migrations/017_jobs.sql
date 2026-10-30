-- Scheduled jobs (POST /cron/<job>), job history for the panel, backend indexes, and the relay heartbeat row.
-- Owner steps after this runs (not in SQL): create a private Storage bucket named `backups`; set the Edge Function secret
-- CRON_TOKEN; then add the schedules below in the SQL editor, with your function URL and the same CRON_TOKEN.

-- pg_cron is installed in pg_catalog (its only supported schema); pg_net goes in the extensions schema.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- One row per job run, written by the Edge Function whatever the outcome. pg_net is fire-and-forget, so this row is the only
-- record that a scheduled call reached the job. started_at and finished_at are ISO text (UTC), like the rest of the schema.
create table if not exists job_runs (
  id          bigserial primary key,
  job         text not null,
  started_at  text not null default '',
  finished_at text not null default '',
  ok          boolean not null default false,
  detail      text not null default ''
);
alter table job_runs enable row level security;
create index if not exists job_runs_job_idx on job_runs (job, id desc);

-- Public pay-page reads (the status poll runs on every open page). Plain expression indexes, not partial ones: the lookups pass a
-- parameter, and Postgres cannot prove a parameterised `upper(reference) = $1` implies a `reference <> ''` partial predicate.
create index if not exists payment_inbox_reference_upper_idx on payment_inbox (upper(reference));
create index if not exists payment_inbox_counterparty_idx on payment_inbox (counterparty);
create index if not exists payments_transaction_upper_idx on payments (upper(transaction_id));
create index if not exists change_log_row_idx on change_log (tab, row_key, id desc);

-- Last time the relay phone reported in (a text "heartbeat" POST to /relay). Empty until the first one.
insert into settings (key, value) values ('relay_heartbeat', '') on conflict (key) do nothing;

-- Example schedules. Uncomment one at a time in the Supabase SQL editor after replacing the two placeholders.
-- The URL is your function base plus /cron/<job>. The token is CRON_TOKEN, never the service-role key.
-- Cron times are UTC: Dhaka is UTC+6, so 09:00 Dhaka is 03:00 UTC.
--
-- select cron.schedule('match-sweep', '*/10 * * * *', $$
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/match-sweep',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('rate', '*/30 * * * *', $$
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/rate',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('backup', '0 21 * * *', $$   -- 03:00 Dhaka
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/backup',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('cleanup', '0 22 * * *', $$   -- 04:00 Dhaka
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/cleanup',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('relay-check', '0 * * * *', $$
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/relay-check',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('webhooks', '*/5 * * * *', $$
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/webhooks',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);
-- select cron.schedule('notify', '*/10 * * * *', $$
--   select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/api/cron/notify',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Token', '<CRON_TOKEN>'), body := '{}'::jsonb);
-- $$);

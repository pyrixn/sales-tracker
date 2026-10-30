-- Phase 4: money dashboard. Goals (a target for a metric over a date range), budgets (a monthly limit per
-- expense category), and the saved order of the dashboard cards. Migration 011 belongs to Phase 3 (numbering gap is intended).
create table if not exists goals (
  goal_id  text primary key,
  title    text not null default '',
  metric   text not null default 'revenue',   -- revenue | profit | collected | new_customers
  target   numeric not null default 0,
  start_date text not null default '',
  end_date text not null default '',
  note     text not null default '',
  status   text not null default 'Active'     -- Active | Done | Dropped
);
alter table goals enable row level security;

create table if not exists budgets (
  budget_id     text primary key,
  category      text not null default '',
  monthly_limit numeric not null default 0,
  alert_pct     numeric not null default 80,
  active        text not null default 'Yes'   -- Yes | No
);
alter table budgets enable row level security;

insert into settings (key, value) values
  ('money_layout', 'net,trend,cash,dues,products,forecast')
on conflict (key) do nothing;

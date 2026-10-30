-- Data migration panel: when a sale's coverage starts, and the staging table for rows read from the old sheet.
alter table sales add column if not exists covers_from text not null default '';
create table if not exists import_rows (
  row_id text primary key,
  batch text not null default '',
  kind text not null default '',
  sheet text not null default '',
  ref text not null default '',
  data text not null default '',
  status text not null default 'Review',
  note text not null default '',
  applied text not null default '',
  created text not null default ''
);
alter table import_rows enable row level security;
create index if not exists import_rows_batch_kind_idx on import_rows (batch, kind);

insert into settings (key, value) values ('migration_panel', 'on') on conflict (key) do nothing;

-- Random customer references: style switch and a reference per pay request.
insert into settings (key, value) values ('ref_style', 'random') on conflict (key) do update set value = 'random';
alter table pay_requests add column if not exists ref text not null default '';
create unique index if not exists pay_requests_ref_idx on pay_requests (upper(ref)) where ref <> '';

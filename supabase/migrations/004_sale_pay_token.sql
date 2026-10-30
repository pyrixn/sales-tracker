-- Unguessable token for the public /pay/<token> link (sub codes are sequential, so they must not be the URL).
-- One token is shared by every sale (renewal) of a line, so the index is not unique.
alter table sales add column if not exists pay_token text not null default '';
create index if not exists sales_pay_token_idx on sales(pay_token) where pay_token <> '';

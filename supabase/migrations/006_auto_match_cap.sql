-- Largest payment (BDT) the relay may match to a sale without the owner. Above it the row stays Pending.
insert into settings (key, value) values ('auto_match_max_bdt', '5000') on conflict (key) do nothing;

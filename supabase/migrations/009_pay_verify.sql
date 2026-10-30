-- Which pay methods confirm themselves from the phone's SMS relay (the rest are confirmed by the owner by hand),
-- and the bank routing number shown on the pay page.
insert into settings (key, value) values
  ('pay_auto_verify', 'bkash,upay'),
  ('bank_routing',    '')
on conflict (key) do nothing;

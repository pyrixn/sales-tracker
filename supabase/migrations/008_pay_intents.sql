-- Pay links: what a customer chose on their pay page (method, the number they pay from, an optional
-- "I have paid" claim with a transaction id). One row per pay token, replaced as the customer progresses.
create table if not exists pay_intents (
  token         text primary key,
  method        text not null default '',
  payer_number  text not null default '',
  claim_trx     text not null default '',
  claimed       text not null default '',
  created       text not null default '',
  updated       text not null default ''
);
alter table pay_intents enable row level security;

-- Where customers can pay. pay_methods lists the enabled ones (bkash, nagad, upay, bank). bkash_number already exists.
insert into settings (key, value) values
  ('pay_methods',         'bkash'),
  ('nagad_number',        ''),
  ('upay_number',         ''),
  ('bank_name',           ''),
  ('bank_account_name',   ''),
  ('bank_account_number', ''),
  ('bank_branch',         ''),
  ('bank_note',           '')
on conflict (key) do nothing;

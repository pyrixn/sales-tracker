-- Login details handed to customers with an account sale, stored encrypted (AES-256-GCM, key in the Edge Function secret VAULT_KEY).
-- The database only ever holds ciphertext and the IV. The row id is bound into the ciphertext as AAD, so a row cannot be swapped for another.
-- RLS on, no policies: only the Edge Function (service role) reads or writes. Revealing needs the vault PIN (settings key vault_pin_hash).
create table if not exists account_secrets (
  secret_id  text primary key,
  account_id text not null default '',
  sale_id    text not null default '',
  sale_token text not null default '',   -- the sale's Pay_Token (or Sub_Code) at link time: a reused sale id never inherits this login
  label      text not null default '',
  ciphertext text not null,
  iv         text not null,
  created    text not null default '',
  updated    text not null default ''
);
create index if not exists account_secrets_account_idx on account_secrets (account_id);
create index if not exists account_secrets_sale_idx on account_secrets (sale_id);
alter table account_secrets enable row level security;
revoke all on account_secrets from anon, authenticated;

-- Delivery message templates: the owner's text with placeholders ({{name}}, {{product}}, {{profile}}, {{paidTill}}, {{login}}).
-- Plain text on purpose: a template never holds a login. {{login}} is filled from the vault at the moment a message is made.
-- product_id and account_id are blank for "any"; an account template wins over a product template.
create table if not exists delivery_templates (
  template_id text primary key,
  product_id  text not null default '',
  account_id  text not null default '',
  title       text not null default '',
  body        text not null default '',
  updated     text not null default ''
);
alter table delivery_templates enable row level security;
revoke all on delivery_templates from anon, authenticated;

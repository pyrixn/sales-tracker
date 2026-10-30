-- Phase 1: how a product is delivered, optional parent product, and how a supplier is contacted.
alter table products add column if not exists delivers_as text not null default 'account';
alter table products add column if not exists parent_id text not null default '';
alter table suppliers add column if not exists contact_channel text not null default '';

-- Multi-letter reference prefixes (1-3 letters). Existing single-letter values carry over unchanged.
alter table products alter column letter type text;
alter table products add constraint products_letter_format check (letter ~ '^[A-Z]{1,3}$');

update products set delivers_as = 'code' where category = 'Game Code';

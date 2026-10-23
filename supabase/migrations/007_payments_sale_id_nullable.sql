-- A payment with no sale is a credit (or opening balance). 001 defines sale_id as nullable,
-- but the live table rejected null. Dropping NOT NULL is a no-op where it is already nullable.
alter table payments alter column sale_id drop not null;

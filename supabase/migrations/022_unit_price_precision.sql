-- A line sold for several months stores total / months as its unit price. Two decimals lose the remainder (800 over 6 months is 133.33 x 6 = 799.98),
-- so keep six: price x months then rounds back to the exact total. Widening the type changes no stored value.
alter table sales alter column unit_price type numeric(14,6);

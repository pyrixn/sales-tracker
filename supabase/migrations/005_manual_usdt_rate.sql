-- Manual USDT/BDT rate override (blank = use the live Bybit rate).
insert into settings (key, value) values ('usdt_bdt_manual', '') on conflict (key) do nothing;

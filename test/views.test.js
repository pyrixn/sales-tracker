const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState, cid } = require('./fixtures');

test('home shows what needs attention today', () => {
  const m = makeMigratedState();
  const h = Core.views.homeData(m);
  assert.equal(Math.round(h.owed), 1360);
  assert.deepEqual(h.renewSoon.map(r => [r.name, r.daysLeft]),
    [['jamilhq', 1], ['Arman Mallik', 1], ['Arnob', 2], ['ashik rono', 3]]);
  assert.equal(h.renewSoon[1].owes, 170);
  assert.deepEqual(h.expired.map(r => r.saleId), [57, 63, 54, 68, 46, 62], 'expired in the last 30 days only (all-time count is 13)');
  assert.equal(h.expired[0].name, 'arnob TV', 'most recently expired first');
  assert.ok(h.expired.every(r => r.daysLeft < 0 && r.daysLeft >= -30));
});

test('home lists pending inbox rows and recent automatic payments', () => {
  const m = makeMigratedState();
  m.inbox = [{ Received: '2026-10-18 10:00', Type: 'Received', Sender: '16247', Amount: 290, Transaction_ID: 'T9', Reference: '', Status: 'Pending', Raw_SMS: 'x' },
             { Received: '2026-10-17 10:00', Type: 'Received', Sender: '16247', Amount: 100, Transaction_ID: 'T8', Reference: '', Status: 'Matched', Raw_SMS: 'y' }];
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-17', Customer_ID: cid(m, 'farid'), Sale_ID: 44, Amount: 290, Method: 'bKash', Transaction_ID: 'T8', Source: 'Auto', Note: '' });
  m.payments.push({ Payment_ID: 'PM-00092', Date: '2026-10-10', Customer_ID: cid(m, 'farid'), Sale_ID: 44, Amount: 1, Method: 'bKash', Transaction_ID: 'T7', Source: 'Auto', Note: '' });
  const h = Core.views.homeData(m);
  assert.deepEqual(h.unmatched.map(u => [u.trx, u.amount]), [['T9', 290]]);
  assert.deepEqual(h.autoToCheck.map(a => [a.trx, a.name, a.amount]), [['T8', 'farid', 290]]);
});

test('dues list: one row per unpaid sale, oldest first, credits apart', () => {
  const m = makeMigratedState();
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-18', Customer_ID: cid(m, 'farid'), Sale_ID: '', Amount: 40, Source: 'App' });
  const d = Core.views.duesList(m);
  assert.equal(Math.round(d.total), 1360);
  assert.deepEqual(d.rows.map(r => [r.name, r.amount]),
    [['tariq', 300], ['Kabir', 300], ['Arman Mallik', 170], ['Anik', 290], ['cust40', 220], ['nabil', 80]]);
  assert.equal(d.rows[0].daysLate, 14);
  assert.equal(d.rows[4].daysLate, null);
  assert.deepEqual(d.credits.map(c => [c.name, c.amount]), [['farid', 40]]);
});

test('customer page shows lines, dues and payments', () => {
  const m = makeMigratedState();
  const c = Core.views.customerData(m, cid(m, 'Kabir'));
  assert.equal(c.customer.Name, 'Kabir');
  assert.equal(c.owes, 300);
  assert.equal(c.lines.length, 5);
  assert.deepEqual(c.lines[0], c.lines.slice().sort((a, b) => (b.daysLeft ?? -1e9) - (a.daysLeft ?? -1e9))[0], 'longest-running first');
  assert.equal(c.lines.find(l => l.subCode === 'N54').owes, 300);
  assert.equal(c.payments.length, 4);
});

test('account book: opening balance, month entries, credit moves excluded', () => {
  const m = makeMigratedState();
  const f = cid(m, 'farid');
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-18', Customer_ID: f, Sale_ID: 44, Amount: 290, Method: 'bKash', Source: 'App' });
  m.payments.push({ Payment_ID: 'PM-00092', Date: '2026-10-18', Customer_ID: f, Sale_ID: '', Amount: -50, Method: '', Source: 'Credit' });
  m.payments.push({ Payment_ID: 'PM-00093', Date: '2026-10-18', Customer_ID: f, Sale_ID: 44, Amount: 50, Method: '', Source: 'Credit' });
  m.expenses.push({ Expense_ID: 'EX-0001', Date: '2026-10-15', Category: 'VPN', Amount: 350, Paid_With: 'UNKNOWN', Note: '' });
  m.purchases.push({ Purchase_ID: 'P-0018', Date: '2026-10-17', Account_ID: 'NFX-02', Paid_With: 'UNKNOWN', Amount: 800, Covers_Until: '', Notes: '' });
  m.purchases.forEach(p => { if (p.Purchase_ID !== 'P-0018') p.Notes = 'Opening balance from migration: real purchase date unknown'; });
  const b = Core.views.bookData(m, '2026-10');
  assert.equal(Math.round(b.opening), Math.round(33786.8 - 28070));
  assert.equal(b.in, 290);
  assert.equal(b.out, 1150);
  assert.equal(b.net, -860);
  assert.equal(Math.round(b.closing), Math.round(33786.8 - 28070 - 860));
  assert.deepEqual(b.entries.map(e => [e.date, e.kind, e.amount]), [['2026-10-15', 'out', 350], ['2026-10-17', 'out', 800], ['2026-10-18', 'in', 290]]);
});

test('lookups for the forms', () => {
  const m = makeMigratedState();
  const l = Core.views.lookups(m);
  const nfx = l.accounts.filter(a => a.productId === 'NETFLIX');
  assert.deepEqual(nfx.map(a => [a.id, a.free]), [['NFX-03', 2], ['NFX-01', 1], ['NFX-02', 1]]);
  assert.equal(l.codes.length, 30);
  assert.equal(l.customers.find(c => c.name === 'Kabir').owes, 300);
  assert.ok(l.lines.some(x => x.subCode === 'N44' && x.price === 290));
  assert.ok(l.products.some(p => p.id === 'NETFLIX' && p.letter === 'N'));
});

test('accounts overview: per-account collected, cost, net, users and open slots', () => {
  const m = makeMigratedState();
  const o = Core.views.accountsOverview(m);
  const all = o.groups.flatMap(g => g.accounts);
  const nfx3 = all.find(a => a.id === 'NFX-03');
  assert.equal(nfx3.cost, 800);
  assert.equal(nfx3.collected, 1140);
  assert.equal(nfx3.net, 340);
  assert.equal(nfx3.slots, 5);
  assert.ok(nfx3.free >= 1 && nfx3.used + nfx3.free === nfx3.slots);
  assert.ok(nfx3.rows.every(r => r.name && 'owes' in r && 'paid' in r));
  const sum = k => Math.round(all.reduce((a, x) => a + x[k], 0) * 100) / 100;
  assert.equal(o.totals.collected, sum('collected'));
  assert.equal(o.totals.cost, sum('cost'));
  assert.equal(o.totals.net, Math.round((o.totals.collected - o.totals.cost) * 100) / 100);
  assert.equal(o.totals.accounts, all.length);
});

test('accounts overview folds nameless receipts into one line and keeps them in the totals', () => {
  const m = makeMigratedState();
  const acct = m.accounts[0];
  const before = Core.views.accountsOverview(m).groups.flatMap(g => g.accounts).find(a => a.id === acct.Account_ID);
  const sale = { Sale_ID: 9001, Sale_Date: '', Customer: 'Bkash Recieve', Contact: '', Product_ID: acct.Product_ID, Account_ID: acct.Account_ID, Code_ID: '',
    Qty: 1, Unit_Price: 250, Paid_Till: '', Record_Status: 'Active', Notes: '', Payment_Method: '', Transaction_ID: '', Cost_Snapshot: 0,
    Customer_ID: '', Months: 1, Sub_Code: 'ZZ1' };
  m.customers.push({ Customer_ID: 'CU-9001', Name: 'Bkash Recieve', Channel: '', Handle: '', Notes: '', Created: '' });
  sale.Customer_ID = 'CU-9001';
  m.sales.push(sale);
  m.payments.push({ Payment_ID: 'PM-09001', Date: '', Customer_ID: 'CU-9001', Sale_ID: 9001, Amount: 250, Source: 'Migrated' });
  const after = Core.views.accountsOverview(m).groups.flatMap(g => g.accounts).find(a => a.id === acct.Account_ID);
  assert.equal(after.rows.length, before.rows.length, 'no named row added');
  assert.equal(after.unattributed.count, before.unattributed.count + 1);
  assert.equal(after.collected, before.collected + 250);
  assert.equal(after.net, before.net + 250);
});

test('host seat: one seat per Spotify account is never sellable', () => {
  const m = makeMigratedState();
  const spt = m.accounts.find(a => /^SPT/.test(a.Account_ID));
  const free = () => Core.sales.freeSlots(m, spt);
  const before = free();
  m.settings.host_seats = spt.Product_ID;
  assert.equal(free(), before - 1, 'host seat comes off the free seats');
  const o = Core.views.accountsOverview(m).groups.flatMap(g => g.accounts).find(a => a.id === spt.Account_ID);
  assert.equal(o.host, true);
  assert.equal(o.slots, Number(spt.Slots) - 1);
  assert.ok(o.used + o.free <= o.slots);
});

test('a retired account has no free seats, sorts last and keeps its profit', () => {
  const m = makeMigratedState();
  const g = Core.views.accountsOverview(m).groups.find(x => x.accounts.length > 1);
  const target = m.accounts.find(a => a.Account_ID === g.accounts[0].id);
  const before = g.accounts[0];
  target.Account_Status = 'Inactive';
  const after = Core.views.accountsOverview(m).groups.find(x => x.productId === g.productId);
  assert.equal(after.accounts[after.accounts.length - 1].id, target.Account_ID, 'retired sorts last');
  const row = after.accounts.find(a => a.id === target.Account_ID);
  assert.equal(row.retired, true);
  assert.equal(row.free, 0);
  assert.equal(row.net, before.net, 'profit unchanged');
  assert.equal(Core.sales.freeSlots(m, target), 0);
});

test('lookups hand the panel the pay page base URL, so the Settings form shows it and copied links use it', () => {
  const m = makeMigratedState();
  m.settings.pay_base_url = 'https://pay.example.test';
  assert.equal(Core.views.lookups(m).settings.pay_base_url, 'https://pay.example.test');
  delete m.settings.pay_base_url;
  assert.equal(Core.views.lookups(m).settings.pay_base_url, '');
});

test('book entries carry type and id for the detail sheet', () => {
  const m = makeMigratedState();
  m.payments.push({ Payment_ID: 'PM-00200', Date: m.today, Customer_ID: cid(m, 'farid'), Sale_ID: 44, Amount: 5, Method: 'bKash', Transaction_ID: '', Source: 'Manual', Note: '' });
  const b = Core.views.bookData(m, m.today.slice(0, 7));
  const e = b.entries.find(x => x.id === 'PM-00200');
  assert.equal(e.type, 'payment');
  assert.ok(b.entries.every(x => ['payment', 'expense', 'purchase'].includes(x.type)));
});

test('entryDetail: auto payment carries the SMS text, customer and sale', () => {
  const m = makeMigratedState();
  m.inbox = [{ Received: '2026-10-17 10:00', Type: 'Received', Sender: '16247', Amount: 290, Transaction_ID: 'T8', Reference: '', Status: 'Matched', Raw_SMS: 'You have received Tk 290.00' }];
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-17', Customer_ID: cid(m, 'farid'), Sale_ID: 44, Amount: 290, Method: 'bKash', Transaction_ID: 'T8', Source: 'Auto', Note: '' });
  const d = Core.views.entryDetail(m, { kind: 'payment', id: 'PM-00091' });
  assert.equal(d.kind, 'payment');
  assert.equal(d.row.Payment_ID, 'PM-00091');
  assert.equal(d.sms, 'You have received Tk 290.00');
  assert.equal(d.customer.Customer_ID, cid(m, 'farid'));
  assert.equal(String(d.sale.Sale_ID), '44');
  assert.deepEqual(d.audit, []);
});

test('entryDetail: expense and purchase carry their wallet; unknown ids throw', () => {
  const m = makeMigratedState();
  m.wallets = [{ Wallet_ID: 'CARD-1', Label: 'Card', Type: 'Card', Notes: '' }];
  m.expenses = [{ Expense_ID: 'EX-1', Date: m.today, Category: 'VPN', Amount: 10, Paid_With: 'CARD-1', Note: '' }];
  const d = Core.views.entryDetail(m, { kind: 'expense', id: 'EX-1' });
  assert.equal(d.wallet.Wallet_ID, 'CARD-1');
  assert.equal(d.sms, undefined);
  assert.throws(() => Core.views.entryDetail(m, { kind: 'payment', id: 'NOPE' }), /Unknown payment NOPE\./);
  assert.throws(() => Core.views.entryDetail(m, { kind: 'expense', id: 'NOPE' }), /Unknown expense NOPE\./);
  assert.throws(() => Core.views.entryDetail(m, { kind: 'purchase', id: 'NOPE' }), /Unknown purchase NOPE\./);
});

test('customer page rows carry what the panel edit sheets need', () => {
  const m = makeMigratedState();
  const f = cid(m, 'farid');
  m.payments.push({ Payment_ID: 'PM-00091', Date: '2026-10-18', Customer_ID: f, Sale_ID: '', Amount: 2290, Method: 'bKash', Source: 'App' });
  m.sales.find(s => s.Sale_ID === 44).Notes = 'gift';
  m.inbox = [{ Received: '2026-10-18 10:00', Type: 'Received', Method: 'Nagad', Sender: '16167', Amount: 290, Transaction_ID: 'T9', Status: 'Pending', Raw_SMS: 'x' }];
  const c = Core.views.customerData(m, f);
  const credit = c.payments.find(p => p.id === 'PM-00091');
  assert.equal(credit.paymentId, 'PM-00091');
  assert.equal(credit.saleId, '');
  assert.ok(c.payments.every(p => p.paymentId === p.id), 'every payment row has paymentId');
  const line = c.history.find(h => h.saleId === 44);
  assert.equal(line.notes, 'gift');
  assert.equal(typeof line.costSnapshot, 'number');
  assert.equal(Core.views.homeData(m).unmatched[0].method, 'Nagad');
});

test('dues rows carry the sale paid till and price the Dues cells edit', () => {
  const m = makeMigratedState();
  const d = Core.views.duesList(m);
  assert.ok(d.rows.length > 0);
  d.rows.forEach(r => {
    const sale = m.sales.find(s => s.Sale_ID === r.saleId);
    assert.equal(r.paidTill, sale.Paid_Till || '');
    assert.equal(typeof r.unitPrice, 'number');
  });
});

test('dues rows and customer lines carry saleId and a reminder kind', () => {
  const m = makeMigratedState();
  const d = Core.views.duesList(m);
  assert.ok(d.rows.every(r => Number.isInteger(r.saleId) && r.kind === 'due'));
  const c = Core.views.customerData(m, cid(m, 'Kabir'));
  assert.ok(c.lines.every(l => Number.isInteger(l.saleId) && ['due', 'before', 'on_day', 'after'].includes(l.kind)));
  const owing = c.lines.find(l => l.subCode === 'N54');
  assert.equal(owing.kind, 'due');
  const clear = c.lines.find(l => l.owes === 0);
  if (clear) assert.equal(clear.kind, clear.daysLeft > 0 ? 'before' : clear.daysLeft === 0 ? 'on_day' : 'after');
});

test('lookups expose reminder templates: global msg_* settings and per-product templates', () => {
  const m = makeMigratedState();
  m.settings.msg_renew_en = 'Hi {name}'; m.settings.msg_due_bn = 'বাকি {balance}';
  m.products[0].Template_Renew = 'Prod {name}';
  const l = Core.views.lookups(m);
  assert.equal(l.settings.msg_renew_en, 'Hi {name}');
  assert.equal(l.settings.msg_due_bn, 'বাকি {balance}');
  assert.equal(l.products[0].tplRenew, 'Prod {name}');
  assert.equal(l.products[0].tplDue, '');
  assert.equal(l.templateDefaults.renew.en, Core.reminders.DEFAULTS.renew.en);
});

test('lookups carry the delivery message settings and the Pending delivery count for the Delivery tab badge', () => {
  const m = makeMigratedState();
  m.settings.tos_text = 'No refunds.'; m.settings.review_discord_url = 'https://discord.gg/x';
  m.deliveries = [{ Delivery_ID: 'D1', Status: 'Pending' }, { Delivery_ID: 'D2', Status: 'Ready' }, { Delivery_ID: 'D3', Status: 'Pending' }, { Delivery_ID: 'D4', Status: 'Delivered' }];
  const l = Core.views.lookups(m);
  assert.equal(l.settings.tos_text, 'No refunds.');
  assert.equal(l.settings.review_discord_url, 'https://discord.gg/x');
  assert.equal(l.settings.review_facebook_url, '');
  assert.equal(l.pendingDeliveries, 2);
  delete m.deliveries;
  assert.equal(Core.views.lookups(m).pendingDeliveries, 0);
});

test('delivery settings save and reload through lookups', () => {
  const m = makeMigratedState();
  const vals = { pay_link_expiry_hours: '48', delivery_note: 'We reply within an hour.', tos_text: 'No refunds.', review_discord_url: 'https://discord.gg/x', review_facebook_url: 'https://facebook.com/y' };
  const r = Core.sales.planSettings(m, vals);
  assert.deepEqual(r.errors, []);
  r.ops.forEach(o => { m.settings[o.id] = o.values.Value; });
  const l = Core.views.lookups(m).settings;
  for (const k of Object.keys(vals)) assert.equal(l[k], vals[k], k);
});

test('settings text is capped', () => {
  const m = makeMigratedState();
  assert.match(Core.sales.planSettings(m, { tos_text: 'x'.repeat(4001) }).errors[0], /4000/);
  assert.match(Core.sales.planSettings(m, { delivery_note: 'x'.repeat(1001) }).errors[0], /1000/);
  assert.deepEqual(Core.sales.planSettings(m, { tos_text: 'x'.repeat(4000), delivery_note: 'x'.repeat(1000) }).errors, []);
});

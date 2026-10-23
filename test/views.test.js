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

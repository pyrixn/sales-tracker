const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

// A Netflix line (N44) with a profile, a pay link and a 290 price.
function netflix(extra) {
  const m = makeMigratedState();
  m.settings = Object.assign({}, m.settings, { pay_base_url: 'https://pay.test', bkash_number: '01700000000',
    msg_renew_en: '', msg_renew_bn: '', msg_due_en: '', msg_due_bn: '' });
  const sale = m.sales.find(s => s.Sub_Code === 'N44');
  Object.assign(sale, { Contact: 'Profile 2', Pay_Token: 'tok1', Sub_Code: 'N44', Unit_Price: 290, Months: 1,
    Paid_Till: '2026-10-25', Record_Status: 'Active', Account_ID: 'NFX-01' });
  Object.assign(m, extra || {});
  return { m, sale };
}

test('renew English: the default text with profile, link, reference and date, and the link once', () => {
  const { m, sale } = netflix();
  const r = Core.reminders.buildMessage(m, sale, 'before');
  assert.ok(r.message.indexOf('Hi ' + m.customers.find(c => c.Customer_ID === sale.Customer_ID).Name +
    ', your Netflix Premium profile Profile 2 subscription needs renewing for 1 month, amount ৳290.') === 0, r.message);
  assert.ok(r.message.indexOf('You can pay here: https://pay.test/pay/tok1') >= 0);
  assert.ok(r.message.indexOf('write this payment reference: N44') >= 0);
  assert.ok(r.message.indexOf('Your current plan ends on 2026-10-25') >= 0);
  assert.equal(r.message.split('https://pay.test/pay/tok1').length - 1, 1, 'link appears once');
  assert.ok(r.message.indexOf('Pay:') < 0, 'no extra Pay: line');
});

test('renew months: opts.months counts, and a 1-day product says days', () => {
  const { m, sale } = netflix();
  assert.ok(Core.reminders.buildMessage(m, sale, 'before', { months: 2 }).message.indexOf('needs renewing for 2 months,') >= 0);
  const short = netflix();
  short.m.products = short.m.products.map(p => p.Product_ID === 'NETFLIX' ? Object.assign({}, p, { Billing_Cycle_Days: 1 }) : p);
  assert.ok(Core.reminders.buildMessage(short.m, short.sale, 'before').message.indexOf('needs renewing for 1 day,') >= 0);
});

test('due English: says the balance is still due and gives the reference', () => {
  const { m, sale } = netflix();
  const paid = Core.ledger.paidMap(m);
  const balance = Core.util.round2(Core.ledger.saleRevenue(sale, m.products) - (paid[sale.Sale_ID] || 0));
  const r = Core.reminders.buildMessage(m, sale, 'due');
  assert.ok(r.message.indexOf(Core.reminders.money(balance) + ' is still due for your Netflix Premium profile Profile 2 subscription.') >= 0, r.message);
  assert.ok(r.message.indexOf('reference: N44') >= 0);
});

test('bn: renew and due carry the reference, link, amount and the month count in Bangla', () => {
  const { m, sale } = netflix();
  const renew = Core.reminders.buildMessage(m, sale, 'before', { lang: 'bn' }).message;
  assert.ok(renew.indexOf('N44') >= 0);
  assert.ok(renew.indexOf('https://pay.test/pay/tok1') >= 0);
  assert.ok(renew.indexOf('৳290') >= 0);
  assert.ok(renew.indexOf('1 মাস') >= 0);
  const due = Core.reminders.buildMessage(m, sale, 'due', { lang: 'bn' }).message;
  assert.ok(due.indexOf('N44') >= 0);
  assert.ok(due.indexOf('https://pay.test/pay/tok1') >= 0);
});

test('a blank profile leaves no double space and no brackets; a blank pay base URL drops the link line but keeps the reference', () => {
  const { m, sale } = netflix();
  sale.Contact = '';
  const noProfile = Core.reminders.buildMessage(m, sale, 'before').message;
  assert.ok(noProfile.indexOf('  ') < 0, 'no double space');
  assert.ok(noProfile.indexOf('()') < 0);
  assert.ok(noProfile.indexOf('your Netflix Premium profile subscription') >= 0);
  m.settings.pay_base_url = '';
  const noLink = Core.reminders.buildMessage(m, sale, 'before').message;
  assert.ok(noLink.indexOf('You can pay here') < 0, 'no dangling label');
  assert.ok(noLink.indexOf('write this payment reference: N44') >= 0);
});

test('a random-style reference is shown as stored', () => {
  const { m, sale } = netflix();
  sale.Sub_Code = 'nubnf3';
  assert.ok(Core.reminders.buildMessage(m, sale, 'before').message.indexOf('write this payment reference: nubnf3') >= 0);
});

test('custom templates keep their behaviour: old {price} works, no stripping, Pay line appended, product template wins, new placeholders work', () => {
  const { m, sale } = netflix();
  m.settings.msg_renew_en = 'Hi {name} {price} {ref}';
  const legacy = Core.reminders.buildMessage(m, sale, 'before').message;
  assert.ok(legacy.indexOf('৳290 N44') >= 0);
  assert.ok(legacy.endsWith('\nPay: https://pay.test/pay/tok1'), legacy);
  const withProduct = netflix();
  withProduct.m.products = withProduct.m.products.map(p => p.Product_ID === 'NETFLIX' ? Object.assign({}, p, { Template_Renew: 'Renew {product} {months} {amount}' }) : p);
  withProduct.m.settings.msg_renew_en = 'Hi {name} {price} {ref}';
  const own = Core.reminders.buildMessage(withProduct.m, withProduct.sale, 'before', { months: 3 }).message;
  assert.ok(own.indexOf('Renew Netflix Premium profile 3 months ৳290') === 0, own);
});

test('DEFAULTS hold the four friendly texts and the lookups expose them', () => {
  const D = Core.reminders.DEFAULTS;
  assert.equal(D.renew.en, 'Hi {name}, your {product} {profile} subscription needs renewing for {months}, amount {amount}.\nYou can pay here: {link}\nOr send {amount} by bKash Send Money to {bkash} and write this payment reference: {ref}\nYour current plan ends on {date} ({status}). Thank you!');
  assert.equal(D.due.en, 'Hi {name}, {balance} is still due for your {product} {profile} subscription.\nYou can pay here: {link}\nOr send {balance} by bKash Send Money to {bkash} and write this payment reference: {ref}\nThank you!');
  assert.equal(D.renew.bn, 'হাই {name}, আপনার {product} {profile} সাবস্ক্রিপশন {months} রিনিউ করতে হবে, পরিমাণ {amount}।\nএখানে পেমেন্ট করুন: {link}\nঅথবা {bkash} নম্বরে বিকাশ সেন্ড মানি করে {amount} পাঠান এবং রেফারেন্সে লিখুন: {ref}\nবর্তমান মেয়াদ {date} তারিখে শেষ হবে ({status})। ধন্যবাদ!');
  assert.equal(D.due.bn, 'হাই {name}, আপনার {product} {profile} সাবস্ক্রিপশনের {balance} এখনও বাকি আছে।\nএখানে পেমেন্ট করুন: {link}\nঅথবা {bkash} নম্বরে বিকাশ সেন্ড মানি করে পাঠান এবং রেফারেন্সে লিখুন: {ref}\nধন্যবাদ!');
  const { m } = netflix();
  const td = Core.views.lookups(m).templateDefaults;
  assert.equal(td.renew.en, D.renew.en);
  assert.equal(td.due.bn, D.due.bn);
});

test('planReminders items carry the new text', () => {
  const { m, sale } = netflix();
  sale.Paid_Till = '2026-10-19';
  const item = Core.reminders.planReminders(m).find(x => x.saleId === sale.Sale_ID && x.kind === 'before');
  assert.ok(item, 'a before item for the line');
  assert.ok(item.message.indexOf('write this payment reference: N44') >= 0);
});

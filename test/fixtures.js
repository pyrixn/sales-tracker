// Builds a State object (see plan "Shared shapes") from the real 2026-10-18 sheet data.
const raw = require('./fixtures/sheet-2026-10-18');

function serialToIso(n) {
  if (n === '' || n === null || n === undefined) return '';
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

const SETTINGS = {
  bkash_number: '01700000000',
  reminder_days_before: 3,
  reminder_days_after: 2,
  due_reminder_every_days: 5,
  grace_days: 3,
  language: 'en',
  msg_renew_en: 'Hi {name}, your {product} ends on {date}. To renew for 1 month, send {price} by bKash Send Money to {bkash} with Reference {ref}. Thanks!',
  msg_due_en: 'Hi {name}, a reminder that {price} is still due for {product}. Please send it by bKash Send Money to {bkash} with Reference {ref}. Thanks!',
  msg_renew_bn: 'হাই {name}, আপনার {product} {date} তারিখে শেষ হবে। ১ মাস রিনিউ করতে {bkash} নম্বরে বিকাশ সেন্ড মানি করে {price} পাঠান, রেফারেন্সে লিখুন {ref}। ধন্যবাদ!',
  msg_due_bn: 'হাই {name}, {product} এর {price} এখনও বাকি আছে। অনুগ্রহ করে {bkash} নম্বরে বিকাশ সেন্ড মানি করে পাঠান, রেফারেন্সে লিখুন {ref}। ধন্যবাদ!'
};

function makeState(overrides) {
  const products = raw.products.map(p => ({
    Product_ID: p[0], Product_Name: p[1], Category: p[2], Billing_Cycle_Days: p[3],
    Default_Price: p[4], Unit_Cost: p[5], Letter: p[6], Active: 'Yes'
  }));
  const accounts = raw.accounts.map(a => ({
    Account_ID: a[0], Product_ID: a[1], Account_Label: a[2], Cycle_Cost: a[3], Slots: a[4],
    Renewal_Date: a[5], Account_Status: 'Active', Cost_Per_Slot: a[3] / a[4]
  }));
  const costOf = id => accounts.find(a => a.Account_ID === id).Cost_Per_Slot;
  const sales = raw.sales.map(s => ({
    Sale_ID: s[0], Sale_Date: '', Customer: s[1], Contact: s[2], Product_ID: s[3], Account_ID: s[4],
    Code_ID: '', Qty: 1, Unit_Price: s[5], Amount_Paid: s[6], Paid_Till: serialToIso(s[7]),
    Record_Status: 'Active', Notes: '', Customer_ID: '', Months: 1, Sub_Code: '', Cost_Snapshot: costOf(s[4])
  }));
  const codes = raw.codes.map(c => ({ Code_ID: c[0], Product_ID: c[1], Code: c[2], Status: 'Available' }));
  const state = {
    today: '2026-10-18',
    settings: Object.assign({}, SETTINGS),
    products, accounts,
    wallets: [{ Wallet_ID: 'UNKNOWN', Label: 'Not recorded yet' }],
    customers: [], sales, payments: [],
    purchases: accounts.map((a, i) => ({ Purchase_ID: 'P-' + String(i + 1).padStart(4, '0'), Date: '2026-10-18',
      Account_ID: a.Account_ID, Paid_With: 'UNKNOWN', Amount: a.Cycle_Cost, Covers_Until: a.Renewal_Date, Notes: '' })),
    expenses: [], codes, inbox: [], remindersLog: []
  };
  return Object.assign(state, overrides || {});
}

/** makeState() with the one-time migration applied: Customers, Payments, Customer_ID/Months/Sub_Code on every sale. */
function makeMigratedState(overrides) {
  const { Core } = require('./load-core');
  const s = makeState();
  const mg = Core.migrate.planMigration(s);
  s.customers = mg.customers;
  const upd = new Map(mg.saleUpdates.map(u => [u.Sale_ID, u]));
  s.sales.forEach(x => { Object.assign(x, upd.get(x.Sale_ID)); delete x.Amount_Paid; });
  s.payments = mg.payments;
  return Object.assign(s, overrides || {});
}

/** Customer_ID of the (only) customer with this name in a migrated state. */
function cid(state, name) {
  const c = state.customers.find(x => x.Name === name);
  if (!c) throw new Error('No customer ' + name);
  return c.Customer_ID;
}

module.exports = { makeState, makeMigratedState, cid, serialToIso, SETTINGS };

// Table-scoped reads: an action that declares NEEDS_ reads only those tables. The risk is a view that silently needs a table
// it did not declare (the value is wrong, nothing errors), so every declared action is run twice over a rich seed, once with
// every table and once scoped, and the results must be identical. A second check records which state fields each action
// really touches and fails when one is missing from its declaration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { Core } = require('./load-core');
const Adapter = require('../src/adapters/postgres.js');
const { buildState, readPayload } = require('../tools/measure');
const { cid } = require('./fixtures');

const TODAY = '2026-10-18';

// Synthetic staged rows for the migration panel (no real names): two batches, every kind, every status the views branch on.
function addImportRows(m) {
  const nfx = m.accounts.find(a => a.Product_ID === 'NETFLIX');
  const row = (id, batch, kind, status, data, created) => ({ Row_ID: id, Batch: batch, Kind: kind, Sheet: 'S', Ref: id.split(':').pop(), Data: JSON.stringify(data),
    Status: status, Note: '', Applied: '', Created: created || '2026-10-17' });
  m.importRows = [
    row('b0:S:A1', 'b0', 'inbox', 'Skipped', { Transaction_ID: 'OLDIMP1', Amount: 10 }, '2026-10-01'),
    row('b1:S:A1', 'b1', 'account', 'Approved', { productHint: 'Netflix', label: 'Synthetic Acct', collected: 350, cost: 1000, renewalDate: '2026-11-20', slots: 4 }),
    row('b1:S:A2', 'b1', 'account', 'Approved', { productHint: 'Netflix', label: nfx.Account_Label, collected: 0, cost: 900, renewalDate: '2026-12-01', slots: nfx.Slots }),
    row('b1:S:L1', 'b1', 'line', 'Approved', { accountRef: 'b1:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20' }),
    row('b1:S:L2', 'b1', 'line', 'Review', { accountRef: 'b1:S:A1', name: 'Synthetic Other', status: 'Due', amount: '220-250', paidTill: '2026-11-20' }),
    row('b1:S:E1', 'b1', 'extra', 'Approved', { accountRef: 'b1:S:A1', amount: 50, label: 'Rent' }),
    row('b1:S:C1', 'b1', 'code', 'Approved', { productHint: 'HONE', code: 'SYNTH-CODE-1', family: 'HONE', redeemed: 'yes' }),
    row('b1:S:I1', 'b1', 'inbox', 'Approved', { Transaction_ID: 'IMPTRX1', Amount: 100, Method: 'bKash', Status: 'Pending' })
  ];
}

// ---- rich seed: the Task 1 volume seed plus a row or two in every table, covering each branch the views take ----
function richState() {
  const m = buildState();
  const maxSale = Math.max(...m.sales.map(s => Number(s.Sale_ID)));
  const kabir = cid(m, 'Kabir'), jamil = cid(m, 'jamilhq');
  m.settings.pay_base_url = 'https://pay.example';
  m.settings.host_seats = 'YOUTUBE';

  // Sales: dates, tokens, statuses, a default-priced line, a USDT-cost line.
  m.sales.forEach((s, i) => {
    s.Sale_Date = ['2026-08-05', '2026-09-10', '2026-10-02', '2026-10-15'][i % 4];
    if (i % 3 === 0) s.Pay_Token = 'PAYTOKEN' + String(1000000 + i);
  });
  m.sales[5].Record_Status = 'Void';
  m.sales[6].Record_Status = 'Refunded';
  m.sales[7].Record_Status = 'Ended';
  m.sales[8].Record_Status = 'Renewed';
  m.sales[10].Unit_Price = '';
  // USDT-cost lines: one this month on a marked-up supplier's product, one ended (the accounts screen prices ended lines).
  m.sales[22].Buy_Currency = 'USDT'; m.sales[22].Buy_Price_USDT = 4;
  m.sales[23].Buy_Currency = 'USDT'; m.sales[23].Buy_Price_USDT = 5; m.sales[23].Product_ID = 'NETFLIX'; m.sales[23].Account_ID = 'NFX-01';
  m.sales[26].Buy_Currency = 'USDT'; m.sales[26].Buy_Price_USDT = 5; m.sales[26].Product_ID = 'NETFLIX'; m.sales[26].Account_ID = 'NFX-02'; m.sales[26].Record_Status = 'Ended';

  // Accounts: one deleted (hidden everywhere), one banned, one retired with a note.
  const acc = id => m.accounts.find(a => a.Account_ID === id);
  acc('ICL-01').Account_Status = 'Deleted';
  acc('SPT-05').Account_Status = 'Banned';
  acc('CR-01').Account_Status = 'Inactive'; acc('CR-01').Notes = 'Retired 2026-10-01';

  // Products: a supplier with a markup, templates, an inactive product, a parent.
  const prod = id => m.products.find(p => p.Product_ID === id);
  prod('NETFLIX').Supplier_ID = 'SUP-01'; prod('NETFLIX').Template_Renew = 'Hi {name}, {product} ends {date} {link}';
  prod('SPOTIFY').Supplier_ID = 'SUP-02'; prod('SPOTIFY').Template_Due = 'Hi {name}, {balance} due';
  prod('CRUNCHYROLL').Active = 'No';
  prod('HELLCASE').Parent_ID = 'HONE'; prod('HONE').Default_Price = 300;
  m.suppliers = [
    { Supplier_ID: 'SUP-01', Name: 'Reseller', Contact: '0170', Currency: 'USDT', Markup_Percent: 10, Notes: 'n', Contact_Channel: 'WhatsApp' },
    { Supplier_ID: 'SUP-02', Name: 'Plain', Contact: '', Currency: 'BDT', Markup_Percent: 0, Notes: '', Contact_Channel: '' }
  ];
  m.liveRates = [{ ID: 'usdt_bdt', Rate: 121.5, Fetched_At: '2026-10-01T00:00:00Z' }];

  // Customers: creation dates (goal), a filler name.
  m.customers.forEach((c, i) => { if (i % 4 === 0) c.Created = '2026-10-0' + (1 + (i % 8)); });

  // Payments: dated, undated opening, Auto, Credit pair, unattached credit, a duplicate trx.
  m.payments.forEach((p, i) => {
    p.Date = i < 10 ? '' : ['2026-08-20', '2026-09-12', '2026-10-05', '2026-10-16', '2026-10-17'][i % 5];
    p.Method = ['bKash', 'Cash', '', 'Nagad'][i % 4];
    if (i % 7 === 0 && i >= 10) { p.Source = 'Auto'; p.Date = '2026-10-17'; p.Transaction_ID = 'AUTOTRX' + i; }
  });
  m.payments.push(
    { Payment_ID: 'PM-00901', Date: '2026-10-10', Customer_ID: kabir, Sale_ID: '', Amount: 150, Method: 'bKash', Transaction_ID: '', Source: 'App', Note: 'credit' },
    { Payment_ID: 'PM-00902', Date: '2026-10-11', Customer_ID: kabir, Sale_ID: '', Amount: -50, Method: '', Transaction_ID: '', Source: 'Credit', Note: 'Credit used' },
    { Payment_ID: 'PM-00903', Date: '2026-10-11', Customer_ID: kabir, Sale_ID: m.sales.find(s => s.Customer_ID === kabir).Sale_ID, Amount: 50, Method: '', Transaction_ID: '', Source: 'Credit', Note: 'Credit used' },
    { Payment_ID: 'PM-00904', Date: '2026-10-12', Customer_ID: jamil, Sale_ID: '', Amount: 30, Method: 'Cash', Transaction_ID: 'DUPTRX', Source: 'App', Note: '' });

  // Expenses and purchases.
  m.expenses = [
    { Expense_ID: 'EX-0001', Date: '2026-10-03', Category: 'Software', Amount: 500, Paid_With: 'UNKNOWN', Note: 'tool' },
    { Expense_ID: 'EX-0002', Date: '2026-09-20', Category: 'Ads', Amount: 300, Paid_With: 'UNKNOWN', Note: '' },
    { Expense_ID: 'EX-0003', Date: '', Category: 'Other', Amount: 40, Paid_With: '', Note: 'opening' }];
  m.purchases.push(
    { Purchase_ID: 'P-0099', Date: '2026-09-02', Account_ID: 'EXL-01', Paid_With: 'UNKNOWN', Amount: 100, Covers_Until: '2026-12-14', Notes: '' },
    { Purchase_ID: 'P-0100', Date: '2026-10-01', Account_ID: 'EXL-02', Paid_With: 'UNKNOWN', Amount: 77, Covers_Until: '', Notes: 'Opening balance 2026' });
  m.wallets.push({ Wallet_ID: 'BKASH', Label: 'bKash wallet' });

  // Codes: batches, sold and reserved codes, plus a sale of a code.
  m.codes.forEach((c, i) => { if (i < 6) { c.Batch_ID = 'B-1'; c['Source / Batch'] = 'batchA'; } });
  m.codes[1].Status = 'Sold'; m.codes[2].Status = 'Reserved'; m.codes[3].Status = 'Reserved';
  m.sales.push({ Sale_ID: maxSale + 1, Sale_Date: '2026-10-14', Customer: 'Kabir', Contact: '', Product_ID: 'HONE', Account_ID: '', Code_ID: m.codes[1].Code_ID,
    Qty: 1, Unit_Price: 300, Paid_Till: '', Record_Status: 'Active', Notes: '', Customer_ID: kabir, Months: 1, Sub_Code: 'G900', Cost_Snapshot: 100 });
  m.payments.push({ Payment_ID: 'PM-00905', Date: '2026-10-14', Customer_ID: kabir, Sale_ID: maxSale + 1, Amount: 300, Method: 'bKash', Transaction_ID: '', Source: 'App', Note: '' });

  // Goals and budgets (one per metric / source).
  m.goals = ['revenue', 'profit', 'collected', 'new_customers'].map((metric, i) => ({ Goal_ID: 'G' + (i + 1), Title: metric, Metric: metric,
    Target: 20000, Start: '2026-10-01', End: '2026-10-31', Note: '', Status: 'Active' }));
  m.budgets = [{ Budget_ID: 'B1', Category: 'Software', Monthly_Limit: 400, Alert_Pct: 80, Active: 'Yes' },
               { Budget_ID: 'B2', Category: 'Account purchases', Monthly_Limit: 3000, Alert_Pct: '', Active: 'Yes' }];

  // Pay requests (open seat, open code, expired code, paid, cancelled, name only), deliveries, intents.
  const exp = (d) => d + 'T00:00:00.000Z';
  const rq = (id, o) => Object.assign({ Request_ID: id, Token: 'RQTOKEN' + id + 'x'.repeat(20), Title: 'Req ' + id, Amount: 290, Customer_ID: '', Customer_Name: '',
    Product_ID: '', Code_ID: '', Note: '', Status: 'Open', Created: exp('2026-10-17'), Expires: exp('2099-01-01'), Sale_ID: '' }, o);
  m.payRequests = [
    rq('R1', { Product_ID: 'NETFLIX', Customer_ID: kabir, Amount: 290 }),
    rq('R2', { Product_ID: 'HONE', Code_ID: m.codes[2].Code_ID, Amount: 300, Customer_Name: 'Walk In' }),
    rq('R3', { Product_ID: 'HONE', Code_ID: m.codes[3].Code_ID, Amount: 300, Expires: exp('2020-01-01') }),
    rq('R4', { Product_ID: 'HONE', Code_ID: m.codes[1].Code_ID, Amount: 300, Customer_ID: kabir, Status: 'Paid', Sale_ID: maxSale + 1 }),
    rq('R5', { Status: 'Cancelled' }),
    rq('R6', { Amount: 100, Customer_Name: 'Name Only' })];
  m.deliveries = [
    { Delivery_ID: 'D1', Sale_ID: maxSale + 1, Request_ID: 'R4', Customer_ID: kabir, Product_ID: 'HONE', Code_ID: m.codes[1].Code_ID, Kind: 'code', Status: 'Delivered', Delivered_At: exp('2026-10-14'), Note: '' },
    { Delivery_ID: 'D2', Sale_ID: '', Request_ID: 'R1', Customer_ID: kabir, Product_ID: 'NETFLIX', Code_ID: '', Kind: 'seat', Status: 'Pending', Delivered_At: '', Note: 'wait' }];
  const tokLine = m.sales.find(s => s.Pay_Token);
  m.payIntents = [
    { Token: tokLine.Pay_Token, Method: 'bkash', Payer_Number: '01711111111', Claim_Trx: 'CLAIM1', Claimed: 'Yes', Created: '2026-10-01 00:00', Updated: '2026-10-17 10:00' },
    { Token: m.payRequests[0].Token, Method: 'bkash', Payer_Number: '01722222222', Claim_Trx: '', Claimed: '', Created: '2026-10-01 00:00', Updated: '2026-10-17 10:00' }];
  m.remindersLog = [
    { Date: '2026-10-16', Sale_ID: m.sales[1].Sale_ID, Customer_ID: m.sales[1].Customer_ID, Kind: 'before', Channel: 'WhatsApp', Status: 'sent' },
    { Date: '2026-10-10', Sale_ID: m.sales[2].Sale_ID, Customer_ID: m.sales[2].Customer_ID, Kind: 'due', Channel: 'WhatsApp', Status: 'sent' }];
  m.profitSnapshots = [{ Month: '2026-09', Revenue_BDT: 1000, Cost_BDT: 500, Profit_BDT: 500 }];
  // Change log: a sale, a payment edit and its undo, and an automatic match, so the Activity read is compared over real batches.
  m.changeLog = [
    { id: 1, time: '2026-10-14T05:00:00Z', batch_id: 'BATCH-A', action: 'newSale', tab: 'Sales_Log', row_key: String(maxSale + 1), field: '(new row)', old: '', new: '' },
    { id: 2, time: '2026-10-14T05:00:00Z', batch_id: 'BATCH-A', action: 'newSale', tab: 'Payments', row_key: 'PM-00905', field: '(new row)', old: '', new: '' },
    { id: 3, time: '2026-10-15T08:00:00Z', batch_id: 'BATCH-B', action: 'editPayment', tab: 'Payments', row_key: 'PM-00904', field: 'Amount', old: '30', new: '29' },
    { id: 4, time: '2026-10-16T09:00:00Z', batch_id: 'BATCH-C', action: 'undo:BATCH-B', tab: 'Payments', row_key: 'PM-00904', field: 'Amount', old: '29', new: '30' },
    { id: 5, time: '2026-10-16T10:00:00Z', batch_id: 'BATCH-D', action: 'autoMatch', tab: 'Payment_Inbox', row_key: 'AUTOTRXA', field: 'Status', old: 'Pending', new: 'Matched' }
  ];

  // Inbox: the paths whyNotAuto / suggest walk (auto line, pay request, code request, Upay, duplicate, review, over the cap, unknown ref, payer number).
  const ib = (i, o) => Object.assign(m.inbox[i], { Status: 'Pending', Type: 'Received', Sender: '16247', Counterparty: '' }, o);
  ib(1, { Reference: m.sales[0].Sub_Code, Amount: 800, Transaction_ID: 'AUTOTRXA' });
  ib(2, { Reference: 'R1', Amount: 290, Transaction_ID: 'AUTOTRXB' });
  ib(3, { Reference: 'R2', Amount: 300, Transaction_ID: 'AUTOTRXC' });
  ib(4, { Sender: '16268', Reference: m.sales[0].Sub_Code, Amount: 800, Transaction_ID: 'AUTOTRXD' });
  ib(5, { Transaction_ID: 'DUPTRX', Amount: 30 });
  ib(6, { Type: 'Unrecognised', Status: 'Review', Amount: 50, Transaction_ID: 'AUTOTRXE' });
  ib(7, { Reference: m.sales[0].Sub_Code, Amount: 99999, Transaction_ID: 'AUTOTRXF' });
  ib(8, { Reference: 'ZZ9', Amount: 20, Transaction_ID: 'AUTOTRXG' });
  ib(9, { Sender: '+8801711111111', Counterparty: '01711111111', Reference: tokLine.Sub_Code, Amount: 5000, Transaction_ID: 'AUTOTRXH', Received: '2026-10-17 10:00' });
  ib(10, { Reference: 'R3', Amount: 300, Transaction_ID: 'AUTOTRXI' });
  ib(11, { Counterparty: '01756999991', Amount: 20, Transaction_ID: 'AUTOTRXJ' });
  addImportRows(m);
  // Orders: one waiting for its pay link (R1, open), one fulfilled into the new sale (its link R4 is Paid), so the order list shows both shapes.
  m.orders = [
    { Order_ID: 'O-00001', Created: '2026-10-17T10:00:00.000Z', Source: 'panel', Status: 'AwaitingPayment', Customer_ID: kabir, Customer_Name: 'Kabir',
      Contact: '', Contact_Channel: '', Product_ID: 'NETFLIX', Months: 1, Unit_Price: 290, Total: 290, Pay_Request_ID: 'R1', Sale_ID: '', Note: '' },
    { Order_ID: 'O-00002', Created: '2026-10-14T09:00:00.000Z', Source: 'website', Status: 'Fulfilled', Customer_ID: kabir, Customer_Name: 'Kabir',
      Contact: '01711111111', Contact_Channel: 'WhatsApp', Product_ID: 'HONE', Months: 1, Unit_Price: 300, Total: 300, Pay_Request_ID: 'R4',
      Sale_ID: maxSale + 1, Note: '', Fulfilled: '2026-10-14T10:00:00.000Z' }];
  return m;
}

async function freshEdge() {
  const { db, tables } = makeFakeDb();
  const m = richState();
  await seedDb(db, tables, m);
  return { db, m, edge: loadEdge(db, { today: TODAY }) };
}

// ---- hooks on the shared Adapter / Core singletons (restored by every helper) ----
/** Run fn with Adapter.readState ignoring its tables argument: the reference result. */
async function withFullReads(fn) {
  const orig = Adapter.readState;
  Adapter.readState = (db, today) => orig(db, today);
  try { return await fn(); } finally { Adapter.readState = orig; }
}

/** Run fn with Adapter.readState returning a proxy that records the state fields read. Accesses made while Core.ids.IdGen
 *  counts existing ids are ignored (their counters only feed the ids on ops). A field copy (Object.assign) is not a read. */
async function recordReads(fn) {
  const origRead = Adapter.readState, origGen = Core.ids.IdGen;
  const seen = {}, args = [];
  let genDepth = 0;
  Core.ids.IdGen = function () { genDepth++; try { return origGen.apply(this, arguments); } finally { genDepth--; } };
  Adapter.readState = async (db, today, tables) => {
    args.push(tables);
    const st = await origRead(db, today, tables);
    let lastCopy = null;
    return new Proxy(st, {
      getOwnPropertyDescriptor(t, k) { lastCopy = k; return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k, r) {
        if (typeof k === 'string' && lastCopy === k) { lastCopy = null; return t[k]; }
        if (typeof k === 'string' && !genDepth) seen[k] = true;
        return t[k];
      }
    });
  };
  try { await fn(); } finally { Adapter.readState = origRead; Core.ids.IdGen = origGen; }
  return { fields: Object.keys(seen), args };
}

/** Run fn while capturing the ops handed to Adapter.applyOps. */
async function captureOps(fn) {
  const orig = Adapter.applyOps, got = [];
  Adapter.applyOps = (db, ops, meta) => { got.push({ ops, action: meta && meta.action }); return orig(db, ops, meta); };
  try { await fn(); } finally { Adapter.applyOps = orig; }
  return got;
}

// Generated secrets differ between runs; everything else must match exactly.
// batchId is a fresh UUID per write: masked, so the two runs compare on whether there is one, not its value.
function norm(x) {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === 'Pay_Token' || k === 'Token' || k === 'token' || k === 'url') && typeof v === 'string' ? '<secret>' : k === 'batchId' && typeof v === 'string' ? '<batch>' : v));
}

function stateField(tab) { return Adapter.TABS[tab].state; }

// ---- payloads per action (default: the measured payload) ----
function readCases(name, m) {
  const sale = m.sales.find(s => s.Customer_ID === cid(m, 'jamilhq'));
  const dueSale = m.sales[2];
  return ({
    moneyOverview: [{}, { month: '2026-09' }],
    insights: [{}, { from: '2026-09-01', to: '2026-10-31' }],
    moneyExport: [{ tab: 'overview' }, { tab: 'book', month: '2026-10' }, { tab: 'cash' }],
    customer: [{ id: cid(m, 'jamilhq') }, { id: cid(m, 'Kabir') }, { id: m.sales[2].Customer_ID }],
    reminderMessage: [{ saleId: sale.Sale_ID }, { saleId: dueSale.Sale_ID, kind: 'due' }, { saleId: m.sales[1].Sale_ID, kind: 'before', lang: 'bn' }],
    book: [{}, { month: '2026-09' }],
    entry: [{ kind: 'payment', id: 'PM-00904' }, { kind: 'payment', id: m.payments[0].Payment_ID }, { kind: 'expense', id: 'EX-0001' }, { kind: 'purchase', id: 'P-0099' }],
    product: [{ productId: 'EXITLAG' }, { productId: 'NETFLIX' }],
    deliveries: [{}, { status: 'Pending' }],
    orders: [{}],
    importReview: [{}, { batch: 'b1' }, { batch: 'b0' }],
    profitMonthly: [{}, { from: '2026-08', to: '2026-10' }],
    suggestCustomers: [{ trx: 'TESTTRX1' }, { trx: 'AUTOTRXA', query: 'kab' }, { trx: 'AUTOTRXJ' }],
    inbox: [{}, { status: 'Pending' }, { status: 'Auto-matched', days: 365 }, { q: 'AUTOTRX', status: 'Matched' }, { q: '01756' }],
    reminderLog: [{}, { status: 'sent' }, { status: 'skipped', days: 30 }, { status: 'all', days: 60 }],
    activity: [{}, { limit: 3 }, { limit: 100 }]
  })[name] || [readPayload(name, m)];
}

const READ_ACTIONS = ['moneyOverview', 'moneyExport', 'init', 'home', 'lookups', 'customer', 'reminderMessage', 'dues', 'accounts', 'payLinks',
  'payRequests', 'deliveries', 'book', 'entry', 'product', 'profit', 'suggestCustomers', 'importReview', 'profitMonthly', 'orders', 'insights', 'inbox', 'reminderLog', 'activity'];
// Reads that touch no state table (activity reads Change_Log only) declare an empty list: readState then loads Settings alone.
const NO_STATE_READS = ['activity'];

test('every read action declares its tables (NEEDS_ names real tabs, never lists Settings twice)', async () => {
  const { edge } = await freshEdge();
  for (const a of READ_ACTIONS) {
    assert.ok(Array.isArray(edge.needs[a]), a + ' has no NEEDS_ entry');
    if (NO_STATE_READS.indexOf(a) >= 0) { assert.deepEqual(edge.needs[a], [], a + ' reads no state table'); continue; }
    assert.ok(edge.needs[a].length > 0, a + ' has no NEEDS_ entry');
    edge.needs[a].forEach(t => assert.ok(Adapter.TABS[t] && Adapter.TABS[t].state, a + ' lists unknown tab ' + t));
    assert.equal(new Set(edge.needs[a]).size, edge.needs[a].length, a + ' lists a tab twice');
  }
  Object.keys(edge.needs).forEach(a => edge.needs[a].forEach(t => assert.ok(Adapter.TABS[t] && Adapter.TABS[t].state, a + ' lists unknown tab ' + t)));
});

test('scoped state gives identical results for every declared read action', async () => {
  for (const name of READ_ACTIONS) {
    const probe = await freshEdge();
    const cases = readCases(name, probe.m);
    for (const payload of cases) {
      const a = await freshEdge(), b = await freshEdge();
      const scoped = await a.edge.api(name, payload);
      const full = await withFullReads(() => b.edge.api(name, payload));
      assert.equal(full.ok, true, name + ' ' + JSON.stringify(payload) + ' failed over the rich seed: ' + full.error);
      assert.deepStrictEqual(norm(scoped), norm(full), name + ' ' + JSON.stringify(payload) + ': scoped read differs from the full read');
    }
  }
});

test('the rich seed exercises the branches (results are not vacuously equal)', async () => {
  const { edge } = await freshEdge();
  const home = (await edge.api('home', {})).data;
  assert.ok(home.renewSoon.length && home.expired.length && home.unmatched.length && home.autoToCheck.length && home.reminders.length, 'home sections are empty');
  assert.ok(home.unmatched.some(u => /pay link|R1|R2/i.test(u.why) || u.why === '' || u.why), 'no why-not-auto text');
  const init = (await edge.api('init', {})).data.lookups;
  assert.ok(init.suppliers.length && init.batches.length && init.codes.length && init.wallets.length && init.pendingDeliveries > 0 && init.rate.source === 'bybit');
  const money = (await edge.api('moneyOverview', {})).data;
  assert.ok(money.goals.length === 4 && money.budgets.length === 2 && money.cash.length && money.expensesByType.length && money.customers.length && money.forecast.length);
  assert.ok((await edge.api('dues', {})).data.rows.length && (await edge.api('dues', {})).data.credits.length);
  assert.ok((await edge.api('payLinks', {})).data.rows.some(r => r.stage !== 'none'));
  const rqs = (await edge.api('payRequests', {})).data.rows;
  assert.ok(rqs.length === 6 && rqs.some(r => r.stage === 'expired') && rqs.some(r => r.deliveryId));
  assert.ok((await edge.api('deliveries', {})).data.rows.length === 2);
  assert.ok((await edge.api('accounts', {})).data.endedLines.length);
  assert.ok((await edge.api('profit', {})).data.families.length);
});

test('every table a declared read actually touches is in its declaration', async () => {
  const { edge, m } = await freshEdge();
  const inverse = {};
  Object.keys(Adapter.TABS).forEach(t => { if (Adapter.TABS[t].state) inverse[Adapter.TABS[t].state] = t; });
  for (const name of READ_ACTIONS) {
    for (const payload of readCases(name, m)) {
      const f = await freshEdge();
      const rec = await recordReads(() => withFullReads(() => f.edge.api(name, payload)));
      const touched = rec.fields.filter(k => inverse[k]).map(k => inverse[k]);
      const missing = touched.filter(t => edge.needs[name].indexOf(t) < 0);
      assert.deepEqual(missing, [], name + ' ' + JSON.stringify(payload) + ' reads ' + missing.join(', ') + ' but does not declare it');
    }
  }
});

test('an action without a declaration still reads every table', async () => {
  const { edge, db } = await freshEdge();
  assert.equal(edge.needs.saveGoal, undefined);
  const rec = await recordReads(() => edge.api('saveGoal', { title: 'x', metric: 'revenue', target: 1000, start: '2026-10-01', end: '2026-10-31' }));
  assert.deepEqual(rec.args, [undefined], 'an undeclared write must call readState without a table list');
  const st = await Adapter.readState(db, TODAY);
  for (const t of Object.keys(Adapter.TABS)) if (Adapter.TABS[t].state) assert.ok(Array.isArray(st[Adapter.TABS[t].state]), t + ' missing from a full read');
});

test('readState(db, today, tables) loads only the named tabs plus Settings', async () => {
  const { db } = await freshEdge();
  db.resetStats();
  const st = await Adapter.readState(db, TODAY, ['Customers', 'Payments']);
  assert.equal(db.stats.statements, 3, 'Settings + 2 tables');
  assert.ok(st.customers.length > 0 && st.payments.length > 0);
  assert.equal(st.sales, undefined);
  assert.equal(st.inbox, undefined);
  assert.equal(st.today, TODAY);
  assert.equal(st.settings.grace_days, 3);
  const withAccounts = await Adapter.readState(db, TODAY, ['Accounts']);
  assert.ok(withAccounts.accounts.every(a => a.Account_Status), 'Account_Status default still applied');
  assert.ok(withAccounts.accounts.some(a => a.Cost_Per_Slot > 0), 'Cost_Per_Slot still derived');
  await assert.rejects(() => Adapter.readState(db, TODAY, ['Nope']), /Unknown tab Nope/);
  await assert.rejects(() => Adapter.readState(db, TODAY, ['Settings']), /Unknown tab Settings|no state/i);
  assert.deepEqual(Object.keys(await Adapter.readState(db, TODAY, [])).sort(), ['settings', 'today']);
});

test('scoped reads cut statements and rows for the hot actions', async () => {
  for (const name of ['home', 'dues', 'customer', 'book', 'profit', 'payLinks']) {
    const a = await freshEdge(), b = await freshEdge();
    const payload = readCases(name, a.m)[0];
    a.db.resetStats(); await a.edge.api(name, payload);
    b.db.resetStats(); await withFullReads(() => b.edge.api(name, payload));
    assert.ok(a.db.stats.statements < b.db.stats.statements, name + ' statements ' + a.db.stats.statements + ' vs ' + b.db.stats.statements);
    assert.ok(a.db.stats.rows < b.db.stats.rows, name + ' rows ' + a.db.stats.rows + ' vs ' + b.db.stats.rows);
  }
});

// ---- writes: the declared ones must plan the same ops and give the same answer ----
const WRITE_CASES = {
  pay: m => [{ customerId: cid(m, 'Kabir'), amount: 300, method: 'bKash' }, { customerId: cid(m, 'jamilhq'), amount: 40, method: 'Cash', trxId: 'NEWTRX1' },
    { customerId: cid(m, 'Kabir'), amount: 100, method: 'bKash', trxId: 'DUPTRX' }],
  newSale: m => [{ productId: 'NETFLIX', accountId: 'NFX-03', customerId: cid(m, 'Kabir'), paidNow: { amount: 290, method: 'bKash' } },
    { productId: 'EXITLAG', accountId: 'EXL-01', newCustomer: { name: 'Brand New' } },
    { productId: 'HONE', codeId: 'C-0001', customerId: cid(m, 'Kabir') }],
  importStage: m => [{ batch: 'b2', rows: [{ id: 'b2:S:A1', kind: 'code', sheet: 'S', ref: 'A1', data: { productHint: 'hone', code: 'ZZ-1' } },
    { id: 'b1:S:A1', kind: 'code', sheet: 'S', ref: 'A1', data: { productHint: 'hone', code: 'DUP' } }] }],
  importEdit: m => [{ rowId: 'b1:S:L2', data: { amount: 250 }, note: 'checked' }, { rowId: 'b1:S:L1', match: { customerId: cid(m, 'Kabir') } }],
  importAdd: m => [{ batch: 'b1', kind: 'extra', data: { accountRef: 'b1:S:A1', amount: 40 } }],
  importDelete: m => [{ rowId: 'b1:S:L2' }],
  importStatus: m => [{ rowIds: ['b1:S:L2', 'b1:S:A2'], status: 'Approved' }, { rowIds: ['b1:S:A1'], status: 'Skipped' }],
  importApply: m => [{ batch: 'b1' }, { batch: 'b1', rowIds: ['b1:S:A1', 'b1:S:L1'] }],
  renew: m => [{ subCode: 'N44', months: 1 }, { subCode: m.sales[0].Sub_Code, months: 2, paidNow: { amount: 100, method: 'bKash' } }, { subCode: 'NOPE1' }]
};

test('declared writes plan the same ops and answer the same from scoped state', async () => {
  const names = Object.keys(WRITE_CASES);
  const { edge } = await freshEdge();
  names.forEach(n => assert.ok(Array.isArray(edge.needs[n]), n + ' has no NEEDS_ entry'));
  for (const name of names) {
    const probe = await freshEdge();
    for (const payload of WRITE_CASES[name](probe.m)) {
      const a = await freshEdge(), b = await freshEdge();
      let scoped, full;
      const opsA = await captureOps(async () => { scoped = await a.edge.api(name, Object.assign({ requestId: 'r-' + name }, payload)); });
      const opsB = await captureOps(async () => { full = await withFullReads(() => b.edge.api(name, Object.assign({ requestId: 'r-' + name }, payload))); });
      assert.deepStrictEqual(norm(scoped), norm(full), name + ' ' + JSON.stringify(payload) + ': response differs');
      assert.deepStrictEqual(norm(opsA), norm(opsB), name + ' ' + JSON.stringify(payload) + ': ops differ');
    }
  }
  // at least one case of each wrote something
  for (const name of names) {
    const f = await freshEdge();
    const got = await captureOps(() => f.edge.api(name, Object.assign({ requestId: 'w-' + name }, WRITE_CASES[name](f.m)[0])));
    assert.ok(got.length && got[0].ops.length, name + ' planned no ops');
  }
});

test('every table a declared write touches is in its declaration', async () => {
  const { edge } = await freshEdge();
  const inverse = {};
  Object.keys(Adapter.TABS).forEach(t => { if (Adapter.TABS[t].state) inverse[Adapter.TABS[t].state] = t; });
  for (const name of Object.keys(WRITE_CASES)) {
    const probe = await freshEdge();
    for (const payload of WRITE_CASES[name](probe.m)) {
      const f = await freshEdge();
      const rec = await recordReads(() => withFullReads(() => f.edge.api(name, Object.assign({ requestId: 'x-' + name }, payload))));
      const missing = rec.fields.filter(k => inverse[k]).map(k => inverse[k]).filter(t => edge.needs[name].indexOf(t) < 0);
      assert.deepEqual(missing, [], name + ' ' + JSON.stringify(payload) + ' reads ' + missing.join(', ') + ' but does not declare it');
    }
  }
});

test('the rich seed gives the migration views something to show', async () => {
  const { edge } = await freshEdge();
  const rev = (await edge.api('importReview', {})).data;
  assert.equal(rev.batch, 'b1', 'a blank batch means the newest');
  assert.deepEqual(rev.batches, [{ batch: 'b0', rows: 1, applied: 0 }, { batch: 'b1', rows: 7, applied: 0 }]);
  assert.ok(rev.accounts.length === 2 && rev.accounts[0].lines.length === 2 && rev.accounts[0].extras.length === 1 && rev.codes.length === 1 && rev.inbox.length === 1);
  const mon = (await edge.api('profitMonthly', {})).data;
  assert.ok(mon.months.length === 6 && mon.months.some(x => x.revenue > 0));
});

// ---- server (Edge Function) -------------------------------------------------
// Runs inside the bundled index.ts after the core modules and the Postgres adapter.
// `db` is { query(text, params) -> {rows}, transaction(fn) } (see the header in the built file).
var APP_TZ = 'Asia/Dhaka';

function today_() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
function batchId_() { return crypto.randomUUID(); }

// Every write path takes this Postgres advisory lock inside its transaction, so writes run one at a time.
var WRITE_LOCK_ = 41001;
// actor (who made the call, see authenticate_) is set on the transaction, so change_log lines written through it name the caller.
async function locked_(db, fn, actor) {
  return db.transaction(async function (tx) {
    tx.actor = actor || '';
    await tx.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_]);
    return fn(tx);
  });
}

// changed: true only when applyOps wrote a change_log batch, so the panel offers Undo only for a save Undo can reverse.
// batchId: that batch, the handle Undo takes (undo with batchId). Only a logged write has one. It is set here, after the plan's
// result, so a result key must never be named batchId (inventory batches use codeBatch).
async function commit_(db, plan, action, data, opts) {
  if (plan.errors && plan.errors.length) return { ok: false, error: plan.errors[0] };
  var logged = false, batch = batchId_();
  if (plan.ops && plan.ops.length) {
    var w = await Adapter.applyOps(db, plan.ops, { batchId: batch, action: action, log: !(opts && opts.log === false) });
    logged = !!(w && w.logged);
  }
  var out = Object.assign({}, data || plan.result || {}, { changed: logged });
  if (logged) out.batchId = batch; else delete out.batchId;
  return { ok: true, data: out };
}
var STALE_UNDO_ = 'Something else changed since. Open the history to undo it.';

// Payload of a pay-request action: a typed amount arrives as text. (api() already strips the client's clock and id generator.)
function clean_(p) {
  var o = Object.assign({}, p);
  if (typeof o.amount === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(o.amount)) o.amount = Number(o.amount);
  return o;
}

// Open pay requests past their expiry become Expired and give their reserved code back. Computed on use, no scheduled job.
// Logged as autoExpire so Undo skips it. Returns the state to continue with (re-read when something changed).
async function sweepExpired_(tx, st) {
  var ops = Core.paylinks.planExpireRequests(st);
  if (!ops.length) return st;
  await Adapter.applyOps(tx, ops, { batchId: batchId_(), action: 'autoExpire', log: true });
  return Adapter.readState(tx, today_());
}
// Same sweep for a read: takes the write lock only when there is something to expire.
async function sweepForRead_(db, st) {
  if (!Core.paylinks.planExpireRequests(st).length) return st;
  return locked_(db, async function (tx) {
    return sweepExpired_(tx, await Adapter.readState(tx, today_()));
  });
}

// Stage a request shows. Paid, Cancelled and Expired come from its status (a no-product Paid request has no payment rows).
function requestStage_(rq, status, nowMs) {
  if (rq.Status === 'Paid') return 'confirmed';
  if (rq.Status === 'Cancelled') return 'cancelled';
  if (rq.Status === 'Expired') return 'expired';
  var exp = Date.parse(rq.Expires || '');
  if (rq.Status === 'Open' && isFinite(exp) && exp <= nowMs) return 'expired';
  return status.stage;
}

// Unofficial Bybit P2P ad list (USDT sold for BDT). Reachability from Supabase is unconfirmed; the manual rate is the fallback.
var BYBIT_P2P_URL = 'https://api2.bybit.com/fiat/otc/item/online';
async function fetchAds_() {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 5000);
  try {
    var res = await fetch(BYBIT_P2P_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ tokenId: 'USDT', currencyId: 'BDT', side: '1', size: '10', page: '1', amount: '' }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data || data.ret_code !== 0 || !data.result || !Array.isArray(data.result.items)) throw new Error('unexpected response');
    return data.result.items;
  } finally { clearTimeout(timer); }
}

// ---- money dashboard ----
// Planner internals (clock, id generator) must never come from the client.
function monthOf_(st, p) {
  var m = p && p.month !== undefined && p.month !== null && p.month !== '' ? p.month : st.today.slice(0, 7);
  var ok = typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (!ok) throw new Error('Month must look like 2026-10.');
  return m;
}
// A real calendar date, 'YYYY-MM-DD' (rejects 2026-02-31). Range for insights: both ends, from <= to, at most 24 months (731 days).
function dateOf_(v, what) {
  var ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Core.util.isoAddDays(v, 0) === v;
  if (!ok) throw new Error(what + ' must be a date like 2026-10-18.');
  return v;
}
function rangeOf_(st, p) {
  var has = function (k) { return p && p[k] !== undefined && p[k] !== null && p[k] !== ''; };
  if (!has('from') && !has('to')) return {};
  var to = has('to') ? dateOf_(p.to, 'To') : st.today;
  var from = has('from') ? dateOf_(p.from, 'From') : Core.util.addMonths(to, -12);
  if (from > to) throw new Error('From must not be after To.');
  if (Core.util.daysBetween(from, to) > 731) throw new Error('Pick a range of 24 months or less.');
  return { from: from, to: to };
}
// inbox payload: status ('all' by default), q (at most 80 characters) and days (1 to 365, default 90). Validated here; the window and the
// row limit are Core.views.inboxRows'.
var INBOX_STATUS_ = ['all', 'Pending', 'Review', 'Matched', 'Auto-matched', 'Ignored'];
function inboxOf_(st, p) {
  var has = function (k) { return p && p[k] !== undefined && p[k] !== null && p[k] !== ''; };
  var status = has('status') ? String(p.status) : 'all';
  if (INBOX_STATUS_.indexOf(status) < 0) throw new Error('Status must be all, Pending, Review, Matched, Auto-matched or Ignored.');
  var q = has('q') ? String(p.q).trim() : '';
  if (q.length > 80) throw new Error('Search must be 80 characters or fewer.');
  var days = 90;
  if (has('days')) {
    days = Number(p.days);
    if (!(Number.isInteger(days) && days >= 1 && days <= 365)) throw new Error('Days must be a whole number from 1 to 365.');
  }
  return Core.views.inboxRows(st, { status: status, q: q, days: days });
}
// reminderLog payload: status ('all' by default, or sent or skipped) and days (1 to 60, default 60). The window and the row limit are
// Core.views.reminderLog's.
var REMINDER_LOG_STATUS_ = ['all', 'sent', 'skipped'];
function reminderLogOf_(st, p) {
  var has = function (k) { return p && p[k] !== undefined && p[k] !== null && p[k] !== ''; };
  var status = has('status') ? String(p.status) : 'all';
  if (REMINDER_LOG_STATUS_.indexOf(status) < 0) throw new Error('Status must be all, sent or skipped.');
  var days = 60;
  if (has('days')) {
    days = Number(p.days);
    if (!(Number.isInteger(days) && days >= 1 && days <= 60)) throw new Error('Days must be a whole number from 1 to 60.');
  }
  return Core.views.reminderLog(st, { status: status, days: days });
}
// activity payload: limit (1 to 100 batches, default 100). The read takes the newest ACTIVITY_LINES_ change lines (Adapter.readRecentChangeLog);
// the batches are grouped and summarised by Core.views.activityBatches.
var ACTIVITY_LINES_ = 1500;
function activityLimit_(p) {
  var has = function (k) { return p && p[k] !== undefined && p[k] !== null && p[k] !== ''; };
  if (!has('limit')) return 100;
  var limit = Number(p.limit);
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new Error('Limit must be a whole number from 1 to 100.');
  return limit;
}
function layoutOf_(st) {
  var known = {};
  Core.money.WIDGETS.forEach(function (w) { known[w.id] = true; });
  var out = [];
  String((st.settings && st.settings.money_layout) || '').split(',').forEach(function (x) {
    x = x.trim();
    if (known[x] === true && out.indexOf(x) < 0) out.push(x);
  });
  return out.length ? out : Core.money.DEFAULT_LAYOUT.slice();
}
function moneyExport_(st, p) {
  var tab = p && p.tab, month = monthOf_(st, p), csv;
  if (tab === 'overview') {
    var o = Core.money.overview(st, month), rows = [];
    rows.push({ Section: 'Summary', Item: 'Net', Value: o.net });
    rows.push({ Section: 'Summary', Item: 'Previous month net', Value: o.prevNet });
    rows.push({ Section: 'Summary', Item: 'In', Value: o.in });
    rows.push({ Section: 'Summary', Item: 'Out', Value: o.out });
    o.series.forEach(function (x) { rows.push({ Section: 'Trend ' + x.month, Item: 'Net', Value: x.net }); });
    o.expensesByType.forEach(function (x) { rows.push({ Section: 'Expenses', Item: x.category, Value: x.amount }); });
    o.products.forEach(function (x) { rows.push({ Section: 'Profit by product', Item: x.name, Value: x.profit }); });
    o.accounts.forEach(function (x) { rows.push({ Section: 'Profit by account', Item: x.label, Value: x.profit }); });
    o.dues.buckets.forEach(function (x) { rows.push({ Section: 'Dues', Item: x.label + ' days late', Value: x.amount }); });
    csv = Core.exporter.toCsv(Core.exporter.safeRows(rows), ['Section', 'Item', 'Value']);
  } else if (tab === 'book') {
    var b = Core.views.bookData(st, month);
    csv = Core.exporter.toCsv(Core.exporter.safeRows(b.entries.map(function (e) {
      return { Date: e.date, Type: e.kind === 'in' ? 'In' : 'Out', Description: e.label, Method: e.method, Amount: e.amount, Balance: e.balance, Ref: e.id };
    })), ['Date', 'Type', 'Description', 'Method', 'Amount', 'Balance', 'Ref']);
  } else if (tab === 'cash') {
    csv = Core.exporter.toCsv(Core.exporter.safeRows(Core.money.overview(st, month).cash.map(function (c) {
      return { Method: c.method, In: c.in, Out: c.out, Balance: c.balance };
    })), ['Method', 'In', 'Out', 'Balance']);
  } else {
    throw new Error('Export tab must be overview, book or cash.');
  }
  // Cash figures are all time, so the cash file carries no month.
  return { filename: 'sales-tracker-' + tab + '-' + (tab === 'cash' ? 'all-time' : month) + '.csv', csv: csv };
}

// ---- table-scoped reads ----
// NEEDS_[action] lists the tabs (Adapter.TABS names) an action's view or planner touches; Settings is always loaded. An action
// with no entry reads every table, which is the safe default. A table left out is absent from the state, so a view that quietly
// needs it would give wrong numbers, not an error: derive an entry from the Core function AND everything it calls, and keep it in
// step with test/scoped-state.test.js, which runs each declared action over a rich seed with all tables and with only these.
// Ids on ops (Core.ids.IdGen) count existing rows of many tables, but a read never returns them, so they are not listed for reads.
var NEEDS_ = {
  // overview: bookData (Payments, Purchases, Expenses, names from Customers), profit splits and goal profit (Sales_Log, Product_Catalog,
  // cost via Suppliers and Live_Rates), dues buckets, top customers, forecast, accounts for the account split, Goals and Budgets.
  moneyOverview: ['Customers', 'Sales_Log', 'Payments', 'Expenses', 'Purchases', 'Accounts', 'Product_Catalog', 'Suppliers', 'Live_Rates', 'Goals', 'Budgets'],
  // overview / book / cash tabs: the overview set without the goals and budgets, which an export never shows.
  moneyExport: ['Customers', 'Sales_Log', 'Payments', 'Expenses', 'Purchases', 'Accounts', 'Product_Catalog', 'Suppliers', 'Live_Rates'],
  // init = lookups + home.
  init: ['Customers', 'Sales_Log', 'Payments', 'Accounts', 'Product_Catalog', 'Code_Inventory', 'Payment_Inbox', 'Reminders_Log', 'Pay_Requests',
    'Suppliers', 'Live_Rates', 'Wallets', 'Deliveries', 'Profit_Snapshots', 'Expenses', 'Purchases', 'Budgets'],
  // homeData: sales, customers, products, payments (paid map, Auto list), accounts (hidden ones), inbox, Reminders_Log (planReminders), and
  // matching.whyNotAuto, which plans each unmatched message: Pay_Requests and Code_Inventory for a pay-link reference, Sales_Log and Accounts
  // for a line reference.
  // Also Deliveries and Budgets (with Expenses and Purchases for the budget spend) for the Today needs-attention counts.
  // stockAlerts (home.stock) reads Accounts and Sales_Log (free seats), Code_Inventory (unsold codes) and Product_Catalog (delivers-as).
  home: ['Customers', 'Sales_Log', 'Payments', 'Accounts', 'Product_Catalog', 'Code_Inventory', 'Payment_Inbox', 'Reminders_Log', 'Pay_Requests', 'Deliveries', 'Expenses', 'Purchases', 'Budgets'],
  // lookups: products, accounts (free seats from Sales_Log), unsold Code_Inventory and batches, customers with balances (Payments),
  // Suppliers with their products, the rate (Live_Rates), Wallets, and the pending Deliveries count.
  lookups: ['Customers', 'Sales_Log', 'Payments', 'Accounts', 'Product_Catalog', 'Code_Inventory', 'Suppliers', 'Live_Rates', 'Wallets', 'Deliveries'],
  // customerData: the customer, their sales (prices from Product_Catalog), their payments, balances.
  // with withLocks (the customer read) the payment locks read Pay_Requests.
  customer: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog', 'Pay_Requests'],
  // Looks up the sale, then customerData for the kind, then buildMessage (customer, product, paid map, settings).
  reminderMessage: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog'],
  // duesList: sales with balances, customers with credit.
  dues: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog'],
  // accountsOverview: accounts and their sales (free seats, collected), costs of ended lines via Suppliers and Live_Rates.
  accounts: ['Accounts', 'Sales_Log', 'Customers', 'Product_Catalog', 'Payments', 'Suppliers', 'Live_Rates'],
  // Core.paylinks.list: one row per live line with its intent, the inbox rows that match its reference and its recorded payments.
  payLinks: ['Pay_Intents', 'Accounts', 'Product_Catalog', 'Customers', 'Payments', 'Sales_Log', 'Payment_Inbox'],
  // sweepForRead_ (Pay_Requests, Code_Inventory), requestStatus (Pay_Intents, Payments, Payment_Inbox), names (Customers, Product_Catalog),
  // the delivery per request, and delivery.confirmable (Product_Catalog, Code_Inventory, Sales_Log, Customers). A sweep re-reads everything.
  payRequests: ['Pay_Requests', 'Code_Inventory', 'Pay_Intents', 'Payments', 'Payment_Inbox', 'Customers', 'Product_Catalog', 'Deliveries', 'Sales_Log'],
  // sweepForRead_ (Pay_Requests, Code_Inventory) then listDeliveries: names (Customers, Product_Catalog), the request and sale for the order link.
  deliveries: ['Deliveries', 'Customers', 'Product_Catalog', 'Pay_Requests', 'Sales_Log', 'Code_Inventory'],
  // bookData: Payments, Purchases, Expenses, names from Customers (index also builds the Product_Catalog map).
  // with withLocks (the book read) the payment locks read Pay_Requests.
  book: ['Payments', 'Purchases', 'Expenses', 'Customers', 'Product_Catalog', 'Pay_Requests'],
  // entryDetail: the row of its kind, then its customer, sale, inbox message or wallet.
  entry: ['Payments', 'Expenses', 'Purchases', 'Customers', 'Sales_Log', 'Payment_Inbox', 'Wallets'],
  // productList: the product's accounts and their active sales (free seats read Sales_Log).
  product: ['Accounts', 'Sales_Log', 'Customers', 'Product_Catalog', 'Payments'],
  // profitByFamily: sales by category, cost via Suppliers and Live_Rates (USDT).
  profit: ['Sales_Log', 'Product_Catalog', 'Customers', 'Payments', 'Suppliers', 'Live_Rates'],
  // Core.importer.review: staged rows (Import_Rows), the matches against products and accounts (Accounts, Product_Catalog), customers, the
  // active line of an account for a customer and what it has paid (Sales_Log, Payments), codes already in stock and inbox transactions.
  importReview: ['Import_Rows', 'Customers', 'Sales_Log', 'Payments', 'Accounts', 'Product_Catalog', 'Code_Inventory', 'Payment_Inbox'],
  // Core.accrual.monthly: sales and their coverage (Sales_Log, Product_Catalog), accounts and their purchases (Accounts, Purchases), cash by month
  // (Payments), and the fallback seat cost of a sale with no purchase via Suppliers and Live_Rates (USDT).
  profitMonthly: ['Sales_Log', 'Product_Catalog', 'Accounts', 'Purchases', 'Payments', 'Suppliers', 'Live_Rates'],
  // matching.suggest: the inbox row, customers, product letters, the line behind the reference (Sales_Log, Accounts), last payment dates.
  suggestCustomers: ['Payment_Inbox', 'Customers', 'Product_Catalog', 'Sales_Log', 'Accounts', 'Payments'],
  // Core.money.insights: sales (billed, renewals, retention, forecast, owed), payments (collected, paid map), customers (names), products
  // (category, delivers-as), cost via Suppliers and Live_Rates, and Accounts (a deleted account's lines are not live lines).
  insights: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog', 'Accounts', 'Suppliers', 'Live_Rates'],
  // Core.views.inboxRows: the inbox rows, and the Payments whose transaction ids mark a Matched message Auto-matched. No names are shown.
  inbox: ['Payment_Inbox', 'Payments'],
  // Core.views.reminderLog: the Reminders_Log rows (sent and skipped), the customer name, and the product and ref of the sale (Sales_Log, Product_Catalog).
  reminderLog: ['Reminders_Log', 'Customers', 'Sales_Log', 'Product_Catalog'],
  // Core.views.activityBatches reads Change_Log only (Adapter.readRecentChangeLog), which is not a state table, so no state table is loaded.
  // An empty list is the declaration: readState then loads Settings alone.
  activity: [],
  // Hot writes. A planner draws new ids from Core.ids.IdGen, which counts existing rows (payment ids: Payments; sale ids and line codes:
  // Sales_Log; customer ids: Customers), so each entry also lists the tables whose counter that planner uses.
  // pay: customer, trx check and balances (Payments, Sales_Log, Product_Catalog), new payment ids.
  pay: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog'],
  // newSale: product, customer (or a new id), seat check (Accounts, Sales_Log), the code (Code_Inventory), sale and line ids, paid-now payment id.
  newSale: ['Customers', 'Sales_Log', 'Payments', 'Product_Catalog', 'Accounts', 'Code_Inventory'],
  // renew: the line (Sales_Log), product, account, credit and trx (Payments), new sale and payment ids.
  renew: ['Sales_Log', 'Product_Catalog', 'Accounts', 'Payments'],
  // customSale: no product, account or code; the customer (or a new id), trx check (Payments) and the sale and payment ids.
  customSale: ['Customers', 'Sales_Log', 'Payments'],
  // Migration staging writes. Stage, add, delete and status touch only the staged rows.
  importStage: ['Import_Rows'],
  // jobs: job_runs (read in the action) and the settings the relay flag comes from; no state table.
  jobs: [],
  importAdd: ['Import_Rows'],
  importDelete: ['Import_Rows'],
  importStatus: ['Import_Rows'],
  // importEdit: the row, plus the ids a chosen match must name (customers, accounts, sales, products).
  importEdit: ['Import_Rows', 'Customers', 'Accounts', 'Sales_Log', 'Product_Catalog'],
  // importApply: staged rows, the matches review reads, and the tables the planners append to and count for ids (Purchases for the account cost).
  importApply: ['Import_Rows', 'Customers', 'Sales_Log', 'Payments', 'Accounts', 'Product_Catalog', 'Code_Inventory', 'Payment_Inbox', 'Purchases'],
  // orders (read): the order rows, names, the product, and each pay link's status and URL (sweepForRead_ reads Pay_Requests and Code_Inventory).
  orders: ['Orders', 'Customers', 'Product_Catalog', 'Pay_Requests', 'Code_Inventory'],
  // createOrder: the order, request and sale ids (Core.ids.IdGen counts every table below), the customer, the product, the pay request's
  // reference and the sweep of expired requests (Pay_Requests, Code_Inventory).
  createOrder: ['Orders', 'Customers', 'Product_Catalog', 'Pay_Requests', 'Sales_Log', 'Payments', 'Code_Inventory', 'Deliveries'],
  // orderStatus: the order, its pay link, and the code a cancelled link gives back (releaseOps). The sweep reads the same tables.
  orderStatus: ['Orders', 'Pay_Requests', 'Code_Inventory'],
  // fulfilOrder: the order and its pay link, the product, the customer and sale ids, the account or code planNewSale picks from, the
  // delivery id, and the payments the link recorded (attached to the sale).
  fulfilOrder: ['Orders', 'Pay_Requests', 'Product_Catalog', 'Customers', 'Sales_Log', 'Payments', 'Accounts', 'Code_Inventory', 'Deliveries'],
  // editProductPublic: the product and the other products' web addresses (slug uniqueness).
  editProductPublic: ['Product_Catalog']
};

// Reads that take { ifNone } and answer { notModified: true, version } when it equals the current Adapter.readVersion. Their NEEDS_ tables
// and everything else they depend on must be covered by that version (see the comment on VERSION_SQL in src/adapters/postgres.js).
var VERSIONED_ = { init: true, home: true };

var IMPORT_MAX_ROWS_ = 2000, IMPORT_MAX_BYTES_ = 1500000;

var READS_ = {
  moneyOverview: async function (db, st, p) {
    var month = monthOf_(st, p), o = Core.money.overview(st, month);
    o.months = Core.views.bookData(st, month).months;
    o.layout = layoutOf_(st);
    o.widgets = Core.money.WIDGETS;
    o.goals = (st.goals || []).map(function (g) { return { goal: g, progress: Core.money.goalProgress(st, g) }; });
    o.budgets = (st.budgets || []).map(function (b) { return { budget: b, progress: Core.money.budgetProgress(st, b, month) }; });
    return o;
  },
  moneyExport: async function (db, st, p) { return moneyExport_(st, p); },
  init: async function (db, st) {
    var l = Core.views.lookups(st);
    l.sheetUrl = '';
    l.walletTypes = Core.sales.WALLET_TYPES;
    return { lookups: l, home: Core.views.homeData(st) };
  },
  home: async function (db, st) { return Core.views.homeData(st); },
  // The Jobs card in More: the latest run of each job, and the relay flag from settings (no table is read for it).
  jobs: async function (db, st) {
    var rows = (await db.query('SELECT DISTINCT ON (job) job, started_at, finished_at, ok, detail FROM job_runs ORDER BY job, id DESC')).rows;
    return { jobs: Core.jobs.summarize(rows), relay: { alert: st.settings.relay_alert === 'on', heartbeat: st.settings.relay_heartbeat || '', hours: Core.jobs.RELAY_HOURS } };
  },
  lookups: async function (db, st) {
    var l = Core.views.lookups(st);
    l.sheetUrl = '';
    l.walletTypes = Core.sales.WALLET_TYPES;
    return l;
  },
  customer: async function (db, st, p) { var c = Core.views.customerData(st, p.id, { withLocks: true }); if (!c) throw new Error('Unknown customer ' + p.id + '.'); return c; },
  reminderMessage: async function (db, st, p) {
    var sale = (st.sales || []).filter(function (s) { return String(s.Sale_ID) === String(p.saleId); })[0];
    if (!sale) throw new Error('Unknown sale ' + p.saleId + '.');
    var kind = p.kind;
    if (kind !== 'before' && kind !== 'on_day' && kind !== 'after' && kind !== 'due') {
      var cd = Core.views.customerData(st, sale.Customer_ID);
      var row = cd ? cd.history.filter(function (r) { return r.saleId === sale.Sale_ID; })[0] : null;
      if (!row) throw new Error('Unknown customer for sale ' + p.saleId + '.');
      kind = row.kind;
    }
    return Core.reminders.buildMessage(st, sale, kind, p.lang ? { lang: p.lang } : undefined);
  },
  dues: async function (db, st) { return Core.views.duesList(st); },
  accounts: async function (db, st) { return Core.views.accountsOverview(st); },
  payLinks: async function (db, st) { return Core.paylinks.list(st); },
  // The panel's order list: newest first, each with its pay link status and URL. The sweep expires open links past their time first.
  orders: async function (db, st) { st = await sweepForRead_(db, st); return { orders: Core.orders.list(st) }; },
  payRequests: async function (db, st) {
    st = await sweepForRead_(db, st);
    var now = Date.now();
    var cust = {}, prod = {};
    (st.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    (st.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    var rows = (st.payRequests || []).map(function (rq) {
      var status = Core.paylinks.requestStatus(st, rq);
      var d = (st.deliveries || []).filter(function (x) { return x.Request_ID === rq.Request_ID; })[0];
      return { id: rq.Request_ID, ref: Core.paylinks.requestRef(rq), title: rq.Title, amount: Number(rq.Amount) || 0,
        customerId: rq.Customer_ID, customer: (cust[rq.Customer_ID] || {}).Name || rq.Customer_Name || '',
        productId: rq.Product_ID, product: rq.Product_ID ? (prod[rq.Product_ID] || {}).Product_Name || rq.Product_ID : '',
        status: rq.Status, stage: requestStage_(rq, status, now), created: rq.Created, expires: rq.Expires, note: rq.Note || '',
        saleId: rq.Sale_ID, url: Core.paylinks.requestUrl(st.settings, rq), token: rq.Token || '', canGotPaid: Core.delivery.confirmable(st, rq, now),
        deliveryId: d ? d.Delivery_ID : '', deliveryStatus: d ? d.Status : '' };
    }).sort(function (a, b) { return Number(String(b.id).replace(/\D/g, '')) - Number(String(a.id).replace(/\D/g, '')); });
    return { rows: rows };
  },
  deliveries: async function (db, st, p) {
    st = await sweepForRead_(db, st);
    return { rows: Core.delivery.listDeliveries(st, { status: p && p.status ? String(p.status) : undefined }) };
  },
  book: async function (db, st, p) { return Core.views.bookData(st, p.month || st.today.slice(0, 7), { withLocks: true }); },
  entry: async function (db, st, p) {
    var tab = { payment: 'Payments', expense: 'Expenses', purchase: 'Purchases' }[p.kind];
    Core.views.entryDetail(st, { kind: p.kind, id: p.id });   // throws for an unknown kind or id before any query
    var log = await Adapter.readChangeLogFor(db, tab, p.id);
    return Core.views.entryDetail(st, { kind: p.kind, id: p.id, log: log });
  },
  product: async function (db, st, p) { return Core.views.productList(st, p.productId); },
  profit: async function (db, st) { var families = Core.views.profitByFamily(st); return { families: families, totals: Core.views.profitTotals(families) }; },
  // { batch } -> Core.importer.review plus batches: [{ batch, rows, applied }]. A blank batch means the newest one (latest Created, then latest row).
  importReview: async function (db, st, p) {
    var seen = {}, order = [];
    (st.importRows || []).forEach(function (r, i) {
      var b = seen[r.Batch];
      if (!b) { b = seen[r.Batch] = { batch: r.Batch, rows: 0, applied: 0, created: '', at: i }; order.push(b); }
      b.rows++; if (r.Status === 'Applied') b.applied++;
      if (String(r.Created || '') > b.created) b.created = String(r.Created || '');
      b.at = i;
    });
    var newest = order.slice().sort(function (a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : b.at - a.at; })[0];
    var asked = p && p.batch !== undefined && p.batch !== null ? String(p.batch).trim() : '';
    var out = Core.importer.review(st, { batch: asked || (newest ? newest.batch : '') });
    out.batches = order.map(function (b) { return { batch: b.batch, rows: b.rows, applied: b.applied }; });
    return out;
  },
  // { from, to } as 'YYYY-MM' -> Core.accrual.monthly. Bad ranges answer with the core's own error text.
  profitMonthly: async function (db, st, p) {
    var from = p && p.from, to = p && p.to;
    return Core.accrual.monthly(st, { from: from === '' || from === null ? undefined : from, to: to === '' || to === null ? undefined : to });
  },
  insights: async function (db, st, p) { return Core.money.insights(st, rangeOf_(st, p)); },
  inbox: async function (db, st, p) { return inboxOf_(st, p); },
  reminderLog: async function (db, st, p) { return reminderLogOf_(st, p); },
  activity: async function (db, st, p) {
    var limit = activityLimit_(p);
    var lines = await Adapter.readRecentChangeLog(db, ACTIVITY_LINES_);
    return Core.views.activityBatches(lines, { limit: limit, truncated: lines.length >= ACTIVITY_LINES_ });
  },
  suggestCustomers: async function (db, st, p) {
    var t = String((p && p.trx) || '').trim().toUpperCase(), row = null;
    (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID || '').trim().toUpperCase() === t) row = r; });
    if (!row) throw new Error('That payment message is no longer in the inbox.');
    return Core.matching.suggest(st, row, p && p.query);
  }
};

var WRITES_ = {
  saveGoal: async function (db, st, p) {
    var plan = Core.sales.planGoal(st, clean_(p));
    return commit_(db, plan, 'saveGoal', plan.result && { message: p.goalId ? 'Goal updated' : 'Goal added', goalId: plan.result.goalId });
  },
  deleteGoal: async function (db, st, p) {
    var plan = Core.sales.planDeleteGoal(st, clean_(p));
    return commit_(db, plan, 'deleteGoal', plan.result && { message: 'Goal deleted', goalId: plan.result.goalId });
  },
  saveBudget: async function (db, st, p) {
    var plan = Core.sales.planBudget(st, clean_(p));
    return commit_(db, plan, 'saveBudget', plan.result && { message: p.budgetId ? 'Budget updated' : 'Budget added', budgetId: plan.result.budgetId });
  },
  deleteBudget: async function (db, st, p) {
    var plan = Core.sales.planDeleteBudget(st, clean_(p));
    return commit_(db, plan, 'deleteBudget', plan.result && { message: 'Budget deleted', budgetId: plan.result.budgetId });
  },
  saveLayout: async function (db, st, p) {
    var plan = Core.sales.planLayout(st, clean_(p));
    return commit_(db, plan, 'saveLayout', plan.result && { message: 'Layout saved', widgets: plan.result.widgets }, { log: false });
  },
  newSale: async function (db, st, p) {
    var plan = Core.sales.planNewSale(st, p);
    return commit_(db, plan, 'newSale', plan.result && Object.assign({ message: 'Sale saved' }, plan.result));
  },
  customSale: async function (db, st, p) {
    var plan = Core.sales.planCustomSale(st, p);
    return commit_(db, plan, 'customSale', plan.result && Object.assign({ message: 'Custom sale saved' }, plan.result));
  },
  renew: async function (db, st, p) {
    var plan = Core.sales.planRenew(st, p);
    var renewed = await commit_(db, plan, 'renew', plan.result && Object.assign({ message: 'Renewed ' + p.subCode }, plan.result));
    if (renewed.ok) await enqueueEvent_(db, 'subscription.renewed', { saleId: renewed.data.saleId, subCode: p.subCode });
    return renewed;
  },
  pay: async function (db, st, p) {
    var plan = Core.sales.planPayment(st, p);
    var msg = plan.result ? 'Payment saved' + (plan.result.credit > 0 ? ' (৳' + plan.result.credit + ' kept as credit)' : '') : '';
    return commit_(db, plan, 'pay', plan.result && Object.assign({ message: msg }, plan.result));
  },
  edit: async function (db, st, p) { return commit_(db, Core.sales.planEdit(st, p), 'edit', { message: 'Changes saved' }); },
  retireAccount: async function (db, st, p) {
    var plan = Core.sales.planRetireAccount(st, p);
    return commit_(db, plan, 'retireAccount', plan.result && Object.assign({ message: plan.result.accountId + ' retired' }, plan.result));
  },
  endLine: async function (db, st, p) {
    var plan = Core.sales.planEndLine(st, p);
    var ended = await commit_(db, plan, 'endLine', plan.result && Object.assign({ message: 'Line ended' }, plan.result));
    if (ended.ok) await enqueueEvent_(db, 'subscription.ended', { saleId: Number(p.saleId) });
    return ended;
  },
  deleteAccount: async function (db, st, p) {
    var plan = Core.sales.planDeleteAccount(st, p);
    return commit_(db, plan, 'deleteAccount', plan.result && Object.assign({ message: plan.result.accountId + ' deleted' }, plan.result));
  },
  mergeCustomers: async function (db, st, p) {
    var plan = Core.sales.planMergeCustomers(st, p);
    return commit_(db, plan, 'mergeCustomers', plan.result && Object.assign({ message: 'Customers merged' }, plan.result));
  },
  editPayment: async function (db, st, p) {
    var plan = Core.sales.planEditPayment(st, p);
    return commit_(db, plan, 'editPayment', plan.result && { message: plan.result.credit > 0 ? 'Payment saved (৳' + plan.result.credit + ' kept as credit)' : 'Payment saved', paymentId: plan.result.paymentId });
  },
  deletePayment: async function (db, st, p) {
    var plan = Core.sales.planDeletePayment(st, p);
    return commit_(db, plan, 'deletePayment', plan.result && { message: 'Payment deleted', paymentId: plan.result.paymentId });
  },
  editExpense: async function (db, st, p) {
    var plan = Core.sales.planEditExpense(st, p);
    return commit_(db, plan, 'editExpense', plan.result && { message: 'Expense saved', expenseId: plan.result.expenseId });
  },
  deleteExpense: async function (db, st, p) {
    var plan = Core.sales.planDeleteExpense(st, p);
    return commit_(db, plan, 'deleteExpense', plan.result && { message: 'Expense deleted', expenseId: plan.result.expenseId });
  },
  editPurchase: async function (db, st, p) {
    var plan = Core.sales.planEditPurchase(st, p);
    return commit_(db, plan, 'editPurchase', plan.result && { message: 'Purchase saved', purchaseId: plan.result.purchaseId });
  },
  deletePurchase: async function (db, st, p) {
    var plan = Core.sales.planDeletePurchase(st, p);
    return commit_(db, plan, 'deletePurchase', plan.result && { message: 'Purchase deleted', purchaseId: plan.result.purchaseId });
  },
  addExpense: async function (db, st, p) { return commit_(db, Core.sales.planExpense(st, p), 'addExpense', { message: 'Expense saved' }); },
  addPurchase: async function (db, st, p) { return commit_(db, Core.sales.planPurchase(st, p), 'addPurchase', { message: 'Purchase saved' }); },
  addAccount: async function (db, st, p) {
    var plan = Core.sales.planAccount(st, p);
    return commit_(db, plan, 'addAccount', plan.result && { message: 'Account ' + plan.result.accountId + ' added', accountId: plan.result.accountId });
  },
  addCodes: async function (db, st, p) {
    var plan = Core.sales.planAddCodes(st, p);
    return commit_(db, plan, 'addCodes', plan.result && { message: plan.result.added + ' codes added' +
      (plan.result.skipped.length ? ', ' + plan.result.skipped.length + ' already in stock' : ''), skipped: plan.result.skipped });
  },
  addWallet: async function (db, st, p) {
    var plan = Core.sales.planWallet(st, p);
    return commit_(db, plan, 'addWallet', plan.result && { message: 'Wallet ' + plan.result.walletId + ' added', walletId: plan.result.walletId });
  },
  editSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplierEdit(st, p);
    return commit_(db, plan, 'editSupplier', plan.result && { message: 'Supplier updated', supplierId: plan.result.supplierId });
  },
  deleteSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplierDelete(st, p);
    return commit_(db, plan, 'deleteSupplier', plan.result && { message: 'Supplier deleted', supplierId: plan.result.supplierId });
  },
  editBatch: async function (db, st, p) {
    var plan = Core.sales.planBatchEdit(st, p);
    return commit_(db, plan, 'editBatch', plan.result && { message: 'Batch updated', codeBatch: plan.result.codeBatch });
  },
  deleteBatch: async function (db, st, p) {
    var plan = Core.sales.planBatchDelete(st, p);
    return commit_(db, plan, 'deleteBatch', plan.result && { message: plan.result.removed + ' codes removed', codeBatch: plan.result.codeBatch });
  },
  // Called by the panel once per load. Idempotent: the month is the key, and a second insert is ignored.
  snapshotIfDue: async function (db, st, p) {
    var month = Core.views.previousMonth(today_());
    var have = (st.profitSnapshots || []).some(function (r) { return r.Month === month; });
    if (have) return { ok: true, data: { month: month, created: false } };
    if (Core.views.profitByFamily(st, month).some(function (f) { return f.rateMissing; })) {
      return { ok: true, data: { month: month, created: false, reason: 'rate missing' } };
    }
    var row = Core.views.profitSnapshotRow(st, month);
    await db.query('INSERT INTO profit_snapshots (month, revenue_bdt, cost_bdt, profit_bdt) VALUES ($1, $2, $3, $4) ON CONFLICT (month) DO NOTHING',
      [row.month, row.revenue_bdt, row.cost_bdt, row.profit_bdt]);
    return { ok: true, data: { month: month, created: true, row: row } };
  },
  refreshRate: async function (db, st, p) {
    var cached = Core.rates.resolveRate({ liveRates: st.liveRates, settings: {} });
    if (!(p && p.force) && cached.source === 'bybit' && !cached.stale) {
      return { ok: true, data: { rate: cached.rate, source: 'bybit', fetchedAt: cached.fetchedAt, stale: false } };
    }
    var ads;
    try { ads = await fetchAds_(); } catch (e) { return { ok: false, error: 'Rate fetch failed: ' + String((e && e.message) || e) }; }
    var rate = Core.rates.pickRate((ads || []).map(function (a) { return { price: a && a.price }; }));
    if (rate === null) return { ok: false, error: 'Rate fetch returned no usable price.' };
    var at = new Date().toISOString();
    await db.query('INSERT INTO live_rates (id, rate, fetched_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at',
      ['usdt_bdt', rate, at]);
    return { ok: true, data: { rate: rate, source: 'bybit', fetchedAt: at, stale: false } };
  },
  backfillPayTokens: async function (db, st, p) {
    var plan = Core.sales.planBackfillPayTokens(st);
    return commit_(db, plan, 'backfillPayTokens', { message: plan.result.updated + ' sales got a pay token', updated: plan.result.updated });
  },
  addSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplier(st, p);
    return commit_(db, plan, 'addSupplier', plan.result && { message: 'Supplier added', supplierId: plan.result.supplierId });
  },
  addCodesBatch: async function (db, st, p) {
    var plan = Core.sales.planAddCodesBatch(st, p);
    return commit_(db, plan, 'addCodesBatch', plan.result && { message: plan.result.added + ' codes added', codeBatch: plan.result.codeBatch });
  },
  saveTemplate: async function (db, st, p) {
    var plan = Core.sales.planTemplate(st, p);
    return commit_(db, plan, 'saveTemplate', plan.result && Object.assign({ message: 'Template saved' }, plan.result));
  },
  settings: async function (db, st, p) { return commit_(db, Core.sales.planSettings(st, p.values || {}), 'settings', { message: 'Settings saved' }); },
  addProduct: async function (db, st, p) {
    var plan = Core.sales.planProduct(st, p);
    var res = await commit_(db, plan, 'addProduct', plan.result);
    if (!res.ok) return res;
    return { ok: true, data: { message: plan.result.tabName + ' added', productId: plan.result.productId, tab: '' } };
  },
  editProduct: async function (db, st, p) {
    var plan = Core.sales.planEditProduct(st, p);
    return commit_(db, plan, 'editProduct', plan.result && { message: 'Product updated', productId: plan.result.productId });
  },
  createPayRequest: async function (db, st, p) {
    p = clean_(p);
    st = await sweepExpired_(db, st);
    var plan = Core.paylinks.planCreateRequest(st, { title: p.title, amount: p.amount, customerId: p.customerId, customerName: p.customerName,
      productId: p.productId, note: p.note, hours: p.hours });
    if (plan.errors && plan.errors.length && plan.code) return { ok: false, error: plan.errors[0], code: plan.code };
    return commit_(db, plan, 'createPayRequest', plan.result && Object.assign({ message: plan.result.requestId + ' created',
      url: Core.paylinks.requestUrl(st.settings, { Token: plan.result.token }) }, plan.result));
  },
  cancelPayRequest: async function (db, st, p) {
    p = clean_(p);
    st = await sweepExpired_(db, st);
    var plan = Core.paylinks.planCancelRequest(st, { id: p.id });
    return commit_(db, plan, 'cancelPayRequest', plan.result && Object.assign({ message: plan.result.requestId + ' cancelled' }, plan.result));
  },
  // The owner confirms by hand (no SMS). Idempotent by transaction id; the planner marks a matching inbox row Matched.
  gotPaidRequest: async function (db, st, p) {
    p = clean_(p);
    st = await sweepExpired_(db, st);
    var plan = Core.delivery.planConfirmRequest(st, { id: p.id, trx: p.trx, method: p.method, amount: p.amount, source: 'App', _role: p._role });
    return commit_(db, plan, 'gotPaidRequest', plan.result && Object.assign({ message: plan.result.duplicate ? 'Already recorded' :
      plan.result.requestId + ' paid' + (plan.result.delivered ? ', code delivered' : plan.result.deliveryId ? ', delivery pending' : '') }, plan.result));
  },
  setDelivery: async function (db, st, p) {
    p = clean_(p);
    var plan = Core.delivery.planSetDelivery(st, { id: p.id, status: p.status, note: p.note });
    return commit_(db, plan, 'setDelivery', plan.result && Object.assign({ message: 'Delivery ' + plan.result.id + ' set to ' + p.status }, plan.result));
  },
  match: async function (db, st, p) {
    var row = null;
    (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID).toUpperCase() === String(p.trx).toUpperCase()) row = r; });
    if (!row) return { ok: false, error: 'That payment message is no longer in the inbox.' };
    var manual = { customerId: p.customerId, subCode: p.subCode || '', _role: p._role };
    ['amount', 'date', 'method', 'note', 'newCustomer'].forEach(function (k) { if (p[k] !== undefined && p[k] !== null) manual[k] = p[k]; });
    var plan = Core.matching.planInboxMatch(st, row, manual);
    if (plan.status === 'duplicate') return commit_(db, plan, 'match', { message: 'Already recorded' });
    return commit_(db, plan, 'match', { message: plan.result ? plan.result.note : '' });
  },
  // One payment across several items (Core.matching.planSplitMatch). The whole split is one batch: one Undo reverts it, a repeated requestId
  // returns the first answer, and a second call for the same trx is 'Already recorded' (planner duplicate).
  splitMatch: async function (db, st, p) {
    var row = null;
    (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID).toUpperCase() === String(p.trx).toUpperCase()) row = r; });
    if (!row) return { ok: false, error: 'That payment message is no longer in the inbox.' };
    var split = clean_(p);
    delete split.trx; delete split.requestId;
    var plan = Core.matching.planSplitMatch(st, row, split);
    if (plan.status === 'duplicate') return commit_(db, plan, 'splitMatch', { message: 'Already recorded' });
    return commit_(db, plan, 'splitMatch', plan.result && Object.assign({ message: plan.result.note }, plan.result));
  },
  ignoreInbox: async function (db, st, p) {
    var plan = Core.sales.planIgnoreInbox(st, p);
    return commit_(db, plan, 'ignoreInbox', plan.result && { message: plan.result.note ? 'Marked as ' + plan.result.note.toLowerCase() : 'Message ignored', trx: plan.result.trx });
  },
  deleteInbox: async function (db, st, p) {
    var plan = Core.sales.planDeleteInbox(st, p);
    return commit_(db, plan, 'deleteInbox', plan.result && { message: 'Message deleted', trx: plan.result.trx });
  },
  remindSent: async function (db, st, p) {
    var plan = { errors: [], ops: [{ op: 'append', tab: 'Reminders_Log', values: { Date: st.today, Sale_ID: p.saleId, Customer_ID: p.customerId,
      Kind: p.kind, Channel: p.channel || '', Status: p.status === 'skipped' ? 'skipped' : 'sent' } }] };
    return commit_(db, plan, 'remindSent', { message: p.status === 'skipped' ? 'Skipped' : 'Marked as sent' }, { log: false });
  },
  // Migration staging. Rules live in Core.importer; these only run the planner through commit_ (request ids, audit log, Undo).
  // importStage { batch, rows: [{ id, kind, sheet, ref, data }] }: up to 2000 rows and 1.5 MB of JSON.
  importStage: async function (db, st, p) {
    if (Array.isArray(p.rows)) {
      if (p.rows.length > IMPORT_MAX_ROWS_) return { ok: false, error: 'Send at most ' + IMPORT_MAX_ROWS_ + ' rows at a time.' };
      if (JSON.stringify(p.rows).length > IMPORT_MAX_BYTES_) return { ok: false, error: 'That batch is too large. Send fewer rows at a time.' };
    }
    var rowsIn = p.rows;
    if (Array.isArray(rowsIn)) {
      var prep = await vaultPrepareRows_(rowsIn);
      if (prep.error) return { ok: false, error: prep.error };
      rowsIn = prep.rows;
    }
    var plan = Core.importer.planStage(st, { batch: p.batch, rows: rowsIn });
    return commit_(db, plan, 'importStage', plan.result && Object.assign({ message: plan.result.added + ' rows staged' +
      (plan.result.skipped ? ', ' + plan.result.skipped + ' already there' : '') }, plan.result));
  },
  // importEdit { rowId, data?, note?, match? }
  importEdit: async function (db, st, p) {
    var input = { rowId: p.rowId, data: p.data, note: p.note };
    if (p.match !== undefined) input.match = p.match;   // the planner reads a present match key, null clears the choice
    // Moving text into the row's encrypted login details: storeAsLogin lists fields whose text is moved (the field is cleared), secret adds text.
    var moveFields = Array.isArray(p.storeAsLogin) ? p.storeAsLogin.map(String) : [];
    var row = importRowOf_(st, p.rowId);
    if (row && (moveFields.length || (typeof p.secret === 'string' && p.secret !== ''))) {
      if (!vaultConfigured_()) return { ok: false, error: 'Set VAULT_KEY before staging login details.' };
      var cur = {};
      try { cur = JSON.parse(row.Data) || {}; } catch (e) { cur = {}; }
      var data = Object.assign({}, p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data : {}), parts = [];
      for (var mi = 0; mi < moveFields.length; mi++) {
        var f = moveFields[mi], v = Object.prototype.hasOwnProperty.call(data, f) ? data[f] : cur[f];
        if (Core.importer.FIELDS[row.Kind].indexOf(f) < 0 || f === 'flags' || typeof v !== 'string') return { ok: false, error: 'Cannot store ' + f + ' as login details.' };
        if (v.trim()) parts.push(f + ': ' + v.trim());
        data[f] = '';
      }
      if (typeof p.secret === 'string' && p.secret.trim()) parts.push(p.secret.trim());
      if (parts.length) {
        var before = Core.importer.hasSecret(cur) ? await vaultDecrypt_(cur.secretCipher, cur.secretIv, row.Row_ID) : '';
        var enc = await vaultEncrypt_((before ? before + '\n' : '') + parts.join('\n'), row.Row_ID);
        input.secretEnc = { cipher: enc.ciphertext, iv: enc.iv };
      }
      input.data = data;
    }
    if (p.clearSecret === true) input.clearSecret = true;
    var plan = Core.importer.planEditRow(st, input);
    // Text moved into the vault: the change_log line for Data shows those fields blank (never plaintext). The batch is audit-only ('importEdit:login'): Undo skips it,
    // since reverting would restore blank fields and drop the encrypted copy.
    if (moveFields.length && plan.ops) plan.ops.forEach(function (o) { if (o.tab === 'Import_Rows' && o.values && o.values.Data !== undefined) o.redactJson = { Data: moveFields }; });
    if (plan.code === 'looks_like_login') return { ok: false, error: plan.errors[0], code: plan.code, fields: plan.fields };
    return commit_(db, plan, moveFields.length ? 'importEdit:login' : 'importEdit', plan.result && Object.assign({ message: 'Row saved' }, plan.result));
  },
  // importAdd { batch, kind, data }
  importAdd: async function (db, st, p) {
    var plan = Core.importer.planAddRow(st, { batch: p.batch, kind: p.kind, data: p.data });
    return commit_(db, plan, 'importAdd', plan.result && Object.assign({ message: 'Row added' }, plan.result));
  },
  // importDelete { rowId }
  importDelete: async function (db, st, p) {
    var plan = Core.importer.planDeleteRow(st, { rowId: p.rowId });
    return commit_(db, plan, 'importDelete', plan.result && Object.assign({ message: 'Row deleted' }, plan.result));
  },
  // importStatus { rowIds, status } with status Review, Approved or Skipped
  importStatus: async function (db, st, p) {
    var plan = Core.importer.planSetStatus(st, { rowIds: p.rowIds, status: p.status });
    return commit_(db, plan, 'importStatus', plan.result && Object.assign({ message: plan.result.updated + ' rows set to ' + p.status }, plan.result));
  },
  // importApply { batch, rowIds? }: one batch of ops, so one Undo reverses all of it.
  importApply: async function (db, st, p) {
    var plan = Core.importer.planApply(st, { batch: p.batch, rowIds: p.rowIds, includeParents: p.includeParents === true, approveParents: p.approveParents === true });
    // Rows with an encrypted login: re-encrypt each under its new secret id (AAD = that id) before anything is written; a failure writes nothing.
    var moved = [];
    if (plan.result && plan.result.secrets && plan.result.secrets.length) {
      if (!vaultConfigured_()) return { ok: false, error: 'Set VAULT_KEY before applying login details.' };
      for (var si = 0; si < plan.result.secrets.length; si++) {
        var sj = plan.result.secrets[si], srow = importRowOf_(st, sj.rowId), sd = JSON.parse(srow.Data), sid = 'sec:' + sj.rowId;
        var plain = await vaultDecrypt_(sd.secretCipher, sd.secretIv, sj.rowId), senc = await vaultEncrypt_(plain, sid);
        moved.push({ secretId: sid, accountId: sj.accountId, saleId: sj.saleId, saleToken: sj.saleToken || '', label: srow.Kind === 'account' ? 'Account login' : 'Login details', ciphertext: senc.ciphertext, iv: senc.iv });
      }
    }
    var applied = await commit_(db, plan, 'importApply', plan.result && Object.assign({ message: 'Applied ' + plan.result.applied + ' rows' + (plan.result.skipped && plan.result.skipped.length ? ', ' + plan.result.skipped.length + ' need attention' : '') }, plan.result, { secrets: moved.length }));
    if (applied.ok) {
      var nowIso = new Date().toISOString();
      for (var mj = 0; mj < moved.length; mj++) {
        moved[mj].created = nowIso; moved[mj].updated = nowIso;
        await Adapter.vaultInsertSecret(db, moved[mj], 'update');
        await vaultAudit_(db, 'vault:import', moved[mj].secretId, moved[mj].label);
      }
    }
    return applied;
  },
  // Orders (Phase 4). Owner actions: a website order arrives through the public API in Phase 5. Each write runs the planner through commit_.
  // createOrder { productId, months?, customerId | customerName, contact?, contactChannel?, price?, note? }: the price the panel shows is checked.
  createOrder: async function (db, st, p) {
    p = clean_(p);
    st = await sweepExpired_(db, st);
    var plan = Core.orders.planCreateOrder(st, { source: 'panel', productId: p.productId, months: p.months, customerId: p.customerId,
      customerName: p.customerName, contact: p.contact, contactChannel: p.contactChannel, price: p.price, note: p.note, hours: p.hours });
    if (plan.errors && plan.errors.length && plan.code) return { ok: false, error: plan.errors[0], code: plan.code };
    var made = await commit_(db, plan, 'createOrder', plan.result && Object.assign({ message: plan.result.orderId + ' created',
      url: Core.paylinks.requestUrl(st.settings, { Token: plan.result.token }) }, plan.result));
    if (made.ok) await enqueueEvent_(db, 'order.created', await orderEventData_(db, made.data.orderId));
    return made;
  },
  // orderStatus { id, status }: New, AwaitingPayment, Paid (needs its pay link paid) or Cancelled (cancels an open pay link).
  orderStatus: async function (db, st, p) {
    st = await sweepExpired_(db, st);
    var plan = Core.orders.planOrderStatus(st, { id: p.id, status: p.status });
    var moved = await commit_(db, plan, 'orderStatus', plan.result && Object.assign({ message: plan.result.orderId + ' is ' + plan.result.status }, plan.result));
    if (moved.ok && p.status === 'Paid') await enqueueEvent_(db, 'order.paid', await orderEventData_(db, moved.data.orderId));
    return moved;
  },
  // fulfilOrder { orderId, codeId? (code products), accountId? (account products), customerId? }: the sale, delivery and links in one batch.
  fulfilOrder: async function (db, st, p) {
    var plan = Core.orders.planFulfil(st, { orderId: p.orderId, codeId: p.codeId, accountId: p.accountId, customerId: p.customerId });
    return commit_(db, plan, 'fulfilOrder', plan.result && Object.assign({ message: plan.result.orderId + ' fulfilled' +
      (plan.result.delivered ? ', key ready to send' : '') }, plan.result));
  },
  // editProductPublic { productId, slug?, public?, description?, imagePath?, sortOrder?, publicPrice? }: only the fields sent change.
  editProductPublic: async function (db, st, p) {
    var plan = Core.orders.planEditPublic(st, p);
    return commit_(db, plan, 'editProductPublic', plan.result && { message: 'Website listing saved', productId: plan.result.productId });
  },
  // Public API settings (owner only). The raw key and the webhook secret come back once, in the first answer (see SECRET_FIELD_).
  createApiKey: async function (db, st, p) { return createApiKey_(db, p); },
  revokeApiKey: async function (db, st, p) { return revokeApiKey_(db, p); },
  saveWebhook: async function (db, st, p) { return saveWebhook_(db, p); },
  resendWebhook: async function (db, st, p) { return resendWebhook_(db, p); },
  export: async function (db, st) { return { ok: true, data: exportAll_(st) }; }
};

// undo: planUndo reads current values synchronously, so every tab is read first.
function fixUndo() {
  WRITES_.undo = async function (db, st, p) {
    var last = await Adapter.readLastBatch(db, { skipAuto: true });
    // With a batchId (from the save's Undo toast) only that batch is reverted, and only while it is still the newest one Undo can reverse.
    if (p && p.batchId && (!last || last.batchId !== String(p.batchId))) return { ok: false, error: STALE_UNDO_ };
    if (!last || !last.lines || !last.lines.length) return { ok: false, error: 'Nothing to undo.' };
    var rows = {};
    for (var t in Adapter.TABS) {
      var key = Core.undo.KEYS[t];
      if (!key) continue;
      var rs = await Adapter.readTab(db, t);
      rows[t] = {};
      rs.forEach(function (r) { rows[t][String(r[key])] = r; });
    }
    function getCurrent(tab, id, field) {
      var row = rows[tab] && rows[tab][String(id)];
      return row ? row[Adapter.fieldFor(tab, field)] : undefined;
    }
    var plan = Core.undo.planUndo(last, getCurrent);
    if (plan.errors.length) return { ok: false, error: plan.errors[0] };
    await Adapter.applyOps(db, plan.ops, { batchId: batchId_(), action: 'undo:' + last.batchId });
    // Undoing an import apply: the logins it moved into the vault go too (secret id sec:<row id>), so none keeps pointing at a deleted sale or account.
    if (last.lines.some(function (l) { return String(l.Action) === 'importApply'; })) {
      var seenRows = {};
      for (var ui = 0; ui < last.lines.length; ui++) {
        var ul = last.lines[ui];
        if (ul.Tab !== 'Import_Rows' || seenRows[ul.Row_Key]) continue;
        seenRows[ul.Row_Key] = true;
        var sec = await Adapter.vaultGetSecret(db, 'sec:' + ul.Row_Key);
        if (!sec) continue;
        await Adapter.vaultDeleteSecret(db, sec.secret_id);
        await vaultAudit_(db, 'vault:undo-import', sec.secret_id, sec.label);
      }
    }
    return { ok: true, data: { message: 'Undone: ' + plan.result.action } };
  };
}
fixUndo();

// ---- staff accounts (phase 2) ----
// Owner only (src/core/permissions.js). Storage in src/adapters/postgres.js; the rules (who may be invited, what may change) are here.
// A staff change is logged to change_log under action 'staff:<field>' with tab 'Staff'. Undo skips those lines.
NEEDS_.staffList = []; NEEDS_.staffInvite = []; NEEDS_.staffUpdate = [];
READS_.staffList = async function (db) { return { staff: await Adapter.readStaff(db) }; };
var UUID_RE_ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var INVITE_ROLES_ = ['staff', 'viewer'];
WRITES_.staffUpdate = async function (db, st, p) {
  var userId = String(p.userId || '');
  if (!UUID_RE_.test(userId)) return { ok: false, error: 'Unknown staff member.' };
  var cur = await Adapter.readStaffMember(db, userId);
  if (!cur) return { ok: false, error: 'Unknown staff member.' };
  if (db.actor && db.actor === userId) return { ok: false, error: 'You cannot change your own access.' };
  var want = {};
  if (p.role !== undefined && p.role !== cur.role) {
    if (INVITE_ROLES_.indexOf(String(p.role)) < 0) return { ok: false, error: 'Role must be staff or viewer.' };
    want.role = String(p.role);
  }
  if (p.active !== undefined && (p.active === true) !== cur.active) want.active = p.active === true;
  if (!Object.keys(want).length) return { ok: true, data: { message: 'Nothing changed' } };
  // Owners are set in the database, and at least one active owner must remain.
  if (cur.role === 'owner' && (want.role || want.active === false)) {
    var owners = (await Adapter.readStaff(db)).filter(function (m) { return m.role === 'owner' && m.active && m.userId !== userId; });
    if (!owners.length) return { ok: false, error: 'At least one active owner must remain.' };
  }
  await Adapter.updateStaff(db, userId, want);
  if (want.role) await Adapter.logAudit(db, 'staff:role', [{ tab: 'Staff', rowKey: userId, field: 'role', old: cur.role, new: want.role }]);
  if (want.active !== undefined) await Adapter.logAudit(db, 'staff:active', [{ tab: 'Staff', rowKey: userId, field: 'active', old: String(cur.active), new: String(want.active) }]);
  return { ok: true, data: { message: 'Staff saved' } };
};
// Creates the login and emails an invite through Supabase Auth's admin endpoint. Needs the function's SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (set by Supabase on the function). Returns the new auth user id.
async function inviteUser_(email) {
  var base = Deno.env.get('SUPABASE_URL') || '', key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!base || !key) throw new Error('Invites need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the function.');
  var root = base.replace(/\/+$/, '') + '/auth/v1';
  var headers = { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': 'Bearer ' + key };
  var res = await fetch(root + '/invite', { method: 'POST', headers: headers, body: JSON.stringify({ email: email }) });
  var data = await res.json().catch(function () { return null; });
  if (res.ok && data && data.id) return { id: String(data.id), existing: false };
  // The address already has a login: find its id and link it instead of failing.
  if (res.status === 422 || (data && /exist|registered/i.test(String(data.error_code || data.msg || data.message || '')))) {
    for (var page = 1; page <= 25; page++) {
      var lr = await fetch(root + '/admin/users?page=' + page + '&per_page=200', { headers: headers });
      var ld = await lr.json().catch(function () { return null; });
      var users = ld && Array.isArray(ld.users) ? ld.users : [];
      for (var i = 0; i < users.length; i++) {
        if (String(users[i].email || '').toLowerCase() === email && users[i].id) {
          // Only an address the owner of the mailbox has confirmed may be linked. An unconfirmed login could be a pre-registered one.
          if (!users[i].email_confirmed_at) throw new Error('A login with this email exists but is not confirmed. Remove it in Supabase Auth, then invite again.');
          return { id: String(users[i].id), existing: true };
        }
      }
      if (!lr.ok || users.length < 200) break;
    }
  }
  throw new Error('Could not send the invite. Check the address.');
}

function exportAll_(st) {
  var tables = {
    Customers: { rows: st.customers, head: ['Customer_ID', 'Name', 'Channel', 'Handle', 'Discord_User_ID', 'Notes', 'Created'] },
    Sales: { rows: st.sales, head: ['Sale_ID', 'Sale_Date', 'Customer_ID', 'Customer', 'Contact', 'Product_ID', 'Account_ID', 'Code_ID', 'Qty',
      'Unit_Price', 'Months', 'Paid_Till', 'Record_Status', 'Sub_Code', 'Cost_Snapshot', 'Notes'] },
    Payments: { rows: st.payments, head: ['Payment_ID', 'Date', 'Customer_ID', 'Sale_ID', 'Amount', 'Method', 'Transaction_ID', 'Source', 'Note'] },
    Expenses: { rows: st.expenses, head: ['Expense_ID', 'Date', 'Category', 'Amount', 'Paid_With', 'Note'] },
    Purchases: { rows: st.purchases, head: ['Purchase_ID', 'Date', 'Account_ID', 'Paid_With', 'Amount', 'Covers_Until', 'Notes'] },
    Accounts: { rows: st.accounts, head: ['Account_ID', 'Product_ID', 'Account_Label', 'Cycle_Cost', 'Renewal_Date', 'Slots', 'Account_Status', 'Notes'] },
    Products: { rows: st.products, head: ['Product_ID', 'Product_Name', 'Category', 'Billing_Cycle_Days', 'Default_Price', 'Letter', 'Active'] },
    Codes: { rows: st.codes, head: ['Code_ID', 'Product_ID', 'Code', 'Status'] },
    Wallets: { rows: st.wallets, head: ['Wallet_ID', 'Label'] }
  };
  var files = {};
  Object.keys(tables).forEach(function (name) {
    files[name + '.csv'] = Core.exporter.toCsv(tables[name].rows, tables[name].head);
  });
  return { message: 'Exported', files: files };
}

// Snapshot of last month's profit if due, and a rate refresh when the cached rate is stale and not manual. Each runs at most once per call and
// a failure of either never fails init. -> { snapshot: { month, created }, rate: { refreshed } }
async function housekeeping_(db, st) {
  var snapshot = { month: '', created: false }, rate = { refreshed: false };
  try {
    var s = await WRITES_.snapshotIfDue(db, st, {});
    if (s && s.ok && s.data) snapshot = { month: s.data.month, created: s.data.created === true };
  } catch (e) { console.error('init snapshot failed:', e && e.message); }
  try {
    var cur = Core.rates.resolveRate(st);
    if (cur.source !== 'manual' && cur.stale) {
      var r = await WRITES_.refreshRate(db, st, {});
      rate.refreshed = !!(r && r.ok);
    }
  } catch (e) { console.error('init rate refresh failed:', e && e.message); }
  return { snapshot: snapshot, rate: rate };
}

// who = { role, actor, email } from authenticate_. The role rules are in src/core/permissions.js; a call without a who is refused.
// Every answer passes the role's redaction (Core.permissions.redactFor), so money fields never reach a non-owner, reads or write replies.
async function api(action, payload, db, who) {
  var r = await apiInner_(action, payload, db, who);
  if (r && r.ok && r.data !== undefined && who) r.data = Core.permissions.redactFor(who.role, action, r.data);
  return r;
}
async function apiInner_(action, payload, db, who) {
  payload = payload || {};
  try {
    if (!who || !Core.permissions.canDo(who.role, action)) return { ok: false, error: 'Your role cannot do that.', code: 'forbidden' };
    if (action === 'me') return { ok: true, data: { role: who.role, email: who.email || '', actor: who.actor || '' } };
    // Owner reads of the public API tables and the webhook sender need no state and must not hold the write lock during network calls.
    if (OUTSIDE_LOCK_[action]) return await OUTSIDE_LOCK_[action](db, payload, who);
    if (READS_[action]) {
      // init and home carry a version. It is read BEFORE the state, so a write landing in between leaves the version older than the
      // data (the next read refetches), never newer (which would cache stale data under a fresh version).
      var versioned = VERSIONED_[action] === true, version = '';
      if (versioned) {
        version = await Adapter.readVersion(db, { today: today_(), nowMs: Date.now(), freshMs: Core.rates.FRESH_MS });
        if (payload.ifNone && payload.ifNone === version) return { ok: true, data: { notModified: true, version: version } };
      }
      var st = await Adapter.readState(db, today_(), NEEDS_[action]);
      var hk = null;
      if (action === 'init') {
        // init does the once-per-load housekeeping itself, so the panel makes one call. A rate refresh changes live_rates, which the version
        // covers: read the version again, THEN the state, so the answer carries the post-refresh version and its data (a write racing in
        // between leaves the version older than the data, never newer).
        hk = await housekeeping_(db, st);
        if (hk.rate.refreshed) {
          version = await Adapter.readVersion(db, { today: today_(), nowMs: Date.now(), freshMs: Core.rates.FRESH_MS });
          st = await Adapter.readState(db, today_(), NEEDS_[action]);
        }
      }
      var out = await READS_[action](db, st, payload);
      if (action === 'init') out.me = { role: who.role, email: who.email || '' };
      if (hk) out.housekeeping = hk;
      if (versioned) out.version = version;
      return { ok: true, data: out };
    }
    if (!WRITES_[action]) return { ok: false, error: 'Unknown action ' + action };
    // A client may not choose the clock or the id generator for any write.
    payload = Object.assign({}, payload); delete payload.nowMs; delete payload._gen; delete payload._rand;
    // The caller's role comes from the sign-in only (owner for the panel password); a client-sent _role is overwritten. Core planEdit reads it.
    payload._role = who.role;
    var requestId = payload.requestId || null;
    // One writer at a time: read, plan, apply and the request log commit together, so two quick taps cannot
    // hand out the same ID, and a repeated requestId sees the first call's saved response.
    return await locked_(db, async function (tx) {
      if (requestId) {
        var ex = await tx.query('SELECT response FROM request_log WHERE request_id = $1', [requestId]);
        if (ex.rows && ex.rows[0] && ex.rows[0].response && ex.rows[0].response !== '{}') {
          // The stored reply carries who asked for what (_req). A reused id for another action or another caller is refused, not
          // answered with someone else's reply. Rows written before this have no _req and replay as before.
          var prior = JSON.parse(ex.rows[0].response), seen = prior && prior._req;
          // A row without _req cannot be tied to a caller, so only the owner may replay it.
          if (!seen && who.role !== 'owner') return { ok: false, error: 'Request id already used for another action.' };
          if (seen && (seen.action !== action || seen.actor !== (who.actor || '') || seen.role !== (who.role || ''))) {
            return { ok: false, error: 'Request id already used for another action.' };
          }
          if (seen) delete prior._req;
          return prior;
        }
      }
      var st2 = await Adapter.readState(tx, today_(), NEEDS_[action]);
      var resp = await WRITES_[action](tx, st2, payload);
      if (requestId && resp.ok) {
        // A replay answers from request_log, so a one-time secret (an API key, a webhook signing secret) is kept out of it: a replay
        // says the item exists without repeating the secret.
        var stored = JSON.parse(JSON.stringify(resp));
        stored._req = { action: action, actor: who.actor || '', role: who.role || '' };
        if (SECRET_FIELD_[action] && stored.data) delete stored.data[SECRET_FIELD_[action]];
        await tx.query('INSERT INTO request_log (request_id, response) VALUES ($1, $2) ON CONFLICT (request_id) DO NOTHING',
          [requestId, JSON.stringify(stored)]);
      }
      return resp;
    }, who.actor);
  } catch (err) {
    // A database error (it carries a Postgres code) goes to the log, not to the panel.
    if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
      console.error('api ' + action + ' failed:', err.code, err.message);
      return { ok: false, error: 'Could not save. Nothing was changed. Try again.' };
    }
    // A bug (not a rule such as "Unknown customer") also stays in the log.
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError) {
      console.error('api ' + action + ' crashed:', err && err.stack);
      return { ok: false, error: 'Something went wrong. Nothing was changed.' };
    }
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---- relay (ported from reference_PaymentRelay_v9.gs) -------------------------
// Same contract the iPhone uses today: POST /relay?src=bkash  { token, sender, text }.
var RELAY_BLOCK = /\b(otp|pin|password|passcode|do not share|don'?t share)\b/i;
var RELAY_SOURCES = { bkash: { method: 'bKash', sender: '16247' }, upay: { method: 'Upay', sender: '16268' }, nagad: { method: 'Nagad', sender: '16167' } };

function nowDhaka_() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date()).replace(', ', ' ');
}

function resolveSource_(tag, sender, text) {
  var t = String(tag).toLowerCase();
  if (RELAY_SOURCES[t]) return RELAY_SOURCES[t];
  var x = String(sender);
  if (/16247|bkash/i.test(x)) return RELAY_SOURCES.bkash;
  if (/16268|upay/i.test(x)) return RELAY_SOURCES.upay;
  if (/16167|nagad/i.test(x)) return RELAY_SOURCES.nagad;
  if (/nagad/i.test(String(text))) return RELAY_SOURCES.nagad;
  return { method: '', sender: '' };
}

function parseSms_(text) {
  var out = { type: '', amount: '', trxId: '', counterparty: '', reference: '', skip: '' };
  var trx = text.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[\s:.#-]*([A-Z0-9]{6,20})/i);
  out.trxId = trx ? trx[1].toUpperCase() : '';
  var amt = text.match(/(?:Tk\.?|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.amount = amt ? Number(amt[1].replace(/,/g, '')) : '';
  if (/incentive/i.test(text)) { out.skip = 'government incentive (not a sale)'; return out; }
  if (/fund transfer successful/i.test(text)) { out.skip = 'outgoing transfer'; return out; }
  if (!out.trxId && !/received/i.test(text)) { out.skip = 'no TrxID (notice, not a payment)'; return out; }
  if (/remittance/i.test(text)) out.type = 'Remittance';
  else if (/you have received|has been received|money received|cash in/i.test(text)) out.type = Core.matching.isTopUpSms(text) ? 'TopUp' : 'Received';
  else if (/sent|send money|cash out|payment|paid|bill|recharge/i.test(text)) { out.skip = 'outgoing or other transaction'; return out; }
  else out.type = 'Unrecognised';
  // Nagad cash-in names the agent (Uddokta): that number is the counterparty. Otherwise the sender.
  var from = text.match(/Uddokta:?\s*(\+?8801\d{9}|01\d{9})/i) || text.match(/(?:from|sender:?)\s*(\+?8801\d{9}|01\d{9})/i);
  out.counterparty = from ? from[1] : '';
  // Same line only ([ \t]), so an empty `Ref:` does not swallow the next line. `N/A` means no reference.
  var ref = text.match(/\b(?:Reference|Ref|Comments?)\b\.?[ \t]*:?[ \t]*([^.\n:][^.\n]*?)[ \t]*(?:\.|\n|$)/i);
  out.reference = ref && !/^n\/?a$/i.test(ref[1].trim()) ? ref[1].trim() : '';
  return out;
}

// The phone's "I am alive" ping: text "heartbeat" stores the time instead of an inbox row. No change_log entry, like the other
// operational writes (the version token still moves, because the settings hash covers it).
async function relayHeartbeat_() {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    ['relay_heartbeat', new Date().toISOString()]);
  return { ok: true, result: 'heartbeat' };
}

async function relayIngest(body, src) {
  var text = String(body.text || '').trim();
  var sender = String(body.sender || '').trim();
  if (!text) return { ok: false, error: 'empty message' };
  if (text.toLowerCase() === 'heartbeat') return relayHeartbeat_();
  if (RELAY_BLOCK.test(text)) return { ok: true, result: 'dropped: sensitive keyword' };
  var s = resolveSource_(src, sender, text);
  var p = parseSms_(text);
  if (p.skip) return { ok: true, result: 'skipped: ' + p.skip };
  // Check and insert under the write lock so two copies of one SMS cannot both pass the check.
  var dupResult = null;
  try {
    dupResult = await locked_(db, async function (tx) {
      if (p.trxId) {
        var dup = await tx.query('SELECT 1 FROM payment_inbox WHERE transaction_id = $1 LIMIT 1', [p.trxId]);
        if (dup.rows.length) return 'duplicate ' + p.trxId;
      } else {
        var dup2 = await tx.query("SELECT 1 FROM payment_inbox WHERE raw_sms = $1 AND transaction_id = '' LIMIT 1", [text]);
        if (dup2.rows.length) return 'duplicate message';
      }
      await tx.query('INSERT INTO payment_inbox (received, type, method, sender, amount, transaction_id, counterparty, reference, status, raw_sms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [nowDhaka_(), p.type, s.method, sender || s.sender, p.amount || 0, p.trxId, p.counterparty, p.reference,
         p.type === 'Unrecognised' ? 'Review' : 'Pending', text]);
      return null;
    });
  } catch (e) {
    // The unique index on transaction_id is the last guard: a duplicate that still got through is not an error.
    if (p.trxId && /duplicate key|unique/i.test(String((e && e.message) || e))) dupResult = 'duplicate ' + p.trxId;
    else return { ok: false, error: 'Could not store the message: ' + String((e && e.message) || e) };
  }
  if (dupResult) return { ok: true, result: dupResult };
  var out = { ok: true, result: 'stored', type: p.type, trxId: p.trxId, amount: p.amount, matched: false };
  if (p.type !== 'Unrecognised' && p.type !== 'TopUp' && p.trxId) {
    var auto = await autoMatch_(p.trxId);
    out.matched = auto.matched;
    if (auto.note) out.autoNote = auto.note;
  }
  return out;
}

/**
 * Match a freshly stored, Pending inbox row to a sale with the same planner the panel uses. Only runs for rows that reached
 * relayIngest through the verified-token route. Anything unclear leaves the row Pending for the owner. The action name starts
 * with "auto" so Undo skips it, as for the other automatic payments.
 */
async function autoMatch_(trx) {
  try {
    return await locked_(db, async function (tx) {
      var st = await sweepExpired_(tx, await Adapter.readState(tx, today_()));
      var row = null;
      (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID).toUpperCase() === String(trx).toUpperCase()) row = r; });
      if (!row || row.Status !== 'Pending') return { matched: false, note: 'Not pending.' };
      var plan = Core.matching.planInboxMatch(st, row);
      if (plan.errors && plan.errors.length) return { matched: false, note: plan.errors[0] };
      // A duplicate books no money, so the amount cap does not apply: it is settled before the cap check.
      if (plan.status === 'duplicate') {
        await Adapter.applyOps(tx, plan.ops, { batchId: batchId_(), action: 'autoMatch', log: true });
        return { matched: false, note: (plan.result && plan.result.note) || 'Already recorded.' };
      }
      if (plan.status !== 'auto') return { matched: false, note: (plan.result && plan.result.note) || 'Left for manual matching.' };
      var over = Core.matching.capNote(st, row);
      if (over) return { matched: false, note: over };
      await Adapter.applyOps(tx, plan.ops, { batchId: batchId_(), action: 'autoMatch', log: true });
      return { matched: true, note: plan.result && plan.result.note };
    });
  } catch (e) {
    return { matched: false, note: 'Auto-match failed: ' + String((e && e.message) || e) };
  }
}

// ---- customer pay page (page markup lives in pay-page.js) -----------------------

/**
 * Newest sale of the line that owns this pay token, plus what the page shows, or null. Sub codes are never accepted here.
 * This route is public and polled, so it reads only the rows it needs, never whole tables.
 */
async function payContext_(token, withPage) {
  var t = String(token || '');
  if (t.length < 16) return null;
  var sale = null;
  (await Adapter.readTabWhere(db, 'Sales_Log', 'Pay_Token', t)).forEach(function (s) {
    if (!sale || Number(s.Sale_ID) > Number(sale.Sale_ID)) sale = s;
  });
  if (!sale) return payRequestContext_(t, withPage);
  var product = (await Adapter.readTabWhere(db, 'Product_Catalog', 'Product_ID', sale.Product_ID))[0] || {};
  var intentRow = (await Adapter.readTabWhere(db, 'Pay_Intents', 'Token', t))[0] || null;
  var price = Core.ledger.salePrice(sale, [product]) || Number(product.Default_Price) || 0;
  var seen = {}, inbox = [];
  var take = function (rows) { rows.forEach(function (r) { var k = r.Transaction_ID || r.Raw_SMS; if (!seen[k]) { seen[k] = true; inbox.push(r); } }); };
  take(await Adapter.readTabWhere(db, 'Payment_Inbox', 'Reference', String(sale.Sub_Code), true));
  if (intentRow) {
    var forms = Core.paylinks.numberForms(intentRow.Payer_Number);
    for (var i = 0; i < forms.length; i++) take(await Adapter.readTabWhere(db, 'Payment_Inbox', 'Counterparty', forms[i]));
  }
  var recorded = (await Adapter.readTabWhere(db, 'Payments', 'Sale_ID', Number(sale.Sale_ID)));
  if (intentRow && intentRow.Claim_Trx) recorded = recorded.concat(await Adapter.readTabWhere(db, 'Payments', 'Transaction_ID', intentRow.Claim_Trx, true));
  var status = Core.paylinks.orderStatus(sale.Sub_Code, price, intentRow, inbox, recorded);
  // After a renewal the line's newest sale carries the new end date.
  var ctx = { sale: sale, product: product, price: price, intentRow: intentRow, status: status, until: sale.Paid_Till || '' };
  if (withPage) {
    ctx.customer = (await Adapter.readTabWhere(db, 'Customers', 'Customer_ID', sale.Customer_ID))[0] || null;
    ctx.settings = await Adapter.readSettings(db);
  }
  return ctx;
}

/** The same context for a pay request token (a link made before there is a sale), or null. Reads only this request's rows. */
async function payRequestContext_(t, withPage) {
  var rq = (await Adapter.readTabWhere(db, 'Pay_Requests', 'Token', t))[0];
  if (!rq) return null;
  var intentRow = (await Adapter.readTabWhere(db, 'Pay_Intents', 'Token', t))[0] || null;
  var seen = {}, inbox = [];
  var take = function (rows) { rows.forEach(function (r) { var k = r.Transaction_ID || r.Raw_SMS; if (!seen[k]) { seen[k] = true; inbox.push(r); } }); };
  take(await Adapter.readTabWhere(db, 'Payment_Inbox', 'Reference', String(rq.Request_ID), true));
  if (rq.Ref) take(await Adapter.readTabWhere(db, 'Payment_Inbox', 'Reference', String(rq.Ref), true));
  if (intentRow) {
    var forms = Core.paylinks.numberForms(intentRow.Payer_Number);
    for (var i = 0; i < forms.length; i++) take(await Adapter.readTabWhere(db, 'Payment_Inbox', 'Counterparty', forms[i]));
  }
  var payments = rq.Sale_ID === '' || rq.Sale_ID === null || rq.Sale_ID === undefined ? [] : await Adapter.readTabWhere(db, 'Payments', 'Sale_ID', Number(rq.Sale_ID));
  var base = Core.paylinks.requestStatus({ payIntents: intentRow ? [intentRow] : [], payments: payments, inbox: inbox }, rq);
  var stage = requestStage_(rq, base, Date.now());
  var status = { stage: stage, paid: base.paid || rq.Status === 'Paid', rows: base.rows, method: base.method };
  var ctx = { request: rq, sale: null, product: { Product_Name: rq.Title }, price: Number(rq.Amount) || 0, intentRow: intentRow, status: status, until: '' };
  if (withPage) {
    ctx.customer = { Name: rq.Customer_Name || '' };
    ctx.settings = await Adapter.readSettings(db);
  }
  return ctx;
}

/**
 * What the receipt route may show for a Paid request, or null when the request is not Paid. The planner's receipt: order lines, tos and
 * https links always, and `code` only when a live code exists (not for a Failed delivery, a void sale or a resold code).
 * delivery is 'delivered' (any delivery whose Status is Delivered), 'pending' (Pending or Ready), 'failed' or '' (none).
 */
async function requestReceipt_(ctx) {
  var rq = ctx.request;
  if (!rq || rq.Status !== 'Paid') return null;
  var deliveries = await Adapter.readTabWhere(db, 'Deliveries', 'Request_ID', rq.Request_ID);
  var d = deliveries[0] || null;
  var sales = d && d.Sale_ID !== '' ? await Adapter.readTabWhere(db, 'Sales_Log', 'Sale_ID', Number(d.Sale_ID)) : [];
  var codes = d && d.Code_ID ? await Adapter.readTabWhere(db, 'Code_Inventory', 'Code_ID', d.Code_ID) : [];
  var receipt = Core.delivery.receipt({ settings: await Adapter.readSettings(db), deliveries: deliveries, sales: sales, codes: codes }, rq);
  var delivery = '';
  if (d) delivery = d.Status === 'Failed' ? 'failed' : d.Status === 'Delivered' ? 'delivered' : 'pending';
  return { receipt: receipt, delivery: delivery };
}

function payIntentView_(row) {
  return row ? { method: row.Method, number: row.Payer_Number, claimed: row.Claimed === 'Yes', trx: row.Claim_Trx || '' } : null;
}

async function payPage_(token) {
  var ctx = await payContext_(token, true);
  if (!ctx) return null;
  var cfg = ctx.settings;
  var status = { stage: ctx.status.stage, rows: ctx.status.rows, delivery: '' };
  if (ctx.request) { var rc = await requestReceipt_(ctx); status.delivery = rc ? rc.delivery : ''; }
  return payHtml_({ lang: cfg.language === 'bn' ? 'bn' : 'en', title: ctx.product.Product_Name || (ctx.sale ? ctx.sale.Product_ID : ''), customerName: ctx.customer ? ctx.customer.Name : '',
    kind: ctx.request ? 'request' : 'sale', ref: ctx.request ? Core.paylinks.requestRef(ctx.request) : ctx.sale.Sub_Code, amount: ctx.price, methods: Core.paylinks.methods(cfg), intent: payIntentView_(ctx.intentRow),
    status: status, until: ctx.until, expires: ctx.request ? String(ctx.request.Expires || '') : '', now: Date.now() });
}

/** Short hash of each status row's amount, date and status (rows carry no code), so an edit that keeps the count still changes the ETag. */
function rowsTag_(rows) {
  var s = (rows || []).map(function (r) { return r.amount + '|' + r.date + '|' + r.status; }).join(';'), h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function payStatus(token) {
  var ctx = await payContext_(token, false);
  if (!ctx) return null;
  var out = { ok: true, paid: ctx.status.paid, stage: ctx.status.stage, rows: ctx.status.rows, until: ctx.until, method: ctx.status.method };
  // Only how delivery stands; the code itself is served by /receipt.
  if (ctx.request) {
    var rc = await requestReceipt_(ctx);
    out.delivery = rc ? rc.delivery : '';
    if (rc && rc.delivery === 'delivered') out.delivered = true;
  }
  return out;
}

/** The customer picked a method and gave their number, or said they paid. One row per token, replaced each time. */
async function payIntent_(token, body) {
  var ctx = await payContext_(token, true);
  if (!ctx) return { status: 404, body: { ok: false, error: 'Payment link not found.' } };
  if (ctx.request && ctx.request.Status !== 'Open') return { status: 400, body: { ok: false, error: 'This payment link is closed.' } };
  if (ctx.request && ctx.status.stage === 'expired') return { status: 400, body: { ok: false, error: 'This payment link has expired.' } };
  var plan = Core.paylinks.planIntent(ctx.settings, body || {});
  if (plan.error) return { status: 400, body: { ok: false, error: plan.error } };
  var v = plan.values, now = nowDhaka_();
  await db.query('INSERT INTO pay_intents (token, method, payer_number, claim_trx, claimed, created, updated) VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
    'ON CONFLICT (token) DO UPDATE SET method = EXCLUDED.method, payer_number = EXCLUDED.payer_number, claim_trx = EXCLUDED.claim_trx, claimed = EXCLUDED.claimed, updated = EXCLUDED.updated',
    [String(token), v.Method, v.Payer_Number, v.Claim_Trx, v.Claimed, now, now]);
  var fresh = await payContext_(token, false);
  return { status: 200, body: { ok: true, intent: payIntentView_(fresh.intentRow), status: { stage: fresh.status.stage, rows: fresh.status.rows }, until: fresh.until } };
}

// ---- customer portal (page markup lives in portal-page.js) -----------------------
var PORTAL_LIMIT_PER_MIN_ = 30;
/**
 * GET /portal/<pay token>: the customer's active subscriptions, what they owe, next renewal and payment history. The token picks
 * one sale, and only that sale's customer is read: no other customer, no cost fields. Counted per client per minute like the API.
 */
async function portalPage_(req, token) {
  var now = Date.now();
  var hits = await Adapter.bumpRateLimit(db, 'portal:' + clientKey_(req), windowIso_(now));
  var headers = { 'Cache-Control': 'no-store' };
  if (Core.publicapi.overLimit(hits, PORTAL_LIMIT_PER_MIN_)) {
    return new Response('Too many requests. Wait a minute and try again.', { status: 429, headers: Object.assign({ 'Retry-After': String(Core.publicapi.retryAfterSeconds(now)) }, headers) });
  }
  var t = String(token || '');
  var sales = t.length >= 16 ? await Adapter.readTabWhere(db, 'Sales_Log', 'Pay_Token', t) : [];
  var notFound = function () { return new Response('Payment link not found.', { status: 404, headers: headers }); };
  if (!sales.length) return notFound();
  var sale = sales.reduce(function (a, b) { return Number(b.Sale_ID) > Number(a.Sale_ID) ? b : a; });
  var st = await Adapter.readState(db, today_(), NEEDS_.customer);
  var cd = Core.views.customerData(st, sale.Customer_ID);
  if (!cd) return notFound();
  var base = String(st.settings.pay_base_url || '').replace(/\/+$/, '');
  var payUrlFor = function (tok) { return base && tok ? base + '/pay/' + encodeURIComponent(tok) : ''; };
  var lines = cd.lines.map(function (l) {
    return { product: l.productName, paidTill: l.paidTill, daysLeft: l.daysLeft, owes: l.owes, payUrl: payUrlFor(l.owes > 0 ? l.payToken : '') };
  });
  var owing = lines.filter(function (l) { return l.owes > 0; })[0];
  var bkash = String(st.settings.bkash_number || '').replace(/\D/g, '');
  var html = portalHtml_({ lang: st.settings.language === 'bn' ? 'bn' : 'en', customerName: cd.customer.Name || '', lines: lines, owes: cd.owes,
    payments: cd.payments.slice(0, 20).map(function (p) { return { date: p.date, amount: p.amount, method: p.method }; }),
    payUrl: owing ? owing.payUrl : payUrlFor(t), receiverName: String(st.settings.bkash_account_name || '').trim(),
    receiverLast4: bkash.length >= 4 ? bkash.slice(-4) : '' });
  return new Response(html, { headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PORTAL_CSP_,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }, headers) });
}

// Failed sign-ins per client, kept in this isolate's memory: a brake on guessing, not a guarantee (a cold start resets it).
var AUTH_FAILS_ = {};
var AUTH_MAX_FAILS_ = 10;
var AUTH_WINDOW_MS_ = 60000;
function clientKey_(req) {
  // Not the first x-forwarded-for entry: a client can write that one. cf-connecting-ip is set by the platform edge,
  // and the last forwarded entry is the one the nearest proxy appended.
  var cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  var xff = String(req.headers.get('x-forwarded-for') || '').split(',');
  return xff[xff.length - 1].trim() || 'unknown';
}
function authBlocked_(req) {
  var f = AUTH_FAILS_[clientKey_(req)];
  return !!f && Date.now() - f.since < AUTH_WINDOW_MS_ && f.n >= AUTH_MAX_FAILS_;
}
function authFailed_(req) {
  var k = clientKey_(req), now = Date.now(), f = AUTH_FAILS_[k];
  if (!f || now - f.since >= AUTH_WINDOW_MS_) {
    var keys = Object.keys(AUTH_FAILS_);
    if (keys.length > 500) keys.forEach(function (x) { if (now - AUTH_FAILS_[x].since >= AUTH_WINDOW_MS_) delete AUTH_FAILS_[x]; });
    AUTH_FAILS_[k] = f = { n: 0, since: now };
  }
  f.n++;
}

// ---- public API v1 (/v1/...) ------------------------------------------------
// Website and integration routes. Each request, in order: a per-IP limit (before any key check, so guessing keys is slowed too), a
// Bearer key, the Origin when a browser sends one (it must be one the key lists), the key's scope, a per-key limit, then the route.
// The rules are in Core.publicapi; this part wires them to the database. Errors are JSON { ok: false, code, error } with stable codes.
var V1_CATALOG_TABLES_ = ['Product_Catalog', 'Sales_Log', 'Code_Inventory', 'Accounts'];
var V1_TOUCH_MS_ = 60000;
// Owner reads of the public API tables, and the webhook sender. They read no state and hold no write lock (a send can take seconds).
var OUTSIDE_LOCK_ = {};
// Runs outside the write lock: the Auth call is a network call. Validate, invite (or link an existing login), then insert the row under the lock.
OUTSIDE_LOCK_.staffInvite = async function (db, p, who) {
  var email = String(p.email || '').trim().toLowerCase();
  var role = String(p.role || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (INVITE_ROLES_.indexOf(role) < 0) return { ok: false, error: 'Role must be staff or viewer.' };
  var listed = await Adapter.readStaff(db);
  if (listed.some(function (m) { return String(m.email || '').toLowerCase() === email; })) return { ok: false, error: 'That login is already on the staff list.' };
  var linked = await inviteUser_(email);
  return locked_(db, async function (tx) {
    if (await Adapter.readStaffMember(tx, linked.id)) return { ok: false, error: 'That login is already on the staff list.' };
    await Adapter.insertStaff(tx, { userId: linked.id, email: email, role: role, active: true });
    await Adapter.logAudit(tx, 'staff:invite', [{ tab: 'Staff', rowKey: linked.id, field: 'role', old: '', new: role }]);
    return { ok: true, data: { message: linked.existing ? email + ' already had a login and is now on the staff list' : 'Invite sent to ' + email } };
  }, who && who.actor);
};
// ---- login details vault -----------------------------------------------------
// Logins handed to customers are kept as AES-GCM ciphertext (vault.js). These actions never go through request_log (a replay would store
// the revealed text) and never write the text to change_log. Every PIN check counts failures per actor: 5 wrong PINs lock that actor for 15 minutes.
// Failures are counted in a sliding window: 1-minute buckets, summed over the last 15 minutes per actor (5 lock that actor for 15 minutes)
// and over the last hour across all actors (20 lock every reveal for an hour), so waiting for a window edge does not reset the count.
var VAULT_FAIL_MAX_ = 5, VAULT_LOCK_MS_ = 15 * 60000, VAULT_BUCKET_MS_ = 60000, VAULT_GLOBAL_MAX_ = 20, VAULT_GLOBAL_WINDOW_MS_ = 60 * 60000, VAULT_GLOBAL_LOCK_MS_ = 60 * 60000;
var VAULT_NOT_CONFIGURED_ERR_ = { ok: false, error: VAULT_NOT_CONFIGURED_, code: 'vault_not_configured' };
var VAULT_ID_RE_ = /^[A-Za-z0-9:_-]{1,64}$/;
function vaultAudit_(tx, action, secretId, note) {
  return Adapter.logAudit(tx, action, [{ tab: 'Account_Secrets', rowKey: String(secretId), field: 'secret', old: '', new: note || '' }]);
}
// Returns null when the PIN is right, else the refusal to send. Runs inside the caller's transaction: a wrong PIN returns (not throws), so the failure count commits.
async function vaultCheckPin_(tx, who, pin) {
  var actor = (who && who.actor) || 'unknown', nowMs = Date.now();
  var gUntil = await Adapter.vaultLockedUntil(tx, '*', new Date(nowMs).toISOString());
  if (gUntil) return { ok: false, error: 'Too many wrong PINs across the team. Login details are locked for ' + Math.max(1, Math.ceil((Date.parse(gUntil) - nowMs) / 60000)) + ' more minutes.', code: 'vault_locked' };
  var until = await Adapter.vaultLockedUntil(tx, actor, new Date(nowMs).toISOString());
  if (until) return { ok: false, error: 'Too many wrong PINs. Try again in ' + Math.max(1, Math.ceil((Date.parse(until) - nowMs) / 60000)) + ' minutes.', code: 'vault_locked' };
  var hash = await Adapter.readVaultPinHash(tx);
  if (!hash) return { ok: false, error: 'Set a vault PIN first (owner: More, Vault PIN).', code: 'vault_no_pin' };
  if (pinValid_(pin) && await pinVerify_(pin, hash)) return null;
  var win = new Date(Math.floor(nowMs / VAULT_BUCKET_MS_) * VAULT_BUCKET_MS_).toISOString();
  await Adapter.bumpRateLimit(tx, 'vaultfail:' + actor, win);
  var n = await Adapter.vaultFailCount(tx, 'vaultfail:' + actor, new Date(Math.floor((nowMs - VAULT_LOCK_MS_) / VAULT_BUCKET_MS_) * VAULT_BUCKET_MS_).toISOString());
  await vaultAudit_(tx, 'vault:pin-fail', actor, 'attempt ' + n);
  var g = await Adapter.vaultFailCount(tx, '*', new Date(Math.floor((nowMs - VAULT_GLOBAL_WINDOW_MS_) / VAULT_BUCKET_MS_) * VAULT_BUCKET_MS_).toISOString());
  if (g >= VAULT_GLOBAL_MAX_) {
    await Adapter.vaultSetLock(tx, '*', new Date(nowMs + VAULT_GLOBAL_LOCK_MS_).toISOString());
    return { ok: false, error: 'Too many wrong PINs across the team. Login details are locked for an hour.', code: 'vault_locked' };
  }
  if (n >= VAULT_FAIL_MAX_) {
    await Adapter.vaultSetLock(tx, actor, new Date(nowMs + VAULT_LOCK_MS_).toISOString());
    return { ok: false, error: 'Too many wrong PINs. Try again in 15 minutes.', code: 'vault_locked' };
  }
  return { ok: false, error: 'Wrong PIN.', code: 'vault_pin' };
}
// A saved login is linked to a sale by id AND by the sale's token (Pay_Token, else Sub_Code, kept when the link is made). A sale id can be reused
// after an Undo, so a login whose token does not match the sale now carrying that id is ignored.
function saleToken_(sale) { return String((sale && (sale.Pay_Token || sale.Sub_Code)) || ''); }
function secretFitsSale_(secret, sale) {
  var t = String(secret.sale_token || '');
  return !!sale && !!t && (t === String(sale.Pay_Token || '') || t === String(sale.Sub_Code || ''));
}
async function saleById_(db, id) {
  var n = Number(id);
  if (!isFinite(n) || String(id).trim() === '') return null;
  return (await Adapter.readTabWhere(db, 'Sales_Log', 'Sale_ID', n))[0] || null;
}
// Reads: labels and links only, never ciphertext. Filters: accountId and/or saleId (a row matches either).
OUTSIDE_LOCK_.vaultList = async function (db, p) {
  var rows = await Adapter.vaultListSecrets(db);
  var a = p.accountId ? String(p.accountId) : '', s = p.saleId ? String(p.saleId) : '';
  var sale = s ? await saleById_(db, s) : null;
  if (a || s) rows = rows.filter(function (r) { return (a && String(r.account_id) === a) || (s && String(r.sale_id) === s && secretFitsSale_(r, sale)); });
  return { ok: true, data: { configured: vaultConfigured_(), pinSet: !!(await Adapter.readVaultPinHash(db)),
    secrets: rows.map(function (r) { return { secretId: r.secret_id, accountId: r.account_id, saleId: r.sale_id, label: r.label, created: r.created }; }) } };
};
// vaultSave { secretId?, accountId | saleId, label, text, pin, requestId? }. A given secretId updates that entry; a repeated requestId adds nothing twice.
OUTSIDE_LOCK_.vaultSave = async function (db, p, who) {
  if (!vaultConfigured_()) return VAULT_NOT_CONFIGURED_ERR_;
  var label = String(p.label == null ? '' : p.label).trim(), text = typeof p.text === 'string' ? p.text : '';
  if (!label || label.length > 100) return { ok: false, error: 'Give the login a label (up to 100 characters).' };
  if (!text.trim() || text.length > 5000) return { ok: false, error: 'Enter the login details (up to 5000 characters).' };
  var explicit = !!p.secretId;
  if (explicit && !VAULT_ID_RE_.test(String(p.secretId))) return { ok: false, error: 'Invalid secret id.' };
  var rid = String(p.requestId || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 56);
  var secretId = explicit ? String(p.secretId) : (rid ? 'sec-' + rid : 'sec-' + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(9)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''));
  return locked_(db, async function (tx) {
    var refusal = await vaultCheckPin_(tx, who, p.pin);
    if (refusal) return refusal;
    var cur = await Adapter.vaultGetSecret(tx, secretId), now = new Date().toISOString();
    if (cur && !explicit) return { ok: true, data: { secretId: secretId, message: 'Saved' } };
    // Staff may add logins; only the owner may overwrite one that exists.
    if (cur && (!who || who.role !== 'owner')) return { ok: false, error: 'Only the owner can change saved login details.' };
    if (!cur && !p.accountId && !p.saleId) return { ok: false, error: 'Pick the account or sale these details belong to.' };
    var linkSale = null;
    if (!cur) {
      if (p.accountId && !(await Adapter.readTabWhere(tx, 'Accounts', 'Account_ID', String(p.accountId)))[0]) return { ok: false, error: 'Unknown account.' };
      if (p.saleId) {
        linkSale = await saleById_(tx, p.saleId);
        if (!linkSale) return { ok: false, error: 'Unknown sale.' };
        if (!saleToken_(linkSale)) return { ok: false, error: 'This sale has no payment token yet, so login details cannot be linked to it.' };
      }
    }
    var enc = await vaultEncrypt_(text, secretId);
    if (cur) {
      await Adapter.vaultUpdateSecret(tx, { secretId: secretId, label: label, ciphertext: enc.ciphertext, iv: enc.iv, updated: now });
      await vaultAudit_(tx, 'vault:update', secretId, label);
    } else {
      await Adapter.vaultInsertSecret(tx, { secretId: secretId, accountId: String(p.accountId || ''), saleId: String(p.saleId || ''), saleToken: saleToken_(linkSale), label: label,
        ciphertext: enc.ciphertext, iv: enc.iv, created: now, updated: now }, 'nothing');
      await vaultAudit_(tx, 'vault:add', secretId, label);
    }
    return { ok: true, data: { secretId: secretId, message: 'Saved' } };
  }, who && who.actor);
};
// vaultReveal { secretId, pin } -> { secretId, label, text }. Not logged to request_log; the HTTP answer is Cache-Control: no-store.
OUTSIDE_LOCK_.vaultReveal = async function (db, p, who) {
  if (!vaultConfigured_()) return VAULT_NOT_CONFIGURED_ERR_;
  return locked_(db, async function (tx) {
    var refusal = await vaultCheckPin_(tx, who, p.pin);
    if (refusal) return refusal;
    var row = await Adapter.vaultGetSecret(tx, String(p.secretId || ''));
    if (!row) return { ok: false, error: 'Login details not found.' };
    if (row.sale_id && !secretFitsSale_(row, await saleById_(tx, row.sale_id))) return { ok: false, error: 'Login details not found.' };   // linked to a sale that is gone or reused
    var plain = await vaultDecrypt_(row.ciphertext, row.iv, row.secret_id);
    await vaultAudit_(tx, 'vault:reveal', row.secret_id, '');
    return { ok: true, data: { secretId: row.secret_id, label: row.label, text: plain } };
  }, who && who.actor);
};
// vaultDelete { secretId, pin }: owner only.
OUTSIDE_LOCK_.vaultDelete = async function (db, p, who) {
  return locked_(db, async function (tx) {
    var refusal = await vaultCheckPin_(tx, who, p.pin);
    if (refusal) return refusal;
    var row = await Adapter.vaultGetSecret(tx, String(p.secretId || ''));
    if (!row) return { ok: false, error: 'Login details not found.' };
    await Adapter.vaultDeleteSecret(tx, row.secret_id);
    await vaultAudit_(tx, 'vault:delete', row.secret_id, row.label);
    return { ok: true, data: { message: 'Deleted' } };
  }, who && who.actor);
};
// vaultSetPin { newPin, currentPin? }: owner only. The first PIN needs no current one; a change does.
OUTSIDE_LOCK_.vaultSetPin = async function (db, p, who) {
  if (!pinNewValid_(p.newPin)) return { ok: false, error: 'The PIN must be 6 to 12 digits.' };
  return locked_(db, async function (tx) {
    var had = !!(await Adapter.readVaultPinHash(tx));
    if (had) {
      var refusal = await vaultCheckPin_(tx, who, p.currentPin);
      if (refusal) return refusal;
    }
    await Adapter.writeVaultPinHash(tx, await pinHash_(p.newPin));
    await vaultAudit_(tx, 'vault:pin-set', 'pin', had ? 'changed' : 'set');
    return { ok: true, data: { message: had ? 'PIN changed' : 'PIN set' } };
  }, who && who.actor);
};

// ---- delivery messages ----
// Templates are plain text with placeholders; only the owner writes them. A message is made on demand: the PIN is checked, {{login}} is
// decrypted from the sale's (or its account's) vault entry, and the text is returned once. Like vaultReveal it skips request_log and
// the audit line carries ids only.
OUTSIDE_LOCK_.deliveryTemplates = async function (db) {
  return { ok: true, data: { templates: await Adapter.listDeliveryTemplates(db), placeholders: Core.delivery.TEMPLATE_FIELDS } };
};
// deliveryTemplateSave { templateId?, productId?, accountId?, title, body, requestId? }
OUTSIDE_LOCK_.deliveryTemplateSave = async function (db, p, who) {
  var title = String(p.title == null ? '' : p.title).trim();
  if (!title || title.length > 100) return { ok: false, error: 'Give the template a title (up to 100 characters).' };
  var bad = Core.delivery.checkTemplate(p.body);
  if (bad) return { ok: false, error: bad };
  var explicit = !!p.templateId;
  if (explicit && !VAULT_ID_RE_.test(String(p.templateId))) return { ok: false, error: 'Invalid template id.' };
  var rid = String(p.requestId || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 56);
  var id = explicit ? String(p.templateId) : (rid ? 'tpl-' + rid : 'tpl-' + Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(6)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''));
  return locked_(db, async function (tx) {
    var cur = await Adapter.getDeliveryTemplate(tx, id);
    if (cur && !explicit) return { ok: true, data: { templateId: id, message: 'Saved' } };
    await Adapter.saveDeliveryTemplate(tx, { templateId: id, productId: String(p.productId || ''), accountId: String(p.accountId || ''), title: title, body: String(p.body), updated: new Date().toISOString() }, !cur);
    await Adapter.logAudit(tx, 'delivery:template', [{ tab: 'Delivery_Templates', rowKey: id, field: 'title', old: cur ? cur.title : '', new: title }]);
    return { ok: true, data: { templateId: id, message: 'Saved' } };
  }, who && who.actor);
};
OUTSIDE_LOCK_.deliveryTemplateDelete = async function (db, p, who) {
  return locked_(db, async function (tx) {
    var cur = await Adapter.getDeliveryTemplate(tx, String(p.templateId || ''));
    if (!cur) return { ok: false, error: 'Template not found.' };
    await Adapter.deleteDeliveryTemplate(tx, cur.templateId);
    await Adapter.logAudit(tx, 'delivery:template', [{ tab: 'Delivery_Templates', rowKey: cur.templateId, field: 'title', old: cur.title, new: '' }]);
    return { ok: true, data: { message: 'Deleted' } };
  }, who && who.actor);
};
// deliveryMessage { saleId, templateId, pin, secretId? } -> { text }
OUTSIDE_LOCK_.deliveryMessage = async function (db, p, who) {
  var tpl = await Adapter.getDeliveryTemplate(db, String(p.templateId || ''));
  if (!tpl) return { ok: false, error: 'Template not found.' };
  var needLogin = Core.delivery.usesLogin(tpl.body);
  if (needLogin && !vaultConfigured_()) return VAULT_NOT_CONFIGURED_ERR_;
  var sales = await Adapter.readTabWhere(db, 'Sales_Log', 'Sale_ID', Number(p.saleId));
  var sale = sales[0];
  if (!sale) return { ok: false, error: 'Sale not found.' };
  if ((tpl.productId && tpl.productId !== sale.Product_ID) || (tpl.accountId && tpl.accountId !== sale.Account_ID)) return { ok: false, error: 'That template is not for this sale.' };
  var prod = (await Adapter.readTabWhere(db, 'Product_Catalog', 'Product_ID', sale.Product_ID))[0];
  return locked_(db, async function (tx) {
    var refusal = await vaultCheckPin_(tx, who, p.pin);
    if (refusal) return refusal;
    var login = '';
    if (needLogin) {
      var rows = await Adapter.vaultListSecrets(tx), sid = String(sale.Sale_ID);
      // Only this sale's own logins (id and token both match) or its account's. Anything else, including a login of another sale, is ignored.
      var mine = rows.filter(function (r) { return (String(r.sale_id) === sid && secretFitsSale_(r, sale)) || (!r.sale_id && r.account_id && r.account_id === sale.Account_ID); });
      var pick = p.secretId ? mine.filter(function (r) { return r.secret_id === String(p.secretId); })[0] : null;
      if (!pick) pick = mine.filter(function (r) { return String(r.sale_id) === sid; })[0] || mine.filter(function (r) { return !r.sale_id; })[0];
      if (!pick) return { ok: false, error: 'No login details are saved for this sale or its account.' };
      var row = await Adapter.vaultGetSecret(tx, pick.secret_id);
      login = await vaultDecrypt_(row.ciphertext, row.iv, row.secret_id);
    }
    var text = Core.delivery.fillTemplate(tpl.body, { name: sale.Customer, product: prod ? prod.Product_Name : sale.Product_ID, profile: sale.Contact, paidTill: sale.Paid_Till, login: login });
    await Adapter.logAudit(tx, 'delivery:message', [{ tab: 'Delivery_Templates', rowKey: String(sale.Sale_ID), field: 'template', old: '', new: tpl.templateId }]);
    return { ok: true, data: { text: text } };
  }, who && who.actor);
};

// Staging: a row's login (data.secret) is encrypted here, before the planner or the database sees the row. AAD = the row id.
// A client may not send the ciphertext keys. Returns { rows } or { error }.
async function vaultPrepareRows_(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || typeof r !== 'object' || !r.data || typeof r.data !== 'object' || Array.isArray(r.data)) { out.push(r); continue; }
    var d = Object.assign({}, r.data), secret = d.secret;
    delete d.secret; delete d.secretCipher; delete d.secretIv;
    if (secret !== undefined && secret !== null && secret !== '') {
      if (typeof secret !== 'string') return { error: 'Row ' + r.id + ': secret must be text.' };
      if (!vaultConfigured_()) return { error: 'Set VAULT_KEY before staging login details.' };
      var id = typeof r.id === 'string' ? r.id.trim() : '';
      if (!id) return { error: 'Row ' + (i + 1) + ': id is required.' };
      var enc = await vaultEncrypt_(secret, id);
      d.secretCipher = enc.ciphertext; d.secretIv = enc.iv;
    }
    out.push(Object.assign({}, r, { data: d }));
  }
  return { rows: out };
}
function importRowOf_(st, rowId) {
  var rows = st.importRows || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].Row_ID === rowId) return rows[i];
  return null;
}
// Owner writes whose answer carries a one-time secret. The request-id replay keeps the answer without the secret.
var SECRET_FIELD_ = { createApiKey: 'key', saveWebhook: 'secret' };

function randomBytes_(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
// The generators return null only when the random bytes run out; 256 bytes is ample, so one retry is plenty.
function randomToken_(make) {
  for (var i = 0; i < 8; i++) { var t = make(randomBytes_(256)); if (t) return t; }
  throw new Error('random source gave too few usable bytes');
}
function windowIso_(nowMs) { return new Date(Core.publicapi.windowStart(nowMs)).toISOString(); }
function v1Error_(status, code, message, headers) {
  return jsonResponse({ ok: false, code: code, error: message }, status, headers);
}
function v1Limited_() {
  return v1Error_(429, 'rate_limited', 'Too many requests. Wait a minute and try again.', { 'Retry-After': String(Core.publicapi.retryAfterSeconds(Date.now())) });
}
// Catalog answers carry an ETag and a short private cache lifetime, so a browser or the website's server can skip re-downloading an
// unchanged catalog. The key is still checked on every request; the cache is private, so no shared cache holds a keyed answer.
function v1Cached_(req, body) {
  var text = JSON.stringify(Object.assign({ ok: true }, body));
  var etag = 'W/"' + Core.publicapi.keyHash(text).slice(0, 32) + '"';
  var h = { 'ETag': etag, 'Cache-Control': 'private, max-age=60' };
  var inm = req.headers.get('If-None-Match') || '';
  if (inm.split(',').some(function (t) { return t.trim() === etag; })) return new Response(null, { status: 304, headers: h });
  return jsonResponse(JSON.parse(text), 200, h);
}

var V1_ROUTES_ = [
  { method: 'GET', re: /^\/v1\/products$/, name: 'products', scope: 'catalog:read' },
  { method: 'GET', re: /^\/v1\/products\/([^\/]+)$/, name: 'product', scope: 'catalog:read' },
  { method: 'POST', re: /^\/v1\/orders$/, name: 'createOrder', scope: 'orders:write' },
  { method: 'GET', re: /^\/v1\/orders\/([^\/]+)$/, name: 'order', scope: 'orders:read' },
  { method: 'GET', re: /^\/v1\/portal\/([^\/]+)$/, name: 'portal', scope: 'portal:read' }
];
function decodeSafe_(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function v1Match_(method, path) {
  var known = false;
  for (var i = 0; i < V1_ROUTES_.length; i++) {
    var r = V1_ROUTES_[i], m = r.re.exec(path);
    if (!m) continue;
    known = true;
    if (r.method === method) return { route: r, args: m.slice(1).map(decodeSafe_), known: true };
  }
  return { route: null, known: known };
}

/** Entry for every /v1 path. Preflight is answered without a key; the rest runs the pipeline in v1Handle_. */
async function v1Entry_(req, path) {
  if (req.method === 'OPTIONS') return v1Preflight_(req);
  try { return await v1Handle_(req, path); } catch (err) {
    console.error('v1 ' + path + ' failed:', err && err.stack);
    return v1Error_(500, 'server_error', 'Something went wrong. Nothing was changed.');
  }
}

async function v1Handle_(req, path) {
  var m = v1Match_(req.method, path);
  if (!m.route) return m.known ? v1Error_(405, 'method_not_allowed', 'That method is not allowed on this route.') : v1Error_(404, 'not_found', 'No such route.');
  var now = Date.now();
  var ipHits = await Adapter.bumpRateLimit(db, Core.publicapi.ipBucket(clientKey_(req), req.method), windowIso_(now));
  if (Core.publicapi.overLimit(ipHits, Core.publicapi.ipLimit(req.method))) return v1Limited_();
  var raw = Core.publicapi.bearerKey(req.headers.get('Authorization'));
  var key = raw ? await Adapter.findApiKey(db, Core.publicapi.keyHash(raw)) : null;
  if (!key || !key.active) return v1Error_(401, 'unauthorized', 'Send a valid API key as Authorization: Bearer <key>.', { 'WWW-Authenticate': 'Bearer' });
  var origin = req.headers.get('Origin') || '';
  if (!Core.publicapi.originAllowed(key, origin)) return v1Error_(403, 'origin_not_allowed', 'This site is not allowed to use this key.');
  if (!Core.publicapi.hasScope(key, m.route.scope)) return v1Error_(403, 'insufficient_scope', 'This key does not have the ' + m.route.scope + ' scope.');
  var keyHits = await Adapter.bumpRateLimit(db, Core.publicapi.keyBucket(key.key_id), windowIso_(now));
  if (Core.publicapi.overLimit(keyHits, Core.publicapi.LIMITS.keyPerMinute)) return v1Limited_();
  if (!key.last_used_at || now - Date.parse(key.last_used_at) > V1_TOUCH_MS_) await Adapter.touchApiKey(db, key.key_id, new Date(now).toISOString());
  var res = await V1_HANDLERS_[m.route.name](req, key, m.args);
  // A browser call from an origin the key lists gets that origin back, and no other. Server calls carry no Origin.
  var allowed = Core.publicapi.normalizeOrigin(origin);
  if (allowed) { res.headers.set('Access-Control-Allow-Origin', allowed); res.headers.set('Vary', 'Origin'); }
  return res;
}

/** Preflight: the origin is echoed only when some active key lists it (the key itself is checked on the real call). */
async function v1Preflight_(req) {
  var headers = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
  var origin = Core.publicapi.normalizeOrigin(req.headers.get('Origin') || '');
  if (origin) {
    var keys = await Adapter.listApiKeys(db);
    if (keys.some(function (k) { return k.active && k.origins.indexOf(origin) >= 0; })) headers['Access-Control-Allow-Origin'] = origin;
  }
  return new Response(null, { status: 204, headers: headers });
}

// Order body for a response: the order as the website sees it, plus the pay link. The token is the customer's key to the order status.
async function v1OrderView_(db, order) {
  var product = (await Adapter.readTabWhere(db, 'Product_Catalog', 'Product_ID', order.Product_ID))[0] || null;
  var rq = order.Pay_Request_ID ? (await Adapter.readTabWhere(db, 'Pay_Requests', 'Request_ID', order.Pay_Request_ID))[0] || null : null;
  var url = rq ? Core.paylinks.requestUrl(await Adapter.readSettings(db), rq) : '';
  return Core.publicapi.orderView(order, product, rq, url);
}

var V1_HANDLERS_ = {
  // GET /v1/products: the public catalog.
  products: async function (req) {
    var st = await Adapter.readState(db, today_(), V1_CATALOG_TABLES_);
    return v1Cached_(req, { products: Core.publicapi.catalogView(st) });
  },
  // GET /v1/products/<slug>: one public product. Anything not on the website is not found.
  product: async function (req, key, args) {
    var slug = String(args[0] || '').toLowerCase();
    var st = await Adapter.readState(db, today_(), V1_CATALOG_TABLES_);
    var p = (st.products || []).filter(function (x) { return Core.orders.isPublic(x) && String(x.Slug).toLowerCase() === slug; })[0];
    if (!p) return v1Error_(404, 'not_found', 'No product has that web address.');
    return v1Cached_(req, { product: Core.publicapi.productView(st, p) });
  },
  // POST /v1/orders: one order, one pay link. A repeat with the same Idempotency-Key returns the same order (200), or 422 when the body differs.
  createOrder: async function (req, key) {
    var idem = Core.publicapi.idempotencyKey(req.headers.get('Idempotency-Key'));
    if (!idem) return v1Error_(400, 'idempotency_key_required', 'Send an Idempotency-Key header: a unique value for this order, 8 to 128 letters, digits, - or _.');
    var body = await req.json().catch(function () { return undefined; });
    if (body === undefined) return v1Error_(400, 'invalid_json', 'The body must be JSON.');
    var v = Core.publicapi.orderRequest(body);
    if (!v.ok) return jsonResponse({ ok: false, code: v.code, error: v.errors.join(' '), errors: v.errors }, 422);
    var fp = Core.publicapi.fingerprint(v.value);
    return locked_(db, async function (tx) {
      var prior = (await Adapter.readTabWhere(tx, 'Orders', 'Idem_Key', idem)).filter(function (o) { return o.Api_Key_ID === key.key_id; })[0];
      if (prior) {
        if (prior.Request_Hash !== fp) return v1Error_(422, 'idempotency_conflict', 'That Idempotency-Key was already used for a different order.');
        return v1OrderCreated_(tx, prior, 200, true);
      }
      var st = await sweepExpired_(tx, await Adapter.readState(tx, today_(), NEEDS_.createOrder));
      var want = v.value.product.toLowerCase();
      var product = (st.products || []).filter(function (p) { return Core.orders.isPublic(p) && String(p.Slug).toLowerCase() === want; })[0];
      if (!product) return v1Error_(404, 'product_not_found', 'No product on sale has that web address.');
      var plan = Core.orders.planCreateOrder(st, { source: 'website', productId: product.Product_ID, months: v.value.months,
        customerName: v.value.customer.name, contact: v.value.customer.contact, contactChannel: v.value.customer.channel, price: v.value.price,
        note: v.value.note, apiKeyId: key.key_id, idempotencyKey: idem, requestHash: fp,
        accessToken: randomToken_(Core.publicapi.makeOrderToken) });
      if (plan.errors && plan.errors.length) return v1Error_(plan.code === 'price_changed' ? 409 : 422, plan.code || 'validation_failed', plan.errors[0]);
      var out = await commit_(tx, plan, 'createOrder', plan.result);
      if (!out.ok) return v1Error_(422, 'validation_failed', out.error);
      var evt = await orderEventData_(tx, out.data.orderId);
      await enqueueEvent_(tx, 'order.created', evt);
      // The owner hears about a website order on the enabled alert channels (Discord, Telegram); one alert per order.
      await enqueueOwner_(tx, 'order:' + out.data.orderId, Core.notify.ownerText('order', { orderId: out.data.orderId, product: evt.product ? evt.product.name : '', months: evt.months, total: evt.total }));
      var made = (await Adapter.readTabWhere(tx, 'Orders', 'Order_ID', out.data.orderId))[0];
      return v1OrderCreated_(tx, made, 201, false);
    });
  },
  // GET /v1/orders/<id>?token=: the order, for the customer who was given the token with it. Other ids and tokens are not found.
  order: async function (req, key, args) {
    var token = new URL(req.url).searchParams.get('token') || '';
    if (!token) return v1Error_(400, 'token_required', 'Add ?token= with the token the order was created with.');
    var order = (await Adapter.readTabWhere(db, 'Orders', 'Order_ID', String(args[0] || '').toUpperCase()))[0] || null;
    if (!order || !order.Access_Token || !Core.publicapi.timingSafeEqual(token, order.Access_Token)) return v1Error_(404, 'not_found', 'No order matches that id and token.');
    return jsonResponse({ ok: true, order: await v1OrderView_(db, order) }, 200, { 'Cache-Control': 'no-store' });
  },
  // GET /v1/portal/<pay token>: the lines of the customer that owns the token (product, paid till, owes). Nothing else about them.
  portal: async function (req, key, args) {
    var t = String(args[0] || '');
    var sales = t.length >= 16 ? await Adapter.readTabWhere(db, 'Sales_Log', 'Pay_Token', t) : [];
    if (!sales.length) return v1Error_(404, 'not_found', 'No payment link has that token.');
    var sale = sales.reduce(function (a, b) { return Number(b.Sale_ID) > Number(a.Sale_ID) ? b : a; });
    var cd = Core.views.customerData(await Adapter.readState(db, today_(), NEEDS_.customer), sale.Customer_ID);
    if (!cd) return v1Error_(404, 'not_found', 'No payment link has that token.');
    var lines = cd.lines.map(function (l) { return { productName: l.productName, paidTill: l.paidTill, owes: l.owes }; });
    return jsonResponse({ ok: true, portal: Core.publicapi.portalView(lines) }, 200, { 'Cache-Control': 'no-store' });
  }
};

async function v1OrderCreated_(db, order, status, replayed) {
  return jsonResponse({ ok: true, order: await v1OrderView_(db, order), token: order.Access_Token }, status,
    replayed ? { 'Idempotent-Replayed': 'true' } : {});
}

// ---- events and the webhook sender ----
/** The data a webhook carries for an order: its id, status, source, months, total and product (slug and name). No contact details. */
async function orderEventData_(db, orderId) {
  var o = (await Adapter.readTabWhere(db, 'Orders', 'Order_ID', String(orderId)))[0] || null;
  var p = o ? (await Adapter.readTabWhere(db, 'Product_Catalog', 'Product_ID', o.Product_ID))[0] || null : null;
  return { orderId: String(orderId), status: o ? o.Status : '', source: o ? o.Source : '', months: o ? o.Months : 1, total: o ? o.Total : 0,
    product: p ? { slug: p.Slug || '', name: p.Product_Name || '' } : null };
}
/** One pending delivery per endpoint that asked for the event. The delivery id is the event id the receiver sees. Runs in the write's transaction. */
async function enqueueEvent_(db, type, data) {
  if (!Core.publicapi.isEvent(type)) return 0;
  var subs = Core.publicapi.subscribers(await Adapter.listWebhookEndpoints(db), type);
  var nowIso = new Date().toISOString();
  for (var i = 0; i < subs.length; i++) {
    await Adapter.insertWebhookDelivery(db, { id: batchId_(), endpoint_id: subs[i].id, event: type, payload: data || {}, attempts: 0,
      status: 'pending', next_try_at: nowIso, created_at: nowIso });
  }
  return subs.length;
}
/** One POST to an endpoint. Resolves to 'ok' or the reason it failed. Redirects are not followed: a signed body must not go elsewhere. */
async function postWebhook_(url, body, sig, eventId) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 5000);
  try {
    var res = await fetch(url, { method: 'POST', redirect: 'manual', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-Event-Id': eventId, 'User-Agent': 'sales-tracker-webhooks/1' }, body: body });
    try { await res.arrayBuffer(); } catch (e) { /* the status is what matters */ }
    return res.status >= 200 && res.status < 300 ? 'ok' : 'HTTP ' + res.status;
  } finally { clearTimeout(timer); }
}
/**
 * Sends the due pending deliveries (at most `limit`, oldest first). A success marks it delivered; a failure schedules the next try
 * with backoff (Core.publicapi.retryPlan) or marks it failed once the attempts are used up. A resend keeps the event id.
 */
async function sendDue_(db, limit) {
  var now = Date.now(), out = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  var eps = {};
  (await Adapter.listWebhookEndpoints(db)).forEach(function (e) { eps[e.id] = e; });
  var due = (await Adapter.listWebhookDeliveries(db, 'pending')).filter(function (d) { return !d.next_try_at || Date.parse(d.next_try_at) <= now; })
    .sort(function (a, b) { return a.next_try_at < b.next_try_at ? -1 : a.next_try_at > b.next_try_at ? 1 : 0; }).slice(0, limit);
  for (var i = 0; i < due.length; i++) {
    var d = due[i], ep = eps[d.endpoint_id];
    if (!ep || !ep.active) { out.skipped++; continue; }
    // One UPDATE claims the row and leases it (next_try_at moves ahead), so two runs at once send an event once. attempts is counted by the claim.
    d = await Adapter.claimWebhookDelivery(db, d.id, new Date(now).toISOString(), new Date(Core.notify.leaseUntil(now)).toISOString());
    if (!d) { out.skipped++; continue; }
    var body = Core.publicapi.eventBody(d.id, d.event, Date.parse(d.created_at) || now, d.payload);
    var sig = Core.publicapi.signatureHeader(ep.secret, Math.floor(now / 1000), body);
    var outcome = await postWebhook_(ep.url, body, sig, d.id).catch(function (e) { return String((e && e.message) || e).slice(0, 200); });
    var attempts = d.attempts, nowIso = new Date(now).toISOString();
    if (outcome === 'ok') {
      await Adapter.updateWebhookDelivery(db, Object.assign({}, d, { attempts: attempts, status: 'delivered', next_try_at: nowIso, last_error: '', delivered_at: nowIso }));
      out.sent++;
    } else {
      var plan = Core.publicapi.retryPlan(attempts, now);
      if (plan.status === 'failed') {
        await Adapter.updateWebhookDelivery(db, Object.assign({}, d, { attempts: attempts, status: 'failed', last_error: outcome }));
        // A delivery that gave up is a failed job: the owner hears about it once.
        await enqueueOwner_(db, 'webhook:' + d.id + ':failed', Core.notify.ownerText('job', { event: d.event, deliveryId: d.id, attempts: attempts, error: outcome }));
        out.failed++;
      } else {
        await Adapter.updateWebhookDelivery(db, Object.assign({}, d, { attempts: attempts, status: 'pending', next_try_at: new Date(plan.nextTryMs).toISOString(), last_error: outcome }));
        out.retry++;
      }
    }
  }
  return out;
}

// ---- notifications: Core.notify plans the rows, notify_outbox stores them, this sends them ----
var NOTIFY_BATCH_ = 25;
/** The secrets for the channels. Read from env only: they never go to settings, the panel or a log. */
function notifyEnv_() {
  var g = function (k) { return Deno.env.get(k) || ''; };
  return { DISCORD_WEBHOOK_URL: g('DISCORD_WEBHOOK_URL'), TELEGRAM_BOT_TOKEN: g('TELEGRAM_BOT_TOKEN'), TELEGRAM_CHAT_ID: g('TELEGRAM_CHAT_ID'),
    WHATSAPP_TOKEN: g('WHATSAPP_TOKEN'), WHATSAPP_PHONE_ID: g('WHATSAPP_PHONE_ID') };
}
/** Queues an owner alert on each owner channel that is switched on and configured. The key is the event's id, so a repeat queues nothing. */
async function enqueueOwner_(db, key, text) {
  var settings = await Adapter.readSettings(db);
  var enabled = Core.notify.enabledChannels(settings, Core.notify.configuredFromEnv(notifyEnv_()));
  return Adapter.insertNotifyRows(db, Core.notify.ownerRows(enabled, key, text), new Date().toISOString());
}
/**
 * Claims one queued row, sends it, and records the outcome: sent, retried with backoff (pending), or failed for good.
 * Returns 'sent' | 'retry' | 'failed' | 'skipped' (another run claimed it first). The error text never holds a URL or a token.
 */
async function sendNotifyRow_(db, row, env, now) {
  var claimed = await Adapter.claimNotify(db, row.id, new Date(now).toISOString(), new Date(Core.notify.leaseUntil(now)).toISOString());
  if (!claimed) return 'skipped';
  var req = Core.notify.buildSend(claimed.channel, claimed, env);
  var outcome = 'ok', error = '';
  if (req.error) { outcome = 'fail'; error = req.error; }
  else {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, Core.notify.TIMEOUT_MS);
    try {
      var res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: ctl.signal });
      try { await res.arrayBuffer(); } catch (e) { /* the status is what matters */ }
      outcome = Core.notify.classify(res.status);
      if (outcome !== 'ok') error = 'HTTP ' + res.status;
    } catch (e) {
      outcome = 'retry';
      error = 'Could not reach ' + claimed.channel + ' (' + ((e && e.name) || 'error') + ')';
    } finally { clearTimeout(timer); }
  }
  var nowIso = new Date(now).toISOString();
  if (outcome === 'ok') { await Adapter.finishNotify(db, row.id, { status: 'sent', nextTryIso: nowIso, sentIso: nowIso, error: '' }); return 'sent'; }
  var plan = outcome === 'retry' ? Core.notify.retryPlan(claimed.attempts, now) : { status: 'failed' };
  if (plan.status === 'failed') { await Adapter.finishNotify(db, row.id, { status: 'failed', nextTryIso: nowIso, error: error }); return 'failed'; }
  await Adapter.finishNotify(db, row.id, { status: 'pending', nextTryIso: new Date(plan.nextTryMs).toISOString(), error: error });
  return 'retry';
}
/**
 * Plans what is due (customer reminders on WhatsApp, unmatched payments for the owner), queues it, then sends up to NOTIFY_BATCH_
 * rows. Runs outside the write lock: each send is a network call. Also what "Send now" and an external scheduler call.
 */
// A sent customer reminder is logged like a manual "Mark sent", so planReminders stops listing it. The outbox id is remind:<saleId>:<kind>:<cycle>.
// Never throws: the message already went out, and a logging failure must not make the run retry it.
async function logReminderSent_(db, st, row) {
  try {
    var m = /^remind:([^:]+):(before|on_day|after|due):/.exec(String(row.id || ''));
    if (!m || row.channel !== 'whatsapp') return;
    var sale = (st.sales || []).filter(function (x) { return String(x.Sale_ID) === m[1]; })[0];
    if (!sale) return;
    await locked_(db, function (tx) {
      return Adapter.applyOps(tx, [{ op: 'append', tab: 'Reminders_Log', values: { Date: st.today, Sale_ID: m[1], Customer_ID: sale.Customer_ID,
        Kind: m[2], Channel: 'WhatsApp', Status: 'sent' } }], { batchId: batchId_(), action: 'remindSent', log: false });
    });
  } catch (e) { console.error('reminder log failed:', e && e.message); }
}
async function sendNotifications_(db) {
  var now = Date.now(), env = notifyEnv_(), nowIso = new Date(now).toISOString();
  var st = await Adapter.readState(db, today_(), NEEDS_.home);
  var enabled = Core.notify.enabledChannels(st.settings, Core.notify.configuredFromEnv(env));
  var rem = Core.notify.reminderRows(st, Core.reminders.planReminders(st), { today: st.today, enabled: enabled.whatsapp });
  var owner = [];
  Core.views.homeData(st).unmatched.forEach(function (u) {
    owner = owner.concat(Core.notify.ownerRows(enabled, Core.notify.inboxKey(u), Core.notify.ownerText('payment', u)));
  });
  await Adapter.insertNotifyRows(db, rem.rows.concat(owner), nowIso);
  var out = { queued: rem.rows.length + owner.length, skipped: rem.skipped, sent: 0, retry: 0, failed: 0 };
  var due = await Adapter.listDueNotify(db, nowIso, NOTIFY_BATCH_);
  for (var i = 0; i < due.length; i++) {
    var r = await sendNotifyRow_(db, due[i], env, now);
    if (r === 'sent') await logReminderSent_(db, st, due[i]);
    if (r === 'sent') out.sent++; else if (r === 'retry') out.retry++; else if (r === 'failed') out.failed++;
  }
  return out;
}
OUTSIDE_LOCK_.sendNotifications = async function (db) { return { ok: true, data: await sendNotifications_(db) }; };
/** The panel's Notifications card: queue counts, the last errors, the channel switches and whether each one is configured. No secrets. */
OUTSIDE_LOCK_.notifyStatus = async function (db) {
  var rows = await Adapter.listNotify(db), counts = { pending: 0, sending: 0, sent: 0, failed: 0 };
  rows.forEach(function (r) { if (counts[r.status] !== undefined) counts[r.status]++; });
  var byTime = function (a, b) { return a < b ? 1 : a > b ? -1 : 0; };
  var errors = rows.filter(function (r) { return r.error; }).sort(function (a, b) { return byTime(a.created_at, b.created_at); }).slice(0, 5)
    .map(function (r) { return { channel: r.channel, status: r.status, attempts: r.attempts, error: r.error, at: r.created_at }; });
  var lastSentAt = rows.filter(function (r) { return r.sent_at; }).map(function (r) { return r.sent_at; }).sort(byTime)[0] || '';
  var settings = await Adapter.readSettings(db), configured = Core.notify.configuredFromEnv(notifyEnv_()), channels = {};
  Core.notify.CHANNELS.forEach(function (ch) {
    var on = String(settings[Core.notify.ENABLE_KEY[ch]] || '') === 'true';
    channels[ch] = { switchOn: on, configured: configured[ch], active: on && configured[ch] };
  });
  var templates = {};
  ['before', 'on_day', 'after', 'due'].forEach(function (k) { templates[k] = String(settings[Core.notify.KIND_TEMPLATE[k]] || ''); });
  return { ok: true, data: { counts: counts, errors: errors, lastSentAt: lastSentAt, channels: channels, templates: templates } };
};

// ---- owner actions for the public API (panel: More > API keys, Webhooks) ----
async function createApiKey_(db, p) {
  var name = Core.publicapi.keyName(p.name);
  if (!name) return { ok: false, error: 'Give the key a name, such as the website it is for.' };
  var scopes = Core.publicapi.checkScopes(p.scopes);
  if (!scopes.ok) return { ok: false, error: scopes.error };
  var origins = Core.publicapi.checkOrigins(p.origins === undefined ? [] : p.origins);
  if (!origins.ok) return { ok: false, error: origins.error };
  var raw = randomToken_(Core.publicapi.makeApiKey);
  var keyId = randomToken_(Core.publicapi.makeKeyId);
  var row = { key_id: keyId, name: name, hash: Core.publicapi.keyHash(raw), scopes: scopes.scopes, origins: origins.origins,
    created_at: new Date().toISOString() };
  await Adapter.insertApiKey(db, row);
  await Adapter.logAudit(db, 'apiKey:create', [{ tab: 'Api_Keys', rowKey: keyId, field: 'name', old: '', new: name }]);
  return { ok: true, data: { message: name + ' key created. Copy it now: it will not be shown again.', key: raw, keyId: keyId,
    view: Core.publicapi.keyView(Object.assign({ active: true, last_used_at: '' }, row, { hash: undefined })) } };
}
async function revokeApiKey_(db, p) {
  var k = (await Adapter.listApiKeys(db)).filter(function (x) { return x.key_id === String(p.keyId || ''); })[0];
  if (!k) return { ok: false, error: 'Unknown API key.' };
  await Adapter.setApiKeyActive(db, k.key_id, false);
  await Adapter.logAudit(db, 'apiKey:revoke', [{ tab: 'Api_Keys', rowKey: k.key_id, field: 'active', old: 'true', new: 'false' }]);
  return { ok: true, data: { message: k.name + ' key revoked. Requests with it now fail.', keyId: k.key_id } };
}
// Audit text for a webhook: the host only (the path or query can carry a token), the events and the switch. Never the signing secret.
function webhookAuditText_(url, events, active) {
  var host = '';
  try { host = new URL(String(url)).host; } catch (e) { host = ''; }
  return host + ' [' + (events || []).join(',') + '] ' + (active === false ? 'off' : 'on');
}
async function saveWebhook_(db, p) {
  var url = Core.publicapi.webhookUrl(p.url);
  if (!url) return { ok: false, error: 'The address must start with https:// (http:// is allowed only for localhost).' };
  var asked = Array.isArray(p.events) ? p.events.map(String) : [];
  var events = asked.filter(function (e, i) { return asked.indexOf(e) === i; });
  if (!events.length || events.some(function (e) { return !Core.publicapi.isEvent(e); })) {
    return { ok: false, error: 'Choose at least one event: ' + Core.publicapi.EVENTS.join(', ') + '.' };
  }
  var active = p.active !== false;
  if (p.id) {
    var cur = (await Adapter.listWebhookEndpoints(db)).filter(function (e) { return e.id === String(p.id); })[0];
    if (!cur) return { ok: false, error: 'Unknown webhook.' };
    var next = { id: cur.id, url: url, events: events, active: active };
    await Adapter.updateWebhookEndpoint(db, next);
    await Adapter.logAudit(db, 'webhook:save', [{ tab: 'Webhooks', rowKey: cur.id, field: 'endpoint',
      old: webhookAuditText_(cur.url, cur.events, cur.active), new: webhookAuditText_(url, events, active) }]);
    return { ok: true, data: { message: 'Webhook saved', endpoint: Core.publicapi.endpointView(Object.assign({}, cur, next)) } };
  }
  var row = { id: randomToken_(function (b) { return Core.publicapi.makeToken('wh_', b, 12); }),
    url: url, secret: randomToken_(function (b) { return Core.publicapi.makeToken('whsec_', b, 40); }),
    events: events, active: active, created_at: new Date().toISOString() };
  await Adapter.insertWebhookEndpoint(db, row);
  await Adapter.logAudit(db, 'webhook:add', [{ tab: 'Webhooks', rowKey: row.id, field: 'endpoint', old: '', new: webhookAuditText_(url, events, active) }]);
  return { ok: true, data: { message: 'Webhook added. Copy the signing secret now: it will not be shown again.',
    endpoint: Core.publicapi.endpointView(row), secret: row.secret } };
}
async function resendWebhook_(db, p) {
  var d = await Adapter.getWebhookDelivery(db, String(p.deliveryId || ''));
  if (!d) return { ok: false, error: 'Unknown delivery.' };
  await Adapter.updateWebhookDelivery(db, Object.assign({}, d, { attempts: 0, status: 'pending', next_try_at: new Date().toISOString(), last_error: '', delivered_at: null }));
  await Adapter.logAudit(db, 'webhook:resend', [{ tab: 'Webhooks', rowKey: String(d.endpoint_id || d.id), field: 'delivery', old: String(d.status || ''), new: 'pending:' + d.id }]);
  return { ok: true, data: { message: 'Queued again. Send the queue to deliver it.', deliveryId: d.id } };
}
OUTSIDE_LOCK_.apiKeys = async function (db) {
  return { ok: true, data: { keys: (await Adapter.listApiKeys(db)).map(Core.publicapi.keyView) } };
};
OUTSIDE_LOCK_.webhooks = async function (db) {
  var deliveries = (await Adapter.listWebhookDeliveries(db)).sort(function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; });
  return { ok: true, data: { events: Core.publicapi.EVENTS.slice(), endpoints: (await Adapter.listWebhookEndpoints(db)).map(Core.publicapi.endpointView),
    deliveries: deliveries.slice(0, 50).map(Core.publicapi.deliveryView) } };
};
// Send the queue now. Also what the `webhooks` cron job calls (POST /cron/webhooks).
OUTSIDE_LOCK_.sendWebhooks = async function (db) { return { ok: true, data: await sendDue_(db, 20) }; };
// ---- scheduled jobs (POST /cron/<job>) ---------------------------------------
// Each job is a planner in Core.jobs plus a runner here. pg_cron calls the route through pg_net, which is fire-and-forget, so every
// run writes one job_runs row whatever the outcome, and the panel's Jobs card reads those rows. Every job is safe to run twice:
// the planners work from the current state, and the backup file name is per day (a second run replaces it).
var BACKUP_BUCKET_ = 'backups';
var JOB_NEEDS_ = { 'match-sweep': ['Payment_Inbox'], rate: ['Live_Rates'], 'relay-check': ['Payment_Inbox'] };

// Storage REST call with the function's own service role. Only the backups bucket is ever addressed. The error names the route, never the key.
async function storageCall_(method, route, payload, extra) {
  var base = Deno.env.get('SUPABASE_URL') || '', key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!base || !key) throw new Error('Storage is not configured.');
  var headers = Object.assign({ Authorization: 'Bearer ' + key, apikey: key, 'Content-Type': 'application/json' }, extra || {});
  var res = await fetch(base.replace(/\/+$/, '') + '/storage/v1/' + route, { method: method, headers: headers,
    body: payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)) });
  if (!res.ok) throw new Error('Storage ' + method + ' ' + route.split('/').slice(0, 2).join('/') + ' failed: HTTP ' + res.status);
  return res.json().catch(function () { return null; });
}

var JOB_RUNNERS_ = {
  // Retries auto-matching on Pending rows. autoMatch_ never throws; a failure comes back as its note.
  'match-sweep': async function () {
    var st = await Adapter.readState(db, today_(), JOB_NEEDS_['match-sweep']);
    var trx = Core.jobs.planMatchSweep(st), matched = 0, failed = 0;
    for (var i = 0; i < trx.length; i++) {
      var r = await autoMatch_(trx[i]);
      if (r.matched) matched++;
      if (/^Auto-match failed/.test(r.note || '')) failed++;
    }
    return { ok: failed === 0, detail: 'checked ' + trx.length + ', matched ' + matched + (failed ? ', failed ' + failed : '') };
  },
  // Refreshes the USDT rate when the cached one is stale. Same write the panel's init does, through the same refreshRate.
  rate: async function () {
    var st = await Adapter.readState(db, today_(), JOB_NEEDS_.rate);
    if (!Core.jobs.planRate(st, Date.now()).refresh) return { ok: true, detail: 'rate current or manual' };
    var r = await WRITES_.refreshRate(db, st, {});
    return r.ok ? { ok: true, detail: 'rate ' + r.data.rate } : { ok: false, detail: r.error };
  },
  // Whole state as JSON into the private backups bucket: one file per Dhaka day, then only the newest 30 of ours are kept.
  backup: async function () {
    var now = Date.now(), st = await Adapter.readState(db, today_());
    var name = Core.jobs.backupName(now);
    await storageCall_('POST', 'object/' + BACKUP_BUCKET_ + '/' + name, Core.jobs.backupDocument(st, new Date(now).toISOString(), { secrets: await Adapter.vaultBackupSecrets(db), templates: await Adapter.listDeliveryTemplates(db) }), { 'x-upsert': 'true' });
    var listed = await storageCall_('POST', 'object/list/' + BACKUP_BUCKET_, { prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'desc' } });
    var old = Core.jobs.planBackupPrune((Array.isArray(listed) ? listed : []).map(function (o) { return o.name; }));
    if (old.length) await storageCall_('DELETE', 'object/' + BACKUP_BUCKET_, { prefixes: old });
    return { ok: true, detail: name + ', removed ' + old.length + ' old' };
  },
  // Retention: request_log (its idempotency replies) and job_runs older than 30 days.
  cleanup: async function () {
    var c = Core.jobs.planCleanup(Date.now());
    var rl = await db.query('DELETE FROM request_log WHERE created_at < $1::timestamptz RETURNING request_id', [c.requestLogBefore]);
    var jr = await db.query('DELETE FROM job_runs WHERE started_at < $1 RETURNING id', [c.jobRunsBefore]);
    return { ok: true, detail: 'removed ' + rl.rows.length + ' request_log, ' + jr.rows.length + ' job_runs' };
  },
  // Delivers due webhook events: the same function as the sendWebhooks owner action. Rows are claimed one by one with a lease, so a run
  // that overlaps another sends nothing twice. A delivery that gave up already told the owner (enqueueOwner_), so the run itself is ok.
  webhooks: async function () {
    var r = await sendDue_(db, 20);
    return { ok: true, detail: 'sent ' + r.sent + ', retry ' + r.retry + ', failed ' + r.failed + ', skipped ' + r.skipped };
  },
  // Queues and sends due notifications: the same function as the sendNotifications owner action.
  notify: async function () {
    var r = await sendNotifications_(db);
    return { ok: true, detail: 'queued ' + r.queued + ', sent ' + r.sent + ', retry ' + r.retry + ', failed ' + r.failed };
  },
  // Raises or clears the relay_alert flag (settings) and fails the run while it is raised, so the Jobs card shows it in warn.
  'relay-check': async function () {
    var st = await Adapter.readState(db, today_(), JOB_NEEDS_['relay-check']);
    var plan = Core.jobs.planRelayCheck(st, Date.now());
    var want = plan.alert ? 'on' : 'off';
    if ((st.settings.relay_alert || 'off') !== want) {
      var op = Object.prototype.hasOwnProperty.call(st.settings, 'relay_alert')
        ? { op: 'update', tab: 'Settings', key: 'Key', id: 'relay_alert', values: { Value: want } }
        : { op: 'append', tab: 'Settings', id: 'relay_alert', values: { Key: 'relay_alert', Value: want } };
      // Action name starts with "auto" so Undo skips it; the change_log line has no actor (system work).
      await locked_(db, function (tx) { return commit_(tx, { errors: [], ops: [op] }, 'autoRelayAlert'); });
    }
    return plan.alert ? { ok: false, detail: 'No relay SMS or heartbeat in ' + plan.hours + ' h' } : { ok: true, detail: 'relay reporting' };
  }
};

// Runs one job and records the outcome. A throw is a failed run with its message, not a bare 500 with no record.
async function runJob_(name) {
  var started = new Date().toISOString(), res;
  try {
    res = await JOB_RUNNERS_[name]();
  } catch (e) {
    console.error('cron ' + name + ' failed:', e && e.stack ? e.stack : e);
    res = { ok: false, detail: String((e && e.message) || e) };
  }
  var detail = String(res.detail || '').slice(0, 500), ok = res.ok === true;
  await db.query('INSERT INTO job_runs (job, started_at, finished_at, ok, detail) VALUES ($1, $2, $3, $4, $5)',
    [name, started, new Date().toISOString(), ok, detail]);
  return { ok: ok, job: name, detail: detail };
}

// POST /cron/<job>. Fails closed without CRON_TOKEN (its own secret, not APP_SECRET), counts wrong tokens with the other sign-in failures.
async function cronRoute_(req, job) {
  var expected = Deno.env.get('CRON_TOKEN');
  if (!expected) return jsonResponse({ ok: false, error: 'Server not configured' }, 503);
  if (authBlocked_(req)) return jsonResponse({ ok: false, error: 'Too many failed attempts. Wait a minute.' }, 429);
  if (!(await safeEqual_(req.headers.get('X-Cron-Token'), expected))) { authFailed_(req); return jsonResponse({ ok: false, error: 'Unauthorized' }, 401); }
  if (!Core.jobs.isJob(job)) return jsonResponse({ ok: false, error: 'Unknown job' }, 404);
  var out = await runJob_(job);
  return jsonResponse(out, out.ok ? 200 : 500);
}

// ---- who is calling ----------------------------------------------------------
// The panel password (X-App-Secret, APP_SECRET) is the owner, actor 'secret'. A Supabase login (Authorization: Bearer) is a staff
// member: its role is the app_role claim the Custom Access Token hook writes (migration 016). Tokens are checked here through Web Crypto:
// ES256 (or RS256) against the project's JWKS (SUPABASE_URL/auth/v1/.well-known/jwks.json, cached), and legacy HS256 against the project
// JWT secret (SUPABASE_JWT_SECRET) only when that is set. The alg is pinned by key type, never taken on trust from the token.
function b64urlBytes_(s) {
  var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  var bin = atob(t), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var jwksCache_ = { keys: null, fetchedAt: 0, attemptedAt: 0, forcedAt: 0 };
var JWKS_TTL_MS_ = 10 * 60 * 1000, JWKS_MIN_GAP_MS_ = 60 * 1000;
/** jwksKeys_(force) -> array of JWKs ([] on any failure). Cached ~10 min; a refetch is attempted at most once per 60 s. */
async function jwksKeys_(force) {
  var base = Deno.env.get('SUPABASE_URL') || '';
  if (!base) return [];
  var now = Date.now();
  var fresh = jwksCache_.keys && now - jwksCache_.fetchedAt < JWKS_TTL_MS_;
  if (fresh && !force) return jwksCache_.keys;
  // A failed or forced fetch is retried at most once per 60 s (forced = unknown kid), so junk tokens cannot make the function hammer Supabase Auth.
  if (force ? now - jwksCache_.forcedAt < JWKS_MIN_GAP_MS_ : now - jwksCache_.attemptedAt < JWKS_MIN_GAP_MS_) return jwksCache_.keys || [];
  jwksCache_.attemptedAt = now;
  if (force) jwksCache_.forcedAt = now;
  try {
    var res = await fetch(base.replace(/\/+$/, '') + '/auth/v1/.well-known/jwks.json');
    if (!res.ok) return jwksCache_.keys || [];
    var body = await res.json();
    if (!body || !Array.isArray(body.keys)) return jwksCache_.keys || [];
    jwksCache_.keys = body.keys; jwksCache_.fetchedAt = now;
    return jwksCache_.keys;
  } catch (e) { return jwksCache_.keys || []; }
}
/** jwksVerify_(header, signingInput, sig) -> boolean. Key found by kid; alg must match the key's type (EC P-256 -> ES256, RSA -> RS256). */
async function jwksVerify_(header, signingInput, sig) {
  if (header.alg !== 'ES256' && header.alg !== 'RS256') return false;
  if (!header.kid || typeof header.kid !== 'string') return false;
  var find = function (keys) { for (var i = 0; i < keys.length; i++) if (keys[i] && keys[i].kid === header.kid) return keys[i]; return null; };
  var jwk = find(await jwksKeys_(false));
  if (!jwk) jwk = find(await jwksKeys_(true));  // unknown kid: one refetch (rate-limited)
  if (!jwk) return false;
  try {
    var data = new TextEncoder().encode(signingInput);
    if (header.alg === 'ES256') {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || sig.length !== 64) return false;
      var ek = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, ek, sig, data);
    }
    if (jwk.kty !== 'RSA') return false;
    var rk = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', rk, sig, data);
  } catch (e) { return false; }
}
/** verifyJwt_(token, hsSecret) -> payload | null. Signature, expiry, not-before and audience ('authenticated') are all checked. hsSecret is the optional legacy HS256 secret. */
async function verifyJwt_(token, hsSecret) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  var header, payload, sig;
  try {
    var dec = new TextDecoder();
    header = JSON.parse(dec.decode(b64urlBytes_(parts[0])));
    payload = JSON.parse(dec.decode(b64urlBytes_(parts[1])));
    sig = b64urlBytes_(parts[2]);
  } catch (e) { return null; }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null;
  var input = parts[0] + '.' + parts[1], ok = false;
  if (header.alg === 'HS256') {
    if (!hsSecret) return null;
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(hsSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(input));
  } else {
    ok = await jwksVerify_(header, input, sig);
  }
  if (!ok) return null;
  var now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + 60)) return null;
  if (payload.aud !== 'authenticated') return null;
  return payload;
}
/** authenticate_(req) -> { who } | { status, error }. Fails closed: with no APP_SECRET, no SUPABASE_JWT_SECRET and no SUPABASE_URL, nothing gets in. */
// A login token is checked against the staff row on every request (one query): an inactive or removed user is refused at once, and so is a
// token whose role no longer matches the row (a downgrade or upgrade), with code access_changed, so the panel signs in again.
async function authenticate_(req, db) {
  var secret = Deno.env.get('APP_SECRET') || '', jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') || '', projectUrl = Deno.env.get('SUPABASE_URL') || '';
  if (!secret && !jwtSecret && !projectUrl) return { status: 503, error: 'Server not configured' };
  var sent = req.headers.get('X-App-Secret');
  if (secret && sent !== null && await safeEqual_(sent, secret)) return { who: { role: 'owner', actor: 'secret', email: '' } };
  var m = /^Bearer\s+(\S+)$/.exec(req.headers.get('Authorization') || '');
  if ((jwtSecret || projectUrl) && m) {
    var claims = await verifyJwt_(m[1], jwtSecret);
    if (!claims || !claims.sub || !UUID_RE_.test(String(claims.sub))) return { status: 401, error: 'Unauthorized' };
    var row = await Adapter.readStaffMember(db, String(claims.sub));
    if (!row || !row.active) return { status: 403, error: 'This login has no staff access.' };
    if (row.role !== claims.app_role) return { status: 403, error: 'Your access changed. Sign in again.', code: 'access_changed' };
    return { who: { role: row.role, actor: String(claims.sub), email: String(claims.email || '') } };
  }
  return { status: 401, error: 'Unauthorized' };
}

// ---- HTTP entry point -------------------------------------------------------
/** Constant-time string compare: hashes both sides so length and content do not leak through timing. */
async function safeEqual_(a, b) {
  var enc = new TextEncoder();
  var ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(a === undefined || a === null ? '' : a))));
  var hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(b === undefined || b === null ? '' : b))));
  var diff = 0;
  for (var i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// CORS is opt-in: only the origin named in ALLOWED_ORIGIN is echoed back. Never '*'.
function withCors_(req, res) {
  var allowed = Deno.env.get('ALLOWED_ORIGIN') || '';
  var origin = req.headers.get('Origin') || '';
  if (allowed && origin === allowed) {
    res.headers.set('Access-Control-Allow-Origin', allowed);
    res.headers.set('Vary', 'Origin');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret, Authorization');
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return res;
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
}

// /v1 has its own CORS (per key, see v1Handle_), so the panel's single allowed origin is never echoed there.
async function handle(req) {
  var path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?api(?:\/|$)/, '/') || '/';
  if (path === '/v1' || path.indexOf('/v1/') === 0) return v1Entry_(req, path);
  return withCors_(req, await route_(req));
}

async function route_(req) {
  var url = new URL(req.url);
  var path = url.pathname.replace(/^\/(?:functions\/v1\/)?api(?:\/|$)/, '/') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method === 'GET') {
    if (path === '/health') return jsonResponse({ ok: true });
    if (path === '/' || path === '/index.html') return jsonResponse({ ok: true, service: 'sales-tracker-api' });
    var pm = /^\/pay\/([^\/]+)$/.exec(path);
    if (pm) {
      var html = await payPage_(decodeURIComponent(pm[1]));
      if (!html) return new Response('Payment link not found.', { status: 404 });
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    var sm = /^\/pay\/([^\/]+)\/status$/.exec(path);
    if (sm) {
      var ps = await payStatus(decodeURIComponent(sm[1]));
      if (!ps) return new Response('Payment link not found.', { status: 404 });
      // A weak ETag over what the page timeline shows (stage, rows, until, delivery status word). Unchanged since the page's If-None-Match: 304, no body.
      var etag = 'W/"' + ps.stage + '|' + (ps.rows ? ps.rows.length : 0) + '|' + (ps.until || '') + '|' + (ps.delivery || '') + '|' + rowsTag_(ps.rows) + '"';
      var inm = req.headers.get('If-None-Match') || '';
      if (inm.split(',').some(function (t) { return t.trim() === etag; })) return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-store' } });
      return jsonResponse(ps, 200, { 'Cache-Control': 'no-store', 'ETag': etag });
    }
    // The receipt: public by token like the page, for a Paid request only; it carries the code only while a live code exists. Never cached.
    var rm = /^\/pay\/([^\/]+)\/receipt$/.exec(path);
    if (rm) {
      var rctx = await payContext_(decodeURIComponent(rm[1]), false);
      var rcpt = rctx && rctx.request ? await requestReceipt_(rctx) : null;
      return rcpt ? jsonResponse(rcpt.receipt, 200, { 'Cache-Control': 'no-store' }) : new Response('Payment link not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    // The customer portal: the subscriptions of the customer who owns this pay token. Read only, rendered by portal-page.js.
    var portm = /^\/portal\/([^\/]+)$/.exec(path);
    if (portm) return portalPage_(req, decodeURIComponent(portm[1]));
    return new Response('Not found', { status: 404 });
  }
  if (req.method === 'POST') {
    // The pay page saves the customer's choice here. Public like the page, but it only writes one row per valid pay token.
    var im = /^\/pay\/([^\/]+)\/intent$/.exec(path);
    if (im) {
      var ib = await req.json().catch(function () { return {}; });
      var ir = await payIntent_(decodeURIComponent(im[1]), ib);
      return jsonResponse(ir.body, ir.status);
    }
    var cm = /^\/cron\/([^\/]+)$/.exec(path);
    if (cm) return cronRoute_(req, decodeURIComponent(cm[1]));
    if (authBlocked_(req)) return jsonResponse({ ok: false, error: 'Too many failed attempts. Wait a minute.' }, 429);
    if (path === '/relay') {
      var body = await req.json().catch(function () { return {}; });
      var relayToken = Deno.env.get('RELAY_TOKEN');
      if (!relayToken) return jsonResponse({ ok: false, error: 'Server not configured' }, 503);
      if (!(await safeEqual_(body.token, relayToken))) { authFailed_(req); return jsonResponse({ ok: false, error: 'bad token' }, 401); }
      return jsonResponse(await relayIngest(body, url.searchParams.get('src') || ''));
    }
    var auth = await authenticate_(req, db);
    if (auth.error) { if (auth.status === 401) authFailed_(req); return jsonResponse({ ok: false, error: auth.error, code: auth.code }, auth.status); }
    var b = await req.json().catch(function () { return {}; });
    var out = await api(b.action, b.payload || {}, db, auth.who);
    // no-store: an answer can carry a revealed login (vaultReveal), and no answer here is for a shared cache.
    return jsonResponse(out, out.code === 'forbidden' ? 403 : 200, { 'Cache-Control': 'no-store' });
  }
  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

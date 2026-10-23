/** Core.views: read-only shapes for the app screens. Everything is computed from State; nothing is stored. */
var Core = Core || {};
Core.views = (function () {
  var r2 = function (n) { return Core.util.round2(n); };
  var EXPIRED_WINDOW = 30, AUTO_WINDOW = 3;
  function find(rows, f, v) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][f] === v) return rows[i]; return null; }
  function isPlaceholder(name) { return /^Unlogged payment/.test(String(name || '')); }

  function index(state) {
    var cust = {}, prod = {};
    (state.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    (state.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    return { cust: cust, prod: prod, paid: Core.ledger.paidMap(state) };
  }

  function saleRow(state, ix, s) {
    var c = ix.cust[s.Customer_ID] || {}, p = ix.prod[s.Product_ID] || {};
    var owes = r2(Core.ledger.saleRevenue(s, state.products) - (ix.paid[s.Sale_ID] || 0));
    return { saleId: s.Sale_ID, subCode: s.Sub_Code, payToken: s.Pay_Token || '', customerId: s.Customer_ID, name: c.Name || s.Customer,
      channel: c.Channel || '', handle: c.Handle || '', productId: s.Product_ID, productName: p.Product_Name || s.Product_ID,
      accountId: s.Account_ID, profile: s.Contact, paidTill: s.Paid_Till || '', status: s.Record_Status,
      daysLeft: s.Paid_Till ? Core.util.daysBetween(state.today, s.Paid_Till) : null,
      price: Core.ledger.salePrice(s, state.products), months: s.Months || 1, owes: owes > 0 ? owes : 0 };
  }

  function activeTimed(state) {
    return (state.sales || []).filter(function (s) { return s.Record_Status === 'Active' && s.Paid_Till; });
  }

  function homeData(state) {
    var ix = index(state), before = Number(state.settings.reminder_days_before) || 3;
    var rows = activeTimed(state).map(function (s) { return saleRow(state, ix, s); })
      .filter(function (r) { return !isPlaceholder(r.name); });
    var renewSoon = rows.filter(function (r) { return r.daysLeft >= 0 && r.daysLeft <= before; })
      .sort(function (a, b) { return a.daysLeft - b.daysLeft || a.saleId - b.saleId; });
    var expired = rows.filter(function (r) { return r.daysLeft < 0 && r.daysLeft >= -EXPIRED_WINDOW; })
      .sort(function (a, b) { return b.daysLeft - a.daysLeft || a.saleId - b.saleId; });
    var unmatched = (state.inbox || []).filter(function (r) { return r.Status === 'Pending' || r.Status === 'Review'; })
      .map(function (r) { return { trx: r.Transaction_ID, amount: Number(r.Amount) || 0, sender: String(r.Sender || ''),
        received: r.Received, reference: r.Reference || '', status: r.Status, sms: r.Raw_SMS || '' }; });
    var autoMap = {}, auto = [];
    (state.payments || []).forEach(function (p) {
      if (p.Source !== 'Auto' || !p.Date) return;
      var age = Core.util.daysBetween(p.Date, state.today);
      if (age < 0 || age > AUTO_WINDOW) return;
      var k = p.Transaction_ID || p.Payment_ID;
      if (!autoMap[k]) { autoMap[k] = { trx: k, customerId: p.Customer_ID, name: (ix.cust[p.Customer_ID] || {}).Name || p.Customer_ID, amount: 0, date: p.Date }; auto.push(autoMap[k]); }
      autoMap[k].amount = r2(autoMap[k].amount + Number(p.Amount || 0));
    });
    return { today: state.today, owed: duesList(state).total, renewSoon: renewSoon, expired: expired, unmatched: unmatched,
             autoToCheck: auto, reminders: Core.reminders.planReminders(state) };
  }

  function duesList(state) {
    var ix = index(state), rows = [], credits = [], total = 0;
    (state.sales || []).forEach(function (s) {
      var bal = r2(Core.ledger.saleRevenue(s, state.products) - (ix.paid[s.Sale_ID] || 0));
      if (bal <= 0) return;
      var r = saleRow(state, ix, s);
      var since = s.Paid_Till || s.Sale_Date || '';
      rows.push({ saleId: s.Sale_ID, subCode: s.Sub_Code, payToken: s.Pay_Token || '', customerId: s.Customer_ID, name: r.name, channel: r.channel, handle: r.handle,
        productName: r.productName, amount: bal, since: since, daysLate: since ? Core.util.daysBetween(since, state.today) : null });
      total += bal;
    });
    rows.sort(function (a, b) {
      if (a.daysLate === null && b.daysLate !== null) return 1;
      if (b.daysLate === null && a.daysLate !== null) return -1;
      return (b.daysLate || 0) - (a.daysLate || 0) || b.amount - a.amount || a.saleId - b.saleId;
    });
    (state.customers || []).forEach(function (c) {
      var cr = Core.ledger.creditOf(state, c.Customer_ID);
      if (cr > 0) credits.push({ customerId: c.Customer_ID, name: c.Name, amount: cr });
    });
    return { rows: rows, total: r2(total), credits: credits };
  }

  function customerData(state, id) {
    var c = find(state.customers, 'Customer_ID', id);
    if (!c) return null;
    var ix = index(state);
    var mine = (state.sales || []).filter(function (s) { return s.Customer_ID === id; });
    var lines = mine.filter(function (s) { return s.Record_Status === 'Active'; }).map(function (s) { return saleRow(state, ix, s); })
      .sort(function (a, b) {
        var da = a.daysLeft === null ? -1e9 : a.daysLeft, db = b.daysLeft === null ? -1e9 : b.daysLeft;
        return db - da || a.saleId - b.saleId;
      });
    var history = mine.map(function (s) { return saleRow(state, ix, s); }).sort(function (a, b) { return b.saleId - a.saleId; });
    var payments = (state.payments || []).filter(function (p) { return p.Customer_ID === id && p.Source !== 'Credit'; })
      .map(function (p) { return { id: p.Payment_ID, date: p.Date || '', saleId: p.Sale_ID, amount: Number(p.Amount) || 0,
        method: p.Method || '', trx: p.Transaction_ID || '', source: p.Source }; })
      .sort(function (a, b) { return Core.util.isoCompare(b.date, a.date) || (a.id < b.id ? 1 : -1); });
    var bal = Core.ledger.customerBalance(state, id);
    return { customer: c, owes: bal > 0 ? bal : 0, credit: Core.ledger.creditOf(state, id), lines: lines, history: history,
             payments: payments, dues: Core.ledger.openDues(state, id) };
  }

  function isOpening(p) { return /^Opening balance/i.test(String(p.Notes || p.Note || '')); }

  function bookData(state, month) {
    var entries = [], opening = 0, ix = index(state);
    (state.payments || []).forEach(function (p) {
      if (p.Source === 'Credit') return;
      var amt = Number(p.Amount) || 0;
      if (!p.Date) { opening += amt; return; }
      entries.push({ date: p.Date, kind: 'in', amount: amt, label: ((ix.cust[p.Customer_ID] || {}).Name || p.Customer_ID), method: p.Method || '', id: p.Payment_ID });
    });
    (state.purchases || []).forEach(function (p) {
      var amt = Number(p.Amount) || 0;
      if (!p.Date || isOpening(p)) { opening -= amt; return; }
      entries.push({ date: p.Date, kind: 'out', amount: amt, label: p.Account_ID + ' renewal', method: p.Paid_With || '', id: p.Purchase_ID });
    });
    (state.expenses || []).forEach(function (e) {
      var amt = Number(e.Amount) || 0;
      if (!e.Date) { opening -= amt; return; }
      entries.push({ date: e.Date, kind: 'out', amount: amt, label: e.Category + (e.Note ? ' · ' + e.Note : ''), method: e.Paid_With || '', id: e.Expense_ID });
    });
    entries.sort(function (a, b) { return Core.util.isoCompare(a.date, b.date) || (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1); });
    var months = {}, balance = opening, inM = 0, outM = 0, openM = null, list = [];
    entries.forEach(function (e) {
      var m = e.date.slice(0, 7); months[m] = true;
      if (m < month) balance += e.kind === 'in' ? e.amount : -e.amount;
    });
    openM = balance;
    entries.forEach(function (e) {
      if (e.date.slice(0, 7) !== month) return;
      if (e.kind === 'in') inM += e.amount; else outM += e.amount;
      balance += e.kind === 'in' ? e.amount : -e.amount;
      list.push(Object.assign({ balance: r2(balance) }, e));
    });
    months[state.today.slice(0, 7)] = true;
    return { month: month, opening: r2(openM), in: r2(inM), out: r2(outM), net: r2(inM - outM), closing: r2(openM + inM - outM),
             entries: list, months: Object.keys(months).sort().reverse(), legacyOpening: r2(opening) };
  }

  function lookups(state) {
    var ix = index(state);
    var products = (state.products || []).filter(function (p) { return String(p.Active || 'Yes') !== 'No'; }).map(function (p) {
      return { id: p.Product_ID, name: p.Product_Name, category: p.Category, letter: p.Letter, price: Number(p.Default_Price) || 0,
               cycle: Number(p.Billing_Cycle_Days) || 30 };
    });
    var accounts = (state.accounts || []).map(function (a) {
      return { id: a.Account_ID, productId: a.Product_ID, label: a.Account_Label, slots: Number(a.Slots) || 0,
               free: Core.sales.freeSlots(state, a), status: a.Account_Status || 'Active', cost: Number(a.Cycle_Cost) || 0 };
    }).sort(function (a, b) { return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : (b.free - a.free) || (a.id < b.id ? -1 : 1); });
    var sold = {};
    (state.sales || []).forEach(function (s) { if (s.Code_ID && s.Record_Status !== 'Void') sold[s.Code_ID] = true; });
    var codes = (state.codes || []).filter(function (c) { return !sold[c.Code_ID] && (!c.Status || c.Status === 'Available'); })
      .map(function (c) { return { id: c.Code_ID, productId: c.Product_ID, code: c.Code }; });
    var customers = (state.customers || []).map(function (c) {
      var bal = Core.ledger.customerBalance(state, c.Customer_ID);
      return { id: c.Customer_ID, name: c.Name, channel: c.Channel || '', handle: c.Handle || '', owes: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 };
    }).sort(function (a, b) { return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1; });
    var lines = (state.sales || []).filter(function (s) { return s.Record_Status === 'Active' && s.Sub_Code && (ix.prod[s.Product_ID] || {}).Category !== 'Game Code'; })
      .map(function (s) { var r = saleRow(state, ix, s); return { subCode: r.subCode, saleId: r.saleId, customerId: r.customerId, name: r.name,
        productId: r.productId, productName: r.productName, accountId: r.accountId, price: r.price, paidTill: r.paidTill, daysLeft: r.daysLeft }; });
    var suppliers = (state.suppliers || []).map(function (s) {
      return { id: s.Supplier_ID, name: s.Name, contact: s.Contact || '', currency: s.Currency || 'BDT',
               markupPercent: Number(s.Markup_Percent) || 0, notes: s.Notes || '' };
    });
    var batchMap = {}, batches = [];
    (state.codes || []).forEach(function (c) {
      if (!c.Batch_ID) return;
      var b = batchMap[c.Batch_ID];
      if (!b) { b = batchMap[c.Batch_ID] = { id: c.Batch_ID, tag: c['Source / Batch'] || c.Batch_ID, productId: c.Product_ID, total: 0, pending: 0, sold: 0 }; batches.push(b); }
      b.total++;
      if (c.Status === 'Sold') b.sold++; else if (c.Status === 'Pending') b.pending++;
    });
    return { products: products, accounts: accounts, codes: codes, batches: batches, customers: customers, lines: lines,
             suppliers: suppliers, rate: Core.rates.resolveRate(state),
             wallets: (state.wallets || []).map(function (w) { return { id: w.Wallet_ID, label: w.Label }; }),
             expenseCategories: Core.sales.EXPENSE_CATEGORIES,
             settings: { usdt_bdt_manual: state.settings.usdt_bdt_manual || '', bkash_number: state.settings.bkash_number || '', language: state.settings.language || 'en',
                         grace_days: state.settings.grace_days, reminder_days_before: state.settings.reminder_days_before,
                         reminder_days_after: state.settings.reminder_days_after, due_reminder_every_days: state.settings.due_reminder_every_days } };
  }

  /** One product tab's content for the app (the sheet tab builds the same view by formula). */
  function productList(state, productId) {
    var ix = index(state);
    return (state.accounts || []).filter(function (a) { return a.Product_ID === productId; }).map(function (a) {
      return { account: { id: a.Account_ID, label: a.Account_Label, cost: Number(a.Cycle_Cost) || 0, slots: Number(a.Slots) || 0,
                          free: Core.sales.freeSlots(state, a), status: a.Account_Status || 'Active' },
               customers: (state.sales || []).filter(function (s) { return s.Account_ID === a.Account_ID && s.Record_Status === 'Active'; })
                 .map(function (s) { return saleRow(state, ix, s); }) };
    });
  }

  /** Profit by product category: revenue minus cost for all non-void sales, sorted by profit descending. */
  /** 'YYYY-MM' before the month of an ISO date string. */
  function previousMonth(iso) {
    var y = Number(String(iso).slice(0, 4)), m = Number(String(iso).slice(5, 7)) - 1;
    if (m < 1) { m = 12; y -= 1; }
    return y + '-' + (m < 10 ? '0' : '') + m;
  }

  /** One profit_snapshots row for a month, built on profitByFamily. */
  function profitSnapshotRow(state, month) {
    var rev = 0, cost = 0;
    profitByFamily(state, month).forEach(function (f) { rev += f.revenue; cost += f.cost; });
    return { month: month, revenue_bdt: r2(rev), cost_bdt: r2(cost), profit_bdt: r2(rev - cost) };
  }

  /** Profit per product category. With `month` ('YYYY-MM') only sales made in that month count. */
  function profitByFamily(state, month) {
    var ix = index(state);
    var groups = {};
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status === 'Void' || s.Record_Status === 'Refunded') return;
      if (month && String(s.Sale_Date || '').slice(0, 7) !== month) return;
      var p = ix.prod[s.Product_ID] || {};
      var cat = p.Category || 'Subscription';
      if (!groups[cat]) groups[cat] = { revenue: 0, cost: 0, rateMissing: false };
      groups[cat].revenue += Core.ledger.saleRevenue(s, state.products);
      var ci = Core.ledger.saleCostInfo(s, state);
      groups[cat].cost += ci.cost;
      if (ci.rateMissing) groups[cat].rateMissing = true;
    });
    var out = [];
    for (var cat in groups) {
      var g = groups[cat];
      var rev = r2(g.revenue), cost = r2(g.cost), profit = r2(g.revenue - g.cost);
      var marginPct = rev > 0 ? Math.round(profit / rev * 10000) / 100 : 0;
      out.push({ category: cat, revenue: rev, cost: cost, profit: profit, marginPct: marginPct, rateMissing: g.rateMissing });
    }
    out.sort(function (a, b) { return b.profit - a.profit; });
    return out;
  }

  return { homeData: homeData, duesList: duesList, customerData: customerData, bookData: bookData, lookups: lookups, productList: productList, profitByFamily: profitByFamily,
           profitSnapshotRow: profitSnapshotRow, previousMonth: previousMonth };
})();
if (typeof module !== 'undefined') module.exports = Core.views;

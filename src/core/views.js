/** Core.views: read-only shapes for the app screens. Everything is computed from State; nothing is stored. */
var Core = Core || {};
Core.views = (function () {
  var r2 = function (n) { return Core.util.round2(n); };
  var EXPIRED_WINDOW = 30, AUTO_WINDOW = 3, PAYLINK_SOON_HOURS = 6;
  function find(rows, f, v) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][f] === v) return rows[i]; return null; }
  function isPlaceholder(name) { return /^Unlogged payment/.test(String(name || '')); }

  function index(state) {
    var cust = {}, prod = {};
    (state.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    (state.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    prod[Core.ledger.CUSTOM_ID] = Core.ledger.CUSTOM_PRODUCT;
    return { cust: cust, prod: prod, paid: Core.ledger.paidMap(state) };
  }

  /** Reminder kind for a settled sale, from days until Paid_Till. */
  function renewKind(state, s) {
    if (!s.Paid_Till) return 'before';
    var d = Core.util.daysBetween(state.today, s.Paid_Till);
    return d > 0 ? 'before' : d === 0 ? 'on_day' : 'after';
  }

  function saleRow(state, ix, s) {
    var c = ix.cust[s.Customer_ID] || {}, p = ix.prod[s.Product_ID] || {};
    var custom = Core.ledger.isCustom(s);
    var owes = Core.ledger.saleBalance(s, state, ix.paid);
    var row = { saleId: s.Sale_ID, subCode: s.Sub_Code, payToken: s.Pay_Token || '', customerId: s.Customer_ID, name: c.Name || s.Customer,
      channel: c.Channel || '', handle: c.Handle || '', productId: s.Product_ID,
      productName: custom ? (s.Notes || 'Custom sale') : (p.Product_Name || s.Product_ID),
      accountId: s.Account_ID, profile: s.Contact, paidTill: s.Paid_Till || '', status: s.Record_Status,
      daysLeft: s.Paid_Till ? Core.util.daysBetween(state.today, s.Paid_Till) : null,
      price: Core.ledger.salePrice(s, state.products), months: s.Months || 1, owes: owes > 0 ? owes : 0,
      kind: owes > 0 ? 'due' : custom ? 'custom' : renewKind(state, s),
      notes: s.Notes || '', costSnapshot: Number(s.Cost_Snapshot) || 0 };
    if (custom) { row.custom = true; row.saleDate = s.Sale_Date || ''; }
    return row;
  }

  /** Account ids the owner deleted (kept for the money, hidden from every list). */
  function deletedIds(state) {
    var gone = {};
    (state.accounts || []).forEach(function (a) { if (a.Account_Status === 'Deleted') gone[a.Account_ID] = true; });
    return gone;
  }

  function activeTimed(state) {
    var gone = deletedIds(state);
    return (state.sales || []).filter(function (s) { return s.Record_Status === 'Active' && s.Paid_Till && !gone[s.Account_ID]; });
  }

  function homeData(state) {
    var ix = index(state), before = Number(state.settings.reminder_days_before) || 3;
    var rows = activeTimed(state).map(function (s) { return saleRow(state, ix, s); })
      .filter(function (r) { return !isPlaceholder(r.name); });
    var renewSoon = rows.filter(function (r) { return r.daysLeft >= 0 && r.daysLeft <= before; })
      .sort(function (a, b) { return a.daysLeft - b.daysLeft || a.saleId - b.saleId; });
    var expired = rows.filter(function (r) { return r.daysLeft < 0 && r.daysLeft >= -EXPIRED_WINDOW; })
      .sort(function (a, b) { return b.daysLeft - a.daysLeft || a.saleId - b.saleId; });
    var open = (state.inbox || []).filter(function (r) { return r.Status === 'Pending' || r.Status === 'Review'; });
    var unmatched = open.filter(function (r) { return Core.matching.rowType(r) !== 'TopUp'; })
      .map(function (r) { return { trx: r.Transaction_ID, amount: Number(r.Amount) || 0, sender: String(r.Sender || ''),
        received: r.Received, reference: r.Reference || '', status: r.Status, sms: r.Raw_SMS || '', method: r.Method || '',
        counterparty: String(r.Counterparty || ''), why: Core.matching.whyNotAuto(state, r) }; });
    var topUps = open.filter(function (r) { return Core.matching.rowType(r) === 'TopUp'; })
      .map(function (r) { return { trx: r.Transaction_ID, amount: Number(r.Amount) || 0, sender: String(r.Sender || ''), received: r.Received, sms: r.Raw_SMS || '' }; });
    var autoMap = {}, auto = [];
    (state.payments || []).forEach(function (p) {
      if (p.Source !== 'Auto' || !p.Date) return;
      var age = Core.util.daysBetween(p.Date, state.today);
      if (age < 0 || age > AUTO_WINDOW) return;
      var k = p.Transaction_ID || p.Payment_ID;
      if (!autoMap[k]) { autoMap[k] = { trx: k, customerId: p.Customer_ID, name: (ix.cust[p.Customer_ID] || {}).Name || p.Customer_ID, amount: 0, date: p.Date }; auto.push(autoMap[k]); }
      autoMap[k].amount = r2(autoMap[k].amount + Number(p.Amount || 0));
    });
    // Counts behind the Today "needs attention" strip. Each one is the set the screen it opens shows.
    var nowMs = Number(state.nowMs) || Date.now(), soonMs = PAYLINK_SOON_HOURS * 3600000, month = String(state.today || '').slice(0, 7);
    var payLinks = (state.payRequests || []).filter(function (rq) {
      var t = Date.parse(rq.Expires || '');
      return rq.Status === 'Open' && isFinite(t) && t > nowMs && t - nowMs <= soonMs;
    }).length;
    var deliveries = (state.deliveries || []).filter(function (d) { return d.Status === 'Pending' || d.Status === 'Failed'; }).length;
    var budgets = (state.budgets || []).filter(function (b) { return (b.Active || 'Yes') === 'Yes'; }).filter(function (b) {
      var st = Core.money.budgetProgress(state, b, month).state;
      return st === 'warn' || st === 'over';
    }).length;
    var attention = { payments: unmatched.length, payLinks: payLinks, deliveries: deliveries, budgets: budgets };
    return { today: state.today, owed: duesList(state).total, renewSoon: renewSoon, expired: expired, unmatched: unmatched, topUps: topUps, attention: attention,
             autoToCheck: auto, reminders: Core.reminders.planReminders(state), stock: stockAlerts(state, state.settings) };
  }

  function duesList(state) {
    var ix = index(state), rows = [], credits = [], total = 0;
    (state.sales || []).forEach(function (s) {
      var bal = Core.ledger.saleBalance(s, state, ix.paid);
      if (bal <= 0) return;
      var r = saleRow(state, ix, s);
      var since = s.Paid_Till || s.Sale_Date || '';
      rows.push({ saleId: s.Sale_ID, subCode: s.Sub_Code, payToken: s.Pay_Token || '', customerId: s.Customer_ID, name: r.name, channel: r.channel, handle: r.handle,
        productName: r.productName, kind: 'due', amount: bal, since: since, daysLate: since ? Core.util.daysBetween(since, state.today) : null,
        paidTill: r.paidTill, unitPrice: r.price, months: Number(s.Months) || 1, custom: Core.ledger.isCustom(s) });
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

  /** opts.withLocks: each payment carries `locked` (paymentLocks). Only the customer and book reads ask for it: it reads Pay_Requests. */
  function customerData(state, id, opts) {
    var withLocks = !!(opts && opts.withLocks);
    var c = find(state.customers, 'Customer_ID', id);
    if (!c) return null;
    var ix = index(state);
    var mine = (state.sales || []).filter(function (s) { return s.Customer_ID === id; });
    var lines = mine.filter(function (s) { return s.Record_Status === 'Active' && !Core.ledger.isCustom(s); }).map(function (s) { return saleRow(state, ix, s); })
      .sort(function (a, b) {
        var da = a.daysLeft === null ? -1e9 : a.daysLeft, db = b.daysLeft === null ? -1e9 : b.daysLeft;
        return db - da || a.saleId - b.saleId;
      });
    var customSales = mine.filter(function (s) { return s.Record_Status === 'Active' && Core.ledger.isCustom(s); })
      .map(function (s) { return saleRow(state, ix, s); }).sort(function (a, b) { return b.saleId - a.saleId; });
    // saleDate on every row (the workspace timeline and first-sale date need it; custom rows already had it).
    var history = mine.map(function (s) { var r = saleRow(state, ix, s); r.saleDate = s.Sale_Date || ''; return r; }).sort(function (a, b) { return b.saleId - a.saleId; });
    var payments = (state.payments || []).filter(function (p) { return p.Customer_ID === id && p.Source !== 'Credit'; })
      .map(function (p) { var row = { id: p.Payment_ID, paymentId: p.Payment_ID, date: p.Date || '', saleId: p.Sale_ID, amount: Number(p.Amount) || 0,
        method: p.Method || '', trx: p.Transaction_ID || '', source: p.Source, note: p.Note || '' };
        if (withLocks) row.locked = Core.sales.paymentLocks(state, p);
        return row; })
      .sort(function (a, b) { return Core.util.isoCompare(b.date, a.date) || (a.id < b.id ? 1 : -1); });
    var bal = Core.ledger.customerBalance(state, id);
    return { customer: c, owes: bal > 0 ? bal : 0, credit: Core.ledger.creditOf(state, id), lines: lines, customSales: customSales, history: history,
             payments: payments, dues: Core.ledger.openDues(state, id) };
  }

  function isOpening(p) { return /^Opening balance/i.test(String(p.Notes || p.Note || '')); }

  /** opts.withLocks: payment rows carry `locked` (paymentLocks). Only the book read asks for it: it reads Pay_Requests. */
  function bookData(state, month, opts) {
    var withLocks = !!(opts && opts.withLocks);
    var entries = [], opening = 0, ix = index(state);
    (state.payments || []).forEach(function (p) {
      if (p.Source === 'Credit') return;
      var amt = Number(p.Amount) || 0;
      if (!p.Date) { opening += amt; return; }
      entries.push({ date: p.Date, kind: 'in', amount: amt, label: ((ix.cust[p.Customer_ID] || {}).Name || p.Customer_ID), method: p.Method || '', type: 'payment', id: p.Payment_ID,
        note: p.Note || '' });
    });
    (state.purchases || []).forEach(function (p) {
      var amt = Number(p.Amount) || 0;
      if (!p.Date || isOpening(p)) { opening -= amt; return; }
      entries.push({ date: p.Date, kind: 'out', amount: amt, label: p.Account_ID + ' renewal', method: p.Paid_With || '', type: 'purchase', id: p.Purchase_ID,
        accountId: p.Account_ID || '', coversUntil: p.Covers_Until || '', notes: p.Notes || '' });
    });
    (state.expenses || []).forEach(function (e) {
      var amt = Number(e.Amount) || 0;
      if (!e.Date) { opening -= amt; return; }
      entries.push({ date: e.Date, kind: 'out', amount: amt, label: e.Category + (e.Note ? ' · ' + e.Note : ''), method: e.Paid_With || '', type: 'expense', id: e.Expense_ID,
        category: e.Category || '', note: e.Note || '' });
    });
    entries.sort(function (a, b) { return Core.util.isoCompare(a.date, b.date) || (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1); });
    var months = {}, balance = opening, inM = 0, outM = 0, openM = null, list = [];
    entries.forEach(function (e) {
      var m = e.date.slice(0, 7); months[m] = true;
      if (m < month) balance += e.kind === 'in' ? e.amount : -e.amount;
    });
    openM = balance;
    var payById = {};
    (state.payments || []).forEach(function (p) { payById[p.Payment_ID] = p; });
    entries.forEach(function (e) {
      if (e.date.slice(0, 7) !== month) return;
      if (e.kind === 'in') inM += e.amount; else outM += e.amount;
      balance += e.kind === 'in' ? e.amount : -e.amount;
      var row = Object.assign({ balance: r2(balance) }, e);
      if (e.type === 'payment' && withLocks) row.locked = Core.sales.paymentLocks(state, payById[e.id]);
      list.push(row);
    });
    months[state.today.slice(0, 7)] = true;
    return { month: month, opening: r2(openM), in: r2(inM), out: r2(outM), net: r2(inM - outM), closing: r2(openM + inM - outM),
             entries: list, months: Object.keys(months).sort().reverse(), legacyOpening: r2(opening) };
  }

  /**
   * One book entry in full. `input.log` is the row's Change_Log lines (the caller reads them; Core does no I/O),
   * newest first, with Time/Action/Field/Old/New keys.
   */
  function entryDetail(state, input) {
    var kind = input.kind, id = input.id, key = { payment: 'Payment_ID', expense: 'Expense_ID', purchase: 'Purchase_ID' }[kind];
    var list = { payment: state.payments, expense: state.expenses, purchase: state.purchases }[kind];
    if (!key) throw new Error('Unknown entry kind ' + kind + '.');
    var row = (list || []).filter(function (r) { return String(r[key]) === String(id); })[0];
    if (!row) throw new Error('Unknown ' + kind + ' ' + id + '.');
    var out = { kind: kind, row: row };
    var pick = function (arr, k, v) { return (arr || []).filter(function (r) { return String(r[k]) === String(v); })[0]; };
    if (kind === 'payment') {
      var c = pick(state.customers, 'Customer_ID', row.Customer_ID); if (c) out.customer = c;
      var sale = row.Sale_ID !== '' && row.Sale_ID !== undefined ? pick(state.sales, 'Sale_ID', row.Sale_ID) : null; if (sale) out.sale = sale;
      var trx = String(row.Transaction_ID || '').trim().toUpperCase();
      if (trx) {
        var ib = (state.inbox || []).filter(function (r) { return String(r.Transaction_ID || '').trim().toUpperCase() === trx; })[0];
        if (ib && ib.Raw_SMS) out.sms = ib.Raw_SMS;
      }
    } else if (row.Paid_With) {
      var w = pick(state.wallets, 'Wallet_ID', row.Paid_With); if (w) out.wallet = w;
    }
    out.audit = (input.log || []).map(function (l) {
      return { when: l.Time, action: l.Action, field: l.Field, old: l.Old, new: l.New };
    });
    return out;
  }

  function lookups(state) {
    var ix = index(state);
    var products = (state.products || []).filter(function (p) { return String(p.Active || 'Yes') !== 'No'; }).map(function (p) {
      return { id: p.Product_ID, name: p.Product_Name, category: p.Category, deliversAs: Core.sales.deliversAs(p), parentId: p.Parent_ID || '', letter: p.Letter, price: Number(p.Default_Price) || 0,
               cycle: Number(p.Billing_Cycle_Days) || 30, tplRenew: p.Template_Renew || '', tplDue: p.Template_Due || '',
               poolId: Core.sales.accountPoolId(state, p),
               slug: p.Slug || '', public: p.Public === true, description: p.Description || '', imagePath: p.Image_Path || '',
               sortOrder: Number(p.Sort_Order) || 0, publicPrice: p.Public_Price === '' || p.Public_Price === undefined ? '' : Number(p.Public_Price) };
    });
    var accounts = (state.accounts || []).filter(function (a) { return a.Account_Status !== 'Deleted'; }).map(function (a) {
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
    var gone = deletedIds(state);
    var lines = (state.sales || []).filter(function (s) { return s.Record_Status === 'Active' && !gone[s.Account_ID] && s.Sub_Code && Core.sales.deliversAs(ix.prod[s.Product_ID]) !== 'code'; })
      .map(function (s) { var r = saleRow(state, ix, s); return { subCode: r.subCode, saleId: r.saleId, customerId: r.customerId, name: r.name,
        productId: r.productId, productName: r.productName, accountId: r.accountId, price: r.price, paidTill: r.paidTill, daysLeft: r.daysLeft }; });
    var suppliers = (state.suppliers || []).map(function (s) {
      return { id: s.Supplier_ID, name: s.Name, contact: s.Contact || '', currency: s.Currency || 'BDT',
               markupPercent: Number(s.Markup_Percent) || 0, notes: s.Notes || '', contactChannel: s.Contact_Channel || '',
               products: (state.products || []).filter(function (p) { return p.Supplier_ID === s.Supplier_ID; })
                 .map(function (p) { return { id: p.Product_ID, name: p.Product_Name }; }) };
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
             expenseCategories: Core.sales.EXPENSE_CATEGORIES, templateDefaults: Core.reminders.DEFAULTS,
             settings: Object.assign({}, state.settings, { usdt_bdt_manual: state.settings.usdt_bdt_manual || '', bkash_number: state.settings.bkash_number || '', language: state.settings.language || 'en',
                         pay_base_url: state.settings.pay_base_url || '', pay_methods: state.settings.pay_methods === undefined ? 'bkash' : state.settings.pay_methods,
                         nagad_number: state.settings.nagad_number || '', upay_number: state.settings.upay_number || '', bank_name: state.settings.bank_name || '',
                         bank_account_name: state.settings.bank_account_name || '', bank_account_number: state.settings.bank_account_number || '',
                         bank_branch: state.settings.bank_branch || '', bank_note: state.settings.bank_note || '', bank_routing: state.settings.bank_routing || '',
                         pay_auto_verify: state.settings.pay_auto_verify === undefined ? 'bkash' : state.settings.pay_auto_verify,
                         msg_renew_en: state.settings.msg_renew_en || '', msg_renew_bn: state.settings.msg_renew_bn || '',
                         msg_due_en: state.settings.msg_due_en || '', msg_due_bn: state.settings.msg_due_bn || '',
                         grace_days: state.settings.grace_days, reminder_days_before: state.settings.reminder_days_before,
                         reminder_days_after: state.settings.reminder_days_after, due_reminder_every_days: state.settings.due_reminder_every_days,
                         tos_text: state.settings.tos_text || '', review_discord_url: state.settings.review_discord_url || '', review_facebook_url: state.settings.review_facebook_url || '',
                         pay_link_expiry_hours: state.settings.pay_link_expiry_hours || '', delivery_note: state.settings.delivery_note || '',
                         low_stock_threshold: state.settings.low_stock_threshold === undefined ? LOW_STOCK_DEFAULT : state.settings.low_stock_threshold }),
             pendingDeliveries: (state.deliveries || []).filter(function (d) { return d.Status === 'Pending'; }).length };
  }

  /** One product tab's content for the app (the sheet tab builds the same view by formula). */
  function productList(state, productId) {
    var ix = index(state);
    return (state.accounts || []).filter(function (a) { return a.Product_ID === productId && a.Account_Status !== 'Deleted'; }).map(function (a) {
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

  /** Which sales a period covers. `period` is a month ('YYYY-MM'), a { from, to } range of Sale_Date (inclusive, 'YYYY-MM-DD'), or empty for all. */
  function inPeriod(s, period) {
    if (!period) return true;
    if (typeof period === 'string') return String(s.Sale_Date || '').slice(0, 7) === period;
    return !!s.Sale_Date && s.Sale_Date >= period.from && s.Sale_Date <= period.to;
  }

  /** Profit per product category. With `month` ('YYYY-MM') only sales made in that month count; a { from, to } range works the same way. */
  function profitByFamily(state, month) {
    var ix = index(state);
    var groups = {};
    (state.sales || []).forEach(function (s) {
      if (Core.ledger.isVoided(s)) return;
      if (!inPeriod(s, month)) return;
      var p = ix.prod[s.Product_ID] || {};
      var cat = p.Category || 'Subscription';
      if (!groups[cat]) groups[cat] = { revenue: 0, cost: 0, uncollected: 0, rateMissing: false, products: {} };
      var rv = Core.ledger.saleRevenue(s, state.products), un = Core.ledger.uncollectedFor(s, state, ix.paid);
      groups[cat].revenue += rv; groups[cat].uncollected += un;
      var ci = Core.ledger.saleCostInfo(s, state);
      groups[cat].cost += ci.cost;
      var pg = groups[cat].products[s.Product_ID] || (groups[cat].products[s.Product_ID] = { productId: s.Product_ID, name: p.Product_Name || s.Product_ID, revenue: 0, cost: 0, uncollected: 0 });
      pg.revenue += rv; pg.cost += ci.cost; pg.uncollected += un;
      if (ci.rateMissing) groups[cat].rateMissing = true;
    });
    var out = [];
    for (var cat in groups) {
      var g = groups[cat];
      var rev = r2(g.revenue), cost = r2(g.cost), profit = r2(g.revenue - g.cost);
      var marginPct = rev > 0 ? Math.round(profit / rev * 10000) / 100 : 0;
      var prods = Object.keys(g.products).map(function (k) { var x = g.products[k]; return { productId: x.productId, name: x.name, revenue: r2(x.revenue), cost: r2(x.cost), profit: r2(x.revenue - x.cost),
          uncollected: r2(x.uncollected), collectedProfit: r2(x.revenue - x.cost - x.uncollected) }; })
        .sort(function (a, b) { return b.profit - a.profit; });
      out.push({ category: cat, revenue: rev, cost: cost, profit: profit, marginPct: marginPct, uncollected: r2(g.uncollected),
        collectedProfit: r2(g.revenue - g.cost - g.uncollected), rateMissing: g.rateMissing, products: prods });
    }
    out.sort(function (a, b) { return b.profit - a.profit; });
    return out;
  }


  /** Sum of the profitByFamily rows. uncollected is billed but unpaid; collectedProfit = profit - uncollected (profit actually received). */
  function profitTotals(families) {
    var t = { revenue: 0, cost: 0, profit: 0, uncollected: 0, collectedProfit: 0 };
    families.forEach(function (f) { Object.keys(t).forEach(function (k) { t[k] += f[k]; }); });
    Object.keys(t).forEach(function (k) { t[k] = r2(t[k]); });
    return t;
  }

  // Rows that stand for money received with no named user (migration fillers); folded into one line per account.
  function isUnattributed(name) { return /^(Unlogged payment|Bkash Recieve)/i.test(String(name || '')); }

  /** One block per account: who is on it, what they paid and owe, and whether the account earns its cost. */
  function accountsOverview(state) {
    var ix = index(state), groups = [], byProduct = {};
    var totals = { accounts: 0, slots: 0, used: 0, free: 0, collected: 0, cost: 0, due: 0, net: 0 };
    (state.accounts || []).forEach(function (a) {
      if (a.Account_Status === 'Deleted') return;
      var rows = [], collected = 0, due = 0, loose = { count: 0, amount: 0 };
      (state.sales || []).forEach(function (s) {
        if (s.Account_ID !== a.Account_ID || s.Record_Status !== 'Active') return;
        var r = saleRow(state, ix, s), paid = r2(ix.paid[s.Sale_ID] || 0);
        collected += paid; due += r.owes;
        if (isUnattributed(r.name)) { loose.count++; loose.amount = r2(loose.amount + paid); return; }
        rows.push({ saleId: r.saleId, subCode: r.subCode, customerId: r.customerId, name: r.name, profile: r.profile || '',
          productId: r.productId, productName: r.productName, accountId: r.accountId, status: r.status,
          price: r.price, months: r.months, paid: paid, owes: r.owes, paidTill: r.paidTill, daysLeft: r.daysLeft,
          notes: r.notes, costSnapshot: r.costSnapshot });
      });
      rows.sort(function (x, y) {
        var dx = x.daysLeft === null ? 1e9 : x.daysLeft, dy = y.daysLeft === null ? 1e9 : y.daysLeft;
        return dx - dy || x.saleId - y.saleId;
      });
      var cost = Number(a.Cycle_Cost) || 0, host = Core.sales.hostSeats(state, a), slots = Math.max(0, (Number(a.Slots) || 0) - host);
      var free = Math.max(0, Core.sales.freeSlots(state, a));
      var used = rows.filter(function (r) { return r.paidTill && r.daysLeft >= 0; }).length;
      var status = a.Account_Status || 'Active';
      var acct = { id: a.Account_ID, label: a.Account_Label, status: status, retired: status !== 'Active', host: host > 0, cost: r2(cost), slots: slots,
        used: Math.min(slots, used), free: free, renewalDate: a.Renewal_Date || '', notes: a.Notes || '', rawSlots: Number(a.Slots) || 0,
        retiredOn: ((/Retired (\d{4}-\d{2}-\d{2})/.exec(a.Notes || '') || [])[1]) || '',
        lastActive: rows.reduce(function (m, r) { return r.paidTill && r.paidTill > m ? r.paidTill : m; }, ''),
        daysLeft: a.Renewal_Date ? Core.util.daysBetween(state.today, a.Renewal_Date) : null,
        collected: r2(collected), due: r2(due), net: r2(collected - cost), rows: rows, unattributed: loose };
      var g = byProduct[a.Product_ID];
      if (!g) {
        g = byProduct[a.Product_ID] = { productId: a.Product_ID, productName: (ix.prod[a.Product_ID] || {}).Product_Name || a.Product_ID, accounts: [] };
        groups.push(g);
      }
      g.accounts.push(acct);
      totals.accounts++; totals.slots += slots; totals.used += acct.used; totals.free += acct.free;
      totals.collected += collected; totals.cost += cost; totals.due += due;
    });
    totals.collected = r2(totals.collected); totals.cost = r2(totals.cost); totals.due = r2(totals.due);
    totals.net = r2(totals.collected - totals.cost);
    groups.sort(function (x, y) { return x.productName < y.productName ? -1 : 1; });
    var gone = deletedIds(state), endedBy = {}, endedLines = [];
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status !== 'Ended' || gone[s.Account_ID]) return;
      var r = saleRow(state, ix, s), paid = r2(ix.paid[s.Sale_ID] || 0), cost = r2(Core.ledger.saleCostInfo(s, state).cost);
      var g = endedBy[s.Product_ID];
      if (!g) { g = endedBy[s.Product_ID] = { productId: s.Product_ID, productName: r.productName, lines: [], collected: 0, cost: 0, net: 0 }; endedLines.push(g); }
      g.lines.push({ saleId: r.saleId, subCode: r.subCode, customerId: r.customerId, name: r.name, accountId: r.accountId,
        endedOn: r.paidTill, collected: paid, cost: cost, net: r2(paid - cost) });
      g.collected = r2(g.collected + paid); g.cost = r2(g.cost + cost); g.net = r2(g.collected - g.cost);
    });
    endedLines.sort(function (x, y) { return x.productName < y.productName ? -1 : 1; });
    endedLines.forEach(function (g) { g.lines.sort(function (x, y) { return x.saleId - y.saleId; }); });
    groups.forEach(function (g) { g.accounts.sort(function (x, y) { return (x.retired - y.retired) || (x.id < y.id ? -1 : 1); }); });
    return { today: state.today, groups: groups, endedLines: endedLines, totals: totals };
  }

  // ── Inbox (uplift 4.1): every payment message, bounded ──────────────────────────────────────────────────────────
  var INBOX_DAYS = 90, INBOX_LIMIT = 300;
  var INBOX_STATUSES = ['Pending', 'Review', 'Matched', 'Auto-matched', 'Ignored'];

  /** Newest first (a blank date last), then transaction id descending. */
  function inboxNewestFirst(a, b) {
    if (a.received !== b.received) return a.received < b.received ? 1 : -1;
    return a.trx < b.trx ? 1 : a.trx > b.trx ? -1 : 0;
  }

  /**
   * The Inbox screen's rows. Bounded: every open message (Pending or Review) plus the messages received in the last `opts.days`
   * (default 90, 1 to 365). Newest first, at most INBOX_LIMIT rows. `opts.status` ('all' or one of INBOX_STATUSES) and `opts.q` (text
   * found in the transaction id, sender, counterparty or reference, or an amount) narrow the rows. Counts are per status over the window,
   * before those two filters, so a chip shows what the window holds. 'Auto-matched' is not stored: a Matched message whose transaction id
   * is on an Auto payment reads as Auto-matched. `matchable` is a row the Match sheet opens: open, not a wallet top-up, and with a transaction id
   * (the sheet finds its message by that id).
   * Returns { rows, counts: { total, Pending, Review, Matched, 'Auto-matched', Ignored }, matching, truncated }. Raw SMS is not returned.
   */
  function inboxRows(st, opts) {
    opts = opts || {};
    var days = opts.days === undefined ? INBOX_DAYS : Number(opts.days);
    if (!(days >= 1 && days <= 365 && Math.floor(days) === days)) throw new Error('Days must be a whole number from 1 to 365.');
    var status = opts.status === undefined || opts.status === null || opts.status === '' ? 'all' : String(opts.status);
    if (status !== 'all' && INBOX_STATUSES.indexOf(status) < 0) throw new Error('Unknown inbox status ' + status + '.');
    var q = String(opts.q === undefined || opts.q === null ? '' : opts.q).trim().toLowerCase();
    var autoTrx = {};
    (st.payments || []).forEach(function (p) {
      var t = String(p.Transaction_ID || '').trim().toUpperCase();
      if (p.Source === 'Auto' && t) autoTrx[t] = true;
    });
    var all = (st.inbox || []).map(function (r) {
      var trx = String(r.Transaction_ID || '').trim(), stored = String(r.Status || '');
      var topUp = Core.matching.rowType(r) === 'TopUp', open = stored === 'Pending' || stored === 'Review';
      var date = (/^(\d{4}-\d{2}-\d{2})/.exec(String(r.Received || '')) || [])[1] || '';
      return { trx: trx, received: String(r.Received || ''), date: date, amount: Number(r.Amount) || 0, sender: String(r.Sender || ''),
        counterparty: String(r.Counterparty || ''), reference: String(r.Reference || ''), method: String(r.Method || ''),
        status: stored === 'Matched' && autoTrx[trx.toUpperCase()] ? 'Auto-matched' : stored, topUp: topUp, open: open, matchable: open && !topUp && trx !== '' };
    });
    var windowRows = all.filter(function (x) { return x.open || (x.date !== '' && Core.util.daysBetween(x.date, st.today) <= days); });
    var counts = { total: windowRows.length };
    INBOX_STATUSES.forEach(function (s) { counts[s] = 0; });
    windowRows.forEach(function (x) { if (INBOX_STATUSES.indexOf(x.status) >= 0) counts[x.status]++; });

    var digits = q.replace(/\D/g, ''), amountText = q.replace(/[,\s৳]|tk/g, ''), amount = /^\d+(\.\d+)?$/.test(amountText) ? Number(amountText) : NaN;
    var hit = function (x) {
      if (!q) return true;
      if ([x.trx, x.sender, x.counterparty, x.reference].join(' ').toLowerCase().indexOf(q) >= 0) return true;
      if (isFinite(amount) && x.amount === amount) return true;
      return digits.length >= 3 && (x.sender + ' ' + x.counterparty).replace(/\D/g, '').indexOf(digits) >= 0;
    };
    var list = windowRows.filter(function (x) { return (status === 'all' || x.status === status) && hit(x); }).sort(inboxNewestFirst);
    var rows = list.slice(0, INBOX_LIMIT).map(function (x) {
      return { trx: x.trx, received: x.received, amount: x.amount, sender: x.sender, counterparty: x.counterparty, reference: x.reference,
        method: x.method, status: x.status, topUp: x.topUp, matchable: x.matchable };
    });
    return { rows: rows, counts: counts, matching: list.length, truncated: list.length > INBOX_LIMIT };
  }

  // ── Reminders queue (uplift 4.2): the Sent and Skipped lists, bounded ───────────────────────────────────────────────
  var REMINDER_LOG_DAYS = 60, REMINDER_LOG_LIMIT = 300;
  var REMINDER_LOG_STATUSES = ['sent', 'skipped'];

  /**
   * The Reminders screen's Sent and Skipped lists, from Reminders_Log. Only rows with status 'sent' or 'skipped' and a Date within
   * `opts.days` of st.today (default 60, 1 to 60) take part. `opts.status` ('all', 'sent' or 'skipped') narrows the rows. Counts are per
   * status over the window, before that filter, so each tab can show its count from one read. Newest first (date, then sale id
   * descending), at most REMINDER_LOG_LIMIT rows. Names come from Customers and products from the sale (Sales_Log, Product_Catalog).
   * Returns { status, rows: [{ saleId, customerId, name, productName, subCode, kind, channel, status, date }], counts: { sent, skipped },
   * matching, truncated }. The message text is not logged, so no row carries it.
   */
  function reminderLog(st, opts) {
    opts = opts || {};
    var days = opts.days === undefined ? REMINDER_LOG_DAYS : Number(opts.days);
    if (!(days >= 1 && days <= REMINDER_LOG_DAYS && Math.floor(days) === days)) throw new Error('Days must be a whole number from 1 to ' + REMINDER_LOG_DAYS + '.');
    var status = opts.status === undefined || opts.status === null || opts.status === '' ? 'all' : String(opts.status);
    if (status !== 'all' && REMINDER_LOG_STATUSES.indexOf(status) < 0) throw new Error('Unknown reminder status ' + status + '.');
    var cust = {}, sale = {}, prod = {};
    (st.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    (st.sales || []).forEach(function (s) { sale[String(s.Sale_ID)] = s; });
    (st.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    prod[Core.ledger.CUSTOM_ID] = Core.ledger.CUSTOM_PRODUCT;
    var counts = { sent: 0, skipped: 0 };
    var inWindow = (st.remindersLog || []).filter(function (l) {
      return REMINDER_LOG_STATUSES.indexOf(l.Status) >= 0 && Core.util.daysBetween(l.Date, st.today) <= days;
    });
    inWindow.forEach(function (l) { counts[l.Status]++; });
    var list = inWindow.filter(function (l) { return status === 'all' || l.Status === status; }).map(function (l) {
      var s = sale[String(l.Sale_ID)] || {}, p = prod[s.Product_ID] || {}, c = cust[l.Customer_ID] || {};
      var productName = s.Product_ID ? (Core.ledger.isCustom(s) ? (s.Notes || 'Custom sale') : (p.Product_Name || s.Product_ID)) : '';
      return { saleId: Number(l.Sale_ID), customerId: String(l.Customer_ID || ''), name: String(c.Name || s.Customer || ''),
        productName: String(productName), subCode: String(s.Sub_Code || ''), kind: String(l.Kind || ''), channel: String(l.Channel || ''),
        status: l.Status, date: String(l.Date || '') };
    }).sort(function (a, b) { return Core.util.isoCompare(b.date, a.date) || (b.saleId - a.saleId); });
    return { status: status, rows: list.slice(0, REMINDER_LOG_LIMIT), counts: counts, matching: list.length, truncated: list.length > REMINDER_LOG_LIMIT };
  }

  // ── Activity and Undo history (uplift 4.3): the newest change batches ───────────────────────────────────────────────
  var ACTIVITY_BATCHES = 100, ACTIVITY_FIELDS_SHOWN = 3;
  var ACTIVITY_TAB = { Customers: 'Customer', Sales_Log: 'Sale', Payments: 'Payment', Expenses: 'Expense', Purchases: 'Purchase', Accounts: 'Account',
    Wallets: 'Wallet', Product_Catalog: 'Product', Code_Inventory: 'Code', Payment_Inbox: 'Message', Settings: 'Setting', Reminders_Log: 'Reminder',
    Suppliers: 'Supplier', Pay_Requests: 'Pay link', Deliveries: 'Delivery', Goals: 'Goal', Budgets: 'Budget', Live_Rates: 'Rate', Pay_Intents: 'Pay page' };
  // The owner's words for each write action (the names the server writes to Change_Log). An action not listed reads as words.
  var ACTIVITY_ACTION = { newSale: 'New sale', customSale: 'Custom sale', renew: 'Renewal', pay: 'Got paid', edit: 'Edit', editPayment: 'Payment edited',
    deletePayment: 'Payment deleted', match: 'Payment matched', splitMatch: 'Payment split', ignoreInbox: 'Message ignored', deleteInbox: 'Message deleted',
    retireAccount: 'Account retired', endLine: 'Line ended', deleteAccount: 'Account deleted', addAccount: 'Account added', mergeCustomers: 'Customers merged',
    editExpense: 'Expense edited', deleteExpense: 'Expense deleted', addExpense: 'Expense added', editPurchase: 'Purchase edited',
    deletePurchase: 'Purchase deleted', addPurchase: 'Purchase added', addCodes: 'Codes added', addCodesBatch: 'Codes added', editBatch: 'Batch edited',
    deleteBatch: 'Batch deleted', addWallet: 'Wallet added', editSupplier: 'Supplier edited', deleteSupplier: 'Supplier deleted', addSupplier: 'Supplier added',
    saveGoal: 'Goal saved', deleteGoal: 'Goal deleted', saveBudget: 'Budget saved', deleteBudget: 'Budget deleted', saveTemplate: 'Message template saved',
    settings: 'Settings saved', addProduct: 'Product added', editProduct: 'Product edited', createPayRequest: 'Pay link created',
    cancelPayRequest: 'Pay link cancelled', gotPaidRequest: 'Pay link paid', setDelivery: 'Delivery updated', backfillPayTokens: 'Pay tokens added',
    autoMatch: 'Automatic match', autoExpire: 'Automatic expiry', remindSent: 'Reminder marked' };

  function activityLabel(action) {
    var a = String(action || '');
    if (/^undo:/.test(a)) return 'Undo';
    if (ACTIVITY_ACTION[a]) return ACTIVITY_ACTION[a];
    var words = a.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Change';
  }
  function activityField(f) { return String(f || '').replace(/_/g, ' ').toLowerCase(); }

  /**
   * The Activity screen's list: the newest change batches, newest first, from Change_Log lines. `lines` are the newest log lines first,
   * each with Time, Batch_ID, Action, Tab, Row_Key, Field (the Change_Log columns, capitalised). Lines with no batch id are skipped.
   * opts.limit (1 to 100, default 100) is how many batches to return. opts.truncated is true when the lines were cut off at a row limit:
   * the oldest batch may then be missing rows, so it is left out.
   * Each batch: { batchId, at, action (its label), summary (what it touched), rows (distinct rows), undone (an Undo was written for it),
   * undoable (the one Undo would reverse now: the newest batch that is not an Undo, not undone and not automatic), automatic (written by the
   * server, not the owner), reversal (an Undo itself) }. An Undo is named by its batch id in its action, so the list can show what it reversed.
   */
  function activityBatches(lines, opts) {
    opts = opts || {};
    var limit = opts.limit === undefined || opts.limit === null || opts.limit === '' ? ACTIVITY_BATCHES : Number(opts.limit);
    if (!(limit >= 1 && limit <= ACTIVITY_BATCHES && Math.floor(limit) === limit)) throw new Error('Limit must be a whole number from 1 to ' + ACTIVITY_BATCHES + '.');
    var order = [], by = {};
    (lines || []).forEach(function (l) {
      var id = String(l.Batch_ID || '');
      if (!id) return;
      if (!by[id]) { by[id] = { batchId: id, at: String(l.Time || ''), raw: String(l.Action || ''), lines: [] }; order.push(id); }
      by[id].lines.push(l);
    });
    if (opts.truncated && order.length) order.pop();
    var undone = {};
    order.forEach(function (id) { var m = /^undo:(.+)$/.exec(by[id].raw); if (m) undone[m[1]] = true; });
    var out = [], undoableSet = false;
    order.slice(0, limit).forEach(function (id) {
      var b = by[id], reversal = /^undo:/.test(b.raw), automatic = /^auto/.test(b.raw) || b.raw.indexOf(':') >= 0;   // audit-only lines (staff:, vault:, apiKey: ...) are never undoable either
      var rowOf = {}, rowList = [];
      // Lines come newest first; walked oldest first, rows and fields read in the order they were written.
      b.lines.slice().reverse().forEach(function (l) {
        var k = l.Tab + '|' + l.Row_Key;
        if (!rowOf[k]) { rowOf[k] = { tab: String(l.Tab), key: String(l.Row_Key), fields: [] }; rowList.push(rowOf[k]); }
        if (l.Field !== '(new row)' && l.Field !== '(deleted row)' && rowOf[k].fields.indexOf(activityField(l.Field)) < 0) rowOf[k].fields.push(activityField(l.Field));
      });
      var texts = rowList.slice(0, 2).map(function (r) {
        var shown = r.fields.slice(0, ACTIVITY_FIELDS_SHOWN);
        return (ACTIVITY_TAB[r.tab] || r.tab) + ' ' + r.key + (shown.length ? ' (' + shown.join(', ') + (r.fields.length > shown.length ? ' and more' : '') + ')' : '');
      });
      if (rowList.length > 2) texts.push('and ' + (rowList.length - 2) + ' more');
      var target = reversal ? b.raw.slice(5) : '';
      var summary = reversal ? 'Reversed: ' + (by[target] ? activityLabel(by[target].raw) : 'an earlier change') : texts.join(' · ');
      var can = !reversal && !automatic && !undone[id] && !undoableSet;
      if (can) undoableSet = true;
      out.push({ batchId: id, at: b.at, action: activityLabel(b.raw), summary: summary, rows: rowList.length, undone: !!undone[id],
                 undoable: can, automatic: automatic, reversal: reversal });
    });
    return { batches: out };
  }

  // ── Stock and capacity alerts (uplift 4.8) ─────────────────────────────────────────────────────────────────────────────
  var LOW_STOCK_DEFAULT = 3, RENEW_SOON_DAYS = 5;

  /** The low-stock threshold from settings.low_stock_threshold: a whole number from 0 up. Blank, missing or not a whole number means 3. */
  function lowStockThreshold(settings) {
    var raw = settings ? settings.low_stock_threshold : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') return LOW_STOCK_DEFAULT;
    var n = Number(raw);
    return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : LOW_STOCK_DEFAULT;
  }

  /**
   * The Today strip, the bell and the Accounts "Low stock" chip read these. One entry per item:
   *  - code_low: an active code product (Core.sales.deliversAs 'code') with unsold codes at or below the threshold. id is the product,
   *    count is the codes left (0 when none). A code is unsold when no non-void sale holds it and its Status is Available or blank,
   *    the same rule lookups uses.
   *  - account_full: an Active account of an active timed product (deliversAs 'account') with no free seat (freeSlots 0 or less).
   *  - account_renewing: an Active account whose Renewal_Date is 0 to RENEW_SOON_DAYS days after st.today.
   * The account kinds have id = Account_ID, label = the account label and count 1. Every entry has tab 'accounts'.
   * Order: code_low, then account_full, then account_renewing, each in the state's order.
   */
  function stockAlerts(st, settings) {
    var threshold = lowStockThreshold(settings || st.settings || {}), out = [], prod = {}, sold = {}, codesLeft = {};
    var live = function (p) { return !!p && String(p.Active || 'Yes') !== 'No'; };
    (st.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    (st.sales || []).forEach(function (s) { if (s.Code_ID && s.Record_Status !== 'Void') sold[s.Code_ID] = true; });
    (st.codes || []).forEach(function (c) {
      if (!sold[c.Code_ID] && (!c.Status || c.Status === 'Available')) codesLeft[c.Product_ID] = (codesLeft[c.Product_ID] || 0) + 1;
    });
    (st.products || []).forEach(function (p) {
      if (!live(p) || Core.sales.deliversAs(p) !== 'code') return;
      var n = codesLeft[p.Product_ID] || 0;
      if (n <= threshold) out.push({ kind: 'code_low', id: p.Product_ID, label: p.Product_Name || p.Product_ID, count: n, tab: 'accounts' });
    });
    (st.accounts || []).forEach(function (a) {
      if (a.Account_Status !== 'Active' || !live(prod[a.Product_ID]) || Core.sales.deliversAs(prod[a.Product_ID]) !== 'account') return;
      if (Core.sales.freeSlots(st, a) <= 0) out.push({ kind: 'account_full', id: a.Account_ID, label: a.Account_Label || a.Account_ID, count: 1, tab: 'accounts' });
    });
    (st.accounts || []).forEach(function (a) {
      if (a.Account_Status !== 'Active' || !a.Renewal_Date) return;
      var d = Core.util.daysBetween(st.today, a.Renewal_Date);
      if (d >= 0 && d <= RENEW_SOON_DAYS) out.push({ kind: 'account_renewing', id: a.Account_ID, label: a.Account_Label || a.Account_ID, count: 1, tab: 'accounts' });
    });
    return out;
  }

  return { homeData: homeData, duesList: duesList, customerData: customerData, bookData: bookData, entryDetail: entryDetail, lookups: lookups, productList: productList, profitByFamily: profitByFamily, profitTotals: profitTotals,
           profitSnapshotRow: profitSnapshotRow, previousMonth: previousMonth, accountsOverview: accountsOverview, inboxRows: inboxRows, reminderLog: reminderLog,
           activityBatches: activityBatches, stockAlerts: stockAlerts, lowStockThreshold: lowStockThreshold, LOW_STOCK_DEFAULT: LOW_STOCK_DEFAULT };
})();
if (typeof module !== 'undefined') module.exports = Core.views;

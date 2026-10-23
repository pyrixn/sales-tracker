/**
 * Core.sales: planners for every action that writes. Each returns {ops, result, errors}; when errors is non-empty, ops is [].
 * Planners never change `state`. Pass `_gen` (an IdGen) to share id counters when one action combines several planners.
 */
var Core = Core || {};
Core.sales = (function () {
  var U = function () { return Core.util; };
  var L = function () { return Core.ledger; };
  var r2 = function (n) { return Core.util.round2(n); };

  var EXPENSE_CATEGORIES = ['VPN', 'Phone', 'Ads', 'Tools', 'Other'];
  var STATUSES = ['Active', 'Renewed', 'Refunded', 'Void'];
  var SETTING_KEYS = ['bkash_number', 'reminder_days_before', 'reminder_days_after', 'due_reminder_every_days', 'grace_days',
                      'language', 'msg_renew_en', 'msg_renew_bn', 'msg_due_en', 'msg_due_bn', 'discord_enabled', 'pay_base_url', 'usdt_bdt_manual',
                      'auto_match_max_bdt'];
  var SALE_EDITABLE = ['Customer_ID', 'Contact', 'Account_ID', 'Unit_Price', 'Months', 'Paid_Till', 'Record_Status', 'Notes', 'Code_ID'];
  var CUSTOMER_EDITABLE = ['Name', 'Channel', 'Handle', 'Discord_User_ID', 'Notes'];

  function fail(msg) { return { ops: [], result: null, errors: [msg] }; }
  function done(ops, result) { return { ops: ops, result: result, errors: [] }; }
  function blank(v) { return v === '' || v === null || v === undefined; }
  function find(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function genOf(state, input) { return (input && input._gen) || Core.ids.IdGen(state); }
  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); }

  function amountError(a) {
    if (typeof a !== 'number' || !isFinite(a) || a <= 0) return 'Amount must be more than 0.';
    if (a >= 1000000) return 'Amount must be less than 1,000,000.';
    return null;
  }
  function monthsError(m) {
    return (typeof m === 'number' && m === Math.floor(m) && m >= 1 && m <= 12) ? null : 'Months must be a whole number from 1 to 12.';
  }
  function priceError(p) {
    if (typeof p !== 'number' || !isFinite(p) || p < 0) return 'Price must be 0 or more.';
    if (p >= 1000000) return 'Price must be less than 1,000,000.';
    return null;
  }

  /** Slots in use: Active sales on the account whose Paid_Till is today or later (same rule as Accounts!Active_Slots). */
  function freeSlots(state, account) {
    var used = 0;
    (state.sales || []).forEach(function (s) {
      if (s.Account_ID === account.Account_ID && s.Record_Status === 'Active' && s.Paid_Till && s.Paid_Till >= state.today) used++;
    });
    return Number(account.Slots || 0) - used;
  }

  function codeSold(state, codeId) {
    return (state.sales || []).some(function (s) { return s.Code_ID === codeId && s.Record_Status !== 'Void'; });
  }

  function trxTaken(state, trx) {
    if (!trx) return false;
    var t = String(trx).trim().toUpperCase();
    return (state.payments || []).some(function (p) { return String(p.Transaction_ID || '').trim().toUpperCase() === t; });
  }

  /** Payments rows for `amount`: fill `targets` ({saleId, balance}) in order; anything left is credit (blank Sale_ID). */
  function paymentOps(state, gen, p, targets) {
    var alloc = L().allocate(p.amount, targets), ops = [], ids = [];
    function row(saleId, amount) {
      var id = gen.payment(); ids.push(id);
      ops.push({ op: 'append', tab: 'Payments', values: {
        Payment_ID: id, Date: p.date || state.today, Customer_ID: p.customerId, Sale_ID: saleId, Amount: amount,
        Method: p.method || '', Transaction_ID: p.trxId ? String(p.trxId).trim().toUpperCase() : '', Source: p.source || 'App', Note: p.note || '' } });
    }
    alloc.applied.forEach(function (a) { row(a.saleId, a.amount); });
    if (alloc.rest > 0) row('', alloc.rest);
    return { ops: ops, applied: alloc.applied, credit: alloc.rest, ids: ids };
  }

  function creditPair(state, gen, customerId, saleId, amount) {
    var base = { Date: state.today, Customer_ID: customerId, Method: '', Transaction_ID: '', Source: 'Credit', Note: 'Credit used' };
    return [
      { op: 'append', tab: 'Payments', values: Object.assign({ Payment_ID: gen.payment(), Sale_ID: '', Amount: -amount }, base) },
      { op: 'append', tab: 'Payments', values: Object.assign({ Payment_ID: gen.payment(), Sale_ID: saleId, Amount: amount }, base) }
    ];
  }

  function checkPaidNow(state, paidNow) {
    if (!paidNow) return null;
    var e = amountError(paidNow.amount);
    if (e) return e;
    if (trxTaken(state, paidNow.trxId)) return 'Transaction ' + String(paidNow.trxId).trim().toUpperCase() + ' is already recorded.';
    return null;
  }

  // ---------------------------------------------------------------- new sale
  function planNewSale(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product) return fail('Unknown product ' + input.productId + '.');
    var isCode = product.Category === 'Game Code';

    var customer = null, newCust = null;
    if (input.customerId) {
      customer = find(state.customers, 'Customer_ID', input.customerId);
      if (!customer) return fail('Unknown customer ' + input.customerId + '.');
    } else if (input.newCustomer && String(input.newCustomer.name || '').trim()) {
      var nm = String(input.newCustomer.name).trim().replace(/\s+/g, ' ');
      var clash = (state.customers || []).filter(function (c) { return String(c.Name).trim().toLowerCase() === nm.toLowerCase(); })[0];
      if (clash) return fail('A customer named "' + clash.Name + '" already exists. Pick them from the list.');
      newCust = { name: nm, channel: input.newCustomer.channel || '', handle: String(input.newCustomer.handle || '').trim() };
    } else {
      return fail('Pick a customer or type a new name.');
    }

    var account = null, code = null;
    if (isCode) {
      code = find(state.codes, 'Code_ID', input.codeId);
      if (!code) return fail('Pick a code.');
      if (code.Product_ID !== product.Product_ID) return fail(code.Code_ID + ' is not a ' + product.Product_ID + ' code.');
      if (codeSold(state, code.Code_ID) || (code.Status && code.Status !== 'Available')) return fail(code.Code_ID + ' is already sold.');
    } else {
      if (!input.accountId) return fail('Pick an account.');
      account = find(state.accounts, 'Account_ID', input.accountId);
      if (!account || account.Product_ID !== product.Product_ID) return fail(input.accountId + ' is not a ' + product.Product_ID + ' account.');
      if (account.Account_Status === 'Banned' || account.Account_Status === 'Closed') return fail(account.Account_ID + ' is marked ' + account.Account_Status + '.');
      if (freeSlots(state, account) <= 0 && input.allowFull !== true) return fail(account.Account_ID + ' has no free slot. Pick another account or add one.');
    }

    var months = isCode ? 1 : (blank(input.months) ? 1 : input.months);
    var e = monthsError(months); if (e) return fail(e);
    var price = blank(input.price) ? Number(product.Default_Price || 0) : input.price;
    e = priceError(price); if (e) return fail(e);
    e = checkPaidNow(state, input.paidNow); if (e) return fail(e);

    var gen = genOf(state, input), ops = [];
    var customerId = customer ? customer.Customer_ID : gen.customer();
    var name = customer ? customer.Name : newCust.name;
    if (newCust) {
      ops.push({ op: 'append', tab: 'Customers', values: { Customer_ID: customerId, Name: name, Channel: newCust.channel,
        Handle: newCust.handle, Discord_User_ID: '', Notes: '', Created: state.today } });
    }
    var saleId = gen.sale(), subCode = gen.subCode(product.Letter || 'X');
    var buyCurr = String(input.buyCurrency || 'BDT').toUpperCase();
    var buyUsdt = input.buyPriceUSDT !== undefined && input.buyPriceUSDT !== '' ? Number(input.buyPriceUSDT) : '';
    var sale = { Sale_ID: saleId, Sale_Date: state.today, Customer: name, Contact: String(input.profile || '').trim(),
      Product_ID: product.Product_ID, Account_ID: account ? account.Account_ID : '', Code_ID: code ? code.Code_ID : '',
      Qty: 1, Unit_Price: price,
      Paid_Till: isCode ? '' : U().addCycle(state.today, months, Number(product.Billing_Cycle_Days) || 30),
      Record_Status: 'Active', Notes: String(input.notes || ''), Customer_ID: customerId, Months: months, Sub_Code: subCode,
      Pay_Token: gen.payToken(),
      Cost_Snapshot: account ? account.Cost_Per_Slot : Number(product.Unit_Cost || 0) };
    if (buyUsdt !== '') sale.Buy_Price_USDT = buyUsdt;
    if (input.buyCurrency && buyCurr !== 'BDT') sale.Buy_Currency = buyCurr;
    ops.push({ op: 'append', tab: 'Sales_Log', values: sale });

    if (input.paidNow) {
      var revenue = r2(price * months);
      var pay = paymentOps(state, gen, { customerId: customerId, amount: input.paidNow.amount, method: input.paidNow.method,
        trxId: input.paidNow.trxId, source: input.source || 'App' }, revenue > 0 ? [{ saleId: saleId, balance: revenue }] : []);
      ops = ops.concat(pay.ops);
    }
    return done(ops, { saleId: saleId, customerId: customerId, subCode: subCode });
  }

  // ---------------------------------------------------------------- renew
  function planRenew(state, input) {
    var line = Core.refs.subCodeLine(state, input.subCode);
    var latest = line.latest;
    if (!latest) return fail('No active subscription has the code ' + input.subCode + '.');
    var product = find(state.products, 'Product_ID', latest.Product_ID);
    if (!product) return fail('Unknown product ' + latest.Product_ID + '.');
    if (product.Category === 'Game Code') return fail('Game codes are not renewed. Use New sale.');
    var account = find(state.accounts, 'Account_ID', latest.Account_ID);
    if (account && (account.Account_Status === 'Banned' || account.Account_Status === 'Closed')) {
      return fail(account.Account_ID + ' is marked ' + account.Account_Status + '. Move the customer to another account first.');
    }
    var months = blank(input.months) ? 1 : input.months;
    var e = monthsError(months); if (e) return fail(e);
    var price = blank(input.price) ? L().salePrice(latest, state.products) : input.price;
    e = priceError(price); if (e) return fail(e);
    e = checkPaidNow(state, input.paidNow); if (e) return fail(e);

    var gen = genOf(state, input), ops = [];
    ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: latest.Sale_ID, values: { Record_Status: 'Renewed' } });
    var start = U().renewalStart(latest.Paid_Till, state.today, state.settings.grace_days);
    var saleId = gen.sale();
    ops.push({ op: 'append', tab: 'Sales_Log', values: {
      Sale_ID: saleId, Sale_Date: state.today, Customer: latest.Customer, Contact: latest.Contact, Product_ID: latest.Product_ID,
      Account_ID: latest.Account_ID, Code_ID: '', Qty: 1, Unit_Price: price,
      Paid_Till: U().addCycle(start, months, Number(product.Billing_Cycle_Days) || 30), Record_Status: 'Active', Notes: '',
      Customer_ID: latest.Customer_ID, Months: months, Sub_Code: latest.Sub_Code,
      Pay_Token: latest.Pay_Token || gen.payToken(),
      Cost_Snapshot: account ? account.Cost_Per_Slot : Number(product.Unit_Cost || 0) } });

    var due = r2(price * months);
    if (input.applyCredit !== false) {
      var credit = Math.min(L().creditOf(state, latest.Customer_ID), due);
      if (credit > 0) { ops = ops.concat(creditPair(state, gen, latest.Customer_ID, saleId, r2(credit))); due = r2(due - credit); }
    }
    if (input.paidNow) {
      var pay = paymentOps(state, gen, { customerId: latest.Customer_ID, amount: input.paidNow.amount, method: input.paidNow.method,
        trxId: input.paidNow.trxId, source: input.source || 'App' }, due > 0 ? [{ saleId: saleId, balance: due }] : []);
      ops = ops.concat(pay.ops);
    }
    return done(ops, { saleId: saleId, previousSaleId: latest.Sale_ID, customerId: latest.Customer_ID, subCode: latest.Sub_Code });
  }

  /** One-off: give every line (Sub_Code) that has sales without a Pay_Token one shared random token. */
  function planBackfillPayTokens(state) {
    var gen = genOf(state, null), byLine = {}, ops = [];
    (state.sales || []).forEach(function (s) {
      if (!s.Sub_Code) return;
      if (s.Pay_Token) byLine[s.Sub_Code] = s.Pay_Token;
    });
    (state.sales || []).forEach(function (s) {
      if (!s.Sub_Code || s.Pay_Token) return;
      if (!byLine[s.Sub_Code]) byLine[s.Sub_Code] = gen.payToken();
      ops.push({ op: 'update', tab: 'Sales_Log', id: s.Sale_ID, values: { Pay_Token: byLine[s.Sub_Code] } });
    });
    return done(ops, { updated: ops.length });
  }

  // ---------------------------------------------------------------- payment
  function planPayment(state, input) {
    var customer = find(state.customers, 'Customer_ID', input.customerId);
    if (!customer) return fail('Unknown customer ' + input.customerId + '.');
    var e = amountError(input.amount); if (e) return fail(e);
    if (trxTaken(state, input.trxId)) return fail('Transaction ' + String(input.trxId).trim().toUpperCase() + ' is already recorded.');
    var targets;
    if (!blank(input.saleId)) {
      var sale = find(state.sales, 'Sale_ID', Number(input.saleId));
      if (!sale || sale.Customer_ID !== customer.Customer_ID) return fail('Sale ' + input.saleId + ' does not belong to ' + customer.Name + '.');
      var bal = L().saleBalance(sale, state);
      targets = bal > 0 ? [{ saleId: sale.Sale_ID, balance: bal }] : [];
    } else {
      targets = L().openDues(state, customer.Customer_ID);
    }
    var pay = paymentOps(state, genOf(state, input), { customerId: customer.Customer_ID, amount: input.amount, method: input.method,
      trxId: input.trxId, source: input.source || 'App', date: input.date, note: input.note }, targets);
    return done(pay.ops, { applied: pay.applied, credit: pay.credit, paymentIds: pay.ids });
  }

  // ---------------------------------------------------------------- edit
  function planEdit(state, input) {
    var values = input.values || {}, keys = Object.keys(values), out = {};
    if (input.kind === 'customer') {
      var c = find(state.customers, 'Customer_ID', input.id);
      if (!c) return fail('Unknown customer ' + input.id + '.');
      for (var i = 0; i < keys.length; i++) {
        if (CUSTOMER_EDITABLE.indexOf(keys[i]) < 0) return fail(keys[i] + " can't be edited here.");
        out[keys[i]] = typeof values[keys[i]] === 'string' ? values[keys[i]].trim() : values[keys[i]];
      }
      if ('Name' in out && !out.Name) return fail('Name cannot be empty.');
      return done(keys.length ? [{ op: 'update', tab: 'Customers', key: 'Customer_ID', id: c.Customer_ID, values: out }] : [], { id: c.Customer_ID });
    }
    var sale = find(state.sales, 'Sale_ID', Number(input.id));
    if (!sale) return fail('Unknown sale ' + input.id + '.');
    for (var k = 0; k < keys.length; k++) {
      var f = keys[k], v = values[f];
      if (SALE_EDITABLE.indexOf(f) < 0) return fail(f + " can't be edited here.");
      if (f === 'Record_Status' && STATUSES.indexOf(v) < 0) return fail('Status must be Active, Renewed, Refunded or Void.');
      if (f === 'Months') { var me = monthsError(v); if (me) return fail(me); }
      if (f === 'Unit_Price') { var pe = priceError(v); if (pe) return fail(pe); }
      if (f === 'Paid_Till' && v !== '' && !isIso(v)) return fail('Paid_Till must be a date like 2026-10-18.');
      out[f] = typeof v === 'string' ? v.trim() : v;
    }
    if ('Customer_ID' in out) {
      var nc = find(state.customers, 'Customer_ID', out.Customer_ID);
      if (!nc) return fail('Unknown customer ' + out.Customer_ID + '.');
      out.Customer = nc.Name;
    }
    if ('Account_ID' in out && out.Account_ID) {
      var acc = find(state.accounts, 'Account_ID', out.Account_ID);
      if (!acc || acc.Product_ID !== sale.Product_ID) return fail(out.Account_ID + ' is not a ' + sale.Product_ID + ' account.');
      out.Cost_Snapshot = acc.Cost_Per_Slot;
    }
    if ('Code_ID' in out && out.Code_ID && out.Code_ID !== sale.Code_ID) {
      var code = find(state.codes, 'Code_ID', out.Code_ID);
      if (!code || code.Product_ID !== sale.Product_ID) return fail(out.Code_ID + ' is not a ' + sale.Product_ID + ' code.');
      if (codeSold(state, code.Code_ID)) return fail(code.Code_ID + ' is already sold.');
      var prod = find(state.products, 'Product_ID', sale.Product_ID);
      out.Cost_Snapshot = Number((prod && prod.Unit_Cost) || 0);
    }
    return done(Object.keys(out).length ? [{ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: sale.Sale_ID, values: out }] : [], { id: sale.Sale_ID });
  }

  // ---------------------------------------------------------------- money out and setup
  function walletError(state, w) {
    if (blank(w)) return null;
    return find(state.wallets, 'Wallet_ID', w) ? null : 'Unknown wallet ' + w + '.';
  }

  function planExpense(state, input) {
    if (EXPENSE_CATEGORIES.indexOf(input.category) < 0) return fail('Category must be one of: ' + EXPENSE_CATEGORIES.join(', ') + '.');
    var e = amountError(input.amount) || walletError(state, input.paidWith); if (e) return fail(e);
    var date = input.date || state.today;
    if (!isIso(date)) return fail('Date must be like 2026-10-18.');
    var gen = genOf(state, input);
    return done([{ op: 'append', tab: 'Expenses', values: { Expense_ID: gen.expense(), Date: date, Category: input.category,
      Amount: input.amount, Paid_With: input.paidWith || '', Note: String(input.note || '').trim() } }], null);
  }

  function nextAccountId(state, product) {
    var mine = (state.accounts || []).filter(function (a) { return a.Product_ID === product.Product_ID; });
    var prefix = mine.length ? String(mine[0].Account_ID).split('-')[0] : String(product.Product_ID).replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
    var max = 0;
    (state.accounts || []).forEach(function (a) {
      var m = new RegExp('^' + prefix + '-(\\d+)$').exec(a.Account_ID);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    });
    var n = String(max + 1); while (n.length < 2) n = '0' + n;
    return prefix + '-' + n;
  }

  function planAccount(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product) return fail('Unknown product ' + input.productId + '.');
    if (!String(input.label || '').trim()) return fail('Give the account a label, e.g. its login email.');
    var e = amountError(input.cycleCost) || walletError(state, input.paidWith); if (e) return fail(e);
    if (!(input.slots >= 1 && input.slots === Math.floor(input.slots) && input.slots <= 50)) return fail('Slots must be a whole number from 1 to 50.');
    if (input.renewalDate && !isIso(input.renewalDate)) return fail('Renewal date must be like 2026-10-18.');
    var gen = genOf(state, input), id = nextAccountId(state, product);
    return done([
      { op: 'append', tab: 'Accounts', values: { Account_ID: id, Product_ID: product.Product_ID, Account_Label: String(input.label).trim(),
        Cycle_Cost: input.cycleCost, Renewal_Date: input.renewalDate || '', Slots: input.slots, Notes: String(input.notes || ''), Account_Status: 'Active' } },
      { op: 'append', tab: 'Purchases', values: { Purchase_ID: gen.purchase(), Date: state.today, Account_ID: id, Paid_With: input.paidWith || '',
        Amount: input.cycleCost, Covers_Until: input.renewalDate || '', Notes: 'First purchase' } }
    ], { accountId: id });
  }

  function planPurchase(state, input) {
    var acc = find(state.accounts, 'Account_ID', input.accountId);
    if (!acc) return fail('Unknown account ' + input.accountId + '.');
    var e = amountError(input.amount) || walletError(state, input.paidWith); if (e) return fail(e);
    if (input.coversUntil && !isIso(input.coversUntil)) return fail('Covers until must be like 2026-10-18.');
    var gen = genOf(state, input), ops = [
      { op: 'append', tab: 'Purchases', values: { Purchase_ID: gen.purchase(), Date: input.date || state.today, Account_ID: acc.Account_ID,
        Paid_With: input.paidWith || '', Amount: input.amount, Covers_Until: input.coversUntil || '', Notes: String(input.notes || '') } }];
    var upd = { Cycle_Cost: input.amount };
    if (input.coversUntil) upd = { Renewal_Date: input.coversUntil, Cycle_Cost: input.amount };
    ops.push({ op: 'update', tab: 'Accounts', key: 'Account_ID', id: acc.Account_ID, values: upd });
    return done(ops, { accountId: acc.Account_ID });
  }

  function planProduct(state, input) {
    var name = String(input.name || '').trim();
    if (!name) return fail('Give the product a name.');
    var pid = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!pid) return fail('The name needs at least one letter or number.');
    var clash = (state.products || []).filter(function (p) { return p.Product_ID === pid || String(p.Product_Name).toLowerCase() === name.toLowerCase(); })[0];
    if (clash) return fail('A product ' + clash.Product_ID + ' already exists.');
    var category = input.category === 'Game Code' ? 'Game Code' : 'Subscription';
    var letter = String(input.letter || '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return fail('Pick one letter A-Z for its reference codes.');
    var used = (state.products || []).filter(function (p) { return p.Letter === letter; })[0];
    if (used && !(letter === 'G' && category === 'Game Code' && used.Category === 'Game Code')) return fail('Letter ' + letter + ' is already used by ' + used.Product_ID + '.');
    var price = input.price;
    var e = priceError(price); if (e) return fail(e);
    var values = { Product_ID: pid, Product_Name: name, Category: category, Platform: name, Active: 'Yes', Letter: letter, Default_Price: price };
    if (category === 'Subscription') {
      if (!(input.cycleDays >= 1 && input.cycleDays <= 400)) return fail('Renews every must be 1-400 days.');
      if (!(input.slots >= 1 && input.slots <= 50)) return fail('People per account must be 1-50.');
      e = amountError(input.accountCost); if (e) return fail(e);
      values.Billing_Cycle_Days = input.cycleDays; values.Account_Cost = input.accountCost; values.Slots_Per_Account = input.slots;
    } else {
      values.Code_Unit_Cost = blank(input.codeCost) ? 0 : input.codeCost;
    }
    return done([{ op: 'append', tab: 'Product_Catalog', values: values }], { productId: pid, tabName: name });
  }

  /** Bulk placeholders for on-demand gift cards: qty rows with empty Code, Status 'Pending', one batch. */
  function planSupplierEdit(state, input) {
    var cur = find(state.suppliers, 'Supplier_ID', input.supplierId);
    if (!cur) return fail('Unknown supplier ' + input.supplierId + '.');
    var values = {};
    if (input.name !== undefined) {
      var name = String(input.name).trim();
      if (!name) return fail('Give the supplier a name.');
      var clash = (state.suppliers || []).filter(function (s) {
        return s.Supplier_ID !== cur.Supplier_ID && String(s.Name).trim().toLowerCase() === name.toLowerCase(); })[0];
      if (clash) return fail('A supplier named "' + clash.Name + '" already exists.');
      values.Name = name;
    }
    if (input.contact !== undefined) values.Contact = String(input.contact).trim();
    if (input.currency !== undefined) {
      if (input.currency !== 'USDT' && input.currency !== 'BDT') return fail('Currency must be USDT or BDT.');
      values.Currency = input.currency;
    }
    if (input.markupPercent !== undefined) {
      var mk = Number(input.markupPercent);
      if (!isFinite(mk) || mk < 0 || mk > 999) return fail('Markup must be a number from 0 to 999.');
      values.Markup_Percent = mk;
    }
    if (input.notes !== undefined) values.Notes = String(input.notes).trim();
    if (!Object.keys(values).length) return done([], { supplierId: cur.Supplier_ID });
    return done([{ op: 'update', tab: 'Suppliers', id: cur.Supplier_ID, values: values }], { supplierId: cur.Supplier_ID });
  }

  function planSupplierDelete(state, input) {
    var cur = find(state.suppliers, 'Supplier_ID', input.supplierId);
    if (!cur) return fail('Unknown supplier ' + input.supplierId + '.');
    var used = (state.products || []).filter(function (p) { return p.Supplier_ID === cur.Supplier_ID; }).length;
    if (used) return fail('Cannot delete ' + cur.Name + ': ' + used + ' product' + (used === 1 ? '' : 's') + ' still use it.');
    return done([{ op: 'clear', tab: 'Suppliers', id: cur.Supplier_ID }], { supplierId: cur.Supplier_ID });
  }

  function batchCodes(state, batchId) {
    var id = String(batchId || '').trim();
    if (!id) return [];
    return (state.codes || []).filter(function (c) { return c.Batch_ID === id; });
  }

  function planBatchEdit(state, input) {
    var rows = batchCodes(state, input.batchId);
    if (!rows.length) return fail('Unknown batch ' + input.batchId + '.');
    var tag = String(input.tag || '').trim();
    if (!tag) return fail('Give the batch a tag.');
    return done(rows.map(function (c) { return { op: 'update', tab: 'Code_Inventory', id: c.Code_ID, values: { 'Source / Batch': tag } }; }),
      { batchId: input.batchId, updated: rows.length });
  }

  function planBatchDelete(state, input) {
    var rows = batchCodes(state, input.batchId);
    if (!rows.length) return fail('Unknown batch ' + input.batchId + '.');
    var sold = rows.filter(function (c) { return c.Status === 'Sold'; }).length;
    if (sold) return fail('Cannot delete batch ' + input.batchId + ': ' + sold + ' code' + (sold === 1 ? ' is' : 's are') + ' already sold.');
    return done(rows.map(function (c) { return { op: 'clear', tab: 'Code_Inventory', id: c.Code_ID }; }),
      { batchId: input.batchId, removed: rows.length });
  }

  function planAddCodesBatch(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product) return fail('Unknown product ' + input.productId + '.');
    var qty = Number(input.quantity);
    if (!(qty >= 1 && qty === Math.floor(qty) && qty <= 1000)) return fail('Quantity must be a whole number from 1 to 1000.');
    var gen = genOf(state, input);
    var ops = [], batchId = String(input.batchId || 'BATCH-' + String(Date.now())).trim();
    for (var i = 0; i < qty; i++) {
      ops.push({ op: 'append', tab: 'Code_Inventory', values: { Code_ID: gen.code(), Product_ID: product.Product_ID,
        Code: '', 'Source / Batch': batchId, Date_Added: state.today, Manual_Flag: '', Status: 'Pending', Batch_ID: batchId } });
    }
    return done(ops, { added: qty, batchId: batchId });
  }

  function planAddCodes(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product || product.Category !== 'Game Code') return fail('Pick a game code product.');
    var seen = {}, skipped = [], ops = [], gen = genOf(state, input);
    (state.codes || []).forEach(function (c) { seen[String(c.Code).trim().toLowerCase()] = true; });
    (input.codes || []).forEach(function (raw) {
      var code = String(raw || '').trim();
      if (!code) return;
      if (seen[code.toLowerCase()]) { skipped.push(code); return; }
      seen[code.toLowerCase()] = true;
      ops.push({ op: 'append', tab: 'Code_Inventory', values: { Code_ID: gen.code(), Product_ID: product.Product_ID, Code: code,
        'Source / Batch': String(input.batch || 'Added in app'), Date_Added: state.today } });
    });
    if (!ops.length && !skipped.length) return fail('Paste at least one code.');
    return done(ops, { added: ops.length, skipped: skipped });
  }

  var WALLET_TYPES = ['Card', 'bKash', 'Nagad', 'Supplier credit', 'Cash', 'Other'];
  var WALLET_PREFIX = { 'Card': 'CARD', 'bKash': 'BKASH', 'Nagad': 'NAGAD', 'Supplier credit': 'SUPPLIER', 'Cash': 'CASH', 'Other': 'OTHER' };
  /** Only the last 4 digits are ever stored, never a full card or phone number. */
  /** Add or update a supplier. input: {name, contact, currency, markup_percent, notes}. */
  function planSupplier(state, input) {
    var name = String(input.name || '').trim();
    if (!name) return fail('Give the supplier a name.');
    var clash = (state.suppliers || []).filter(function (s) { return String(s.Name).trim().toLowerCase() === name.toLowerCase(); })[0];
    if (clash) return fail('A supplier named "' + clash.Name + '" already exists.');
    var max = 0;
    (state.suppliers || []).forEach(function (s) {
      var m = /^SUP-(\d+)$/.exec(String(s.Supplier_ID || ''));
      if (m && Number(m[1]) > max) max = Number(m[1]);
    });
    var id = 'SUP-' + pad(max + 1, 4);
    function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
    return done([{ op: 'append', tab: 'Suppliers', values: {
      Supplier_ID: id, Name: name, Contact: String(input.contact || '').trim(),
      Currency: input.currency === 'USDT' ? 'USDT' : 'BDT',
      Markup_Percent: Number(input.markup_percent) || 0, Notes: String(input.notes || '').trim()
    } }], { supplierId: id });
  }

  function planWallet(state, input) {
    if (WALLET_TYPES.indexOf(input.type) < 0) return fail('Type must be one of: ' + WALLET_TYPES.join(', ') + '.');
    var last4 = String(input.last4 || '').replace(/\D/g, '');
    if (last4.length > 4) return fail('Enter only the last 4 digits.');
    if (!String(input.label || '').trim()) return fail('Give the wallet a name.');
    var id = WALLET_PREFIX[input.type] + (last4 ? '-' + last4 : '-' + String(input.label).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
    if (find(state.wallets, 'Wallet_ID', id)) return fail('Wallet ' + id + ' already exists.');
    return done([{ op: 'append', tab: 'Wallets', values: { Wallet_ID: id, Label: String(input.label).trim(), Type: input.type, Notes: String(input.notes || '') } }], { walletId: id });
  }

  function planSettings(state, input) {
    var ops = [], keys = Object.keys(input || {});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === '_gen') continue;
      if (SETTING_KEYS.indexOf(keys[i]) < 0) return fail('Unknown setting ' + keys[i] + '.');
      if (keys[i] === 'usdt_bdt_manual' && String(input[keys[i]]).trim() !== '') {
        var mr = Number(String(input[keys[i]]).trim());
        if (!(isFinite(mr) && mr > 0 && mr < 100000)) return fail('Manual rate must be a number above 0, or blank to use the live rate.');
      }
      ops.push({ op: 'update', tab: 'Settings', key: 'Key', id: keys[i], values: { Value: input[keys[i]] } });
    }
    return done(ops, null);
  }

  return { planSupplierEdit: planSupplierEdit, planSupplierDelete: planSupplierDelete, planBatchEdit: planBatchEdit,
           planBatchDelete: planBatchDelete, planBackfillPayTokens: planBackfillPayTokens, planNewSale: planNewSale, planRenew: planRenew, planPayment: planPayment, planEdit: planEdit,
           planExpense: planExpense, planAccount: planAccount, planPurchase: planPurchase, planProduct: planProduct,
           planAddCodes: planAddCodes, planAddCodesBatch: planAddCodesBatch, planSupplier: planSupplier,
           planSettings: planSettings, planWallet: planWallet, WALLET_TYPES: WALLET_TYPES,
           freeSlots: freeSlots, paymentOps: paymentOps, creditPair: creditPair,
           EXPENSE_CATEGORIES: EXPENSE_CATEGORIES, SETTING_KEYS: SETTING_KEYS, STATUSES: STATUSES };
})();
if (typeof module !== 'undefined') module.exports = Core.sales;

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
  var STATUSES = ['Active', 'Renewed', 'Refunded', 'Void', 'Ended'];
  /** Any setting key is editable: a lowercase identifier. Values are text, capped in length. */
  var SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
  var SETTING_VALUE_MAX = 5000;
  var SALE_EDITABLE = ['Customer_ID', 'Contact', 'Account_ID', 'Unit_Price', 'Months', 'Paid_Till', 'Record_Status', 'Notes', 'Code_ID', 'Cost_Snapshot', 'Sale_Date', 'Covers_From', 'Qty'];
  var CUSTOMER_EDITABLE = ['Name', 'Channel', 'Handle', 'Discord_User_ID', 'Notes'];
  var ACCOUNT_EDITABLE = ['Account_Label', 'Cycle_Cost', 'Renewal_Date', 'Slots', 'Notes', 'Account_Status'];
  var ACCOUNT_STATUSES = ['Active', 'Inactive', 'Banned', 'Closed', 'Deleted'];

  /** 'code' or 'account'. Uses Delivers_As; rows without it fall back to the old Game Code category. */
  function deliversAs(p) {
    var d = p && p.Delivers_As;
    if (d === 'code' || d === 'account' || d === 'custom') return d;
    return p && p.Category === 'Game Code' ? 'code' : 'account';
  }

  function fail(msg) { return { ops: [], result: null, errors: [msg] }; }
  function done(ops, result) { return { ops: ops, result: result, errors: [] }; }
  function blank(v) { return v === '' || v === null || v === undefined; }
  function find(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function genOf(state, input) { return (input && input._gen) || Core.ids.IdGen(state); }
  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); }
  /** A date that exists on the calendar: 2026-02-30 and 2026-13-45 look like dates but are not. */
  function isRealDate(v) {
    if (!isIso(v)) return false;
    var p = String(v).split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

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
  /** Seats on this account kept for the host's own login (setting host_seats: comma list of product ids). Never sold. */
  function hostSeats(state, account) {
    var list = String((state.settings || {}).host_seats || '').split(',').map(function (x) { return x.trim(); });
    return list.indexOf(account.Product_ID) >= 0 ? 1 : 0;
  }

  /** Sellable seats still free. An account that is not Active (retired, banned) has none. */
  function freeSlots(state, account) {
    if (account.Account_Status && account.Account_Status !== 'Active') return 0;
    var used = 0;
    (state.sales || []).forEach(function (s) {
      if (s.Account_ID === account.Account_ID && s.Record_Status === 'Active' && s.Paid_Till && s.Paid_Till >= state.today) used++;
    });
    return Number(account.Slots || 0) - hostSeats(state, account) - used;
  }

  /** The product whose accounts a product sells from. A product with its own accounts (or no parent) uses its own id;
   *  a variant with no accounts of its own (for example a 1-day rent of ExitLag) sells from its parent's accounts. */
  function accountPoolId(state, product) {
    var pid = product.Product_ID;
    if ((state.accounts || []).some(function (a) { return a.Product_ID === pid; })) return pid;
    if (product.Parent_ID && find(state.products, 'Product_ID', product.Parent_ID)) return product.Parent_ID;
    return pid;
  }

  /** Free, sellable accounts of the pool, in Account_ID order. freeSlots already gives 0 to any non-Active account. */
  function freeAccountsIn(state, poolId) {
    return (state.accounts || []).filter(function (a) { return a.Product_ID === poolId && freeSlots(state, a) > 0; })
      .sort(function (a, b) { return a.Account_ID < b.Account_ID ? -1 : a.Account_ID > b.Account_ID ? 1 : 0; });
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
    if (!String(p.customerId || '').trim()) return { ops: [], applied: [], credit: 0, ids: [], errors: ['A payment needs a customer.'] };
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

  // input._role is set by the server from the sign-in; no _role means a direct core call, treated as the owner.
  function nonOwner(input) { return input && input._role !== undefined && input._role !== 'owner'; }

  /** A total for all months (input.total) becomes the per-month Unit_Price: total / (months x qty), kept to 6 decimals so
   *  saleRevenue (rounded to 2) gives back exactly the total. Returns { price } or { error }. Staff must match catalog x months x qty. */
  function priceFromTotal(input, months, qty, catalogPrice) {
    var t = input.total;
    if (typeof t !== 'number' || !isFinite(t) || t <= 0) return { error: 'Total must be more than 0.' };
    if (t >= 1000000) return { error: 'Total must be less than 1,000,000.' };
    if (nonOwner(input) && r2(t) !== r2(Number(catalogPrice) * months * qty)) return { error: 'Only the owner can set a custom price.' };
    return { price: Math.round(t / (months * qty) * 1e6) / 1e6 };
  }

  // ---------------------------------------------------------------- new sale
  function planNewSale(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product) return fail('Unknown product ' + input.productId + '.');
    var isCode = deliversAs(product) === 'code';

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
      var pool = accountPoolId(state, product);
      if (!input.accountId) {
        if (pool === product.Product_ID) return fail('Pick an account.');
        var candidates = freeAccountsIn(state, pool);
        if (!candidates.length) {
          var poolProduct = find(state.products, 'Product_ID', pool) || product;
          return fail('No free seat on any ' + poolProduct.Product_Name + ' account. Add one, or wait for a seat to free up.');
        }
        account = candidates[(input._rand || U().randomInt)(candidates.length)];
      } else {
        account = find(state.accounts, 'Account_ID', input.accountId);
        if (!account || account.Product_ID !== pool) return fail(input.accountId + ' is not a ' + pool + ' account.');
        if (account.Account_Status === 'Banned' || account.Account_Status === 'Closed' || account.Account_Status === 'Deleted') return fail(account.Account_ID + ' is marked ' + account.Account_Status + '.');
        if (freeSlots(state, account) <= 0 && input.allowFull !== true) return fail(account.Account_ID + ' has no free slot. Pick another account or add one.');
      }
    }

    var months = isCode ? 1 : (blank(input.months) ? 1 : input.months);
    var e = monthsError(months); if (e) return fail(e);
    var price = blank(input.price) ? Number(product.Default_Price || 0) : input.price;
    if (!blank(input.total)) { var pt = priceFromTotal(input, months, 1, product.Default_Price || 0); if (pt.error) return fail(pt.error); price = pt.price; }
    e = priceError(price); if (e) return fail(e);
    if (nonOwner(input)) {
      if (blank(input.total) && !blank(input.price) && r2(Number(input.price)) !== r2(Number(product.Default_Price || 0))) return fail('Only the owner can set a custom price.');
      if (!blank(input.cost)) return fail('Only the owner can set a custom cost.');
      if (input.allowFull === true) return fail('Only the owner can add past a full account.');
    }
    var costIn = blank(input.cost) ? null : input.cost;
    if (costIn !== null && (typeof costIn !== 'number' || !isFinite(costIn) || costIn < 0 || costIn >= 1000000)) return fail('Cost must be 0 or more.');
    e = checkPaidNow(state, input.paidNow); if (e) return fail(e);

    var gen = genOf(state, input), ops = [];
    var customerId = customer ? customer.Customer_ID : gen.customer();
    var name = customer ? customer.Name : newCust.name;
    if (newCust) {
      ops.push({ op: 'append', tab: 'Customers', values: { Customer_ID: customerId, Name: name, Channel: newCust.channel,
        Handle: newCust.handle, Discord_User_ID: '', Notes: '', Created: state.today } });
    }
    var saleId = gen.sale();
    var subCode = ((state.settings || {}).ref_style === 'random') ? gen.ref(input._rand) : gen.subCode(product.Letter || 'X');
    var buyCurr = String(input.buyCurrency || 'BDT').toUpperCase();
    var buyUsdt = input.buyPriceUSDT !== undefined && input.buyPriceUSDT !== '' ? Number(input.buyPriceUSDT) : '';
    var sale = { Sale_ID: saleId, Sale_Date: state.today, Customer: name, Contact: String(input.profile || '').trim(),
      Product_ID: product.Product_ID, Account_ID: account ? account.Account_ID : '', Code_ID: code ? code.Code_ID : '',
      Qty: 1, Unit_Price: price,
      Paid_Till: isCode ? '' : U().addCycle(state.today, months, Number(product.Billing_Cycle_Days) || 30),
      Covers_From: isCode ? '' : state.today,
      Record_Status: 'Active', Notes: String(input.notes || ''), Customer_ID: customerId, Months: months, Sub_Code: subCode,
      Pay_Token: gen.payToken(),
      Cost_Snapshot: costIn !== null ? costIn : (account ? account.Cost_Per_Slot : Number(product.Unit_Cost || 0)) };
    if (buyUsdt !== '') sale.Buy_Price_USDT = buyUsdt;
    if (input.buyCurrency && buyCurr !== 'BDT') sale.Buy_Currency = buyCurr;
    ops.push({ op: 'append', tab: 'Sales_Log', values: sale });

    if (input.paidNow) {
      var revenue = r2(price * months);
      var pay = paymentOps(state, gen, { customerId: customerId, amount: input.paidNow.amount, method: input.paidNow.method,
        trxId: input.paidNow.trxId, source: input.source || 'App' }, revenue > 0 ? [{ saleId: saleId, balance: revenue }] : []);
      ops = ops.concat(pay.ops);
    }
    return done(ops, { saleId: saleId, customerId: customerId, subCode: subCode, accountId: account ? account.Account_ID : '' });
  }

  // ---------------------------------------------------------------- custom sale
  /** A free-text item with no product, account, code or delivery. A Sales_Log row with Product_ID CUSTOM and the title in Notes. */
  function planCustomSale(state, input) {
    if (nonOwner(input)) return fail('Only the owner can add a custom sale.');
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

    var title = String(blank(input.title) ? '' : input.title).trim().replace(/\s+/g, ' ');
    if (!title || title.length > 80) return fail('Give the item a name (up to 80 characters).');
    var price = input.price;
    var e = amountError(price); if (e) return fail(e);
    var cost = blank(input.cost) ? 0 : input.cost;
    if (typeof cost !== 'number' || !isFinite(cost) || cost < 0) return fail('Cost must be 0 or more.');
    if (cost >= 1000000) return fail('Cost must be less than 1,000,000.');
    var date = blank(input.date) ? state.today : input.date;
    if (!isRealDate(date)) return fail('Date must be like 2026-10-18.');
    e = checkPaidNow(state, input.paidNow); if (e) return fail(e);

    var gen = genOf(state, input), ops = [];
    var customerId = customer ? customer.Customer_ID : gen.customer();
    var name = customer ? customer.Name : newCust.name;
    if (newCust) {
      ops.push({ op: 'append', tab: 'Customers', values: { Customer_ID: customerId, Name: name, Channel: newCust.channel,
        Handle: newCust.handle, Discord_User_ID: '', Notes: '', Created: state.today } });
    }
    var saleId = gen.sale();
    ops.push({ op: 'append', tab: 'Sales_Log', values: { Sale_ID: saleId, Sale_Date: date, Customer: name, Contact: '',
      Product_ID: 'CUSTOM', Account_ID: '', Code_ID: '', Qty: 1, Unit_Price: price, Paid_Till: '', Record_Status: 'Active',
      Notes: title, Customer_ID: customerId, Months: 1, Sub_Code: '', Pay_Token: '', Cost_Snapshot: cost } });
    if (input.paidNow) {
      var pay = paymentOps(state, gen, { customerId: customerId, amount: input.paidNow.amount, method: input.paidNow.method,
        trxId: input.paidNow.trxId, source: input.source || 'App', date: date }, [{ saleId: saleId, balance: r2(price) }]);
      ops = ops.concat(pay.ops);
    }
    return done(ops, { saleId: saleId, customerId: customerId });
  }

  // ---------------------------------------------------------------- renew
  function planRenew(state, input) {
    var line = Core.refs.subCodeLine(state, input.subCode);
    var latest = line.latest;
    if (!latest) return fail('No active subscription has the code ' + input.subCode + '.');
    var product = find(state.products, 'Product_ID', latest.Product_ID);
    if (!product) return fail('Unknown product ' + latest.Product_ID + '.');
    if (deliversAs(product) === 'code') return fail('Game codes are not renewed. Use New sale.');
    var account = find(state.accounts, 'Account_ID', latest.Account_ID);
    if (account && (account.Account_Status === 'Banned' || account.Account_Status === 'Closed' || account.Account_Status === 'Deleted')) {
      return fail(account.Account_ID + ' is marked ' + account.Account_Status + '. Move the customer to another account first.');
    }
    var months = blank(input.months) ? 1 : input.months;
    var e = monthsError(months); if (e) return fail(e);
    var price = blank(input.price) ? L().salePrice(latest, state.products) : input.price;
    if (!blank(input.total)) { var pt = priceFromTotal(input, months, 1, L().salePrice(latest, state.products)); if (pt.error) return fail(pt.error); price = pt.price; }
    e = priceError(price); if (e) return fail(e);
    if (nonOwner(input)) {
      if (blank(input.total) && !blank(input.price) && r2(Number(input.price)) !== r2(Number(L().salePrice(latest, state.products)))) return fail('Only the owner can set a custom price.');
      if (!blank(input.paidTill)) return fail('Only the owner can set a custom Paid_Till.');
    }
    e = checkPaidNow(state, input.paidNow); if (e) return fail(e);

    var gen = genOf(state, input), ops = [];
    ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: latest.Sale_ID, values: { Record_Status: 'Renewed' } });
    var cycle = Number(product.Billing_Cycle_Days) || 30;
    var fromRule = blank(input.from) ? 'auto' : input.from;
    if (['auto', 'oldPaidTill', 'today'].indexOf(fromRule) < 0) return fail('From must be auto, oldPaidTill or today.');
    var start = fromRule === 'today' ? state.today
      : fromRule === 'oldPaidTill' ? (latest.Paid_Till || state.today)
      : U().renewalStart(latest.Paid_Till, state.today, state.settings.grace_days);
    var till = U().addCycle(start, months, cycle);
    if (!blank(input.paidTill)) {
      if (!isRealDate(input.paidTill)) return fail('Paid till must be a date like 2026-10-18.');
      if (input.paidTill <= start) return fail('Paid till must be after ' + start + '.');
      till = input.paidTill;
    }
    var saleId = gen.sale();
    ops.push({ op: 'append', tab: 'Sales_Log', values: {
      Sale_ID: saleId, Sale_Date: state.today, Customer: latest.Customer, Contact: latest.Contact, Product_ID: latest.Product_ID,
      Account_ID: latest.Account_ID, Code_ID: '', Qty: 1, Unit_Price: price,
      Paid_Till: till, Covers_From: start, Record_Status: 'Active', Notes: '',
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
    return done(ops, { saleId: saleId, previousSaleId: latest.Sale_ID, customerId: latest.Customer_ID, subCode: latest.Sub_Code,
      paidTill: till, start: start });
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
      // Named sale: take what is still uncollected on it, so a payment for an Ended line stays on that line instead of turning into credit.
      var bal = L().uncollectedFor(sale, state);
      targets = bal > 0 ? [{ saleId: sale.Sale_ID, balance: bal }] : [];
    } else {
      targets = L().openDues(state, customer.Customer_ID);
    }
    var pay = paymentOps(state, genOf(state, input), { customerId: customer.Customer_ID, amount: input.amount, method: input.method,
      trxId: input.trxId, source: input.source || 'App', date: input.date, note: input.note }, targets);
    return done(pay.ops, { applied: pay.applied, credit: pay.credit, paymentIds: pay.ids });
  }

  // ---------------------------------------------------------------- edit
  // Fields a non-owner may not change through edit: money, and anything that voids or removes a row. input._role is set by the server
  // from the signed-in caller (never from the client); no _role means a direct core call, treated as the owner.
  var OWNER_ONLY_ACCOUNT = ['Cycle_Cost', 'Account_Status'];
  var OWNER_ONLY_SALE = ['Customer_ID', 'Unit_Price', 'Total', 'Cost_Snapshot', 'Qty', 'Months', 'Sale_Date', 'Covers_From', 'Account_ID', 'Code_ID'];
  var OWNER_ONLY_SALE_STATUS = ['Void', 'Refunded'];
  function ownerOnlyError(state, input, values, keys) {
    if (input._role === undefined || input._role === 'owner') return null;
    for (var i = 0; i < keys.length; i++) {
      var f = keys[i], bad = false;
      if (input.kind === 'account') bad = OWNER_ONLY_ACCOUNT.indexOf(f) >= 0;
      else if (input.kind !== 'customer') bad = OWNER_ONLY_SALE.indexOf(f) >= 0 || (f === 'Record_Status' && OWNER_ONLY_SALE_STATUS.indexOf(values[f]) >= 0);
      if (!bad && f === 'Record_Status' && input.kind !== 'account' && input.kind !== 'customer') {
        var cs = find(state.sales, 'Sale_ID', Number(input.id));
        if (cs && (cs.Record_Status === 'Void' || cs.Record_Status === 'Refunded' || cs.Record_Status === 'Renewed') && values[f] !== cs.Record_Status) bad = true;
        else if (cs && values[f] === 'Ended' && cs.Record_Status !== 'Ended') {
          var owed = L().saleBalance(cs, state);
          if (owed > 0) return 'Only the owner can end a line that still owes ' + owed + '.';
        }
      }
      if (bad) return 'Only the owner can change ' + f + '.';
    }
    return null;
  }
  function planEdit(state, input) {
    var values = input.values || {}, keys = Object.keys(values), out = {};
    var denied = ownerOnlyError(state, input, values, keys);
    if (denied) return fail(denied);
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
    if (input.kind === 'account') {
      var ac = find(state.accounts, 'Account_ID', input.id);
      if (!ac) return fail('Unknown account ' + input.id + '.');
      for (var j = 0; j < keys.length; j++) {
        var af = keys[j], av = values[af];
        if (ACCOUNT_EDITABLE.indexOf(af) < 0) return fail(af + " can't be edited here.");
        if (af === 'Account_Label' && !String(av).trim()) return fail('The account needs a name or login label.');
        if (af === 'Cycle_Cost' && !(isFinite(Number(av)) && Number(av) >= 0 && String(av).trim() !== '')) return fail('Cost must be a number, 0 or more.');
        if (af === 'Slots' && !(Number.isInteger(Number(av)) && Number(av) >= 1 && Number(av) <= 20)) return fail('Seats must be a whole number from 1 to 20.');
        if (af === 'Renewal_Date' && av !== '' && !isRealDate(av)) return fail('Renewal date must be a date like 2026-10-18.');
        if (af === 'Account_Status' && ACCOUNT_STATUSES.indexOf(av) < 0) return fail('Status must be Active, Inactive, Banned, Closed or Deleted.');
        out[af] = typeof av === 'string' ? av.trim() : av;
      }
      return done(keys.length ? [{ op: 'update', tab: 'Accounts', key: 'Account_ID', id: ac.Account_ID, values: out }] : [], { id: ac.Account_ID });
    }
    var sale = find(state.sales, 'Sale_ID', Number(input.id));
    if (!sale) return fail('Unknown sale ' + input.id + '.');
    var custom = L().isCustom(sale);
    if ('Total' in values) {
      // Total for all months -> Unit_Price = Total / (Months x Qty), using the Months/Qty in this edit or the sale's own.
      if ('Unit_Price' in values) return fail('Give a price per month or a total, not both.');
      var tm = 'Months' in values ? values.Months : sale.Months, tq = 'Qty' in values ? values.Qty : sale.Qty;
      var tmErr = monthsError(tm); if (tmErr) return fail(tmErr);
      if (!(typeof tq === 'number' && Number.isInteger(tq) && tq >= 1 && tq <= 100)) return fail('Quantity must be a whole number from 1 to 100.');
      var tp = priceFromTotal({ total: values.Total }, tm, tq, 0);
      if (tp.error) return fail(tp.error);
      values = Object.assign({}, values); delete values.Total; values.Unit_Price = tp.price; keys = Object.keys(values);
    }
    for (var k = 0; k < keys.length; k++) {
      var f = keys[k], v = values[f];
      if (SALE_EDITABLE.indexOf(f) < 0) return fail(f + " can't be edited here.");
      if (custom && f === 'Paid_Till' && !blank(v)) return fail('A custom sale has no end date.');
      if (custom && (f === 'Account_ID' || f === 'Code_ID') && !blank(v)) return fail('A custom sale has no account or code.');
      if (f === 'Record_Status' && STATUSES.indexOf(v) < 0) return fail('Status must be Active, Renewed, Refunded, Void or Ended.');
      if (f === 'Months') { var me = monthsError(v); if (me) return fail(me); }
      if (f === 'Unit_Price') { var pe = priceError(v); if (pe) return fail(pe); }
      if (f === 'Paid_Till' && v !== '' && !isRealDate(v)) return fail('Paid_Till must be a date like 2026-10-18.');
      if (f === 'Paid_Till' && nonOwner(input) && !blank(v) && (blank(sale.Paid_Till) || String(v) > String(sale.Paid_Till))) return fail('Only the owner can extend Paid_Till.');
      if (f === 'Paid_Till' && blank(v) && !custom && deliversAs(find(state.products, 'Product_ID', sale.Product_ID)) !== 'code') {
        return fail('Paid till cannot be blank: a line with no end date is never counted as active. Enter a date like 2026-10-18.');
      }
      if (f === 'Sale_Date' && !isRealDate(v)) return fail('Sale date must be a date like 2026-10-18.');
      if (f === 'Covers_From' && !blank(v) && !isRealDate(v)) return fail('Covers from must be a date like 2026-10-18.');
      if (f === 'Qty' && !(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100)) return fail('Quantity must be a whole number from 1 to 100.');
      if (f === 'Cost_Snapshot' && !(typeof v === 'number' && isFinite(v) && v >= 0)) return fail('Cost must be a number, 0 or more.');
      out[f] = typeof v === 'string' ? v.trim() : v;
    }
    if ('Customer_ID' in out) {
      var nc = find(state.customers, 'Customer_ID', out.Customer_ID);
      if (!nc) return fail('Unknown customer ' + out.Customer_ID + '.');
      out.Customer = nc.Name;
    }
    if ('Account_ID' in out && out.Account_ID) {
      var acc = find(state.accounts, 'Account_ID', out.Account_ID);
      var saleProduct = find(state.products, 'Product_ID', sale.Product_ID) || { Product_ID: sale.Product_ID };
      var pool = accountPoolId(state, saleProduct);
      if (!acc || acc.Product_ID !== pool) return fail(out.Account_ID + ' is not a ' + pool + ' account.');
      if (acc.Account_Status === 'Deleted') return fail(acc.Account_ID + ' is deleted.');
      if (!('Cost_Snapshot' in values)) out.Cost_Snapshot = acc.Cost_Per_Slot;
    }
    if ('Code_ID' in out && out.Code_ID && out.Code_ID !== sale.Code_ID) {
      var code = find(state.codes, 'Code_ID', out.Code_ID);
      if (!code || code.Product_ID !== sale.Product_ID) return fail(out.Code_ID + ' is not a ' + sale.Product_ID + ' code.');
      if (codeSold(state, code.Code_ID) || (code.Status && code.Status !== 'Available')) return fail(code.Code_ID + ' is already sold.');
      var prod = find(state.products, 'Product_ID', sale.Product_ID);
      if (!('Cost_Snapshot' in values)) out.Cost_Snapshot = Number((prod && prod.Unit_Cost) || 0);
    }
    return done(Object.keys(out).length ? [{ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: sale.Sale_ID, values: out }] : [], { id: sale.Sale_ID });
  }

  /**
   * Take an account out of service. Its sales and profit stay on record (the Retired list shows them by product).
   * With moveEntries, receipts of its sales that have no date and its cost entries dated after `date` are dated `date`,
   * so the book shows the account's profit in the last month it was active.
   */
  function planRetireAccount(state, input) {
    var acc = find(state.accounts, 'Account_ID', input.accountId);
    if (!acc) return fail('Unknown account ' + input.accountId + '.');
    if (acc.Account_Status && acc.Account_Status !== 'Active') return fail(acc.Account_ID + ' is already ' + acc.Account_Status.toLowerCase() + '.');
    var date = String(input.date || '').trim();
    if (!isIso(date)) return fail('Pick the last day the account was in use, as a date like 2026-10-18.');
    var note = String(acc.Notes || '').trim();
    var ops = [{ op: 'update', tab: 'Accounts', key: 'Account_ID', id: acc.Account_ID,
      values: { Account_Status: 'Inactive', Notes: (note ? note + ' · ' : '') + 'Retired ' + date } }];
    var movedPayments = 0, movedPurchases = 0;
    if (input.moveEntries !== false) {
      var mine = {};
      (state.sales || []).forEach(function (s) { if (s.Account_ID === acc.Account_ID) mine[s.Sale_ID] = true; });
      (state.payments || []).forEach(function (p) {
        if (mine[p.Sale_ID] && !p.Date) { ops.push({ op: 'update', tab: 'Payments', key: 'Payment_ID', id: p.Payment_ID, values: { Date: date } }); movedPayments++; }
      });
      (state.purchases || []).forEach(function (p) {
        if (p.Account_ID === acc.Account_ID && (!p.Date || p.Date > date)) { ops.push({ op: 'update', tab: 'Purchases', key: 'Purchase_ID', id: p.Purchase_ID, values: { Date: date } }); movedPurchases++; }
      });
    }
    return done(ops, { accountId: acc.Account_ID, movedPayments: movedPayments, movedPurchases: movedPurchases });
  }

  /** End one subscription line on `date`. Keeps its payments and cost on record; the Retired log shows collected, cost and net. */
  function planEndLine(state, input) {
    var sale = find(state.sales, 'Sale_ID', Number(input.saleId));
    if (!sale) return fail('Unknown sale ' + input.saleId + '.');
    if (sale.Record_Status !== 'Active') return fail('Sale ' + sale.Sale_ID + ' is already ' + String(sale.Record_Status).toLowerCase() + '.');
    var date = String(input.date || '').trim();
    if (!isIso(date)) return fail('Pick the last day of the line, as a date like 2026-10-18.');
    if (input._role !== undefined && input._role !== 'owner') {
      var owedNow = L().saleBalance(sale, state);
      if (owedNow > 0) return fail('Only the owner can end a line that still owes ' + owedNow + '.');
    }
    var collected = r2(L().salePaid(sale, state)), cost = r2(L().saleCostInfo(sale, state).cost);
    return done([{ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: sale.Sale_ID, values: { Record_Status: 'Ended', Paid_Till: date } }],
      { saleId: sale.Sale_ID, collected: collected, cost: cost, net: r2(collected - cost) });
  }

  /** Remove an account from every list but keep its sales, purchases and payments in profit and the book. */
  function planDeleteAccount(state, input) {
    var acc = find(state.accounts, 'Account_ID', input.accountId);
    if (!acc) return fail('Unknown account ' + input.accountId + '.');
    if (acc.Account_Status === 'Deleted') return fail(acc.Account_ID + ' is already deleted.');
    var live = (state.sales || []).filter(function (s) {
      return s.Account_ID === acc.Account_ID && s.Record_Status === 'Active' && s.Paid_Till && s.Paid_Till >= state.today;
    }).length;
    if (live) return fail(acc.Account_ID + ' still has ' + live + ' customer' + (live === 1 ? '' : 's') + ' using a seat. End or move ' + (live === 1 ? 'that line' : 'those lines') + ' first.');
    var ops = [{ op: 'update', tab: 'Accounts', key: 'Account_ID', id: acc.Account_ID, values: { Account_Status: 'Deleted' } }];
    // Expired lines still marked Active would stay renewable; end them (Paid_Till kept) so nothing can come back to this account.
    (state.sales || []).forEach(function (s) {
      if (s.Account_ID === acc.Account_ID && s.Record_Status === 'Active') ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: s.Sale_ID, values: { Record_Status: 'Ended' } });
    });
    return done(ops, { accountId: acc.Account_ID, endedLines: ops.length - 1 });
  }

  /** Move everything of customer `fromId` to `intoId`, note the source name on the target, and clear the source row. */
  function planMergeCustomers(state, input) {
    var from = find(state.customers, 'Customer_ID', input.fromId), into = find(state.customers, 'Customer_ID', input.intoId);
    if (!from) return fail('Unknown customer ' + input.fromId + '.');
    if (!into) return fail('Unknown customer ' + input.intoId + '.');
    if (from.Customer_ID === into.Customer_ID) return fail('Pick two different customers to merge.');
    var ops = [], moved = { sales: 0, payments: 0, reminders: 0 }, seen = {};
    (state.sales || []).forEach(function (s) {
      if (s.Customer_ID !== from.Customer_ID) return;
      ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: s.Sale_ID, values: { Customer_ID: into.Customer_ID, Customer: into.Name } }); moved.sales++;
    });
    (state.payments || []).forEach(function (p) {
      if (p.Customer_ID !== from.Customer_ID) return;
      ops.push({ op: 'update', tab: 'Payments', key: 'Payment_ID', id: p.Payment_ID, values: { Customer_ID: into.Customer_ID } }); moved.payments++;
    });
    (state.remindersLog || []).forEach(function (l) {
      // Reminders_Log rows share a Sale_ID per sale, and a sale has one customer, so one update per sale moves them all.
      if (l.Customer_ID !== from.Customer_ID || seen[l.Sale_ID]) return;
      seen[l.Sale_ID] = true;
      ops.push({ op: 'update', tab: 'Reminders_Log', key: 'Sale_ID', id: l.Sale_ID, values: { Customer_ID: into.Customer_ID } }); moved.reminders++;
    });
    var note = String(into.Notes || '').trim(), tag = 'Merged from ' + from.Name + ' (' + from.Customer_ID + ')';
    var contact = [from.Channel, from.Handle].filter(Boolean).join(' ');
    if (contact) tag += ' · ' + contact;
    if (from.Discord_User_ID) tag += ' · Discord ' + from.Discord_User_ID;
    ops.push({ op: 'update', tab: 'Customers', key: 'Customer_ID', id: into.Customer_ID, values: { Notes: note ? note + ' · ' + tag : tag } });
    ops.push({ op: 'clear', tab: 'Customers', key: 'Customer_ID', id: from.Customer_ID });
    return done(ops, { fromId: from.Customer_ID, intoId: into.Customer_ID, moved: moved });
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

  // ---------------------------------------------------------------- edit and delete money rows
  function isCreditUsedRow(p) { return p.Source === 'Credit' || Number(p.Amount) < 0; }

  /**
   * The Paid pay link that this payment confirmed, or undefined. Only the confirming money counts (and rows booked with its transaction id,
   * such as the overpaid credit), not later dues or renewals on the same sale. The confirming payment is the earliest one for that link
   * with a Transaction_ID; a link paid without any transaction id falls back to its earliest payment.
   */
  function confirmedLink(state, cur) {
    var D = Core.delivery, upperTrx = function (p) { return String(p.Transaction_ID || '').trim().toUpperCase(); };
    return (state.payRequests || []).filter(function (r) {
      if (r.Status !== 'Paid' || !D.paidFor(cur, r)) return false;
      var mine = (state.payments || []).filter(function (p) { return D.paidFor(p, r); });
      var first = mine.filter(function (p) { return upperTrx(p); })[0] || mine[0];
      if (!first) return false;
      var t = upperTrx(first);
      return cur.Payment_ID === first.Payment_ID || (!!t && upperTrx(cur) === t);
    })[0];
  }

  var CREDIT_USED_LOCK = 'Credit-used entries cannot be edited. Use Undo, or edit the original payment.';

  /** The pay request whose link lives in this payment's note alone (see Core.delivery.linkedByNote), or undefined. */
  function noteLink(state, p) {
    var D = Core.delivery;
    return (state.payRequests || []).filter(function (r) { return D.linkedByNote(p, r); })[0];
  }

  /**
   * Which fields of a payment can be changed now, with the reason for each one that cannot. The reads (customerData, bookData) send this
   * as `locked`, and the panel disables those cells. planEditPayment refuses the same edits with the same reasons, so the rules live here once.
   * Fields: amount, date, method, note. A field missing from the map is editable.
   */
  function paymentLocks(state, p) {
    var locked = {};
    if (isCreditUsedRow(p)) {
      ['amount', 'date', 'method', 'note'].forEach(function (f) { locked[f] = CREDIT_USED_LOCK; });
      return locked;
    }
    var lk = confirmedLink(state, p);
    if (lk) locked.amount = 'Confirmed pay link ' + lk.Request_ID + ' fixed this amount. Use Undo on the Got paid action instead.';
    var nl = noteLink(state, p);
    // Changing the note would unlink the row (and move the confirming payment), so it is fixed while the link holds.
    if (nl) locked.note = 'The note links this payment to pay link ' + nl.Request_ID + ', so it cannot be changed. Use Undo on the Got paid action instead.';
    return locked;
  }

  /**
   * Edit a payment. input: {paymentId, amount?, date?, method?, note?, transactionId?, saleId?}. saleId '' makes it credit.
   * Above the target sale's remaining balance, the excess is split off as a credit row (never a negative balance).
   * A field that paymentLocks locks is refused with the lock's reason when the edit would change it.
   */
  function planEditPayment(state, input) {
    var cur = find(state.payments, 'Payment_ID', input.paymentId);
    if (!cur) return fail('Unknown payment ' + input.paymentId + '.');
    if (isCreditUsedRow(cur)) return fail(CREDIT_USED_LOCK);
    var locks = paymentLocks(state, cur);
    var values = {};
    if (input._role !== undefined && input._role !== 'owner') {
      if (input.amount !== undefined && r2(Number(input.amount)) !== r2(Number(cur.Amount))) return fail('Only the owner can change Amount.');
      var curSk = blank(cur.Sale_ID) ? '' : String(cur.Sale_ID);
      if (input.saleId !== undefined && (blank(input.saleId) ? '' : String(input.saleId)) !== curSk) return fail('Only the owner can change Sale_ID.');
      if (input.customerId !== undefined && String(input.customerId) !== String(cur.Customer_ID)) return fail('Only the owner can change Customer_ID.');
    }
    var amount = input.amount !== undefined ? input.amount : Number(cur.Amount);
    var e = amountError(amount); if (e) return fail(e);
    amount = r2(amount);
    if (amount !== Number(cur.Amount) && locks.amount) return fail(locks.amount);
    var lk = confirmedLink(state, cur);
    if (lk) {
      var curSaleKey = blank(cur.Sale_ID) ? '' : String(cur.Sale_ID);
      var trxMoved = input.transactionId !== undefined && String(input.transactionId || '').trim().toUpperCase() !== String(cur.Transaction_ID || '').trim().toUpperCase();
      var saleMoved = input.saleId !== undefined && (blank(input.saleId) ? '' : String(input.saleId)) !== curSaleKey;
      if (trxMoved || saleMoved) {
        return fail('This payment confirmed pay link ' + lk.Request_ID + '. Its sale and transaction id cannot be changed; use Undo on the Got paid action instead.');
      }
    }
    if (input.date !== undefined) {
      if (!isRealDate(input.date)) return fail('Date must be like 2026-10-18.');
      if (input.date !== cur.Date) { if (locks.date) return fail(locks.date); values.Date = input.date; }
    }
    if (input.method !== undefined) {
      var method = String(input.method || '').trim();
      if (method !== String(cur.Method || '')) { if (locks.method) return fail(locks.method); values.Method = method; }
    }
    if (input.note !== undefined) {
      var nt = String(input.note || '').trim();
      if (nt !== String(cur.Note || '').trim()) {
        if (locks.note) return fail(locks.note);
        if (Core.delivery.claimsRequestNote(nt)) return fail('That note starts like a pay link record ("Pay link ...:" or "Overpaid on ..."), which only the app writes. Use other words.');
        values.Note = nt;
      }
    }
    if (input.transactionId !== undefined) {
      var trx = String(input.transactionId || '').trim().toUpperCase();
      if (trx !== String(cur.Transaction_ID || '').trim().toUpperCase()) {
        if (trxTaken(state, trx)) return fail('Transaction ' + trx + ' is already recorded.');
        values.Transaction_ID = trx;
      }
    }
    var curSale = blank(cur.Sale_ID) ? '' : Number(cur.Sale_ID);
    var target = input.saleId === undefined ? curSale : (blank(input.saleId) ? '' : Number(input.saleId));
    var curAmt = Number(cur.Amount), newAmount = curAmt, newSaleId = curSale, extra = [], credit = 0;
    var saleChanged = target !== curSale, amountChanged = amount !== curAmt;
    // Money moves only when the amount rises or the sale changes; date, method and transaction edits never touch Sale_ID or Amount.
    if (saleChanged || amountChanged) {
      if (target === '') {
        newSaleId = ''; newAmount = amount;
      } else {
        var sale = find(state.sales, 'Sale_ID', target);
        if (!sale || sale.Customer_ID !== cur.Customer_ID) return fail('Sale ' + target + ' does not belong to this customer.');
        var paid = L().paidMap(state)[target] || 0;
        var room = r2(L().saleRevenue(sale, state.products) - paid);
        if (!saleChanged) {
          if (amount <= curAmt) newAmount = amount;
          else {
            var inc = r2(amount - curAmt), onS = Math.max(0, Math.min(inc, room));
            newAmount = r2(curAmt + onS); credit = r2(inc - onS);
          }
        } else {
          if (room <= 0) return fail('Sale ' + target + ' has nothing left to pay.');
          var take = Math.min(amount, room);
          newSaleId = target; newAmount = take; credit = r2(amount - take);
        }
        if (credit > 0) {
          extra = paymentOps(state, genOf(state, input), { customerId: cur.Customer_ID, amount: credit, date: values.Date || cur.Date,
            method: values.Method !== undefined ? values.Method : cur.Method, source: cur.Source, note: cur.Note }, []).ops;
        }
      }
      if (curSale === '' && curAmt > 0) {
        var taken = r2(curAmt - (target === '' ? newAmount : credit)), avail = L().creditOf(state, cur.Customer_ID);
        if (taken > 0 && r2(avail - taken) < 0) return fail('৳' + r2(taken - avail) + ' of this credit is already used; undo that first.');
      }
    }
    if (newSaleId !== curSale) values.Sale_ID = newSaleId;
    if (newAmount !== curAmt) values.Amount = newAmount;
    var ops = Object.keys(values).length ? [{ op: 'update', tab: 'Payments', key: 'Payment_ID', id: cur.Payment_ID, values: values }] : [];
    var becameCredit = (curSale !== '' && target === '') ? amount : 0;
    return done(ops.concat(extra), { paymentId: cur.Payment_ID, credit: r2(credit + becameCredit) });
  }

  /** Delete a payment. An auto payment's Matched inbox message goes back to Pending so it can be matched again. */
  function planDeletePayment(state, input) {
    var cur = find(state.payments, 'Payment_ID', input.paymentId);
    if (!cur) return fail('Unknown payment ' + input.paymentId + '.');
    if (isCreditUsedRow(cur)) return fail('Credit-used entries cannot be deleted. Use Undo on the action that created them.');
    // Money that confirmed a Paid pay link is part of a delivery (code or seat) that already went out; deleting it would leave the link Paid with no money.
    var linked = confirmedLink(state, cur);
    if (linked) return fail('This payment confirmed pay link ' + linked.Request_ID + '. Use Undo on the Got paid action instead.');
    if (blank(cur.Sale_ID) && Number(cur.Amount) > 0) {
      var avail = L().creditOf(state, cur.Customer_ID), amt = Number(cur.Amount);
      if (r2(avail - amt) < 0) return fail('৳' + r2(amt - avail) + ' of this credit is already used; undo that first.');
    }
    var ops = [{ op: 'clear', tab: 'Payments', key: 'Payment_ID', id: cur.Payment_ID }];
    var trx = String(cur.Transaction_ID || '').trim().toUpperCase();
    if (trx) {
      var shared = (state.payments || []).some(function (p) {
        return p.Payment_ID !== cur.Payment_ID && String(p.Transaction_ID || '').trim().toUpperCase() === trx; });
      var row = null;
      (state.inbox || []).forEach(function (r) { if (String(r.Transaction_ID || '').trim().toUpperCase() === trx) row = r; });
      if (row && row.Status === 'Matched' && !shared) {
        ops.push({ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: row.Transaction_ID, values: { Status: 'Pending', Matched_Sale_ID: '' } });
      }
    }
    return done(ops, { paymentId: cur.Payment_ID });
  }

  function inboxRow(state, trx) {
    var t = String(trx || '').trim().toUpperCase(), row = null;
    (state.inbox || []).forEach(function (r) { if (String(r.Transaction_ID || '').trim().toUpperCase() === t) row = r; });
    return row;
  }

  /** Set a pending payment message aside. A Matched or already ignored message is refused. */
  function planIgnoreInbox(state, input) {
    var row = inboxRow(state, input.trx);
    if (!row) return fail('That payment message is no longer in the inbox.');
    if (row.Status === 'Matched') return fail('That message is already matched. Delete the payment first.');
    if (row.Status === 'Ignored') return fail('That message is already ignored.');
    // topUp: the one-tap 'Mark as top-up'. Only a wallet top-up may be set aside this way.
    if (input.topUp && Core.matching.rowType(row) !== 'TopUp') return fail('Only a wallet top-up can be marked as a top-up.');
    var note = input.topUp ? Core.matching.TOPUP_NOTE : '';
    return done([{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: row.Transaction_ID, values: { Status: 'Ignored' } }],
      { trx: row.Transaction_ID, note: note });
  }

  /** Remove a payment message from the inbox. A Matched message is refused. */
  function planDeleteInbox(state, input) {
    var row = inboxRow(state, input.trx);
    if (!row) return fail('That payment message is no longer in the inbox.');
    if (row.Status === 'Matched') return fail('That message is matched to a payment, so it cannot be deleted. Delete the payment first.');
    return done([{ op: 'clear', tab: 'Payment_Inbox', key: 'Transaction_ID', id: row.Transaction_ID }], { trx: row.Transaction_ID });
  }

  function planEditExpense(state, input) {
    var cur = find(state.expenses, 'Expense_ID', input.expenseId);
    if (!cur) return fail('Unknown expense ' + input.expenseId + '.');
    var v = {};
    if (input.date !== undefined) { if (!isRealDate(input.date)) return fail('Date must be like 2026-10-18.'); if (input.date !== cur.Date) v.Date = input.date; }
    if (input.category !== undefined) {
      if (EXPENSE_CATEGORIES.indexOf(input.category) < 0) return fail('Category must be one of: ' + EXPENSE_CATEGORIES.join(', ') + '.');
      if (input.category !== cur.Category) v.Category = input.category;
    }
    if (input.amount !== undefined) { var e = amountError(input.amount); if (e) return fail(e); if (r2(input.amount) !== Number(cur.Amount)) v.Amount = r2(input.amount); }
    if (input.paidWith !== undefined) { var we = walletError(state, input.paidWith); if (we) return fail(we); if ((input.paidWith || '') !== String(cur.Paid_With || '')) v.Paid_With = input.paidWith || ''; }
    if (input.note !== undefined && String(input.note).trim() !== String(cur.Note || '')) v.Note = String(input.note).trim();
    return done(Object.keys(v).length ? [{ op: 'update', tab: 'Expenses', key: 'Expense_ID', id: cur.Expense_ID, values: v }] : [], { expenseId: cur.Expense_ID });
  }

  function planDeleteExpense(state, input) {
    var cur = find(state.expenses, 'Expense_ID', input.expenseId);
    if (!cur) return fail('Unknown expense ' + input.expenseId + '.');
    return done([{ op: 'clear', tab: 'Expenses', key: 'Expense_ID', id: cur.Expense_ID }], { expenseId: cur.Expense_ID });
  }

  function planEditPurchase(state, input) {
    var cur = find(state.purchases, 'Purchase_ID', input.purchaseId);
    if (!cur) return fail('Unknown purchase ' + input.purchaseId + '.');
    var v = {};
    if (input.date !== undefined) { if (!isRealDate(input.date)) return fail('Date must be like 2026-10-18.'); if (input.date !== cur.Date) v.Date = input.date; }
    if (input.accountId !== undefined) {
      if (!find(state.accounts, 'Account_ID', input.accountId)) return fail('Unknown account ' + input.accountId + '.');
      if (input.accountId !== cur.Account_ID) v.Account_ID = input.accountId;
    }
    if (input.paidWith !== undefined) { var we = walletError(state, input.paidWith); if (we) return fail(we); if ((input.paidWith || '') !== String(cur.Paid_With || '')) v.Paid_With = input.paidWith || ''; }
    if (input.amount !== undefined) { var e = amountError(input.amount); if (e) return fail(e); if (r2(input.amount) !== Number(cur.Amount)) v.Amount = r2(input.amount); }
    if (input.coversUntil !== undefined) {
      if (input.coversUntil && !isIso(input.coversUntil)) return fail('Covers until must be like 2026-10-18.');
      if ((input.coversUntil || '') !== String(cur.Covers_Until || '')) v.Covers_Until = input.coversUntil || '';
    }
    if (input.notes !== undefined && String(input.notes).trim() !== String(cur.Notes || '')) v.Notes = String(input.notes).trim();
    return done(Object.keys(v).length ? [{ op: 'update', tab: 'Purchases', key: 'Purchase_ID', id: cur.Purchase_ID, values: v }] : [], { purchaseId: cur.Purchase_ID });
  }

  function planDeletePurchase(state, input) {
    var cur = find(state.purchases, 'Purchase_ID', input.purchaseId);
    if (!cur) return fail('Unknown purchase ' + input.purchaseId + '.');
    return done([{ op: 'clear', tab: 'Purchases', key: 'Purchase_ID', id: cur.Purchase_ID }], { purchaseId: cur.Purchase_ID });
  }

  function parentError(state, parentId, selfId) {
    var parent = find(state.products, 'Product_ID', parentId);
    if (!parent || parentId === selfId) return 'Parent ' + parentId + ' is not a product.';
    if (parent.Parent_ID) return parent.Product_ID + ' is itself a variant. A variant cannot have variants.';
    return null;
  }

  function planProduct(state, input) {
    var name = String(input.name || '').trim();
    if (!name) return fail('Give the product a name.');
    var typed = String(input.productId || '').trim().toUpperCase();
    var pid = typed || name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!pid) return fail('The name needs at least one letter or number.');
    if (typed && !/^[A-Z0-9]+$/.test(typed)) return fail('Product ID can only use letters A-Z and numbers.');
    if (pid === 'CUSTOM') return fail('CUSTOM is reserved for custom sales.');
    var clash = (state.products || []).filter(function (p) { return p.Product_ID === pid || String(p.Product_Name).toLowerCase() === name.toLowerCase(); })[0];
    if (clash) return fail('A product ' + clash.Product_ID + ' already exists.');
    var category = String(input.category === undefined || input.category === null ? '' : input.category).trim();
    if (!category || category.length > 40) return fail('Category must be 1-40 characters.');
    var delivers = blank(input.deliversAs) ? (category === 'Game Code' ? 'code' : 'account') : input.deliversAs;
    if (delivers !== 'account' && delivers !== 'code') return fail('Delivers as must be account or code.');
    var letter = String(input.letter || '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(letter)) return fail('Pick 1-3 letters A-Z for its reference codes.');
    if (letter === 'R') return fail('R is reserved for custom pay links.');
    var used = (state.products || []).filter(function (p) { return p.Letter === letter; })[0];
    if (used && !(letter === 'G' && delivers === 'code' && deliversAs(used) === 'code')) return fail('Letter ' + letter + ' is already used by ' + used.Product_ID + '.');
    var parentId = String(input.parentId || '').trim();
    if (parentId) { var pe = parentError(state, parentId, pid); if (pe) return fail(pe); }
    var price = input.price;
    var e = priceError(price); if (e) return fail(e);
    var values = { Product_ID: pid, Product_Name: name, Category: category, Platform: name, Active: 'Yes', Letter: letter, Default_Price: price,
      Delivers_As: delivers, Parent_ID: parentId };
    if (delivers === 'account') {
      if (!(input.cycleDays >= 1 && input.cycleDays <= 400)) return fail('Renews every must be 1-400 days.');
      if (!(input.slots >= 1 && input.slots <= 50)) return fail('People per account must be 1-50.');
      e = amountError(input.accountCost); if (e) return fail(e);
      values.Billing_Cycle_Days = input.cycleDays; values.Account_Cost = input.accountCost; values.Slots_Per_Account = input.slots;
    } else {
      values.Code_Unit_Cost = blank(input.codeCost) ? 0 : input.codeCost;
    }
    return done([{ op: 'append', tab: 'Product_Catalog', values: values }], { productId: pid, tabName: name });
  }

  /** Edit name, category, parent or default price. input: {productId, name?, category?, parentId?, price?}. */
  function planEditProduct(state, input) {
    var cur = find(state.products, 'Product_ID', input.productId);
    if (!cur) return fail('Unknown product ' + input.productId + '.');
    var values = {};
    if (input.name !== undefined) {
      var name = String(input.name).trim();
      if (!name) return fail('Give the product a name.');
      var clash = (state.products || []).filter(function (p) {
        return p.Product_ID !== cur.Product_ID && String(p.Product_Name).toLowerCase() === name.toLowerCase(); })[0];
      if (clash) return fail('A product ' + clash.Product_ID + ' already exists.');
      values.Product_Name = name;
    }
    if (input.category !== undefined) {
      var category = String(input.category === null ? '' : input.category).trim();
      if (!category || category.length > 40) return fail('Category must be 1-40 characters.');
      values.Category = category;
    }
    if (input.parentId !== undefined) {
      var parentId = String(input.parentId || '').trim();
      if (parentId) {
        var pe = parentError(state, parentId, cur.Product_ID); if (pe) return fail(pe);
        var kids = (state.products || []).filter(function (p) { return p.Parent_ID === cur.Product_ID; }).length;
        if (kids) return fail(cur.Product_ID + ' has variants, so it cannot become a variant.');
      }
      values.Parent_ID = parentId;
    }
    if (input.price !== undefined) {
      var e = priceError(input.price); if (e) return fail(e);
      values.Default_Price = input.price;
    }
    if (!Object.keys(values).length) return done([], { productId: cur.Product_ID });
    return done([{ op: 'update', tab: 'Product_Catalog', key: 'Product_ID', id: cur.Product_ID, values: values }], { productId: cur.Product_ID });
  }

  /** Bulk placeholders for on-demand gift cards: qty rows with empty Code, Status 'Pending', one batch. */
  var CONTACT_CHANNELS = ['', 'Telegram', 'WhatsApp', 'Facebook', 'Email', 'Other'];
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
    if (input.contactChannel !== undefined) {
      if (CONTACT_CHANNELS.indexOf(input.contactChannel) < 0) return fail('Contact channel must be one of: ' + CONTACT_CHANNELS.slice(1).join(', ') + ', or empty.');
      values.Contact_Channel = input.contactChannel;
    }
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

  // Inventory batches are tagged codeBatch (Code_Inventory Batch_ID). batchId is reserved for the Undo handle.
  function batchCodes(state, codeBatch) {
    var id = String(codeBatch || '').trim();
    if (!id) return [];
    return (state.codes || []).filter(function (c) { return c.Batch_ID === id; });
  }

  function planBatchEdit(state, input) {
    var rows = batchCodes(state, input.codeBatch);
    if (!rows.length) return fail('Unknown batch ' + input.codeBatch + '.');
    var tag = String(input.tag || '').trim();
    if (!tag) return fail('Give the batch a tag.');
    return done(rows.map(function (c) { return { op: 'update', tab: 'Code_Inventory', id: c.Code_ID, values: { 'Source / Batch': tag } }; }),
      { codeBatch: input.codeBatch, updated: rows.length });
  }

  function planBatchDelete(state, input) {
    var rows = batchCodes(state, input.codeBatch);
    if (!rows.length) return fail('Unknown batch ' + input.codeBatch + '.');
    var sold = rows.filter(function (c) { return c.Status === 'Sold'; }).length;
    if (sold) return fail('Cannot delete batch ' + input.codeBatch + ': ' + sold + ' code' + (sold === 1 ? ' is' : 's are') + ' already sold.');
    var held = rows.filter(function (c) { return c.Status === 'Reserved'; }).length;
    if (held) return fail('Cannot delete batch ' + input.codeBatch + ': ' + held + ' code' + (held === 1 ? ' is' : 's are') + ' held by open pay links; cancel those first.');
    return done(rows.map(function (c) { return { op: 'clear', tab: 'Code_Inventory', id: c.Code_ID }; }),
      { codeBatch: input.codeBatch, removed: rows.length });
  }

  function planAddCodesBatch(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product) return fail('Unknown product ' + input.productId + '.');
    var qty = Number(input.quantity);
    if (!(qty >= 1 && qty === Math.floor(qty) && qty <= 1000)) return fail('Quantity must be a whole number from 1 to 1000.');
    var gen = genOf(state, input);
    var ops = [], codeBatch = String(input.codeBatch || 'BATCH-' + String(Date.now())).trim();
    for (var i = 0; i < qty; i++) {
      ops.push({ op: 'append', tab: 'Code_Inventory', values: { Code_ID: gen.code(), Product_ID: product.Product_ID,
        Code: '', 'Source / Batch': codeBatch, Date_Added: state.today, Manual_Flag: '', Status: 'Pending', Batch_ID: codeBatch } });
    }
    return done(ops, { added: qty, codeBatch: codeBatch });
  }

  function planAddCodes(state, input) {
    var product = find(state.products, 'Product_ID', input.productId);
    if (!product || deliversAs(product) !== 'code') return fail('Pick a game code product.');
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
    var channel = input.contactChannel === undefined || input.contactChannel === null ? '' : input.contactChannel;
    if (CONTACT_CHANNELS.indexOf(channel) < 0) return fail('Contact channel must be one of: ' + CONTACT_CHANNELS.slice(1).join(', ') + ', or empty.');
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
      Markup_Percent: Number(input.markup_percent) || 0, Notes: String(input.notes || '').trim(),
      Contact_Channel: channel
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
      if (keys[i] === 'vault_pin_hash') return fail('The vault PIN is changed from the Vault PIN card.');
      if (!SETTING_KEY_RE.test(keys[i])) return fail('Invalid setting name ' + keys[i] + '.');
      if (String(input[keys[i]] == null ? '' : input[keys[i]]).length > SETTING_VALUE_MAX) return fail('Setting ' + keys[i] + ' is too long.');
      if (keys[i] === 'ref_style' && ['random', 'legacy'].indexOf(String(input[keys[i]])) < 0) return fail('Reference style must be random or legacy.');
      if (keys[i] === 'usdt_bdt_manual' && String(input[keys[i]]).trim() !== '') {
        var mr = Number(String(input[keys[i]]).trim());
        if (!(isFinite(mr) && mr > 0 && mr < 100000)) return fail('Manual rate must be a number above 0, or blank to use the live rate.');
      }
      if (keys[i] === 'low_stock_threshold' && String(input[keys[i]] == null ? '' : input[keys[i]]).trim() !== '') {
        var lt = Number(String(input[keys[i]]).trim());
        if (!(isFinite(lt) && lt >= 0 && lt <= 100000 && Math.floor(lt) === lt)) return fail('Low stock threshold must be a whole number from 0, or blank for the default of 3.');
      }
      if (keys[i] === 'pay_methods' || keys[i] === 'pay_auto_verify') {
        var wanted = String(input[keys[i]]).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        for (var w = 0; w < wanted.length; w++) if (Core.paylinks.METHOD_IDS.indexOf(wanted[w]) < 0) return fail('Unknown payment method ' + wanted[w] + '.');
        if (keys[i] === 'pay_auto_verify' && wanted.indexOf('bank') >= 0) return fail('Bank transfers cannot be verified automatically.');
      }
      if ((keys[i] === 'nagad_number' || keys[i] === 'upay_number') && String(input[keys[i]]).trim() !== '' && !/^01\d{9}$/.test(String(input[keys[i]]).trim())) {
        return fail('The ' + (keys[i] === 'nagad_number' ? 'Nagad' : 'Upay') + ' number must look like 01XXXXXXXXX.');
      }
      if (/^notify_[a-z]+_enabled$/.test(keys[i]) && ['true', 'false'].indexOf(String(input[keys[i]])) < 0) return fail('Notification switches are on or off.');
      if (/^wa_tpl_/.test(keys[i]) && String(input[keys[i]]).trim() !== '' && !/^[a-z0-9_]{1,512}$/.test(String(input[keys[i]]).trim())) {
        return fail('A WhatsApp template name uses lower case letters, digits and underscores only, as it appears in WhatsApp Manager.');
      }
      var stored = input[keys[i]];
      if (keys[i] === 'review_discord_url' || keys[i] === 'review_facebook_url' || keys[i] === 'pay_link_expiry_hours') stored = String(stored).trim();
      if ((keys[i] === 'review_discord_url' || keys[i] === 'review_facebook_url') && stored !== '' && !/^https:\/\/[^\s/]+\S*$/.test(stored)) {
        return fail('The ' + (keys[i] === 'review_discord_url' ? 'Discord' : 'Facebook') + ' link must start with https://.');
      }
      if (keys[i] === 'tos_text' && String(stored).length > 4000) return fail('Terms can be up to 4000 characters.');
      if (keys[i] === 'delivery_note' && String(stored).length > 1000) return fail('The delivery note can be up to 1000 characters.');
      if (keys[i] === 'pay_link_expiry_hours') {
        if (!/^\d+$/.test(stored) || Number(stored) < 1 || Number(stored) > 720) return fail('Link expiry must be a whole number of hours from 1 to 720.');
      }
      // A key with no row yet (a setting added after the table was seeded, such as low_stock_threshold) is inserted: an update finds nothing.
      var known = !!state && !!state.settings && Object.prototype.hasOwnProperty.call(state.settings, keys[i]);
      if (known) ops.push({ op: 'update', tab: 'Settings', key: 'Key', id: keys[i], values: { Value: stored } });
      else ops.push({ op: 'append', tab: 'Settings', id: keys[i], values: { Key: keys[i], Value: stored } });
    }
    return done(ops, null);
  }

  var TEMPLATE_MAX = 1500;
  /** Save a reminder template. Global scope writes the msg_<kind>_<lang> setting; product scope writes the product's language-neutral Template_Renew/Template_Due. */
  function planTemplate(state, input) {
    input = input || {};
    var kind = input.kind, lang = input.lang, text = input.text === undefined || input.text === null ? '' : String(input.text);
    if (kind !== 'renew' && kind !== 'due') return fail('Template kind must be renew or due.');
    if (lang !== 'en' && lang !== 'bn') return fail('Template language must be en or bn.');
    if (text.length > TEMPLATE_MAX) return fail('A template can be at most ' + TEMPLATE_MAX + ' characters.');
    if (input.scope === 'global') {
      return done([{ op: 'update', tab: 'Settings', key: 'Key', id: 'msg_' + kind + '_' + lang, values: { Value: text } }], { scope: 'global', key: 'msg_' + kind + '_' + lang });
    }
    if (input.scope === 'product') {
      var cur = find(state.products, 'Product_ID', input.productId);
      if (!cur) return fail('Unknown product ' + input.productId + '.');
      var values = {};
      values[kind === 'due' ? 'Template_Due' : 'Template_Renew'] = text;
      return done([{ op: 'update', tab: 'Product_Catalog', key: 'Product_ID', id: cur.Product_ID, values: values }], { scope: 'product', productId: cur.Product_ID });
    }
    return fail('Template scope must be global or product.');
  }

  // ---------------------------------------------------------------- goals, budgets, dashboard layout
  var GOAL_METRICS = ['revenue', 'profit', 'collected', 'new_customers'];
  var GOAL_STATUSES = ['Active', 'Done', 'Dropped'];
  var BUDGET_CATEGORIES = EXPENSE_CATEGORIES.concat(['Account purchases']);

  function planGoal(state, input) {
    var cur = null, id = input.goalId;
    if (!blank(id)) { cur = find(state.goals, 'Goal_ID', id); if (!cur) return fail('Unknown goal ' + id + '.'); }
    var title = String(input.title === undefined && cur ? cur.Title : (input.title || '')).trim();
    if (!title) return fail('Give the goal a title.');
    var metric = input.metric === undefined && cur ? cur.Metric : input.metric;
    if (GOAL_METRICS.indexOf(metric) < 0) return fail('Metric must be one of: ' + GOAL_METRICS.join(', ') + '.');
    var target = input.target === undefined && cur ? Number(cur.Target) : input.target;
    if (typeof target !== 'number' || !isFinite(target) || target <= 0) return fail('Target must be more than 0.');
    if (target >= 1e9) return fail('Target is too large.');
    var start = input.start === undefined && cur ? cur.Start : input.start, end = input.end === undefined && cur ? cur.End : input.end;
    if (!isIso(start) || !isIso(end)) return fail('Start and end dates must be like 2026-10-18.');
    if (!isRealDate(start) || !isRealDate(end)) return fail('Start and end must be real calendar dates, like 2026-10-18.');
    if (end < start) return fail('End date must be on or after the start date.');
    var status = input.status === undefined ? (cur ? cur.Status || 'Active' : 'Active') : input.status;
    if (GOAL_STATUSES.indexOf(status) < 0) return fail('Status must be one of: ' + GOAL_STATUSES.join(', ') + '.');
    var note = String(input.note === undefined && cur ? cur.Note || '' : (input.note || '')).trim();
    var values = { Goal_ID: cur ? cur.Goal_ID : genOf(state, input).goal(), Title: title, Metric: metric, Target: target, Start: start, End: end, Note: note, Status: status };
    if (!cur) return done([{ op: 'append', tab: 'Goals', values: values }], { goalId: values.Goal_ID });
    delete values.Goal_ID;
    return done([{ op: 'update', tab: 'Goals', key: 'Goal_ID', id: cur.Goal_ID, values: values }], { goalId: cur.Goal_ID });
  }

  function planDeleteGoal(state, input) {
    var g = find(state.goals, 'Goal_ID', input && input.goalId);
    if (!g) return fail('Unknown goal ' + (input && input.goalId) + '.');
    return done([{ op: 'clear', tab: 'Goals', id: g.Goal_ID }], { goalId: g.Goal_ID });
  }

  function planBudget(state, input) {
    var cur = null, id = input.budgetId;
    if (!blank(id)) { cur = find(state.budgets, 'Budget_ID', id); if (!cur) return fail('Unknown budget ' + id + '.'); }
    var category = input.category === undefined && cur ? cur.Category : input.category;
    if (BUDGET_CATEGORIES.indexOf(category) < 0) return fail('Category must be one of: ' + BUDGET_CATEGORIES.join(', ') + '.');
    var limit = input.monthlyLimit === undefined && cur ? Number(cur.Monthly_Limit) : input.monthlyLimit;
    if (typeof limit !== 'number' || !isFinite(limit) || limit < 1 || limit > 999999) return fail('Monthly limit must be from 1 to 999,999.');
    var alert = input.alertPct === undefined ? (cur ? Number(cur.Alert_Pct) || 80 : 80) : input.alertPct;
    if (typeof alert !== 'number' || !isFinite(alert) || alert < 1 || alert > 100) return fail('Alert level must be from 1 to 100 percent.');
    var active = input.active === undefined ? (cur ? cur.Active || 'Yes' : 'Yes') : (input.active === true ? 'Yes' : input.active === false ? 'No' : input.active);
    if (active !== 'Yes' && active !== 'No') return fail('Active must be Yes or No.');
    if (active === 'Yes') {
      var dup = (state.budgets || []).some(function (b) { return b.Category === category && (b.Active || 'Yes') === 'Yes' && (!cur || b.Budget_ID !== cur.Budget_ID); });
      if (dup) return fail('There is already an active budget for ' + category + '.');
    }
    var values = { Budget_ID: cur ? cur.Budget_ID : genOf(state, input).budget(), Category: category, Monthly_Limit: limit, Alert_Pct: alert, Active: active };
    if (!cur) return done([{ op: 'append', tab: 'Budgets', values: values }], { budgetId: values.Budget_ID });
    delete values.Budget_ID;
    return done([{ op: 'update', tab: 'Budgets', key: 'Budget_ID', id: cur.Budget_ID, values: values }], { budgetId: cur.Budget_ID });
  }

  function planDeleteBudget(state, input) {
    var b = find(state.budgets, 'Budget_ID', input && input.budgetId);
    if (!b) return fail('Unknown budget ' + (input && input.budgetId) + '.');
    return done([{ op: 'clear', tab: 'Budgets', id: b.Budget_ID }], { budgetId: b.Budget_ID });
  }

  /** Saves the dashboard card order in the money_layout setting. Unknown ids are dropped, repeats keep their first place. */
  function planLayout(state, input) {
    if (!input || !Array.isArray(input.widgets)) return fail('widgets must be a list of card ids.');
    var known = {}, out = [];
    Core.money.WIDGETS.forEach(function (w) { known[w.id] = true; });
    input.widgets.forEach(function (w) { if (known[w] === true && out.indexOf(w) < 0) out.push(w); });
    return done([{ op: 'update', tab: 'Settings', key: 'Key', id: 'money_layout', values: { Value: out.join(',') } }], { widgets: out });
  }

  return { planGoal: planGoal, planDeleteGoal: planDeleteGoal, planBudget: planBudget, planDeleteBudget: planDeleteBudget, planLayout: planLayout,
           planTemplate: planTemplate, planSupplierEdit: planSupplierEdit, planSupplierDelete: planSupplierDelete, planBatchEdit: planBatchEdit,
           planBatchDelete: planBatchDelete, planRetireAccount: planRetireAccount, planEndLine: planEndLine, planDeleteAccount: planDeleteAccount, planMergeCustomers: planMergeCustomers, planBackfillPayTokens: planBackfillPayTokens, planNewSale: planNewSale, planCustomSale: planCustomSale, planRenew: planRenew, planPayment: planPayment, planEdit: planEdit,
           planEditPayment: planEditPayment, paymentLocks: paymentLocks, planDeletePayment: planDeletePayment, planEditExpense: planEditExpense,
           planDeleteExpense: planDeleteExpense, planEditPurchase: planEditPurchase, planDeletePurchase: planDeletePurchase,
           planExpense: planExpense,planAccount: planAccount, planPurchase: planPurchase, planProduct: planProduct, planEditProduct: planEditProduct, deliversAs: deliversAs,
           planAddCodes: planAddCodes, planAddCodesBatch: planAddCodesBatch, planSupplier: planSupplier,
           planSettings: planSettings, planWallet: planWallet, WALLET_TYPES: WALLET_TYPES, planIgnoreInbox: planIgnoreInbox, planDeleteInbox: planDeleteInbox,
           freeSlots: freeSlots, accountPoolId: accountPoolId, hostSeats: hostSeats, paymentOps: paymentOps, creditPair: creditPair,
           EXPENSE_CATEGORIES: EXPENSE_CATEGORIES, ACCOUNT_STATUSES: ACCOUNT_STATUSES, STATUSES: STATUSES };
})();
if (typeof module !== 'undefined') module.exports = Core.sales;

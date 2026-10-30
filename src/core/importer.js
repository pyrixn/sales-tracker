/**
 * Core.importer: staged sheet rows (tab Import_Rows) that the owner reviews, edits and approves before they become real sales,
 * payments, accounts, purchases, codes and inbox rows. Planners return {ops, result, errors} like Core.sales and never change `state`.
 * Pure: no I/O. Plaintext credentials are never staged: any data text containing "@" is refused. A login can ride along only as
 * ciphertext (data.secretCipher and data.secretIv, made by the server with the vault key, AAD = the row id); the planners never see or
 * make plaintext. planApply lists the rows that carry one (result.secrets) so the server can re-encrypt each into account_secrets.
 *
 * Row (tab Import_Rows, state.importRows): Row_ID, Batch, Kind, Sheet, Ref, Data (JSON text), Status (Review|Approved|Skipped|Applied),
 * Note, Applied (JSON text of the ids a row created), Created.
 * data.use is the owner's chosen match: { customerId, accountId, saleId, productId }, each an existing id or 'new'.
 */
var Core = Core || {};
Core.importer = (function () {
  var U = function () { return Core.util; };
  var L = function () { return Core.ledger; };
  var S = function () { return Core.sales; };
  var r2 = function (n) { return Core.util.round2(n); };

  var TAB = 'Import_Rows';
  var KINDS = ['account', 'line', 'extra', 'code', 'inbox'];
  var APPLY_ORDER = KINDS;
  var STATUSES = ['Review', 'Approved', 'Skipped', 'Applied'];
  var SETTABLE = ['Review', 'Approved', 'Skipped'];
  var USE_KEYS = ['customerId', 'accountId', 'saleId', 'productId'];
  var UNLOGGED = 'Unlogged payment';
  // Keys the server sets after encrypting a login. A client may not send them: the server strips them before calling a planner.
  var SECRET_KEYS = ['secretCipher', 'secretIv'];
  // Fields where a login pasted by mistake is common; the panel offers to move it into the encrypted login details.
  var LOGIN_FIELDS = ['profile', 'label', 'name'];
  var MAX_ID = 200, MAX_DATA = 20000, MAX_NOTE = 500, MAX_ROWS = 5000;

  /** Fields the owner (or the staging script) may put in data, per kind. `use` is set only through the match argument. */
  var FIELDS = {
    account: ['productHint', 'label', 'collected', 'cost', 'renewalDate', 'slots', 'flags'],
    line: ['accountRef', 'name', 'profile', 'status', 'amount', 'due', 'dueAmount', 'paidTill', 'renewalDate', 'coversFrom', 'months', 'flags', 'ended'],
    extra: ['accountRef', 'amount', 'label', 'coversFrom', 'paidTill'],
    code: ['productHint', 'code', 'family', 'redeemed'],
    inbox: ['Received', 'Type', 'Method', 'Sender', 'Amount', 'Transaction_ID', 'Counterparty', 'Reference', 'Status', 'Raw_SMS']
  };

  // Ops tab -> state field and key, for the working copy that planApply builds.
  var TABS = {
    Customers: ['customers', 'Customer_ID'], Sales_Log: ['sales', 'Sale_ID'], Payments: ['payments', 'Payment_ID'],
    Accounts: ['accounts', 'Account_ID'], Purchases: ['purchases', 'Purchase_ID'], Code_Inventory: ['codes', 'Code_ID'],
    Payment_Inbox: ['inbox', 'Transaction_ID']
  };
  var CREATED_KEY = { Customers: 'customers', Sales_Log: 'sales', Payments: 'payments', Accounts: 'accounts', Purchases: 'purchases',
    Code_Inventory: 'codes', Payment_Inbox: 'inbox' };

  // ------------------------------------------------------------------ small helpers
  function fail(msgs) { return { ops: [], result: null, errors: [].concat(msgs) }; }
  function done(ops, result) { return { ops: ops, result: result, errors: [] }; }
  function blank(v) { return v === '' || v === null || v === undefined; }
  function norm(s) { return String(blank(s) ? '' : s).toLowerCase().trim().replace(/\s+/g, ' '); }
  function text(s) { return String(blank(s) ? '' : s).trim(); }
  function find(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function isDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return false;
    var p = String(v).split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }
  /** {kind: 'blank'|'text'|'ok', value}. A numeric string such as "250" or "1,200" counts as a number; "220-250" is text. */
  function amountOf(v) {
    if (blank(v)) return { kind: 'blank', value: NaN };
    if (typeof v === 'number') return isFinite(v) ? { kind: 'ok', value: v } : { kind: 'text', value: NaN };
    var s = String(v).trim().replace(/,/g, '');
    if (s === '') return { kind: 'blank', value: NaN };
    return /^\d+(\.\d+)?$/.test(s) ? { kind: 'ok', value: Number(s) } : { kind: 'text', value: NaN };
  }
  function truthy(v) { return v === true || /^(1|true|yes|y)$/i.test(String(v === undefined || v === null ? '' : v)); }
  function parseJson(s) { try { var v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
  function allRows(state) { return state.importRows || []; }
  function dataOf(row) { return parseJson(row.Data) || {}; }
  function appliedOf(row) { return blank(row.Applied) ? null : parseJson(row.Applied); }
  function rowById(state, id) { return find(allRows(state), 'Row_ID', id); }
  function notDeleted(a) { return a.Account_Status !== 'Deleted'; }
  function productName(p) { return p.Product_Name || p.Product_ID; }
  function deliversAs(p) { return S().deliversAs(p); }

  function hasSecret(d) { return !!d && typeof d.secretCipher === 'string' && d.secretCipher !== '' && typeof d.secretIv === 'string' && d.secretIv !== ''; }
  function withoutSecret(d) { var o = Object.assign({}, d); SECRET_KEYS.forEach(function (k) { delete o[k]; }); return o; }
  /** Fields (profile, label, name) whose text looks like a login (has an "@"). */
  function loginFields(data) {
    return LOGIN_FIELDS.filter(function (f) { return data && typeof data[f] === 'string' && data[f].indexOf('@') >= 0; });
  }
  /** null, or a message. A login is not a plain error to the owner: the panel offers "Store as login details" (code looks_like_login, see credentialPlan). */
  function credentialError(id, data) {
    if (Object.prototype.hasOwnProperty.call(data, 'secret')) return 'Row ' + id + ': a login must be encrypted by the server before it is staged.';
    var json = JSON.stringify(withoutSecret(data));
    if (json.indexOf('@') >= 0) {
      var lf = loginFields(data);
      if (lf.length) return 'Row ' + id + ': ' + lf.join(', ') + ' looks like a login. Store it as login details; it is kept encrypted.';
      return 'Row ' + id + ': data contains "@". Plaintext logins and emails are never staged; remove it.';
    }
    if (json.length > MAX_DATA) return 'Row ' + id + ': data is too long.';
    return null;
  }
  /** A failed plan that tells the panel which fields it can move into the encrypted login details. */
  function credentialPlan(id, data) {
    var msg = credentialError(id, data);
    if (!msg) return null;
    var p = fail(msg), lf = loginFields(data);
    if (lf.length) { p.code = 'looks_like_login'; p.fields = lf; }
    return p;
  }

  /** Keeps only the allowed fields of a kind; flags must be a list of text, every other field a single value. */
  function cleanData(kind, input, id) {
    var out = {}, errs = [];
    FIELDS[kind].forEach(function (f) {
      if (!Object.prototype.hasOwnProperty.call(input, f)) return;
      var v = input[f];
      if (f === 'flags') {
        if (v === null || v === undefined || v === '') { out.flags = []; return; }
        if (!Array.isArray(v) || v.some(function (x) { return typeof x !== 'string'; })) { errs.push('Row ' + id + ': flags must be a list of text.'); return; }
        out.flags = v.slice(0, 20);
        return;
      }
      if (v !== null && typeof v === 'object') { errs.push('Row ' + id + ': ' + f + ' must be a single value.'); return; }
      out[f] = v === null || v === undefined ? '' : v;
    });
    return { data: out, errors: errs };
  }

  // ------------------------------------------------------------------ staging
  /** Appends staged rows. Ids already in the table are skipped, so running the script twice adds nothing. */
  function planStage(state, input) {
    input = input || {};
    var batch = text(input.batch);
    if (!batch || batch.length > MAX_ID) return fail('Give the batch a name (up to ' + MAX_ID + ' characters).');
    var rows = input.rows;
    if (!Array.isArray(rows) || !rows.length) return fail('Send at least one row.');
    if (rows.length > MAX_ROWS) return fail('Send at most ' + MAX_ROWS + ' rows at a time.');
    var have = {}, errs = [], ops = [], added = 0, skipped = 0;
    allRows(state).forEach(function (r) { have[r.Row_ID] = true; });
    rows.forEach(function (r, i) {
      var id = r && typeof r.id === 'string' ? r.id.trim() : '';
      if (!id || id.length > MAX_ID) { errs.push('Row ' + (i + 1) + ': id must be 1 to ' + MAX_ID + ' characters.'); return; }
      if (!r || KINDS.indexOf(r.kind) < 0) { errs.push('Row ' + id + ': kind must be one of ' + KINDS.join(', ') + '.'); return; }
      if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) { errs.push('Row ' + id + ': data must be an object.'); return; }
      var ce = credentialError(id, r.data);
      if (ce) { errs.push(ce); return; }
      if ((r.data.secretCipher !== undefined || r.data.secretIv !== undefined) && !hasSecret(r.data)) { errs.push('Row ' + id + ': the encrypted login is incomplete.'); return; }
      if (have[id]) { skipped++; return; }
      have[id] = true;
      ops.push({ op: 'append', tab: TAB, values: { Row_ID: id, Batch: batch, Kind: r.kind, Sheet: text(r.sheet), Ref: text(r.ref),
        Data: JSON.stringify(r.data), Status: 'Review', Note: '', Applied: '', Created: state.today } });
      added++;
    });
    if (errs.length) return fail(errs);
    return done(ops, { added: added, skipped: skipped });
  }

  // ------------------------------------------------------------------ matching
  function productPool(state, kind) {
    return (state.products || []).filter(function (p) {
      var d = deliversAs(p);
      return kind === 'code' ? d === 'code' : d === 'account';
    });
  }

  /** Products whose name or id contains the hint (or the other way round), best first: exact (0) before contains (1). */
  function rankProducts(state, hint, kind) {
    var h = norm(hint);
    if (!h) return [];
    var out = [];
    productPool(state, kind).forEach(function (p) {
      var n = norm(p.Product_Name), id = norm(p.Product_ID), rank = -1;
      if (n === h || id === h) rank = 0;
      else if ((n && (n.indexOf(h) >= 0 || h.indexOf(n) >= 0)) || (id.length >= 2 && (id.indexOf(h) >= 0 || h.indexOf(id) >= 0))) rank = 1;
      if (rank >= 0) out.push({ p: p, rank: rank });
    });
    out.sort(function (a, b) { return a.rank - b.rank || (productName(a.p) < productName(b.p) ? -1 : 1); });
    return out;
  }
  function productRef(p) { return p ? { id: p.Product_ID, name: productName(p) } : null; }

  /** product: the chosen one (use.productId, else the single best hint match), candidates up to 5, ambiguous when several tie. */
  function matchProduct(state, data, kind) {
    var use = data.use || {}, ranked = rankProducts(state, data.productHint, kind), product = null, ambiguous = false;
    if (use.productId && use.productId !== 'new') product = find(state.products, 'Product_ID', use.productId);
    else if (ranked.length) {
      if (ranked.length === 1 || ranked[0].rank < ranked[1].rank) product = ranked[0].p; else ambiguous = true;
    }
    var cands = ranked.slice(0, 5).map(function (x) { return productRef(x.p); });
    if (product && !cands.some(function (c) { return c.id === product.Product_ID; })) cands.unshift(productRef(product));
    return { product: product, candidates: cands.slice(0, 5), ambiguous: ambiguous };
  }

  function accountRef(a) { return a ? { id: a.Account_ID, label: a.Account_Label, productId: a.Product_ID } : null; }

  /** An account row's match: the product and, within it, the existing account with the same normalised label. */
  function matchAccountRow(state, data) {
    var use = data.use || {}, product, account = null, cands = [];
    if (use.accountId && use.accountId !== 'new') {
      account = find(state.accounts, 'Account_ID', use.accountId);
      product = account ? find(state.products, 'Product_ID', account.Product_ID) : null;
      var pm = { product: product, candidates: product ? [productRef(product)] : [], ambiguous: false };
      return { product: pm.product, productCandidates: pm.candidates, ambiguous: false, account: account,
        accountCandidates: account ? [accountRef(account)] : [], chosen: true };
    }
    var m = matchProduct(state, data, 'account');
    product = m.product;
    if (product) {
      var mine = (state.accounts || []).filter(function (a) { return a.Product_ID === product.Product_ID && notDeleted(a); });
      var label = norm(data.label);
      var same = mine.filter(function (a) { return label && norm(a.Account_Label) === label; });
      if (use.accountId !== 'new' && same.length) account = same[0];
      cands = same.concat(mine.filter(function (a) { return same.indexOf(a) < 0; })).slice(0, 5).map(accountRef);
    }
    return { product: product, productCandidates: m.candidates, ambiguous: m.ambiguous, account: account, accountCandidates: cands, chosen: false };
  }

  function customerRef(c) { return c ? { id: c.Customer_ID, name: c.Name } : null; }

  /** Exact name or handle first, then names that contain the typed name. Returns {customer, candidates, ambiguous}. */
  function matchCustomer(state, name, use, pool) {
    use = use || {};
    var customers = pool || state.customers || [], n = norm(name);
    if (use.customerId && use.customerId !== 'new') {
      var picked = find(customers, 'Customer_ID', use.customerId);
      if (picked) return { customer: picked, candidates: [customerRef(picked)], ambiguous: false };
    }
    var exact = [], loose = [];
    if (n) customers.forEach(function (c) {
      var cn = norm(c.Name), ch = norm(c.Handle);
      if (cn === n || (ch && ch === n)) exact.push(c);
      else if (n.length >= 3 && cn && (cn.indexOf(n) >= 0 || n.indexOf(cn) >= 0) && cn.length >= 3) loose.push(c);
    });
    var cands = exact.concat(loose).slice(0, 5).map(customerRef);
    if (use.customerId === 'new') return { customer: null, candidates: cands, ambiguous: false };
    return { customer: exact.length === 1 ? exact[0] : null, candidates: cands, ambiguous: exact.length > 1 };
  }

  function saleRef(state, s) {
    return { saleId: s.Sale_ID, customerId: s.Customer_ID, customer: s.Customer, paid: L().salePaid(s, state), paidTill: s.Paid_Till || '' };
  }

  /** The Active or Ended sale on the account for the customer (newest first), or the one the owner chose in use.saleId. */
  function matchSale(state, accountId, customer, use, opts) {
    use = use || {}; opts = opts || {};
    var prof = norm(opts.profile);
    var onAcc = (state.sales || []).filter(function (s) { return s.Account_ID === accountId && (s.Record_Status === 'Active' || s.Record_Status === 'Ended'); });
    var cands = onAcc.slice().sort(function (a, b) {
      return (customer && b.Customer_ID === customer.Customer_ID ? 1 : 0) - (customer && a.Customer_ID === customer.Customer_ID ? 1 : 0) || b.Sale_ID - a.Sale_ID;
    });
    var sale = null;
    if (use.saleId && use.saleId !== 'new') sale = find(state.sales, 'Sale_ID', Number(use.saleId));
    else if (use.saleId !== 'new' && customer) {
      // Same customer, never a sale with a different non-blank profile, and a sale made earlier in this apply only if the profile is the same.
      var mine = onAcc.filter(function (s) {
        if (s.Customer_ID !== customer.Customer_ID) return false;
        var sp = norm(s.Contact);
        if (prof && sp && sp !== prof) return false;
        if (opts.isNew && opts.isNew(s) && sp !== prof) return false;
        return true;
      });
      sale = mine.sort(function (a, b) {
        return (norm(b.Contact) === prof ? 1 : 0) - (norm(a.Contact) === prof ? 1 : 0) || b.Sale_ID - a.Sale_ID;
      })[0] || null;
    }
    return { sale: sale, candidates: cands.slice(0, 5).map(function (s) { return saleRef(state, s); }) };
  }

  /** The rent product and sale date an extra row would be posted with, against a state. */
  function extraShape(state, accProduct, d) {
    var rent = (state.products || []).filter(function (p) { return p.Parent_ID === accProduct.Product_ID && Number(p.Billing_Cycle_Days) < 30; })
      .sort(function (a, b) { return Number(a.Billing_Cycle_Days) - Number(b.Billing_Cycle_Days) || (a.Product_ID < b.Product_ID ? -1 : 1); })[0];
    var product = rent || accProduct, paidTill = text(d.paidTill), coversFrom = text(d.coversFrom);
    var date = coversFrom || (paidTill ? U().addCycle(paidTill, -1, Number(product.Billing_Cycle_Days) || 30) : state.today);
    return { product: product, paidTill: paidTill, coversFrom: coversFrom, date: date };
  }
  /** Same-batch extra row that comes before `row` and says the same thing (account, amount, label, dates). */
  function extraKey(ctx, r) {
    var d = ctx.data[r.Row_ID] || {};
    return [r.Sheet || '', norm(d.accountRef), String(amountOf(d.amount).value), norm(d.label), text(d.paidTill), text(d.coversFrom)].join('|');
  }
  function earlierTwin(ctx, row) {
    var key = extraKey(ctx, row);
    for (var i = 0; i < ctx.rows.length; i++) {
      var o = ctx.rows[i];
      if (o.Row_ID === row.Row_ID) return null;
      if (o.Kind === 'extra' && o.Status !== 'Skipped' && extraKey(ctx, o) === key) return o;
    }
    return null;
  }
  /** An existing sale an extra row already is: same account, same date (Sale_Date or Covers_From), same amount, Unlogged payment customer or same note. */
  function extraDuplicate(state, accountId, d) {
    var acc = find(state.accounts, 'Account_ID', accountId), accProduct = acc && find(state.products, 'Product_ID', acc.Product_ID);
    var amt = amountOf(d.amount);
    if (!accProduct || amt.kind !== 'ok') return null;
    var shape = extraShape(state, accProduct, d), note = text(d.label) || 'Rent or custom amount';
    return (state.sales || []).filter(function (s) {
      return s.Account_ID === accountId && !L().isVoided(s) && Number(s.Unit_Price) === amt.value &&
        (s.Sale_Date === shape.date || (shape.coversFrom && s.Covers_From === shape.coversFrom)) &&
        (norm(s.Customer) === norm(UNLOGGED) || text(s.Notes) === note);
    }).sort(function (a, b) { return b.Sale_ID - a.Sale_ID; })[0] || null;
  }

  // ------------------------------------------------------------------ context over one batch
  /** A sheet's Due column sometimes holds a number: that is an amount still owed (dueAmount), not a date. Applied on read, so rows staged before need no re-staging. */
  function normData(kind, d) {
    if (kind !== 'line' || blank(d.due) || !blank(d.dueAmount)) return d;
    var a = amountOf(d.due);
    if (a.kind !== 'ok') return d;
    return Object.assign({}, d, { due: '', dueAmount: a.value });
  }
  /** Months a line was sold for: 1 when blank, otherwise a whole number 1 to 24 (null when it is not). */
  function monthsOf(d) {
    if (blank(d.months)) return 1;
    var a = amountOf(d.months);
    return a.kind === 'ok' && a.value === Math.floor(a.value) && a.value >= 1 && a.value <= 24 ? a.value : null;
  }
  /** The exact quotient (6 decimals): the sales column keeps them, so price x months gives the total back (rounded to cents by saleRevenue). */
  function unitOf(total, months) { return Math.round(total / months * 1e6) / 1e6; }
  function dueAmountOf(d) { var a = amountOf(d.dueAmount); return a.kind === 'ok' && a.value > 0 ? a.value : 0; }
  function makeCtx(state, rows) {
    var ctx = { state: state, rows: rows, data: {}, accountRows: [], accMatch: {} };
    rows.forEach(function (r) {
      ctx.data[r.Row_ID] = normData(r.Kind, dataOf(r));
      if (r.Kind === 'account') ctx.accountRows.push(r);
    });
    return ctx;
  }
  function accMatchOf(ctx, row) {
    if (!ctx.accMatch[row.Row_ID]) ctx.accMatch[row.Row_ID] = matchAccountRow(ctx.state, ctx.data[row.Row_ID] || {});
    return ctx.accMatch[row.Row_ID];
  }
  /** The staged account row a line or extra points at: by row id, ref, or Sheet!Ref; same sheet wins when several match. */
  function stagedAccountOf(ctx, row) {
    var ref = text((ctx.data[row.Row_ID] || {}).accountRef);
    if (!ref) return null;
    var hits = ctx.accountRows.filter(function (a) { return a.Row_ID === ref || a.Ref === ref || (a.Sheet + '!' + a.Ref) === ref; });
    if (!hits.length) return null;
    return hits.filter(function (a) { return a.Sheet === row.Sheet; })[0] || hits[0];
  }
  /** The real account a line or extra belongs to, as far as review can tell: {accountId, staged, via}. accountId '' when still to be created. */
  function lineAccount(ctx, row) {
    var use = (ctx.data[row.Row_ID] || {}).use || {};
    if (use.accountId && use.accountId !== 'new' && find(ctx.state.accounts, 'Account_ID', use.accountId)) return { accountId: use.accountId, staged: null, via: 'use' };
    var staged = stagedAccountOf(ctx, row);
    if (staged) {
      var ap = staged.Status === 'Applied' ? appliedOf(staged) : null;
      if (ap && ap.accountId) return { accountId: ap.accountId, staged: staged, via: 'applied' };
      var am = accMatchOf(ctx, staged);
      return { accountId: am.account ? am.account.Account_ID : '', staged: staged, via: am.account ? 'match' : 'new' };
    }
    var ref = text((ctx.data[row.Row_ID] || {}).accountRef);
    if (ref && find(ctx.state.accounts, 'Account_ID', ref)) return { accountId: ref, staged: null, via: 'id' };
    return { accountId: '', staged: null, via: 'none' };
  }

  // ------------------------------------------------------------------ review
  function blockDate(block, label, v, field) {
    if (!blank(v) && !isDate(v)) block(label + ' "' + v + '" is not a date like 2026-10-18.', field);
  }
  function dateIssue(issues, label, v) {
    if (!blank(v) && !isDate(v)) issues.push(label + ' "' + v + '" is not a date like 2026-10-18.');
  }
  function flagIssues(issues, d) {
    (Array.isArray(d.flags) ? d.flags : []).forEach(function (f) {
      if (f === 'label-hidden') issues.push('The account label looked like a login and was hidden. Type a label.');
      else issues.push('Flag: ' + f);
    });
  }

  var BLOCKS = 'blocks apply';
  /** Amount range planApply enforces (needAmount): 0 or more (or more than 0) and under 1,000,000. Returns the issue text or ''. */
  function amountRangeIssue(v, label, allowZero) {
    var a = amountOf(v);
    if (a.kind !== 'ok') return '';
    if (a.value < 0 || (!allowZero && a.value === 0) || a.value >= 1000000) return label + ' must be ' + (allowZero ? '0 or more' : 'more than 0') + ' and under 1,000,000.';
    return '';
  }

  function reviewRow(ctx, row) {
    var state = ctx.state, d = ctx.data[row.Row_ID] || {}, kind = row.Kind, issues = [], match = {};
    // Every issue planApply would refuse is also listed in blocking (same text as in issues), with the field to fix and a one-click fix when obvious.
    var blocking = [], fixes = [];
    function block(text, field) { issues.push(text); blocking.push({ text: text, field: field || '', severity: BLOCKS }); }
    var parsed = parseJson(row.Data);
    if (!parsed) block('Data is not valid JSON.', '');
    var use = d.use || null;

    if (kind === 'account') {
      var am = accMatchOf(ctx, row);
      if (!text(d.label)) block('Account label is blank.', 'label');
      if (!am.product) block(am.ambiguous ? 'Several products match "' + text(d.productHint) + '". Pick one.' : 'No product matches "' + text(d.productHint) + '".', 'productHint');
      var cost = amountOf(d.cost);
      if (cost.kind === 'text') block('Cost "' + d.cost + '" is not a number.', 'cost');
      else if (cost.kind === 'blank') block('Cost is blank.', 'cost');
      else { var ci = amountRangeIssue(d.cost, 'Cost', false); if (ci) block(ci, 'cost'); }
      var slots = amountOf(d.slots);
      if (slots.kind !== 'ok') block(slots.kind === 'blank' ? 'Slots is blank.' : 'Slots "' + d.slots + '" is not a number.', 'slots');
      else { var si = amountRangeIssue(d.slots, 'Slots', false); if (si) block(si, 'slots'); }
      blockDate(block, 'Renewal date', d.renewalDate, 'renewalDate');
      flagIssues(issues, d);
      match = { product: productRef(am.product), account: accountRef(am.account),
        candidates: { products: am.productCandidates, accounts: am.accountCandidates } };
    } else if (kind === 'line' || kind === 'extra') {
      var acc = lineAccount(ctx, row), accRow = acc.accountId ? find(state.accounts, 'Account_ID', acc.accountId) : null;
      var product = accRow ? find(state.products, 'Product_ID', accRow.Product_ID) : (acc.staged ? accMatchOf(ctx, acc.staged).product : null);
      if (!acc.staged && acc.via !== 'use' && acc.via !== 'id') block('No account row matches "' + text(d.accountRef) + '".', 'accountRef');
      else if (acc.staged && acc.via === 'new' && acc.staged.Status === 'Skipped') block('Account row ' + (acc.staged.Ref || acc.staged.Row_ID) + ' is skipped and cannot be applied. Approve it or pick an account.', 'accountRef');
      if (d.use && d.use.accountId && d.use.accountId !== 'new' && !find(state.accounts, 'Account_ID', d.use.accountId)) block('Account ' + d.use.accountId + ' does not exist.', 'accountRef');
      var amt = amountOf(d.amount);
      if (amt.kind === 'blank') block('Amount is blank.', 'amount');
      else if (amt.kind === 'text') block('Amount "' + d.amount + '" is text, not a number.', 'amount');
      else { var ai = amountRangeIssue(d.amount, 'Amount', kind === 'line'); if (ai) block(ai, 'amount'); }
      blockDate(block, 'Paid till', d.paidTill, 'paidTill');
      blockDate(block, 'Covers from', d.coversFrom, 'coversFrom');
      if (kind === 'line') {
        blockDate(block, 'Due', d.due, 'due');
        if (monthsOf(d) === null) { block('Months "' + d.months + '" must be a whole number from 1 to 24.', 'months'); fixes.push({ id: 'months', field: 'months', label: 'Use 1 month', value: 1, values: { months: 1 } }); }
        if (!blank(d.dueAmount) && amountOf(d.dueAmount).kind !== 'ok') issues.push('Still owes "' + d.dueAmount + '" is not a number.');
        blockDate(block, 'Renewal date', d.renewalDate, 'renewalDate');
        if (!text(d.name)) block('Name is blank.', 'name');
        if (!text(d.paidTill) && !text(d.renewalDate)) {
          block('Paid till is blank and there is no renewal date to use.', 'paidTill');
          var mo = monthsOf(d) || 1, cf = isDate(d.coversFrom) ? d.coversFrom : state.today, days = Number(product && product.Billing_Cycle_Days) || 30;
          fixes.push({ id: 'paidTill-set', field: 'paidTill', label: 'Set paid till', picker: true });
          fixes.push({ id: 'paidTill-computed', field: 'paidTill', label: 'Use covers from + ' + mo + (mo === 1 ? ' month' : ' months'),
            value: U().addCycle(cf, mo, days), values: isDate(d.coversFrom) ? { paidTill: U().addCycle(cf, mo, days) } : { paidTill: U().addCycle(cf, mo, days), coversFrom: cf },
            coversFrom: cf });
        }
        if (norm(d.status) === 'paid' && isDate(d.paidTill) && d.paidTill < state.today) issues.push('Paid till ' + d.paidTill + ' is in the past but the status is Paid.');
        var dup = ctx.rows.filter(function (o) {
          if (o.Kind !== 'line' || o.Row_ID === row.Row_ID || o.Status === 'Skipped') return false;
          var od = ctx.data[o.Row_ID] || {};
          return norm(od.name) && norm(od.name) === norm(d.name) && text(od.accountRef) === text(d.accountRef);
        });
        if (dup.length && row.Status !== 'Skipped') issues.push('Another line on this account has the name "' + text(d.name) + '".');
        var cm = matchCustomer(state, d.name, d.use);
        if (cm.ambiguous && !(use && use.customerId)) block('Several customers are named "' + text(d.name) + '". Pick one.', 'customerId');
        if (use && use.customerId && use.customerId !== 'new' && !find(state.customers, 'Customer_ID', use.customerId)) block('Customer ' + use.customerId + ' does not exist.', 'customerId');
        if (use && use.customerId === 'new' && matchCustomer(state, d.name, null).customer) block('A customer named "' + text(d.name) + '" already exists. Pick them from the list instead of New.', 'customerId');
        var sm = acc.accountId ? matchSale(state, acc.accountId, cm.customer, d.use, { profile: d.profile }) : { sale: null, candidates: [] };
        match = { account: accountRef(accRow), accountRow: acc.staged ? acc.staged.Row_ID : null, product: productRef(product),
          customer: customerRef(cm.customer), sale: sm.sale ? saleRef(state, sm.sale) : null,
          candidates: { customers: cm.candidates, sales: sm.candidates } };
        if (sm.sale) {
          var due = amt.kind === 'ok' ? r2(amt.value - L().salePaid(sm.sale, state)) : null;
          match.sale.difference = due;
          var inPaidTill = text(d.paidTill) || text(d.renewalDate), unpaidL = /^(due|unpaid)$/i.test(text(d.status));
          if (inPaidTill && sm.sale.Paid_Till && inPaidTill > sm.sale.Paid_Till) match.sale.renewal = true;
          else if (isDate(inPaidTill) && (unpaidL || due === null || due <= 0)) issues.push('Already in the panel: ' + sm.sale.Sale_ID);
        }
      } else {
        match = { account: accountRef(accRow), accountRow: acc.staged ? acc.staged.Row_ID : null, product: productRef(product), candidates: {} };
        var xd = acc.accountId && !(use && use.saleId === 'new') ? extraDuplicate(state, acc.accountId, d) : null;
        if (use && use.saleId && use.saleId !== 'new') xd = find(state.sales, 'Sale_ID', Number(use.saleId));
        if (xd) { issues.push('Already in the panel: ' + xd.Sale_ID); match.sale = saleRef(state, xd); }
        else if (!(use && use.saleId)) {
          var twin = earlierTwin(ctx, row);
          if (twin) issues.push('Duplicate of row ' + twin.Row_ID + ' in this batch');
        }
      }
      flagIssues(issues, d);
    } else if (kind === 'code') {
      var pm = matchProduct(state, d, 'code');
      var code = text(d.code);
      if (!code) block('Code is blank.', 'code');
      if (!pm.product) block(pm.ambiguous ? 'Several products match "' + text(d.productHint) + '". Pick one.' : 'No code product matches "' + text(d.productHint) + '".', 'productHint');
      var existing = code ? (state.codes || []).filter(function (c) { return norm(c.Code) === norm(code); })[0] : null;
      if (existing) issues.push('This code is already in the inventory as ' + existing.Code_ID + '.');
      match = { product: productRef(pm.product), code: existing ? { id: existing.Code_ID, status: existing.Status || '' } : null,
        candidates: { products: pm.candidates } };
    } else if (kind === 'inbox') {
      var trx = text(d.Transaction_ID).toUpperCase();
      if (!trx) block('Transaction ID is blank.', 'Transaction_ID');
      var ia = amountOf(d.Amount);
      if (ia.kind === 'text') block('Amount "' + d.Amount + '" is text, not a number.', 'Amount');
      var inInbox = trx ? find(state.inbox, 'Transaction_ID', trx) : null;
      var inPay = trx && (state.payments || []).some(function (p) { return String(p.Transaction_ID || '').trim().toUpperCase() === trx; });
      if (inInbox) issues.push('Transaction ' + trx + ' is already in the inbox. It will be skipped.');
      if (inPay) issues.push('A payment with transaction ' + trx + ' already exists.');
      match = { trx: trx || null, inInbox: !!inInbox, inPayments: !!inPay, candidates: {} };
    }
    match.use = use;
    // The ciphertext never goes to the panel; hasSecret drives the "Has login details" badge.
    return { id: row.Row_ID, batch: row.Batch, kind: kind, sheet: row.Sheet, ref: row.Ref, status: row.Status, note: row.Note || '',
      data: withoutSecret(d), hasSecret: hasSecret(d), issues: issues, blocking: blocking, blocks: blocking.length > 0, fixes: fixes,
      match: match, applied: appliedOf(row) };
  }

  /** The owner's view of one batch (all rows when no batch is given). */
  function review(state, input) {
    input = input || {};
    var batch = text(input.batch);
    var rows = allRows(state).filter(function (r) { return !batch || r.Batch === batch; });
    var ctx = makeCtx(state, rows), counts = {};
    KINDS.forEach(function (k) { counts[k] = {}; STATUSES.forEach(function (s) { counts[k][s] = 0; }); });
    var views = {};
    rows.forEach(function (r) {
      if (counts[r.Kind] && counts[r.Kind][r.Status] !== undefined) counts[r.Kind][r.Status]++;
      views[r.Row_ID] = reviewRow(ctx, r);
    });
    var byAcc = {}, orphans = [];
    rows.forEach(function (r) {
      if (r.Kind !== 'line' && r.Kind !== 'extra') return;
      var st = stagedAccountOf(ctx, r);
      if (!st) { orphans.push(views[r.Row_ID]); return; }
      (byAcc[st.Row_ID] = byAcc[st.Row_ID] || []).push(views[r.Row_ID]);
    });
    var accounts = rows.filter(function (r) { return r.Kind === 'account'; }).map(function (r) {
      var v = views[r.Row_ID], kids = byAcc[r.Row_ID] || [], total = 0;
      var lines = kids.filter(function (k) { return k.kind === 'line'; }), extras = kids.filter(function (k) { return k.kind === 'extra'; });
      kids.forEach(function (k) {
        if (k.status === 'Skipped') return;
        if (k.kind === 'line' && /^(due|unpaid)$/i.test(text(k.data.status))) return;
        var a = amountOf(k.data.amount);
        if (a.kind === 'ok') total += a.value;
      });
      var coll = amountOf(v.data.collected);
      var staged = r2(total);
      return { row: v, data: v.data, issues: v.issues, blocking: v.blocking, match: v.match, sheetCollected: coll.kind === 'ok' ? coll.value : null,
        stagedTotal: staged, difference: coll.kind === 'ok' ? r2(coll.value - staged) : null, lines: lines, extras: extras };
    });
    function ofKind(k) { return rows.filter(function (r) { return r.Kind === k; }).map(function (r) { return views[r.Row_ID]; }); }
    return { batch: batch, counts: counts, accounts: accounts, orphans: orphans, codes: ofKind('code'), inbox: ofKind('inbox') };
  }

  // ------------------------------------------------------------------ edit, add, delete, status
  function checkUse(state, match) {
    var errs = [];
    Object.keys(match).forEach(function (k) {
      var v = match[k];
      if (USE_KEYS.indexOf(k) < 0) { errs.push('Unknown match field ' + k + '.'); return; }
      if (v === 'new' || blank(v)) return;
      var tabs = { customerId: ['customers', 'Customer_ID'], accountId: ['accounts', 'Account_ID'], saleId: ['sales', 'Sale_ID'], productId: ['products', 'Product_ID'] }[k];
      var key = k === 'saleId' ? Number(v) : v;
      if (!find(state[tabs[0]], tabs[1], key)) errs.push('Unknown ' + k.replace('Id', '') + ' ' + v + '.');
    });
    return errs;
  }

  function planEditRow(state, input) {
    input = input || {};
    var row = rowById(state, input.rowId);
    if (!row) return fail('Unknown row ' + input.rowId + '.');
    if (row.Status === 'Applied') return fail('Row ' + row.Row_ID + ' is already applied and cannot be edited.');
    var cur = dataOf(row), next = Object.assign({}, cur), values = {};
    if (input.data !== undefined) {
      if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) return fail('Data must be an object.');
      var c = cleanData(row.Kind, input.data, row.Row_ID);
      if (c.errors.length) return fail(c.errors);
      Object.assign(next, c.data);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'match')) {
      if (input.match === null) delete next.use;
      else {
        if (typeof input.match !== 'object' || Array.isArray(input.match)) return fail('Match must be an object like { customerId: "CU-0001" }.');
        var ue = checkUse(state, input.match);
        if (ue.length) return fail(ue);
        var use = Object.assign({}, next.use || {});
        Object.keys(input.match).forEach(function (k) { if (blank(input.match[k])) delete use[k]; else use[k] = input.match[k]; });
        if (Object.keys(use).length) next.use = use; else delete next.use;
      }
    }
    // The server passes secretEnc after it encrypted a login for this row (AAD = the row id). clearSecret removes it.
    if (input.secretEnc) {
      if (!input.secretEnc.cipher || !input.secretEnc.iv) return fail('The encrypted login is incomplete.');
      next.secretCipher = String(input.secretEnc.cipher); next.secretIv = String(input.secretEnc.iv);
    } else if (input.clearSecret) SECRET_KEYS.forEach(function (k) { delete next[k]; });
    var cp = credentialPlan(row.Row_ID, next);
    if (cp) return cp;
    var json = JSON.stringify(next);
    if (json !== JSON.stringify(cur)) values.Data = json;
    if (input.note !== undefined) {
      var note = text(input.note);
      if (note.length > MAX_NOTE) return fail('Note can be at most ' + MAX_NOTE + ' characters.');
      if (note !== (row.Note || '')) values.Note = note;
    }
    if (!Object.keys(values).length) return fail('Nothing to change.');
    return done([{ op: 'update', tab: TAB, key: 'Row_ID', id: row.Row_ID, values: values }], { rowId: row.Row_ID });
  }

  function planAddRow(state, input) {
    input = input || {};
    var batch = text(input.batch);
    if (!batch) return fail('Give the batch.');
    if (KINDS.indexOf(input.kind) < 0) return fail('Kind must be one of ' + KINDS.join(', ') + '.');
    var raw = input.data === undefined ? {} : input.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Data must be an object.');
    var c = cleanData(input.kind, raw, batch);
    if (c.errors.length) return fail(c.errors);
    var max = 0, prefix = batch + ':manual-';
    allRows(state).forEach(function (r) {
      if (String(r.Row_ID).indexOf(prefix) === 0) { var n = Number(String(r.Row_ID).slice(prefix.length)); if (isFinite(n) && n > max) max = n; }
    });
    var id = prefix + (max + 1);
    if (id.length > MAX_ID) return fail('Batch name is too long.');
    var cp2 = credentialPlan(id, c.data);
    if (cp2) return cp2;
    return done([{ op: 'append', tab: TAB, values: { Row_ID: id, Batch: batch, Kind: input.kind, Sheet: 'manual', Ref: String(max + 1),
      Data: JSON.stringify(c.data), Status: 'Review', Note: '', Applied: '', Created: state.today } }], { rowId: id });
  }

  function idsOf(input) {
    var list = Array.isArray(input.rowIds) ? input.rowIds : (blank(input.rowId) ? [] : [input.rowId]);
    return list.map(function (x) { return String(x); });
  }

  function planDeleteRow(state, input) {
    input = input || {};
    var ids = idsOf(input);
    if (!ids.length) return fail('Pick at least one row.');
    var errs = [], ops = [];
    ids.forEach(function (id) {
      var row = rowById(state, id);
      if (!row) errs.push('Unknown row ' + id + '.');
      else if (row.Status === 'Applied') errs.push('Row ' + id + ' is already applied and cannot be deleted.');
      else ops.push({ op: 'clear', tab: TAB, key: 'Row_ID', id: id });
    });
    if (errs.length) return fail(errs);
    return done(ops, { deleted: ops.length });
  }

  function planSetStatus(state, input) {
    input = input || {};
    if (SETTABLE.indexOf(input.status) < 0) return fail('Status must be Review, Approved or Skipped.');
    var ids = idsOf(input);
    if (!ids.length) return fail('Pick at least one row.');
    var errs = [], ops = [], seen = {};
    ids.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      var row = rowById(state, id);
      if (!row) errs.push('Unknown row ' + id + '.');
      else if (row.Status === 'Applied') errs.push('Row ' + id + ' is already applied.');
      else if (row.Status !== input.status) ops.push({ op: 'update', tab: TAB, key: 'Row_ID', id: id, values: { Status: input.status } });
    });
    if (errs.length) return fail(errs);
    return done(ops, { updated: ops.length });
  }

  // ------------------------------------------------------------------ apply
  function bad(msg) { throw new Error(msg); }

  /** Copies the row arrays so a step can append into them without touching `state`. */
  function workingCopy(state) {
    var work = Object.assign({}, state);
    Object.keys(TABS).forEach(function (t) { work[TABS[t][0]] = (state[TABS[t][0]] || []).slice(); });
    return work;
  }
  function commit(work, ops) {
    ops.forEach(function (o) {
      var t = TABS[o.tab];
      if (!t) return;
      if (o.op === 'append') work[t[0]].push(Object.assign({}, o.values));
      else if (o.op === 'update') {
        var key = o.key || t[1];
        for (var i = 0; i < work[t[0]].length; i++) if (work[t[0]][i][key] === o.id) work[t[0]][i] = Object.assign({}, work[t[0]][i], o.values);
      }
    });
  }
  function restore(cur, snap) { Object.keys(cur).forEach(function (k) { if (!(k in snap)) delete cur[k]; }); return cur; }
  function must(r) { if (r.errors && r.errors.length) bad(r.errors.join(' ')); return r; }

  function hasPurchase(work, accountId) { return (work.purchases || []).some(function (p) { return p.Account_ID === accountId; }); }

  function validDate(v, label) { if (!blank(v) && !isDate(v)) bad(label + ' "' + v + '" is not a date like 2026-10-18.'); }
  function needAmount(v, label, allowZero) {
    var a = amountOf(v);
    if (a.kind === 'blank') bad(label + ' is blank.');
    if (a.kind === 'text') bad(label + ' "' + v + '" is not a number.');
    if (a.value < 0 || (!allowZero && a.value === 0) || a.value >= 1000000) bad(label + ' must be ' + (allowZero ? '0 or more' : 'more than 0') + ' and under 1,000,000.');
    return a.value;
  }

  /** The account a line or extra posts to, in the working state: chosen id, account created earlier in this apply, applied row, or label match. */
  function applyAccount(ctx, work, created, row) {
    var d = ctx.data[row.Row_ID], use = d.use || {};
    if (use.accountId && use.accountId !== 'new') {
      var u = find(work.accounts, 'Account_ID', use.accountId);
      if (!u) bad('Account ' + use.accountId + ' does not exist.');
      return u;
    }
    var staged = stagedAccountOf(ctx, row);
    if (staged) {
      if (created[staged.Row_ID]) return find(work.accounts, 'Account_ID', created[staged.Row_ID]);
      var ap = staged.Status === 'Applied' ? appliedOf(staged) : null;
      if (ap && ap.accountId) { var a1 = find(work.accounts, 'Account_ID', ap.accountId); if (a1) return a1; }
      var am = accMatchOf(ctx, staged);
      if (am.account) return find(work.accounts, 'Account_ID', am.account.Account_ID);
      bad('Account row ' + staged.Row_ID + ' is not applied yet. Approve and apply it first.');
    }
    var ref = text(d.accountRef), byId = ref ? find(work.accounts, 'Account_ID', ref) : null;
    if (byId) return byId;
    bad('No account row matches "' + ref + '".');
  }

  function sourceNote(row) { return row.Sheet ? row.Sheet + '!' + row.Ref : row.Row_ID; }

  function stepAccount(ctx, work, gen, row, created) {
    var d = ctx.data[row.Row_ID], am = matchAccountRow(work, d);
    if (!am.product) bad(am.ambiguous ? 'Several products match "' + text(d.productHint) + '". Pick one.' : 'No product matches "' + text(d.productHint) + '".');
    var cost = needAmount(d.cost, 'Cost', false), slots = needAmount(d.slots, 'Slots', false);
    validDate(d.renewalDate, 'Renewal date');
    var renewal = text(d.renewalDate), ops = [], accountId;
    if (am.account) {
      accountId = am.account.Account_ID;
      var covered = renewal && (work.purchases || []).some(function (p) { return p.Account_ID === accountId && p.Covers_Until >= renewal; });
      if (cost > 0 && renewal && !covered) {
        ops = ops.concat(must(S().planPurchase(work, { accountId: accountId, amount: cost, coversUntil: renewal, notes: 'Migration ' + sourceNote(row), _gen: gen })).ops);
      } else {
        var upd = {};
        if (Number(am.account.Cycle_Cost) !== cost) upd.Cycle_Cost = cost;
        if (renewal && (!am.account.Renewal_Date || renewal > am.account.Renewal_Date)) upd.Renewal_Date = renewal;
        if (Object.keys(upd).length) ops.push({ op: 'update', tab: 'Accounts', key: 'Account_ID', id: accountId, values: upd });
      }
      if (Number(am.account.Slots) !== slots) ops.push({ op: 'update', tab: 'Accounts', key: 'Account_ID', id: accountId, values: { Slots: slots } });
    } else {
      var r = must(S().planAccount(work, { productId: am.product.Product_ID, label: text(d.label), cycleCost: cost, slots: slots,
        renewalDate: renewal, notes: 'Migration ' + sourceNote(row), _gen: gen }));
      accountId = r.result.accountId;
      ops = r.ops;
    }
    created[row.Row_ID] = accountId;
    return { ops: ops, extra: { accountId: accountId } };
  }

  function defaultCoversFrom(d, product, paidTill) {
    if (!blank(d.coversFrom)) return d.coversFrom;
    var months = Math.max(1, Math.floor(Number(d.months) || 1));
    return U().addCycle(paidTill, -months, Number(product && product.Billing_Cycle_Days) || 30);
  }

  function costFor(work, account) {
    if (hasPurchase(work, account.Account_ID)) return 0;
    var per = Number(account.Cost_Per_Slot);
    if (isFinite(per) && per > 0) return per;
    var slots = Number(account.Slots) || 0;
    return slots > 0 ? r2((Number(account.Cycle_Cost) || 0) / slots) : 0;
  }

  /** The customer for a name: matched (chosen or exact) in the working state, else a new Customers row. */
  function customerFor(state, work, gen, name, use, ops, createdNames) {
    var key = norm(name);
    if (use && use.customerId && use.customerId !== 'new') {
      var p = find(work.customers, 'Customer_ID', use.customerId);
      if (!p) bad('Customer ' + use.customerId + ' does not exist.');
      return p;
    }
    if (createdNames[key]) return find(work.customers, 'Customer_ID', createdNames[key]);
    if (use && use.customerId === 'new') {
      if (matchCustomer(state, name, null).customer) bad('A customer named "' + text(name) + '" already exists. Pick them from the list instead of New.');
    } else {
      var m = matchCustomer(work, name, null);
      if (m.ambiguous) bad('Several customers are named "' + text(name) + '". Pick one.');
      if (m.customer) return m.customer;
    }
    var id = gen.customer();
    var values = { Customer_ID: id, Name: text(name).replace(/\s+/g, ' '), Channel: '', Handle: '', Discord_User_ID: '', Notes: '', Created: state.today };
    ops.push({ op: 'append', tab: 'Customers', values: values });
    createdNames[key] = id;
    return values;
  }

  function stepLine(ctx, state, work, gen, row, created, createdNames) {
    var d = ctx.data[row.Row_ID], use = d.use || {};
    if (!text(d.name)) bad('Name is blank.');
    var account = applyAccount(ctx, work, created, row), product = find(work.products, 'Product_ID', account.Product_ID);
    if (!product) bad('Account ' + account.Account_ID + ' has no product.');
    var amount = needAmount(d.amount, 'Amount', true), owed = dueAmountOf(d), price = r2(amount + owed);
    var months = monthsOf(d);
    if (months === null) bad('Months "' + d.months + '" must be a whole number from 1 to 24.');
    var unit = unitOf(price, months);
    validDate(d.paidTill, 'Paid till'); validDate(d.coversFrom, 'Covers from'); validDate(d.renewalDate, 'Renewal date');
    var paidTill = text(d.paidTill) || text(d.renewalDate);
    if (!paidTill) bad('Paid till is blank (and there is no renewal date to use).');
    var coversFrom = defaultCoversFrom(d, product, paidTill);
    var unpaid = /^(due|unpaid)$/i.test(text(d.status));
    var ops = [], note = sourceNote(row), extra = {};
    var customer = customerFor(state, work, gen, d.name, use, ops, createdNames);
    // Match against the working copy so a row sees the sales that earlier rows of this apply added (newest per line wins).
    var existing = use.saleId === 'new' || !(state.customers || []).some(function (c) { return c.Customer_ID === customer.Customer_ID; }) ? null
      : matchSale(work, account.Account_ID, customer, use, { profile: d.profile, isNew: function (s) { return !find(state.sales, 'Sale_ID', s.Sale_ID); } }).sale;

    if (existing && existing.Paid_Till && paidTill > existing.Paid_Till) {
      // Later paid-till than the panel has: a renewal. New sale row (same line) plus its own payment, like planRenew.
      var rid = gen.sale();
      if (existing.Record_Status === 'Active') ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: existing.Sale_ID, values: { Record_Status: 'Renewed' } });
      ops.push({ op: 'append', tab: 'Sales_Log', values: { Sale_ID: rid, Sale_Date: coversFrom, Customer: customer.Name, Contact: text(d.profile) || existing.Contact || '',
        Product_ID: existing.Product_ID, Account_ID: account.Account_ID, Code_ID: '', Qty: 1, Unit_Price: unit, Paid_Till: paidTill,
        Record_Status: truthy(d.ended) ? 'Ended' : 'Active', Notes: '', Customer_ID: customer.Customer_ID, Months: months, Sub_Code: existing.Sub_Code || '',
        Pay_Token: existing.Pay_Token || gen.payToken(), Cost_Snapshot: costFor(work, account), Covers_From: coversFrom } });
      if (!unpaid && amount > 0) {
        ops = ops.concat(S().paymentOps(work, gen, { customerId: customer.Customer_ID, amount: amount, date: coversFrom, source: 'Migration', note: note },
          [{ saleId: rid, balance: amount }]).ops);
      }
      extra.saleId = rid; extra.renewedSaleId = existing.Sale_ID;
      return { ops: ops, extra: extra };
    }
    if (existing) {
      extra.saleId = existing.Sale_ID;
      var diff = r2(amount - L().salePaid(existing, work));
      if (!unpaid && diff > 0) {
        ops = ops.concat(S().paymentOps(work, gen, { customerId: existing.Customer_ID, amount: diff, date: coversFrom, source: 'Migration', note: note },
          [{ saleId: existing.Sale_ID, balance: diff }]).ops);
      }
      if (!existing.Paid_Till) ops.push({ op: 'update', tab: 'Sales_Log', key: 'Sale_ID', id: existing.Sale_ID, values: { Paid_Till: paidTill } });
      return { ops: ops, extra: extra };
    }

    var saleId = gen.sale();
    var subCode = ((work.settings || {}).ref_style === 'random') ? gen.ref() : gen.subCode(product.Letter || 'X');
    ops.push({ op: 'append', tab: 'Sales_Log', values: { Sale_ID: saleId, Sale_Date: coversFrom, Customer: customer.Name, Contact: text(d.profile),
      Product_ID: product.Product_ID, Account_ID: account.Account_ID, Code_ID: '', Qty: 1, Unit_Price: unit, Paid_Till: paidTill,
      Record_Status: truthy(d.ended) ? 'Ended' : 'Active', Notes: '', Customer_ID: customer.Customer_ID, Months: months, Sub_Code: subCode,
      Pay_Token: gen.payToken(), Cost_Snapshot: costFor(work, account), Covers_From: coversFrom } });
    if (!unpaid && amount > 0) {
      ops = ops.concat(S().paymentOps(work, gen, { customerId: customer.Customer_ID, amount: amount, date: coversFrom, source: 'Migration', note: note },
        [{ saleId: saleId, balance: amount }]).ops);
    }
    extra.saleId = saleId;
    return { ops: ops, extra: extra };
  }

  function stepExtra(ctx, state, work, gen, row, created, createdNames) {
    var d = ctx.data[row.Row_ID];
    var account = applyAccount(ctx, work, created, row), accProduct = find(work.products, 'Product_ID', account.Product_ID);
    if (!accProduct) bad('Account ' + account.Account_ID + ' has no product.');
    var amount = needAmount(d.amount, 'Amount', false);
    validDate(d.paidTill, 'Paid till'); validDate(d.coversFrom, 'Covers from');
    var use = d.use || {};
    if (use.saleId && use.saleId !== 'new') {
      var chosen = find(state.sales, 'Sale_ID', Number(use.saleId));
      if (chosen) return { ops: [], extra: { skipped: 'already in the panel as ' + chosen.Sale_ID, saleId: chosen.Sale_ID } };
    } else if (use.saleId !== 'new') {
      var dup = extraDuplicate(state, account.Account_ID, d);
      if (!dup) {
        var wdup = extraDuplicate(work, account.Account_ID, d);
        if (wdup && ctx.extraRowOf && ctx.extraRowOf[wdup.Sale_ID]) return { ops: [], extra: { skipped: 'Duplicate of row ' + ctx.extraRowOf[wdup.Sale_ID] + ' in this batch', saleId: wdup.Sale_ID } };
        dup = wdup;
      }
      if (dup) return { ops: [], extra: { skipped: 'already in the panel as ' + dup.Sale_ID, saleId: dup.Sale_ID } };
    }
    var shape = extraShape(work, accProduct, d), product = shape.product, paidTill = shape.paidTill, coversFrom = shape.coversFrom, date = shape.date;
    var ops = [], note = sourceNote(row);
    var customer = customerFor(state, work, gen, UNLOGGED, null, ops, createdNames);
    var saleId = gen.sale();
    ops.push({ op: 'append', tab: 'Sales_Log', values: { Sale_ID: saleId, Sale_Date: date, Customer: customer.Name, Contact: '',
      Product_ID: product.Product_ID, Account_ID: account.Account_ID, Code_ID: '', Qty: 1, Unit_Price: amount, Paid_Till: paidTill,
      Record_Status: 'Active', Notes: text(d.label) || 'Rent or custom amount', Customer_ID: customer.Customer_ID, Months: 1, Sub_Code: '',
      Pay_Token: '', Cost_Snapshot: 0, Covers_From: coversFrom && paidTill ? coversFrom : '' } });
    ops = ops.concat(S().paymentOps(work, gen, { customerId: customer.Customer_ID, amount: amount, date: date, source: 'Migration', note: note },
      [{ saleId: saleId, balance: amount }]).ops);
    (ctx.extraRowOf = ctx.extraRowOf || {})[saleId] = row.Row_ID;
    return { ops: ops, extra: { saleId: saleId } };
  }

  function stepCode(ctx, work, gen, row) {
    var d = ctx.data[row.Row_ID], code = text(d.code);
    if (!code) bad('Code is blank.');
    var pm = matchProduct(work, d, 'code');
    if (!pm.product) bad(pm.ambiguous ? 'Several products match "' + text(d.productHint) + '". Pick one.' : 'No code product matches "' + text(d.productHint) + '".');
    var r = must(S().planAddCodes(work, { productId: pm.product.Product_ID, codes: [code], batch: text(d.family) || 'Migration', _gen: gen }));
    if (truthy(d.redeemed)) r.ops.forEach(function (o) { o.values.Status = 'Sold'; });
    return { ops: r.ops, extra: r.ops.length ? {} : { skipped: 'code already in inventory' } };
  }

  function stepInbox(ctx, work, row) {
    var d = ctx.data[row.Row_ID], trx = text(d.Transaction_ID).toUpperCase();
    if (!trx) bad('Transaction ID is blank.');
    var amt = amountOf(d.Amount);
    if (amt.kind === 'text') bad('Amount "' + d.Amount + '" is not a number.');
    if (find(work.inbox, 'Transaction_ID', trx)) return { ops: [], extra: { skipped: 'transaction already in the inbox' } };
    return { ops: [{ op: 'append', tab: 'Payment_Inbox', values: { Transaction_ID: trx, Received: text(d.Received), Type: text(d.Type),
      Method: text(d.Method), Sender: text(d.Sender), Amount: amt.kind === 'ok' ? amt.value : '', Counterparty: text(d.Counterparty),
      Reference: text(d.Reference), Raw_SMS: blank(d.Raw_SMS) ? '' : String(d.Raw_SMS), Status: text(d.Status) || 'Pending', Matched_Sale_ID: '' } }], extra: {} };
  }

  /**
   * Turns Approved rows into the ops the normal planners produce, in dependency order (account, line, extra, code, inbox), and marks each
   * row Applied with the ids it created. A row that cannot be applied is skipped (it stays Approved) and listed in result.skipped as {rowId, ref, error}; the rest are applied in one batch. A line or extra whose staged account row failed is skipped too ("Account <ref> could not be applied").
   * input: { batch, rowIds? }. With rowIds, those rows must all be Approved; without, every Approved row of the batch is applied.
   */
  function planApply(state, input) {
    input = input || {};
    var wanted = Array.isArray(input.rowIds) ? input.rowIds.map(String) : null, batch = text(input.batch), errs = [];
    if (!batch && wanted && wanted.length) { var first = rowById(state, wanted[0]); if (first) batch = first.Batch; }
    if (!batch) return fail('Give the batch to apply.');
    var batchRows = allRows(state).filter(function (r) { return r.Batch === batch; });
    var picked;
    if (wanted) {
      picked = [];
      wanted.forEach(function (id) {
        var r = find(batchRows, 'Row_ID', id);
        if (!r) errs.push('Unknown row ' + id + ' in batch ' + batch + '.');
        else if (r.Status !== 'Approved') errs.push('Row ' + id + ' is ' + r.Status + ', not Approved.');
        else if (picked.indexOf(r) < 0) picked.push(r);
      });
      if (errs.length) return fail(errs);
    } else {
      picked = batchRows.filter(function (r) { return r.Status === 'Approved'; });
    }
    var ctx = makeCtx(state, batchRows), alsoApplied = [];
    // includeParents: a line or extra whose account row is not applied yet brings that account row along, in the same apply (one Undo), but only an
    // Approved one. A parent still in Review is refused unless approveParents is set (the panel's "Approve and include"), which approves it explicitly.
    if (input.includeParents) {
      var refused = [];
      picked.slice().forEach(function (r) {
        if (r.Kind !== 'line' && r.Kind !== 'extra') return;
        var pr = stagedAccountOf(ctx, r);
        if (!pr || pr.Status === 'Applied' || pr.Status === 'Skipped' || picked.indexOf(pr) >= 0) return;
        if (pr.Status === 'Approved' || input.approveParents === true) { picked.push(pr); alsoApplied.push(pr.Row_ID); }
        else if (refused.indexOf(pr.Row_ID) < 0) { refused.push(pr.Row_ID); errs.push('Approve account ' + (pr.Ref || pr.Row_ID) + ' first, or approve both.'); }
      });
      if (errs.length) return fail(errs);
    }
    if (!picked.length) return fail('No approved rows to apply.');

    var work = workingCopy(state), gen = Core.ids.IdGen(state);
    var created = {}, createdNames = {}, allOps = [], markOps = [], secrets = [], skipped = [], failedAccount = {};
    function skipRow(row, message) { skipped.push({ rowId: row.Row_ID, ref: sourceNote(row), error: message }); }
    var totals = { customers: 0, sales: 0, payments: 0, accounts: 0, purchases: 0, codes: 0, inbox: 0 };
    APPLY_ORDER.forEach(function (kind) {
      picked.filter(function (r) { return r.Kind === kind; }).forEach(function (row) {
        // Roll back what a failed step may have touched outside its ops: the id maps. (Ids drawn from gen are simply left unused.)
        var snapCreated = Object.assign({}, created), snapNames = Object.assign({}, createdNames);
        try {
          if (kind === 'line' || kind === 'extra') {
            var par = stagedAccountOf(ctx, row);
            var usedId = (ctx.data[row.Row_ID].use || {}).accountId;
            if (par && failedAccount[par.Row_ID] && !(usedId && usedId !== 'new')) bad('Account ' + sourceNote(par) + ' could not be applied.');
          }
          if (!parseJson(row.Data)) bad('Data is not valid JSON.');
          var step;
          if (kind === 'account') step = stepAccount(ctx, work, gen, row, created);
          else if (kind === 'line') step = stepLine(ctx, state, work, gen, row, created, createdNames);
          else if (kind === 'extra') step = stepExtra(ctx, state, work, gen, row, created, createdNames);
          else if (kind === 'code') step = stepCode(ctx, work, gen, row);
          else step = stepInbox(ctx, work, row);
          commit(work, step.ops);
          var ids = {};
          step.ops.forEach(function (o) {
            var k = CREATED_KEY[o.tab];
            if (o.op !== 'append' || !k) return;
            (ids[k] = ids[k] || []).push(o.values[TABS[o.tab][1]]);
            totals[k]++;
          });
          Object.keys(step.extra || {}).forEach(function (k) { ids[k] = step.extra[k]; });
          allOps = allOps.concat(step.ops);
          markOps.push({ op: 'update', tab: TAB, key: 'Row_ID', id: row.Row_ID, values: { Status: 'Applied', Applied: JSON.stringify(ids) } });
          // A row with an encrypted login: tell the server where it now belongs (the account row's account, or the line's sale and its account).
          if ((kind === 'account' || kind === 'line' || kind === 'extra') && hasSecret(ctx.data[row.Row_ID])) {
            var sid = ids.saleId === undefined ? '' : String(ids.saleId), accId = ids.accountId || '';
            if (!accId && sid) { var sl = find(work.sales, 'Sale_ID', ids.saleId); accId = sl ? sl.Account_ID : ''; }
            var slk = sid ? find(work.sales, 'Sale_ID', ids.saleId) : null;
            secrets.push({ rowId: row.Row_ID, accountId: accId, saleId: sid, saleToken: slk ? String(slk.Pay_Token || slk.Sub_Code || '') : '' });
          }
        } catch (e) {
          created = restore(created, snapCreated); createdNames = restore(createdNames, snapNames);
          if (kind === 'account') failedAccount[row.Row_ID] = true;
          skipRow(row, e && e.message ? e.message : String(e));
        }
      });
    });
    // Rows that failed stay Approved (no mark op). Everything else is one batch, so one Undo.
    return done(allOps.concat(markOps), { applied: markOps.length, created: totals, secrets: secrets, alsoApplied: alsoApplied, skipped: skipped });
  }

  return { TAB: TAB, KINDS: KINDS, FIELDS: FIELDS, planStage: planStage, review: review, planEditRow: planEditRow, planAddRow: planAddRow,
    planDeleteRow: planDeleteRow, planSetStatus: planSetStatus, planApply: planApply, normData: normData, hasSecret: hasSecret, LOGIN_FIELDS: LOGIN_FIELDS };
})();
if (typeof module !== 'undefined') module.exports = Core.importer;

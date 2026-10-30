/**
 * Core.paylinks: what a customer's pay link offers and where their order stands.
 * Pure: the server reads the rows, this decides. Methods come from settings; a payment is
 * recognised by its reference, or by the payer's number plus an amount that covers the price.
 */
var Core = Core || {};
Core.paylinks = (function () {
  var METHOD_IDS = ['bkash', 'nagad', 'upay', 'bank'];
  var LABEL = { bkash: 'bKash', nagad: 'Nagad', upay: 'Upay', bank: 'Bank transfer' };
  var r2 = function (n) { return Core.util.round2(n); };
  function digits(v) { return String(v || '').replace(/\D/g, ''); }

  /** "+8801711223344", "8801711223344" and "01711223344" all become "01711223344". A non-number gives ''. */
  function normalizeNumber(v) {
    var d = digits(v);
    if (d.indexOf('880') === 0 && d.length === 13) d = d.slice(2);
    return /^01\d{9}$/.test(d) ? d : '';
  }

  /** Spellings of one number the SMS parser may have stored as counterparty. */
  function numberForms(v) {
    var n = normalizeNumber(v);
    return n ? [n, '+88' + n, '88' + n] : [];
  }

  function idList(raw) {
    var ids = String(raw).split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(function (x) { return METHOD_IDS.indexOf(x) >= 0; });
    return METHOD_IDS.filter(function (id) { return ids.indexOf(id) >= 0; });
  }
  function enabledIds(settings) { return idList((settings || {}).pay_methods === undefined ? 'bkash' : settings.pay_methods); }
  /** Methods whose payments confirm themselves from the SMS relay. The rest the owner confirms by hand. A bank transfer is always by hand. */
  function autoIds(settings) {
    return idList((settings || {}).pay_auto_verify === undefined ? 'bkash' : settings.pay_auto_verify).filter(function (id) { return id !== 'bank'; });
  }

  /**
   * The methods the customer can pick, in a fixed order. A wallet method is `ready` when its number is set;
   * the bank method when it has an account number. A method that is not ready is still listed so the page can say so.
   */
  function methods(settings) {
    var s = settings || {};
    var auto = autoIds(s);
    return enabledIds(s).map(function (id) {
      var m = { id: id, label: LABEL[id], ready: false, auto: auto.indexOf(id) >= 0 };
      if (id === 'bank') {
        m.bankName = String(s.bank_name || ''); m.accountName = String(s.bank_account_name || '');
        m.accountNumber = String(s.bank_account_number || ''); m.branch = String(s.bank_branch || ''); m.routing = String(s.bank_routing || ''); m.note = String(s.bank_note || '');
        m.ready = !!m.accountNumber;
      } else {
        m.number = String(s[id + '_number'] || '');
        m.ready = !!m.number;
      }
      return m;
    });
  }

  function receivedAfter(row, since) {
    return !since || String(row.Received || '') >= String(since);
  }

  /** Inbox rows that belong to this order: same reference, or the payer's number with an amount that covers the price. */
  function paymentsFor(rows, subCode, price, intent) {
    var code = String(subCode || '').toUpperCase();
    var payer = intent ? normalizeNumber(intent.Payer_Number) : '';
    return (rows || []).filter(function (r) {
      if (code && String(r.Reference || '').trim().toUpperCase() === code) return true;
      if (code && Core.refs.isRandomRef(code) && Core.refs.hasToken(r.Reference, code)) return true;
      if (!payer || Core.matching.rowType(r) !== 'Received') return false;
      return normalizeNumber(r.Counterparty) === payer && Number(r.Amount) >= price && price > 0 && receivedAfter(r, intent.Created);
    });
  }

  /**
   * Where the order stands: created (link exists), waiting (customer chose a method and gave a number),
   * claimed (customer says they paid), received (a matching message arrived), confirmed (it was matched to the sale).
   */
  function orderStatus(subCode, price, intent, inboxRows, paymentRows) {
    var paid = paymentsFor(inboxRows, subCode, price, intent);
    var rows = paid.map(function (r) { return { amount: Number(r.Amount) || 0, date: r.Received || '', status: r.Status || '' }; });
    var stage = 'created';
    if (intent) stage = intent.Claimed === 'Yes' ? 'claimed' : 'waiting';
    if (paid.length) stage = paid.some(function (r) { return r.Status === 'Matched'; }) ? 'confirmed' : 'received';
    // A payment the owner recorded by hand (Got paid) confirms the order: same transaction id as the claim, or for this line since the link was used.
    var recorded = (paymentRows || []).filter(function (p) {
      var trx = intent && String(intent.Claim_Trx || '').trim().toUpperCase();
      if (trx && String(p.Transaction_ID || '').trim().toUpperCase() === trx) return true;
      return !!intent && intent.Claimed === 'Yes' && p.Date && String(p.Date) >= String(intent.Created || '').slice(0, 10);
    });
    if (recorded.length) {
      stage = 'confirmed';
      recorded.forEach(function (p) { rows.push({ amount: Number(p.Amount) || 0, date: p.Date || '', status: 'Recorded' }); });
    }
    return { stage: stage, paid: rows.length > 0, rows: rows, method: intent ? intent.Method : '' };
  }

  /** Checks what the pay page sends before it is stored. Returns { values } or { error }. */
  function planIntent(settings, input) {
    var method = String((input || {}).method || '').toLowerCase();
    if (enabledIds(settings).indexOf(method) < 0) return { error: 'Pick one of the payment methods shown.' };
    var number = normalizeNumber((input || {}).number);
    if (!number) return { error: 'Enter your 11-digit mobile number, like 01XXXXXXXXX.' };
    var claimed = (input || {}).claimed === true;
    var trx = String((input || {}).trx || '').trim().slice(0, 40);
    if (trx && !/^[A-Za-z0-9 _.\/#-]+$/.test(trx)) return { error: 'The transaction ID can only use letters, numbers and - _ . / #.' };
    if (claimed && !trx && autoIds(settings).indexOf(method) < 0) return { error: 'Add the transaction ID so the seller can find your payment.' };
    return { values: { Method: method, Payer_Number: number, Claim_Trx: trx, Claimed: claimed ? 'Yes' : '' } };
  }

  /** Rows for the owner's Pay links tab: one per live line, with its link state. */
  function list(state) {
    var intents = {}, paidByLine = {};
    (state.payIntents || []).forEach(function (i) { intents[i.Token] = i; });
    var prod = {}, cust = {}, gone = {};
    (state.accounts || []).forEach(function (a) { if (a.Account_Status === 'Deleted') gone[a.Account_ID] = true; });
    (state.products || []).forEach(function (p) { prod[p.Product_ID] = p; });
    (state.customers || []).forEach(function (c) { cust[c.Customer_ID] = c; });
    var paid = Core.ledger.paidMap(state);
    var lines = {};
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status !== 'Active' || !s.Sub_Code || Core.sales.deliversAs(prod[s.Product_ID]) === 'code' || gone[s.Account_ID]) return;
      var cur = lines[s.Sub_Code];
      if (!cur || Number(s.Sale_ID) > Number(cur.Sale_ID)) lines[s.Sub_Code] = s;
    });
    var out = [], missing = 0;
    Object.keys(lines).forEach(function (code) {
      var s = lines[code], c = cust[s.Customer_ID] || { Name: s.Customer }, p = prod[s.Product_ID] || {};
      if (/^(Unlogged payment|Bkash Recieve)/i.test(String(c.Name || ''))) return;
      var price = Core.ledger.salePrice(s, state.products);
      var owes = r2(Core.ledger.saleRevenue(s, state.products) - (paid[s.Sale_ID] || 0));
      var intent = s.Pay_Token ? intents[s.Pay_Token] : null;
      var rows = (state.inbox || []);
      var mine = (state.payments || []).filter(function (p) { return p.Sale_ID === s.Sale_ID || (intent && intent.Claim_Trx && String(p.Transaction_ID).toUpperCase() === String(intent.Claim_Trx).toUpperCase()); });
      var status = s.Pay_Token ? orderStatus(code, price, intent, rows, mine) : { stage: 'none', paid: false, rows: [], method: '' };
      if (!s.Pay_Token) missing++;
      out.push({ saleId: s.Sale_ID, subCode: code, token: s.Pay_Token || '', customerId: s.Customer_ID, name: c.Name || s.Customer,
        channel: c.Channel || '', handle: c.Handle || '', productName: p.Product_Name || s.Product_ID, accountId: s.Account_ID,
        price: price, owes: owes > 0 ? owes : 0, paidTill: s.Paid_Till || '',
        daysLeft: s.Paid_Till ? Core.util.daysBetween(state.today, s.Paid_Till) : null,
        stage: status.stage, method: intent ? intent.Method : '', payer: intent ? intent.Payer_Number : '',
        claimTrx: intent ? intent.Claim_Trx || '' : '', updated: intent ? intent.Updated || '' : '' });
    });
    var ORDER = { claimed: 0, received: 1, waiting: 2, created: 3, none: 4, confirmed: 5 };
    out.sort(function (a, b) {
      if (ORDER[a.stage] !== ORDER[b.stage]) return ORDER[a.stage] - ORDER[b.stage];
      var da = a.daysLeft === null ? 1e9 : a.daysLeft, db = b.daysLeft === null ? 1e9 : b.daysLeft;
      return da - db || a.saleId - b.saleId;
    });
    return { rows: out, missing: missing, methods: methods(state.settings) };
  }

  // ---------------------------------------------------------------- pay requests (a link before there is a sale)
  function reqFail(msg, code) { return { ops: [], result: null, errors: [msg], code: code }; }
  function findBy(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function nowOf(state, input) { return Number((input && input.nowMs) || (state && state.nowMs) || Date.now()); }

  /**
   * Open a payment request. A product that delivers a code reserves the first Available code of that product
   * (code Status 'Reserved'); a seat product reserves nothing. input: {title, amount, customerId?, customerName?,
   * productId?, note?, hours?, nowMs?, _gen?}. The SMS reference for the customer is the Request_ID (e.g. R12).
   * Must run under the router's write lock: the code reservation is a plain update, not a compare-and-set.
   */
  function planCreateRequest(state, input) {
    input = input || {};
    var title = String(input.title || '').trim() || 'Payment';
    if (title.length > 120) return reqFail('The title can be up to 120 characters.');
    if (String(input.note || '').trim().length > 500) return reqFail('The note can be up to 500 characters.');
    var typedName = String(input.customerName || '').trim().replace(/\s+/g, ' ');
    if (typedName.length > 120) return reqFail('The customer name can be up to 120 characters.');
    var amount = input.amount;
    if (typeof amount === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(amount)) amount = Number(amount);
    if (typeof amount !== 'number' || !isFinite(amount) || amount < 1 || amount > 999999) return reqFail('Amount must be from 1 to 999,999.');
    var customer = null;
    if (input.customerId) {
      customer = findBy(state.customers, 'Customer_ID', input.customerId);
      if (!customer) return reqFail('Unknown customer ' + input.customerId + '.');
    }
    if (!customer && typedName && (state.customers || []).some(function (c) { return String(c.Name).trim().toLowerCase() === typedName.toLowerCase(); })) {
      return reqFail('A customer named "' + typedName + '" already exists. Pick them from the list, or use a different name.', 'customer_name_taken');
    }
    var product = null, code = null;
    if (input.productId) {
      product = findBy(state.products, 'Product_ID', input.productId);
      if (!product) return reqFail('Unknown product ' + input.productId + '.');
      if (Core.sales.deliversAs(product) === 'code') {
        var sold = {};
        (state.sales || []).forEach(function (s) { if (s.Code_ID && s.Record_Status !== 'Void') sold[s.Code_ID] = true; });
        code = (state.codes || []).filter(function (c) {
          return c.Product_ID === product.Product_ID && c.Status === 'Available' && !sold[c.Code_ID];
        })[0] || null;
        if (!code) return reqFail('Out of stock');
      }
    }
    var hours;
    if (input.hours === undefined || input.hours === null || input.hours === '') {
      hours = Number((state.settings || {}).pay_link_expiry_hours);
      if (!(hours >= 1 && hours <= 720)) hours = 24;
    } else {
      hours = Number(input.hours);
      if (!(hours >= 1 && hours <= 720)) return reqFail('Expiry must be from 1 to 720 hours.');
    }
    var now = nowOf(state, input);
    var gen = input._gen || Core.ids.IdGen(state);
    var id = gen.request(), token = gen.requestToken();
    var ref = (state.settings || {}).ref_style === 'random' ? gen.ref(input._rand) : '';
    var ops = [{ op: 'append', tab: 'Pay_Requests', values: {
      Request_ID: id, Token: token, Title: title, Amount: amount, Customer_ID: customer ? customer.Customer_ID : '', Ref: ref,
      Customer_Name: customer ? customer.Name : String(input.customerName || '').trim(), Product_ID: product ? product.Product_ID : '',
      Code_ID: code ? code.Code_ID : '', Note: String(input.note || '').trim(), Status: 'Open',
      Created: new Date(now).toISOString(), Expires: new Date(now + hours * 3600000).toISOString(), Sale_ID: '' } }];
    if (code) ops.push({ op: 'update', tab: 'Code_Inventory', key: 'Code_ID', id: code.Code_ID, values: { Status: 'Reserved' } });
    return { ops: ops, result: { requestId: id, token: token, ref: ref || id }, errors: [] };
  }

  function releaseOps(state, rq, status) {
    var ops = [{ op: 'update', tab: 'Pay_Requests', key: 'Request_ID', id: rq.Request_ID, values: { Status: status } }];
    var code = rq.Code_ID ? findBy(state.codes, 'Code_ID', rq.Code_ID) : null;
    var other = (state.payRequests || []).some(function (x) { return x !== rq && x.Status === 'Open' && x.Code_ID === rq.Code_ID; });
    if (code && code.Status === 'Reserved' && !other) ops.push({ op: 'update', tab: 'Code_Inventory', key: 'Code_ID', id: code.Code_ID, values: { Status: 'Available' } });
    return ops;
  }

  /** Cancel an Open request and free its reserved code. */
  function planCancelRequest(state, input) {
    var id = String((input || {}).id || '').trim().toUpperCase();
    var rq = findBy(state.payRequests, 'Request_ID', id);
    if (!rq) return reqFail('Unknown request ' + ((input || {}).id || '') + '.');
    if (rq.Status !== 'Open') return reqFail(rq.Request_ID + ' is ' + rq.Status + ', so it cannot be cancelled.');
    return { ops: releaseOps(state, rq, 'Cancelled'), result: { requestId: rq.Request_ID }, errors: [] };
  }

  /** Open requests past `Expires` become Expired and their Reserved codes go back to Available. nowMs defaults to state.nowMs or the clock. */
  function planExpireRequests(state, nowMs) {
    var now = Number(nowMs || (state && state.nowMs) || Date.now()), ops = [];
    (state.payRequests || []).forEach(function (rq) {
      var t = Date.parse(rq.Expires || '');
      if (rq.Status === 'Open' && isFinite(t) && t <= now) ops = ops.concat(releaseOps(state, rq, 'Expired'));
    });
    return ops;
  }

  /** The customer-facing reference of a request: its random Ref, or the Request_ID for legacy requests. */
  function requestRef(rq) { return (rq && rq.Ref) || rq.Request_ID; }

  /** Same stages as orderStatus; the request reference is the payment reference. Plus the request's own Status. */
  function requestStatus(state, rq) {
    var intent = null;
    (state.payIntents || []).forEach(function (i) { if (rq.Token && i.Token === rq.Token) intent = i; });
    var recorded = rq.Sale_ID === '' || rq.Sale_ID === null || rq.Sale_ID === undefined ? [] :
      (state.payments || []).filter(function (p) { return String(p.Sale_ID) === String(rq.Sale_ID); });
    var st = orderStatus(requestRef(rq), Number(rq.Amount) || 0, intent, state.inbox, recorded);
    st.status = rq.Status;
    return st;
  }

  /** Public pay link for a request, or '' when no base URL is set. */
  function requestUrl(settings, rq) {
    var base = String((settings || {}).pay_base_url || '').replace(/\/+$/, '');
    return base && rq && rq.Token ? base + '/pay/' + encodeURIComponent(rq.Token) : '';
  }

  return { requestRef: requestRef, METHOD_IDS: METHOD_IDS, LABEL: LABEL, normalizeNumber: normalizeNumber, numberForms: numberForms, enabledIds: enabledIds, autoIds: autoIds,
           methods: methods, paymentsFor: paymentsFor, orderStatus: orderStatus, planIntent: planIntent, list: list,
           planCreateRequest: planCreateRequest, planCancelRequest: planCancelRequest, planExpireRequests: planExpireRequests,
           requestStatus: requestStatus, requestUrl: requestUrl };
})();
if (typeof module !== 'undefined') module.exports = Core.paylinks;

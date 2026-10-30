/**
 * Core.delivery: confirming a paid pay request (one op set: payment, sale, code Sold, request Paid, delivery row, inbox Matched),
 * the owner's delivery list and status changes, and the receipt the pay page shows. Pure: planners return {ops, result, errors}.
 */
var Core = Core || {};
Core.delivery = (function () {
  var STATUSES = ['Pending', 'Ready', 'Delivered', 'Failed'];
  var NOTE_MAX = 500;
  var r2 = function (n) { return Core.util.round2(n); };

  function fail(msg) { return { ops: [], result: null, errors: [msg] }; }
  function find(rows, field, val) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][field] === val) return rows[i]; return null; }
  function blank(v) { return v === '' || v === null || v === undefined; }
  function nowOf(state, input) { return Number((input && input.nowMs) || (state && state.nowMs) || Date.now()); }
  function upper(v) { return String(v || '').trim().toUpperCase(); }

  /** The customer row the sale goes to: the request's customer, or a new one named after the request (never an existing namesake). */
  function saleCustomer(state, rq) {
    if (rq.Customer_ID) {
      var c = find(state.customers, 'Customer_ID', rq.Customer_ID);
      return c ? { customerId: c.Customer_ID } : { error: 'Unknown customer ' + rq.Customer_ID + ' on ' + rq.Request_ID + '.' };
    }
    var taken = function (n) {
      return (state.customers || []).some(function (c) { return String(c.Name).trim().toLowerCase() === n.toLowerCase(); });
    };
    var name = String(rq.Customer_Name || '').trim().replace(/\s+/g, ' ') || 'Pay link ' + rq.Request_ID;
    if (taken(name)) name = name + ' (' + rq.Request_ID + ')';
    if (taken(name)) return { error: 'A customer named "' + name + '" already exists.' };
    return { newCustomer: { name: name } };
  }

  /**
   * Linked to rq by its note alone: the no-product pay link row ('Pay link <RQ>: title') and the overpaid credit row ('Overpaid on <RQ>').
   * Such a row has no sale, so the note is the only link; editing the note would unlink it.
   */
  function linkedByNote(p, rq) {
    var note = String(p.Note || '');
    var over = 'Overpaid on ' + rq.Request_ID;
    return note.indexOf('Pay link ' + rq.Request_ID + ':') === 0 || note === over || note.indexOf(over + ',') === 0;
  }

  /**
   * A note that would link a payment to a pay request, for any request id: the same two forms as linkedByNote. Only the app writes
   * them; a typed note in either form would forge a link, so the planner refuses it.
   */
  function claimsRequestNote(note) {
    var t = String(note || '');
    return /^Pay link \S+:/.test(t) || /^Overpaid on \S+(,|$)/.test(t);
  }

  /** A payment row written by confirming rq: on its sale, or (no-product requests, overpayment rows) noted with its id. */
  function paidFor(p, rq) {
    if (!blank(rq.Sale_ID) && !blank(p.Sale_ID) && String(p.Sale_ID) === String(rq.Sale_ID)) return true;
    return linkedByNote(p, rq);
  }

  // Methods Got paid accepts (pay methods plus the owner's cash / other), stored under one label each.
  var METHOD_LABEL = { bkash: 'bKash', nagad: 'Nagad', upay: 'Upay', bank: 'Bank', 'bank transfer': 'Bank', cash: 'Cash', other: 'Other' };
  var BY_HAND = ' Match the payment by hand from Today, then cancel ';

  /**
   * Why Got paid cannot confirm rq right now, or null when it can: not Open, past Expires (now as in planConfirmRequest),
   * or a code product whose code is missing, no longer Reserved or already on a sale. Matching uses this to decide whether
   * hand-matching the SMS is refused (only when Got paid would work).
   */
  function blocked(state, rq, nowMs) {
    if (rq.Status !== 'Open') return rq.Request_ID + ' is ' + rq.Status + ', so it cannot be confirmed. Match the payment by hand from Today.';
    var exp = Date.parse(rq.Expires || '');
    if (isFinite(exp) && exp <= Number(nowMs)) return rq.Request_ID + ' expired at ' + rq.Expires + ', so it cannot be confirmed.' + BY_HAND + rq.Request_ID + '.';
    var product = rq.Product_ID ? find(state.products, 'Product_ID', rq.Product_ID) : null;
    if (product && Core.sales.deliversAs(product) === 'code') {
      var code = rq.Code_ID ? find(state.codes, 'Code_ID', rq.Code_ID) : null;
      if (!code || code.Product_ID !== product.Product_ID) return rq.Request_ID + ' holds no ' + product.Product_ID + ' code.' + BY_HAND + rq.Request_ID + '.';
      if (code.Status !== 'Reserved') return 'Code ' + code.Code_ID + ' for ' + rq.Request_ID + ' is no longer reserved (' + (code.Status || 'no status') + ').' + BY_HAND + rq.Request_ID + '.';
      var onSale = (state.sales || []).some(function (s) { return s.Code_ID === code.Code_ID && s.Record_Status !== 'Void'; });
      if (onSale) return 'Code ' + code.Code_ID + ' for ' + rq.Request_ID + ' is already sold.' + BY_HAND + rq.Request_ID + '.';
    }
    // A name-only request whose namesake customers block the sale: Got paid would refuse, so hand-matching must stay open.
    if (product && !rq.Customer_ID) {
      var who = saleCustomer(state, rq);
      if (who.error) return who.error + BY_HAND + rq.Request_ID + '.';
    }
    return null;
  }

  /** True when Got paid can confirm rq now (see blocked). */
  function confirmable(state, rq, nowMs) { return blocked(state, rq, nowMs === undefined ? nowOf(state, null) : nowMs) === null; }

  /** Underpayment: what the owner can do about it. */
  function shortMessage(rq, amount) {
    var due = Number(rq.Amount) || 0;
    return 'Paid ৳' + amount + ' is less than the ৳' + due + ' asked for ' + rq.Request_ID + ', so nothing was delivered. ' +
      'Ask the customer for the remaining ৳' + r2(due - amount) + ', or cancel ' + rq.Request_ID + ' and match this payment by hand.';
  }

  /** First Active account of the product with a free seat, in table order. */
  function freeAccount(state, productId) {
    return (state.accounts || []).filter(function (a) {
      return a.Product_ID === productId && (!a.Account_Status || a.Account_Status === 'Active') && Core.sales.freeSlots(state, a) > 0;
    })[0] || null;
  }

  var UNLOGGED_NAME = 'Unlogged payment (pay links)';
  /** Customer a payment books to: the link's customer, else the shared placeholder (reused if in state or already appended in `ops`, else created in `ops`). */
  function bookingCustomer(state, gen, rq, ops) {
    if (rq.Customer_ID) return rq.Customer_ID;
    var made = ops.filter(function (o) { return o.op === 'append' && o.tab === 'Customers' && o.values.Name === UNLOGGED_NAME; })[0];
    if (made) return made.values.Customer_ID;
    var have = (state.customers || []).filter(function (c) { return c.Name === UNLOGGED_NAME; })[0];
    if (have) return have.Customer_ID;
    var id = gen.customer();
    ops.push({ op: 'append', tab: 'Customers', values: { Customer_ID: id, Name: UNLOGGED_NAME, Channel: '', Handle: '',
      Discord_User_ID: '', Notes: '', Created: state.today } });
    return id;
  }

  /**
   * Confirm that an Open request was paid. input: {id, trx, method, amount, source, date?, nowMs?, _gen?}.
   * Idempotent by transaction id: when that Transaction_ID already confirmed THIS request, no ops and result.duplicate;
   * when it is booked for anything else, an error. The inbox row with that trx, if present, becomes Matched.
   * Refuses (no ops): unknown, Paid, Expired or Cancelled request, an Open request past Expires, amount below the request
   * amount, a reserved code that is no longer Reserved or already on a sale, a seat product with no free seat.
   * Code product: sale (planNewSale, price = request amount) with the reserved code, code Sold, delivery 'Delivered'.
   * Seat product: sale on the first account with a free seat, delivery 'Pending' (delivered by hand).
   * No product: a payment only, no sale and no delivery; it is not booked as the customer's credit.
   * Overpayment: the excess is the customer's credit when the request names a customer; otherwise it is booked to nobody
   * and noted on the delivery (or on the payment when there is no delivery).
   */
  function planConfirmRequest(state, input) {
    input = input || {};
    var trx = upper(input.trx);
    var rq = find(state.payRequests, 'Request_ID', upper(input.id));
    if (!rq) return fail('Unknown request ' + (input.id || '') + '.');
    var same = trx ? (state.payments || []).filter(function (p) { return upper(p.Transaction_ID) === trx; }) : [];
    if (same.length) {
      // A no-op only when that money already confirmed THIS request; money booked for anything else is not a confirmation.
      if (rq.Status === 'Paid' && same.some(function (p) { return paidFor(p, rq); })) {
        return { ops: [], errors: [], result: { duplicate: true, requestId: rq.Request_ID } };
      }
      return fail('Transaction ' + trx + ' is already recorded for something else.');
    }
    var methodLabel = METHOD_LABEL[String(input.method || '').trim().toLowerCase()];
    if (!methodLabel) return fail('Pick a payment method: bKash, Nagad, Upay, Bank, Cash or Other.');
    var now = nowOf(state, input), why = blocked(state, rq, now);
    if (why) return fail(why);
    var amount = input.amount;
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || amount >= 1000000) return fail('Amount must be more than 0 and less than 1,000,000.');
    var due = Number(rq.Amount) || 0;
    if (!(due > 0)) return fail(rq.Request_ID + ' has no amount.');
    if (amount < due) return fail(shortMessage(rq, amount));
    if (input._role !== undefined && input._role !== 'owner' && amount !== due) return fail('Only the owner can set a custom amount.');
    var excess = r2(amount - due);

    var product = rq.Product_ID ? find(state.products, 'Product_ID', rq.Product_ID) : null;
    if (rq.Product_ID && !product) return fail('Unknown product ' + rq.Product_ID + ' on ' + rq.Request_ID + '.');
    var isCode = !!product && Core.sales.deliversAs(product) === 'code';
    var gen = input._gen || Core.ids.IdGen(state);
    var method = methodLabel, source = String(input.source || 'App');
    var pay = { method: method, trxId: trx, source: source, date: input.date || state.today };
    var ops = [], saleId = '', customerId = rq.Customer_ID || '', code = null, account = null, notes = [];

    if (product) {
      var who = saleCustomer(state, rq);
      if (who.error) return fail(who.error);
      var saleState = state;
      if (isCode) {
        code = find(state.codes, 'Code_ID', rq.Code_ID); // checked by blocked(): this product's code, Reserved, on no sale
        // planNewSale sells Available codes only; show it this request's reserved code as Available. It still refuses a code on a sale.
        saleState = Object.assign({}, state, { codes: (state.codes || []).map(function (c) { return c === code ? Object.assign({}, c, { Status: 'Available' }) : c; }) });
      } else {
        account = freeAccount(state, product.Product_ID);
        if (!account) return fail('No free seat on any ' + product.Product_ID + ' account. Add one, then confirm ' + rq.Request_ID + '.');
      }
      var paidNow = r2(customerId ? amount : due);
      var sale = Core.sales.planNewSale(saleState, { productId: product.Product_ID, customerId: who.customerId, newCustomer: who.newCustomer,
        codeId: code ? code.Code_ID : undefined, accountId: account ? account.Account_ID : undefined, months: 1, price: due,
        notes: 'Pay link ' + rq.Request_ID, paidNow: { amount: paidNow, method: method, trxId: trx }, source: source, _gen: gen });
      if (sale.errors.length) return fail(sale.errors[0]);
      sale.ops.forEach(function (o) { if (o.tab === 'Payments') o.values.Date = pay.date; });
      ops = ops.concat(sale.ops);
      saleId = sale.result.saleId; customerId = sale.result.customerId;
      if (code) ops.push({ op: 'update', tab: 'Code_Inventory', key: 'Code_ID', id: code.Code_ID, values: { Status: 'Sold' } });
      if (excess > 0 && rq.Customer_ID) notes.push('Overpaid ৳' + excess + ', kept as credit.');
    } else {
      var owner = bookingCustomer(state, gen, rq, ops);
      ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ customerId: owner, amount: due,
        note: 'Pay link ' + rq.Request_ID + ': ' + String(rq.Title || '') }, pay), []).ops);
      if (excess > 0 && rq.Customer_ID) {
        ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ customerId: rq.Customer_ID, amount: excess,
          note: 'Overpaid on ' + rq.Request_ID }, pay), []).ops);
        notes.push('Overpaid ৳' + excess + ', kept as credit.');
      }
    }
    if (excess > 0 && !rq.Customer_ID) {
      var holder = bookingCustomer(state, gen, rq, ops);
      ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ customerId: holder, amount: excess,
        note: 'Overpaid on ' + rq.Request_ID + ', no customer to credit' }, pay), []).ops);
      notes.push('Overpaid ৳' + excess + ' (no customer to credit).');
    }

    ops.push({ op: 'update', tab: 'Pay_Requests', key: 'Request_ID', id: rq.Request_ID, values: { Status: 'Paid', Sale_ID: saleId } });
    var deliveryId = '';
    if (product) {
      deliveryId = gen.delivery();
      ops.push({ op: 'append', tab: 'Deliveries', values: { Delivery_ID: deliveryId, Sale_ID: saleId, Request_ID: rq.Request_ID,
        Customer_ID: customerId, Product_ID: product.Product_ID, Code_ID: code ? code.Code_ID : '', Kind: isCode ? 'code' : 'seat',
        Status: isCode ? 'Delivered' : 'Pending', Delivered_At: isCode ? new Date(now).toISOString() : '', Note: notes.join(' ') } });
    }
    var inboxRow = trx && (state.inbox || []).some(function (r) { return upper(r.Transaction_ID) === trx; });
    if (inboxRow) {
      ops.push({ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched', Matched_Sale_ID: saleId } });
    }
    return { ops: ops, errors: [], result: { requestId: rq.Request_ID, saleId: saleId, customerId: customerId, deliveryId: deliveryId,
      delivered: isCode, excess: excess, note: notes.join(' ') } };
  }

  /** Owner sets a delivery's status. input: {id, status, note?, nowMs?}. Delivered stamps Delivered_At; other statuses clear it. */
  function planSetDelivery(state, input) {
    input = input || {};
    var row = find(state.deliveries, 'Delivery_ID', upper(input.id));
    if (!row) return fail('Unknown delivery ' + (input.id || '') + '.');
    if (STATUSES.indexOf(input.status) < 0) return fail('Status must be Pending, Ready, Delivered or Failed.');
    var values = { Status: input.status };
    if (input.note !== undefined && input.note !== null) {
      var note = String(input.note).trim();
      if (note.length > NOTE_MAX) return fail('Note must be ' + NOTE_MAX + ' characters or fewer.');
      values.Note = note;
    }
    values.Delivered_At = input.status === 'Delivered' ? new Date(nowOf(state, input)).toISOString() : '';
    return { ops: [{ op: 'update', tab: 'Deliveries', key: 'Delivery_ID', id: row.Delivery_ID, values: values }], errors: [], result: { id: row.Delivery_ID } };
  }

  /** Rows for the Delivery tab, newest first, optionally one status. Code values are never included (Code_ID only). */
  function listDeliveries(state, filter) {
    var status = filter && filter.status;
    var base = String(((state.settings || {}).pay_base_url) || '').replace(/\/+$/, '');
    return (state.deliveries || []).filter(function (d) { return !status || d.Status === status; }).map(function (d) {
      var c = find(state.customers, 'Customer_ID', d.Customer_ID), p = find(state.products, 'Product_ID', d.Product_ID);
      var rq = d.Request_ID ? find(state.payRequests, 'Request_ID', d.Request_ID) : null;
      var sale = blank(d.Sale_ID) ? null : find(state.sales, 'Sale_ID', Number(d.Sale_ID));
      var url = rq ? Core.paylinks.requestUrl(state.settings, rq) : (base && sale && sale.Pay_Token ? base + '/pay/' + encodeURIComponent(sale.Pay_Token) : '');
      return Object.assign({}, d, { customerName: c ? c.Name : (rq ? rq.Customer_Name || '' : ''), productName: p ? p.Product_Name : d.Product_ID,
        kind: d.Kind, orderUrl: url });
    }).sort(function (a, b) {
      return Number(String(b.Delivery_ID).replace(/\D/g, '')) - Number(String(a.Delivery_ID).replace(/\D/g, ''));
    });
  }

  /** A review link is kept only when it is a plain https:// URL (no spaces, quotes or angle brackets). */
  function safeLink(v) {
    var s = String(v || '').trim();
    return /^https:\/\/[^\s"'<>`\\]+$/i.test(s) ? s : '';
  }

  /**
   * What the pay page shows for a request. `code` is present only when the request is Paid and its delivery row exists with a code.
   * tos and links come from settings; links that do not start with https:// are dropped.
   */
  function receipt(state, rq) {
    var s = state.settings || {};
    var lines = [{ label: 'Order', value: rq.Request_ID }, { label: 'Item', value: String(rq.Title || '') },
      { label: 'Amount', value: '৳' + (Number(rq.Amount) || 0) }, { label: 'Status', value: rq.Status }];
    var out = { lines: lines, tos: String(s.tos_text || ''), links: [] };
    [['Discord', s.review_discord_url], ['Facebook', s.review_facebook_url]].forEach(function (l) {
      var url = safeLink(l[1]);
      if (url) out.links.push({ label: l[0], url: url });
    });
    if (rq.Status === 'Paid') {
      var d = (state.deliveries || []).filter(function (x) { return x.Request_ID === rq.Request_ID && x.Code_ID; })[0];
      // The delivery's sale must still be live and still hold that code: a voided or refunded sale whose code was resold shows nothing.
      var sale = d && !blank(d.Sale_ID) ? find(state.sales, 'Sale_ID', Number(d.Sale_ID)) : null;
      // The code shows only once the delivery is Delivered (not Pending, Ready or Failed).
      var live = sale && d.Status === 'Delivered' && sale.Record_Status !== 'Void' && sale.Record_Status !== 'Refunded' && sale.Code_ID === d.Code_ID;
      var code = live ? find(state.codes, 'Code_ID', d.Code_ID) : null;
      if (code && code.Code) out.code = String(code.Code);
    }
    return out;
  }

  // ---- delivery message templates ----
  var TEMPLATE_FIELDS = ['name', 'product', 'profile', 'paidTill', 'login'];
  var TEMPLATE_MAX = 2000;
  /** checkTemplate(body) -> error text or ''. Only the known placeholders are allowed. */
  function checkTemplate(body) {
    var b = String(body === undefined || body === null ? '' : body);
    if (!b.trim()) return 'Write the message.';
    if (b.length > TEMPLATE_MAX) return 'The message can be up to ' + TEMPLATE_MAX + ' characters.';
    var bad = null;
    b.replace(/\{\{\s*([A-Za-z_]*)\s*\}\}/g, function (m, k) { if (TEMPLATE_FIELDS.indexOf(k) < 0 && !bad) bad = m; return m; });
    if (bad) return 'Unknown placeholder ' + bad + '. Use ' + TEMPLATE_FIELDS.map(function (f) { return '{{' + f + '}}'; }).join(', ') + '.';
    return '';
  }
  /** fillTemplate(body, values) -> text with each {{field}} replaced (a missing value becomes blank). Replaces once: a value is never re-scanned. */
  function fillTemplate(body, values) {
    return String(body).replace(/\{\{\s*([A-Za-z_]*)\s*\}\}/g, function (m, k) {
      return TEMPLATE_FIELDS.indexOf(k) >= 0 && values && values[k] !== undefined && values[k] !== null ? String(values[k]) : '';
    });
  }
  function usesLogin(body) { return /\{\{\s*login\s*\}\}/.test(String(body)); }
  /** pickTemplate(templates, productId, accountId) -> templates that apply to the sale, account ones first. */
  function templatesFor(templates, productId, accountId) {
    return (templates || []).filter(function (t) {
      return (!t.productId || t.productId === productId) && (!t.accountId || t.accountId === accountId);
    }).sort(function (a, b) { return (b.accountId ? 2 : 0) + (b.productId ? 1 : 0) - ((a.accountId ? 2 : 0) + (a.productId ? 1 : 0)); });
  }
  return { checkTemplate: checkTemplate, fillTemplate: fillTemplate, usesLogin: usesLogin, templatesFor: templatesFor, TEMPLATE_FIELDS: TEMPLATE_FIELDS, paidFor: paidFor, linkedByNote: linkedByNote, claimsRequestNote: claimsRequestNote, STATUSES: STATUSES, confirmable: confirmable, planConfirmRequest: planConfirmRequest, planSetDelivery: planSetDelivery, listDeliveries: listDeliveries, receipt: receipt };
})();
if (typeof module !== 'undefined') module.exports = Core.delivery;

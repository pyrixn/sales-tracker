/**
 * Core.matching: turns one Payment_Inbox row into payments (and a renewal when the money covers it).
 * Automatic only for real bKash (16247) "Received" texts whose reference names a live subscription line.
 */
var Core = Core || {};
Core.matching = (function () {
  var r2 = function (n) { return Core.util.round2(n); };
  var MAX_EXPIRED_DAYS = 30;

  function pending(note) { return { status: 'pending', ops: [], result: { note: note }, errors: [] }; }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  /** bKash's own short code, or the name "bKash" that iPhone Shortcuts can report instead of the number. */
  function isBkashSender(v) { return digits(v) === '16247' || /^bkash$/i.test(String(v || '').trim()); }
  /** Upay short code 16268 or name "Upay". */
  function isUpaySender(v) { return digits(v) === '16268' || /^upay$/i.test(String(v || '').trim()); }
  /** Nagad short code 16167 or name "Nagad". */
  function isNagadSender(v) { return digits(v) === '16167' || /^nagad$/i.test(String(v || '').trim()); }
  function senderMethod(v) {
    if (isBkashSender(v)) return 'bKash';
    if (isUpaySender(v)) return 'Upay';
    if (isNagadSender(v)) return 'Nagad';
    return 'bKash';
  }
  function isAutoSender(v) { return isBkashSender(v) || isUpaySender(v) || isNagadSender(v); }
  function find(rows, f, v) { for (var i = 0; i < (rows || []).length; i++) if (rows[i][f] === v) return rows[i]; return null; }

  function liveLine(state, code) {
    if (!code) return { why: 'No reference code in the message.' };
    var line = Core.refs.subCodeLine(state, code);
    var latest = line.latest;
    if (!latest) return { why: 'Reference ' + code + ' does not match an active subscription.' };
    var acc = find(state.accounts, 'Account_ID', latest.Account_ID);
    if (acc && (acc.Account_Status === 'Banned' || acc.Account_Status === 'Closed' || acc.Account_Status === 'Deleted')) return { why: latest.Account_ID + ' is ' + acc.Account_Status + '.' };
    if (latest.Paid_Till && Core.util.daysBetween(latest.Paid_Till, state.today) > MAX_EXPIRED_DAYS) {
      return { why: 'Reference ' + code + ' expired more than ' + MAX_EXPIRED_DAYS + ' days ago.' };
    }
    return { latest: latest };
  }

  /** Owner moving money into his own wallet (bKash). Not a customer payment, so never matched. */
  var TOPUP_NOTE = 'Wallet top-up';
  function isTopUpSms(text) {
    var t = String(text || '');
    // Only the iBanking deposit. A bKash 'Cash In ... successful' can be a customer paying in cash, so it stays a payment.
    return /received deposit from iBanking/i.test(t);
  }
  /** The type a row is read as. A row stored as Received whose SMS is a wallet top-up reads as TopUp (derived on read, not written). */
  function rowType(row) {
    if (row.Type === 'TopUp') return 'TopUp';
    if (row.Type === 'Received' && isTopUpSms(row.Raw_SMS)) return 'TopUp';
    return row.Type;
  }

  function receivedDate(row, today) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(row.Received || ''));
    return m ? m[1] : today;
  }

  var KNOWN_METHODS = ['bKash', 'Nagad', 'Upay', 'Rocket', 'Cash', 'Bank', 'Card', 'Other'];
  function manualFail(msg) { return { status: 'pending', ops: [], result: null, errors: [msg] }; }
  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); }

  /** Validate the owner's overrides. Returns {error} or the cleaned {amount?, date?, method?, note?}. */
  function cleanOverrides(manual) {
    var o = {};
    if (manual.amount !== undefined) {
      var a = manual.amount;
      if (typeof a !== 'number' || !isFinite(a) || a <= 0) return { error: 'Amount must be more than 0.' };
      if (a >= 1000000) return { error: 'Amount must be less than 1,000,000.' };
      o.amount = r2(a);
    }
    if (manual.date !== undefined) {
      if (!isIso(manual.date)) return { error: 'Date must be like 2026-10-18.' };
      o.date = manual.date;
    }
    if (manual.method !== undefined) {
      var m = String(manual.method || '').trim().toLowerCase();
      var known = KNOWN_METHODS.filter(function (k) { return k.toLowerCase() === m; })[0];
      if (!known) return { error: 'Method must be one of: ' + KNOWN_METHODS.join(', ') + '.' };
      o.method = known;
    }
    if (manual.note !== undefined) o.note = String(manual.note || '').trim();
    return o;
  }

  /** 'R12' when the Reference column, or "Ref: ..." in the SMS text, is a pay request id; else null. */
  function requestRef(state, row) {
    // A pay request's random Ref, as a whole token in the Reference column or the "Ref: ..." part of the SMS, comes first.
    var withRef = (state.payRequests || []).filter(function (rq) { return rq.Ref; });
    var smsPart = /Ref(?:erence)?\.?\s*:?\s*([^\n]*)/i.exec(String((row && row.Raw_SMS) || ''));
    for (var k = 0; k < withRef.length; k++) {
      if (Core.refs.hasToken(row && row.Reference, withRef[k].Ref) || (smsPart && Core.refs.hasToken(smsPart[1], withRef[k].Ref))) return withRef[k].Request_ID;
    }
    var col = String((row && row.Reference) || '').replace(/[\s-]/g, '');
    var m = /^R(\d{1,6})$/i.exec(col);
    if (!m && !col) m = /Ref(?:erence)?\.?\s*:?\s*R\s*-?\s*(\d{1,6})(?![\dA-Za-z])/i.exec(String((row && row.Raw_SMS) || ''));
    return m ? 'R' + Number(m[1]) : null;
  }

  /** Auto path for a pay request: Open, amount covers it, then one confirm op set (Core.delivery). Anything else stays Pending. */
  function confirmRequest(state, row, rq, trx, amount) {
    if (rq.Status !== 'Open') return pending(rq.Request_ID + ' is ' + rq.Status + '. Match it by hand.');
    // planConfirmRequest refuses an underpayment (with what the owner can do), so the row stays Pending.
    var plan = Core.delivery.planConfirmRequest(state, { id: rq.Request_ID, trx: trx, method: senderMethod(row.Sender), amount: amount,
      source: 'Auto', date: receivedDate(row, state.today) });
    if (plan.errors.length) return pending(plan.errors[0]);
    if (plan.result.duplicate) return pending('Already recorded.');
    var cust = find(state.customers, 'Customer_ID', plan.result.customerId);
    var note = (cust ? cust.Name : (rq.Customer_Name || rq.Request_ID)) + ': ৳' + amount + ', ' + rq.Request_ID + ' paid' +
      (plan.result.delivered ? ', code delivered' : plan.result.deliveryId ? ', delivery pending' : '') +
      (plan.result.note ? ' · ' + plan.result.note : '');
    return { status: 'auto', ops: plan.ops, errors: [], result: { saleId: plan.result.saleId, customerId: plan.result.customerId,
      requestId: rq.Request_ID, deliveryId: plan.result.deliveryId, note: note } };
  }

  /**
   * manual: {customerId, subCode?} chosen by the owner (skips the sender and reference checks).
   * It may also carry overrides for the recorded payment only: {amount?, date?, method?, note?}
   * and {newCustomer: {name, channel?, handle?}} instead of customerId. The inbox row keeps its SMS values.
   */
  function planInboxMatch(state, row, manual) {
    var trx = String(row.Transaction_ID || '').trim().toUpperCase();
    if (!trx) {
      return manual ? { status: 'pending', ops: [], result: null, errors: ['This message has no transaction ID, so it cannot be matched.'] }
                    : pending('No transaction ID.');
    }
    var taken = (state.payments || []).some(function (p) { return String(p.Transaction_ID || '').trim().toUpperCase() === trx; });
    if (taken) {
      return { status: 'duplicate', errors: [], result: { note: 'Already recorded.' },
               ops: [{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched' } }] };
    }
    if (rowType(row) === 'TopUp') {
      return manual ? manualFail('This is a wallet top-up, not a customer payment. Mark it as a top-up instead.')
                    : pending(TOPUP_NOTE + '. Not a customer payment.');
    }
    var ov = {};
    if (manual) { ov = cleanOverrides(manual); if (ov.error) return manualFail(ov.error); }
    var role = manual && manual._role;
    if (role !== undefined && role !== 'owner' && ov.amount !== undefined && ov.amount !== r2(Number(row.Amount))) {
      return manualFail('Only the owner can override the amount.');
    }
    var amount = ov.amount !== undefined ? ov.amount : Number(row.Amount);
    if (!(amount > 0)) return manual ? { status: 'pending', ops: [], result: null, errors: ['This message has no amount.'] } : pending('No amount.');

    var customerId, latest = null, gen = null, newCustOp = null, newCustName = '';
    if (manual) {
      // Money for a pay link that Got paid can confirm now is confirmed from Pay links, never booked as dues or credit by hand.
      // An expired link, or one whose code is no longer held, cannot be confirmed, so it is hand-matched as before.
      var openId = requestRef(state, row), open = openId ? find(state.payRequests, 'Request_ID', openId) : null;
      if (open && Core.delivery.confirmable(state, open)) {
        var short = amount < Number(open.Amount);
        return { status: 'pending', ops: [], result: null,
                 errors: [open.Request_ID + ' is an open pay link. Confirm it from Pay links with Got paid, using this transaction id.' +
                   (short ? ' This is less than the ৳' + Number(open.Amount) + ' asked, so Got paid will refuse it: cancel ' + open.Request_ID + ' first, then match this payment by hand.' : '')] };
      }
      if (!manual.customerId && manual.newCustomer) {
        var nm = String(manual.newCustomer.name || '').trim().replace(/\s+/g, ' ');
        if (!nm) return manualFail('Type a name for the new customer.');
        var clash = (state.customers || []).filter(function (c) { return String(c.Name).trim().toLowerCase() === nm.toLowerCase(); })[0];
        if (clash) return manualFail('A customer named "' + clash.Name + '" already exists. Pick them from the list.');
        gen = Core.ids.IdGen(state);
        customerId = gen.customer();
        newCustName = nm;
        newCustOp = { op: 'append', tab: 'Customers', values: { Customer_ID: customerId, Name: nm, Channel: manual.newCustomer.channel || '',
          Handle: String(manual.newCustomer.handle || '').trim(), Discord_User_ID: '', Notes: '', Created: state.today } };
      } else if (!find(state.customers, 'Customer_ID', manual.customerId)) {
        return { status: 'pending', ops: [], result: null, errors: ['Unknown customer ' + manual.customerId + '.'] };
      } else {
        customerId = manual.customerId;
      }
      if (manual.subCode) {
        latest = Core.refs.subCodeLine(state, manual.subCode).latest;
        if (!latest || latest.Customer_ID !== customerId) {
          return { status: 'pending', ops: [], result: null, errors: [manual.subCode + ' is not an active subscription of this customer.'] };
        }
      }
    } else {
      if (!isAutoSender(row.Sender)) return pending('Not sent by bKash (16247), Upay (16268), or Nagad (16167). Match it by hand.');
      if (row.Type !== 'Received') return pending('Not a received payment.');
      // Upay: verified on TrxID, the sending phone number, the reference and the amount, so the number must be in the message.
      if (isUpaySender(row.Sender) && !/^(?:\+?88)?01\d{9}$/.test(String(row.Counterparty || '').trim())) {
        return pending('Upay message has no sender phone number. Match it by hand.');
      }
      // A pay request reference (R12) selects that request, never a subscription line. An R reference with no such request
      // falls through to the old rules (R is reserved, so no product line can claim it).
      var reqId = requestRef(state, row);
      var rq = reqId ? find(state.payRequests, 'Request_ID', reqId) : null;
      if (rq) return confirmRequest(state, row, rq, trx, amount);
      var live = liveLine(state, Core.refs.findKnownRef(row, state) || Core.refs.findRef(row, (state.products || []).map(function (p) { return p.Letter; })));
      if (!live.latest) return pending(live.why);
      latest = live.latest;
      customerId = latest.Customer_ID;
    }

    gen = gen || Core.ids.IdGen(state);
    var source = manual ? 'App' : 'Auto', date = ov.date || receivedDate(row, state.today);
    var method = ov.method || (manual ? (row.Method || 'bKash') : senderMethod(row.Sender));
    var pay = { customerId: customerId, method: method, trxId: trx, source: source, date: date };
    if (ov.note) pay.note = ov.note;
    var ops = newCustOp ? [newCustOp] : [], lastSale = '';

    var dues = Core.ledger.openDues(state, customerId);
    var alloc = Core.ledger.allocate(amount, dues);
    if (alloc.applied.length) {
      var applied = alloc.applied.reduce(function (a, x) { return a + x.amount; }, 0);
      ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ amount: r2(applied) }, pay), dues).ops);
      lastSale = alloc.applied[alloc.applied.length - 1].saleId;
    }
    var rest = alloc.rest, renewedMonths = 0;

    if (latest && rest > 0) {
      var price = Core.ledger.salePrice(latest, state.products);
      if (price > 0 && rest >= price) {
        renewedMonths = Math.min(12, Math.floor(r2(rest / price) + 1e-9));
        var renew = Core.sales.planRenew(state, { subCode: latest.Sub_Code, months: renewedMonths, applyCredit: false,
          paidNow: { amount: r2(renewedMonths * price), method: method, trxId: trx }, source: source, _gen: gen });
        if (renew.errors.length) return manual ? { status: 'pending', ops: [], result: null, errors: renew.errors } : pending(renew.errors[0]);
        renew.ops.forEach(function (o) { if (o.tab === 'Payments') { o.values.Date = date; if (ov.note) o.values.Note = ov.note; } });
        ops = ops.concat(renew.ops);
        lastSale = renew.result.saleId;
        rest = r2(rest - renewedMonths * price);
      }
    }
    if (rest > 0) ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ amount: rest }, pay), []).ops);

    ops.push({ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched', Matched_Sale_ID: lastSale } });
    var cust = find(state.customers, 'Customer_ID', customerId);
    var note = (cust ? cust.Name : (newCustName || customerId)) + ': ৳' + amount +
      (alloc.applied.length ? ', dues paid' : '') +
      (renewedMonths ? ', renewed ' + latest.Sub_Code + ' for ' + renewedMonths + (renewedMonths === 1 ? ' month' : ' months') : '') +
      (rest > 0 ? ', ৳' + rest + ' kept as credit' : '');
    return { status: manual ? 'manual' : 'auto', ops: ops, errors: [], result: { saleId: lastSale, customerId: customerId, note: note } };
  }

  var SPLIT_KINDS = ['renew', 'custom', 'newSale'];
  var MAX_SPLIT_ITEMS = 6;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** Amount a split item takes from the payment, read before its planner runs: {amount} or {error}. */
  function splitItemAmount(state, t, n) {
    if (t.kind === 'renew') {
      var line = Core.refs.subCodeLine(state, t.subCode).latest;
      if (!line) return { error: 'Item ' + n + ': No active subscription has the code ' + t.subCode + '.' };
      if (isNum(t.total)) return { amount: r2(t.total) };
      var rp = (t.price === '' || t.price === undefined || t.price === null) ? Core.ledger.salePrice(line, state.products) : t.price;
      var rm = (t.months === '' || t.months === undefined || t.months === null) ? 1 : t.months;
      return { amount: r2(rm * rp) };
    }
    if (t.kind === 'custom') return { amount: r2(t.price) };
    var product = find(state.products, 'Product_ID', t.productId);
    if (!product) return { error: 'Item ' + n + ': Unknown product ' + t.productId + '.' };
    if (isNum(t.total)) return { amount: r2(t.total) };
    var months = Core.sales.deliversAs(product) === 'code' ? 1 : ((t.months === '' || t.months === undefined || t.months === null) ? 1 : t.months);
    var price = (t.price === '' || t.price === undefined || t.price === null) ? Number(product.Default_Price || 0) : t.price;
    return { amount: r2(price * months) };
  }

  /**
   * One payment split across up to 6 items (renewals, custom items, product sales) in one action.
   * split: {customerId? | newCustomer?, targets: [...], creditRest?, amount?, date?, method?, note?}.
   * Every item planner shares one id generator. Any error returns no ops; success returns one op list.
   */
  function planSplitMatch(state, row, split) {
    split = split || {};
    var trx = String(row.Transaction_ID || '').trim().toUpperCase();
    if (!trx) return manualFail('This message has no transaction ID, so it cannot be matched.');
    var taken = (state.payments || []).some(function (p) { return String(p.Transaction_ID || '').trim().toUpperCase() === trx; });
    if (taken) {
      return { status: 'duplicate', errors: [], result: { note: 'Already recorded.' },
               ops: [{ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched' } }] };
    }
    if (rowType(row) === 'TopUp') return manualFail('This is a wallet top-up, not a customer payment. Mark it as a top-up instead.');
    var ov = cleanOverrides(split);
    if (ov.error) return manualFail(ov.error);
    var amount = ov.amount !== undefined ? ov.amount : Number(row.Amount);
    var nonOwnerSplit = split._role !== undefined && split._role !== 'owner';
    if (nonOwnerSplit && ov.amount !== undefined && ov.amount !== r2(Number(row.Amount))) return manualFail('Only the owner can override the amount.');
    if (!(amount > 0)) return manualFail('This message has no amount.');

    var openId = requestRef(state, row), open = openId ? find(state.payRequests, 'Request_ID', openId) : null;
    if (open && Core.delivery.confirmable(state, open)) {
      var short = amount < Number(open.Amount);
      return manualFail(open.Request_ID + ' is an open pay link. Confirm it from Pay links with Got paid, using this transaction id.' +
        (short ? ' This is less than the ৳' + Number(open.Amount) + ' asked, so Got paid will refuse it: cancel ' + open.Request_ID + ' first, then match this payment by hand.' : ''));
    }

    var gen = Core.ids.IdGen(state), customerId = '', overlay = state, newCustOp = null, newCustName = '';
    if (!split.customerId && split.newCustomer) {
      var nm = String(split.newCustomer.name || '').trim().replace(/\s+/g, ' ');
      if (!nm) return manualFail('Type a name for the new customer.');
      var clash = (state.customers || []).filter(function (c) { return String(c.Name).trim().toLowerCase() === nm.toLowerCase(); })[0];
      if (clash) return manualFail('A customer named "' + clash.Name + '" already exists. Pick them from the list.');
      customerId = gen.customer();
      newCustName = nm;
      var newRow = { Customer_ID: customerId, Name: nm, Channel: split.newCustomer.channel || '',
        Handle: String(split.newCustomer.handle || '').trim(), Discord_User_ID: '', Notes: '', Created: state.today };
      newCustOp = { op: 'append', tab: 'Customers', values: newRow };
      overlay = Object.assign({}, state, { customers: (state.customers || []).concat([newRow]) });
    } else if (!split.customerId) {
      return manualFail('Pick a customer or type a new name.');
    } else if (!find(state.customers, 'Customer_ID', split.customerId)) {
      return manualFail('Unknown customer ' + split.customerId + '.');
    } else {
      customerId = split.customerId;
    }

    var targets = split.targets;
    if (!Array.isArray(targets) || targets.length === 0) return manualFail('Add at least one item to split.');
    if (targets.length > MAX_SPLIT_ITEMS) return manualFail('A split can have at most ' + MAX_SPLIT_ITEMS + ' items.');
    var i, t;
    for (i = 0; i < targets.length; i++) {
      if (!targets[i] || SPLIT_KINDS.indexOf(targets[i].kind) < 0) return manualFail('Item ' + (i + 1) + ': pick renew, custom or new sale.');
      if (nonOwnerSplit && targets[i].kind === 'custom') return manualFail('Item ' + (i + 1) + ': Only the owner can add a custom sale.');
    }
    var subSeen = {}, codeSeen = {};
    for (i = 0; i < targets.length; i++) {
      t = targets[i];
      if (t.kind === 'renew') {
        var sc = String(t.subCode || '').trim().toUpperCase();
        if (subSeen[sc]) return manualFail(sc + ' appears twice. Use months instead.');
        subSeen[sc] = true;
      }
      if (t.kind === 'newSale') {
        if (t.codeId) {
          var cc = String(t.codeId).trim().toUpperCase();
          if (codeSeen[cc]) return manualFail(cc + ' appears twice.');
          codeSeen[cc] = true;
        }
      }
    }

    var amounts = [];
    for (i = 0; i < targets.length; i++) {
      var got = splitItemAmount(state, targets[i], i + 1);
      if (got.error) return manualFail(got.error);
      amounts.push(got.amount);
    }

    var date = ov.date || receivedDate(row, state.today);
    var method = ov.method || (row.Method || 'bKash');
    var built = [];
    for (i = 0; i < targets.length; i++) {
      t = targets[i];
      var paid = { amount: amounts[i], method: method, trxId: trx };
      var res = null;
      if (t.kind === 'renew') {
        res = Core.sales.planRenew(overlay, { subCode: t.subCode, months: t.months, price: t.price, total: t.total, from: t.from || 'oldPaidTill',
          paidTill: t.paidTill, applyCredit: false, paidNow: paid, source: 'App', _gen: gen, _role: split._role });
        if (!res.errors.length && res.result.customerId !== customerId) {
          return manualFail(t.subCode + ' is not an active subscription of this customer.');
        }
      } else if (t.kind === 'custom') {
        res = Core.sales.planCustomSale(overlay, { customerId: customerId, title: t.title, price: t.price, cost: t.cost,
          date: t.date || date, paidNow: paid, source: 'App', _gen: gen });
      } else {
        res = Core.sales.planNewSale(overlay, { productId: t.productId, customerId: customerId, accountId: t.accountId, codeId: t.codeId,
          months: t.months, price: t.price, total: t.total, profile: t.profile, paidNow: paid, source: 'App', _gen: gen, _role: split._role, cost: t.cost, allowFull: t.allowFull });
      }
      if (res.errors.length) return manualFail('Item ' + (i + 1) + ': ' + res.errors[0]);
      built.push({ target: t, res: res });
    }

    // Seats: each new product sale names its account (chosen, or random among the free ones). Two items on one
    // account must fit its free slots; the planners only see the state before the split, so count here.
    var seatCount = {};
    built.forEach(function (b) {
      if (b.target.kind === 'newSale' && b.res.result && b.res.result.accountId) {
        seatCount[b.res.result.accountId] = (seatCount[b.res.result.accountId] || 0) + 1;
      }
    });
    for (var seatAcc in seatCount) {
      if (!seatCount.hasOwnProperty(seatAcc)) continue;
      var seatAccount = find(state.accounts, 'Account_ID', seatAcc);
      if (!seatAccount || Core.sales.freeSlots(state, seatAccount) < seatCount[seatAcc]) return manualFail(seatAcc + ' has no free slot for both items.');
    }

    var total = 0;
    amounts.forEach(function (a) { total = r2(total + a); });
    if (total > amount) return manualFail('The items add up to ৳' + total + ', more than the payment ৳' + amount + '.');
    var rest = r2(amount - total);
    if (rest > 0 && !split.creditRest) return manualFail('৳' + rest + ' of the payment is not assigned. Add it to an item or keep it as credit.');

    var ops = newCustOp ? [newCustOp] : [], saleIds = [], renewed = [], parts = [];
    built.forEach(function (b) {
      b.res.ops.forEach(function (o) {
        if (o.tab === 'Payments') { o.values.Date = date; if (ov.note) o.values.Note = ov.note; }
      });
      ops = ops.concat(b.res.ops);
      saleIds.push(b.res.result.saleId);
      var tt = b.target;
      if (tt.kind === 'renew') {
        var months = (tt.months === '' || tt.months === undefined || tt.months === null) ? 1 : tt.months;
        renewed.push(b.res.result.subCode);
        parts.push('renewed ' + b.res.result.subCode + ' for ' + months + (months === 1 ? ' month' : ' months'));
      } else if (tt.kind === 'custom') {
        parts.push('custom "' + String(tt.title || '').trim().replace(/\s+/g, ' ') + '"');
      } else {
        parts.push('sold ' + tt.productId);
      }
    });
    if (rest > 0) {
      ops = ops.concat(Core.sales.paymentOps(state, gen, { customerId: customerId, amount: rest, method: method, trxId: trx,
        source: 'App', date: date, note: ov.note }, []).ops);
      parts.push('৳' + rest + ' kept as credit');
    }
    ops.push({ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched', Matched_Sale_ID: saleIds[0] } });
    var cust = find(state.customers, 'Customer_ID', customerId);
    var note = (cust ? cust.Name : newCustName) + ': ৳' + amount + ' split: ' + parts.join(', ');
    return { status: 'manual', ops: ops, errors: [], result: { customerId: customerId, saleIds: saleIds, renewedSubCodes: renewed,
      credit: rest > 0 ? rest : 0, note: note } };
  }

  /** Largest amount (BDT) matched automatically: settings.auto_match_max_bdt, 5000 when blank, invalid or not above 0. */
  function autoCap(state) {
    var cap = Number((state.settings || {}).auto_match_max_bdt);
    return cap > 0 ? cap : 5000;
  }

  /** The note for a row above the auto-match limit, or ''. */
  function capNote(state, row) {
    var cap = autoCap(state);
    return Number(row && row.Amount) > cap ? 'Amount is above the auto-match limit (৳' + cap + '). Match it by hand.' : '';
  }

  /** Why this row would not match by itself; '' only when the automatic rules accept it and it is within the limit. */
  function whyNotAuto(state, row) {
    var x = planInboxMatch(state, row);
    if (x.status === 'duplicate') return 'Already recorded.';
    if (x.status === 'auto') return capNote(state, row);
    return (x.result && x.result.note) || (x.errors && x.errors[0]) || 'Left for manual matching.';
  }

  function last10(v) { var d = digits(v); return d.length >= 10 ? d.slice(-10) : ''; }

  /** Up to 6 customers worth offering for this message, best first. query narrows by name. */
  function suggest(state, row, query) {
    var out = [], seen = {}, customers = state.customers || [];
    function add(c, why) {
      if (!c || seen[c.Customer_ID] || out.length >= 6) return;
      seen[c.Customer_ID] = 1; out.push({ customerId: c.Customer_ID, name: c.Name, why: why });
    }
    var cp = last10(row && row.Counterparty);
    if (cp) customers.forEach(function (c) { if (last10(c.Handle) === cp) add(c, 'Same number as the sender'); });
    var code = Core.refs.findKnownRef(row || {}, state) || Core.refs.findRef(row || {}, (state.products || []).map(function (p) { return p.Letter; }));
    if (code) {
      var latest = liveLine(state, code).latest;
      if (latest) add(find(customers, 'Customer_ID', latest.Customer_ID), 'Owns ' + code);
    }
    var q = String(query || '').trim().toLowerCase();
    if (q) customers.forEach(function (c) { if (String(c.Name || '').toLowerCase().indexOf(q) >= 0) add(c, 'Name matches'); });
    var lastPaid = {};
    (state.payments || []).forEach(function (p) {
      var d = String(p.Date || '');
      if (p.Customer_ID && d >= (lastPaid[p.Customer_ID] || '')) lastPaid[p.Customer_ID] = d;
    });
    customers.slice().sort(function (a, b) {
      var x = lastPaid[a.Customer_ID] || '', y = lastPaid[b.Customer_ID] || '';
      return x < y ? 1 : x > y ? -1 : 0;
    }).forEach(function (c) { if (/^Unlogged payment/.test(String(c.Name || ''))) return; add(c, lastPaid[c.Customer_ID] ? 'Paid recently' : 'Customer'); });
    return out;
  }

  return { planInboxMatch: planInboxMatch, planSplitMatch: planSplitMatch, isTopUpSms: isTopUpSms, rowType: rowType, TOPUP_NOTE: TOPUP_NOTE, whyNotAuto: whyNotAuto, autoCap: autoCap, capNote: capNote, suggest: suggest, KNOWN_METHODS: KNOWN_METHODS, MAX_EXPIRED_DAYS: MAX_EXPIRED_DAYS };
})();
if (typeof module !== 'undefined') module.exports = Core.matching;

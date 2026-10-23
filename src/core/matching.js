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
    if (acc && (acc.Account_Status === 'Banned' || acc.Account_Status === 'Closed')) return { why: latest.Account_ID + ' is ' + acc.Account_Status + '.' };
    if (latest.Paid_Till && Core.util.daysBetween(latest.Paid_Till, state.today) > MAX_EXPIRED_DAYS) {
      return { why: 'Reference ' + code + ' expired more than ' + MAX_EXPIRED_DAYS + ' days ago.' };
    }
    return { latest: latest };
  }

  function receivedDate(row, today) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(row.Received || ''));
    return m ? m[1] : today;
  }

  /** manual: {customerId, subCode?} chosen by the owner (skips the sender and reference checks). */
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
    var amount = Number(row.Amount);
    if (!(amount > 0)) return manual ? { status: 'pending', ops: [], result: null, errors: ['This message has no amount.'] } : pending('No amount.');

    var customerId, latest = null;
    if (manual) {
      if (!find(state.customers, 'Customer_ID', manual.customerId)) {
        return { status: 'pending', ops: [], result: null, errors: ['Unknown customer ' + manual.customerId + '.'] };
      }
      customerId = manual.customerId;
      if (manual.subCode) {
        latest = Core.refs.subCodeLine(state, manual.subCode).latest;
        if (!latest || latest.Customer_ID !== customerId) {
          return { status: 'pending', ops: [], result: null, errors: [manual.subCode + ' is not an active subscription of this customer.'] };
        }
      }
    } else {
      if (!isAutoSender(row.Sender)) return pending('Not sent by bKash (16247), Upay (16268), or Nagad (16167). Match it by hand.');
      if (row.Type !== 'Received') return pending('Not a received payment.');
      var live = liveLine(state, Core.refs.findRef(row));
      if (!live.latest) return pending(live.why);
      latest = live.latest;
      customerId = latest.Customer_ID;
    }

    var gen = Core.ids.IdGen(state), source = manual ? 'App' : 'Auto', date = receivedDate(row, state.today);
    var method = manual ? (row.Method || 'bKash') : senderMethod(row.Sender);
    var pay = { customerId: customerId, method: method, trxId: trx, source: source, date: date };
    var ops = [], lastSale = '';

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
        renew.ops.forEach(function (o) { if (o.tab === 'Payments') o.values.Date = date; });
        ops = ops.concat(renew.ops);
        lastSale = renew.result.saleId;
        rest = r2(rest - renewedMonths * price);
      }
    }
    if (rest > 0) ops = ops.concat(Core.sales.paymentOps(state, gen, Object.assign({ amount: rest }, pay), []).ops);

    ops.push({ op: 'update', tab: 'Payment_Inbox', key: 'Transaction_ID', id: trx, values: { Status: 'Matched', Matched_Sale_ID: lastSale } });
    var cust = find(state.customers, 'Customer_ID', customerId);
    var note = (cust ? cust.Name : customerId) + ': ৳' + amount +
      (alloc.applied.length ? ', dues paid' : '') +
      (renewedMonths ? ', renewed ' + latest.Sub_Code + ' for ' + renewedMonths + (renewedMonths === 1 ? ' month' : ' months') : '') +
      (rest > 0 ? ', ৳' + rest + ' kept as credit' : '');
    return { status: manual ? 'manual' : 'auto', ops: ops, errors: [], result: { saleId: lastSale, customerId: customerId, note: note } };
  }

  return { planInboxMatch: planInboxMatch, MAX_EXPIRED_DAYS: MAX_EXPIRED_DAYS };
})();
if (typeof module !== 'undefined') module.exports = Core.matching;

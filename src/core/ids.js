/** Core.ids: allocates new IDs as (max existing + 1). Call inside the script lock; every call increments. */
var Core = Core || {};
Core.ids = (function () {
  function maxNum(rows, field, prefix) {
    var max = 0;
    (rows || []).forEach(function (r) {
      var v = r[field];
      if (v === '' || v === null || v === undefined) return;
      var n = prefix ? Number(String(v).replace(/^[^\d]*/, '')) : Number(v);
      if (prefix && String(v).indexOf(prefix) !== 0) return;
      if (isFinite(n) && n > max) max = n;
    });
    return max;
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function IdGen(state) {
    var c = {
      sale: maxNum(state.sales, 'Sale_ID'),
      customer: maxNum(state.customers, 'Customer_ID', 'CU-'),
      payment: maxNum(state.payments, 'Payment_ID', 'PM-'),
      expense: maxNum(state.expenses, 'Expense_ID', 'EX-'),
      purchase: maxNum(state.purchases, 'Purchase_ID', 'P-'),
      code: maxNum(state.codes, 'Code_ID', 'C-'),
      order: maxNum(state.orders, 'Order_ID', 'O-'),
      request: maxNum(state.payRequests, 'Request_ID', 'R'),
      delivery: maxNum(state.deliveries, 'Delivery_ID', 'D'),
      goal: maxNum(state.goals, 'Goal_ID', 'G'),
      budget: maxNum(state.budgets, 'Budget_ID', 'B'),
      sub: 0
    };
    var taken = null;
    (state.sales || []).forEach(function (s) {
      var m = /^[A-Z]{1,3}(\d+)$/.exec(String(s.Sub_Code || ''));
      if (m && Number(m[1]) > c.sub) c.sub = Number(m[1]);
    });
    return {
      sale: function () { return ++c.sale; },
      customer: function () { return 'CU-' + pad(++c.customer, 4); },
      payment: function () { return 'PM-' + pad(++c.payment, 5); },
      expense: function () { return 'EX-' + pad(++c.expense, 4); },
      purchase: function () { return 'P-' + pad(++c.purchase, 4); },
      code: function () { return 'C-' + pad(++c.code, 4); },
      order: function () { return 'O-' + pad(++c.order, 5); },
      request: function () { return 'R' + (++c.request); },
      delivery: function () { return 'D' + (++c.delivery); },
      goal: function () { return 'G' + (++c.goal); },
      budget: function () { return 'B' + (++c.budget); },
      subCode: function (letter) { return String(letter).toUpperCase() + (++c.sub); },
      // Random customer reference (lowercase, unique against sales and pay requests in this state and this batch).
      ref: function (rand) {
        if (!taken) taken = Core.refs.usedRefs(state);
        var r = Core.refs.newRef(taken, rand);
        taken[r.toUpperCase()] = true;
        return r;
      },
      // Unguessable id for the public /pay/<token> link (128 bits, url-safe base64, no padding).
      payToken: function () { return token(16); },
      // Request links use 192 bits (32 chars) from the same generator, so tokens never collide with sale tokens in practice.
      requestToken: function () { return token(24); }
    };
    function token(n) {
      var b = new Uint8Array(n); crypto.getRandomValues(b);
      var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');
    }
  }
  return { IdGen: IdGen };
})();
if (typeof module !== 'undefined') module.exports = Core.ids;

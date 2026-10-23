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
      sub: 0
    };
    (state.sales || []).forEach(function (s) {
      var m = /^[A-Z](\d+)$/.exec(String(s.Sub_Code || ''));
      if (m && Number(m[1]) > c.sub) c.sub = Number(m[1]);
    });
    return {
      sale: function () { return ++c.sale; },
      customer: function () { return 'CU-' + pad(++c.customer, 4); },
      payment: function () { return 'PM-' + pad(++c.payment, 5); },
      expense: function () { return 'EX-' + pad(++c.expense, 4); },
      purchase: function () { return 'P-' + pad(++c.purchase, 4); },
      code: function () { return 'C-' + pad(++c.code, 4); },
      subCode: function (letter) { return String(letter).toUpperCase() + (++c.sub); },
      // Unguessable id for the public /pay/<token> link (128 bits, url-safe base64, no padding).
      payToken: function () {
        var b = new Uint8Array(16); crypto.getRandomValues(b);
        var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');
      }
    };
  }
  return { IdGen: IdGen };
})();
if (typeof module !== 'undefined') module.exports = Core.ids;

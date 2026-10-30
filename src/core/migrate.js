/** Core.migrate: one-time move of the old Sales_Log into Customers + Payments + Sub_Codes. Pure: returns rows, writes nothing. */
var Core = Core || {};
Core.migrate = (function () {
  var PLACEHOLDER = /^(unlogged payment|bkash( reci?eve| receive| received)?)$/i;

  function norm(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  function levenshtein(a, b) {
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function planMigration(state) {
    var gen = Core.ids.IdGen(state);
    var byKey = {}, customers = [], saleUpdates = [], payments = [];
    var letters = {};
    (state.products || []).forEach(function (p) { letters[p.Product_ID] = p.Letter || 'X'; });

    var sales = (state.sales || []).slice().sort(function (a, b) { return a.Sale_ID - b.Sale_ID; });
    var seq = 0;
    sales.forEach(function (s) {
      var isPlaceholder = PLACEHOLDER.test(String(s.Customer || '').trim());
      var key = isPlaceholder ? 'placeholder:' + s.Product_ID : norm(s.Customer);
      if (!byKey[key]) {
        var name = isPlaceholder ? 'Unlogged payment (' + s.Product_ID + ')' : String(s.Customer).trim().replace(/\s+/g, ' ');
        byKey[key] = { Customer_ID: gen.customer(), Name: name, Channel: '', Handle: '', Discord_User_ID: '',
                       Notes: isPlaceholder ? 'Placeholder for payments with no customer name in the old sheet' : '',
                       Created: state.today };
        customers.push(byKey[key]);
      }
      var cid = byKey[key].Customer_ID;
      saleUpdates.push({ Sale_ID: s.Sale_ID, Customer_ID: cid, Months: 1, Sub_Code: letters[s.Product_ID] + (++seq) });
      if (Number(s.Amount_Paid) > 0) {
        payments.push({ Payment_ID: gen.payment(), Date: '', Customer_ID: cid, Sale_ID: s.Sale_ID,
                        Amount: Number(s.Amount_Paid), Method: '', Transaction_ID: '', Source: 'Migrated', Note: '' });
      }
    });

    var names = customers.filter(function (c) { return c.Name.indexOf('Unlogged payment (') !== 0; })
                         .map(function (c) { return c.Name; });
    var nearDupes = [];
    for (var i = 0; i < names.length; i++) {
      for (var j = i + 1; j < names.length; j++) {
        var a = norm(names[i]), b = norm(names[j]);
        if (a.length < 3 || b.length < 3) continue;
        var contains = a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
        var close = a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 2;
        if (contains || close) nearDupes.push([names[i], names[j]]);
      }
    }
    return { customers: customers, saleUpdates: saleUpdates, payments: payments, nearDupes: nearDupes };
  }

  return { planMigration: planMigration, levenshtein: levenshtein, PLACEHOLDER: PLACEHOLDER };
})();
if (typeof module !== 'undefined') module.exports = Core.migrate;

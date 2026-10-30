/** Core.ledger: what each sale earns, what has been paid against it, and who owes what. */
var Core = Core || {};
Core.ledger = (function () {
  var r2 = function (n) { return Core.util.round2(n); };
  function num(v, dflt) { return v === '' || v === null || v === undefined ? dflt : Number(v); }

  /** Built-in id for custom sales (free-text items). It is never stored as a product row. */
  var CUSTOM_ID = 'CUSTOM';
  var CUSTOM_PRODUCT = { Product_ID: 'CUSTOM', Product_Name: 'Custom sales', Category: 'Custom', Platform: '', Delivers_As: 'custom',
    Letter: '', Default_Price: 0, Billing_Cycle_Days: 30, Active: 'No' };
  function isCustom(sale) { return !!sale && sale.Product_ID === CUSTOM_ID; }

  function productOf(products, id) {
    if (id === CUSTOM_ID) return CUSTOM_PRODUCT;
    for (var i = 0; i < (products || []).length; i++) if (products[i].Product_ID === id) return products[i];
    return null;
  }

  /** Per-month price: the typed Unit_Price (0 included), else the catalog default. Same rule as Sales_Log!P. */
  function salePrice(sale, products) {
    if (sale.Unit_Price !== '' && sale.Unit_Price !== null && sale.Unit_Price !== undefined) return Number(sale.Unit_Price);
    var p = productOf(products, sale.Product_ID);
    return p ? num(p.Default_Price, 0) : 0;
  }

  /** Void (entered by mistake) and Refunded (money returned) lines are out of every total. The one place that rule lives. */
  function isVoided(sale) { return sale.Record_Status === 'Void' || sale.Record_Status === 'Refunded'; }

  /** Billed amount: full price x qty x months. Profit and every revenue figure use this; an Ended line still bills in full. */
  function saleRevenue(sale, products) {
    if (isVoided(sale)) return 0;
    return r2(salePrice(sale, products) * num(sale.Qty, 1) * num(sale.Months, 1));
  }

  function paidMap(state) {
    var m = {};
    (state.payments || []).forEach(function (p) {
      if (p.Sale_ID === '' || p.Sale_ID === null || p.Sale_ID === undefined) return;
      m[p.Sale_ID] = r2((m[p.Sale_ID] || 0) + Number(p.Amount || 0));
    });
    return m;
  }

  function salePaid(sale, state) { return paidMap(state)[sale.Sale_ID] || 0; }

  /** What counts as owed on a line. Same as saleRevenue, except an Ended line is only ever owed what was paid on it:
   *  nobody is chased for it and the part payment is not turned into credit. Void and Refunded owe 0. `paid` is an optional paidMap(state). */
  function owedBillFor(sale, state, paid) {
    var rev = saleRevenue(sale, state.products);
    if (sale.Record_Status !== 'Ended') return rev;
    return Math.min(rev, (paid || paidMap(state))[sale.Sale_ID] || 0);
  }

  /** Billed but not yet received on a line, for any non-void status (Ended included). Feeds the "collected" profit figure. */
  function uncollectedFor(sale, state, paid) {
    return Math.max(0, r2(saleRevenue(sale, state.products) - ((paid || paidMap(state))[sale.Sale_ID] || 0)));
  }

  /** Owed on one line (owedBillFor minus paid). Negative only when the line is overpaid. */
  function saleBalance(sale, state, paid) {
    paid = paid || paidMap(state);
    return r2(owedBillFor(sale, state, paid) - (paid[sale.Sale_ID] || 0));
  }

  /** Positive: the customer owes. Negative: the customer has credit. */
  function customerBalance(state, customerId) {
    var billed = 0, paid = 0, pm = paidMap(state);
    (state.sales || []).forEach(function (s) { if (s.Customer_ID === customerId) billed += owedBillFor(s, state, pm); });
    (state.payments || []).forEach(function (p) { if (p.Customer_ID === customerId) paid += Number(p.Amount || 0); });
    return r2(billed - paid);
  }

  function creditOf(state, customerId) {
    var c = 0;
    (state.payments || []).forEach(function (p) {
      if (p.Customer_ID === customerId && (p.Sale_ID === '' || p.Sale_ID === null || p.Sale_ID === undefined)) c += Number(p.Amount || 0);
    });
    return r2(c);
  }

  function openDues(state, customerId) {
    var paid = paidMap(state), out = [];
    (state.sales || []).forEach(function (s) {
      if (s.Customer_ID !== customerId) return;
      var bal = saleBalance(s, state, paid);
      if (bal > 0) out.push({ saleId: s.Sale_ID, balance: bal, since: s.Paid_Till || s.Sale_Date || '' });
    });
    out.sort(function (a, b) { return Core.util.isoCompare(a.since, b.since) || (a.saleId - b.saleId); });
    return out;
  }

  function allocate(amount, dues) {
    var rest = r2(amount), applied = [];
    for (var i = 0; i < dues.length && rest > 0; i++) {
      var take = Math.min(rest, dues[i].balance);
      if (take > 0) { applied.push({ saleId: dues[i].saleId, amount: r2(take) }); rest = r2(rest - take); }
    }
    return { applied: applied, rest: rest };
  }

  /** Cost of a sale in BDT: converts USDT buy price via live rate, applies supplier markup. */
  /** Cost of a sale in BDT plus whether a USDT cost had no rate to convert with (then it counts as 0). */
  function saleCostInfo(sale, state) {
    var cost = Number(sale.Cost_Snapshot) || 0, rateMissing = false;
    var currency = String(sale.Buy_Currency || 'BDT').toUpperCase();
    if (currency === 'USDT') {
      var usdt = Number(sale.Buy_Price_USDT) || 0;
      var rate = Core.rates.resolveRate(state).rate;
      if (!rate) { rate = 0; rateMissing = true; }
      cost = r2(usdt * rate);
    }
    var prod = productOf(state.products, sale.Product_ID);
    if (prod && prod.Supplier_ID) {
      var sup = null;
      (state.suppliers || []).forEach(function (s) { if (s.Supplier_ID === prod.Supplier_ID) sup = s; });
      if (sup && Number(sup.Markup_Percent) > 0) {
        cost = r2(cost * (1 + Number(sup.Markup_Percent) / 100));
      }
    }
    return { cost: cost, rateMissing: rateMissing };
  }

  function saleCostBdt(sale, state) { return saleCostInfo(sale, state).cost; }

  return { CUSTOM_ID: CUSTOM_ID, CUSTOM_PRODUCT: CUSTOM_PRODUCT, isCustom: isCustom, salePrice: salePrice, isVoided: isVoided, saleRevenue: saleRevenue, owedBillFor: owedBillFor, uncollectedFor: uncollectedFor, paidMap: paidMap, salePaid: salePaid, saleBalance: saleBalance,
           customerBalance: customerBalance, creditOf: creditOf, openDues: openDues, allocate: allocate, productOf: productOf,
           saleCostBdt: saleCostBdt, saleCostInfo: saleCostInfo };
})();
if (typeof module !== 'undefined') module.exports = Core.ledger;

/**
 * Core.accrual: profit spread by month. A sale's revenue is spread evenly over the days it covers, and an account's cost (its
 * Purchases rows) over the days each purchase covers, so a 3-month payment counts a third in each month and empty seats count as cost.
 * Periods are half-open [start, end) in Dhaka 'YYYY-MM-DD' dates. Pure: no I/O.
 */
var Core = Core || {};
Core.accrual = (function () {
  var U = function () { return Core.util; };
  var L = function () { return Core.ledger; };
  var r2 = function (n) { return Core.util.round2(n); };
  var MAX_MONTHS = 24;

  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  function monthOf(iso) { return String(iso).slice(0, 7); }
  function nextMonthStart(iso) { return U().addMonths(monthOf(iso) + '-01', 1); }
  function byId(rows, key) { var m = {}; (rows || []).forEach(function (r) { m[r[key]] = r; }); return m; }
  function cycleOf(product) { return (product && Number(product.Billing_Cycle_Days)) || 30; }

  /**
   * The days a sale covers: {start, end} with start < end, or {start, end: ''} for a single day (codes, custom sales, no Paid_Till).
   * start is Covers_From when set, else Paid_Till minus Months cycles of the product, else Sale_Date. null when the sale has no date at all.
   */
  function saleCoverage(sale, products) {
    var end = isIso(sale.Paid_Till) ? sale.Paid_Till : '';
    if (!end) return isIso(sale.Sale_Date) ? { start: sale.Sale_Date, end: '' } : null;
    var start = isIso(sale.Covers_From) ? sale.Covers_From
      : U().addCycle(end, -(Number(sale.Months) || 1), cycleOf(L().productOf(products, sale.Product_ID)));
    if (!(start < end)) start = U().isoAddDays(end, -1);
    return { start: start, end: end };
  }

  /**
   * Splits `amount` over the months of [start, end). Each month weighs the share of that calendar month covered, so a whole month
   * counts 1 whatever its length (a 3-month payment from the 1st gives three equal parts). A single day (end blank) puts it all in
   * start's month. The parts sum exactly to amount.
   */
  function spread(amount, start, end) {
    var out = {};
    if (!end) { out[monthOf(start)] = r2(amount); return out; }
    var cur = start, parts = [], total = 0;
    while (cur < end) {
      var first = monthOf(cur) + '-01', next = nextMonthStart(cur), stop = next > end ? end : next;
      var w = U().daysBetween(cur, stop) / U().daysBetween(first, next);
      parts.push({ month: monthOf(cur), w: w }); total += w;
      cur = stop;
    }
    var given = 0;
    parts.forEach(function (p, i) {
      var share = i === parts.length - 1 ? r2(amount - given) : r2(amount * p.w / total);
      out[p.month] = r2((out[p.month] || 0) + share); given = r2(given + share);
    });
    return out;
  }

  /** Each account's Purchases rows as covered periods: [{purchase, accountId, start, end}]. */
  function purchasePeriods(state) {
    var acc = byId(state.accounts, 'Account_ID'), out = [], byAcc = {};
    (state.purchases || []).forEach(function (p) {
      if (!(Number(p.Amount) > 0) || !acc[p.Account_ID]) return;
      (byAcc[p.Account_ID] = byAcc[p.Account_ID] || []).push(p);
    });
    Object.keys(byAcc).forEach(function (id) {
      var cycle = cycleOf(L().productOf(state.products, acc[id].Product_ID)), prevEnd = '';
      var list = byAcc[id].map(function (p) {
        var end = isIso(p.Covers_Until) ? p.Covers_Until : isIso(p.Date) ? U().addCycle(p.Date, 1, cycle) : '';
        return { p: p, end: end };
      }).filter(function (x) { return x.end; })
        .sort(function (a, b) { return a.end < b.end ? -1 : a.end > b.end ? 1 : 0; });
      list.forEach(function (x) {
        var start;
        if (prevEnd && prevEnd < x.end) start = prevEnd;
        else {
          start = U().addCycle(x.end, -1, cycle);
          if (isIso(x.p.Date) && x.p.Date < start) start = x.p.Date;
        }
        if (!(start < x.end)) start = U().isoAddDays(x.end, -1);
        out.push({ purchase: x.p, accountId: id, start: start, end: x.end });
        prevEnd = x.end;
      });
    });
    return out;
  }

  function monthList(from, to) {
    var out = [], m = from;
    while (m <= to && out.length <= MAX_MONTHS) { out.push(m); m = monthOf(U().addMonths(m + '-01', 1)); }
    return out;
  }

  /**
   * Profit spread by month for months from..to ('YYYY-MM', default the last 6 months to this month).
   * months: [{ month, revenue, cost, profit, collected, byProduct: [...], byAccount: [...] }] oldest first.
   * costMissing: accounts with sales in range but no purchase, whose seat costs fall back to Cost_Snapshot.
   */
  function monthly(state, opts) {
    opts = opts || {};
    var to = opts.to || monthOf(state.today), from = opts.from || monthOf(U().addMonths(to + '-01', -5));
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) throw new Error('From and to must be months like 2026-10.');
    if (from > to) throw new Error('From must not be after to.');
    var list = monthList(from, to);
    if (list.length > MAX_MONTHS) throw new Error('A range can cover at most ' + MAX_MONTHS + ' months.');
    var want = {}; list.forEach(function (m) { want[m] = true; });

    var acc = byId(state.accounts, 'Account_ID'), prod = byId(state.products, 'Product_ID');
    var M = {};
    list.forEach(function (m) { M[m] = { month: m, revenue: 0, cost: 0, collected: 0, products: {}, accounts: {} }; });
    function prodRow(m, pid) {
      var p = M[m].products[pid];
      if (!p) p = M[m].products[pid] = { productId: pid, name: (L().productOf(state.products, pid) || {}).Product_Name || pid, revenue: 0, cost: 0 };
      return p;
    }
    function accRow(m, id) {
      var a = M[m].accounts[id];
      if (!a) {
        var row = acc[id] || {}, host = row.Product_ID ? Core.sales.hostSeats(state, row) : 0;
        a = M[m].accounts[id] = { accountId: id, label: row.Account_Label || '', productId: row.Product_ID || '', revenue: 0, cost: 0,
          seats: Math.max(0, (Number(row.Slots) || 0) - host), seatsUsed: 0 };
      }
      return a;
    }

    var periods = purchasePeriods(state), hasPurchase = {};
    periods.forEach(function (x) { hasPurchase[x.accountId] = true; });
    periods.forEach(function (x) {
      var parts = spread(Number(x.purchase.Amount), x.start, x.end), pid = acc[x.accountId].Product_ID;
      for (var m in parts) {
        if (!want[m]) continue;
        M[m].cost += parts[m]; prodRow(m, pid).cost += parts[m]; accRow(m, x.accountId).cost += parts[m];
      }
    });

    var rateMissing = false, missing = {};
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status === 'Void' || s.Record_Status === 'Refunded') return;
      var cov = saleCoverage(s, state.products);
      if (!cov) return;
      var rev = spread(L().saleRevenue(s, state.products), cov.start, cov.end);
      var onAccount = !!(s.Account_ID && acc[s.Account_ID]);
      var cost = null;
      if (!(onAccount && hasPurchase[s.Account_ID])) {
        var ci = L().saleCostInfo(s, state);
        if (ci.cost) cost = spread(ci.cost, cov.start, cov.end);
        if (ci.rateMissing) rateMissing = true;
      }
      var touched = false;
      for (var m in rev) {
        if (!want[m]) continue;
        touched = true;
        M[m].revenue += rev[m]; prodRow(m, s.Product_ID).revenue += rev[m];
        if (onAccount) { var a = accRow(m, s.Account_ID); a.revenue += rev[m]; if (cov.end) a.seatsUsed++; }
      }
      if (cost) for (var c in cost) {
        if (!want[c]) continue;
        M[c].cost += cost[c]; prodRow(c, s.Product_ID).cost += cost[c];
        if (onAccount) accRow(c, s.Account_ID).cost += cost[c];
      }
      if (touched && onAccount && !hasPurchase[s.Account_ID] && L().productOf(state.products, s.Product_ID) && !L().isCustom(s)) missing[s.Account_ID] = true;
    });

    (state.payments || []).forEach(function (p) {
      if (p.Source === 'Credit' || !isIso(p.Date)) return;
      var m = monthOf(p.Date);
      if (want[m]) M[m].collected += Number(p.Amount) || 0;
    });

    function fin(o) { o.revenue = r2(o.revenue); o.cost = r2(o.cost); o.profit = r2(o.revenue - o.cost); return o; }
    var months = list.map(function (m) {
      var x = M[m];
      return { month: m, revenue: r2(x.revenue), cost: r2(x.cost), profit: r2(x.revenue - x.cost), collected: r2(x.collected),
        byProduct: Object.keys(x.products).map(function (k) { return fin(x.products[k]); }).sort(function (a, b) { return b.profit - a.profit; }),
        byAccount: Object.keys(x.accounts).map(function (k) { return fin(x.accounts[k]); })
          .sort(function (a, b) { return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.accountId < b.accountId ? -1 : 1; }) };
    });
    return { from: from, to: to, months: months, costMissing: Object.keys(missing).sort(), rateMissing: rateMissing };
  }

  return { saleCoverage: saleCoverage, spread: spread, purchasePeriods: purchasePeriods, monthly: monthly, MAX_MONTHS: MAX_MONTHS };
})();
if (typeof module !== 'undefined') module.exports = Core.accrual;

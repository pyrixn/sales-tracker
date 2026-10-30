/** Core.money: figures for the Money overview. Reuses Core.views (bookData, duesList) and Core.ledger so there is one definition of net, revenue and cost. */
var Core = Core || {};
Core.money = (function () {
  var r2 = function (n) { return Core.util.round2(n); };
  var BUCKETS = [['0-7', 7], ['8-30', 30], ['31-60', 60], ['60+', Infinity]];

  function monthShift(month, delta) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1 + delta;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + (m < 9 ? '0' : '') + (m + 1);
  }

  function byId(rows, f) { var o = {}; (rows || []).forEach(function (r) { o[r[f]] = r; }); return o; }

  /** Cash in/out per payment method over ALL dated entries (plus undated legacy opening), not as of `month`: balances are today's, from bookData so they agree with the Book tab. `recent` is the last 5 movements, newest first. */
  function cashByMethod(state, month) {
    var book = Core.views.bookData(state, month), methods = {}, order = [];
    function slot(m) { if (!methods[m]) { methods[m] = { method: m, in: 0, out: 0, recent: [] }; order.push(m); } return methods[m]; }
    book.months.forEach(function (mo) {
      Core.views.bookData(state, mo).entries.forEach(function (e) {
        var s = slot(e.method || 'Unspecified');
        if (e.kind === 'in') s.in += e.amount; else s.out += e.amount;
        s.recent.push({ date: e.date, kind: e.kind, label: e.label, amount: e.amount });
      });
    });
    if (book.legacyOpening) { var o = slot('Opening'); if (book.legacyOpening > 0) o.in += book.legacyOpening; else o.out -= book.legacyOpening; }
    return order.map(function (m) { var s = methods[m]; var recent = s.recent.map(function (x, i) { return { x: x, i: i }; })
        .sort(function (a, b) { return a.x.date < b.x.date ? 1 : a.x.date > b.x.date ? -1 : b.i - a.i; })
        .slice(0, 5).map(function (r) { return r.x; });
      return { method: m, in: r2(s.in), out: r2(s.out), balance: r2(s.in - s.out), recent: recent }; });
  }

  function duesBuckets(state) {
    var d = Core.views.duesList(state), b = BUCKETS.map(function (x) { return { label: x[0], count: 0, amount: 0 }; });
    d.rows.forEach(function (r) {
      var late = r.daysLate === null ? 0 : r.daysLate;
      for (var i = 0; i < BUCKETS.length; i++) if (late <= BUCKETS[i][1]) { b[i].count++; b[i].amount += r.amount; break; }
    });
    b.forEach(function (x) { x.amount = r2(x.amount); });
    return { buckets: b, total: d.total };
  }

  /** Revenue and cost per product and per account for sales made in the month, same attribution as Core.views.profitByFamily. */
  function profitSplits(state, month) {
    var prod = byId(state.products, 'Product_ID'), acct = byId(state.accounts, 'Account_ID');
    prod[Core.ledger.CUSTOM_ID] = Core.ledger.CUSTOM_PRODUCT;
    var P = {}, A = {}, rateMissing = false, paid = Core.ledger.paidMap(state);
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status === 'Void' || s.Record_Status === 'Refunded') return;
      if (String(s.Sale_Date || '').slice(0, 7) !== month) return;
      var rev = Core.ledger.saleRevenue(s, state.products), ci = Core.ledger.saleCostInfo(s, state), un = Core.ledger.uncollectedFor(s, state, paid);
      if (ci.rateMissing) rateMissing = true;
      var p = P[s.Product_ID] || (P[s.Product_ID] = { productId: s.Product_ID, revenue: 0, cost: 0, uncollected: 0 });
      p.revenue += rev; p.cost += ci.cost; p.uncollected += un;
      if (s.Account_ID) { var a = A[s.Account_ID] || (A[s.Account_ID] = { accountId: s.Account_ID, revenue: 0, cost: 0, uncollected: 0 }); a.revenue += rev; a.cost += ci.cost; a.uncollected += un; }
    });
    var products = Object.keys(P).map(function (k) {
      var x = P[k], pr = prod[k] || {}, revenue = r2(x.revenue), cost = r2(x.cost), profit = r2(x.revenue - x.cost);
      return { productId: k, name: pr.Product_Name || k, category: pr.Category || 'Subscription', revenue: revenue, cost: cost, profit: profit,
               uncollected: r2(x.uncollected), collectedProfit: r2(x.revenue - x.cost - x.uncollected), marginPct: revenue > 0 ? Math.round(profit / revenue * 10000) / 100 : 0 };
    }).sort(function (a, b) { return b.profit - a.profit; });
    var accounts = Object.keys(A).map(function (k) {
      var x = A[k], ac = acct[k] || {};
      return { accountId: k, label: ac.Account_Label || k, productId: ac.Product_ID || '', revenue: r2(x.revenue), cost: r2(x.cost),
               profit: r2(x.revenue - x.cost), uncollected: r2(x.uncollected), collectedProfit: r2(x.revenue - x.cost - x.uncollected), retired: (ac.Account_Status || 'Active') !== 'Active' };
    }).sort(function (a, b) { return b.profit - a.profit; });
    return { products: products, accounts: accounts, rateMissing: rateMissing };
  }

  /** Top customers. Overview call: by money received in the 12 months to `month`, 8 rows.
   *  With opts { from, to, limit }: by billed revenue of sales dated in the range, with the profit, active lines and what is owed now. */
  function topCustomers(state, month, opts) {
    var cust = byId(state.customers, 'Customer_ID');
    var lines = {};
    (state.sales || []).forEach(function (s) { if (s.Record_Status === 'Active') lines[s.Customer_ID] = (lines[s.Customer_ID] || 0) + 1; });
    if (opts && opts.from) {
      var B = {}, paid = Core.ledger.paidMap(state);
      (state.sales || []).forEach(function (s) {
        if (Core.ledger.isVoided(s) || !s.Customer_ID || !inRange(s.Sale_Date, opts.from, opts.to)) return;
        var b = B[s.Customer_ID] || (B[s.Customer_ID] = { revenue: 0, cost: 0 });
        b.revenue += Core.ledger.saleRevenue(s, state.products); b.cost += Core.ledger.saleCostInfo(s, state).cost;
      });
      var owes = {};
      (state.sales || []).forEach(function (s) {
        var bal = Core.ledger.saleBalance(s, state, paid);
        if (bal > 0 && B[s.Customer_ID]) owes[s.Customer_ID] = r2((owes[s.Customer_ID] || 0) + bal);
      });
      return Object.keys(B).map(function (k) {
        return { customerId: k, name: (cust[k] || {}).Name || k, revenue: r2(B[k].revenue), profit: r2(B[k].revenue - B[k].cost), lines: lines[k] || 0, owes: owes[k] || 0 };
      }).sort(function (a, b) { return b.revenue - a.revenue || (a.name < b.name ? -1 : 1); }).slice(0, opts.limit || 10);
    }
    var from = monthShift(month, -11) + '-01', to = monthShift(month, 1) + '-01', T = {};
    (state.payments || []).forEach(function (p) {
      if (p.Source === 'Credit' || !p.Date || p.Date < from || p.Date >= to) return;
      T[p.Customer_ID] = r2((T[p.Customer_ID] || 0) + (Number(p.Amount) || 0));
    });
    return Object.keys(T).map(function (k) {
      return { customerId: k, name: (cust[k] || {}).Name || k, paid: T[k], lines: lines[k] || 0 };
    }).sort(function (a, b) { return b.paid - a.paid || (a.name < b.name ? -1 : 1); }).slice(0, 8);
  }

  /** Active timed lines whose Paid_Till is today..today+days-1 (code products excluded), one renewal of the line's monthly price each. */
  function renewingLines(state, days) {
    var prod = byId(state.products, 'Product_ID'), out = [];
    (state.sales || []).forEach(function (s) {
      if (s.Record_Status !== 'Active' || !s.Paid_Till) return;
      if (Core.sales.deliversAs(prod[s.Product_ID]) === 'code') return;
      var d = Core.util.daysBetween(state.today, s.Paid_Till);
      if (d < 0 || d > days - 1) return;
      out.push({ sale: s, date: s.Paid_Till, amount: Core.ledger.salePrice(s, state.products) });
    });
    return out;
  }

  /** Active timed lines renewing in the next 14 days, grouped by day. */
  function forecast(state) {
    var D = {}, order = [];
    renewingLines(state, 14).forEach(function (x) {
      if (!D[x.date]) { D[x.date] = { date: x.date, amount: 0, count: 0 }; order.push(x.date); }
      D[x.date].amount += x.amount; D[x.date].count++;
    });
    return order.sort().map(function (k) { D[k].amount = r2(D[k].amount); return D[k]; });
  }

  function expensesByType(state, month) {
    var T = {}, order = [];
    function add(c, a) { if (!(c in T)) { T[c] = 0; order.push(c); } T[c] += a; }
    (state.expenses || []).forEach(function (e) { if (e.Date && e.Date.slice(0, 7) === month) add(e.Category || 'Other', Number(e.Amount) || 0); });
    (state.purchases || []).forEach(function (p) {
      if (p.Date && p.Date.slice(0, 7) === month && !/^Opening balance/i.test(String(p.Notes || p.Note || ''))) add('Account purchases', Number(p.Amount) || 0);
    });
    return order.map(function (c) { return { category: c, amount: r2(T[c]) }; }).sort(function (a, b) { return b.amount - a.amount; });
  }

  function overview(state, month) {
    var cur = Core.views.bookData(state, month), prev = Core.views.bookData(state, monthShift(month, -1));
    var series = [];
    for (var i = 5; i >= 0; i--) {
      var m = monthShift(month, -i), b = i === 0 ? cur : Core.views.bookData(state, m);
      series.push({ month: m, in: b.in, out: b.out, net: b.net });
    }
    var sp = profitSplits(state, month);
    return { month: month, net: cur.net, prevNet: prev.net, delta: r2(cur.net - prev.net), in: cur.in, out: cur.out, series: series,
             cash: cashByMethod(state, month), dues: duesBuckets(state), products: sp.products, accounts: sp.accounts,
             customers: topCustomers(state, month), forecast: forecast(state), expensesByType: expensesByType(state, month), rateMissing: sp.rateMissing };
  }

  var RETENTION_STEPS = [1, 2, 3, 6];

  function monthList(from, to) {
    var out = [], m = from.slice(0, 7), end = to.slice(0, 7);
    while (m <= end) { out.push(m); m = monthShift(m, 1); }
    return out;
  }

  /**
   * Business insights for a date range (opts { from, to }, 'YYYY-MM-DD', default: 12 full months before this month up to today).
   * Two "revenue" figures, never mixed: revenue, cost, profit, margin and byCategory are BILLED (Core.ledger.saleRevenue and saleCostInfo
   * over sales dated in the range, the same sums as Core.views.profitByFamily); collected is money received (Payments excluding Source
   * 'Credit', the Book's "in"). Months are keyed by Sale_Date / payment Date; undated payments are left out of the series and counted.
   * Renewal rate: lines (Sub_Code) whose Paid_Till is in the range and already past; renewed = a later sale on the same Sub_Code dated within
   * 7 days after Paid_Till; a line not renewed whose 7 days are not over yet is pending and left out.
   * Retention: customers by month of their first sale; kept at k months = latest Paid_Till reaches first sale + k months (null: too young).
   */
  function insights(state, opts) {
    opts = opts || {};
    var today = state.today, thisMonth = today.slice(0, 7);
    var from = opts.from || monthShift(thisMonth, -12) + '-01', to = opts.to || today;
    var range = { from: from, to: to };
    var prod = byId(state.products, 'Product_ID'), cust = byId(state.customers, 'Customer_ID');
    prod[Core.ledger.CUSTOM_ID] = Core.ledger.CUSTOM_PRODUCT;
    var paid = Core.ledger.paidMap(state);
    var series = {}, order = monthList(from, to);
    order.forEach(function (m) { series[m] = { month: m, revenue: 0, cost: 0, collected: 0, payments: 0, newCustomers: 0, renewals: 0 }; });

    var revenue = 0, cost = 0, rateMissing = false, billedCustomers = {}, paidOnRange = 0, owedNow = 0, lateSum = 0, lateN = 0;
    var firstSale = {}, firstOfLine = {}, lineSales = {}, till = {};
    (state.sales || []).forEach(function (s) {
      if (Core.ledger.isVoided(s)) return;
      if (s.Customer_ID && s.Sale_Date && (!firstSale[s.Customer_ID] || s.Sale_Date < firstSale[s.Customer_ID])) firstSale[s.Customer_ID] = s.Sale_Date;
      if (s.Customer_ID && s.Paid_Till && (!till[s.Customer_ID] || s.Paid_Till > till[s.Customer_ID])) till[s.Customer_ID] = s.Paid_Till;
      if (s.Sub_Code) (lineSales[s.Sub_Code] || (lineSales[s.Sub_Code] = [])).push(s);
    });
    Object.keys(lineSales).forEach(function (k) { lineSales[k].sort(function (a, b) { return Number(a.Sale_ID) - Number(b.Sale_ID); }); firstOfLine[k] = lineSales[k][0].Sale_ID; });

    (state.sales || []).forEach(function (s) {
      if (Core.ledger.isVoided(s) || !inRange(s.Sale_Date, from, to)) return;
      var m = series[s.Sale_Date.slice(0, 7)], rev = Core.ledger.saleRevenue(s, state.products), ci = Core.ledger.saleCostInfo(s, state);
      m.revenue += rev; m.cost += ci.cost; revenue += rev; cost += ci.cost;
      if (ci.rateMissing) rateMissing = true;
      if (s.Customer_ID) billedCustomers[s.Customer_ID] = true;
      if (s.Sub_Code && !Core.ledger.isCustom(s) && firstOfLine[s.Sub_Code] !== s.Sale_ID) m.renewals++;
      paidOnRange += paid[s.Sale_ID] || 0;
      var bal = Core.ledger.saleBalance(s, state, paid);
      if (bal > 0) {
        owedNow += bal;
        lateSum += Math.max(0, Core.util.daysBetween(s.Paid_Till || s.Sale_Date, today)); lateN++;
      }
    });
    Object.keys(firstSale).forEach(function (id) { var m = series[firstSale[id].slice(0, 7)]; if (m && inRange(firstSale[id], from, to)) m.newCustomers++; });

    // undated counts every dated-less payment on record (it has no date to scope by), so the UI can say how many are left out of the months.
    var collected = 0, undated = 0, methods = {}, methodOrder = [];
    (state.payments || []).forEach(function (p) {
      if (p.Source === 'Credit') return;
      var amt = Number(p.Amount) || 0;
      if (!p.Date) { undated++; return; }
      if (!inRange(p.Date, from, to)) return;
      var m = series[p.Date.slice(0, 7)];
      m.collected += amt; m.payments++; collected += amt;
      var k = p.Method || 'Unspecified';
      if (!(k in methods)) { methods[k] = 0; methodOrder.push(k); }
      methods[k] += amt;
    });

    var reached = 0, renewed = 0;
    Object.keys(lineSales).forEach(function (code) {
      var list = lineSales[code];
      list.forEach(function (s, i) {
        if (Core.ledger.isCustom(s) || !s.Paid_Till || !inRange(s.Paid_Till, from, to) || s.Paid_Till > today) return;
        if (Core.sales.deliversAs(prod[s.Product_ID]) === 'code') return;
        // Only lines whose 7-day window is over count, renewed or not; counting early renewals alone would push the rate up.
        var limit = Core.util.isoAddDays(s.Paid_Till, 7);
        if (limit >= today) return;
        reached++;
        if (list.slice(i + 1).some(function (n) { return n.Sale_Date && n.Sale_Date <= limit; })) renewed++;
      });
    });

    var families = Core.views.profitByFamily(state, range), famRevenue = 0;
    families.forEach(function (f) { famRevenue += f.revenue; });
    var byCategory = families.map(function (f) { return { category: f.category, revenue: f.revenue, profit: f.profit, share: famRevenue > 0 ? r2(f.revenue / famRevenue * 100) : 0 }; });

    var lines = {}, active = 0, gone = {};
    (state.accounts || []).forEach(function (a) { if (a.Account_Status === 'Deleted') gone[a.Account_ID] = true; });
    (state.sales || []).forEach(function (s) {
      // A live timed line: Active with an end date, not a game code (sold once, Active for ever) and not on a deleted account.
      if (s.Record_Status === 'Active' && s.Paid_Till && !Core.ledger.isCustom(s) && !gone[s.Account_ID] && Core.sales.deliversAs(prod[s.Product_ID]) !== 'code') {
        active++; lines[s.Customer_ID] = true;
      }
    });

    var retention = order.map(function (m) {
      var ids = Object.keys(firstSale).filter(function (id) { return firstSale[id].slice(0, 7) === m; });
      if (!ids.length) return null;
      return { cohort: m, size: ids.length, kept: RETENTION_STEPS.map(function (k) {
        var ok = 0, n = 0;
        ids.forEach(function (id) {
          var target = Core.util.addMonths(firstSale[id], k);
          if (target > today) return;
          n++; if ((till[id] || '') >= target) ok++;
        });
        return n ? r2(ok / n * 100) : null;
      }) };
    }).filter(Boolean);

    var fc = renewingLines(state, 30).sort(function (a, b) { return Core.util.isoCompare(a.date, b.date) || Number(a.sale.Sale_ID) - Number(b.sale.Sale_ID); });
    var fcTotal = 0;
    var next30Lines = fc.map(function (x) {
      var s = x.sale, p = prod[s.Product_ID] || {};
      fcTotal += x.amount;
      return { saleId: s.Sale_ID, customerId: s.Customer_ID, name: (cust[s.Customer_ID] || {}).Name || s.Customer || '', productName: p.Product_Name || s.Product_ID, amount: r2(x.amount), date: x.date };
    });

    var billedN = Object.keys(billedCustomers).length, profit = revenue - cost;
    var methodMix = methodOrder.map(function (k) { return { method: k, amount: r2(methods[k]), share: collected > 0 ? r2(methods[k] / collected * 100) : 0 }; })
      .sort(function (a, b) { return b.amount - a.amount; });
    return {
      range: range,
      months: order.map(function (m) { var x = series[m];
        return { month: m, revenue: r2(x.revenue), cost: r2(x.cost), profit: r2(x.revenue - x.cost), collected: r2(x.collected), payments: x.payments, newCustomers: x.newCustomers, renewals: x.renewals }; }),
      kpis: { revenue: r2(revenue), profit: r2(profit), marginPct: revenue > 0 ? Math.round(profit / revenue * 10000) / 100 : 0, collected: r2(collected),
        arpu: billedN ? r2(revenue / billedN) : 0, activeLines: active, activeCustomers: Object.keys(lines).length,
        renewalRatePct: reached ? r2(renewed / reached * 100) : 0, churnedLines: reached - renewed,
        collectionRatePct: paidOnRange + owedNow > 0 ? r2(paidOnRange / (paidOnRange + owedNow) * 100) : 0,
        avgDaysLate: lateN ? Math.round(lateSum / lateN * 10) / 10 : 0, rateMissing: rateMissing, undatedPayments: undated },
      byCategory: byCategory,
      topCustomers: topCustomers(state, thisMonth, { from: from, to: to, limit: 10 }),
      forecast: { next30Expected: r2(fcTotal), next30Lines: next30Lines },
      retention: retention,
      methodMix: methodMix
    };
  }

  var WIDGETS = [
    { id: 'net', title: 'Net this month', size: 'sm', kind: 'stat' },
    { id: 'trend', title: 'Six-month trend', size: 'lg', kind: 'chart' },
    { id: 'cash', title: 'Cash by method', size: 'md', kind: 'list' },
    { id: 'dues', title: 'Dues by age', size: 'md', kind: 'chart' },
    { id: 'products', title: 'Profit by product', size: 'md', kind: 'list' },
    { id: 'accounts', title: 'Profit by account', size: 'md', kind: 'list' },
    { id: 'customers', title: 'Top customers', size: 'md', kind: 'list' },
    { id: 'forecast', title: 'Renewals, next 14 days', size: 'md', kind: 'list' },
    { id: 'expenses', title: 'Expenses by type', size: 'md', kind: 'chart' },
    { id: 'goals', title: 'Goals', size: 'lg', kind: 'progress' },
    { id: 'budgets', title: 'Budgets', size: 'lg', kind: 'progress' }
  ];
  var DEFAULT_LAYOUT = ['net', 'trend', 'cash', 'dues', 'products', 'forecast'];

  function inRange(d, from, to) { return !!d && d >= from && d <= to; }

  /** Progress of one goal. current uses the same definitions as the rest of Money: revenue = Core.ledger.saleRevenue and
   *  profit = revenue minus Core.ledger.saleCostInfo for non-void, non-refunded sales dated in the period; collected = Payments
   *  in the period excluding Source 'Credit'; new_customers = customers whose Created is in the period.
   *  pct is rounded to 2 decimals and is NOT capped (a goal beyond target shows above 100); target <= 0 gives pct 0.
   *  onTrack: target met, or current >= target x share of the period elapsed (a goal not started yet is on track). */
  function goalProgress(state, goal) {
    var from = String(goal.Start || ''), to = String(goal.End || ''), target = Number(goal.Target) || 0, cur = 0;
    if (goal.Metric === 'revenue' || goal.Metric === 'profit') {
      (state.sales || []).forEach(function (s) {
        if (s.Record_Status === 'Void' || s.Record_Status === 'Refunded' || !inRange(s.Sale_Date, from, to)) return;
        var rev = Core.ledger.saleRevenue(s, state.products);
        cur += goal.Metric === 'revenue' ? rev : rev - Core.ledger.saleCostInfo(s, state).cost;
      });
    } else if (goal.Metric === 'collected') {
      (state.payments || []).forEach(function (p) { if (p.Source !== 'Credit' && inRange(p.Date, from, to)) cur += Number(p.Amount) || 0; });
    } else if (goal.Metric === 'new_customers') {
      (state.customers || []).forEach(function (c) { if (inRange(c.Created, from, to)) cur++; });
    }
    cur = r2(cur);
    var pct = target > 0 ? Math.round(cur / target * 10000) / 100 : 0;
    var daysLeft = Math.max(0, Core.util.daysBetween(state.today, to) || 0);
    var total = Core.util.daysBetween(from, to) + 1, elapsed = Core.util.daysBetween(from, state.today) + 1;
    var share = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
    return { current: cur, target: target, pct: pct, remaining: r2(Math.max(0, target - cur)), daysLeft: daysLeft,
             onTrack: target > 0 ? cur >= target * share : true };
  }

  /** Spend against a monthly limit: that month's Expenses in the category (Purchases, excluding opening balances, for 'Account purchases').
   *  pct is rounded to 2 decimals and NOT capped (over budget shows above 100). state: over when spent > limit, warn when pct >= Alert_Pct (default 80), else ok. */
  function budgetProgress(state, budget, month) {
    var spent = 0, limit = Number(budget.Monthly_Limit) || 0, alert = Number(budget.Alert_Pct);
    if (!(alert > 0)) alert = 80;
    expensesByType(state, month).forEach(function (e) { if (e.category === budget.Category) spent += e.amount; });
    spent = r2(spent);
    var pct = limit > 0 ? Math.round(spent / limit * 10000) / 100 : 0;
    return { spent: spent, limit: limit, pct: pct, state: spent > limit ? 'over' : (pct >= alert ? 'warn' : 'ok') };
  }

  return { overview: overview, WIDGETS: WIDGETS, DEFAULT_LAYOUT: DEFAULT_LAYOUT, goalProgress: goalProgress, budgetProgress: budgetProgress, insights: insights };
})();
if (typeof module !== 'undefined') module.exports = Core.money;

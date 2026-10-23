/**
 * Core.rates: USDT to BDT rate selection. Pure: no I/O, no clock unless the caller passes `now`.
 * The network fetch lives in the Edge Function; this module only picks and resolves.
 */
Core.rates = (function () {
  var FRESH_MS = 5 * 60 * 1000;

  function round2(n) { return Math.round(n * 100) / 100; }

  /** Median of the 5 cheapest positive prices in a P2P ad list, rounded to 2 decimals; null when none usable. */
  function pickRate(ads) {
    var prices = [];
    (Array.isArray(ads) ? ads : []).forEach(function (a) {
      var p = a ? Number(a.price) : NaN;
      if (isFinite(p) && p > 0) prices.push(p);
    });
    if (!prices.length) return null;
    prices.sort(function (a, b) { return a - b; });
    var top = prices.slice(0, 5), mid = Math.floor(top.length / 2);
    var med = top.length % 2 ? top[mid] : (top[mid - 1] + top[mid]) / 2;
    return round2(med);
  }

  /** { rate, source: 'manual'|'bybit'|'none', fetchedAt, stale }. Manual override > fresh row > stale row > none. */
  function resolveRate(state, now) {
    var manual = Number((state.settings || {}).usdt_bdt_manual);
    if (isFinite(manual) && manual > 0) return { rate: manual, source: 'manual', fetchedAt: '', stale: false };
    var rows = state.liveRates || [], r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].ID === 'usdt_bdt') r = rows[i];
    if (!r && rows.length) r = rows[0];
    var rate = r ? Number(r.Rate) : 0;
    if (!r || !(rate > 0)) return { rate: null, source: 'none', fetchedAt: '', stale: true };
    var fetched = r.Fetched_At ? new Date(r.Fetched_At).getTime() : 0;
    var age = fetched ? (now === undefined ? Date.now() : now) - fetched : Infinity;
    return { rate: rate, source: 'bybit', fetchedAt: String(r.Fetched_At || ''), stale: !(age <= FRESH_MS) };
  }

  return { pickRate: pickRate, resolveRate: resolveRate, FRESH_MS: FRESH_MS };
})();
if (typeof module !== 'undefined') module.exports = Core.rates;

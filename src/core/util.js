/** Core.util: money rounding and ISO-date arithmetic. Dates are 'YYYY-MM-DD' strings, computed in UTC so no time zone can shift them. */
var Core = Core || {};
Core.util = (function () {
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function parse(iso) {
    var p = String(iso).split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function fmt(ms) {
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function isoAddDays(iso, n) { return fmt(parse(iso) + n * 86400000); }

  /** Blank sorts after every date. */
  function isoCompare(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function daysBetween(fromIso, toIso) { return Math.round((parse(toIso) - parse(fromIso)) / 86400000); }

  function addMonths(iso, months) {
    var p = String(iso).split('-').map(Number);
    var y = p[0], m = p[1] - 1 + months, d = p[2];
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fmt(Date.UTC(y, m, Math.min(d, last)));
  }

  /** 30-day products renew by calendar months (EDATE); any other cycle adds days x months. */
  function addCycle(startIso, months, cycleDays) {
    months = Number(months) || 1;
    cycleDays = Number(cycleDays) || 30;
    return cycleDays === 30 ? addMonths(startIso, months) : isoAddDays(startIso, cycleDays * months);
  }

  /** A renewal continues from the old Paid_Till when today is within Paid_Till + grace; otherwise it starts today. */
  function renewalStart(oldPaidTill, todayIso, graceDays) {
    if (!oldPaidTill) return todayIso;
    return todayIso <= isoAddDays(oldPaidTill, Number(graceDays) || 0) ? oldPaidTill : todayIso;
  }

  /**
   * Editing Months does not move Paid_Till by itself (the owner changes both). This says what the
   * new end date would be, so the edit form can offer to move it and warn when the two disagree.
   * A blank current Paid_Till stays blank: a line with no end date does not gain one from Months.
   */
  function suggestPaidTill(currentTill, oldMonths, newMonths, cycleDays) {
    if (!currentTill) return '';
    oldMonths = Number(oldMonths) || 1;
    newMonths = Number(newMonths) || 1;
    if (newMonths === oldMonths) return currentTill;
    var start = addCycle(currentTill, -oldMonths, cycleDays);
    return addCycle(start, newMonths, cycleDays);
  }


  return { round2: round2, isoAddDays: isoAddDays, isoCompare: isoCompare, daysBetween: daysBetween,
           addMonths: addMonths, addCycle: addCycle, renewalStart: renewalStart, suggestPaidTill: suggestPaidTill };
})();
if (typeof module !== 'undefined') module.exports = Core.util;

/** Core.exporter: RFC 4180 CSV for "Export all data". */
var Core = Core || {};
Core.exporter = (function () {
  function cell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows, headers) {
    var lines = [headers.map(cell).join(',')];
    (rows || []).forEach(function (r) { lines.push(headers.map(function (h) { return cell(r[h]); }).join(',')); });
    return lines.join('\r\n');
  }
  /** Spreadsheet formula guard for exports of user text: a string whose first non-blank character is = + - @ (or that starts with TAB/CR)
   *  gets a leading ' so Excel/Sheets show it as text. Numbers and non-strings pass through untouched. */
  function safeCell(v) { return typeof v === 'string' && /^(?:[\t\r]|\s*[=+\-@])/.test(v) ? "'" + v : v; }
  function safeRows(rows) {
    return (rows || []).map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { o[k] = safeCell(r[k]); }); return o; });
  }
  return { toCsv: toCsv, safeCell: safeCell, safeRows: safeRows };
})();
if (typeof module !== 'undefined') module.exports = Core.exporter;

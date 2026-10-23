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
  return { toCsv: toCsv };
})();
if (typeof module !== 'undefined') module.exports = Core.exporter;

/** Core.refs: reading the customer's bKash reference code (e.g. N44) and finding its subscription line. */
var Core = Core || {};
Core.refs = (function () {
  // A single letter that starts a word, optional space or dash, then 1-5 digits that end the number.
  var CODE = /(?:^|[^A-Za-z0-9])([A-Za-z])\s*-?\s*(\d{1,5})(?!\d)/;

  function normalizeRef(text) {
    if (text === null || text === undefined) return null;
    var m = CODE.exec(String(text));
    return m ? m[1].toUpperCase() + String(Number(m[2])) : null;
  }

  function findRef(row) {
    var fromCol = normalizeRef(row && row.Reference);
    if (fromCol) return fromCol;
    var m = /Ref(?:erence)?\.?\s*:?\s*([A-Za-z]\s*-?\s*\d{1,5})(?!\d)/i.exec(String((row && row.Raw_SMS) || ''));
    return m ? normalizeRef(m[1]) : null;
  }

  function subCodeLine(state, code) {
    var rows = (state.sales || []).filter(function (s) { return s.Sub_Code === code; });
    var latest = null;
    rows.forEach(function (s) {
      if (s.Record_Status === 'Active' && (!latest || Number(s.Sale_ID) > Number(latest.Sale_ID))) latest = s;
    });
    return { latest: latest, rows: rows };
  }

  return { normalizeRef: normalizeRef, findRef: findRef, subCodeLine: subCodeLine };
})();
if (typeof module !== 'undefined') module.exports = Core.refs;

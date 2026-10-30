/** Core.refs: reading the customer's bKash reference code (e.g. N44) and finding its subscription line. */
var Core = Core || {};
Core.refs = (function () {
  // A single letter that starts a word, optional space or dash, then 1-5 digits that end the number.
  var CODE = /(?:^|[^A-Za-z0-9])([A-Za-z])\s*-?\s*(\d{1,5})(?!\d)/;

  // With known prefixes (1-3 letters, from products): the longest listed prefix wins, and a token
  // with an unlisted prefix (VP12 when only V is known) is never read as its trailing letter.
  function codeFor(prefixes) {
    var list = (prefixes || []).map(function (p) { return String(p || '').toUpperCase(); })
      .filter(function (p) { return /^[A-Z]{1,3}$/.test(p); });
    if (!list.length) return CODE;
    list.sort(function (a, b) { return b.length - a.length; });
    return new RegExp('(?:^|[^A-Za-z0-9])(' + list.join('|') + ')\\s*-?\\s*(\\d{1,5})(?!\\d)', 'i');
  }

  function normalizeRef(text, prefixes) {
    if (text === null || text === undefined) return null;
    var m = codeFor(prefixes).exec(String(text));
    return m ? m[1].toUpperCase() + String(Number(m[2])) : null;
  }

  function findRef(row, prefixes) {
    var fromCol = normalizeRef(row && row.Reference, prefixes);
    if (fromCol) return fromCol;
    var m = /Ref(?:erence)?\.?\s*:?\s*([A-Za-z]{1,3}\s*-?\s*\d{1,5})(?!\d)/i.exec(String((row && row.Raw_SMS) || ''));
    return m ? normalizeRef(m[1], prefixes) : null;
  }

  // Random customer references (migration 013): 6 lowercase letters and digits, with both kinds in them,
  // and never the legacy shape (1-3 letters then 1-5 digits), so a random ref is never read as N54 or R12.
  var ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789', REF_LENGTH = 6;
  var LEGACY_SHAPE = /^[a-z]{1,3}\d{1,5}$/i;

  function isRandomRef(s) {
    var t = String(s === null || s === undefined ? '' : s);
    return /^[a-z0-9]{6}$/i.test(t) && /\d/.test(t) && /[a-z]/i.test(t) && !LEGACY_SHAPE.test(t);
  }

  // rand(n) returns an integer in [0, n). Tries up to 50 times, then gives up.
  function newRef(taken, rand) {
    var pick = rand || function (n) { return Core.util.randomInt(n); };
    for (var tries = 0; tries < 50; tries++) {
      var s = '';
      for (var i = 0; i < REF_LENGTH; i++) s += ALPHABET.charAt(pick(ALPHABET.length));
      if (isRandomRef(s) && !taken[s.toUpperCase()]) return s;
    }
    throw new Error('Could not make a unique reference. Try again.');
  }

  // Upper-case values in use: every sub code, every pay request id and every pay request ref.
  function usedRefs(state) {
    var out = {};
    (state.sales || []).forEach(function (s) { if (s.Sub_Code) out[String(s.Sub_Code).toUpperCase()] = true; });
    (state.payRequests || []).forEach(function (r) {
      if (r.Request_ID) out[String(r.Request_ID).toUpperCase()] = true;
      if (r.Ref) out[String(r.Ref).toUpperCase()] = true;
    });
    return out;
  }

  // Whole-token, case-insensitive match of ref inside free text (words are split on anything but letters and digits).
  function hasToken(text, ref) {
    var want = String(ref === null || ref === undefined ? '' : ref).toUpperCase();
    if (!want) return false;
    return String(text === null || text === undefined ? '' : text).split(/[^A-Za-z0-9]+/).some(function (t) { return t.toUpperCase() === want; });
  }

  // Upper-case sub code -> stored spelling, for every sale whose Sub_Code is a random ref. Built per call.
  function knownRandomRefs(state) {
    var out = {};
    (state.sales || []).forEach(function (s) { if (isRandomRef(s.Sub_Code)) out[String(s.Sub_Code).toUpperCase()] = s.Sub_Code; });
    return out;
  }

  // A random ref the owner's sales already use, found as a whole token in the Reference column or in the
  // "Ref: ..." part of the SMS. Unknown tokens, words, TrxIDs and amounts never match. Null when none.
  function findKnownRef(row, state) {
    var known = knownRandomRefs(state);
    var texts = [row && row.Reference];
    var m = /Ref(?:erence)?\.?\s*:?\s*([^\n]*)/i.exec(String((row && row.Raw_SMS) || ''));
    if (m) texts.push(m[1]);
    for (var i = 0; i < texts.length; i++) {
      var tokens = String(texts[i] || '').split(/[^A-Za-z0-9]+/);
      for (var j = 0; j < tokens.length; j++) {
        if (isRandomRef(tokens[j]) && known[tokens[j].toUpperCase()]) return known[tokens[j].toUpperCase()];
      }
    }
    return null;
  }

  function subCodeLine(state, code) {
    var want = String(code).toUpperCase();
    var rows = (state.sales || []).filter(function (s) { return String(s.Sub_Code).toUpperCase() === want; });
    var latest = null;
    rows.forEach(function (s) {
      if (s.Record_Status === 'Active' && (!latest || Number(s.Sale_ID) > Number(latest.Sale_ID))) latest = s;
    });
    return { latest: latest, rows: rows };
  }

  return { normalizeRef: normalizeRef, findRef: findRef, subCodeLine: subCodeLine,
    isRandomRef: isRandomRef, hasToken: hasToken, findKnownRef: findKnownRef, newRef: newRef, usedRefs: usedRefs, ALPHABET: ALPHABET, REF_LENGTH: REF_LENGTH };
})();
if (typeof module !== 'undefined') module.exports = Core.refs;

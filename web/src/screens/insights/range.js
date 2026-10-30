import util from '@/lib/util';

// Dates here are Dhaka calendar dates as 'YYYY-MM-DD' strings. All arithmetic goes through Core.util (UTC maths on the string), never
// through the browser's own time zone. Only the calendar widget needs Date objects, built and read with local getters so they round-trip.

/** True for a real calendar date like 2026-10-18 (rejects 2026-02-31). */
export const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && util.isoAddDays(v, 0) === v;

/** The four quick ranges, all ending today. Last 12 months starts 12 full months back, like the server default. */
export function presets(today) {
  const month = today.slice(0, 7) + '-01';
  return [
    { id: 'month', label: 'This month', from: month, to: today },
    { id: 'last3', label: 'Last 3 months', from: util.addMonths(month, -2), to: today },
    { id: 'last12', label: 'Last 12 months', from: util.addMonths(month, -12), to: today },
    { id: 'ytd', label: 'Year to date', from: today.slice(0, 4) + '-01-01', to: today }
  ];
}

/** The range kept in the URL hash (#/insights?from=...&to=...), or null when absent or not valid. */
export function readRange() {
  const h = window.location.hash;
  const q = h.indexOf('?');
  if (q < 0) return null;
  const p = new URLSearchParams(h.slice(q + 1));
  const from = p.get('from'), to = p.get('to');
  return isDate(from) && isDate(to) && from <= to ? { from, to } : null;
}

/** Puts the range in the hash as a new history entry, so Back returns to the previous range. */
export function writeRange(r) {
  window.history.pushState(null, '', '#/insights?from=' + r.from + '&to=' + r.to);
}

export const toDate = iso => { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
export const fromDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10' -> 'Oct' (or 'Oct 26' when the range crosses years). */
export const monthShort = (m, withYear) => (MONTHS[Number(m.slice(5, 7)) - 1] || m) + (withYear ? ' ' + m.slice(2, 4) : '');
/** '2026-10' -> 'Oct 2026'. */
export const monthTitle = m => (MONTHS[Number(m.slice(5, 7)) - 1] || m) + ' ' + m.slice(0, 4);

/** Axis amounts: 950, 12k, 1.5k, 2M. */
export function compact(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  const f = (x, s) => String(parseFloat(x.toFixed(1))) + s;
  return (v < 0 ? '−' : '') + (a >= 1e6 ? f(a / 1e6, 'M') : a >= 1e3 ? f(a / 1e3, 'k') : String(Math.round(a)));
}

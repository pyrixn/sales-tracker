// Display helpers shared by every screen.
let whole = null;
let fraction = null;
try {
  whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  fraction = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
} catch (e) { /* plain String() below */ }

/** Taka: whole amounts show no decimals, fractions always two, negatives use a real minus sign. */
export function tk(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const f = Number.isInteger(v) ? whole : fraction;
  const a = Math.abs(v);
  return (v < 0 ? '−' : '') + '৳' + (f ? f.format(a) : String(a));
}

/** Number without the currency sign, for big display figures. */
export function plain(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const f = Number.isInteger(v) ? whole : fraction;
  return f ? f.format(Math.abs(v)) : String(Math.abs(v));
}

export function productShort(name) { return String(name || '').split(' ')[0]; }

export function initials(name) {
  // First letter or digit of the first two words; punctuation such as "(" never becomes an initial.
  const parts = String(name || '').split(/\s+/).map(w => (w.match(/[\p{L}\p{N}]/u) || [''])[0]).filter(Boolean);
  return ((parts[0] || '?') + (parts[1] || '')).toUpperCase();
}

/** Stable 0..4 tint per name, so a customer keeps the same avatar colour everywhere. */
export function hue(name) {
  const s = String(name || '?').trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 5;
  return h;
}

/** Days left on a line -> { tone, text } for a Pill. Colour is never the only signal. */
export function daysTone(d) {
  if (d === null || d === undefined) return { tone: 'muted', text: 'no date' };
  if (d < 0) return { tone: 'bad', text: 'expired ' + (-d) + 'd' };
  if (d === 0) return { tone: 'warn', text: 'today' };
  if (d <= 3) return { tone: 'warn', text: 'in ' + d + 'd' };
  if (d <= 7) return { tone: 'warn', text: d + ' days' };
  return { tone: 'ok', text: d + ' days' };
}

/** lookups.rate -> the one-line label shown on Profit, Settings and the calculator. */
export function rateText(r) {
  if (!r || !r.rate) return 'No rate';
  const how = r.source === 'manual' ? 'manual' : 'Bybit';
  let age = '';
  if (r.source === 'bybit' && r.fetchedAt) {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(r.fetchedAt)) / 60000));
    age = ' · ' + (m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago');
  }
  return '৳' + r.rate + ' / USDT · ' + how + age + (r.stale ? ' · stale' : '');
}

export function longDate(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
export function shortDate(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function fullDate(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "12.5" / "1,200" / "৳1,200" -> number, null when blank. Throws a readable error otherwise. */
export function num(v, label) {
  if (String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,৳\s]/g, ''));
  if (!isFinite(n)) throw new Error(label + ' must be a number.');
  return n;
}

/** Link a customer opens to pay one line. base is the pay page host. */
export function payUrl(base, token) {
  return String(base).replace(/\/+$/, '') + '/pay/' + encodeURIComponent(token);
}
/** The message sent with a pay link (English or Bangla). */
export function payText(lang, name, product, url) {
  return lang === 'bn'
    ? 'হ্যালো ' + name + ', ' + product + ' এর পেমেন্ট এই লিংকে করুন: ' + url
    : 'Hi ' + name + ', you can pay for ' + product + ' here: ' + url;
}

export const METHODS = ['bKash', 'Nagad', 'Upay', 'Cash', 'Bank', 'Other'];
export const CHANNELS = ['WhatsApp', 'Messenger', 'Discord', 'Phone', 'Other'];

/** wa.me link for a customer whose contact is a WhatsApp number (Bangladesh numbers get the 880 prefix). */
export function whatsappLink(channel, handle) {
  if (channel !== 'WhatsApp') return '';
  let d = String(handle || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('01')) d = '88' + d;
  return 'https://wa.me/' + d;
}

/** Spreadsheet formula guard: the same rule as the server's Core.exporter.safeCell (src/core/exporter.js). A string whose first
 *  non-blank character is = + - @, or that starts with TAB or CR, gets a leading apostrophe. Numbers and other values pass through. */
export function csvSafe(v) {
  return typeof v === 'string' && /^(?:[\t\r]|\s*[=+\-@])/.test(v) ? "'" + v : v;
}

/** Rows -> CSV text (quotes doubled; cells pass through csvSafe so a sheet cannot run a formula). */
export function toCsv(header, rows) {
  const cell = v => '"' + String(csvSafe(v === null || v === undefined ? '' : v)).replace(/"/g, '""') + '"';
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
}

// Times. Inbox rows store the Dhaka wall clock as "YYYY-MM-DD HH:MM" with no zone; API timestamps are ISO. Both read as Dhaka time here,
// the zone the rest of the app uses (the same as the Dhaka date in api.js).
const DHAKA_OFFSET = '+06:00';
let dhakaExact = null, dhakaDay = null, dhakaKeyFmt = null, dhakaClockFmt = null;
try {
  dhakaExact = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  dhakaDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
  dhakaKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
  dhakaClockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
} catch (e) { /* plain text below */ }

/** The Dhaka calendar day of a stamp as YYYY-MM-DD ('' when unreadable). Groups the Activity timeline by day. */
export function dhakaDate(v) {
  const ms = timeMs(v);
  if (!isFinite(ms) || !dhakaKeyFmt) return '';
  return dhakaKeyFmt.format(new Date(ms));
}

/** The Dhaka clock time of a stamp, 09:30 ('' when unreadable). */
export function dhakaClock(v) {
  const ms = timeMs(v);
  if (!isFinite(ms) || !dhakaClockFmt) return '';
  return dhakaClockFmt.format(new Date(ms));
}

/** Milliseconds for an inbox stamp ("2026-10-25 09:30", Dhaka) or an ISO stamp. NaN when it is blank or unreadable. */
export function timeMs(v) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (naive) return Date.parse(naive[1] + 'T' + naive[2] + (naive[3] || ':00') + DHAKA_OFFSET);
  return Date.parse(s);
}

/** Relative time: "just now", "30 min ago", "3 h ago", "2 days ago", then the Dhaka date. A future time reads "in 40 min" / "in 2 h". */
export function relTime(v, nowMs) {
  const ms = timeMs(v);
  if (!isFinite(ms)) return String(v || '');
  const diff = (Number(nowMs) || Date.now()) - ms;
  const future = diff < 0;
  const mins = Math.floor(Math.abs(diff) / 60000);
  if (mins < 1) return 'just now';
  if (future && mins >= 60 * 24 * 7) return dhakaDay ? dhakaDay.format(new Date(ms)) : String(v);
  const body = mins < 60 ? mins + ' min'
    : mins < 60 * 24 ? Math.floor(mins / 60) + ' h'
    : mins < 60 * 24 * 7 ? Math.floor(mins / 1440) + (Math.floor(mins / 1440) === 1 ? ' day' : ' days')
    : null;
  if (body === null) return dhakaDay ? dhakaDay.format(new Date(ms)) : String(v);
  return future ? 'in ' + body : body + ' ago';
}

/** The exact time for a title or tooltip: "25 Oct 2026, 09:30 Dhaka time". */
export function exactTime(v) {
  const ms = timeMs(v);
  if (!isFinite(ms) || !dhakaExact) return String(v || '');
  return dhakaExact.format(new Date(ms)) + ' Dhaka time';
}

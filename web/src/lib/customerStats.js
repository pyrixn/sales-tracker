// Figures and the timeline for the customer workspace. Built on the client from the `customer` read (history, payments, lines):
// no extra read. Reminders and deliveries are not in that read, so the timeline has sales and payments only.
import { tk } from '@/lib/format';

const VOIDED = ['Void', 'Refunded'];

/** Headline figures. Lifetime revenue is price x months over the lines that are not Void or Refunded. The read has no Qty, and every
 *  write path sets Qty to 1 (src/core/sales.js), so this equals Core.ledger.saleRevenue. avgLate is the mean of days past Paid till over the
 *  lines that still owe money (on-time owing lines count as 0); null when no owing line has a date. */
export function customerStats(d) {
  const live = d.history.filter(h => !VOIDED.includes(h.status));
  const lifetime = Math.round(live.reduce((a, h) => a + Math.round(Number(h.price || 0) * Number(h.months || 1) * 100) / 100, 0) * 100) / 100;
  const late = d.history.filter(h => h.owes > 0 && h.daysLeft !== null && h.daysLeft !== undefined).map(h => Math.max(0, -h.daysLeft));
  const avgLate = late.length ? Math.round(late.reduce((a, n) => a + n, 0) / late.length) : null;
  const firstSale = live.reduce((min, h) => (h.saleDate && (!min || h.saleDate < min) ? h.saleDate : min), '');
  return { lifetime, lines: d.lines.length, avgLate, firstSale };
}

/** One entry per sale (history) and per payment, newest first. Sales are placed by Sale_Date; an entry with no date goes last. */
export function customerTimeline(d) {
  const items = [];
  d.history.forEach(h => items.push({
    key: 'sale-' + h.saleId, kind: 'sale', date: h.saleDate || '',
    title: 'Sale #' + h.saleId + ' · ' + h.productName,
    detail: tk(h.price) + ' × ' + h.months + ' · ' + h.status
  }));
  d.payments.forEach(p => items.push({
    key: 'pay-' + p.paymentId, kind: 'payment', date: p.date || '',
    title: p.saleId === '' ? 'Payment · credit' : 'Payment on sale #' + p.saleId,
    detail: tk(p.amount) + (p.method ? ' · ' + p.method : '') + (p.trx ? ' · ' + p.trx : '')
  }));
  const order = { payment: 0, sale: 1 };
  items.sort((a, b) => {
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return order[a.kind] - order[b.kind] || b.key.localeCompare(a.key, undefined, { numeric: true });
  });
  return items;
}

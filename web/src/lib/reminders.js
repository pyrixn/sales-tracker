import { call, rid } from '@/lib/api';

/** Records that a reminder was sent or skipped, so it leaves the list and is not repeated. */
export function markReminder(it, status) {
  return call('remindSent', {
    requestId: rid(), saleId: it.saleId, customerId: it.customerId, kind: it.kind, channel: it.channel, status
  });
}

/**
 * The text for a bulk copy: one block per customer, a "--- Name ---" line and that customer's messages, a blank line between messages
 * and between customers. rows: [{ customerId, name, message }] in the order shown.
 */
export function reminderBlocks(rows) {
  const groups = new Map();
  rows.forEach(r => {
    const k = String(r.customerId);
    if (!groups.has(k)) groups.set(k, { name: r.name, messages: [] });
    groups.get(k).messages.push(r.message);
  });
  return Array.from(groups.values()).map(g => '--- ' + g.name + ' ---\n' + g.messages.join('\n\n')).join('\n\n');
}

/**
 * Records each reminder as sent or skipped, one request at a time, each with its own request id. Stops at the first failure.
 * Resolves to { marked: the items recorded, in order, error: the first failure's message or '' }.
 */
export async function markReminders(items, status) {
  const marked = [];
  let error = '';
  for (const x of items) {
    const r = await markReminder(x, status);
    if (!r.ok) { error = r.error || 'Could not mark as ' + (status === 'skipped' ? 'skipped' : 'sent') + '.'; break; }
    marked.push(x);
  }
  return { marked, error };
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  return Promise.resolve(false);
}

export const REMINDER_LABEL = {
  before: () => 'ends soon',
  on_day: () => 'ends today',
  after: () => 'expired',
  due: (it, tk) => 'owes ' + tk(it.amount)
};

/** Variables a template can use, in the order the chips show them. */
export const TEMPLATE_VARS = ['name', 'product', 'profile', 'months', 'amount', 'date', 'days', 'price', 'balance', 'status', 'link', 'ref', 'bkash', 'nolink'];
export const TEMPLATE_MAX = 1500;

/** Sample values for the live preview. They are not read from any real sale. */
export const SAMPLE_VARS = {
  name: 'Fahim', product: 'Spotify Premium', profile: 'Profile 2', months: '1 month', amount: '৳290', date: '2026-10-25', days: '1', price: '৳290', balance: '৳0',
  status: 'expires in 1 day', link: 'https://…/pay/…', ref: 'nubnf3', bkash: '01XXXXXXXXX', nolink: ''
};

/** Fills a template with sample values. Unknown {words} stay as typed; {nolink} renders as nothing. */
export function previewTemplate(text, vars = SAMPLE_VARS) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

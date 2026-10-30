import { useMemo } from 'react';
import { useApp } from '@/lib/store';

// The "needs attention" counts behind the header bell (uplift 4.6). Each item is a count the owner has to act on, and `tab` is the
// screen that handles it. Zero counts are left out. The wording and the counts match Today's AttentionStrip, which can read this
// list too. The stock item (uplift 4.8) counts the home read's stock alerts, one per product or account.
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/** Pure: the attention items for a home read, in the order the bell shows them. */
export function attentionItems(home) {
  if (!home) return [];
  const a = home.attention || {};
  const expiringToday = (home.renewSoon || []).filter(r => r.daysLeft === 0).length;
  const stock = (home.stock || []).length;
  const items = [
    { id: 'payments', label: plural(a.payments || 0, 'payment to match', 'payments to match'), count: a.payments || 0, tab: 'today' },
    { id: 'expiring', label: plural(expiringToday, 'line expires today', 'lines expire today'), count: expiringToday, tab: 'today' },
    { id: 'paylinks', label: plural(a.payLinks || 0, 'pay link expiring within 6 hours', 'pay links expiring within 6 hours'), count: a.payLinks || 0, tab: 'paylinks' },
    { id: 'deliveries', label: plural(a.deliveries || 0, 'delivery pending or failed', 'deliveries pending or failed'), count: a.deliveries || 0, tab: 'delivery' },
    { id: 'budgets', label: plural(a.budgets || 0, 'budget near or over its limit', 'budgets near or over their limit'), count: a.budgets || 0, tab: 'money' },
    { id: 'stock', label: plural(stock, 'stock or capacity alert', 'stock and capacity alerts'), count: stock, tab: 'accounts' }
  ];
  return items.filter(it => it.count > 0);
}

export function useAttentionItems() {
  const { home } = useApp();
  return useMemo(() => attentionItems(home), [home]);
}

// Unread state lives in localStorage as { [item id]: the count the owner last saw }. An item is unread while its count differs from
// that, so a count that changes re-lights the item. Every access is guarded: when storage throws, nothing is ever marked read.
const SEEN_KEY = 'sales_tracker_attention_seen';
export function readSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
/** Opening the bell marks the items on screen as read. Items that are gone are dropped from the store. */
export function markSeen(items) {
  const seen = {};
  items.forEach(it => { seen[it.id] = it.count; });
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* storage unavailable: the items stay unread */ }
}
export const isUnread = (seen, it) => seen[it.id] !== it.count;

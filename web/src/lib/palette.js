// Records the command palette can open, found by the text typed. Plain data (no React) so it can be tested directly.
// Everything searched is data the panel already has (lookups and home); nothing here calls the server.
export const MIN_QUERY = 3;
export const LIMIT = 150;

/** Customers (name, handle), sub-codes and payment transaction ids that contain the query. Under MIN_QUERY nothing matches. */
export function recordMatches(query, data) {
  const needle = String(query || '').trim().toLowerCase();
  const none = { customers: [], subCodes: [], transactions: [] };
  if (needle.length < MIN_QUERY) return none;
  const hit = v => String(v || '').toLowerCase().includes(needle);
  const d = data || {};
  const customers = (d.customers || []).filter(c => hit(c.name) || hit(c.handle)).slice(0, LIMIT);
  const subCodes = (d.lines || []).filter(l => hit(l.subCode)).slice(0, LIMIT);
  const pending = (d.unmatched || []).filter(u => hit(u.trx)).map(u => ({ trx: u.trx, amount: u.amount, pending: true, customerId: '' }));
  const auto = (d.autoToCheck || []).filter(a => hit(a.trx)).map(a => ({ trx: a.trx, amount: a.amount, pending: false, customerId: a.customerId }));
  return { customers, subCodes, transactions: pending.concat(auto).slice(0, LIMIT) };
}

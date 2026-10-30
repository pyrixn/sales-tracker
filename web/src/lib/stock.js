// Stock and capacity alerts (uplift 4.8). The server computes them (Core.views.stockAlerts, in home.stock): one entry per product
// (code_low) or per account (account_full, account_renewing). This file only groups them into chips for the Today strip and the bell.
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/** Pure: one chip per alert kind that has alerts, in a fixed order, with the number of alerts of that kind and its wording. */
export function stockChips(stock) {
  const list = stock || [];
  return [
    { kind: 'code_low', word: n => plural(n, 'product low on codes', 'products low on codes') },
    { kind: 'account_full', word: n => plural(n, 'account with no free slot', 'accounts with no free slot') },
    { kind: 'account_renewing', word: n => plural(n, 'account renewing within 5 days', 'accounts renewing within 5 days') }
  ].map(c => { const count = list.filter(s => s.kind === c.kind).length; return { kind: c.kind, count, label: c.word(count) }; })
    .filter(c => c.count > 0);
}

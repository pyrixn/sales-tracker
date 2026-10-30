/** Category > Product > Variant grouping for lookups.products (same shape as Core.tree.build). Pure. */
// Same comparison as Core.tree (lower-cased, UTF-16 code-unit order), so panel and server agree.
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const byName = (a, b) => cmp(String(a.name).toLowerCase(), String(b.name).toLowerCase());

export function buildTree(products) {
  const list = products || [];
  const ids = new Set(list.map(p => p.id));
  const kids = new Map();
  list.forEach(p => {
    if (p.parentId && ids.has(p.parentId)) {
      if (!kids.has(p.parentId)) kids.set(p.parentId, []);
      kids.get(p.parentId).push(p);
    }
  });
  const cats = new Map();
  list.forEach(p => {
    if (p.parentId && ids.has(p.parentId)) return;
    const c = p.category || '';
    if (!cats.has(c)) cats.set(c, []);
    cats.get(c).push({ product: p, variants: (kids.get(p.id) || []).slice().sort(byName) });
  });
  return Array.from(cats.keys()).sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()))
    .map(c => ({ category: c, products: cats.get(c).sort((a, b) => byName(a.product, b.product)) }));
}

/** Core.tree: groups products as Category > Product > Variant (depth max 3). Pure. */
var Core = Core || {};
Core.tree = (function () {
  function byName(a, b) { var x = String(a.Product_Name).toLowerCase(), y = String(b.Product_Name).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }

  /** -> [{category, products: [{product, variants: [product]}]}]; categories A-Z, products and variants by name. */
  function build(products) {
    var list = products || [], ids = {};
    list.forEach(function (p) { ids[p.Product_ID] = true; });
    var kids = {};
    list.forEach(function (p) { if (p.Parent_ID && ids[p.Parent_ID]) (kids[p.Parent_ID] = kids[p.Parent_ID] || []).push(p); });
    var cats = {};
    list.forEach(function (p) {
      if (p.Parent_ID && ids[p.Parent_ID]) return;
      var c = p.Category || '';
      (cats[c] = cats[c] || []).push({ product: p, variants: (kids[p.Product_ID] || []).slice().sort(byName) });
    });
    return Object.keys(cats).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0; })
      .map(function (c) { return { category: c, products: cats[c].sort(function (a, b) { return byName(a.product, b.product); }) }; });
  }

  return { build: build };
})();
if (typeof module !== 'undefined') module.exports = Core.tree;

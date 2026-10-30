const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');
const { appendOf, ok } = require('./helpers');

const S = () => Core.sales;
const sub = { cycleDays: 30, accountCost: 100, slots: 4, price: 50 };

test('custom category with deliversAs code saves', () => {
  const m = makeMigratedState();
  const r = ok(S().planProduct(m, { name: 'Valorant', category: 'Game top-up', deliversAs: 'code', letter: 'VP', price: 500 }));
  const v = appendOf(r, 'Product_Catalog').values;
  assert.deepEqual([v.Category, v.Delivers_As, v.Letter, v.Parent_ID, v.Product_ID], ['Game top-up', 'code', 'VP', '', 'VALORANT']);
  assert.equal(v.Code_Unit_Cost, 0);
});

test('category must be 1-40 chars; deliversAs must be account or code', () => {
  const m = makeMigratedState();
  assert.equal(S().planProduct(m, { name: 'Z1', category: '', deliversAs: 'code', letter: 'Z', price: 1 }).errors.length, 1);
  assert.equal(S().planProduct(m, { name: 'Z1', category: 'x'.repeat(41), deliversAs: 'code', letter: 'Z', price: 1 }).errors.length, 1);
  assert.equal(S().planProduct(m, { name: 'Z1', category: 'Misc', deliversAs: 'both', letter: 'Z', price: 1 }).errors.length, 1);
});

test('blank productId derives from name; typed productId is used', () => {
  const m = makeMigratedState();
  let r = ok(S().planProduct(m, { name: 'Disney+', category: 'Streaming', deliversAs: 'account', letter: 'D', price: 1, ...sub }));
  assert.equal(r.result.productId, 'DISNEY');
  r = ok(S().planProduct(m, { name: 'Disney+', productId: 'DSN2', category: 'Streaming', deliversAs: 'account', letter: 'D', price: 1, ...sub }));
  assert.equal(r.result.productId, 'DSN2');
  assert.equal(appendOf(r, 'Product_Catalog').values.Product_ID, 'DSN2');
  assert.equal(S().planProduct(m, { name: 'Disney+', productId: 'ds-n', category: 'Streaming', deliversAs: 'account', letter: 'D', price: 1, ...sub }).errors.length, 1);
});

test('duplicate productId rejected', () => {
  const m = makeMigratedState();
  const r = S().planProduct(m, { name: 'Other', productId: 'NETFLIX', category: 'Streaming', deliversAs: 'account', letter: 'Q', price: 1, ...sub });
  assert.deepEqual(r.errors, ['A product NETFLIX already exists.']);
});

test('multi-letter prefix: VP ok, V and VP coexist, duplicate VP rejected', () => {
  const m = makeMigratedState();
  const a = { category: 'Game top-up', deliversAs: 'code', price: 5 };
  ok(S().planProduct(m, { ...a, name: 'Vee', letter: 'V' }));
  const m2 = { ...m, products: m.products.concat([{ Product_ID: 'VEE', Product_Name: 'Vee', Category: 'Game top-up', Delivers_As: 'code', Letter: 'V' }]) };
  const r = ok(S().planProduct(m2, { ...a, name: 'Valo', letter: 'vp' }));
  assert.equal(appendOf(r, 'Product_Catalog').values.Letter, 'VP');
  const m3 = { ...m2, products: m2.products.concat([{ Product_ID: 'VALO', Product_Name: 'Valo', Category: 'Game top-up', Delivers_As: 'code', Letter: 'VP' }]) };
  assert.deepEqual(S().planProduct(m3, { ...a, name: 'Other', letter: 'VP' }).errors, ['Letter VP is already used by VALO.']);
  assert.equal(S().planProduct(m, { ...a, name: 'Four', letter: 'ABCD' }).errors.length, 1);
});

test('G is shared between code products, but not with account products', () => {
  const m = { ...makeMigratedState() };
  m.products = m.products.concat([{ Product_ID: 'GAMEA', Product_Name: 'GameA', Category: 'Game Code', Letter: 'G' }]);
  assert.equal(S().planProduct(m, { name: 'NewGame', category: 'Game Code', deliversAs: 'code', letter: 'G', price: 5 }).errors.length, 0);
  assert.equal(S().planProduct(m, { name: 'NewSub', category: 'Subscription', deliversAs: 'account', letter: 'G', price: 5, ...sub }).errors.length, 1);
});

test('parentId: must be existing top-level product; variants cannot have variants', () => {
  const m = makeMigratedState();
  const base = { category: 'Streaming', deliversAs: 'account', price: 1, ...sub };
  assert.equal(S().planProduct(m, { ...base, name: 'Nf Premium', letter: 'Q', parentId: 'NOPE' }).errors.length, 1);
  const r = ok(S().planProduct(m, { ...base, name: 'Nf Premium', letter: 'Q', parentId: 'NETFLIX' }));
  assert.equal(appendOf(r, 'Product_Catalog').values.Parent_ID, 'NETFLIX');
  const m2 = { ...m, products: m.products.concat([{ Product_ID: 'NFP', Product_Name: 'Nf Premium', Category: 'Streaming', Letter: 'Q', Parent_ID: 'NETFLIX' }]) };
  assert.equal(S().planProduct(m2, { ...base, name: 'Deeper', letter: 'R', parentId: 'NFP' }).errors.length, 1);
});

test('planEditProduct edits name, category, price, parent; guards depth and clashes', () => {
  const m = makeMigratedState();
  const first = m.products[0].Product_ID;
  const r = ok(S().planEditProduct(m, { productId: first, name: 'Renamed X', category: 'New cat', price: 99 }));
  assert.deepEqual(r.ops[0].values, { Product_Name: 'Renamed X', Category: 'New cat', Default_Price: 99 });
  assert.equal(S().planEditProduct(m, { productId: 'NOPE' }).errors.length, 1);
  assert.equal(S().planEditProduct(m, { productId: first, category: '' }).errors.length, 1);
  assert.equal(S().planEditProduct(m, { productId: first, parentId: first }).errors.length, 1);
  const other = m.products[1].Product_ID;
  assert.equal(S().planEditProduct(m, { productId: first, name: m.products[1].Product_Name }).errors.length, 1);
  const withKid = { ...m, products: m.products.map(p => p.Product_ID === other ? { ...p, Parent_ID: first } : p) };
  assert.equal(S().planEditProduct(withKid, { productId: first, parentId: m.products[2].Product_ID }).errors.length, 1);
  assert.equal(S().planEditProduct(m, { productId: first, parentId: 'NOPE' }).errors.length, 1);
  ok(S().planEditProduct(m, { productId: first, parentId: other }));
  ok(S().planEditProduct(withKid, { productId: other, parentId: '' }));
});

test('deliversAs reads field, falls back to Game Code category', () => {
  assert.equal(S().deliversAs({ Category: 'Game Code' }), 'code');
  assert.equal(S().deliversAs({ Category: 'Subscription' }), 'account');
  assert.equal(S().deliversAs({ Category: 'Game Code', Delivers_As: 'account' }), 'account');
  assert.equal(S().deliversAs({ Category: 'Game top-up', Delivers_As: 'code' }), 'code');
});

test('planNewSale on a custom-category code product demands a code', () => {
  const m = makeMigratedState();
  const prods = m.products.concat([{ Product_ID: 'VALO', Product_Name: 'Valo', Category: 'Game top-up', Delivers_As: 'code', Letter: 'VP', Default_Price: 5 }]);
  const r = S().planNewSale({ ...m, products: prods }, { productId: 'VALO', newCustomer: { name: 'Zed' } });
  assert.deepEqual(r.errors, ['Pick a code.']);
});

test('lookups expose category, deliversAs, parentId', () => {
  const m = makeMigratedState();
  const l = Core.views.lookups({ ...m, products: m.products.concat([{ Product_ID: 'VALO', Product_Name: 'Valo', Category: 'Game top-up', Delivers_As: 'code', Parent_ID: 'NETFLIX', Letter: 'VP' }]) });
  const v = l.products.find(p => p.id === 'VALO');
  assert.deepEqual([v.category, v.deliversAs, v.parentId], ['Game top-up', 'code', 'NETFLIX']);
});

test('Core.tree.build groups by category, sorts, nests variants', () => {
  const P = (id, name, cat, parent) => ({ Product_ID: id, Product_Name: name, Category: cat, Parent_ID: parent || '' });
  const t = Core.tree.build([P('B', 'Beta', 'Zed'), P('A2', 'Alpha 2', 'Zed', 'A'), P('A', 'Alpha', 'Zed'), P('C', 'Gamma', 'Apple'), P('A1', 'Alpha 1', 'Zed', 'A')]);
  assert.deepEqual(t.map(c => c.category), ['Apple', 'Zed']);
  assert.deepEqual(t[1].products.map(x => x.product.Product_ID), ['A', 'B']);
  assert.deepEqual(t[1].products[0].variants.map(v => v.Product_ID), ['A1', 'A2']);
  assert.deepEqual(t[1].products[1].variants, []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { ok } = require('./helpers');

function base(extra) {
  return Object.assign({
    today: '2026-10-15',
    settings: { money_layout: 'net,trend' },
    products: [{ Product_ID: 'NF', Product_Name: 'Netflix', Category: 'Subscription', Default_Price: 500, Unit_Cost: 0, Active: 'Yes' }],
    customers: [{ Customer_ID: 'CU-0001', Name: 'A', Created: '2026-10-03' }, { Customer_ID: 'CU-0002', Name: 'B', Created: '2026-09-03' }],
    sales: [
      { Sale_ID: 1, Customer_ID: 'CU-0001', Product_ID: 'NF', Sale_Date: '2026-10-02', Unit_Price: 4000, Months: 1, Qty: 1, Cost_Snapshot: 1500, Record_Status: 'Active' },
      { Sale_ID: 2, Customer_ID: 'CU-0001', Product_ID: 'NF', Sale_Date: '2026-09-02', Unit_Price: 900, Months: 1, Qty: 1, Cost_Snapshot: 100, Record_Status: 'Active' },
      { Sale_ID: 3, Customer_ID: 'CU-0001', Product_ID: 'NF', Sale_Date: '2026-10-04', Unit_Price: 700, Months: 1, Qty: 1, Cost_Snapshot: 0, Record_Status: 'Void' }],
    payments: [
      { Payment_ID: 'PM-00001', Date: '2026-10-03', Customer_ID: 'CU-0001', Sale_ID: 1, Amount: 4000, Method: 'bKash', Source: 'Manual' },
      { Payment_ID: 'PM-00002', Date: '2026-10-04', Customer_ID: 'CU-0001', Sale_ID: 1, Amount: 999, Method: '', Source: 'Credit' },
      { Payment_ID: 'PM-00003', Date: '2026-08-04', Customer_ID: 'CU-0001', Sale_ID: 2, Amount: 777, Method: 'bKash', Source: 'Manual' }],
    expenses: [], purchases: [], goals: [], budgets: [], accounts: [], suppliers: [], codes: [], wallets: []
  }, extra || {});
}
const goalIn = o => Object.assign({ title: 'Oct', metric: 'revenue', target: 10000, start: '2026-10-01', end: '2026-10-31' }, o);

test('goal revenue 10000 target with 4000 sold in range -> pct 40', () => {
  const g = { Goal_ID: 'G1', Metric: 'revenue', Target: 10000, Start: '2026-10-01', End: '2026-10-31', Status: 'Active' };
  const p = Core.money.goalProgress(base(), g);
  assert.equal(p.current, 4000);
  assert.equal(p.pct, 40);
  assert.equal(p.remaining, 6000);
  assert.equal(p.daysLeft, 16);
});

test('goal metrics: profit, collected (no Credit rows), new_customers', () => {
  const s = base(), mk = m => ({ Goal_ID: 'G', Metric: m, Target: 100, Start: '2026-10-01', End: '2026-10-31' });
  assert.equal(Core.money.goalProgress(s, mk('profit')).current, 2500);
  assert.equal(Core.money.goalProgress(s, mk('collected')).current, 4000);
  assert.equal(Core.money.goalProgress(s, mk('new_customers')).current, 1);
});

test('goal in the past reports daysLeft 0; target 0 never divides by zero', () => {
  const past = Core.money.goalProgress(base(), { Metric: 'revenue', Target: 10000, Start: '2026-08-01', End: '2026-08-31' });
  assert.equal(past.daysLeft, 0);
  assert.equal(past.onTrack, false);
  const z = Core.money.goalProgress(base(), { Metric: 'revenue', Target: 0, Start: '2026-10-01', End: '2026-10-31' });
  assert.equal(z.pct, 0);
  assert.ok(Number.isFinite(z.remaining));
});

test('goal pct may exceed 100 and onTrack is true when target met', () => {
  const p = Core.money.goalProgress(base(), { Metric: 'revenue', Target: 2000, Start: '2026-10-01', End: '2026-10-31' });
  assert.equal(p.pct, 200);
  assert.equal(p.remaining, 0);
  assert.equal(p.onTrack, true);
});

test('budget: 850 of 1000 warns at default 80; 1001 is over; none spent is ok', () => {
  const b = { Budget_ID: 'B1', Category: 'Tools', Monthly_Limit: 1000, Alert_Pct: 80, Active: 'Yes' };
  const exp = a => [{ Expense_ID: 'EX-0001', Date: '2026-10-05', Category: 'Tools', Amount: a }, { Expense_ID: 'EX-0002', Date: '2026-09-05', Category: 'Tools', Amount: 5000 },
    { Expense_ID: 'EX-0003', Date: '2026-10-06', Category: 'Ads', Amount: 5000 }];
  let p = Core.money.budgetProgress(base({ expenses: exp(850) }), b, '2026-10');
  assert.deepEqual([p.spent, p.limit, p.pct, p.state], [850, 1000, 85, 'warn']);
  p = Core.money.budgetProgress(base({ expenses: exp(1001) }), b, '2026-10');
  assert.equal(p.state, 'over'); assert.ok(p.pct > 100);
  p = Core.money.budgetProgress(base({ expenses: exp(100) }), b, '2026-10');
  assert.equal(p.state, 'ok');
  p = Core.money.budgetProgress(base(), b, '2026-10');
  assert.deepEqual([p.spent, p.pct, p.state], [0, 0, 'ok']);
});

test('Account purchases budget reads Purchases', () => {
  const b = { Category: 'Account purchases', Monthly_Limit: 1000, Alert_Pct: 80 };
  const s = base({ purchases: [{ Purchase_ID: 'P-0001', Date: '2026-10-02', Amount: 600 }, { Purchase_ID: 'P-0002', Date: '2026-10-02', Amount: 900, Notes: 'Opening balance' }] });
  assert.equal(Core.money.budgetProgress(s, b, '2026-10').spent, 600);
});

test('planGoal appends G1, validates', () => {
  const r = ok(Core.sales.planGoal(base(), goalIn({ note: ' x ' })));
  assert.deepEqual(r.ops[0], { op: 'append', tab: 'Goals', values: { Goal_ID: 'G1', Title: 'Oct', Metric: 'revenue', Target: 10000, Start: '2026-10-01', End: '2026-10-31', Note: 'x', Status: 'Active' } });
  assert.equal(Core.sales.planGoal(base({ goals: [{ Goal_ID: 'G4' }, { Goal_ID: 'G2' }] }), goalIn()).ops[0].values.Goal_ID, 'G5');
  assert.ok(Core.sales.planGoal(base(), goalIn({ target: 0 })).errors.length);
  assert.ok(Core.sales.planGoal(base(), goalIn({ target: -5 })).errors.length);
  assert.ok(Core.sales.planGoal(base(), goalIn({ end: '2026-09-30' })).errors.length);
  assert.equal(Core.sales.planGoal(base(), goalIn({ end: '2026-10-01' })).errors.length, 0);
  assert.ok(Core.sales.planGoal(base(), goalIn({ metric: 'vibes' })).errors.length);
  assert.ok(Core.sales.planGoal(base(), goalIn({ title: ' ' })).errors.length);
  assert.ok(Core.sales.planGoal(base(), goalIn({ start: 'nope' })).errors.length);
  assert.ok(Core.sales.planGoal(base(), goalIn({ status: 'Weird' })).errors.length);
});

test('planGoal edits existing and planDeleteGoal clears', () => {
  const s = base({ goals: [{ Goal_ID: 'G1', Title: 'Old', Metric: 'revenue', Target: 1, Start: '2026-10-01', End: '2026-10-31', Note: '', Status: 'Active' }] });
  const r = ok(Core.sales.planGoal(s, goalIn({ goalId: 'G1', status: 'Done' })));
  assert.equal(r.ops[0].op, 'update'); assert.equal(r.ops[0].id, 'G1'); assert.equal(r.ops[0].values.Status, 'Done');
  assert.ok(Core.sales.planGoal(s, goalIn({ goalId: 'G9' })).errors.length);
  assert.deepEqual(ok(Core.sales.planDeleteGoal(s, { goalId: 'G1' })).ops, [{ op: 'clear', tab: 'Goals', id: 'G1' }]);
  assert.ok(Core.sales.planDeleteGoal(s, { goalId: 'G9' }).errors.length);
});

test('planBudget validates category, limit, duplicates', () => {
  const bi = o => Object.assign({ category: 'Tools', monthlyLimit: 1000 }, o);
  const r = ok(Core.sales.planBudget(base(), bi()));
  assert.deepEqual(r.ops[0].values, { Budget_ID: 'B1', Category: 'Tools', Monthly_Limit: 1000, Alert_Pct: 80, Active: 'Yes' });
  ok(Core.sales.planBudget(base(), bi({ category: 'Account purchases' })));
  assert.ok(Core.sales.planBudget(base(), bi({ category: 'Rent' })).errors.length);
  assert.ok(Core.sales.planBudget(base(), bi({ monthlyLimit: 0 })).errors.length);
  assert.ok(Core.sales.planBudget(base(), bi({ monthlyLimit: 1000000 })).errors.length);
  ok(Core.sales.planBudget(base(), bi({ monthlyLimit: 999999 })));
  assert.ok(Core.sales.planBudget(base(), bi({ alertPct: 0 })).errors.length);
  assert.ok(Core.sales.planBudget(base(), bi({ alertPct: 101 })).errors.length);
  const s = base({ budgets: [{ Budget_ID: 'B1', Category: 'Tools', Monthly_Limit: 5, Alert_Pct: 80, Active: 'Yes' }, { Budget_ID: 'B2', Category: 'Ads', Monthly_Limit: 5, Alert_Pct: 80, Active: 'No' }] });
  assert.ok(/already/i.test(Core.sales.planBudget(s, bi()).errors[0]));
  ok(Core.sales.planBudget(s, bi({ category: 'Ads' })));
  const e = ok(Core.sales.planBudget(s, bi({ budgetId: 'B1', monthlyLimit: 2000 })));
  assert.equal(e.ops[0].op, 'update'); assert.equal(e.ops[0].values.Monthly_Limit, 2000);
  assert.equal(Core.sales.planBudget(s, bi({ category: 'Other' })).ops[0].values.Budget_ID, 'B3');
  assert.deepEqual(ok(Core.sales.planDeleteBudget(s, { budgetId: 'B2' })).ops, [{ op: 'clear', tab: 'Budgets', id: 'B2' }]);
  assert.ok(Core.sales.planDeleteBudget(s, { budgetId: 'B9' }).errors.length);
});

test('planLayout drops unknown ids, de-dupes, keeps order, writes the setting', () => {
  const r = ok(Core.sales.planLayout(base(), { widgets: ['dues', 'bogus', 'net', 'dues', 'goals'] }));
  assert.deepEqual(r.ops, [{ op: 'update', tab: 'Settings', key: 'Key', id: 'money_layout', values: { Value: 'dues,net,goals' } }]);
  assert.ok(Core.sales.planLayout(base(), { widgets: 'net' }).errors.length);
  assert.equal(ok(Core.sales.planLayout(base(), { widgets: [] })).ops[0].values.Value, '');
});

test('WIDGETS registry and DEFAULT_LAYOUT', () => {
  assert.deepEqual(Core.money.WIDGETS.map(w => w.id), ['net', 'trend', 'cash', 'dues', 'products', 'accounts', 'customers', 'forecast', 'expenses', 'goals', 'budgets']);
  Core.money.WIDGETS.forEach(w => { assert.ok(['sm', 'md', 'lg'].includes(w.size)); assert.ok(w.title && w.kind); });
  assert.deepEqual(Core.money.DEFAULT_LAYOUT, ['net', 'trend', 'cash', 'dues', 'products', 'forecast']);
});

test('id generators do not disturb each other', () => {
  const g = Core.ids.IdGen(base({ goals: [{ Goal_ID: 'G3' }], budgets: [{ Budget_ID: 'B7' }] }));
  assert.equal(g.goal(), 'G4'); assert.equal(g.budget(), 'B8'); assert.equal(g.sale(), 4); assert.equal(g.payment(), 'PM-00004');
});

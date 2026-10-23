# Admin Panel Implementation Plan

> **SUPERSEDED in part:** the Foundation decisions (`docs/superpowers/specs/2026-10-23-foundation-design.md`) override this plan. The due-reminder default is 5 days and the USDT-BDT rate is cached only in the `live_rates` table. Do not follow the 14-day or settings-cache instructions below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Sales Tracker admin panel to support AI accounts, multi-currency cost tracking, supplier management, gift-card bulk handling, profit dashboards, bi-weekly reminders, and multi-payment verification (bKash/Upay/Nagad).

**Architecture:** Extend existing Core modules (`src/core/*.js`) with new functions; add new tables via migration; extend Edge Function (`src/server/edge.js`) with new endpoints; extend UI (`src/ui/Index.html`) with new tabs and forms. All changes preserve existing behavior and tests.

**Tech Stack:** Vanilla JS (frontend), Supabase Edge Functions (Deno), PostgreSQL 17, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-23-admin-panel-design.md`

## Global Constraints

- All tables retain RLS with no public anon access.
- All monetary values stored as `numeric(12,2)` in BDT; USDT amounts stored separately.
- Exchange rate fetched at most every 5 min, cached in `settings` table.
- Supplier records must include `name`, `contact`, `currency` (USDT/BDT), and `default_markup_percent`.
- Gift-card codes may be bulk; `codes` table gains `batch_id` and `status` (`Available`, `Pending`, `Sold`).
- Payment verification supports `bKash`, `Upay`, `Nagad`.
- Reminder cadence: bi-weekly (every 14 days) for due reminders; `due_reminder_every_days` defaults to `14`.
- Per-product message templates: settings keys `msg_renew_<product_id>_en`, `msg_renew_<product_id>_bn`, etc.
- Live USDT→BDT rate from Bybit P2P API (`https://api.bybit.com/v5/market/tickers?category=linear&symbol=USDTBDT`).

## Review Focus

1. **Live rate fetch failure**: network timeout or Bybit API error → fallback to last cached rate; UI must show "rate stale" warning.
2. **Supplier-cost loop**: product points to nonexistent supplier → return error, do not crash.
3. **Bulk code batch creation**: batch size must match quantity; duplicate `code_id` must not occur.
4. **Multi-payment source handling**: Upay/Nagad webhook payload format differs from bKash → parse correctly or mark as `Review`.
5. **Margin calculation rounding**: use `Core.util.round2` consistently; test edge cases (0.005 rounds to 0.01).

---

### Task 1: Schema Migration — New Tables and Columns

**Files:**
- Create: `supabase/migrations/002_admin_panel_extensions.sql`
- Modify: `tools/ensure-schema.js` (add new DDL)

**Interfaces:**
- Consumes: existing schema (`products`, `sales`, `codes`, `payments`, `settings`).
- Produces: new tables `suppliers`, `live_rates`, `profit_snapshots`; new columns on `products`, `sales`, `codes`.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/002_admin_panel_extensions.sql`:

```sql
-- Suppliers
create table if not exists suppliers (
  supplier_id   text primary key,
  name          text not null,
  contact       text not null default '',
  currency      text not null default 'BDT',
  markup_percent numeric(5,2) not null default 0,
  notes         text not null default ''
);
create index if not exists suppliers_name_idx on suppliers(name);

-- USDT↔BDT live rate cache
create table if not exists live_rates (
  id            text primary key default 'usdt_bdt',
  rate          numeric(12,6) not null,
  fetched_at    timestamptz not null default now()
);

-- Profit snapshots (monthly)
create table if not exists profit_snapshots (
  month        text primary key, -- YYYY-MM
  revenue_bdt  numeric(12,2) not null default 0,
  cost_bdt     numeric(12,2) not null default 0,
  profit_bdt   numeric(12,2) not null default 0,
  generated_at timestamptz not null default now()
);

-- Extend products: add category values (already exists, just ensure constraint)
-- Extend sales: add buy_price_usdt and buy_currency
alter table sales add column if not exists buy_price_usdt numeric(12,6);
alter table sales add column if not exists buy_currency text default 'BDT';

-- Extend codes: add batch_id and status
alter table codes add column if not exists batch_id text default '';
alter table codes add column if not exists status text default 'Available';

-- Extend products: add supplier_id
alter table products add column if not exists supplier_id text default '';

-- Enable RLS on new tables
alter table suppliers enable row level security;
alter table live_rates enable row level security;
alter table profit_snapshots enable row level security;
```

- [ ] **Step 2: Run migration locally (if Supabase CLI available)**

```bash
supabase db reset
```

Expected: migration applies without error.

- [ ] **Step 3: Update `tools/ensure-schema.js` to include new DDL**

Copy the DDL from Step 1 into `ensure-schema.js` after the existing DDL block.

- [ ] **Step 4: Update `src/adapters/postgres.js` SPEC mappings**

Add mappings for new tables and columns:

```javascript
// In SPEC object, add:
Suppliers: { table: 'suppliers', key: 'Supplier_ID', num: ['Markup_Percent'],
  cols: { Supplier_ID: 'supplier_id', Name: 'name', Contact: 'contact',
          Currency: 'currency', Markup_Percent: 'markup_percent', Notes: 'notes' } },
Live_Rates: { table: 'live_rates', key: 'ID', num: ['Rate'],
  cols: { ID: 'id', Rate: 'rate', Fetched_At: 'fetched_at' } },
Profit_Snapshots: { table: 'profit_snapshots', key: 'Month', num: ['Revenue_BDT', 'Cost_BDT', 'Profit_BDT'],
  cols: { Month: 'month', Revenue_BDT: 'revenue_bdt', Cost_BDT: 'cost_bdt',
           Profit_BDT: 'profit_bdt', Generated_At: 'generated_at' } },

// In Sales_Log spec, add to cols:
Buy_Price_USDT: 'buy_price_usdt', Buy_Currency: 'buy_currency'

// In Code_Inventory spec, add to cols:
Batch_ID: 'batch_id', Status: 'status'

// In Product_Catalog spec, add to cols:
Supplier_ID: 'supplier_id'
```

- [ ] **Step 5: Update `src/adapters/postgres.js` TABS mapping**

Add:

```javascript
Suppliers: { key: 'Supplier_ID', state: 'suppliers' },
Live_Rates: { key: 'ID', state: 'liveRates' },
Profit_Snapshots: { key: 'Month', state: 'profitSnapshots' }
```

- [ ] **Step 6: Run existing tests**

```bash
npm run test:core
```

Expected: all existing tests pass (adapter changes are additive).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/002_admin_panel_extensions.sql tools/ensure-schema.js src/adapters/postgres.js
git commit -m "feat(schema): add suppliers, live_rates, profit_snapshots; extend sales/codes/products"
```

---

### Task 2: Live Rate Service

**Files:**
- Modify: `src/core/util.js`
- Modify: `src/server/edge.js`
- Create: `test/live-rate.test.js`

**Interfaces:**
- Consumes: `live_rates` table via adapter.
- Produces: `Core.util.getLiveRate(state)` → `Number` (BDT per USDT).

- [ ] **Step 1: Write the failing test**

Create `test/live-rate.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

test('getLiveRate returns cached rate when fresh', () => {
  const state = {
    liveRates: [{ ID: 'usdt_bdt', Rate: 123.45, Fetched_At: new Date().toISOString() }],
    settings: {}
  };
  const rate = Core.util.getLiveRate(state);
  assert.equal(rate, 123.45);
});

test('getLiveRate returns null when no rate cached', () => {
  const state = { liveRates: [], settings: {} };
  const rate = Core.util.getLiveRate(state);
  assert.equal(rate, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/live-rate.test.js
```

Expected: FAIL with "Core.util.getLiveRate is not a function".

- [ ] **Step 3: Implement `getLiveRate` in `src/core/util.js`**

Add to the return object in `Core.util`:

```javascript
function getLiveRate(state) {
  var rows = state.liveRates || [];
  if (!rows.length) return null;
  var r = rows[0];
  var fetched = r.Fetched_At ? new Date(r.Fetched_At).getTime() : 0;
  var ageMs = Date.now() - fetched;
  var maxAgeMs = 5 * 60 * 1000; // 5 minutes
  if (ageMs > maxAgeMs) return null; // stale
  return Number(r.Rate) || null;
}

// In return statement:
return { round2: round2, isoAddDays: isoAddDays, isoCompare: isoCompare, daysBetween: daysBetween,
         addMonths: addMonths, addCycle: addCycle, renewalStart: renewalStart, suggestPaidTill: suggestPaidTill,
         getLiveRate: getLiveRate };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/live-rate.test.js
```

Expected: PASS.

- [ ] **Step 5: Add Edge Function endpoint `/rates/usdt-bdt`**

In `src/server/edge.js`, add to `READS_`:

```javascript
rates: async function (db, st, p) {
  var force = p.refresh === '1' || p.refresh === true;
  var rows = st.liveRates || [];
  var r = rows[0];
  if (!r || force) {
    // Fetch from Bybit
    var res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=USDTBDT');
    var data = await res.json();
    var rate = data && data.result && data.result.list && data.result.list[0] && data.result.list[0].lastPrice;
    if (rate) {
      await db.query('INSERT INTO live_rates (id, rate, fetched_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = now()',
        ['usdt_bdt', Number(rate)]);
      return { rate: Number(rate), source: 'bybit' };
    }
    return { rate: r ? Number(r.Rate) : null, source: 'cached', stale: true };
  }
  return { rate: Number(r.Rate), source: 'cached' };
}
```

Add route in `handle()`:

```javascript
if (path === '/rates/usdt-bdt') {
  var st = await Adapter.readState(db, today_());
  return jsonResponse(await READS_.rates(db, st, { refresh: url.searchParams.get('refresh') }));
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/util.js src/server/edge.js test/live-rate.test.js
git commit -m "feat(core): add getLiveRate for USDT↔BDT conversion"
```

---

### Task 3: Supplier Management Core

**Files:**
- Modify: `src/core/sales.js`
- Create: `test/suppliers.test.js`

**Interfaces:**
- Consumes: `suppliers` table via state.
- Produces: `Core.sales.planSupplier(state, input)` → `{ops, result, errors}`.

- [ ] **Step 1: Write the failing test**

Create `test/suppliers.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

test('planSupplier creates a supplier', () => {
  const state = { suppliers: [], settings: {} };
  const plan = Core.sales.planSupplier(state, { name: 'Supplier A', contact: 'Telegram: @supa', currency: 'USDT', markup_percent: 5 });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.ops[0].tab, 'Suppliers');
  assert.ok(plan.result.supplierId);
});

test('planSupplier rejects duplicate name', () => {
  const state = { suppliers: [{ Supplier_ID: 'SUP-0001', Name: 'Supplier A' }], settings: {} };
  const plan = Core.sales.planSupplier(state, { name: 'Supplier A', contact: 'x', currency: 'BDT', markup_percent: 0 });
  assert.ok(plan.errors.length > 0);
  assert.match(plan.errors[0], /already exists/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/suppliers.test.js
```

Expected: FAIL with "Core.sales.planSupplier is not a function".

- [ ] **Step 3: Implement `planSupplier` in `src/core/sales.js`**

Add to `Core.sales`:

```javascript
function planSupplier(state, input) {
  var name = String(input.name || '').trim();
  if (!name) return fail('Give the supplier a name.');
  var clash = (state.suppliers || []).filter(function (s) { return String(s.Name).trim().toLowerCase() === name.toLowerCase(); })[0];
  if (clash) return fail('A supplier named "' + clash.Name + '" already exists.');
  var gen = genOf(state, input);
  var id = 'SUP-' + pad((state.suppliers || []).length + 1, 4);
  return done([{ op: 'append', tab: 'Suppliers', values: {
    Supplier_ID: id, Name: name, Contact: String(input.contact || '').trim(),
    Currency: input.currency === 'USDT' ? 'USDT' : 'BDT',
    Markup_Percent: Number(input.markup_percent) || 0, Notes: String(input.notes || '').trim()
  } }], { supplierId: id });
}

// Add to return statement:
return { ..., planSupplier: planSupplier };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/suppliers.test.js
```

Expected: PASS.

- [ ] **Step 5: Add Edge Function endpoint `/suppliers`**

In `src/server/edge.js`, add to `WRITES_`:

```javascript
addSupplier: async function (db, st, p) {
  var plan = Core.sales.planSupplier(st, p);
  return commit_(db, plan, 'addSupplier', plan.result && { message: 'Supplier added', supplierId: plan.result.supplierId });
}
```

Add route in `handle()` for `/suppliers`:

```javascript
if (path === '/suppliers' && req.method === 'POST') {
  var b = await req.json();
  return jsonResponse(await api('addSupplier', b, db));
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/sales.js src/server/edge.js test/suppliers.test.js
git commit -m "feat(core): add supplier management (planSupplier)"
```

---

### Task 4: Profit Dashboard Core

**Files:**
- Modify: `src/core/views.js`
- Create: `test/profit.test.js`

**Interfaces:**
- Consumes: `sales`, `products`, `suppliers`, `liveRates`.
- Produces: `Core.views.profitByFamily(state)` → `[{category, revenue, cost, profit, marginPct}]`.

- [ ] **Step 1: Write the failing test**

Create `test/profit.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');
const { makeMigratedState } = require('./fixtures');

test('profitByFamily groups by category', () => {
  const m = makeMigratedState();
  const rows = Core.views.profitByFamily(m);
  assert.ok(rows.some(r => r.category === 'Subscription'));
  assert.ok(rows.every(r => typeof r.revenue === 'number'));
  assert.ok(rows.every(r => typeof r.profit === 'number'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/profit.test.js
```

Expected: FAIL with "Core.views.profitByFamily is not a function".

- [ ] **Step 3: Implement `profitByFamily` in `src/core/views.js`**

Add to `Core.views`:

```javascript
function profitByFamily(state) {
  var ix = index(state);
  var groups = {};
  (state.sales || []).forEach(function (s) {
    if (s.Record_Status === 'Void' || s.Record_Status === 'Refunded') return;
    var p = ix.prod[s.Product_ID] || {};
    var cat = p.Category || 'Subscription';
    if (!groups[cat]) groups[cat] = { revenue: 0, cost: 0 };
    var rev = Core.ledger.saleRevenue(s, state.products);
    groups[cat].revenue += rev;
    // Cost: use Cost_Snapshot (existing) or compute from supplier
    var cost = Number(s.Cost_Snapshot) || 0;
    // TODO: extend for supplier-based cost conversion (Task 5)
    groups[cat].cost += cost;
  });
  var out = [];
  for (var cat in groups) {
    var g = groups[cat];
    var profit = r2(g.revenue - g.cost);
    var marginPct = g.revenue > 0 ? Math.round(profit / g.revenue * 10000) / 100 : 0;
    out.push({ category: cat, revenue: r2(g.revenue), cost: r2(g.cost), profit: profit, marginPct: marginPct });
  }
  out.sort(function (a, b) { return b.profit - a.profit; });
  return out;
}

// Add to return statement:
return { homeData: homeData, duesList: duesList, customerData: customerData, bookData: bookData,
         lookups: lookups, productList: productList, profitByFamily: profitByFamily };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/profit.test.js
```

Expected: PASS.

- [ ] **Step 5: Add Edge Function endpoint `/profit`**

In `src/server/edge.js`, add to `READS_`:

```javascript
profit: async function (db, st) {
  return { families: Core.views.profitByFamily(st) };
}
```

Add route in `handle()`:

```javascript
if (path === '/profit') {
  var st = await Adapter.readState(db, today_());
  return jsonResponse(await READS_.profit(db, st));
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/views.js src/server/edge.js test/profit.test.js
git commit -m "feat(views): add profitByFamily for profit dashboard"
```

---

### Task 5: Multi-Currency Cost Calculation

**Files:**
- Modify: `src/core/ledger.js`
- Modify: `test/ledger.test.js`

**Interfaces:**
- Consumes: `suppliers`, `liveRates`, `sales.buy_price_usdt`, `sales.buy_currency`.
- Produces: `Core.ledger.saleCostBdt(sale, state)` → `Number` (cost in BDT).

- [ ] **Step 1: Write the failing test**

Add to `test/ledger.test.js`:

```javascript
test('saleCostBdt converts USDT to BDT using live rate', () => {
  const state = {
    liveRates: [{ ID: 'usdt_bdt', Rate: 123.5, Fetched_At: new Date().toISOString() }],
    suppliers: [{ Supplier_ID: 'SUP-01', Markup_Percent: 0 }],
    products: [{ Product_ID: 'TEST', Supplier_ID: 'SUP-01' }],
    settings: {}
  };
  const sale = { Buy_Price_USDT: 10, Buy_Currency: 'USDT', Product_ID: 'TEST' };
  const cost = Core.ledger.saleCostBdt(sale, state);
  assert.equal(cost, 1235);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/ledger.test.js
```

Expected: FAIL with "Core.ledger.saleCostBdt is not a function".

- [ ] **Step 3: Implement `saleCostBdt` in `src/core/ledger.js`**

Add to `Core.ledger`:

```javascript
function saleCostBdt(sale, state) {
  var cost = Number(sale.Cost_Snapshot) || 0;
  var currency = String(sale.Buy_Currency || 'BDT').toUpperCase();
  if (currency === 'USDT') {
    var usdt = Number(sale.Buy_Price_USDT) || 0;
    var rate = Core.util.getLiveRate(state);
    if (!rate) rate = 120; // fallback
    cost = r2(usdt * rate);
  }
  // Apply supplier markup if exists
  var prod = productOf(state.products, sale.Product_ID);
  if (prod && prod.Supplier_ID) {
    var sup = (state.suppliers || []).filter(function (s) { return s.Supplier_ID === prod.Supplier_ID; })[0];
    if (sup && Number(sup.Markup_Percent) > 0) {
      cost = r2(cost * (1 + Number(sup.Markup_Percent) / 100));
    }
  }
  return cost;
}

// Add to return statement:
return { salePrice: salePrice, saleRevenue: saleRevenue, paidMap: paidMap, salePaid: salePaid, saleBalance: saleBalance,
         customerBalance: customerBalance, creditOf: creditOf, openDues: openDues, allocate: allocate, productOf: productOf,
         saleCostBdt: saleCostBdt };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/ledger.test.js
```

Expected: PASS.

- [ ] **Step 5: Update `profitByFamily` to use `saleCostBdt`**

In `src/core/views.js`, replace the cost calculation in `profitByFamily`:

```javascript
var cost = Core.ledger.saleCostBdt(s, state);
```

- [ ] **Step 6: Commit**

```bash
git add src/core/ledger.js src/core/views.js test/ledger.test.js
git commit -m "feat(ledger): add saleCostBdt for multi-currency cost conversion"
```

---

### Task 6: Gift-Card Bulk Handling

**Files:**
- Modify: `src/core/sales.js`
- Modify: `test/sales.test.js`

**Interfaces:**
- Consumes: `codes` table with `batch_id` and `status`.
- Produces: `Core.sales.planAddCodesBatch(state, input)` → `{ops, result, errors}`.

- [ ] **Step 1: Write the failing test**

Add to `test/sales.test.js`:

```javascript
test('planAddCodesBatch creates placeholder codes', () => {
  const state = { codes: [], products: [{ Product_ID: 'STEAM', Category: 'Gift_Card' }], settings: {} };
  const plan = Core.sales.planAddCodesBatch(state, { productId: 'STEAM', quantity: 3, batchId: 'BATCH-001' });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.ops.length, 3);
  assert.equal(plan.ops[0].values.Status, 'Pending');
  assert.equal(plan.result.added, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/sales.test.js
```

Expected: FAIL with "Core.sales.planAddCodesBatch is not a function".

- [ ] **Step 3: Implement `planAddCodesBatch` in `src/core/sales.js`**

Add to `Core.sales`:

```javascript
function planAddCodesBatch(state, input) {
  var product = find(state.products, 'Product_ID', input.productId);
  if (!product) return fail('Unknown product ' + input.productId + '.');
  var qty = Number(input.quantity);
  if (!(qty >= 1 && qty <= 1000)) return fail('Quantity must be 1-1000.');
  var gen = genOf(state, input);
  var ops = [], batchId = String(input.batchId || 'BATCH-' + Date.now()).trim();
  for (var i = 0; i < qty; i++) {
    var id = gen.code();
    ops.push({ op: 'append', tab: 'Code_Inventory', values: {
      Code_ID: id, Product_ID: product.Product_ID, Code: '',
      Source_Batch: batchId, Date_Added: state.today, Status: 'Pending'
    } });
  }
  return done(ops, { added: qty, batchId: batchId });
}

// Add to return statement:
return { ..., planAddCodesBatch: planAddCodesBatch };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/sales.test.js
```

Expected: PASS.

- [ ] **Step 5: Add Edge Function endpoint `/codes/batch`**

In `src/server/edge.js`, add to `WRITES_`:

```javascript
addCodesBatch: async function (db, st, p) {
  var plan = Core.sales.planAddCodesBatch(st, p);
  return commit_(db, plan, 'addCodesBatch', plan.result && { message: plan.result.added + ' codes added', batchId: plan.result.batchId });
}
```

Add route in `handle()`:

```javascript
if (path === '/codes/batch' && req.method === 'POST') {
  var b = await req.json();
  return jsonResponse(await api('addCodesBatch', b, db));
}
```

- [ ] **Step 6: Commit**

```bash
git add src/core/sales.js src/server/edge.js test/sales.test.js
git commit -m "feat(sales): add planAddCodesBatch for bulk gift-card handling"
```

---

### Task 7: Multi-Payment Verification

**Files:**
- Modify: `src/core/matching.js`
- Modify: `test/matching.test.js`

**Interfaces:**
- Consumes: `payment_inbox` with `source` column (`bKash`, `Upay`, `Nagad`).
- Produces: extended `planInboxMatch` to handle multiple providers.

- [ ] **Step 1: Write the failing test**

Add to `test/matching.test.js`:

```javascript
test('planInboxMatch handles Upay sender', () => {
  const m = makeMigratedState();
  m.inbox = [{ Received: '2026-10-18', Type: 'Received', Sender: '16268', Amount: 290, Transaction_ID: 'U1', Reference: 'N44', Status: 'Pending', Raw_SMS: '' }];
  const plan = Core.matching.planInboxMatch(m, m.inbox[0], { customerId: cid(m, 'Kabir') });
  assert.equal(plan.status, 'manual');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/matching.test.js
```

Expected: FAIL (Upay sender not recognized).

- [ ] **Step 3: Extend `isBkashSender` to multi-provider check**

In `src/core/matching.js`, add:

```javascript
function isUpaySender(v) { return digits(v) === '16268' || /^upay$/i.test(String(v || '').trim()); }
function isNagadSender(v) { return digits(v) === '16167' || /^nagad$/i.test(String(v || '').trim()); }

// In planInboxMatch, replace sender check:
if (!manual) {
  if (isBkashSender(row.Sender)) { /* existing bKash logic */ }
  else if (isUpaySender(row.Sender) || isNagadSender(row.Sender)) {
    // Manual match for now
    return pending('Payment from ' + (isUpaySender(row.Sender) ? 'Upay' : 'Nagad') + '. Match it by hand.');
  }
  else return pending('Unknown sender. Match it by hand.');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/matching.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/matching.js test/matching.test.js
git commit -m "feat(matching): add Upay/Nagad sender recognition"
```

---

### Task 8: Bi-Weekly Reminder Cadence

**Files:**
- Modify: `src/core/reminders.js`
- Modify: `test/reminders.test.js`

**Interfaces:**
- Consumes: `settings.due_reminder_every_days` (default `14`).
- Produces: `planReminders` uses bi-weekly cadence for due reminders.

- [ ] **Step 1: Write the failing test**

Add to `test/reminders.test.js`:

```javascript
test('due reminder repeats every 14 days by default', () => {
  const m = makeMigratedState();
  m.settings.due_reminder_every_days = 14;
  m.remindersLog.push({ Date: '2026-10-04', Sale_ID: 46, Customer_ID: cid(m, 'tariq'), Kind: 'due', Channel: '', Status: 'sent' });
  const items = Core.reminders.planReminders(m);
  assert.ok(items.some(i => i.saleId === 46 && i.kind === 'due'), 'sent 14 days ago, eligible again');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/reminders.test.js
```

Expected: FAIL (reminder not eligible yet).

- [ ] **Step 3: Update `planReminders` to use `due_reminder_every_days`**

In `src/core/reminders.js`, change:

```javascript
var every = Number(st.due_reminder_every_days) || 14; // was 5
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/reminders.test.js
```

Expected: PASS.

- [ ] **Step 5: Update default in `tools/ensure-schema.js`**

Change:

```javascript
('due_reminder_every_days',  '14'), // was '5'
```

- [ ] **Step 6: Commit**

```bash
git add src/core/reminders.js test/reminders.test.js tools/ensure-schema.js
git commit -m "feat(reminders): change due reminder cadence to bi-weekly (14 days)"
```

---

### Task 9: Per-Product Message Templates

**Files:**
- Modify: `src/core/reminders.js`
- Modify: `test/reminders.test.js`

**Interfaces:**
- Consumes: `settings.msg_renew_<product_id>_en`, etc.
- Produces: `planReminders` picks product-specific template if exists.

- [ ] **Step 1: Write the failing test**

Add to `test/reminders.test.js`:

```javascript
test('product-specific template overrides global', () => {
  const m = makeMigratedState();
  m.settings['msg_renew_NETFLIX_en'] = 'Netflix renewal: {name}, pay {price}';
  const items = Core.reminders.planReminders(m);
  const nfx = items.find(i => i.productName === 'Netflix Premium profile' && i.kind === 'before');
  assert.match(nfx.message, /^Netflix renewal:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/reminders.test.js
```

Expected: FAIL (message uses global template).

- [ ] **Step 3: Update `planReminders` to check product-specific template**

In `src/core/reminders.js`, in `item()` function:

```javascript
var prodId = s.Product_ID;
var tplKey = 'msg_' + kind + '_' + prodId + '_' + lang;
var tpl = st[tplKey] || st['msg_' + kind + '_' + lang] || '';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/reminders.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/reminders.js test/reminders.test.js
git commit -m "feat(reminders): support per-product message templates"
```

---

### Task 10: UI — Suppliers Tab

**Files:**
- Modify: `src/ui/Index.html`

**Interfaces:**
- Consumes: `/suppliers` endpoint.
- Produces: New tab "Suppliers" with CRUD form.

- [ ] **Step 1: Add Suppliers tab to NAV array**

In `src/ui/Index.html`, find `var NAV = [...]` and add:

```javascript
{ id: 'suppliers', label: 'Suppliers', icon: 'truck' }
```

- [ ] **Step 2: Add Suppliers screen to SCREENS object**

Add:

```javascript
SCREENS.suppliers = function () {
  var html = '<h2>Suppliers</h2><button class="btn" id="addSupplier">Add supplier</button><div id="supplierList"></div>';
  $('#screen').innerHTML = html;
  $('#addSupplier').onclick = openNewSupplier;
  drawSupplierList();
};

function drawSupplierList() {
  var list = (S.lookups.suppliers || []).map(function (s) {
    return '<div class="row"><b>' + esc(s.name) + '</b><small>' + esc(s.currency) + '</small></div>';
  }).join('');
  $('#supplierList').innerHTML = list || '<p>No suppliers yet.</p>';
}

function openNewSupplier() {
  var body = '...form HTML...';
  openSheet('New supplier', body);
  // wire form submit to call('addSupplier', ...)
}
```

- [ ] **Step 3: Add suppliers to lookups endpoint**

In `src/core/views.js`, `lookups()` function, add:

```javascript
suppliers: (state.suppliers || []).map(function (s) { return { id: s.Supplier_ID, name: s.Name, currency: s.Currency }; })
```

- [ ] **Step 4: Test manually in browser**

Run `npm run build`, open `dist/harness.html`, verify Suppliers tab appears and form works.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Index.html src/core/views.js
git commit -m "feat(ui): add Suppliers tab with CRUD form"
```

---

### Task 11: UI — Profit Dashboard

**Files:**
- Modify: `src/ui/Index.html`

**Interfaces:**
- Consumes: `/profit` endpoint.
- Produces: New tab "Profit" showing table by category.

- [ ] **Step 1: Add Profit tab to NAV array**

Add:

```javascript
{ id: 'profit', label: 'Profit', icon: 'chart' }
```

- [ ] **Step 2: Add Profit screen to SCREENS object**

Add:

```javascript
SCREENS.profit = function () {
  call('profit', {}).then(function (r) {
    if (!r.ok) return fail(r);
    var rows = r.data.families.map(function (f) {
      return '<tr><td>' + esc(f.category) + '</td><td>' + tk(f.revenue) + '</td><td>' + tk(f.cost) + '</td><td>' + tk(f.profit) + '</td><td>' + f.marginPct + '%</td></tr>';
    }).join('');
    $('#screen').innerHTML = '<h2>Profit by Category</h2><table class="data"><thead><tr><th>Category</th><th>Revenue</th><th>Cost</th><th>Profit</th><th>Margin</th></tr></thead><tbody>' + rows + '</tbody></table>';
  });
};
```

- [ ] **Step 3: Test manually**

- [ ] **Step 4: Commit**

```bash
git add src/ui/Index.html
git commit -m "feat(ui): add Profit dashboard tab"
```

---

### Task 12: UI — Gift-Card Batch View

**Files:**
- Modify: `src/ui/Index.html`

**Interfaces:**
- Consumes: `/codes/batch` endpoint.
- Produces: Codes tab shows batch list and "Add batch" button.

- [ ] **Step 1: Extend Codes screen**

Add batch list view and "Add batch" button.

- [ ] **Step 2: Add batch creation form**

- [ ] **Step 3: Test manually**

- [ ] **Step 4: Commit**

```bash
git add src/ui/Index.html
git commit -m "feat(ui): add gift-card batch view and creation form"
```

---

### Task 13: UI — Live Rate Display

**Files:**
- Modify: `src/ui/Index.html`

**Interfaces:**
- Consumes: `/rates/usdt-bdt` endpoint.
- Produces: Header shows current USDT→BDT rate with stale warning.

- [ ] **Step 1: Add rate display to header**

Fetch rate on load, show in header.

- [ ] **Step 2: Add stale warning**

If `stale: true`, show warning icon.

- [ ] **Step 3: Test manually**

- [ ] **Step 4: Commit**

```bash
git add src/ui/Index.html
git commit -m "feat(ui): show live USDT↔BDT rate in header"
```

---

### Task 14: Monthly Profit Snapshot Job

**Files:**
- Create: `supabase/functions/cron/profit-snapshot/index.ts`

**Interfaces:**
- Consumes: `profitByFamily` for previous month.
- Produces: row in `profit_snapshots` table.

- [ ] **Step 1: Create Edge Function**

Create `supabase/functions/cron/profit-snapshot/index.ts`:

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2';
import postgres from 'npm:postgres';

const DB_URL = Deno.env.get('SUPABASE_DB_URL')!;
const sql = postgres(DB_URL, { prepare: false });

// ... (copy adapter and core logic from main Edge Function)

Deno.serve(async (req) => {
  const today = new Date().toISOString().slice(0, 10);
  const prevMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
  const st = await readState(sql, today);
  const families = Core.views.profitByFamily(st);
  let revenue = 0, cost = 0, profit = 0;
  families.forEach(f => { revenue += f.revenue; cost += f.cost; profit += f.profit; });
  await sql`INSERT INTO profit_snapshots (month, revenue_bdt, cost_bdt, profit_bdt) VALUES (${prevMonth}, ${revenue}, ${cost}, ${profit}) ON CONFLICT (month) DO UPDATE SET revenue_bdt = EXCLUDED.revenue_bdt, cost_bdt = EXCLUDED.cost_bdt, profit_bdt = EXCLUDED.profit_bdt`;
  return new Response(JSON.stringify({ ok: true, month: prevMonth }), { headers: { 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 2: Deploy Edge Function**

```bash
supabase functions deploy profit-snapshot
```

- [ ] **Step 3: Register cron trigger in Supabase dashboard**

Set to run on 1st of each month at 00:00 UTC.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/cron/profit-snapshot/index.ts
git commit -m "feat(cron): add monthly profit snapshot job"
```

---

### Task 15: Final Integration Test

**Files:**
- Modify: `test/ui/app.test.js`

**Interfaces:**
- Consumes: all new features.
- Produces: end-to-end test for new flows.

- [ ] **Step 1: Add integration test for supplier creation**

```javascript
test('Supplier tab creates and lists supplier', async () => {
  const { page } = await open();
  await page.getByRole('button', { name: 'Suppliers' }).click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByLabel('Name').fill('Test Supplier');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Test Supplier').waitFor();
});
```

- [ ] **Step 2: Add integration test for profit dashboard**

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/ui/app.test.js
git commit -m "test(ui): add integration tests for suppliers and profit"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-23-admin-panel-implementation.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because the tasks are well-scoped, the interfaces are explicit, and a shipped mistake would be caught by the existing test suite before deployment. Does the plan capture what you want, and which approach should we use?

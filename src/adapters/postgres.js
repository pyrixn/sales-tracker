/**
 * Adapter (Postgres): the only code that touches the database. It mirrors the former sheets.js adapter's public API
 * (readState, readTab, applyOps, readLastBatch, fieldFor, headerFor) so the Core planners and the
 * server router work unchanged. Everything is async and takes a `db` object:
 *   db.query(text, paramsArray) -> { rows }          (params use $1, $2, ...)
 *   db.transaction(async tx => { ... })              (tx has the same .query)
 * Column names are snake_case; this file maps them to the state field names the Core expects.
 */
var Adapter = (function () {
  // tab -> state field name (mirrors the former sheets.js adapter's TABS, minus sheet-only details)
  var TABS = {
    Customers:       { key: 'Customer_ID',    state: 'customers' },
    Sales_Log:       { key: 'Sale_ID',        state: 'sales' },
    Payments:        { key: 'Payment_ID',     state: 'payments' },
    Expenses:        { key: 'Expense_ID',     state: 'expenses' },
    Purchases:      { key: 'Purchase_ID',    state: 'purchases' },
    Accounts:        { key: 'Account_ID',     state: 'accounts' },
    Wallets:         { key: 'Wallet_ID',      state: 'wallets' },
    Product_Catalog: { key: 'Product_ID',     state: 'products' },
    Code_Inventory:  { key: 'Code_ID',        state: 'codes' },
    Payment_Inbox:   { key: 'Transaction_ID', state: 'inbox' },
    Settings:        { key: 'Key' },
    Change_Log:      { key: 'Batch_ID' },
    Reminders_Log:   { key: 'Sale_ID',        state: 'remindersLog' },
    Suppliers:       { key: 'Supplier_ID',    state: 'suppliers' },
    Live_Rates:      { key: 'ID',             state: 'liveRates' },
    Profit_Snapshots:{ key: 'Month',          state: 'profitSnapshots' }
  };

  // state field -> db column, per tab. `num` lists numeric fields (read back via Number,
  // blank/null becomes ''), everything else is text.
  var SPEC = {
    Customers: { table: 'customers', key: 'Customer_ID', num: [],
      cols: { Customer_ID: 'customer_id', Name: 'name', Channel: 'channel', Handle: 'handle',
              Discord_User_ID: 'discord_user_id', Notes: 'notes', Created: 'created' } },
    Sales_Log: { table: 'sales', key: 'Sale_ID', num: ['Sale_ID', 'Qty', 'Unit_Price', 'Months', 'Cost_Snapshot', 'Buy_Price_USDT'],
      cols: { Sale_ID: 'sale_id', Sale_Date: 'sale_date', Customer: 'customer', Contact: 'contact',
              Product_ID: 'product_id', Account_ID: 'account_id', Code_ID: 'code_id', Qty: 'qty',
              Unit_Price: 'unit_price', Paid_Till: 'paid_till', Record_Status: 'record_status', Notes: 'notes',
              Payment_Method: 'payment_method', Transaction_ID: 'transaction_id', Cost_Snapshot: 'cost_snapshot',
              Customer_ID: 'customer_id', Months: 'months', Sub_Code: 'sub_code', Pay_Token: 'pay_token',
              Buy_Price_USDT: 'buy_price_usdt', Buy_Currency: 'buy_currency' } },
    Payments: { table: 'payments', key: 'Payment_ID', num: ['Sale_ID', 'Amount'],
      cols: { Payment_ID: 'payment_id', Date: 'date', Customer_ID: 'customer_id', Sale_ID: 'sale_id',
              Amount: 'amount', Method: 'method', Transaction_ID: 'transaction_id', Source: 'source', Note: 'note' } },
    Expenses: { table: 'expenses', key: 'Expense_ID', num: ['Amount'],
      cols: { Expense_ID: 'expense_id', Date: 'date', Category: 'category', Amount: 'amount',
              Paid_With: 'paid_with', Note: 'note' } },
    Purchases: { table: 'purchases', key: 'Purchase_ID', num: ['Amount'],
      cols: { Purchase_ID: 'purchase_id', Date: 'date', Account_ID: 'account_id', Paid_With: 'paid_with',
              Amount: 'amount', Covers_Until: 'covers_until', Notes: 'notes' } },
    Accounts: { table: 'accounts', key: 'Account_ID', num: ['Cycle_Cost', 'Slots'],
      cols: { Account_ID: 'account_id', Product_ID: 'product_id', Account_Label: 'account_label',
              Cycle_Cost: 'cycle_cost', Renewal_Date: 'renewal_date', Slots: 'slots', Notes: 'notes',
              Account_Status: 'account_status' } },
    Wallets: { table: 'wallets', key: 'Wallet_ID', num: [],
      cols: { Wallet_ID: 'wallet_id', Label: 'label', Type: 'type', Notes: 'notes' } },
    Product_Catalog: { table: 'products', key: 'Product_ID', num: ['Billing_Cycle_Days', 'Account_Cost', 'Slots_Per_Account', 'Code_Unit_Cost', 'Default_Price'],
      cols: { Product_ID: 'product_id', Product_Name: 'product_name', Category: 'category', Platform: 'platform',
              Billing_Cycle_Days: 'billing_cycle_days', Account_Cost: 'account_cost', Slots_Per_Account: 'slots_per_account',
              Code_Unit_Cost: 'code_unit_cost', Default_Price: 'default_price', Active: 'active', Letter: 'letter',
              Supplier_ID: 'supplier_id', Template_Renew: 'template_renew', Template_Due: 'template_due' } },
    Code_Inventory: { table: 'codes', key: 'Code_ID', num: [],
      cols: { Code_ID: 'code_id', Product_ID: 'product_id', Code: 'code', 'Source / Batch': 'source_batch',
              Date_Added: 'date_added', Manual_Flag: 'manual_flag', Status: 'status', Batch_ID: 'batch_id' } },
    Payment_Inbox: { table: 'payment_inbox', key: 'Transaction_ID', num: ['Amount'],
      cols: { Transaction_ID: 'transaction_id', Received: 'received', Type: 'type', Method: 'method',
              Sender: 'sender', Amount: 'amount', Counterparty: 'counterparty', Reference: 'reference',
              Raw_SMS: 'raw_sms', Status: 'status', Matched_Sale_ID: 'matched_sale_id' } },
    Settings: { table: 'settings', key: 'Key', num: [],
      cols: { Key: 'key', Value: 'value' } },
    Reminders_Log: { table: 'reminders_log', key: 'Sale_ID', num: ['Sale_ID'],
      cols: { Date: 'date', Sale_ID: 'sale_id', Customer_ID: 'customer_id', Kind: 'kind', Channel: 'channel', Status: 'status' } },
    Change_Log: { table: 'change_log', key: 'Batch_ID', num: [],
      cols: { Time: 'time', Batch_ID: 'batch_id', Action: 'action', Tab: 'tab', Row_Key: 'row_key',
              Field: 'field', Old: 'old', New: 'new' } },
    Suppliers: { table: 'suppliers', key: 'Supplier_ID', num: ['Markup_Percent'],
      cols: { Supplier_ID: 'supplier_id', Name: 'name', Contact: 'contact',
              Currency: 'currency', Markup_Percent: 'markup_percent', Notes: 'notes' } },
    Live_Rates: { table: 'live_rates', key: 'ID', num: ['Rate'],
      cols: { ID: 'id', Rate: 'rate', Fetched_At: 'fetched_at' } },
    Profit_Snapshots: { table: 'profit_snapshots', key: 'Month', num: ['Revenue_BDT', 'Cost_BDT', 'Profit_BDT'],
      cols: { Month: 'month', Revenue_BDT: 'revenue_bdt', Cost_BDT: 'cost_bdt',
              Profit_BDT: 'profit_bdt', Generated_At: 'generated_at' } }
  };

  var NUMERIC_SETTINGS = ['reminder_days_before', 'reminder_days_after', 'due_reminder_every_days', 'grace_days'];

  function isBlank(v) { return v === '' || v === null || v === undefined; }
  function num(v) { return isBlank(v) ? '' : Number(v); }

  // ── state field -> db column and back (no sheet-header indirection in Postgres) ──
  function headerFor(tab, field) { return field; }
  function fieldFor(tab, field) { return field; }

  // ── reading ─────────────────────────────────────────────────────────────────────
  async function readTab(db, tab) {
    var spec = SPEC[tab];
    if (!spec) throw new Error('Unknown tab ' + tab);
    return mapRows(spec, (await db.query('SELECT * FROM ' + spec.table)).rows);
  }

  /**
   * Rows of one tab where `field` equals `value`, shaped like readTab. For public routes that must not read whole tables.
   * `ci` compares upper-case on both sides (references are typed by customers in any case).
   */
  async function readTabWhere(db, tab, field, value, ci) {
    var spec = SPEC[tab];
    if (!spec || !spec.cols[field]) throw new Error('Unknown field ' + tab + '.' + field);
    var col = spec.cols[field];
    var res = ci
      ? await db.query('SELECT * FROM ' + spec.table + ' WHERE upper(' + col + ') = $1', [String(value).toUpperCase()])
      : await db.query('SELECT * FROM ' + spec.table + ' WHERE ' + col + ' = $1', [value]);
    return mapRows(spec, res.rows);
  }

  function mapRows(spec, rows) {
    var numCols = spec.num || [];
    return (rows || []).map(function (r) {
      var o = {};
      for (var sf in spec.cols) {
        var v = r[spec.cols[sf]];
        if (v === null || v === undefined) v = '';
        if (numCols.indexOf(sf) >= 0) v = num(v);
        else if (sf === 'Letter' || sf === 'Active') v = String(v);
        else if (typeof v !== 'string') v = String(v);
        o[sf] = v;
      }
      return o;
    });
  }

  async function readSettings(db) {
    var s = {};
    var res = await db.query('SELECT key, value FROM settings');
    (res.rows || []).forEach(function (r) {
      var k = String(r.key), v = r.value;
      if (NUMERIC_SETTINGS.indexOf(k) >= 0) v = Number(v);
      else if (k === 'discord_enabled') v = v === true || String(v).toUpperCase() === 'TRUE';
      else v = isBlank(v) ? '' : String(v);
      s[k] = v;
    });
    return s;
  }

  async function readState(db, today) {
    var st = { today: today, settings: await readSettings(db) };
    for (var tab in TABS) {
      if (TABS[tab].state) st[TABS[tab].state] = await readTab(db, tab);
    }
    st.accounts.forEach(function (a) {
      if (isBlank(a.Cost_Per_Slot) && Number(a.Slots) > 0) a.Cost_Per_Slot = Number(a.Cycle_Cost || 0) / Number(a.Slots);
      if (isBlank(a.Account_Status)) a.Account_Status = 'Active';
    });
    return st;
  }

  // ── writing ─────────────────────────────────────────────────────────────────────
  function toDb(spec, field, v) {
    if (v === null || v === undefined) return null;
    if (spec.num.indexOf(field) >= 0) {
      if (v === '') return null;
      return Number(v);
    }
    return String(v);
  }

  function keyCol(spec, op) { return spec.cols[op.key || spec.key]; }

  async function writeChangeLog(tx, meta, log) {
    if (meta.log === false || !log.length) return;
    var now = new Date().toISOString();
    for (var i = 0; i < log.length; i++) {
      var l = log[i];
      await tx.query(
        'INSERT INTO change_log (time, batch_id, action, tab, row_key, field, old, new) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [now, meta.batchId || '', meta.action || '', l.tab, String(l.rowKey), l.field, l.old, l.new]);
    }
  }

  async function applyOps(db, ops, meta) {
    meta = meta || {};
    ops = ops || [];
    return db.transaction(async function (tx) {
      var log = [], changes = 0;
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i], spec = SPEC[op.tab];
        if (!spec) throw new Error('Unknown tab ' + op.tab);

        if (op.op === 'append') {
          var cols = [], vals = [], ph = [];
          for (var f in op.values) {
            var c = spec.cols[f];
            if (c === undefined) throw new Error('Unknown field ' + op.tab + '.' + f);
            cols.push(c); vals.push(toDb(spec, f, op.values[f])); ph.push('$' + cols.length);
          }
          await tx.query('INSERT INTO ' + spec.table + ' (' + cols.join(',') + ') VALUES (' + ph.join(',') + ')', vals);
          changes++;
          log.push({ tab: op.tab, rowKey: op.values[spec.key], field: '(new row)', old: '', new: '' });

        } else if (op.op === 'update') {
          var kc = keyCol(spec, op), idv = toDb(spec, op.key || spec.key, op.id);
          var oldRes = await tx.query('SELECT * FROM ' + spec.table + ' WHERE ' + kc + ' = $1', [idv]);
          var oldRow = (oldRes.rows || [])[0];
          if (!oldRow) throw new Error('Not found: ' + op.tab + ' ' + op.id);   // match sheets adapter semantics
          var sets = [], svals = [];
          for (var uf in op.values) {
            var uc = spec.cols[uf];
            if (uc === undefined) throw new Error('Unknown field ' + op.tab + '.' + uf);
            sets.push(uc + ' = $' + (sets.length + 1));
            svals.push(toDb(spec, uf, op.values[uf]));
          }
          if (!sets.length) continue;
          await tx.query('UPDATE ' + spec.table + ' SET ' + sets.join(', ') + ' WHERE ' + kc + ' = $' + (svals.length + 1),
            svals.concat([idv]));
          changes++;
          for (var wf in op.values) {
            var old = oldRow[spec.cols[wf]];
            if (old === null || old === undefined) old = '';
            else old = String(old);
            log.push({ tab: op.tab, rowKey: op.id, field: wf, old: old, new: String(op.values[wf]) });
          }

        } else if (op.op === 'clear') {
          var kc2 = keyCol(spec, op), idv2 = toDb(spec, op.key || spec.key, op.id);
          var res2 = await tx.query('SELECT * FROM ' + spec.table + ' WHERE ' + kc2 + ' = $1', [idv2]);
          var row2 = (res2.rows || [])[0];
          if (!row2) throw new Error('Not found: ' + op.tab + ' ' + op.id);   // match sheets adapter semantics
          for (var cf in spec.cols) {
              if (cf === spec.key) continue;
              var ov = row2[spec.cols[cf]];
              if (ov === null || ov === undefined) ov = '';
              log.push({ tab: op.tab, rowKey: op.id, field: cf, old: String(ov), new: '' });
            }
            await tx.query('DELETE FROM ' + spec.table + ' WHERE ' + kc2 + ' = $1', [idv2]);
            changes++;

        } else {
          throw new Error('Unknown op ' + op.op);
        }
      }
      await writeChangeLog(tx, meta, log);
      return { changes: changes };
    });
  }

  /** Newest batch that is not an undo and has not been undone (mirrors the former sheets.js adapter). */
  async function readLastBatch(db, opts) {
    var res = await db.query('SELECT * FROM change_log ORDER BY id');
    // change_log columns come back snake_case; the Core undo planner expects the capitalised line keys.
    var cols = SPEC.Change_Log.cols;
    var lines = (res.rows || []).map(function (r) {
      var o = {};
      for (var f in cols) o[f] = r[cols[f]];
      return o;
    });
    var undone = {};
    lines.forEach(function (l) { var m = /^undo:(.+)$/.exec(String(l.Action)); if (m) undone[m[1]] = true; });
    for (var i = lines.length - 1; i >= 0; i--) {
      var b = String(lines[i].Batch_ID);
      if (!b || /^undo:/.test(String(lines[i].Action)) || undone[b]) continue;
      if (opts && opts.skipAuto && /^auto/.test(String(lines[i].Action))) continue;
      var batchId = b;
      return {
        batchId: batchId,
        lines: lines.filter(function (l) { return String(l.Batch_ID) === batchId; }).map(function (l) {
          return { Batch_ID: l.Batch_ID, Action: l.Action, Tab: l.Tab, Row_Key: l.Row_Key, Field: l.Field, Old: l.Old, New: l.New };
        })
      };
    }
    return null;
  }

  return { TABS: TABS, SPEC: SPEC, readState: readState, readTab: readTab, readTabWhere: readTabWhere, readSettings: readSettings, applyOps: applyOps,
           readLastBatch: readLastBatch, headerFor: headerFor, fieldFor: fieldFor };
})();
if (typeof module !== 'undefined') module.exports = Adapter;

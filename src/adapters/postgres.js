/**
 * Adapter (Postgres): the only code that touches the database. It mirrors the former sheets.js adapter's public API
 * (readState, readTab, applyOps, readLastBatch, fieldFor, headerFor) so the Core planners and the
 * server router work unchanged. Everything is async and takes a `db` object:
 *   db.query(text, paramsArray) -> { rows }          (params use $1, $2, ...)
 *   db.transaction(async tx => { ... })              (tx has the same .query)
 * Column names are snake_case; this file maps them to the state field names the Core expects.
 */
var Adapter = (function () {
  // Code identity of this build. tools/build-edge.js replaces the 'dev' value with a hash of the bundle, so a deploy changes every version token.
  var BUILD_STAMP = 'dev';
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
    Profit_Snapshots:{ key: 'Month',          state: 'profitSnapshots' },
    Pay_Intents:     { key: 'Token',          state: 'payIntents' },
    Pay_Requests:    { key: 'Request_ID',     state: 'payRequests' },
    Deliveries:      { key: 'Delivery_ID',    state: 'deliveries' },
    Goals:           { key: 'Goal_ID',        state: 'goals' },
    Budgets:         { key: 'Budget_ID',      state: 'budgets' },
    Import_Rows:     { key: 'Row_ID',         state: 'importRows' },
    Orders:          { key: 'Order_ID',       state: 'orders' }
  };

  // state field -> db column, per tab. `num` lists numeric fields (read back via Number,
  // blank/null becomes ''), everything else is text.
  // `bool` lists boolean fields (read as true/false, written as booleans). Timestamps come back as Date and are read as ISO strings.
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
              Buy_Price_USDT: 'buy_price_usdt', Buy_Currency: 'buy_currency', Covers_From: 'covers_from' } },
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
    Product_Catalog: { table: 'products', key: 'Product_ID', num: ['Billing_Cycle_Days', 'Account_Cost', 'Slots_Per_Account', 'Code_Unit_Cost', 'Default_Price', 'Sort_Order', 'Public_Price'], bool: ['Public'],
      cols: { Product_ID: 'product_id', Product_Name: 'product_name', Category: 'category', Platform: 'platform',
              Billing_Cycle_Days: 'billing_cycle_days', Account_Cost: 'account_cost', Slots_Per_Account: 'slots_per_account',
              Code_Unit_Cost: 'code_unit_cost', Default_Price: 'default_price', Active: 'active', Letter: 'letter',
              Supplier_ID: 'supplier_id', Template_Renew: 'template_renew', Template_Due: 'template_due',
              Delivers_As: 'delivers_as', Parent_ID: 'parent_id',
              Slug: 'slug', Public: 'public', Description: 'description', Image_Path: 'image_path',
              Sort_Order: 'sort_order', Public_Price: 'public_price' } },
    Orders: { table: 'orders', key: 'Order_ID', num: ['Months', 'Unit_Price', 'Total', 'Sale_ID'],
      cols: { Order_ID: 'order_id', Created: 'created_at', Source: 'source', Status: 'status', Customer_ID: 'customer_id',
              Customer_Name: 'customer_name', Contact: 'contact', Contact_Channel: 'contact_channel', Product_ID: 'product_id',
              Months: 'months', Unit_Price: 'unit_price', Total: 'total', Pay_Request_ID: 'pay_request_id', Sale_ID: 'sale_id',
              Note: 'note', Fulfilled: 'fulfilled_at', Api_Key_ID: 'api_key_id', Idem_Key: 'idem_key', Request_Hash: 'request_hash',
              Access_Token: 'access_token' } },
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
              Currency: 'currency', Markup_Percent: 'markup_percent', Notes: 'notes',
              Contact_Channel: 'contact_channel' } },
    Live_Rates: { table: 'live_rates', key: 'ID', num: ['Rate'],
      cols: { ID: 'id', Rate: 'rate', Fetched_At: 'fetched_at' } },
    Pay_Intents: { table: 'pay_intents', key: 'Token', num: [],
      cols: { Token: 'token', Method: 'method', Payer_Number: 'payer_number', Claim_Trx: 'claim_trx',
              Claimed: 'claimed', Created: 'created', Updated: 'updated' } },
    Pay_Requests: { table: 'pay_requests', key: 'Request_ID', num: ['Amount', 'Sale_ID'],
      cols: { Request_ID: 'request_id', Token: 'token', Title: 'title', Amount: 'amount', Customer_ID: 'customer_id',
              Customer_Name: 'customer_name', Product_ID: 'product_id', Code_ID: 'code_id', Note: 'note',
              Status: 'status', Created: 'created', Expires: 'expires', Sale_ID: 'sale_id', Ref: 'ref' } },
    Deliveries: { table: 'deliveries', key: 'Delivery_ID', num: ['Sale_ID'],
      cols: { Delivery_ID: 'delivery_id', Sale_ID: 'sale_id', Request_ID: 'request_id', Customer_ID: 'customer_id',
              Product_ID: 'product_id', Code_ID: 'code_id', Kind: 'kind', Status: 'status',
              Delivered_At: 'delivered_at', Note: 'note' } },
    Profit_Snapshots: { table: 'profit_snapshots', key: 'Month', num: ['Revenue_BDT', 'Cost_BDT', 'Profit_BDT'],
      cols: { Month: 'month', Revenue_BDT: 'revenue_bdt', Cost_BDT: 'cost_bdt',
              Profit_BDT: 'profit_bdt', Generated_At: 'generated_at' } },
    Goals: { table: 'goals', key: 'Goal_ID', num: ['Target'],
      cols: { Goal_ID: 'goal_id', Title: 'title', Metric: 'metric', Target: 'target',
              Start: 'start_date', End: 'end_date', Note: 'note', Status: 'status' } },
    Budgets: { table: 'budgets', key: 'Budget_ID', num: ['Monthly_Limit', 'Alert_Pct'],
      cols: { Budget_ID: 'budget_id', Category: 'category', Monthly_Limit: 'monthly_limit',
              Alert_Pct: 'alert_pct', Active: 'active' } },
    Import_Rows: { table: 'import_rows', key: 'Row_ID', num: [],
      cols: { Row_ID: 'row_id', Batch: 'batch', Kind: 'kind', Sheet: 'sheet', Ref: 'ref', Data: 'data',
              Status: 'status', Note: 'note', Applied: 'applied', Created: 'created' } }
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
    var boolCols = spec.bool || [];
    return (rows || []).map(function (r) {
      var o = {};
      for (var sf in spec.cols) {
        var v = r[spec.cols[sf]];
        if (boolCols.indexOf(sf) >= 0) { o[sf] = v === true || String(v).toLowerCase() === 'true'; continue; }
        if (v === null || v === undefined) v = '';
        if (numCols.indexOf(sf) >= 0) v = num(v);
        else if (v instanceof Date) v = v.toISOString();
        else if (sf === 'Letter' || sf === 'Active') v = String(v);
        else if (typeof v !== 'string') v = String(v);
        o[sf] = v;
      }
      return o;
    });
  }

  var VAULT_PIN_KEY = 'vault_pin_hash';
  async function readSettings(db) {
    var s = {};
    var res = await db.query('SELECT key, value FROM settings');
    (res.rows || []).forEach(function (r) {
      var k = String(r.key), v = r.value;
      if (NUMERIC_SETTINGS.indexOf(k) >= 0) v = Number(v);
      else if (k === 'discord_enabled') v = v === true || String(v).toUpperCase() === 'TRUE';
      else v = isBlank(v) ? '' : String(v);
      // The vault PIN hash is never part of the settings every role receives (init, home): see readVaultPinHash.
      if (k === VAULT_PIN_KEY) return;
      s[k] = v;
    });
    return s;
  }

  /**
   * The state Core planners and views read. `tables` (optional) lists tab names to load; Settings is always loaded.
   * Without it every table is read (the safe default). A table not listed is absent from the state (its field is undefined), so
   * only ask for a subset when the caller's code touches nothing else.
   */
  async function readState(db, today, tables) {
    var want = null;
    if (tables) {
      want = {};
      tables.forEach(function (t) {
        if (!TABS[t] || !TABS[t].state) throw new Error('Unknown tab ' + t);
        want[t] = true;
      });
    }
    // Every read goes out at once (Edge db: postgres.js pool outside a transaction, pipelined on the one connection inside).
    var names = [];
    for (var tab in TABS) if (TABS[tab].state && (!want || want[tab])) names.push(tab);
    var got = await Promise.all([readSettings(db)].concat(names.map(function (t) { return readTab(db, t); })));
    var st = { today: today, settings: got[0] };
    names.forEach(function (t, i) { st[TABS[t].state] = got[i + 1]; });
    (st.accounts || []).forEach(function (a) {
      if (isBlank(a.Cost_Per_Slot) && Number(a.Slots) > 0) a.Cost_Per_Slot = Number(a.Cycle_Cost || 0) / Number(a.Slots);
      if (isBlank(a.Account_Status)) a.Account_Status = 'Active';
    });
    return st;
  }

  // ── version token ───────────────────────────────────────────────────────────────
  // One statement, one row of change markers for everything the panel's init/home views read or that moves them:
  //  - change_log max id: every write through commit_/applyOps with logging on (all tables, undo, autoExpire, autoMatch).
  //  - payment_inbox count + max received: relay inserts (they write no change_log). Status edits are logged.
  //  - settings md5 of all key=value pairs (the table has no updated marker): settings saves and log:false layout saves.
  //  - pay_intents md5 of all rows (customers' POSTs write no change_log and may repeat inside one minute, so count/max(updated) is not enough).
  //  - reminders_log count + max id: remindSent is written with log:false.
  //  - live_rates md5 of rows: refreshRate writes no change_log.
  //  - rate_epoch and open_expires are time inputs: readVersion turns them into "rate still fresh" and "open requests past expiry" counts.
  var VERSION_SQL =
    "SELECT (SELECT coalesce(max(id), 0) FROM change_log) AS log_id, " +
    "(SELECT count(*) FROM payment_inbox) AS inbox_n, " +
    "(SELECT coalesce(max(received), '') FROM payment_inbox) AS inbox_max, " +
    "(SELECT md5(coalesce(string_agg(key || '=' || value, '|' ORDER BY key), '')) FROM settings) AS settings_h, " +
    "(SELECT md5(coalesce(string_agg(token || '~' || method || '~' || payer_number || '~' || claim_trx || '~' || claimed || '~' || updated, '|' ORDER BY token), '')) FROM pay_intents) AS intents_h, " +
    "(SELECT count(*) FROM reminders_log) AS rem_n, " +
    "(SELECT coalesce(max(id), 0) FROM reminders_log) AS rem_max, " +
    "(SELECT md5(coalesce(string_agg(id || '=' || rate::text || '@' || fetched_at::text, '|' ORDER BY id), '')) FROM live_rates) AS rate_h, " +
    "coalesce((SELECT extract(epoch FROM fetched_at) FROM live_rates ORDER BY (id = 'usdt_bdt') DESC LIMIT 1), 0) AS rate_epoch, " +
    "(SELECT coalesce(string_agg(expires, '|'), '') FROM pay_requests WHERE status = 'Open') AS open_expires";

  /**
   * Opaque string that changes whenever what init/home show may have changed. `ctx` = { today, nowMs, freshMs } adds the inputs that move
   * with the clock and not with data: the Dhaka date (dues, days left, reminders), whether the cached rate is still fresh, and how many
   * open pay requests are past their expiry (matching.whyNotAuto reads that). Equal strings mean an unchanged answer; the converse is not promised.
   */
  async function readVersion(db, ctx) {
    var r = ((await db.query(VERSION_SQL)).rows || [])[0] || {};
    var parts = [(ctx && ctx.build !== undefined) ? ctx.build : BUILD_STAMP, r.log_id, r.inbox_n, r.inbox_max, r.settings_h, r.intents_h, r.rem_n, r.rem_max, r.rate_h];
    if (ctx) {
      var now = Number(ctx.nowMs), epoch = Number(r.rate_epoch) || 0;
      var fresh = epoch > 0 && now - epoch * 1000 <= Number(ctx.freshMs) ? 1 : 0;
      var expired = String(r.open_expires || '').split('|').filter(function (x) {
        var t = Date.parse(x); return x !== '' && isFinite(t) && t <= now;
      }).length;
      parts.push(ctx.today, fresh, expired);
      if (!fresh) parts.push(Math.floor(now / (Number(ctx.freshMs) || 300000)));
    }
    return parts.map(function (x) { return String(x === null || x === undefined ? '' : x); }).join('.');
  }

  // ── writing ─────────────────────────────────────────────────────────────────────
  function toDb(spec, field, v) {
    if (v === null || v === undefined) return null;
    if ((spec.bool || []).indexOf(field) >= 0) return v === true || String(v).toLowerCase() === 'true';
    if (spec.num.indexOf(field) >= 0) {
      if (v === '') return null;
      return Number(v);
    }
    return String(v);
  }

  function keyCol(spec, op) { return spec.cols[op.key || spec.key]; }

  function redactJsonKeys_(text, keys) {
    try {
      var o = JSON.parse(text);
      if (!o || typeof o !== 'object') return text;
      keys.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== '') o[k] = ''; });
      return JSON.stringify(o);
    } catch (e) { return text; }
  }

  // Returns true when a batch was written (false for log:false or no logged line).
  async function writeChangeLog(tx, meta, log) {
    if (meta.log === false || !log.length) return false;
    var now = new Date().toISOString();
    for (var i = 0; i < log.length; i++) {
      var l = log[i];
      await tx.query(
        'INSERT INTO change_log (time, batch_id, action, tab, row_key, field, old, new, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [now, meta.batchId || '', meta.action || '', l.tab, String(l.rowKey), l.field, l.old, l.new, meta.actor || '']);
    }
    return true;
  }

  // Who made the change: the request's actor ('secret' for the panel password, a Supabase user id for a staff login, '' for system work).
  // The Edge Function sets db.actor on the request's own transaction; a root db has none, so housekeeping writes are logged as system.
  async function applyOps(db, ops, meta) {
    meta = Object.assign({}, meta || {});
    if (meta.actor === undefined) meta.actor = (db && db.actor) || '';
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
            var nw = String(op.values[wf]);
            // op.redactJson { Field: [json keys] }: the change_log line shows those keys of a JSON field blanked (plaintext never reaches the log).
            if (op.redactJson && op.redactJson[wf]) { old = redactJsonKeys_(old, op.redactJson[wf]); nw = redactJsonKeys_(nw, op.redactJson[wf]); }
            log.push({ tab: op.tab, rowKey: op.id, field: wf, old: old, new: nw });
          }

        } else if (op.op === 'clear') {
          var kc2 = keyCol(spec, op), idv2 = toDb(spec, op.key || spec.key, op.id);
          var res2 = await tx.query('SELECT * FROM ' + spec.table + ' WHERE ' + kc2 + ' = $1', [idv2]);
          var row2 = (res2.rows || [])[0];
          if (!row2) throw new Error('Not found: ' + op.tab + ' ' + op.id);   // match sheets adapter semantics
          log.push({ tab: op.tab, rowKey: op.id, field: '(deleted row)', old: '', new: '' });
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
      var logged = await writeChangeLog(tx, meta, log);
      return { changes: changes, logged: logged };
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
      // Audit-only batches (staff:, vault:, apiKey:, webhook:, delivery:, importEdit:login) all carry a ':' in the action; automatic work starts with 'auto'. Real writes never contain ':'.
      if (opts && opts.skipAuto && /^auto|:/.test(String(lines[i].Action))) continue;
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

  // Change_Log rows as capitalised lines (Time, Batch_ID, Action, Tab, Row_Key, Field, Old, New). A timestamp comes back as ISO text.
  function changeLines(rows) {
    var cols = SPEC.Change_Log.cols;
    return (rows || []).map(function (r) {
      var o = {};
      for (var f in cols) { var v = r[cols[f]]; o[f] = v === null || v === undefined ? '' : v; }
      if (o.Time instanceof Date) o.Time = o.Time.toISOString();
      return o;
    });
  }

  /** Change_Log lines of one row (tab + row key), newest first, at most 50. Targeted: never reads the whole log. */
  async function readChangeLogFor(db, tab, rowKey) {
    var res = await db.query('SELECT * FROM change_log WHERE tab = $1 AND row_key = $2 ORDER BY id DESC LIMIT 50', [String(tab), String(rowKey)]);
    return changeLines(res.rows);
  }

  /** The newest `limit` Change_Log lines, newest first (the Activity screen groups them into batches in Core). Bounded: never the whole log. */
  async function readRecentChangeLog(db, limit) {
    var res = await db.query('SELECT * FROM change_log ORDER BY id DESC LIMIT $1', [Number(limit)]);
    return changeLines(res.rows);
  }

  // ── public API tables (api_keys, rate_limits, webhook_endpoints, webhook_deliveries) ──────────────────────
  // Not part of the state the planners read, so they have their own small functions here. The rules (what a key may do, what a
  // webhook says) live in Core.publicapi; these only store and fetch rows. Text arrays are passed as '{"a","b"}' literals, which
  // Postgres takes for a text[] column without a cast. Values in the lists never contain commas or quotes (they are validated first).
  function pgArray(list) {
    return '{' + (list || []).map(function (x) { return '"' + String(x).replace(/["\\]/g, '\\$&') + '"'; }).join(',') + '}';
  }
  function arrayOf(v) {
    if (Array.isArray(v)) return v.map(String);
    var s = String(v === null || v === undefined ? '' : v).replace(/^\{|\}$/g, '');
    return s ? s.split(',').map(function (x) { return x.replace(/^"|"$/g, ''); }) : [];
  }
  function isoOf(v) { return v === null || v === undefined || v === '' ? '' : v instanceof Date ? v.toISOString() : String(v); }
  function flag(v) { return v === true || String(v).toLowerCase() === 'true'; }
  function keyRow(r) {
    return { key_id: String(r.key_id), name: String(r.name || ''), hash: String(r.hash || ''), scopes: arrayOf(r.scopes), origins: arrayOf(r.origins),
      active: flag(r.active), created_at: isoOf(r.created_at), last_used_at: isoOf(r.last_used_at) };
  }
  function endpointRow(r) {
    return { id: String(r.id), url: String(r.url || ''), secret: String(r.secret || ''), events: arrayOf(r.events), active: flag(r.active),
      created_at: isoOf(r.created_at) };
  }
  function deliveryRow(r) {
    var payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
    return { id: String(r.id), endpoint_id: String(r.endpoint_id), event: String(r.event || ''), payload: payload, attempts: Number(r.attempts) || 0,
      status: String(r.status || 'pending'), next_try_at: isoOf(r.next_try_at), last_error: String(r.last_error || ''), created_at: isoOf(r.created_at),
      delivered_at: isoOf(r.delivered_at) };
  }

  /** API keys (hash, scopes, origins, active). The panel never receives the hash: Core.publicapi.keyView drops it. */
  async function findApiKey(db, hash) {
    var r = await db.query('SELECT * FROM api_keys WHERE hash = $1', [hash]);
    return r.rows && r.rows[0] ? keyRow(r.rows[0]) : null;
  }
  async function listApiKeys(db) {
    var r = await db.query('SELECT * FROM api_keys');
    return (r.rows || []).map(keyRow).sort(function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; });
  }
  async function insertApiKey(db, k) {
    await db.query('INSERT INTO api_keys (key_id, name, hash, scopes, origins, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [k.key_id, k.name, k.hash, pgArray(k.scopes), pgArray(k.origins), true, k.created_at]);
  }
  async function setApiKeyActive(db, keyId, active) {
    await db.query('UPDATE api_keys SET active = $1 WHERE key_id = $2', [active === true, keyId]);
  }
  async function touchApiKey(db, keyId, at) {
    await db.query('UPDATE api_keys SET last_used_at = $1 WHERE key_id = $2', [at, keyId]);
  }

  /** Counts one request in a one-minute window (window = its ISO start). Returns the count including this request. */
  async function bumpRateLimit(db, bucket, windowIso) {
    var r = await db.query('INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1) ' +
      'ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count', [bucket, windowIso]);
    return Number(r.rows[0].count);
  }
  async function pruneRateLimits(db, beforeIso) {
    await db.query('DELETE FROM rate_limits WHERE window_start < $1', [beforeIso]);
  }

  async function listWebhookEndpoints(db) {
    return ((await db.query('SELECT * FROM webhook_endpoints')).rows || []).map(endpointRow);
  }
  async function getWebhookEndpoint(db, id) {
    var r = await db.query('SELECT * FROM webhook_endpoints WHERE id = $1', [id]);
    return r.rows && r.rows[0] ? endpointRow(r.rows[0]) : null;
  }
  async function insertWebhookEndpoint(db, e) {
    await db.query('INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [e.id, e.url, e.secret, pgArray(e.events), e.active === true, e.created_at]);
  }
  async function updateWebhookEndpoint(db, e) {
    await db.query('UPDATE webhook_endpoints SET url = $1, events = $2, active = $3 WHERE id = $4', [e.url, pgArray(e.events), e.active === true, e.id]);
  }
  async function insertWebhookDelivery(db, d) {
    await db.query('INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, attempts, status, next_try_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [d.id, d.endpoint_id, d.event, JSON.stringify(d.payload), d.attempts, d.status, d.next_try_at, d.created_at]);
  }
  /** Deliveries, optionally only those with one status (the index covers status and next try). */
  async function listWebhookDeliveries(db, status) {
    var r = status ? await db.query('SELECT * FROM webhook_deliveries WHERE status = $1', [status])
      : await db.query('SELECT * FROM webhook_deliveries');
    return (r.rows || []).map(deliveryRow);
  }
  async function getWebhookDelivery(db, id) {
    var r = await db.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
    return r.rows && r.rows[0] ? deliveryRow(r.rows[0]) : null;
  }
  /** Claims one pending delivery for sending: one UPDATE that counts the attempt and sets a lease in next_try_at. Returns the row, or null when
   *  another run holds the lease, the row is not due or it is no longer pending. Only the run that gets a row may send it. */
  async function claimWebhookDelivery(db, id, nowIso, leaseIso) {
    var r = await db.query("UPDATE webhook_deliveries SET attempts = attempts + 1, next_try_at = $2 " +
      "WHERE id = $1 AND status = 'pending' AND next_try_at <= $3 RETURNING *", [id, leaseIso, nowIso]);
    return r.rows && r.rows[0] ? deliveryRow(r.rows[0]) : null;
  }
  async function updateWebhookDelivery(db, d) {
    await db.query('UPDATE webhook_deliveries SET attempts = $1, status = $2, next_try_at = $3, last_error = $4, delivered_at = $5 WHERE id = $6',
      [d.attempts, d.status, d.next_try_at, d.last_error || '', d.delivered_at || null, d.id]);
  }

  // ── notification outbox (notify_outbox, migration 020) ──────────────────────────────────────────
  // Rows are planned by Core.notify; these store them and move them through pending -> sending -> sent | failed. A row is claimed
  // with one UPDATE that also sets a lease in next_try_at, so only the run that claims it sends it.
  function notifyRow(r) {
    var payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
    return { id: String(r.id), channel: String(r.channel || ''), to_ref: String(r.to_ref || ''), template: String(r.template || ''), payload: payload,
      status: String(r.status || 'pending'), attempts: Number(r.attempts) || 0, next_try_at: isoOf(r.next_try_at), created_at: isoOf(r.created_at),
      sent_at: isoOf(r.sent_at), error: String(r.error || '') };
  }
  /** Queues rows; an id already queued is left alone (the dedupe key). Returns how many rows were offered. */
  async function insertNotifyRows(db, rows, nowIso) {
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      await db.query('INSERT INTO notify_outbox (id, channel, to_ref, template, payload, status, attempts, next_try_at, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING',
        [r.id, r.channel, r.to_ref, r.template, JSON.stringify(r.payload || {}), 'pending', 0, nowIso, nowIso]);
    }
    return (rows || []).length;
  }
  /** Rows due to be sent (pending, or a lease that ran out), oldest first. */
  async function listDueNotify(db, nowIso, limit) {
    var r = await db.query("SELECT * FROM notify_outbox WHERE status IN ('pending', 'sending') AND next_try_at <= $1 ORDER BY next_try_at LIMIT $2", [nowIso, limit]);
    return (r.rows || []).map(notifyRow);
  }
  /** Claims one row for sending: returns it (attempts counted, lease set) or null when another run holds it or it is not due. */
  async function claimNotify(db, id, nowIso, leaseIso) {
    var r = await db.query("UPDATE notify_outbox SET status = 'sending', attempts = attempts + 1, next_try_at = $2 " +
      "WHERE id = $1 AND status IN ('pending', 'sending') AND next_try_at <= $3 RETURNING *", [id, leaseIso, nowIso]);
    return r.rows && r.rows[0] ? notifyRow(r.rows[0]) : null;
  }
  /** Records the outcome of a claimed send: status is sent, pending (retry at nextTryIso) or failed. */
  async function finishNotify(db, id, o) {
    await db.query('UPDATE notify_outbox SET status = $2, next_try_at = $3, sent_at = $4, error = $5 WHERE id = $1',
      [id, o.status, o.nextTryIso, o.sentIso || null, o.error || '']);
  }
  async function listNotify(db) {
    return ((await db.query('SELECT * FROM notify_outbox')).rows || []).map(notifyRow);
  }

  // ---- staff (migration 016) ----
  // Staff rows are read and written only here. Role rules live in src/core/permissions.js; this is storage only.
  var STAFF_COLS = 'user_id, email, role, active, created_at';
  async function readStaff(db) {
    var res = await db.query('SELECT ' + STAFF_COLS + ' FROM staff ORDER BY created_at, email');
    return (res.rows || []).map(staffOut_);
  }
  async function readStaffMember(db, userId) {
    var res = await db.query('SELECT ' + STAFF_COLS + ' FROM staff WHERE user_id = $1', [String(userId)]);
    return res.rows && res.rows[0] ? staffOut_(res.rows[0]) : null;
  }
  async function insertStaff(db, m) {
    await db.query('INSERT INTO staff (user_id, email, role, active, created_at) VALUES ($1, $2, $3, $4, $5)',
      [String(m.userId), String(m.email || ''), String(m.role), m.active !== false, m.createdAt || new Date().toISOString()]);
  }
  async function updateStaff(db, userId, fields) {
    var sets = [], vals = [String(userId)];
    if (fields.role !== undefined) { vals.push(String(fields.role)); sets.push('role = $' + vals.length); }
    if (fields.active !== undefined) { vals.push(fields.active === true); sets.push('active = $' + vals.length); }
    if (!sets.length) return;
    await db.query('UPDATE staff SET ' + sets.join(', ') + ' WHERE user_id = $1', vals);
  }
  function staffOut_(r) {
    return { userId: String(r.user_id), email: String(r.email || ''), role: String(r.role), active: r.active === true || r.active === 't',
      createdAt: r.created_at ? String(r.created_at) : '' };
  }


  // ── account_secrets (migration 021) and the vault PIN ───────────────────────────────────────────────────
  // Only ciphertext and the IV live here. Listings never select the ciphertext.
  async function vaultListSecrets(db) {
    return (await db.query('SELECT secret_id, account_id, sale_id, sale_token, label, created, updated FROM account_secrets ORDER BY created, secret_id')).rows || [];
  }
  async function vaultGetSecret(db, secretId) {
    var r = await db.query('SELECT * FROM account_secrets WHERE secret_id = $1', [String(secretId)]);
    return r.rows && r.rows[0] ? r.rows[0] : null;
  }
  /** Inserts a secret. onConflict 'nothing' keeps an existing row (a repeated request); 'update' re-links and replaces it (a re-applied import). */
  async function vaultInsertSecret(db, s, onConflict) {
    var tail = onConflict === 'nothing' ? ' ON CONFLICT (secret_id) DO NOTHING'
      : onConflict === 'update' ? ' ON CONFLICT (secret_id) DO UPDATE SET account_id = EXCLUDED.account_id, sale_id = EXCLUDED.sale_id, sale_token = EXCLUDED.sale_token, label = EXCLUDED.label, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, updated = EXCLUDED.updated' : '';
    await db.query('INSERT INTO account_secrets (secret_id, account_id, sale_id, label, ciphertext, iv, created, updated, sale_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)' + tail,
      [s.secretId, s.accountId || '', s.saleId || '', s.label || '', s.ciphertext, s.iv, s.created || '', s.updated || '', s.saleToken || '']);
  }
  /** Backup rows: ciphertext and IV only, never plaintext. */
  async function vaultBackupSecrets(db) {
    return (await db.query('SELECT secret_id, account_id, sale_id, sale_token, label, ciphertext, iv, created, updated FROM account_secrets ORDER BY secret_id')).rows || [];
  }
  /** Failures counted since an ISO time, across the 1-minute windows of one rate_limits bucket (or every vaultfail bucket when bucket is '*'). */
  async function vaultFailCount(db, bucket, sinceIso) {
    var r = bucket === '*'
      ? await db.query("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE bucket LIKE 'vaultfail:%' AND window_start >= $1", [sinceIso])
      : await db.query('SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE bucket = $1 AND window_start >= $2', [bucket, sinceIso]);
    return Number(r.rows && r.rows[0] ? r.rows[0].n : 0);
  }
  async function vaultUpdateSecret(db, s) {
    await db.query('UPDATE account_secrets SET label = $2, ciphertext = $3, iv = $4, updated = $5 WHERE secret_id = $1',
      [s.secretId, s.label || '', s.ciphertext, s.iv, s.updated || '']);
  }
  async function vaultDeleteSecret(db, secretId) {
    await db.query('DELETE FROM account_secrets WHERE secret_id = $1', [String(secretId)]);
  }
  async function listDeliveryTemplates(db) {
    return ((await db.query('SELECT * FROM delivery_templates ORDER BY title, template_id')).rows || []).map(templateOut_);
  }
  async function getDeliveryTemplate(db, id) {
    var r = await db.query('SELECT * FROM delivery_templates WHERE template_id = $1', [String(id)]);
    return r.rows && r.rows[0] ? templateOut_(r.rows[0]) : null;
  }
  async function saveDeliveryTemplate(db, t, isNew) {
    if (isNew) await db.query('INSERT INTO delivery_templates (template_id, product_id, account_id, title, body, updated) VALUES ($1, $2, $3, $4, $5, $6)',
      [t.templateId, t.productId || '', t.accountId || '', t.title, t.body, t.updated || '']);
    else await db.query('UPDATE delivery_templates SET product_id = $2, account_id = $3, title = $4, body = $5, updated = $6 WHERE template_id = $1',
      [t.templateId, t.productId || '', t.accountId || '', t.title, t.body, t.updated || '']);
  }
  async function deleteDeliveryTemplate(db, id) { await db.query('DELETE FROM delivery_templates WHERE template_id = $1', [String(id)]); }
  function templateOut_(r) {
    return { templateId: String(r.template_id), productId: String(r.product_id || ''), accountId: String(r.account_id || ''), title: String(r.title || ''), body: String(r.body || ''), updated: String(r.updated || '') };
  }
  async function readVaultPinHash(db) {
    var r = await db.query('SELECT * FROM settings WHERE key = $1', [VAULT_PIN_KEY]);
    return r.rows && r.rows[0] ? String(r.rows[0].value || '') : '';
  }
  async function writeVaultPinHash(db, hash) {
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [VAULT_PIN_KEY, String(hash)]);
  }
  /** The end of an active PIN lockout for this actor (ISO), or '' when not locked. A lock is a rate_limits row whose window_start is the end. */
  async function vaultLockedUntil(db, actor, nowIso) {
    var r = await db.query('SELECT window_start FROM rate_limits WHERE bucket = $1 AND window_start > $2 ORDER BY window_start DESC LIMIT 1', ['vaultlock:' + actor, nowIso]);
    return r.rows && r.rows[0] ? new Date(r.rows[0].window_start).toISOString() : '';
  }
  async function vaultSetLock(db, actor, untilIso) {
    await db.query('INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count', ['vaultlock:' + actor, untilIso]);
  }

  /** Audit lines for a change that is not a sheet cell (staff). Same change_log as every write; Undo does not reverse them. */
  async function logAudit(db, action, lines) {
    return writeChangeLog(db, { batchId: batchIdFor_(), action: action, actor: (db && db.actor) || '' }, lines.map(function (l) {
      return { tab: l.tab, rowKey: l.rowKey, field: l.field, old: l.old, new: l.new };
    }));
  }
  function batchIdFor_() { return 'staff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }

  return { TABS: TABS, SPEC: SPEC, logAudit: logAudit, readStaff: readStaff, readStaffMember: readStaffMember, insertStaff: insertStaff, updateStaff: updateStaff, readChangeLogFor: readChangeLogFor, readRecentChangeLog: readRecentChangeLog, readState: readState, readTab: readTab, readTabWhere: readTabWhere, readSettings: readSettings, applyOps: applyOps, readVersion: readVersion,
           readLastBatch: readLastBatch, headerFor: headerFor, fieldFor: fieldFor,
           findApiKey: findApiKey, listApiKeys: listApiKeys, insertApiKey: insertApiKey, setApiKeyActive: setApiKeyActive, touchApiKey: touchApiKey,
           bumpRateLimit: bumpRateLimit, pruneRateLimits: pruneRateLimits,
           listWebhookEndpoints: listWebhookEndpoints, getWebhookEndpoint: getWebhookEndpoint, insertWebhookEndpoint: insertWebhookEndpoint,
           updateWebhookEndpoint: updateWebhookEndpoint, insertWebhookDelivery: insertWebhookDelivery, listWebhookDeliveries: listWebhookDeliveries,
           getWebhookDelivery: getWebhookDelivery, claimWebhookDelivery: claimWebhookDelivery, updateWebhookDelivery: updateWebhookDelivery,
           listDeliveryTemplates: listDeliveryTemplates, getDeliveryTemplate: getDeliveryTemplate, saveDeliveryTemplate: saveDeliveryTemplate, deleteDeliveryTemplate: deleteDeliveryTemplate,
           vaultListSecrets: vaultListSecrets, vaultGetSecret: vaultGetSecret, vaultInsertSecret: vaultInsertSecret, vaultUpdateSecret: vaultUpdateSecret,
           vaultDeleteSecret: vaultDeleteSecret, vaultBackupSecrets: vaultBackupSecrets, vaultFailCount: vaultFailCount, readVaultPinHash: readVaultPinHash, writeVaultPinHash: writeVaultPinHash, vaultLockedUntil: vaultLockedUntil, vaultSetLock: vaultSetLock,
           insertNotifyRows: insertNotifyRows, listDueNotify: listDueNotify, claimNotify: claimNotify, finishNotify: finishNotify, listNotify: listNotify };
})();
if (typeof module !== 'undefined') module.exports = Adapter;

// In-memory stand-in for the Edge Function's `db` ({ query(text, params) -> {rows}, transaction(fn) }).
// Regex based: it understands only the SQL forms the adapter and tests send. Anything else throws
// `unhandled SQL: <text>` so a new statement form fails loudly instead of silently returning nothing.
const all_ = tbl => (Array.isArray(tbl) ? tbl : Array.from(tbl.values()));
// Column a Map table is keyed on when it is not the first inserted column.
const KEY_COL = { payment_inbox: 'transaction_id', pay_intents: 'token' };
function makeFakeDb() {
  const tables = {
    settings: new Map([['bkash_number', '01711111111'], ['language', 'en'], ['reminder_days_before', '3'],
                       ['reminder_days_after', '2'], ['due_reminder_every_days', '5'], ['grace_days', '3'],
                       // Rows migration 008 inserts, so Settings updates find them as they do in the live database.
                       ['pay_methods', 'bkash'], ['nagad_number', ''], ['upay_number', ''], ['bank_name', ''], ['bank_account_name', ''],
                       ['bank_account_number', ''], ['bank_branch', ''], ['bank_note', ''], ['bank_routing', ''], ['pay_auto_verify', 'bkash,upay'],
                       // Rows migration 011 inserts.
                       ['tos_text', ''], ['review_discord_url', ''], ['review_facebook_url', ''], ['pay_link_expiry_hours', '24'], ['delivery_note', ''],
                       ['money_layout', 'net,trend,cash,dues,products,forecast'],
                       // Test default: legacy references, so existing tests keep N54-style codes (migration 013 sets random in production).
                       ['ref_style', 'legacy'],
                       // Row migration 014 inserts.
                       ['migration_panel', 'on'],
                       // Row migration 017 inserts.
                       ['relay_heartbeat', '']]),
    customers: new Map(), sales: new Map(), payments: new Map(), expenses: new Map(), purchases: new Map(),
    accounts: new Map([['EXL-01', { account_id: 'EXL-01', product_id: 'EXITLAG', account_label: 'Main', cycle_cost: 2000, renewal_date: '2026-11-01', slots: 5, notes: '', account_status: 'Active' }]]),
    wallets: new Map(), products: new Map([['EXITLAG', { product_id: 'EXITLAG', product_name: 'ExitLag', category: 'Gaming', platform: 'PC', billing_cycle_days: 30, account_cost: 2000, slots_per_account: 5, code_unit_cost: 0, default_price: 500, active: 'Yes', letter: 'E', delivers_as: 'account', parent_id: '' }]]),
    codes: new Map(), payment_inbox: new Map(), reminders_log: [], change_log: [], request_log: new Map(),
    suppliers: new Map(), live_rates: new Map(), profit_snapshots: new Map(), pay_intents: new Map(),
    pay_requests: new Map(), deliveries: new Map(),
    goals: new Map(), budgets: new Map(), import_rows: new Map(), orders: new Map(),
    // Public API tables (migration 019). rate_limits is keyed by bucket and window (see its handler below).
    api_keys: new Map(), rate_limits: new Map(), webhook_endpoints: new Map(), webhook_deliveries: new Map(),
    // Notification outbox (migration 020). Keyed by id, the dedupe key.
    notify_outbox: new Map(),
    // Login details vault (migration 021). Keyed by secret_id.
    account_secrets: new Map(), delivery_templates: new Map(),
    job_runs: [], staff: new Map()
  };

  // db.stats: statements = query() calls, rows = rows returned, roundTrips = statements + BEGIN/COMMIT per transaction.
  // Cheap to keep always on; tools/measure.js reads it, resetting with db.resetStats().
  // Queries started while another is still in flight share its round trip (a pool or a pipelined connection sends them together).
  const stats = { statements: 0, roundTrips: 0, rows: 0 };
  let inFlight = 0;
  const run = async (text, params) => {
      params = params || [];
      const clean = text.replace(/\s+/g, ' ').trim();
      // Notification outbox (migration 020): queue with dedupe, due list, claim with a lease, and the outcome of a send.
      if (/^INSERT INTO notify_outbox \(.+\) VALUES \(.+\) ON CONFLICT \(id\) DO NOTHING$/i.test(clean)) {
        const id = String(params[0]);
        if (!tables.notify_outbox.has(id)) {
          tables.notify_outbox.set(id, { id: id, channel: params[1], to_ref: params[2], template: params[3], payload: params[4], status: params[5],
            attempts: params[6], next_try_at: params[7], created_at: params[8], sent_at: null, error: '' });
        }
        return { rows: [] };
      }
      if (/^SELECT \* FROM notify_outbox WHERE status IN \('pending', 'sending'\) AND next_try_at <= \$1 ORDER BY next_try_at LIMIT \$2$/i.test(clean)) {
        const due = all_(tables.notify_outbox).filter(r => (r.status === 'pending' || r.status === 'sending') && String(r.next_try_at) <= String(params[0]));
        return { rows: due.sort((a, b) => (a.next_try_at < b.next_try_at ? -1 : 1)).slice(0, Number(params[1])).map(r => Object.assign({}, r)) };
      }
      if (/^UPDATE notify_outbox SET status = 'sending', attempts = attempts \+ 1, next_try_at = \$2 WHERE id = \$1 AND status IN \('pending', 'sending'\) AND next_try_at <= \$3 RETURNING \*$/i.test(clean)) {
        const row = tables.notify_outbox.get(String(params[0]));
        if (!row || !(row.status === 'pending' || row.status === 'sending') || String(row.next_try_at) > String(params[2])) return { rows: [] };
        row.status = 'sending'; row.attempts = row.attempts + 1; row.next_try_at = params[1];
        return { rows: [Object.assign({}, row)] };
      }
      if (/^UPDATE notify_outbox SET status = \$2, next_try_at = \$3, sent_at = \$4, error = \$5 WHERE id = \$1$/i.test(clean)) {
        const row = tables.notify_outbox.get(String(params[0]));
        if (!row) throw new Error('Not found');
        Object.assign(row, { status: params[1], next_try_at: params[2], sent_at: params[3], error: params[4] });
        return { rows: [] };
      }
      if (/^UPDATE webhook_deliveries SET attempts = attempts \+ 1, next_try_at = \$2 WHERE id = \$1 AND status = 'pending' AND next_try_at <= \$3 RETURNING \*$/i.test(clean)) {
        const row = tables.webhook_deliveries.get(String(params[0]));
        if (!row || row.status !== 'pending' || (row.next_try_at && String(row.next_try_at) > String(params[2]))) return { rows: [] };
        row.attempts = row.attempts + 1; row.next_try_at = params[1];
        return { rows: [Object.assign({}, row)] };
      }
      if (/^SELECT key, value FROM settings/i.test(clean)) {
        return { rows: Array.from(tables.settings.entries()).map(([k, v]) => ({ key: k, value: v })) };
      }
      // Vault (migration 021): the listing names its columns (never the ciphertext); a lock is a rate_limits row whose window_start is the end of the lockout.
      if (/^SELECT secret_id, account_id, sale_id, sale_token, label, created, updated FROM account_secrets ORDER BY created, secret_id$/i.test(clean)) {
        return { rows: all_(tables.account_secrets).map(r => ({ secret_id: r.secret_id, account_id: r.account_id, sale_id: r.sale_id, sale_token: r.sale_token || '', label: r.label, created: r.created, updated: r.updated })) };
      }
      if (/^SELECT secret_id, account_id, sale_id, sale_token, label, ciphertext, iv, created, updated FROM account_secrets ORDER BY secret_id$/i.test(clean)) {
        return { rows: all_(tables.account_secrets).map(r => Object.assign({}, r)).sort((a, b) => (a.secret_id < b.secret_id ? -1 : 1)) };
      }
      if (/^SELECT COALESCE\(SUM\(count\), 0\) AS n FROM rate_limits WHERE bucket LIKE 'vaultfail:%' AND window_start >= \$1$/i.test(clean)) {
        return { rows: [{ n: all_(tables.rate_limits).filter(r => r.bucket.indexOf('vaultfail:') === 0 && String(r.window_start) >= String(params[0])).reduce((s, r) => s + r.count, 0) }] };
      }
      if (/^SELECT COALESCE\(SUM\(count\), 0\) AS n FROM rate_limits WHERE bucket = \$1 AND window_start >= \$2$/i.test(clean)) {
        return { rows: [{ n: all_(tables.rate_limits).filter(r => r.bucket === String(params[0]) && String(r.window_start) >= String(params[1])).reduce((s, r) => s + r.count, 0) }] };
      }
      if (/^INSERT INTO account_secrets \(.+\) VALUES \(.+\) ON CONFLICT \(secret_id\) DO (NOTHING|UPDATE SET .+)$/i.test(clean)) {
        const id = String(params[0]);
        if (tables.account_secrets.has(id) && /DO NOTHING$/i.test(clean)) return { rows: [] };
        const old = tables.account_secrets.get(id);
        tables.account_secrets.set(id, { secret_id: id, account_id: params[1], sale_id: params[2], label: params[3], ciphertext: params[4], iv: params[5], created: old ? old.created : params[6], updated: params[7], sale_token: params[8] || '' });
        return { rows: [] };
      }
      if (/^SELECT window_start FROM rate_limits WHERE bucket = \$1 AND window_start > \$2 ORDER BY window_start DESC LIMIT 1$/i.test(clean)) {
        const rows = all_(tables.rate_limits).filter(r => r.bucket === String(params[0]) && String(r.window_start) > String(params[1])).sort((a, b) => (a.window_start < b.window_start ? 1 : -1));
        return { rows: rows.slice(0, 1).map(r => ({ window_start: r.window_start })) };
      }
      // Adapter.readVersion: one row of change markers (see VERSION_SQL in postgres.js). Computed here from the in-memory tables.
      if (/^SELECT \(SELECT coalesce\(max\(id\), ?0\) FROM change_log\) AS log_id/i.test(clean)) {
        const inbox = all_(tables.payment_inbox), intents = all_(tables.pay_intents), rates = all_(tables.live_rates);
        const maxStr = (rows, c) => rows.reduce((m, r) => (String(r[c]) > m ? String(r[c]) : m), '');
        const rate = rates.filter(r => r.id === 'usdt_bdt')[0] || rates[0];
        const hash = Array.from(tables.settings.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('|');
        return { rows: [{
          log_id: tables.change_log.reduce((m, r) => Math.max(m, r.id || 0), 0),
          inbox_n: inbox.length, inbox_max: maxStr(inbox, 'received'),
          settings_h: hash,
          intents_h: intents.slice().sort((a, b) => (a.token < b.token ? -1 : 1)).map(r => [r.token, r.method, r.payer_number, r.claim_trx, r.claimed, r.updated].join('~')).join('|'),
          rem_n: tables.reminders_log.length, rem_max: tables.reminders_log.reduce((m, r) => Math.max(m, r.id || 0), 0),
          rate_h: rates.map(r => r.id + '=' + r.rate + '@' + r.fetched_at).join('|'),
          rate_epoch: rate && rate.fetched_at ? Date.parse(rate.fetched_at) / 1000 : 0,
          open_expires: all_(tables.pay_requests).filter(r => r.status === 'Open').map(r => r.expires).join('|')
        }] };
      }
      const reqSel = clean.match(/^SELECT response FROM request_log WHERE request_id = \$1$/i);
      if (reqSel) {
        const row = tables.request_log.get(String(params[0]));
        return { rows: row ? [{ response: row.response }] : [] };
      }
      // Migration 017 forms: the latest job_runs row per job, and the two retention deletes (RETURNING the deleted keys).
      if (/^SELECT DISTINCT ON \(job\) job, started_at, finished_at, ok, detail FROM job_runs ORDER BY job, id DESC$/i.test(clean)) {
        const latest = {};
        tables.job_runs.forEach(r => { if (!latest[r.job] || r.id > latest[r.job].id) latest[r.job] = r; });
        return { rows: Object.keys(latest).map(k => Object.assign({}, latest[k])) };
      }
      if (/^DELETE FROM request_log WHERE created_at < \$1::timestamptz RETURNING request_id$/i.test(clean)) {
        const cut = String(params[0]);
        const gone = Array.from(tables.request_log.values()).filter(r => String(r.created_at) < cut);
        gone.forEach(r => tables.request_log.delete(r.request_id));
        return { rows: gone.map(r => ({ request_id: r.request_id })) };
      }
      if (/^DELETE FROM job_runs WHERE started_at < \$1 RETURNING id$/i.test(clean)) {
        const cut = String(params[0]);
        const gone = tables.job_runs.filter(r => String(r.started_at) < cut);
        tables.job_runs = tables.job_runs.filter(r => !gone.includes(r));
        return { rows: gone.map(r => ({ id: r.id })) };
      }
      if (/^INSERT INTO request_log \(request_id, ?response\) VALUES \(\$1, ?\$2\) ON CONFLICT \(request_id\) DO NOTHING$/i.test(clean)) {
        const id = String(params[0]);
        if (!tables.request_log.has(id)) tables.request_log.set(id, { request_id: id, response: params[1], created_at: new Date().toISOString() });
        return { rows: [] };
      }
      if (/^INSERT INTO settings \(key, ?value\) VALUES \(\$1, ?\$2\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value$/i.test(clean)) {
        tables.settings.set(String(params[0]), params[1]);
        return { rows: [] };
      }
      if (/^SELECT 1 FROM payment_inbox WHERE transaction_id = \$1 LIMIT 1$/i.test(clean)) {
        return { rows: all_(tables.payment_inbox).filter(r => String(r.transaction_id) === String(params[0])).slice(0, 1).map(() => ({ '?column?': 1 })) };
      }
      // Settings is a key -> value Map of plain strings, so row-shaped reads and updates are mapped by hand.
      if (/^SELECT \* FROM settings WHERE key = \$1/i.test(clean)) {
        const k = String(params[0]);
        return { rows: tables.settings.has(k) ? [{ key: k, value: tables.settings.get(k) }] : [] };
      }
      const setUpd = clean.match(/^UPDATE settings SET value = \$1 WHERE key = \$2/i);
      if (setUpd) {
        const k = String(params[1]);
        if (!tables.settings.has(k)) throw new Error('Not found');
        tables.settings.set(k, params[0]);
        return { rows: [{ key: k, value: params[0] }] };
      }
      if (/^INSERT INTO pay_intents \(token, method, payer_number, claim_trx, claimed, created, updated\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\) ON CONFLICT \(token\) DO UPDATE SET/i.test(clean)) {
        const old = tables.pay_intents.get(String(params[0]));
        tables.pay_intents.set(String(params[0]), { token: params[0], method: params[1], payer_number: params[2], claim_trx: params[3],
          claimed: params[4], created: old ? old.created : params[5], updated: params[6] });
        return { rows: [] };
      }
      if (/^SELECT pg_advisory_xact_lock\(\$1\)$/i.test(clean)) {
        db.lockCalls = (db.lockCalls || 0) + 1;
        return { rows: [] };
      }
      // Staff reads name their columns (Adapter.readStaff and readStaffMember); the rows come from the staff Map.
      const staffSel = clean.match(/^SELECT [a-z_, ]+ FROM staff(?: WHERE user_id = \$1)?(?: ORDER BY [a-z_, ]+)?$/i);
      if (staffSel) {
        let rows = all_(tables.staff);
        if (/WHERE user_id = \$1/.test(clean)) rows = rows.filter(r => String(r.user_id) === String(params[0]));
        return { rows: rows.map(r => Object.assign({}, r)).sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1)) };
      }
      const upSel = clean.match(/^SELECT \* FROM ([a-z_]+) WHERE upper\(([a-z_]+)\) = \$1$/i);
      if (upSel) {
        const rows = all_(tables[upSel[1]]).filter(r => String(r[upSel[2]] || '').toUpperCase() === String(params[0]));
        return { rows: rows.map(r => Object.assign({}, r)) };
      }
      // Rate-limit counter (Adapter.bumpRateLimit): one row per bucket and window; the count goes up by one and comes back.
      if (/^INSERT INTO rate_limits \(bucket, window_start, count\) VALUES \(\$1, \$2, 1\) ON CONFLICT \(bucket, window_start\) DO UPDATE SET count = rate_limits\.count \+ 1 RETURNING count$/i.test(clean)) {
        const k = String(params[0]) + '|' + String(params[1]);
        const row = tables.rate_limits.get(k) || { bucket: String(params[0]), window_start: String(params[1]), count: 0 };
        row.count += 1;
        tables.rate_limits.set(k, row);
        return { rows: [{ count: row.count }] };
      }
      if (/^DELETE FROM rate_limits WHERE window_start < \$1$/i.test(clean)) {
        for (const [k, r] of Array.from(tables.rate_limits.entries())) if (r.window_start < String(params[0])) tables.rate_limits.delete(k);
        return { rows: [] };
      }
      // Adapter.readRecentChangeLog: the newest $1 rows. Honours the limit, so a bounded read shows up in db.stats.rows.
      if (/^SELECT \* FROM change_log ORDER BY id DESC LIMIT \$1$/i.test(clean)) {
        return { rows: tables.change_log.slice().sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, Number(params[0])).map(r => Object.assign({}, r)) };
      }
      if (/^SELECT \* FROM change_log WHERE tab = \$1 AND row_key = \$2 ORDER BY id DESC LIMIT 50$/i.test(clean)) {
        return { rows: tables.change_log.filter(r => r.tab === params[0] && String(r.row_key) === String(params[1])).reverse().slice(0, 50).map(r => Object.assign({}, r)) };
      }
      const sel = clean.match(/^SELECT \* FROM ([a-z_]+)(?: WHERE ([a-z_]+) = \$1)?/i);
      if (sel) {
        const tbl = tables[sel[1]];
        if (!tbl) throw new Error('no table ' + sel[1]);
        let rows = Array.isArray(tbl) ? tbl.slice() : Array.from(tbl.values());
        if (sel[2]) rows = rows.filter(r => String(r[sel[2]]) === String(params[0]));
        // Copies, like a real driver: a later UPDATE must not change rows already read.
        return { rows: rows.map(r => Object.assign({}, r)) };
      }
      // Settings is a key -> value Map (see SELECT key, value above), so a plain insert stores the pair.
      // (reminders_log is an array: many rows share a sale or a date, so no single column is a key.)
      const setIns = clean.match(/^INSERT INTO settings \(key, ?value\) VALUES \(\$1, ?\$2\)$/i);
      if (setIns) {
        tables.settings.set(String(params[0]), params[1]);
        return { rows: [{ key: String(params[0]), value: params[1] }] };
      }
      const ins = clean.match(/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \(([^)]+)\)/i);
      if (ins) {
        const tbl = tables[ins[1]];
        const cols = ins[2].split(',').map(s => s.trim());
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        // Mirrors the live schema: payments.customer_id is NOT NULL with a foreign key to customers.
        if (ins[1] === 'payments') {
          const cid = String(row.customer_id == null ? '' : row.customer_id);
          if (!cid || !tables.customers.has(cid)) throw new Error('insert or update on table "payments" violates foreign key constraint "payments_customer_id_fkey"');
        }
        if (Array.isArray(tbl)) { row.id = tbl.length + 1; tbl.push(row); }
        else {
          tbl.set(String(row[KEY_COL[ins[1]] || cols[0]]), row);
        }
        return { rows: [row] };
      }
      const upd = clean.match(/^UPDATE ([a-z_]+) SET (.+) WHERE ([a-z_]+) = \$(\d+)/i);
      if (upd) {
        const tbl = tables[upd[1]];
        const sets = upd[2].split(',').map(s => s.trim().split(' = '));
        const whereVal = params[Number(upd[4]) - 1];
        const row = tbl.get(String(whereVal));
        if (!row) throw new Error('Not found');
        sets.forEach(([col, ph]) => {
          const idx = Number(ph.replace('$', '')) - 1;
          row[col] = params[idx];
        });
        return { rows: [row] };
      }
      const del = clean.match(/^DELETE FROM ([a-z_]+) WHERE ([a-z_]+) = \$1/i);
      if (del) {
        const tbl = tables[del[1]];
        tbl.delete(String(params[0]));
        return { rows: [] };
      }
      throw new Error('unhandled SQL: ' + clean);
  };
  const db = {
    stats,
    resetStats: () => { stats.statements = 0; stats.roundTrips = 0; stats.rows = 0; },
    query: async (text, params) => {
      stats.statements++;
      if (inFlight === 0) stats.roundTrips++;
      inFlight++;
      let res;
      try { res = await run(text, params); } finally { inFlight--; }
      stats.rows += (res && res.rows ? res.rows.length : 0);
      return res;
    },
    transaction: async (fn) => { stats.roundTrips += 2; return fn(db); }
  };
  return { db, tables };
}

module.exports = { makeFakeDb };

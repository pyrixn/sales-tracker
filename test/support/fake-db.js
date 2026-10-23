// In-memory stand-in for the Edge Function's `db` ({ query(text, params) -> {rows}, transaction(fn) }).
// Regex based: it understands only the SQL forms the adapter and tests send. Anything else throws
// `unhandled SQL: <text>` so a new statement form fails loudly instead of silently returning nothing.
const all_ = tbl => (Array.isArray(tbl) ? tbl : Array.from(tbl.values()));
// Column a Map table is keyed on when it is not the first inserted column.
const KEY_COL = { payment_inbox: 'transaction_id' };
function makeFakeDb() {
  const tables = {
    settings: new Map([['bkash_number', '01711111111'], ['language', 'en'], ['reminder_days_before', '3'],
                       ['reminder_days_after', '2'], ['due_reminder_every_days', '5'], ['grace_days', '3']]),
    customers: new Map(), sales: new Map(), payments: new Map(), expenses: new Map(), purchases: new Map(),
    accounts: new Map([['EXL-01', { account_id: 'EXL-01', product_id: 'EXITLAG', account_label: 'Main', cycle_cost: 2000, renewal_date: '2026-11-01', slots: 5, notes: '', account_status: 'Active' }]]),
    wallets: new Map(), products: new Map([['EXITLAG', { product_id: 'EXITLAG', product_name: 'ExitLag', category: 'Gaming', platform: 'PC', billing_cycle_days: 30, account_cost: 2000, slots_per_account: 5, code_unit_cost: 0, default_price: 500, active: 'Yes', letter: 'E' }]]),
    codes: new Map(), payment_inbox: new Map(), reminders_log: [], change_log: [], request_log: new Map(),
    suppliers: new Map(), live_rates: new Map(), profit_snapshots: new Map()
  };

  const db = {
    query: async (text, params) => {
      params = params || [];
      const clean = text.replace(/\s+/g, ' ').trim();
      if (/^SELECT key, value FROM settings/i.test(clean)) {
        return { rows: Array.from(tables.settings.entries()).map(([k, v]) => ({ key: k, value: v })) };
      }
      const reqSel = clean.match(/^SELECT response FROM request_log WHERE request_id = \$1$/i);
      if (reqSel) {
        const row = tables.request_log.get(String(params[0]));
        return { rows: row ? [{ response: row.response }] : [] };
      }
      if (/^INSERT INTO request_log \(request_id, ?response\) VALUES \(\$1, ?\$2\) ON CONFLICT \(request_id\) DO NOTHING$/i.test(clean)) {
        const id = String(params[0]);
        if (!tables.request_log.has(id)) tables.request_log.set(id, { request_id: id, response: params[1] });
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
      if (/^SELECT pg_advisory_xact_lock\(\$1\)$/i.test(clean)) {
        db.lockCalls = (db.lockCalls || 0) + 1;
        return { rows: [] };
      }
      const upSel = clean.match(/^SELECT \* FROM ([a-z_]+) WHERE upper\(([a-z_]+)\) = \$1$/i);
      if (upSel) {
        const rows = all_(tables[upSel[1]]).filter(r => String(r[upSel[2]] || '').toUpperCase() === String(params[0]));
        return { rows: rows.map(r => Object.assign({}, r)) };
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
    },
    transaction: async (fn) => fn(db)
  };
  return { db, tables };
}

module.exports = { makeFakeDb };

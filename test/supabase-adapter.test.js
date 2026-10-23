const test = require('node:test');
const assert = require('node:assert/strict');
const Adapter = require('../src/adapters/postgres.js');

// Mock Supabase client to test makeSupabaseDb wrapper
function makeMockSupabase() {
  const tables = {
    settings: [{ key: 'bkash_number', value: '01711111111' }, { key: 'language', value: 'en' },
               { key: 'reminder_days_before', value: '3' }, { key: 'reminder_days_after', value: '2' },
               { key: 'due_reminder_every_days', value: '5' }, { key: 'grace_days', value: '3' }],
    customers: [], sales: [], payments: [], expenses: [], purchases: [],
    accounts: [{ account_id: 'EXL-01', product_id: 'EXITLAG', account_label: 'Main', cycle_cost: 2000, renewal_date: '2026-11-01', slots: 5, notes: '', account_status: 'Active' }],
    wallets: [], products: [{ product_id: 'EXITLAG', product_name: 'ExitLag', category: 'Gaming', platform: 'PC', billing_cycle_days: 30, account_cost: 2000, slots_per_account: 5, code_unit_cost: 0, default_price: 500, active: 'Yes', letter: 'E' }],
    codes: [], payment_inbox: [], reminders_log: [], change_log: [], request_log: []
  };

  return {
    from: (table) => {
      let filterCol = null, filterVal = null;
      let limitCount = null;
      let orderCol = null;

      const builder = {
        select: (cols) => builder,
        eq: (col, val) => { filterCol = col; filterVal = String(val); return builder; },
        order: (col) => { orderCol = col; return builder; },
        limit: (n) => { limitCount = n; return builder; },
        then: (resolve) => {
          let list = (tables[table] || []).slice();
          if (filterCol) list = list.filter(r => String(r[filterCol]) === filterVal);
          if (limitCount) list = list.slice(0, limitCount);
          resolve({ data: list, error: null });
        },
        insert: async (row) => {
          tables[table] = tables[table] || [];
          if (Array.isArray(row)) tables[table].push(...row);
          else tables[table].push(row);
          return { data: row, error: null };
        },
        upsert: async (row, opts) => {
          tables[table] = tables[table] || [];
          const pk = opts && opts.onConflict ? opts.onConflict : 'key';
          const existing = tables[table].find(r => String(r[pk]) === String(row[pk]));
          if (existing) {
            if (!opts || !opts.ignoreDuplicates) Object.assign(existing, row);
          } else {
            tables[table].push(row);
          }
          return { data: row, error: null };
        },
        update: (updates) => ({
          eq: async (col, val) => {
            const list = tables[table] || [];
            const row = list.find(r => String(r[col]) === String(val));
            if (row) Object.assign(row, updates);
            return { data: row, error: null };
          }
        }),
        delete: () => ({
          eq: async (col, val) => {
            tables[table] = (tables[table] || []).filter(r => String(r[col]) !== String(val));
            return { data: null, error: null };
          }
        })
      };
      return builder;
    },
    _tables: tables
  };
}

function makeSupabaseDb(supabase) {
  const db = {
    query: async (text, params) => {
      params = params || [];
      const clean = text.replace(/\s+/g, ' ').trim();

      // 1. SELECT * FROM table WHERE col = $1
      let m = clean.match(/^SELECT \* FROM ([a-z_]+) WHERE ([a-z_]+) = \$1/i);
      if (m) {
        const r = await supabase.from(m[1]).select('*').eq(m[2], params[0]);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: r.data || [] };
      }

      // 2. SELECT * FROM table (optional ORDER BY)
      m = clean.match(/^SELECT \* FROM ([a-z_]+)(?: ORDER BY ([a-z_]+))?/i);
      if (m) {
        let q = supabase.from(m[1]).select('*');
        if (m[2]) q = q.order(m[2]);
        const r = await q;
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: r.data || [] };
      }

      // 3. SELECT key, value FROM settings
      if (/^SELECT key, value FROM settings/i.test(clean)) {
        const r = await supabase.from('settings').select('key, value');
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: r.data || [] };
      }

      // 4. SELECT response FROM request_log WHERE request_id = $1
      m = clean.match(/^SELECT response FROM request_log WHERE request_id = \$1/i);
      if (m) {
        const r = await supabase.from('request_log').select('response').eq('request_id', params[0]);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: r.data || [] };
      }

      // 5. SELECT 1 FROM payment_inbox WHERE transaction_id = $1 LIMIT 1
      m = clean.match(/^SELECT 1 FROM payment_inbox WHERE transaction_id = \$1 LIMIT 1/i);
      if (m) {
        const r = await supabase.from('payment_inbox').select('id').eq('transaction_id', params[0]).limit(1);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: (r.data && r.data.length) ? [{ exists: 1 }] : [] };
      }

      // 6. SELECT 1 FROM payment_inbox WHERE raw_sms = $1 AND transaction_id = '' LIMIT 1
      m = clean.match(/^SELECT 1 FROM payment_inbox WHERE raw_sms = \$1 AND transaction_id = '' LIMIT 1/i);
      if (m) {
        const r = await supabase.from('payment_inbox').select('id').eq('raw_sms', params[0]).eq('transaction_id', '').limit(1);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: (r.data && r.data.length) ? [{ exists: 1 }] : [] };
      }

      // 7. INSERT INTO settings ... ON CONFLICT
      if (/^INSERT INTO settings/i.test(clean)) {
        const r = await supabase.from('settings').upsert({ key: params[0], value: String(params[1]) }, { onConflict: 'key' });
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: [] };
      }

      // 8. INSERT INTO request_log ... ON CONFLICT
      if (/^INSERT INTO request_log/i.test(clean)) {
        const r = await supabase.from('request_log').upsert({ request_id: params[0], response: params[1] }, { onConflict: 'request_id', ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: [] };
      }

      // 9. INSERT INTO table (cols...) VALUES ($1, $2...)
      m = clean.match(/^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES/i);
      if (m) {
        const table = m[1];
        const cols = m[2].split(',').map(s => s.trim());
        const row = {};
        cols.forEach((c, idx) => { row[c] = params[idx]; });
        const r = await supabase.from(table).insert(row);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: [] };
      }

      // 10. UPDATE table SET ... WHERE col = $N
      m = clean.match(/^UPDATE ([a-z_]+) SET (.+) WHERE ([a-z_]+) = \$(\d+)/i);
      if (m) {
        const table = m[1];
        const sets = m[2].split(',').map(s => s.trim());
        const whereCol = m[3];
        const whereIdx = Number(m[4]) - 1;
        const updates = {};
        sets.forEach(s => {
          const parts = s.split('=').map(p => p.trim());
          const col = parts[0];
          const paramIdx = Number(parts[1].replace('$', '')) - 1;
          updates[col] = params[paramIdx];
        });
        const r = await supabase.from(table).update(updates).eq(whereCol, params[whereIdx]);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: [] };
      }

      // 11. DELETE FROM table WHERE col = $1
      m = clean.match(/^DELETE FROM ([a-z_]+) WHERE ([a-z_]+) = \$1/i);
      if (m) {
        const r = await supabase.from(m[1]).delete().eq(m[2], params[0]);
        if (r.error) throw new Error(r.error.message || r.error);
        return { rows: [] };
      }

      throw new Error('Unsupported SQL: ' + clean);
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

test('makeSupabaseDb adapter: readState shape', async () => {
  const mock = makeMockSupabase();
  const db = makeSupabaseDb(mock);
  const st = await Adapter.readState(db, '2026-10-21');
  assert.equal(st.today, '2026-10-21');
  assert.equal(st.settings.bkash_number, '01711111111');
  assert.equal(st.settings.reminder_days_before, 3);
  assert.equal(st.accounts.length, 1);
  assert.equal(st.accounts[0].Cost_Per_Slot, 400);
});

test('makeSupabaseDb adapter: append, update, clear, change_log', async () => {
  const mock = makeMockSupabase();
  const db = makeSupabaseDb(mock);
  await Adapter.applyOps(db, [
    { op: 'append', tab: 'Customers', values: { Customer_ID: 'CU-0001', Name: 'Alice', Channel: 'WhatsApp', Handle: '01700000001', Created: '2026-10-21' } }
  ], { batchId: 'b1', action: 'newCustomer' });
  assert.equal(mock._tables.customers.length, 1);
  assert.equal(mock._tables.customers[0].name, 'Alice');

  await Adapter.applyOps(db, [
    { op: 'update', tab: 'Customers', id: 'CU-0001', values: { Name: 'Alice Updated' } }
  ], { batchId: 'b2', action: 'editCust' });
  assert.equal(mock._tables.customers[0].name, 'Alice Updated');

  assert.equal(mock._tables.change_log.length, 2);

  await Adapter.applyOps(db, [
    { op: 'clear', tab: 'Customers', id: 'CU-0001' }
  ], { batchId: 'b3', action: 'undo' });
  assert.equal(mock._tables.customers.length, 0);
});

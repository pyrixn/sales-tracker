#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const fix = require('../test/fixtures');

const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
envFile.split('\n').forEach(line => {
  const eq = line.indexOf('=');
  if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
});

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ query: sql })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Query failed (${res.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sqlVal(v, isNum) {
  if (v === null || v === undefined || v === '') {
    return isNum ? 'NULL' : "''";
  }
  if (isNum) {
    const n = Number(v);
    return isNaN(n) ? '0' : String(n);
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function main() {
  console.log('Loading migrated state fixture...');
  const state = fix.makeMigratedState();

  console.log('Counts in state:', {
    products: state.products.length,
    accounts: state.accounts.length,
    wallets: state.wallets.length,
    purchases: state.purchases.length,
    codes: state.codes.length,
    customers: state.customers.length,
    sales: state.sales.length,
    payments: state.payments.length
  });

  // 1. Products
  if (state.products.length) {
    const rows = state.products.map(p => `(
      ${sqlVal(p.Product_ID)}, ${sqlVal(p.Product_Name)}, ${sqlVal(p.Category || 'Subscription')},
      ${sqlVal(p.Platform || '')}, ${sqlVal(p.Billing_Cycle_Days || 30, true)}, ${sqlVal(p.Account_Cost || 0, true)},
      ${sqlVal(p.Slots_Per_Account || 5, true)}, ${sqlVal(p.Code_Unit_Cost || 0, true)}, ${sqlVal(p.Default_Price || 0, true)},
      ${sqlVal(p.Active || 'Yes')}, ${sqlVal(p.Letter || 'X')}
    )`).join(',\n');
    await query(`
      INSERT INTO products (product_id, product_name, category, platform, billing_cycle_days, account_cost, slots_per_account, code_unit_cost, default_price, active, letter)
      VALUES ${rows}
      ON CONFLICT (product_id) DO NOTHING;
    `);
    console.log('✓ Products migrated');
  }

  // 2. Accounts
  if (state.accounts.length) {
    const rows = state.accounts.map(a => `(
      ${sqlVal(a.Account_ID)}, ${sqlVal(a.Product_ID)}, ${sqlVal(a.Account_Label || '')},
      ${sqlVal(a.Cycle_Cost || 0, true)}, ${sqlVal(a.Renewal_Date || '')}, ${sqlVal(a.Slots || 5, true)},
      ${sqlVal(a.Notes || '')}, ${sqlVal(a.Account_Status || 'Active')}
    )`).join(',\n');
    await query(`
      INSERT INTO accounts (account_id, product_id, account_label, cycle_cost, renewal_date, slots, notes, account_status)
      VALUES ${rows}
      ON CONFLICT (account_id) DO NOTHING;
    `);
    console.log('✓ Accounts migrated');
  }

  // 3. Wallets
  if (state.wallets.length) {
    const rows = state.wallets.map(w => `(
      ${sqlVal(w.Wallet_ID)}, ${sqlVal(w.Label)}, ${sqlVal(w.Type || '')}, ${sqlVal(w.Notes || '')}
    )`).join(',\n');
    await query(`
      INSERT INTO wallets (wallet_id, label, type, notes)
      VALUES ${rows}
      ON CONFLICT (wallet_id) DO NOTHING;
    `);
    console.log('✓ Wallets migrated');
  }

  // 4. Purchases
  if (state.purchases.length) {
    const rows = state.purchases.map(p => `(
      ${sqlVal(p.Purchase_ID)}, ${sqlVal(p.Date || '')}, ${sqlVal(p.Account_ID)},
      ${sqlVal(p.Paid_With || '')}, ${sqlVal(p.Amount || 0, true)}, ${sqlVal(p.Covers_Until || '')},
      ${sqlVal(p.Notes || '')}
    )`).join(',\n');
    await query(`
      INSERT INTO purchases (purchase_id, date, account_id, paid_with, amount, covers_until, notes)
      VALUES ${rows}
      ON CONFLICT (purchase_id) DO NOTHING;
    `);
    console.log('✓ Purchases migrated');
  }

  // 5. Codes
  if (state.codes.length) {
    const rows = state.codes.map(c => `(
      ${sqlVal(c.Code_ID)}, ${sqlVal(c.Product_ID)}, ${sqlVal(c.Code)},
      ${sqlVal(c['Source / Batch'] || '')}, ${sqlVal(c.Date_Added || '')},
      ${sqlVal(c.Manual_Flag || '')}, ${sqlVal(c.Status || 'Available')}
    )`).join(',\n');
    await query(`
      INSERT INTO codes (code_id, product_id, code, source_batch, date_added, manual_flag, status)
      VALUES ${rows}
      ON CONFLICT (code_id) DO NOTHING;
    `);
    console.log('✓ Codes migrated');
  }

  // 6. Customers
  if (state.customers.length) {
    const rows = state.customers.map(c => `(
      ${sqlVal(c.Customer_ID)}, ${sqlVal(c.Name)}, ${sqlVal(c.Channel || '')},
      ${sqlVal(c.Handle || '')}, ${sqlVal(c.Discord_User_ID || '')},
      ${sqlVal(c.Notes || '')}, ${sqlVal(c.Created || '')}
    )`).join(',\n');
    await query(`
      INSERT INTO customers (customer_id, name, channel, handle, discord_user_id, notes, created)
      VALUES ${rows}
      ON CONFLICT (customer_id) DO NOTHING;
    `);
    console.log('✓ Customers migrated');
  }

  // 7. Sales
  if (state.sales.length) {
    const rows = state.sales.map(s => `(
      ${sqlVal(s.Sale_ID, true)}, ${sqlVal(s.Sale_Date || '')}, ${sqlVal(s.Customer || '')},
      ${sqlVal(s.Contact || '')}, ${sqlVal(s.Product_ID)}, ${sqlVal(s.Account_ID || '')},
      ${sqlVal(s.Code_ID || '')}, ${sqlVal(s.Qty || 1, true)}, ${sqlVal(s.Unit_Price || 0, true)},
      ${sqlVal(s.Paid_Till || '')}, ${sqlVal(s.Record_Status || 'Active')}, ${sqlVal(s.Notes || '')},
      ${sqlVal(s.Payment_Method || '')}, ${sqlVal(s.Transaction_ID || '')}, ${sqlVal(s.Cost_Snapshot || 0, true)},
      ${sqlVal(s.Customer_ID || '')}, ${sqlVal(s.Months || 1, true)}, ${sqlVal(s.Sub_Code || '')}
    )`).join(',\n');
    await query(`
      INSERT INTO sales (sale_id, sale_date, customer, contact, product_id, account_id, code_id, qty, unit_price, paid_till, record_status, notes, payment_method, transaction_id, cost_snapshot, customer_id, months, sub_code)
      VALUES ${rows}
      ON CONFLICT (sale_id) DO NOTHING;
    `);
    console.log('✓ Sales migrated');
  }

  // 8. Payments
  if (state.payments.length) {
    const rows = state.payments.map(p => `(
      ${sqlVal(p.Payment_ID)}, ${sqlVal(p.Date || '')}, ${sqlVal(p.Customer_ID)},
      ${sqlVal(p.Sale_ID, true)}, ${sqlVal(p.Amount || 0, true)}, ${sqlVal(p.Method || '')},
      ${sqlVal(p.Transaction_ID || '')}, ${sqlVal(p.Source || '')}, ${sqlVal(p.Note || '')}
    )`).join(',\n');
    await query(`
      INSERT INTO payments (payment_id, date, customer_id, sale_id, amount, method, transaction_id, source, note)
      VALUES ${rows}
      ON CONFLICT (payment_id) DO NOTHING;
    `);
    console.log('✓ Payments migrated');
  }

  // Verify counts
  const summary = await query(`
    SELECT 'products' as tbl, count(*) as count FROM products
    UNION ALL SELECT 'accounts', count(*) FROM accounts
    UNION ALL SELECT 'wallets', count(*) FROM wallets
    UNION ALL SELECT 'purchases', count(*) FROM purchases
    UNION ALL SELECT 'codes', count(*) FROM codes
    UNION ALL SELECT 'customers', count(*) FROM customers
    UNION ALL SELECT 'sales', count(*) FROM sales
    UNION ALL SELECT 'payments', count(*) FROM payments;
  `);

  console.log('\nMigration Summary in Supabase:');
  summary.forEach(r => console.log(`  ${r.tbl.padEnd(12)}: ${r.count}`));
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

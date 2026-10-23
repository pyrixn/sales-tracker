// ---- server (Edge Function) -------------------------------------------------
// Runs inside the bundled index.ts after the core modules and the Postgres adapter.
// `db` is { query(text, params) -> {rows}, transaction(fn) } (see the header in the built file).
var APP_TZ = 'Asia/Dhaka';

function today_() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
function batchId_() { return crypto.randomUUID(); }

// Every write path takes this Postgres advisory lock inside its transaction, so writes run one at a time.
var WRITE_LOCK_ = 41001;
async function locked_(db, fn) {
  return db.transaction(async function (tx) {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK_]);
    return fn(tx);
  });
}

async function commit_(db, plan, action, data, opts) {
  if (plan.errors && plan.errors.length) return { ok: false, error: plan.errors[0] };
  if (plan.ops && plan.ops.length) await Adapter.applyOps(db, plan.ops, { batchId: batchId_(), action: action, log: !(opts && opts.log === false) });
  return { ok: true, data: data || plan.result || {} };
}

// Unofficial Bybit P2P ad list (USDT sold for BDT). Reachability from Supabase is unconfirmed; the manual rate is the fallback.
var BYBIT_P2P_URL = 'https://api2.bybit.com/fiat/otc/item/online';
async function fetchAds_() {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 5000);
  try {
    var res = await fetch(BYBIT_P2P_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ tokenId: 'USDT', currencyId: 'BDT', side: '1', size: '10', page: '1', amount: '' }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data || data.ret_code !== 0 || !data.result || !Array.isArray(data.result.items)) throw new Error('unexpected response');
    return data.result.items;
  } finally { clearTimeout(timer); }
}

var READS_ = {
  init: async function (db, st) {
    var l = Core.views.lookups(st);
    l.sheetUrl = '';
    l.walletTypes = Core.sales.WALLET_TYPES;
    return { lookups: l, home: Core.views.homeData(st) };
  },
  home: async function (db, st) { return Core.views.homeData(st); },
  lookups: async function (db, st) {
    var l = Core.views.lookups(st);
    l.sheetUrl = '';
    l.walletTypes = Core.sales.WALLET_TYPES;
    return l;
  },
  customer: async function (db, st, p) { var c = Core.views.customerData(st, p.id); if (!c) throw new Error('Unknown customer ' + p.id + '.'); return c; },
  dues: async function (db, st) { return Core.views.duesList(st); },
  book: async function (db, st, p) { return Core.views.bookData(st, p.month || st.today.slice(0, 7)); },
  product: async function (db, st, p) { return Core.views.productList(st, p.productId); },
  profit: async function (db, st) { return { families: Core.views.profitByFamily(st) }; }
};

var WRITES_ = {
  newSale: async function (db, st, p) {
    var plan = Core.sales.planNewSale(st, p);
    return commit_(db, plan, 'newSale', plan.result && Object.assign({ message: 'Sale saved' }, plan.result));
  },
  renew: async function (db, st, p) {
    var plan = Core.sales.planRenew(st, p);
    return commit_(db, plan, 'renew', plan.result && Object.assign({ message: 'Renewed ' + p.subCode }, plan.result));
  },
  pay: async function (db, st, p) {
    var plan = Core.sales.planPayment(st, p);
    var msg = plan.result ? 'Payment saved' + (plan.result.credit > 0 ? ' (৳' + plan.result.credit + ' kept as credit)' : '') : '';
    return commit_(db, plan, 'pay', plan.result && Object.assign({ message: msg }, plan.result));
  },
  edit: async function (db, st, p) { return commit_(db, Core.sales.planEdit(st, p), 'edit', { message: 'Changes saved' }); },
  addExpense: async function (db, st, p) { return commit_(db, Core.sales.planExpense(st, p), 'addExpense', { message: 'Expense saved' }); },
  addPurchase: async function (db, st, p) { return commit_(db, Core.sales.planPurchase(st, p), 'addPurchase', { message: 'Purchase saved' }); },
  addAccount: async function (db, st, p) {
    var plan = Core.sales.planAccount(st, p);
    return commit_(db, plan, 'addAccount', plan.result && { message: 'Account ' + plan.result.accountId + ' added', accountId: plan.result.accountId });
  },
  addCodes: async function (db, st, p) {
    var plan = Core.sales.planAddCodes(st, p);
    return commit_(db, plan, 'addCodes', plan.result && { message: plan.result.added + ' codes added' +
      (plan.result.skipped.length ? ', ' + plan.result.skipped.length + ' already in stock' : ''), skipped: plan.result.skipped });
  },
  addWallet: async function (db, st, p) {
    var plan = Core.sales.planWallet(st, p);
    return commit_(db, plan, 'addWallet', plan.result && { message: 'Wallet ' + plan.result.walletId + ' added', walletId: plan.result.walletId });
  },
  editSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplierEdit(st, p);
    return commit_(db, plan, 'editSupplier', plan.result && { message: 'Supplier updated', supplierId: plan.result.supplierId });
  },
  deleteSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplierDelete(st, p);
    return commit_(db, plan, 'deleteSupplier', plan.result && { message: 'Supplier deleted', supplierId: plan.result.supplierId });
  },
  editBatch: async function (db, st, p) {
    var plan = Core.sales.planBatchEdit(st, p);
    return commit_(db, plan, 'editBatch', plan.result && { message: 'Batch updated', batchId: plan.result.batchId });
  },
  deleteBatch: async function (db, st, p) {
    var plan = Core.sales.planBatchDelete(st, p);
    return commit_(db, plan, 'deleteBatch', plan.result && { message: plan.result.removed + ' codes removed', batchId: plan.result.batchId });
  },
  // Called by the panel once per load. Idempotent: the month is the key, and a second insert is ignored.
  snapshotIfDue: async function (db, st, p) {
    var month = Core.views.previousMonth(today_());
    var have = (st.profitSnapshots || []).some(function (r) { return r.Month === month; });
    if (have) return { ok: true, data: { month: month, created: false } };
    if (Core.views.profitByFamily(st, month).some(function (f) { return f.rateMissing; })) {
      return { ok: true, data: { month: month, created: false, reason: 'rate missing' } };
    }
    var row = Core.views.profitSnapshotRow(st, month);
    await db.query('INSERT INTO profit_snapshots (month, revenue_bdt, cost_bdt, profit_bdt) VALUES ($1, $2, $3, $4) ON CONFLICT (month) DO NOTHING',
      [row.month, row.revenue_bdt, row.cost_bdt, row.profit_bdt]);
    return { ok: true, data: { month: month, created: true, row: row } };
  },
  refreshRate: async function (db, st, p) {
    var cached = Core.rates.resolveRate({ liveRates: st.liveRates, settings: {} });
    if (!(p && p.force) && cached.source === 'bybit' && !cached.stale) {
      return { ok: true, data: { rate: cached.rate, source: 'bybit', fetchedAt: cached.fetchedAt, stale: false } };
    }
    var ads;
    try { ads = await fetchAds_(); } catch (e) { return { ok: false, error: 'Rate fetch failed: ' + String((e && e.message) || e) }; }
    var rate = Core.rates.pickRate((ads || []).map(function (a) { return { price: a && a.price }; }));
    if (rate === null) return { ok: false, error: 'Rate fetch returned no usable price.' };
    var at = new Date().toISOString();
    await db.query('INSERT INTO live_rates (id, rate, fetched_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at',
      ['usdt_bdt', rate, at]);
    return { ok: true, data: { rate: rate, source: 'bybit', fetchedAt: at, stale: false } };
  },
  backfillPayTokens: async function (db, st, p) {
    var plan = Core.sales.planBackfillPayTokens(st);
    return commit_(db, plan, 'backfillPayTokens', { message: plan.result.updated + ' sales got a pay token', updated: plan.result.updated });
  },
  addSupplier: async function (db, st, p) {
    var plan = Core.sales.planSupplier(st, p);
    return commit_(db, plan, 'addSupplier', plan.result && { message: 'Supplier added', supplierId: plan.result.supplierId });
  },
  addCodesBatch: async function (db, st, p) {
    var plan = Core.sales.planAddCodesBatch(st, p);
    return commit_(db, plan, 'addCodesBatch', plan.result && { message: plan.result.added + ' codes added', batchId: plan.result.batchId });
  },
  settings: async function (db, st, p) { return commit_(db, Core.sales.planSettings(st, p.values || {}), 'settings', { message: 'Settings saved' }); },
  addProduct: async function (db, st, p) {
    var plan = Core.sales.planProduct(st, p);
    var res = await commit_(db, plan, 'addProduct', plan.result);
    if (!res.ok) return res;
    return { ok: true, data: { message: plan.result.tabName + ' added', productId: plan.result.productId, tab: '' } };
  },
  match: async function (db, st, p) {
    var row = null;
    (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID).toUpperCase() === String(p.trx).toUpperCase()) row = r; });
    if (!row) return { ok: false, error: 'That payment message is no longer in the inbox.' };
    var plan = Core.matching.planInboxMatch(st, row, { customerId: p.customerId, subCode: p.subCode || '' });
    if (plan.status === 'duplicate') return commit_(db, plan, 'match', { message: 'Already recorded' });
    return commit_(db, plan, 'match', { message: plan.result ? plan.result.note : '' });
  },
  remindSent: async function (db, st, p) {
    var plan = { errors: [], ops: [{ op: 'append', tab: 'Reminders_Log', values: { Date: st.today, Sale_ID: p.saleId, Customer_ID: p.customerId,
      Kind: p.kind, Channel: p.channel || '', Status: p.status === 'skipped' ? 'skipped' : 'sent' } }] };
    return commit_(db, plan, 'remindSent', { message: p.status === 'skipped' ? 'Skipped' : 'Marked as sent' }, { log: false });
  },
  export: async function (db, st) { return { ok: true, data: exportAll_(st) }; }
};

// undo: planUndo reads current values synchronously, so every tab is read first.
function fixUndo() {
  WRITES_.undo = async function (db, st) {
    var last = await Adapter.readLastBatch(db, { skipAuto: true });
    if (!last || !last.lines || !last.lines.length) return { ok: false, error: 'Nothing to undo.' };
    var rows = {};
    for (var t in Adapter.TABS) {
      var key = Core.undo.KEYS[t];
      if (!key) continue;
      var rs = await Adapter.readTab(db, t);
      rows[t] = {};
      rs.forEach(function (r) { rows[t][String(r[key])] = r; });
    }
    function getCurrent(tab, id, field) {
      var row = rows[tab] && rows[tab][String(id)];
      return row ? row[Adapter.fieldFor(tab, field)] : undefined;
    }
    var plan = Core.undo.planUndo(last, getCurrent);
    if (plan.errors.length) return { ok: false, error: plan.errors[0] };
    await Adapter.applyOps(db, plan.ops, { batchId: batchId_(), action: 'undo:' + last.batchId });
    return { ok: true, data: { message: 'Undone: ' + plan.result.action } };
  };
}
fixUndo();

function exportAll_(st) {
  var tables = {
    Customers: { rows: st.customers, head: ['Customer_ID', 'Name', 'Channel', 'Handle', 'Discord_User_ID', 'Notes', 'Created'] },
    Sales: { rows: st.sales, head: ['Sale_ID', 'Sale_Date', 'Customer_ID', 'Customer', 'Contact', 'Product_ID', 'Account_ID', 'Code_ID', 'Qty',
      'Unit_Price', 'Months', 'Paid_Till', 'Record_Status', 'Sub_Code', 'Cost_Snapshot', 'Notes'] },
    Payments: { rows: st.payments, head: ['Payment_ID', 'Date', 'Customer_ID', 'Sale_ID', 'Amount', 'Method', 'Transaction_ID', 'Source', 'Note'] },
    Expenses: { rows: st.expenses, head: ['Expense_ID', 'Date', 'Category', 'Amount', 'Paid_With', 'Note'] },
    Purchases: { rows: st.purchases, head: ['Purchase_ID', 'Date', 'Account_ID', 'Paid_With', 'Amount', 'Covers_Until', 'Notes'] },
    Accounts: { rows: st.accounts, head: ['Account_ID', 'Product_ID', 'Account_Label', 'Cycle_Cost', 'Renewal_Date', 'Slots', 'Account_Status', 'Notes'] },
    Products: { rows: st.products, head: ['Product_ID', 'Product_Name', 'Category', 'Billing_Cycle_Days', 'Default_Price', 'Letter', 'Active'] },
    Codes: { rows: st.codes, head: ['Code_ID', 'Product_ID', 'Code', 'Status'] },
    Wallets: { rows: st.wallets, head: ['Wallet_ID', 'Label'] }
  };
  var files = {};
  Object.keys(tables).forEach(function (name) {
    files[name + '.csv'] = Core.exporter.toCsv(tables[name].rows, tables[name].head);
  });
  return { message: 'Exported', files: files };
}

async function api(action, payload, db) {
  payload = payload || {};
  try {
    if (READS_[action]) {
      var st = await Adapter.readState(db, today_());
      return { ok: true, data: await READS_[action](db, st, payload) };
    }
    if (!WRITES_[action]) return { ok: false, error: 'Unknown action ' + action };
    var requestId = payload.requestId || null;
    // One writer at a time: read, plan, apply and the request log commit together, so two quick taps cannot
    // hand out the same ID, and a repeated requestId sees the first call's saved response.
    return await locked_(db, async function (tx) {
      if (requestId) {
        var ex = await tx.query('SELECT response FROM request_log WHERE request_id = $1', [requestId]);
        if (ex.rows && ex.rows[0] && ex.rows[0].response && ex.rows[0].response !== '{}') {
          return JSON.parse(ex.rows[0].response);
        }
      }
      var st2 = await Adapter.readState(tx, today_());
      var resp = await WRITES_[action](tx, st2, payload);
      if (requestId && resp.ok) {
        await tx.query('INSERT INTO request_log (request_id, response) VALUES ($1, $2) ON CONFLICT (request_id) DO NOTHING',
          [requestId, JSON.stringify(resp)]);
      }
      return resp;
    });
  } catch (err) {
    // A database error (it carries a Postgres code) goes to the log, not to the panel.
    if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
      console.error('api ' + action + ' failed:', err.code, err.message);
      return { ok: false, error: 'Could not save. Nothing was changed. Try again.' };
    }
    // A bug (not a rule such as "Unknown customer") also stays in the log.
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError) {
      console.error('api ' + action + ' crashed:', err && err.stack);
      return { ok: false, error: 'Something went wrong. Nothing was changed.' };
    }
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---- relay (ported from reference_PaymentRelay_v9.gs) -------------------------
// Same contract the iPhone uses today: POST /relay?src=bkash  { token, sender, text }.
var RELAY_BLOCK = /\b(otp|pin|password|passcode|do not share|don'?t share)\b/i;
var RELAY_SOURCES = { bkash: { method: 'bKash', sender: '16247' }, upay: { method: 'Upay', sender: '16268' }, nagad: { method: 'Nagad', sender: '16167' } };

function nowDhaka_() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date()).replace(', ', ' ');
}

function resolveSource_(tag, sender, text) {
  var t = String(tag).toLowerCase();
  if (RELAY_SOURCES[t]) return RELAY_SOURCES[t];
  var x = String(sender);
  if (/16247|bkash/i.test(x)) return RELAY_SOURCES.bkash;
  if (/16268|upay/i.test(x)) return RELAY_SOURCES.upay;
  if (/16167|nagad/i.test(x)) return RELAY_SOURCES.nagad;
  if (/nagad/i.test(String(text))) return RELAY_SOURCES.nagad;
  return { method: '', sender: '' };
}

function parseSms_(text) {
  var out = { type: '', amount: '', trxId: '', counterparty: '', reference: '', skip: '' };
  var trx = text.match(/(?:TrxID|TxnID|Txn ID|Transaction ID)[\s:.#-]*([A-Z0-9]{6,20})/i);
  out.trxId = trx ? trx[1].toUpperCase() : '';
  var amt = text.match(/(?:Tk\.?|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.amount = amt ? Number(amt[1].replace(/,/g, '')) : '';
  if (/incentive/i.test(text)) { out.skip = 'government incentive (not a sale)'; return out; }
  if (/fund transfer successful/i.test(text)) { out.skip = 'outgoing transfer'; return out; }
  if (!out.trxId && !/received/i.test(text)) { out.skip = 'no TrxID (notice, not a payment)'; return out; }
  if (/remittance/i.test(text)) out.type = 'Remittance';
  else if (/you have received|has been received|money received|cash in/i.test(text)) out.type = 'Received';
  else if (/sent|send money|cash out|payment|paid|bill|recharge/i.test(text)) { out.skip = 'outgoing or other transaction'; return out; }
  else out.type = 'Unrecognised';
  // Nagad cash-in names the agent (Uddokta): that number is the counterparty. Otherwise the sender.
  var from = text.match(/Uddokta:?\s*(\+?8801\d{9}|01\d{9})/i) || text.match(/(?:from|sender:?)\s*(\+?8801\d{9}|01\d{9})/i);
  out.counterparty = from ? from[1] : '';
  // Same line only ([ \t]), so an empty `Ref:` does not swallow the next line. `N/A` means no reference.
  var ref = text.match(/\b(?:Reference|Ref|Comments?)\b\.?[ \t]*:?[ \t]*([^.\n:][^.\n]*?)[ \t]*(?:\.|\n|$)/i);
  out.reference = ref && !/^n\/?a$/i.test(ref[1].trim()) ? ref[1].trim() : '';
  return out;
}

async function relayIngest(body, src) {
  var text = String(body.text || '').trim();
  var sender = String(body.sender || '').trim();
  if (!text) return { ok: false, error: 'empty message' };
  if (RELAY_BLOCK.test(text)) return { ok: true, result: 'dropped: sensitive keyword' };
  var s = resolveSource_(src, sender, text);
  var p = parseSms_(text);
  if (p.skip) return { ok: true, result: 'skipped: ' + p.skip };
  // Check and insert under the write lock so two copies of one SMS cannot both pass the check.
  var dupResult = null;
  try {
    dupResult = await locked_(db, async function (tx) {
      if (p.trxId) {
        var dup = await tx.query('SELECT 1 FROM payment_inbox WHERE transaction_id = $1 LIMIT 1', [p.trxId]);
        if (dup.rows.length) return 'duplicate ' + p.trxId;
      } else {
        var dup2 = await tx.query("SELECT 1 FROM payment_inbox WHERE raw_sms = $1 AND transaction_id = '' LIMIT 1", [text]);
        if (dup2.rows.length) return 'duplicate message';
      }
      await tx.query('INSERT INTO payment_inbox (received, type, method, sender, amount, transaction_id, counterparty, reference, status, raw_sms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [nowDhaka_(), p.type, s.method, sender || s.sender, p.amount || 0, p.trxId, p.counterparty, p.reference,
         p.type === 'Unrecognised' || s.method === 'Upay' ? 'Review' : 'Pending', text]);
      return null;
    });
  } catch (e) {
    // The unique index on transaction_id is the last guard: a duplicate that still got through is not an error.
    if (p.trxId && /duplicate key|unique/i.test(String((e && e.message) || e))) dupResult = 'duplicate ' + p.trxId;
    else return { ok: false, error: 'Could not store the message: ' + String((e && e.message) || e) };
  }
  if (dupResult) return { ok: true, result: dupResult };
  var out = { ok: true, result: 'stored', type: p.type, trxId: p.trxId, amount: p.amount, matched: false };
  if (!(p.type === 'Unrecognised' || s.method === 'Upay') && p.trxId) {
    var auto = await autoMatch_(p.trxId);
    out.matched = auto.matched;
    if (auto.note) out.autoNote = auto.note;
  }
  return out;
}

/**
 * Match a freshly stored, Pending inbox row to a sale with the same planner the panel uses. Only runs for rows that reached
 * relayIngest through the verified-token route. Anything unclear leaves the row Pending for the owner. The action name starts
 * with "auto" so Undo skips it, as for the other automatic payments.
 */
async function autoMatch_(trx) {
  try {
    return await locked_(db, async function (tx) {
      var st = await Adapter.readState(tx, today_());
      var row = null;
      (st.inbox || []).forEach(function (r) { if (String(r.Transaction_ID).toUpperCase() === String(trx).toUpperCase()) row = r; });
      if (!row || row.Status !== 'Pending') return { matched: false, note: 'Not pending.' };
      var cap = Number((st.settings || {}).auto_match_max_bdt);
      if (!(cap > 0)) cap = 5000;
      if (Number(row.Amount) > cap) return { matched: false, note: 'Amount is above the auto-match limit (৳' + cap + '). Match it by hand.' };
      var plan = Core.matching.planInboxMatch(st, row);
      if (plan.errors && plan.errors.length) return { matched: false, note: plan.errors[0] };
      if (plan.status !== 'auto') return { matched: false, note: (plan.result && plan.result.note) || 'Left for manual matching.' };
      await Adapter.applyOps(tx, plan.ops, { batchId: batchId_(), action: 'autoMatch', log: true });
      return { matched: true, note: plan.result && plan.result.note };
    });
  } catch (e) {
    return { matched: false, note: 'Auto-match failed: ' + String((e && e.message) || e) };
  }
}

// ---- customer pay page (PipraPay-inspired payment link) -----------------------
function payHtml_(sale, product, customer, bkash, paidRows) {
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var amt = Core.ledger.salePrice(sale, [product]) || product.Default_Price || '';
  var paid = paidRows.length > 0;
  var paidHtml = paid
    ? '<div id="status" class="box ok">✓ Payment received' +
      paidRows.map(function (r) { return ' — <b>৳' + esc(r.amount) + '</b> (' + esc(r.date) + ')'; }).join('') + '</div>'
    : '<div id="status" class="box wait">Waiting for payment… this page confirms automatically.</div>';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Pay — ' + esc(product.Product_Name || '') + '</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;max-width:400px;width:100%;box-sizing:border-box}' +
    'h1{font-size:20px;margin:0 0 4px}.sub{color:#94a3b8;font-size:14px;margin:0 0 20px}' +
    '.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #334155;font-size:15px}' +
    '.row b{color:#fff}.big{font-size:22px;color:#34d399}.ref{letter-spacing:1px;font-weight:700}' +
    '.box{margin-top:20px;padding:12px;border-radius:10px;text-align:center;font-size:14px}' +
    '.wait{background:#42200633;border:1px solid #92600a66;color:#fbbf24}.ok{background:#065f4622;border:1px solid #10b98155;color:#34d399}' +
    '</style></head><body><div class="card">' +
    '<h1>' + esc(product.Product_Name || '') + '</h1>' +
    '<p class="sub">' + esc(customer ? customer.Name : '') + ' · monthly plan</p>' +
    '<div class="row"><span>Amount</span><b class="big">৳' + esc(amt) + '</b></div>' +
    '<div class="row"><span>Pay with</span><b>bKash Send Money</b></div>' +
    '<div class="row"><span>Number</span><b>' + esc(bkash) + '</b></div>' +
    '<div class="row"><span>Reference</span><b class="ref">' + esc(sale.Sub_Code) + '</b></div>' +
    paidHtml +
    '<script>setInterval(function(){ fetch(location.pathname.replace(/\\/$/, "") + "/status").then(function(r){return r.json()}).then(function(d){' +
    'if(d && d.paid){ location.reload(); }}); }, 5000);</script>' +
    '</div></body></html>';
}

/**
 * Newest sale of the line that owns this pay token, with what the pay page shows, or null. Sub codes are never accepted here.
 * This route is public and polled, so it reads only the rows it needs, never whole tables.
 */
async function payContext_(token, withPage) {
  var t = String(token || '');
  if (t.length < 16) return null;
  var sale = null;
  (await Adapter.readTabWhere(db, 'Sales_Log', 'Pay_Token', t)).forEach(function (s) {
    if (!sale || Number(s.Sale_ID) > Number(sale.Sale_ID)) sale = s;
  });
  if (!sale) return null;
  var paid = (await Adapter.readTabWhere(db, 'Payment_Inbox', 'Reference', String(sale.Sub_Code), true))
    .map(function (r) { return { amount: r.Amount, date: r.Received, status: r.Status }; });
  var ctx = { sale: sale, paidRows: paid };
  if (withPage) {
    ctx.product = (await Adapter.readTabWhere(db, 'Product_Catalog', 'Product_ID', sale.Product_ID))[0] || {};
    ctx.customer = (await Adapter.readTabWhere(db, 'Customers', 'Customer_ID', sale.Customer_ID))[0] || null;
    ctx.bkash = String((await Adapter.readSettings(db)).bkash_number || '');
  }
  return ctx;
}

async function payStatus(token) {
  var ctx = await payContext_(token, false);
  if (!ctx) return null;
  return { ok: true, paid: ctx.paidRows.length > 0, rows: ctx.paidRows };
}

// Failed sign-ins per client, kept in this isolate's memory: a brake on guessing, not a guarantee (a cold start resets it).
var AUTH_FAILS_ = {};
var AUTH_MAX_FAILS_ = 10;
var AUTH_WINDOW_MS_ = 60000;
function clientKey_(req) {
  // Not the first x-forwarded-for entry: a client can write that one. cf-connecting-ip is set by the platform edge,
  // and the last forwarded entry is the one the nearest proxy appended.
  var cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  var xff = String(req.headers.get('x-forwarded-for') || '').split(',');
  return xff[xff.length - 1].trim() || 'unknown';
}
function authBlocked_(req) {
  var f = AUTH_FAILS_[clientKey_(req)];
  return !!f && Date.now() - f.since < AUTH_WINDOW_MS_ && f.n >= AUTH_MAX_FAILS_;
}
function authFailed_(req) {
  var k = clientKey_(req), now = Date.now(), f = AUTH_FAILS_[k];
  if (!f || now - f.since >= AUTH_WINDOW_MS_) {
    var keys = Object.keys(AUTH_FAILS_);
    if (keys.length > 500) keys.forEach(function (x) { if (now - AUTH_FAILS_[x].since >= AUTH_WINDOW_MS_) delete AUTH_FAILS_[x]; });
    AUTH_FAILS_[k] = f = { n: 0, since: now };
  }
  f.n++;
}

// ---- HTTP entry point -------------------------------------------------------
/** Constant-time string compare: hashes both sides so length and content do not leak through timing. */
async function safeEqual_(a, b) {
  var enc = new TextEncoder();
  var ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(a === undefined || a === null ? '' : a))));
  var hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(b === undefined || b === null ? '' : b))));
  var diff = 0;
  for (var i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// CORS is opt-in: only the origin named in ALLOWED_ORIGIN is echoed back. Never '*'.
function withCors_(req, res) {
  var allowed = Deno.env.get('ALLOWED_ORIGIN') || '';
  var origin = req.headers.get('Origin') || '';
  if (allowed && origin === allowed) {
    res.headers.set('Access-Control-Allow-Origin', allowed);
    res.headers.set('Vary', 'Origin');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-App-Secret');
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return res;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

async function handle(req) { return withCors_(req, await route_(req)); }

async function route_(req) {
  var url = new URL(req.url);
  var path = url.pathname.replace(/^\/(?:functions\/v1\/)?api(?:\/|$)/, '/') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method === 'GET') {
    if (path === '/health') return jsonResponse({ ok: true });
    if (path === '/' || path === '/index.html') return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    var pm = /^\/pay\/([^\/]+)$/.exec(path);
    if (pm) {
      var ctx = await payContext_(decodeURIComponent(pm[1]), true);
      if (!ctx) return new Response('Payment link not found.', { status: 404 });
      return new Response(payHtml_(ctx.sale, ctx.product, ctx.customer, ctx.bkash, ctx.paidRows),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    var sm = /^\/pay\/([^\/]+)\/status$/.exec(path);
    if (sm) {
      var ps = await payStatus(decodeURIComponent(sm[1]));
      return ps ? jsonResponse(ps) : new Response('Payment link not found.', { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  }
  if (req.method === 'POST') {
    var secret = Deno.env.get('APP_SECRET');
    if (authBlocked_(req)) return jsonResponse({ ok: false, error: 'Too many failed attempts. Wait a minute.' }, 429);
    if (path === '/relay') {
      var body = await req.json().catch(function () { return {}; });
      var relayToken = Deno.env.get('RELAY_TOKEN');
      if (!relayToken) return jsonResponse({ ok: false, error: 'Server not configured' }, 503);
      if (!(await safeEqual_(body.token, relayToken))) { authFailed_(req); return jsonResponse({ ok: false, error: 'bad token' }, 401); }
      return jsonResponse(await relayIngest(body, url.searchParams.get('src') || ''));
    }
    if (!secret) return jsonResponse({ ok: false, error: 'Server not configured' }, 503);
    if (!(await safeEqual_(req.headers.get('X-App-Secret'), secret))) { authFailed_(req); return jsonResponse({ ok: false, error: 'Unauthorized' }, 401); }
    var b = await req.json().catch(function () { return {}; });
    return jsonResponse(await api(b.action, b.payload || {}, db));
  }
  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

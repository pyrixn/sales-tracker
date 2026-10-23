// Seeds a fake db (test/support/fake-db.js) from a Core State object, through the same
// `INSERT INTO <table> (cols) VALUES (...)` path the Postgres adapter uses in production.
const Adapter = require('../../src/adapters/postgres.js');
const { makeMigratedState } = require('../fixtures');

/**
 * Writes `state` into the fake tables using Adapter.SPEC column maps, so Adapter.readState returns
 * an equivalent state. The fake db ships with a few default rows (settings, EXL-01, EXITLAG); they
 * are cleared first through `tables` so the seeded state is the whole database.
 */
async function seedDb(db, tables, state) {
  for (const name of Object.keys(tables)) {
    if (Array.isArray(tables[name])) tables[name].length = 0;
    else tables[name].clear();
  }

  if (!state.settings) state.settings = {};
  // Production has a row for every setting key (migrations 001 and 005); the settings planner only updates existing rows.
  const defaults = { bkash_number: '', language: 'en', pay_base_url: '', reminder_days_before: '3', reminder_days_after: '2',
    due_reminder_every_days: '5', grace_days: '3', discord_enabled: 'false', msg_renew_en: '', msg_renew_bn: '', msg_due_en: '', msg_due_bn: '',
    usdt_bdt_manual: '' };
  for (const k of Object.keys(defaults)) if (state.settings[k] === undefined) state.settings[k] = defaults[k];
  for (const key of Object.keys(state.settings || {})) {
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, String(state.settings[key])]);
  }

  for (const tab of Object.keys(Adapter.TABS)) {
    const field = Adapter.TABS[tab].state;
    const spec = Adapter.SPEC[tab];
    if (!field || !spec) continue;
    for (const row of state[field] || []) {
      // Key column first: the fake db keys its Maps on the first inserted column.
      const fields = [spec.key].concat(Object.keys(spec.cols).filter(f => f !== spec.key))
        .filter(f => row[f] !== undefined);
      const cols = fields.map(f => spec.cols[f]);
      const ph = fields.map((f, i) => '$' + (i + 1));
      const vals = fields.map(f => (row[f] === '' && spec.num.indexOf(f) >= 0) ? null : row[f]);
      await db.query('INSERT INTO ' + spec.table + ' (' + cols.join(',') + ') VALUES (' + ph.join(',') + ')', vals);
    }
  }
}

/** makeMigratedState() plus the two edits the old Apps Script UI harness made. */
function makeUiState() {
  const s = makeMigratedState();
  const c = s.customers.find(x => x.Name === 'jamilhq');
  if (!c) throw new Error('No customer jamilhq in the migrated state');
  c.Channel = 'WhatsApp';
  c.Handle = '01711111111';
  c.Notes = 'Example contact for testing';
  s.inbox = [{ Received: '2026-10-18 14:05', Type: 'Received', Method: 'bKash', Sender: '+8801756999991', Amount: 290,
    Transaction_ID: 'TESTTRX1', Reference: '', Status: 'Pending', Matched_Sale_ID: '', Raw_SMS: 'Example forwarded message' }];
  return s;
}

module.exports = { seedDb, makeUiState };

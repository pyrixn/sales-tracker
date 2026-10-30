// Review fixes for the login vault: audit-only batches never block Undo, secrets follow their sale (token) and die with an undone import,
// owner-only overwrite, 6 to 12 digit PINs with a sliding lock and a global cap, parent rows need approval, no plaintext in change_log,
// and the backup holds ciphertext only.
// Synthetic data only. The VAULT_KEY below is a throwaway test key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');

const KEY = crypto.randomBytes(32).toString('base64');
const STAFF = { role: 'staff', actor: 'staff-1', email: '' };
const PIN = '482916';
const all = tbl => Array.from(tbl.values ? tbl.values() : tbl);

async function boot() {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  return { db, tables, edge: loadEdge(db, { env: { VAULT_KEY: KEY, APP_SECRET: 'x' } }) };
}
const ACC = { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', collected: 300, cost: 900, renewalDate: '2026-11-20', slots: 3, secret: 'account pass 1' } };
const LINE = { id: 'imp:S:L1', kind: 'line', sheet: 'S', ref: 'L1', data: { accountRef: 'imp:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20', secret: 'profile: pin 4455' } };
async function stageApply(edge, rows) {
  assert.equal((await edge.api('importStage', { requestId: 's1', batch: 'imp', rows })).ok, true);
  assert.equal((await edge.api('importStatus', { requestId: 'a1', rowIds: rows.map(r => r.id), status: 'Approved' })).ok, true);
  const ap = await edge.api('importApply', { requestId: 'ap1', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  return ap;
}

test('Undo skips every audit-only batch (vault:, apiKey:, webhook:, delivery:) and reverses the previous real write', async () => {
  const { edge, tables } = await boot();
  const staged = await edge.api('importStage', { requestId: 's1', batch: 'imp', rows: [{ id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', cost: 900, slots: 3 } }] });
  assert.equal(staged.ok, true, staged.error);
  assert.equal(tables.import_rows.size, 1);
  await edge.api('vaultSetPin', { newPin: PIN });
  await edge.api('vaultReveal', { secretId: 'nope', pin: '000000' }, STAFF);                 // vault:pin-fail
  assert.equal((await edge.api('createApiKey', { requestId: 'k1', name: 'site', scopes: ['catalog:read'], origins: ['https://shop.example'] })).ok, true);  // apiKey:create
  const t = await edge.api('deliveryTemplateSave', { title: 'T', body: 'Hi {{name}}' });       // delivery:template
  assert.equal(t.ok, true, t.error);
  const actions = tables.change_log.map(c => c.action);
  ['vault:pin-fail', 'apiKey:create', 'delivery:template'].forEach(a => assert.ok(actions.includes(a), a));
  const act = await edge.api('activity', {});
  assert.equal(act.data.batches.filter(b => b.undoable).length, 1);
  assert.equal(act.data.batches.find(b => b.undoable).action.length > 0, true);
  const undone = await edge.api('undo', {});
  assert.equal(undone.ok, true, undone.error);
  assert.equal(tables.import_rows.size, 0, 'the staging write was reversed');
});

test('undoing an import apply deletes the logins it moved into the vault', async () => {
  const { edge, tables } = await boot();
  const ap = await stageApply(edge, [ACC, LINE]);
  assert.equal(all(tables.account_secrets).length, 2);
  const undone = await edge.api('undo', { batchId: ap.data.batchId });
  assert.equal(undone.ok, true, undone.error);
  assert.equal(all(tables.account_secrets).length, 0);
  assert.ok(tables.change_log.some(c => c.action === 'vault:undo-import'));
  // Applying again links fresh secrets.
  const again = await edge.api('importApply', { requestId: 'ap2', batch: 'imp' });
  assert.equal(again.ok, true, again.error);
  assert.equal(all(tables.account_secrets).length, 2);
});

test('a login follows its sale by token: a reused sale id with another token never gets it', async () => {
  const { edge, tables } = await boot();
  await stageApply(edge, [ACC, LINE]);
  await edge.api('vaultSetPin', { newPin: PIN });
  const sec = tables.account_secrets.get('sec:imp:S:L1');
  const sale = all(tables.sales).find(s => String(s.sale_id) === sec.sale_id);
  assert.ok(sec.sale_token && (sec.sale_token === sale.pay_token || sec.sale_token === sale.sub_code));
  const t = await edge.api('deliveryTemplateSave', { title: 'L', body: 'Login: {{login}}' });
  const ok = await edge.api('deliveryMessage', { saleId: sale.sale_id, templateId: t.data.templateId, pin: PIN });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(ok.data.text.includes('pin 4455'));
  // Another customer's sale takes over the id (token and line code differ).
  sale.pay_token = 'other-token-1234567890'; sale.sub_code = 'OTHER-LINE';
  // The sale-linked login is ignored; only the account's own login can still be served.
  const bad = await edge.api('deliveryMessage', { saleId: sale.sale_id, templateId: t.data.templateId, pin: PIN });
  assert.ok(!JSON.stringify(bad).includes('pin 4455'));
  assert.ok(bad.ok === false || bad.data.text.includes('account pass 1'));
  assert.equal((await edge.api('vaultReveal', { secretId: 'sec:imp:S:L1', pin: PIN })).ok, false);
  assert.deepEqual((await edge.api('vaultList', { saleId: sec.sale_id })).data.secrets, []);
  // A login of one sale is not served for another sale through p.secretId either.
  const other = all(tables.sales).find(s => String(s.sale_id) !== sec.sale_id && s.account_id);
  const cross = await edge.api('deliveryMessage', { saleId: other.sale_id, templateId: t.data.templateId, pin: PIN, secretId: 'sec:imp:S:L1' });
  assert.equal(cross.ok, false);
});

test('vaultSave: staff cannot overwrite an existing entry; unknown account or sale refused; the sale token is stored', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const sale = all(tables.sales).find(s => s.account_id);
  const made = await edge.api('vaultSave', { accountId: sale.account_id, saleId: String(sale.sale_id), label: 'L', text: 'one', pin: PIN }, STAFF);
  assert.equal(made.ok, true, made.error);
  assert.ok(tables.account_secrets.get(made.data.secretId).sale_token);
  const over = await edge.api('vaultSave', { secretId: made.data.secretId, label: 'L', text: 'two', pin: PIN }, STAFF);
  assert.deepEqual([over.ok, over.error], [false, 'Only the owner can change saved login details.']);
  assert.equal((await edge.api('vaultReveal', { secretId: made.data.secretId, pin: PIN })).data.text, 'one');
  const ownerOver = await edge.api('vaultSave', { secretId: made.data.secretId, label: 'L', text: 'two', pin: PIN });
  assert.equal(ownerOver.ok, true, ownerOver.error);
  assert.equal((await edge.api('vaultSave', { accountId: 'NOPE-99', label: 'L', text: 'x', pin: PIN })).error, 'Unknown account.');
  assert.equal((await edge.api('vaultSave', { saleId: '987654', label: 'L', text: 'x', pin: PIN })).error, 'Unknown sale.');
  assert.equal(tables.account_secrets.size, 1);
});

test('new PINs are 6 to 12 digits; older shorter PINs still verify', async () => {
  const { edge } = await boot();
  for (const bad of ['1234', '12345', '1234567890123', '12345a']) {
    const r = await edge.api('vaultSetPin', { newPin: bad });
    assert.deepEqual([r.ok, r.error], [false, 'The PIN must be 6 to 12 digits.'], bad);
  }
  assert.equal((await edge.api('vaultSetPin', { newPin: '123456' })).ok, true);
  assert.equal((await edge.api('vaultSetPin', { newPin: '123456789012', currentPin: '123456' })).ok, true);
});

test('PIN lock counts failures over a sliding 15 minutes, not a fixed window', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const minute = 60000, now = Date.now();
  // Four failures spread over the last 14 minutes: a fixed 15-minute window could have reset between them.
  [13, 10, 7, 4].forEach(m => {
    const w = new Date(Math.floor((now - m * minute) / minute) * minute).toISOString();
    tables.rate_limits.set('vaultfail:staff-1|' + w, { bucket: 'vaultfail:staff-1', window_start: w, count: 1 });
  });
  const fifth = await edge.api('vaultReveal', { secretId: 'x', pin: '000000' }, STAFF);
  assert.equal(fifth.code, 'vault_locked');
  assert.equal((await edge.api('vaultReveal', { secretId: 'x', pin: PIN }, STAFF)).code, 'vault_locked');
  // Failures older than 15 minutes do not count.
  const { edge: e2, tables: t2 } = await boot();
  await e2.api('vaultSetPin', { newPin: PIN });
  [40, 30, 25, 20].forEach(m => {
    const w = new Date(Math.floor((now - m * minute) / minute) * minute).toISOString();
    t2.rate_limits.set('vaultfail:staff-1|' + w, { bucket: 'vaultfail:staff-1', window_start: w, count: 1 });
  });
  assert.equal((await e2.api('vaultReveal', { secretId: 'x', pin: '000000' }, STAFF)).code, 'vault_pin');
});

test('20 wrong PINs in an hour across all actors lock every reveal, even for the owner with the right PIN', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const saved = await edge.api('vaultSave', { accountId: 'EXL-01', label: 'L', text: 'one', pin: PIN });
  assert.equal(saved.ok, true, saved.error);
  const minute = 60000, now = Date.now();
  // 19 failures by 19 different actors, each under the personal limit.
  for (let i = 0; i < 19; i++) {
    const w = new Date(Math.floor((now - (i + 1) * 2 * minute) / minute) * minute).toISOString();
    tables.rate_limits.set('vaultfail:actor-' + i + '|' + w, { bucket: 'vaultfail:actor-' + i, window_start: w, count: 1 });
  }
  const twentieth = await edge.api('vaultReveal', { secretId: saved.data.secretId, pin: '000000' }, STAFF);
  assert.equal(twentieth.code, 'vault_locked');
  const owner = await edge.api('vaultReveal', { secretId: saved.data.secretId, pin: PIN });
  assert.equal(owner.code, 'vault_locked');
  assert.match(owner.error, /across the team/);
});

test('importApply: a line only brings an Approved account row; a Review one is refused until approveParents', async () => {
  const { edge, tables } = await boot();
  const acc = { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', collected: 300, cost: 900, renewalDate: '2026-11-20', slots: 3 } };
  const line = { id: 'imp:S:L1', kind: 'line', sheet: 'S', ref: 'L1', data: { accountRef: 'imp:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20' } };
  assert.equal((await edge.api('importStage', { requestId: 's1', batch: 'imp', rows: [acc, line] })).ok, true);
  await edge.api('importStatus', { requestId: 'a1', rowIds: ['imp:S:L1'], status: 'Approved' });
  const refused = await edge.api('importApply', { requestId: 'x1', batch: 'imp', rowIds: ['imp:S:L1'], includeParents: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Approve account A1 first, or approve both.');
  assert.equal(tables.import_rows.get('imp:S:A1').status, 'Review');
  const both = await edge.api('importApply', { requestId: 'x2', batch: 'imp', rowIds: ['imp:S:L1'], includeParents: true, approveParents: true });
  assert.equal(both.ok, true, both.error);
  assert.deepEqual(both.data.alsoApplied, ['imp:S:A1']);
  assert.equal(tables.import_rows.get('imp:S:A1').status, 'Applied');
  // An Approved parent is included without approveParents.
  const { edge: e2, tables: t2 } = await boot();
  await e2.api('importStage', { requestId: 's1', batch: 'imp', rows: [acc, line] });
  await e2.api('importStatus', { requestId: 'a1', rowIds: ['imp:S:A1', 'imp:S:L1'], status: 'Approved' });
  const ok = await e2.api('importApply', { requestId: 'x1', batch: 'imp', rowIds: ['imp:S:L1'], includeParents: true });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(t2.import_rows.get('imp:S:A1').status, 'Applied');
});

test('moving a value into the vault keeps plaintext out of change_log (Data old/new blanked); the batch is audit-only', async () => {
  const { edge, tables } = await boot();
  await edge.api('importStage', { requestId: 's1', batch: 'imp', rows: [{ id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'plain-marker-label', cost: 900, slots: 3 } }] });
  const moved = await edge.api('importEdit', { requestId: 'e1', rowId: 'imp:S:A1', storeAsLogin: ['label'] });
  assert.equal(moved.ok, true, moved.error);
  const lines = tables.change_log.filter(c => c.action === 'importEdit:login' && c.field === 'Data');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0].old).label, '');
  assert.equal(JSON.parse(lines[0].new).label, '');
  assert.ok(!JSON.stringify(tables.change_log).includes('plain-marker-label'));
  const d = JSON.parse(tables.import_rows.get('imp:S:A1').data);
  assert.equal(await edge.vault.decrypt(d.secretCipher, d.secretIv, 'imp:S:A1'), 'label: plain-marker-label');
});

test('backup document carries account_secrets (ciphertext and IV only) and delivery_templates', async () => {
  const { Core } = require('./load-core');
  const { edge, tables, db } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const s = await edge.api('vaultSave', { accountId: 'EXL-01', label: 'L', text: 'backup-marker-plain', pin: PIN });
  await edge.api('deliveryTemplateSave', { title: 'T', body: 'Hi {{name}}' });
  const Adapter = require('../src/adapters/postgres.js');
  const secrets = await Adapter.vaultBackupSecrets(db), templates = await Adapter.listDeliveryTemplates(db);
  const doc = Core.jobs.backupDocument({ settings: {} }, '2026-10-29T00:00:00.000Z', { secrets, templates });
  assert.equal(doc.account_secrets.length, 1);
  assert.ok(doc.account_secrets[0].ciphertext && doc.account_secrets[0].iv);
  assert.equal(doc.delivery_templates.length, 1);
  assert.ok(!JSON.stringify(doc).includes('backup-marker-plain'));
  assert.equal(await edge.vault.decrypt(doc.account_secrets[0].ciphertext, doc.account_secrets[0].iv, s.data.secretId), 'backup-marker-plain');
  assert.equal(Core.jobs.backupDocument({}, 'x').account_secrets, undefined);
});

// Login details vault: crypto, PIN, lockout, permissions, request_log hygiene, and the migration panel's encrypted logins.
// Synthetic data only. The VAULT_KEY below is a throwaway test key.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { Core } = require('./load-core');

const KEY = crypto.randomBytes(32).toString('base64');
const OTHER_KEY = crypto.randomBytes(32).toString('base64');
const STAFF = { role: 'staff', actor: 'staff-1', email: '' };
const VIEWER = { role: 'viewer', actor: 'viewer-1', email: '' };
const PIN = '482916';
const PLAIN = 'user: demo-login-name\npass: demo-pass-phrase-77';

async function boot(env) {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const edge = loadEdge(db, { env: env === undefined ? { VAULT_KEY: KEY } : env });
  return { db, tables, edge };
}
const all = tbl => Array.from(tbl.values ? tbl.values() : tbl);
const dump = tables => JSON.stringify({ rs: all(tables.request_log), cl: tables.change_log, as: all(tables.account_secrets), ir: all(tables.import_rows), st: all(tables.settings) });

test('migration 021: account_secrets with RLS, no policies, anon and authenticated revoked, number unique', () => {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('021_')).length, 1);
  const sql = fs.readFileSync(path.join(dir, '021_account_secrets.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sql.includes('create table if not exists account_secrets ('));
  assert.ok(sql.includes('secret_id text primary key') && sql.includes('ciphertext text not null') && sql.includes('iv text not null'));
  assert.ok(sql.includes('alter table account_secrets enable row level security'));
  assert.ok(sql.includes('revoke all on account_secrets from anon, authenticated'));
  assert.ok(sql.includes('(account_id)') && sql.includes('(sale_id)'));
  assert.ok(!/create policy/i.test(sql));
});

test('crypto: roundtrip, fresh IV each time, wrong AAD fails, wrong key fails, no key fails closed', async () => {
  const { edge } = await boot();
  const v = edge.vault;
  const a = await v.encrypt('hello login', 'sec-1'), b = await v.encrypt('hello login', 'sec-1');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.ok(!a.ciphertext.includes('hello'));
  assert.equal(await v.decrypt(a.ciphertext, a.iv, 'sec-1'), 'hello login');
  await assert.rejects(() => v.decrypt(a.ciphertext, a.iv, 'sec-2'));
  const wrongKey = (await boot({ VAULT_KEY: OTHER_KEY })).edge.vault;
  await assert.rejects(() => wrongKey.decrypt(a.ciphertext, a.iv, 'sec-1'));
  const none = (await boot({})).edge.vault;
  assert.equal(none.configured(), false);
  await assert.rejects(() => none.encrypt('x', 'sec-1'), /Vault not configured: set VAULT_KEY\./);
  const short = (await boot({ VAULT_KEY: Buffer.alloc(16).toString('base64') })).edge.vault;
  assert.equal(short.configured(), false);
});

test('PIN hash: pbkdf2 format, verifies, rejects wrong and malformed', async () => {
  const { edge } = await boot();
  const h = await edge.vault.hashPin(PIN);
  const p = h.split('$');
  assert.equal(p[0], 'pbkdf2');
  assert.ok(Number(p[1]) >= 210000);
  assert.equal(Buffer.from(p[2], 'base64').length, 16);
  assert.notEqual(h, await edge.vault.hashPin(PIN));
  assert.equal(await edge.vault.verifyPin(PIN, h), true);
  assert.equal(await edge.vault.verifyPin('000000', h), false);
  assert.equal(await edge.vault.verifyPin(PIN, 'pbkdf2$1$AAAA$AAAA'), false);
  assert.equal(await edge.vault.verifyPin(PIN, ''), false);
});

test('permissions: viewer refused, staff list/save/reveal ok, staff delete and set-pin refused', async () => {
  const P = Core.permissions;
  ['vaultList', 'vaultSave', 'vaultReveal', 'vaultDelete', 'vaultSetPin'].forEach(a => assert.equal(P.canDo('viewer', a), false, a));
  ['vaultList', 'vaultSave', 'vaultReveal'].forEach(a => assert.equal(P.canDo('staff', a), true, a));
  ['vaultDelete', 'vaultSetPin'].forEach(a => { assert.equal(P.canDo('staff', a), false, a); assert.equal(P.canDo('owner', a), true, a); });
  const { edge } = await boot();
  assert.equal((await edge.api('vaultSetPin', { newPin: PIN })).ok, true);
  const saved = await edge.api('vaultSave', { accountId: 'EXL-01', label: 'Login', text: PLAIN, pin: PIN }, STAFF);
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await edge.api('vaultList', {}, VIEWER)).code, 'forbidden');
  assert.equal((await edge.api('vaultReveal', { secretId: saved.data.secretId, pin: PIN }, VIEWER)).code, 'forbidden');
  const rev = await edge.api('vaultReveal', { secretId: saved.data.secretId, pin: PIN }, STAFF);
  assert.equal(rev.ok, true, rev.error);
  assert.equal(rev.data.text, PLAIN);
  assert.equal((await edge.api('vaultDelete', { secretId: saved.data.secretId, pin: PIN }, STAFF)).code, 'forbidden');
  assert.equal((await edge.api('vaultSetPin', { newPin: '1111' }, STAFF)).code, 'forbidden');
});

test('vault: only ciphertext is stored; list has no ciphertext; reveal and save never reach request_log or change_log', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN, requestId: 'pin1' });
  const s = await edge.api('vaultSave', { requestId: 'save1', saleId: '1', accountId: 'EXL-01', label: 'Main login', text: PLAIN, pin: PIN });
  assert.equal(s.ok, true, s.error);
  const again = await edge.api('vaultSave', { requestId: 'save1', saleId: '1', accountId: 'EXL-01', label: 'Main login', text: PLAIN, pin: PIN });
  assert.equal(again.data.secretId, s.data.secretId);
  assert.equal(tables.account_secrets.size, 1, 'a repeated request id adds nothing');
  const row = tables.account_secrets.get(s.data.secretId);
  assert.ok(row.ciphertext && row.iv);
  const rev = await edge.api('vaultReveal', { requestId: 'rev1', secretId: s.data.secretId, pin: PIN });
  assert.equal(rev.data.text, PLAIN);
  const list = await edge.api('vaultList', { accountId: 'EXL-01' });
  assert.equal(list.data.secrets.length, 1);
  assert.equal(list.data.pinSet, true);
  assert.deepEqual(Object.keys(list.data.secrets[0]).sort(), ['accountId', 'created', 'label', 'saleId', 'secretId']);
  const blob = dump(tables);
  ['demo-login-name', 'demo-pass-phrase-77', PIN].forEach(t => assert.ok(!blob.includes(t), 'leaked ' + t));
  assert.equal(tables.request_log.has('rev1'), false);
  assert.ok(tables.change_log.some(c => c.action === 'vault:reveal' && String(c.row_key) === s.data.secretId));
  // The PIN hash is not part of the settings every role gets.
  const init = await edge.api('init', {});
  // (The fake database's version token is a plain join; the real one is an md5.)
  delete init.data.version;
  assert.ok(!JSON.stringify(init).includes('vault_pin_hash'));
  assert.ok(!JSON.stringify(init).includes('pbkdf2'));
  assert.equal((await edge.api('settings', { values: { vault_pin_hash: 'x' } })).ok, false);
});

test('vault fails closed without VAULT_KEY', async () => {
  const { edge, tables } = await boot({});
  await edge.api('vaultSetPin', { newPin: PIN });
  const s = await edge.api('vaultSave', { accountId: 'EXL-01', label: 'x', text: PLAIN, pin: PIN });
  assert.deepEqual([s.ok, s.error], [false, 'Vault not configured: set VAULT_KEY.']);
  assert.equal(tables.account_secrets.size, 0);
  assert.equal((await edge.api('vaultReveal', { secretId: 'a', pin: PIN })).error, 'Vault not configured: set VAULT_KEY.');
});

test('PIN: 6 to 12 digits, a change needs the current PIN, 5 wrong PINs lock the actor for 15 minutes', async () => {
  const { edge, tables } = await boot();
  assert.equal((await edge.api('vaultSetPin', { newPin: '12' })).ok, false);
  assert.equal((await edge.api('vaultSetPin', { newPin: '12ab34' })).ok, false);
  assert.equal((await edge.api('vaultSetPin', { newPin: PIN })).ok, true);
  assert.equal((await edge.api('vaultSetPin', { newPin: '999999', currentPin: '000000' })).ok, false);
  assert.equal((await edge.api('vaultSetPin', { newPin: '999999', currentPin: PIN })).ok, true);
  const s = await edge.api('vaultSave', { accountId: 'EXL-01', label: 'L', text: PLAIN, pin: '999999' }, STAFF);
  assert.equal(s.ok, true, s.error);
  for (let i = 0; i < 4; i++) {
    const r = await edge.api('vaultReveal', { secretId: s.data.secretId, pin: '1234' }, STAFF);
    assert.equal(r.code, 'vault_pin');
  }
  const fifth = await edge.api('vaultReveal', { secretId: s.data.secretId, pin: '1234' }, STAFF);
  assert.equal(fifth.code, 'vault_locked');
  // Locked: even the right PIN is refused.
  const locked = await edge.api('vaultReveal', { secretId: s.data.secretId, pin: '999999' }, STAFF);
  assert.equal(locked.code, 'vault_locked');
  // Another actor is not locked.
  assert.equal((await edge.api('vaultReveal', { secretId: s.data.secretId, pin: '999999' })).ok, true);
  assert.ok(tables.change_log.filter(c => c.action === 'vault:pin-fail').length >= 5);
  assert.ok(!dump(tables).includes('1234'), 'a wrong PIN is not logged');
});

test('importStage encrypts a row secret and never stores plaintext; refuses it without VAULT_KEY', async () => {
  const rows = [
    { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', cost: 900, slots: 3, secret: 'label: boss@example.test' } },
    { id: 'imp:S:L1', kind: 'line', sheet: 'S', ref: 'L1', data: { accountRef: 'imp:S:A1', name: 'Synthetic Person', profile: '', amount: 300, secretCipher: 'forged', secretIv: 'forged' } }
  ];
  const { edge, tables } = await boot();
  const r = await edge.api('importStage', { requestId: 's1', batch: 'imp', rows });
  assert.equal(r.ok, true, r.error);
  const stored = all(tables.import_rows);
  assert.equal(stored.length, 2);
  const blob = JSON.stringify(stored);
  assert.ok(!blob.includes('boss@example.test') && !blob.includes('example.test') && !blob.includes('"secret"') && !blob.includes('forged'));
  const a1 = JSON.parse(tables.import_rows.get('imp:S:A1').data);
  assert.ok(a1.secretCipher && a1.secretIv);
  assert.equal(await edge.vault.decrypt(a1.secretCipher, a1.secretIv, 'imp:S:A1'), 'label: boss@example.test');
  await assert.rejects(() => edge.vault.decrypt(a1.secretCipher, a1.secretIv, 'imp:S:L1'));
  const none = await boot({});
  const bad = await none.edge.api('importStage', { requestId: 's2', batch: 'imp', rows });
  assert.deepEqual([bad.ok, bad.error], [false, 'Set VAULT_KEY before staging login details.']);
  assert.equal(none.tables.import_rows.size, 0);
});

test('review shows a login badge, no "@" error, and never the ciphertext', async () => {
  const { edge } = await boot();
  await edge.api('importStage', { requestId: 's1', batch: 'imp', rows: [
    { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', cost: 900, slots: 3, renewalDate: '2026-11-20', secret: 'a@b.test' } }] });
  const r = await edge.api('importReview', {});
  const v = r.data.accounts[0].row;
  assert.equal(v.hasSecret, true);
  assert.ok(!v.issues.some(i => i.includes('@') || /login/i.test(i)));
  assert.ok(!JSON.stringify(r.data).includes('secretCipher'));
});

test('editing a field to a login: error offers Store as login details; storing moves it to the encrypted secret', async () => {
  const { edge, tables } = await boot();
  await edge.api('importStage', { requestId: 's1', batch: 'imp', rows: [
    { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', cost: 900, slots: 3 } }] });
  const refused = await edge.api('importEdit', { requestId: 'e1', rowId: 'imp:S:A1', data: { label: 'me@example.test' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'looks_like_login');
  assert.deepEqual(refused.fields, ['label']);
  assert.ok(!JSON.stringify(tables.import_rows.get('imp:S:A1')).includes('example.test'));
  const moved = await edge.api('importEdit', { requestId: 'e2', rowId: 'imp:S:A1', data: { label: 'me@example.test' }, storeAsLogin: ['label'] });
  assert.equal(moved.ok, true, moved.error);
  const d = JSON.parse(tables.import_rows.get('imp:S:A1').data);
  assert.equal(d.label, '');
  assert.equal(await edge.vault.decrypt(d.secretCipher, d.secretIv, 'imp:S:A1'), 'label: me@example.test');
  assert.ok(!dump(tables).includes('example.test'));
  const again = await edge.api('importEdit', { requestId: 'e3', rowId: 'imp:S:A1', data: { label: 'two@example.test' }, storeAsLogin: ['label'] });
  const d2 = JSON.parse(tables.import_rows.get('imp:S:A1').data);
  assert.equal(await edge.vault.decrypt(d2.secretCipher, d2.secretIv, 'imp:S:A1'), 'label: me@example.test\nlabel: two@example.test');
  assert.equal(again.ok, true);
});

test('importApply stores each login as an account_secrets row linked to the account and the sale, idempotently', async () => {
  const { edge, tables } = await boot();
  const rows = [
    { id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', collected: 300, cost: 900, renewalDate: '2026-11-20', slots: 3, secret: 'account pass 1' } },
    { id: 'imp:S:L1', kind: 'line', sheet: 'S', ref: 'L1', data: { accountRef: 'imp:S:A1', name: 'Synthetic Person', status: 'Paid', amount: 300, paidTill: '2026-11-20', coversFrom: '2026-10-20', secret: 'profile: pin 4455' } }
  ];
  assert.equal((await edge.api('importStage', { requestId: 's1', batch: 'imp', rows })).ok, true);
  assert.equal((await edge.api('importStatus', { requestId: 'a1', rowIds: rows.map(r => r.id), status: 'Approved' })).ok, true);
  const ap = await edge.api('importApply', { requestId: 'ap1', batch: 'imp' });
  assert.equal(ap.ok, true, ap.error);
  assert.equal(ap.data.secrets, 2);
  const secrets = all(tables.account_secrets);
  assert.equal(secrets.length, 2);
  const acc = secrets.find(s => s.secret_id === 'sec:imp:S:A1'), line = secrets.find(s => s.secret_id === 'sec:imp:S:L1');
  assert.ok(acc.account_id && acc.account_id !== 'EXL-01' && acc.sale_id === '');
  assert.ok(line.sale_id && line.account_id === acc.account_id);
  assert.ok(all(tables.sales).some(s => String(s.sale_id) === line.sale_id && s.account_id === acc.account_id));
  assert.ok(!JSON.stringify(secrets).includes('account pass 1'));
  // Re-encrypted under the new id: the old AAD no longer opens it.
  await assert.rejects(() => edge.vault.decrypt(line.ciphertext, line.iv, 'imp:S:L1'));
  await edge.api('vaultSetPin', { newPin: PIN });
  const rev = await edge.api('vaultReveal', { secretId: 'sec:imp:S:L1', pin: PIN });
  assert.equal(rev.data.text, 'profile: pin 4455');
  assert.deepEqual((await edge.api('vaultList', { saleId: line.sale_id })).data.secrets.map(s => s.secretId), ['sec:imp:S:L1']);
  // Replay: same request id answers from request_log without a second write; the stored reply holds no plaintext.
  const replay = await edge.api('importApply', { requestId: 'ap1', batch: 'imp' });
  assert.equal(replay.ok, true);
  assert.equal(all(tables.account_secrets).length, 2);
  assert.ok(!dump(tables).includes('pin 4455'));
});

test('importApply with logins and no VAULT_KEY writes nothing', async () => {
  const staged = await boot();
  const rows = [{ id: 'imp:S:A1', kind: 'account', sheet: 'S', ref: 'A1', data: { productHint: 'Netflix', label: 'Synthetic Acct', cost: 900, renewalDate: '2026-11-20', slots: 3, secret: 'x1' } }];
  await staged.edge.api('importStage', { requestId: 's1', batch: 'imp', rows });
  await staged.edge.api('importStatus', { requestId: 'a1', rowIds: ['imp:S:A1'], status: 'Approved' });
  const noKey = loadEdge(staged.db, { env: {} });
  const r = await noKey.api('importApply', { requestId: 'ap1', batch: 'imp' });
  assert.deepEqual([r.ok, r.error], [false, 'Set VAULT_KEY before applying login details.']);
  assert.equal(JSON.parse(staged.tables.import_rows.get('imp:S:A1').status === 'Approved' ? '1' : '0'), 1);
});

test('HTTP: api answers are Cache-Control no-store', async () => {
  const { db, tables } = makeFakeDb();
  await seedDb(db, tables, makeUiState());
  const edge = loadEdge(db, { env: { APP_SECRET: 'unit-secret', VAULT_KEY: KEY } });
  const res = await edge.handle(new Request('https://x.test/functions/v1/api/', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Secret': 'unit-secret' }, body: JSON.stringify({ action: 'vaultList', payload: {} }) }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

// ---- delivery messages ----
const firstSale = tables => all(tables.sales).filter(s => s.account_id)[0];

test('delivery template: placeholders only, filled once, unknown placeholder refused, owner-only writes', async () => {
  const D = Core.delivery;
  assert.equal(D.checkTemplate('Hi {{name}}, {{login}} till {{paidTill}}'), '');
  assert.match(D.checkTemplate('Hi {{secret}}'), /Unknown placeholder \{\{secret\}\}/);
  assert.match(D.checkTemplate('  '), /Write the message/);
  // A value that looks like a placeholder is not filled a second time.
  assert.equal(D.fillTemplate('A {{name}} B {{login}}', { name: '{{login}}', login: 'L' }), 'A {{login}} B L');
  assert.equal(D.fillTemplate('{{profile}}|', {}), '|');
  const { edge } = await boot();
  const body = { title: 'Login', body: 'Hi {{name}}', productId: '', accountId: '' };
  assert.equal((await edge.api('deliveryTemplateSave', body, STAFF)).code, 'forbidden');
  assert.equal((await edge.api('deliveryTemplateDelete', { templateId: 'x' }, STAFF)).code, 'forbidden');
  assert.equal((await edge.api('deliveryTemplates', {}, VIEWER)).code, 'forbidden');
  assert.equal((await edge.api('deliveryMessage', { saleId: 1, templateId: 'x', pin: PIN }, VIEWER)).code, 'forbidden');
  assert.equal((await edge.api('deliveryTemplateSave', { title: 'x', body: '{{nope}}' })).ok, false);
  assert.equal((await edge.api('deliveryTemplates', {}, STAFF)).ok, true);
});

test('deliveryMessage: PIN gate, fills name/product/profile/paidTill/login, nothing secret in request_log or change_log', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const sale = firstSale(tables);
  const saved = await edge.api('vaultSave', { accountId: sale.account_id, label: 'Account login', text: PLAIN, pin: PIN });
  assert.equal(saved.ok, true, saved.error);
  const t = await edge.api('deliveryTemplateSave', { requestId: 't1', title: 'Login', body: 'Hi {{name}}\nLogin: {{login}}\nProfile: {{profile}}\nTill {{paidTill}} for {{product}}' });
  assert.equal(t.ok, true, t.error);
  assert.equal((await edge.api('deliveryTemplateSave', { requestId: 't1', title: 'Login', body: 'Hi {{name}}\nLogin: {{login}}\nProfile: {{profile}}\nTill {{paidTill}} for {{product}}' })).data.templateId, t.data.templateId);
  assert.equal(tables.delivery_templates.size, 1);
  const noPin = await edge.api('deliveryMessage', { saleId: sale.sale_id, templateId: t.data.templateId, pin: '0000' }, STAFF);
  assert.equal(noPin.code, 'vault_pin');
  const r = await edge.api('deliveryMessage', { requestId: 'dm1', saleId: sale.sale_id, templateId: t.data.templateId, pin: PIN }, STAFF);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.text.includes(PLAIN));
  assert.ok(r.data.text.includes('Hi ' + sale.customer));
  assert.ok(r.data.text.includes('Till ' + sale.paid_till));
  assert.ok(!r.data.text.includes('{{'));
  const blob = dump(tables) + JSON.stringify(all(tables.delivery_templates));
  ['demo-login-name', 'demo-pass-phrase-77', PIN].forEach(x => assert.ok(!blob.includes(x), 'leaked ' + x));
  assert.equal(tables.request_log.has('dm1'), false);
  assert.ok(tables.change_log.some(c => c.action === 'delivery:message'));
  // No saved login and a {{login}} template: a clear refusal, not an empty login.
  const other = all(tables.sales).filter(s => s.account_id && s.account_id !== sale.account_id)[0];
  if (other) {
    const miss = await edge.api('deliveryMessage', { saleId: other.sale_id, templateId: t.data.templateId, pin: PIN }, STAFF);
    assert.equal(miss.ok, false);
    assert.match(miss.error, /No login details/);
  }
});

test('deliveryMessage: a sale-linked login wins over the account login; a template for another product is refused', async () => {
  const { edge, tables } = await boot();
  await edge.api('vaultSetPin', { newPin: PIN });
  const sale = firstSale(tables);
  await edge.api('vaultSave', { accountId: sale.account_id, label: 'A', text: 'account-level', pin: PIN });
  await edge.api('vaultSave', { accountId: sale.account_id, saleId: String(sale.sale_id), label: 'S', text: 'sale-level', pin: PIN });
  const t = await edge.api('deliveryTemplateSave', { title: 'L', body: '{{login}}' });
  const r = await edge.api('deliveryMessage', { saleId: sale.sale_id, templateId: t.data.templateId, pin: PIN });
  assert.equal(r.data.text, 'sale-level');
  const wrong = await edge.api('deliveryTemplateSave', { title: 'W', body: '{{name}}', productId: 'NOPE' });
  const bad = await edge.api('deliveryMessage', { saleId: sale.sale_id, templateId: wrong.data.templateId, pin: PIN });
  assert.match(bad.error, /not for this sale/);
});

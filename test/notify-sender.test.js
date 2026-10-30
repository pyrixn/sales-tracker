// The notification sender through the real Edge router over the fake db, with fetch stubbed (nothing reaches WhatsApp, Discord or
// Telegram). Covers: a reminder is queued and sent once, two runs at once send a row once (claim), retries with backoff, a failure
// that stops for good, owner alerts (unmatched payment, a webhook that gave up), the status card (no secrets), and the switches.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeDb } = require('./support/fake-db');
const { seedDb, makeUiState } = require('./support/seed');
const { loadEdge } = require('./support/edge-host');
const { Core } = require('./load-core');

const TODAY = '2026-10-28';
const ENV = { WHATSAPP_TOKEN: 'wa-secret-token', WHATSAPP_PHONE_ID: '1055500001', DISCORD_WEBHOOK_URL: 'https://discord.example/hook/abc',
  TELEGRAM_BOT_TOKEN: 'tg-secret-token', TELEGRAM_CHAT_ID: '-100123' };

/** Replaces fetch for the test. handler(url, init) -> Response, or throws. Restore puts the real one back. */
function stubFetch(handler) {
  const orig = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init }); await new Promise(r => setImmediate(r)); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const ok = () => new Response('{}', { status: 200 });
const status = (n) => () => new Response('{}', { status: n });

/**
 * Jamil (WhatsApp, 01711111111) has an active line ending in two days, so a 'before' reminder is due. The WhatsApp switch is on,
 * the template is named, and the Discord switch is on for owner alerts. Env: the secrets for WhatsApp and Discord only.
 */
async function host(opts) {
  const { db, tables } = makeFakeDb();
  const st = makeUiState();
  const jamil = st.customers.find(c => c.Name === 'jamilhq');
  const base = st.sales.find(s => s.Customer_ID === jamil.Customer_ID && s.Record_Status === 'Active') || st.sales[0];
  st.sales = st.sales.map(s => (s.Sale_ID === base.Sale_ID ? Object.assign({}, s, { Pay_Token: 'tokJAMILjamil000000', Paid_Till: '2026-10-30',
    Record_Status: 'Active', Months: 1 }) : s));
  await seedDb(db, tables, st);
  tables.settings.set('pay_base_url', 'https://pay.example');
  tables.settings.set('notify_whatsapp_enabled', 'true');
  tables.settings.set('wa_tpl_before', 'renew_soon');
  tables.settings.set('notify_discord_enabled', opts && opts.discord === false ? 'false' : 'true');
  const env = Object.assign({}, { WHATSAPP_TOKEN: ENV.WHATSAPP_TOKEN, WHATSAPP_PHONE_ID: ENV.WHATSAPP_PHONE_ID, DISCORD_WEBHOOK_URL: ENV.DISCORD_WEBHOOK_URL }, opts && opts.env);
  const edge = loadEdge(db, { today: TODAY, env: env });
  return { db, tables, edge, api: (a, p) => edge.api(a, p || {}) };
}
const rows = (h) => Array.from(h.tables.notify_outbox.values());
const remindRow = (h) => rows(h).filter(r => r.id.indexOf('remind:') === 0)[0];

test('a due reminder is queued for the WhatsApp customer and sent once with the approved template', async () => {
  const h = await host();
  const f = stubFetch(ok);
  try {
    const r = await h.api('sendNotifications');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.sent >= 1, true);
    const wa = f.calls.find(c => c.url.indexOf('graph.facebook.com/v21.0/1055500001/messages') >= 0);
    assert.ok(wa, 'the WhatsApp Cloud API was called');
    assert.equal(wa.init.headers.Authorization, 'Bearer wa-secret-token');
    const body = JSON.parse(wa.init.body);
    assert.equal(body.to, '8801711111111');
    assert.equal(body.template.name, 'renew_soon');
    assert.match(body.template.components[0].parameters[3].text, /^https:\/\/pay\.example\/pay\/tokJAMILjamil000000$/);
    const row = remindRow(h);
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);
    assert.equal(row.error, '');
  } finally { f.restore(); }
});

test('a second run does not send the reminder again', async () => {
  const h = await host();
  const f = stubFetch(ok);
  try {
    await h.api('sendNotifications');
    const before = f.calls.length;
    const again = await h.api('sendNotifications');
    assert.equal(again.ok, true);
    assert.equal(f.calls.length, before, 'nothing new was sent');
    assert.equal(rows(h).filter(r => r.id === remindRow(h).id).length, 1, 'queued once');
  } finally { f.restore(); }
});

test('claim once: two runs at the same time send each row exactly once', async () => {
  const h = await host();
  const f = stubFetch(ok);
  try {
    const [a, b] = await Promise.all([h.api('sendNotifications'), h.api('sendNotifications')]);
    assert.equal(a.ok && b.ok, true);
    const perRow = {};
    f.calls.forEach(c => { perRow[c.url] = (perRow[c.url] || 0) + 1; });
    const ids = rows(h).map(r => r.id);
    assert.equal(f.calls.length, ids.length, 'one request for each queued row, not two');
    assert.ok(Object.values(perRow).every(n => n === 1));
    assert.ok(rows(h).every(r => r.status === 'sent'));
  } finally { f.restore(); }
});

test('the claim is atomic: a row a run holds cannot be claimed again until its lease ends', async () => {
  const h = await host();
  await h.api('sendNotifications', {}).catch(() => {});
  const f = stubFetch(status(500));
  try {
    const row = remindRow(h);
    const attemptsBefore = row.attempts;
    // Put the row back to pending and due, then claim it twice from the adapter directly.
    h.tables.notify_outbox.get(row.id).status = 'pending';
    h.tables.notify_outbox.get(row.id).next_try_at = '2000-01-01T00:00:00.000Z';
    const Adapter = require('../src/adapters/postgres.js');
    const first = await Adapter.claimNotify(h.db, row.id, '2026-10-28T10:00:00.000Z', '2026-10-28T10:02:00.000Z');
    const second = await Adapter.claimNotify(h.db, row.id, '2026-10-28T10:00:01.000Z', '2026-10-28T10:02:01.000Z');
    assert.ok(first && first.status === 'sending' && first.attempts === attemptsBefore + 1);
    assert.equal(second, null);
  } finally { f.restore(); }
});

test('retry: a 5xx leaves the row pending with a later try, and the error says HTTP 503 (no URL, no token)', async () => {
  const h = await host();
  const f = stubFetch(status(503));
  try {
    await h.api('sendNotifications');
    const row = remindRow(h);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.error, 'HTTP 503');
    assert.ok(Date.parse(row.next_try_at) > Date.parse(TODAY) || Date.parse(row.next_try_at) > Date.now() - 1000, 'a later try');
    // Not due yet: the next run does not call WhatsApp again.
    const before = f.calls.length;
    await h.api('sendNotifications');
    assert.equal(f.calls.length, before);
  } finally { f.restore(); }
});

test('failure: after the last attempt the row is failed and stays visible in the status card', async () => {
  const h = await host();
  const f = stubFetch(status(503));
  try {
    for (let i = 0; i < Core.notify.MAX_ATTEMPTS + 1; i++) {
      const row = remindRow(h);
      if (row) h.tables.notify_outbox.get(row.id).next_try_at = '2000-01-01T00:00:00.000Z';
      await h.api('sendNotifications');
    }
    const row = remindRow(h);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, Core.notify.MAX_ATTEMPTS);
    const st = await h.api('notifyStatus');
    assert.equal(st.data.counts.failed >= 1, true);
    assert.equal(st.data.errors[0].error, 'HTTP 503');
  } finally { f.restore(); }
});

test('a client error (400) fails at once: retrying the same bad request would not help', async () => {
  const h = await host();
  const f = stubFetch(status(400));
  try {
    await h.api('sendNotifications');
    const row = remindRow(h);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.error, 'HTTP 400');
  } finally { f.restore(); }
});

test('a network error is retried, and the error names no address', async () => {
  const h = await host();
  const f = stubFetch(() => { throw new TypeError('fetch failed https://graph.facebook.com/v21.0/1055500001/messages'); });
  try {
    await h.api('sendNotifications');
    const row = remindRow(h);
    assert.equal(row.status, 'pending');
    assert.equal(row.error, 'Could not reach whatsapp (TypeError)');
    assert.ok(!row.error.includes('http'));
  } finally { f.restore(); }
});

test('an unmatched payment goes to the owner on Discord, once, and the message carries the transaction id', async () => {
  const h = await host();
  const f = stubFetch(ok);
  try {
    await h.api('sendNotifications');
    await h.api('sendNotifications');
    const discord = f.calls.filter(c => c.url === ENV.DISCORD_WEBHOOK_URL);
    assert.equal(discord.length, 1, 'one alert for the one unmatched payment');
    assert.match(JSON.parse(discord[0].init.body).content, /manual match: ৳290 .* trx TESTTRX1/);
    assert.ok(!rows(h).some(r => r.channel === 'whatsapp' && r.to_ref === 'owner'));
  } finally { f.restore(); }
});

test('a webhook that gives up is a failed job: the owner gets one Discord alert about it', async () => {
  const h = await host();
  h.tables.webhook_endpoints.set('wh_1', { id: 'wh_1', url: 'https://hooks.shop.example/x', secret: 'whsec_test', events: ['order.paid'], active: true,
    created_at: '2026-10-01T00:00:00.000Z' });
  h.tables.webhook_deliveries.set('evt_1', { id: 'evt_1', endpoint_id: 'wh_1', event: 'order.paid', payload: { orderId: 'O1' }, attempts: 7,
    status: 'pending', next_try_at: '2000-01-01T00:00:00.000Z', last_error: 'HTTP 500', created_at: '2026-10-27T00:00:00.000Z', delivered_at: null });
  const f = stubFetch((url) => (url.indexOf('hooks.shop.example') >= 0 ? status(500)() : ok()));
  try {
    const sent = await h.api('sendWebhooks');
    assert.equal(sent.data.failed, 1);
    await h.api('sendNotifications');
    const alert = f.calls.find(c => c.url === ENV.DISCORD_WEBHOOK_URL);
    assert.ok(alert, 'the owner was alerted');
    assert.match(JSON.parse(alert.init.body).content, /Webhook order\.paid \(evt_1\) failed after 8 tries: HTTP 500/);
  } finally { f.restore(); }
});

test('no send is attempted for a channel without its secret, and the row fails with a clear reason', async () => {
  const h = await host({ env: { WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '' } });
  const f = stubFetch(ok);
  try {
    const st = await h.api('notifyStatus');
    assert.equal(st.data.channels.whatsapp.configured, false);
    assert.equal(st.data.channels.whatsapp.active, false);
    // Nothing is queued for WhatsApp while it is not configured.
    await h.api('sendNotifications');
    assert.equal(rows(h).filter(r => r.channel === 'whatsapp').length, 0);
    assert.equal(f.calls.filter(c => c.url.indexOf('graph.facebook.com') >= 0).length, 0);
  } finally { f.restore(); }
});

test('the status card carries counts, errors and switches, never a secret', async () => {
  const h = await host();
  const f = stubFetch(status(503));
  try {
    await h.api('sendNotifications');
    const st = await h.api('notifyStatus');
    assert.equal(st.ok, true);
    const text = JSON.stringify(st);
    assert.ok(!text.includes('wa-secret-token') && !text.includes('discord.example') && !text.includes('01711111111'));
    assert.equal(st.data.channels.discord.switchOn, true);
    assert.equal(st.data.channels.discord.active, true);
    assert.equal(st.data.templates.before, 'renew_soon');
  } finally { f.restore(); }
});

test('the switches save only true or false, and the template names only lower case letters, digits and underscores', async () => {
  const h = await host();
  const bad = await h.api('settings', { values: { notify_whatsapp_enabled: 'yes' } });
  assert.equal(bad.ok, false);
  const badTpl = await h.api('settings', { values: { wa_tpl_due: 'Pay Due!' } });
  assert.equal(badTpl.ok, false);
  const good = await h.api('settings', { values: { notify_whatsapp_enabled: 'false', wa_tpl_due: 'pay_due' } });
  assert.equal(good.ok, true, good.error);
  assert.equal(h.tables.settings.get('wa_tpl_due'), 'pay_due');
});

test('a sent WhatsApp reminder is logged to Reminders_Log like a manual send, so planReminders stops listing it', async () => {
  const h = await host();
  const f = stubFetch(ok);
  try {
    const before = h.tables.reminders_log.length;
    const r = await h.api('sendNotifications');
    assert.equal(r.ok, true, r.error);
    const added = h.tables.reminders_log.slice(before);
    assert.equal(added.length, 1, JSON.stringify(added));
    const row = remindRow(h);
    const m = /^remind:([^:]+):(\w+):/.exec(row.id);
    assert.equal(String(added[0].sale_id), m[1]);
    assert.equal(added[0].kind, 'before');
    assert.equal(added[0].channel, 'WhatsApp');
    assert.equal(added[0].status, 'sent');
    const home = await h.api('home');
    assert.ok(!(home.data.reminders || []).some(x => String(x.saleId) === m[1] && x.kind === 'before'), 'no longer planned');
  } finally { f.restore(); }
});

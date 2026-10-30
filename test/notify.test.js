// Core.notify: the pure rules of the notification outbox. No network, no clock: every input is passed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('./load-core');

const N = Core.notify;
const ENV = { WHATSAPP_TOKEN: 'wa-secret-token', WHATSAPP_PHONE_ID: '1055500001', DISCORD_WEBHOOK_URL: 'https://discord.example/hook/abc',
  TELEGRAM_BOT_TOKEN: 'tg-secret-token', TELEGRAM_CHAT_ID: '-100123' };

test('retry plan: backoff doubles from a minute, and the row fails after the last attempt', () => {
  const now = 1000000;
  assert.deepEqual(N.retryPlan(1, now), { status: 'pending', nextTryMs: now + 60000 });
  assert.deepEqual(N.retryPlan(2, now), { status: 'pending', nextTryMs: now + 120000 });
  assert.deepEqual(N.retryPlan(4, now), { status: 'pending', nextTryMs: now + 480000 });
  assert.deepEqual(N.retryPlan(N.MAX_ATTEMPTS, now), { status: 'failed' });
  assert.equal(N.retryPlan(20, now).status, 'failed');
});

test('phone numbers: a Bangladeshi mobile in any usual spelling becomes 880 + 10 digits; anything else is refused', () => {
  assert.equal(N.normalizePhone('01711111111'), '8801711111111');
  assert.equal(N.normalizePhone('+880 1711-111111'), '8801711111111');
  assert.equal(N.normalizePhone('8801711111111'), '8801711111111');
  assert.equal(N.normalizePhone('01211111111'), '');
  assert.equal(N.normalizePhone('017111'), '');
  assert.equal(N.normalizePhone('jamilhq'), '');
  assert.equal(N.normalizePhone(''), '');
});

test('a channel sends only when its switch is on AND its secret is set', () => {
  const configured = N.configuredFromEnv({ WHATSAPP_TOKEN: 'x', WHATSAPP_PHONE_ID: '1' });
  assert.deepEqual(configured, { whatsapp: true, discord: false, telegram: false });
  const on = { notify_whatsapp_enabled: 'true', notify_discord_enabled: 'true', notify_telegram_enabled: 'false' };
  assert.deepEqual(N.enabledChannels(on, configured), { whatsapp: true, discord: false, telegram: false });
  assert.deepEqual(N.enabledChannels({}, configured), { whatsapp: false, discord: false, telegram: false });
  // The secrets never appear in the configured flags, only whether they are set.
  assert.ok(!JSON.stringify(N.configuredFromEnv(ENV)).includes('secret'));
});

function reminderState(overrides) {
  return Object.assign({
    settings: { language: 'en', pay_base_url: 'https://pay.example', wa_tpl_before: 'renew_soon', wa_tpl_on_day: '', wa_tpl_after: 'renew_late',
      wa_tpl_due: 'pay_due', due_reminder_every_days: '5' },
    sales: [{ Sale_ID: 1, Customer_ID: 'C1', Product_ID: 'P1', Paid_Till: '2026-10-30', Pay_Token: 'tok1234567890abcdef' }]
  }, overrides || {});
}
const item = (over) => Object.assign({ saleId: 1, customerId: 'C1', name: 'Rahim', kind: 'before', channel: 'WhatsApp', handle: '01711111111',
  productName: 'ExitLag', amount: 300 }, over || {});

test('reminder rows: WhatsApp customers with a mobile number and an approved template, one row per renewal cycle', () => {
  const st = reminderState();
  const planned = N.reminderRows(st, [item(), item({ kind: 'on_day' }), item({ channel: 'Messenger' }), item({ handle: 'rahim_fb' })], { today: '2026-10-28', enabled: true });
  assert.equal(planned.rows.length, 1, 'on_day has no template, Messenger is not WhatsApp, and the handle is not a phone');
  assert.deepEqual(planned.skipped, { off: 0, noPhone: 1, noTemplate: 1 });
  const row = planned.rows[0];
  assert.equal(row.id, 'remind:1:before:2026-10-30');
  assert.equal(row.channel, 'whatsapp');
  assert.equal(row.to_ref, '8801711111111');
  assert.equal(row.template, 'renew_soon');
  assert.deepEqual(row.payload.params, ['Rahim', 'ExitLag', '৳300', 'https://pay.example/pay/tok1234567890abcdef']);
});

test('reminder rows: nothing is queued while the WhatsApp switch is off, and the reason is counted', () => {
  const planned = N.reminderRows(reminderState(), [item()], { today: '2026-10-28', enabled: false });
  assert.equal(planned.rows.length, 0);
  assert.equal(planned.skipped.off, 1);
});

test('reminder rows: a due reminder keeps one id for its N-day bucket, and parameters carry no line breaks', () => {
  const st = reminderState();
  const a = N.reminderRows(st, [item({ kind: 'due', amount: 120, name: 'Rahim\nKhan' })], { today: '2026-10-28', enabled: true }).rows[0];
  const b = N.reminderRows(st, [item({ kind: 'due', amount: 120 })], { today: '2026-10-28', enabled: true }).rows[0];
  const c = N.reminderRows(st, [item({ kind: 'due', amount: 120 })], { today: '2026-11-10', enabled: true }).rows[0];
  assert.equal(a.id, b.id, 'same bucket, same id: queued once');
  assert.notEqual(a.id, c.id, 'a later bucket gets a new reminder');
  assert.equal(a.template, 'pay_due');
  assert.equal(a.payload.params[0], 'Rahim Khan');
});

test('owner rows: one per enabled owner channel only, with a stable id per channel', () => {
  const rows = N.ownerRows({ whatsapp: true, discord: true, telegram: false }, 'order:77', 'hello');
  assert.deepEqual(rows.map(r => r.id), ['order:77|discord']);
  assert.equal(rows[0].to_ref, 'owner');
  assert.equal(rows[0].payload.text, 'hello');
  assert.equal(N.ownerRows({ discord: true, telegram: true }, 'k', 'x').length, 2);
  assert.equal(N.ownerRows({}, 'k', 'x').length, 0);
});

test('owner text: an order, a payment needing a match and a failed job each say what happened', () => {
  const order = N.ownerText('order', { orderId: 'ORD-9', product: 'ExitLag', months: 2, total: 600 });
  assert.match(order, /New website order ORD-9: ExitLag x2 month\(s\), ৳600\./);
  const pay = N.ownerText('payment', { amount: 300, sender: '01711111111', trx: 'BK123', reference: 'N54' });
  assert.match(pay, /manual match: ৳300 from 01711111111, trx BK123, reference N54/);
  const job = N.ownerText('job', { event: 'order.paid', deliveryId: 'd1', attempts: 8, error: 'HTTP 500' });
  assert.match(job, /Webhook order\.paid \(d1\) failed after 8 tries: HTTP 500\./);
});

test('inbox key: a transaction id when there is one, otherwise a stable hash of the SMS', () => {
  assert.equal(N.inboxKey({ trx: 'BK123', sms: 'x' }), 'inbox:BK123');
  const a = N.inboxKey({ trx: '', sms: 'You received Tk 300' }), b = N.inboxKey({ trx: '', sms: 'You received Tk 300' });
  assert.equal(a, b);
  assert.notEqual(a, N.inboxKey({ trx: '', sms: 'You received Tk 301' }));
  assert.match(a, /^inbox:sms:[0-9a-f]+$/);
});

test('send requests: WhatsApp template body with the phone id in the URL; the token only in the header', () => {
  const row = { to_ref: '8801711111111', template: 'renew_soon', payload: { lang: 'bn', params: ['Rahim', 'ExitLag', '৳300', 'https://pay.example/pay/x'] } };
  const req = N.buildSend('whatsapp', row, ENV);
  assert.equal(req.url, 'https://graph.facebook.com/v21.0/1055500001/messages');
  assert.equal(req.headers.Authorization, 'Bearer wa-secret-token');
  const body = JSON.parse(req.body);
  assert.equal(body.type, 'template');
  assert.equal(body.to, '8801711111111');
  assert.equal(body.template.name, 'renew_soon');
  assert.equal(body.template.language.code, 'bn');
  assert.equal(body.template.components[0].parameters.length, 4);
  assert.ok(!req.body.includes('wa-secret-token'));
});

test('send requests: Discord posts content to the webhook URL; Telegram posts to the bot API', () => {
  const d = N.buildSend('discord', { payload: { text: 'hi' } }, ENV);
  assert.equal(d.url, ENV.DISCORD_WEBHOOK_URL);
  assert.deepEqual(JSON.parse(d.body), { content: 'hi' });
  const t = N.buildSend('telegram', { payload: { text: 'hi' } }, ENV);
  assert.equal(t.url, 'https://api.telegram.org/bottg-secret-token/sendMessage');
  assert.deepEqual(JSON.parse(t.body), { chat_id: '-100123', text: 'hi', disable_web_page_preview: true });
});

test('send requests: a channel without its secrets gives an error, not a request', () => {
  assert.equal(N.buildSend('whatsapp', { payload: {} }, {}).error, 'WhatsApp is not configured');
  assert.equal(N.buildSend('discord', { payload: {} }, {}).error, 'Discord is not configured');
  assert.equal(N.buildSend('sms', { payload: {} }, ENV).error, 'Unknown channel sms');
});

test('classify: 2xx is ok, 429 and 5xx retry, other codes fail for good', () => {
  assert.equal(N.classify(200), 'ok');
  assert.equal(N.classify(204), 'ok');
  assert.equal(N.classify(429), 'retry');
  assert.equal(N.classify(503), 'retry');
  assert.equal(N.classify(400), 'fail');
  assert.equal(N.classify(404), 'fail');
});

test('waText: no line breaks, no runs of four spaces, never empty', () => {
  assert.equal(N.waText('a\n\tb'), 'a b');
  assert.equal(N.waText('a      b'), 'a   b');
  assert.equal(N.waText('   '), '-');
});

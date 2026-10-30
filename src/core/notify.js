/**
 * Core.notify: the pure rules of the notification outbox. It decides which messages to queue (customer reminders on WhatsApp,
 * owner alerts on Discord and Telegram), what each queued row says, how a send is retried, and the exact request each channel needs.
 * No I/O and no clock: the server passes in the time, the settings, and which channels have their secrets set (env values are
 * read there, never stored in settings). The server does the fetch.
 */
var Core = Core || {};
Core.notify = (function () {
  var CHANNELS = ['whatsapp', 'discord', 'telegram'];
  var OWNER_CHANNELS = ['discord', 'telegram'];
  var MAX_ATTEMPTS = 5, BACKOFF_BASE_MS = 60000, BACKOFF_CAP_MS = 3600000, LEASE_MS = 120000, TIMEOUT_MS = 8000;
  var WA_API = 'https://graph.facebook.com/v21.0/';
  var TG_API = 'https://api.telegram.org/bot';
  // Setting that holds the approved WhatsApp template name for each reminder kind (blank = do not send that kind).
  var KIND_TEMPLATE = { before: 'wa_tpl_before', on_day: 'wa_tpl_on_day', after: 'wa_tpl_after', due: 'wa_tpl_due' };
  var ENABLE_KEY = { whatsapp: 'notify_whatsapp_enabled', discord: 'notify_discord_enabled', telegram: 'notify_telegram_enabled' };
  var ENV_OK = {
    whatsapp: function (e) { return !!(e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_ID); },
    discord: function (e) { return !!e.DISCORD_WEBHOOK_URL; },
    telegram: function (e) { return !!(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID); }
  };

  /** Next try after a failed send, or 'failed' once the attempts are used up. attempts counts this try too. */
  function retryPlan(attempts, nowMs) {
    if (Number(attempts) >= MAX_ATTEMPTS) return { status: 'failed' };
    var delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, Number(attempts) - 1)));
    return { status: 'pending', nextTryMs: nowMs + delay };
  }
  /** A claimed row is locked for this long; a crash mid-send lets a later run take it again. */
  function leaseUntil(nowMs) { return nowMs + LEASE_MS; }

  /** A Bangladeshi mobile number as WhatsApp wants it (880 + 10 digits), or '' when the handle is not one. */
  function normalizePhone(handle) {
    var d = String(handle || '').replace(/\D/g, '');
    if (d.length === 11 && d.indexOf('01') === 0) d = '880' + d.slice(1);
    return /^8801[3-9]\d{8}$/.test(d) ? d : '';
  }

  /** WhatsApp template parameters take no line breaks, tabs or runs of 4+ spaces, and may not be empty. */
  function waText(s) {
    var t = String(s === undefined || s === null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
    return t || '-';
  }

  /** Which channels may send: the switch in settings is on AND the secrets are set. configured comes from configuredFromEnv. */
  function enabledChannels(settings, configured) {
    var out = {};
    CHANNELS.forEach(function (ch) { out[ch] = String((settings || {})[ENABLE_KEY[ch]] || '') === 'true' && !!(configured || {})[ch]; });
    return out;
  }
  /** Booleans only: which channels have their secrets. The values themselves never leave the server. */
  function configuredFromEnv(env) {
    var out = {};
    CHANNELS.forEach(function (ch) { out[ch] = ENV_OK[ch](env || {}); });
    return out;
  }

  /** Reminder "cycle" key: one message per renewal date per kind, one due message per N-day bucket. */
  function dueBucket(today, every) {
    return Math.floor(Date.parse(String(today) + 'T00:00:00Z') / 86400000 / Math.max(1, Number(every) || 5));
  }

  /**
   * Rows for customer reminders (planReminders items) that go to WhatsApp. Skipped, with the reason counted: the channel is off,
   * the handle is not a mobile number, or the kind has no approved template name in settings.
   * Each row id is 'remind:<sale>:<cycle>', so a reminder is queued once per cycle however often the job runs.
   */
  function reminderRows(state, items, opts) {
    var st = (state && state.settings) || {}, sales = {}, rows = [], skipped = { off: 0, noPhone: 0, noTemplate: 0 };
    (state.sales || []).forEach(function (s) { sales[String(s.Sale_ID)] = s; });
    var lang = st.language === 'bn' ? 'bn' : 'en';
    (items || []).forEach(function (it) {
      if (it.channel !== 'WhatsApp') return;
      if (!(opts && opts.enabled)) { skipped.off++; return; }
      var phone = normalizePhone(it.handle);
      if (!phone) { skipped.noPhone++; return; }
      var tpl = String(st[KIND_TEMPLATE[it.kind]] || '').trim();
      if (!tpl) { skipped.noTemplate++; return; }
      var sale = sales[String(it.saleId)] || {};
      var cycle = it.kind === 'due' ? 'due:' + dueBucket(opts.today, st.due_reminder_every_days) : it.kind + ':' + (sale.Paid_Till || '');
      var base = String(st.pay_base_url || '').replace(/\/+$/, '');
      var link = base && sale.Pay_Token ? base + '/pay/' + encodeURIComponent(sale.Pay_Token) : '';
      rows.push({ id: 'remind:' + it.saleId + ':' + cycle, channel: 'whatsapp', to_ref: phone, template: tpl,
        payload: { lang: lang, params: [waText(it.name), waText(it.productName), waText(it.amount === undefined ? '' : Core.reminders.money(it.amount)), waText(link)] } });
    });
    return { rows: rows, skipped: skipped };
  }

  /** Owner alert rows: one per enabled owner channel (discord, telegram). key is the event's stable id. */
  function ownerRows(enabled, key, text) {
    var rows = [];
    OWNER_CHANNELS.forEach(function (ch) {
      if (enabled && enabled[ch]) rows.push({ id: key + '|' + ch, channel: ch, to_ref: 'owner', template: 'owner_alert', payload: { text: String(text || '') } });
    });
    return rows;
  }

  /** The text an owner alert carries. kind: order | payment | job. Owner-only, so names are fine here. */
  function ownerText(kind, d) {
    d = d || {};
    if (kind === 'order') {
      return 'New website order ' + d.orderId + ': ' + (d.product || 'product') + ' x' + (Number(d.months) || 1) + ' month(s), ' + Core.reminders.money(d.total) + '.';
    }
    if (kind === 'payment') {
      return 'Payment needs a manual match: ' + Core.reminders.money(d.amount) + ' from ' + (d.sender || d.counterparty || 'unknown sender') +
        (d.trx ? ', trx ' + d.trx : '') + (d.reference ? ', reference ' + d.reference : '') + '. Open Today to match it.';
    }
    if (kind === 'job') {
      return 'Webhook ' + d.event + ' (' + d.deliveryId + ') failed after ' + d.attempts + ' tries: ' + (d.error || 'unknown error') + '.';
    }
    return String(d.text || '');
  }

  /** Stable key for an unmatched inbox message: its transaction id, or a hash of the SMS text when it has none. */
  function inboxKey(u) {
    if (u.trx) return 'inbox:' + u.trx;
    var s = String(u.sms || ''), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'inbox:sms:' + h.toString(16);
  }

  /** The request a channel needs for one row: { url, headers, body } or { error }. The body never carries a secret; Discord and Telegram URLs do. */
  function buildSend(channel, row, env) {
    env = env || {};
    var p = row.payload || {};
    if (channel === 'whatsapp') {
      if (!ENV_OK.whatsapp(env)) return { error: 'WhatsApp is not configured' };
      return { url: WA_API + env.WHATSAPP_PHONE_ID + '/messages', headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: row.to_ref, type: 'template',
          template: { name: row.template, language: { code: p.lang === 'bn' ? 'bn' : 'en' },
            components: [{ type: 'body', parameters: (p.params || []).map(function (t) { return { type: 'text', text: waText(t) }; }) }] } }) };
    }
    if (channel === 'discord') {
      if (!ENV_OK.discord(env)) return { error: 'Discord is not configured' };
      return { url: env.DISCORD_WEBHOOK_URL, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(p.text || '').slice(0, 2000) }) };
    }
    if (channel === 'telegram') {
      if (!ENV_OK.telegram(env)) return { error: 'Telegram is not configured' };
      return { url: TG_API + env.TELEGRAM_BOT_TOKEN + '/sendMessage', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: String(p.text || '').slice(0, 4096), disable_web_page_preview: true }) };
    }
    return { error: 'Unknown channel ' + channel };
  }

  /** ok (2xx), retry (429 or 5xx), fail (anything else: the request will not succeed as it is). */
  function classify(status) {
    var s = Number(status);
    if (s >= 200 && s < 300) return 'ok';
    if (s === 429 || s >= 500) return 'retry';
    return 'fail';
  }

  return { CHANNELS: CHANNELS, OWNER_CHANNELS: OWNER_CHANNELS, MAX_ATTEMPTS: MAX_ATTEMPTS, TIMEOUT_MS: TIMEOUT_MS, KIND_TEMPLATE: KIND_TEMPLATE,
    ENABLE_KEY: ENABLE_KEY, retryPlan: retryPlan, leaseUntil: leaseUntil, normalizePhone: normalizePhone, waText: waText,
    enabledChannels: enabledChannels, configuredFromEnv: configuredFromEnv, dueBucket: dueBucket, reminderRows: reminderRows,
    ownerRows: ownerRows, ownerText: ownerText, inboxKey: inboxKey, buildSend: buildSend, classify: classify };
})();
if (typeof module !== 'undefined') module.exports = Core.notify;

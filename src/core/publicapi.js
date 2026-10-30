/**
 * Core.publicapi: the rules behind the public API (/v1/... in the Edge Function). Pure: no I/O, no clock, no randomness of its own.
 * The server passes in the time and random bytes. Covers API key format and hashing, scopes, origins, rate-limit windows, the
 * public projections (what a website may see: never codes, costs, suppliers or account data), order input checks, webhook events
 * and the HMAC-SHA256 signature. SHA-256 and HMAC are written here, synchronous, so the same code runs in the Node tests and in
 * the Deno bundle without crypto.subtle.
 */
var Core = Core || {};
Core.publicapi = (function () {
  var SCOPES = ['catalog:read', 'orders:write', 'orders:read', 'portal:read'];
  var KEY_PREFIX = 'st_live_', KEY_LEN = 32, KEY_ID_LEN = 8;
  var BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var KEY_RE = /^st_live_[0-9A-Za-z]{32}$/;
  var WINDOW_MS = 60000;
  var LIMITS = { keyPerMinute: 60, ipPostPerMinute: 20, ipReadPerMinute: 120 };
  var EVENTS = ['order.created', 'order.paid', 'subscription.renewed', 'subscription.ended'];
  var MAX_ATTEMPTS = 8, BACKOFF_BASE_MS = 60000, BACKOFF_CAP_MS = 6 * 3600000;
  var SIG_TOLERANCE_S = 300;
  var ORIGIN_RE = /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;
  var IDEM_RE = /^[A-Za-z0-9_-]{8,128}$/;
  var NAME_MAX = 80, URL_MAX = 500, NOTE_MAX = 500, CUSTOMER_MAX = 120, CHANNEL_MAX = 40, SLUG_MAX = 80;

  // ---- SHA-256 (FIPS 180-4) and HMAC (RFC 2104) ----
  function primes(n) {
    var out = [], c = 2;
    while (out.length < n) {
      var ok = true;
      for (var d = 2; d * d <= c; d++) if (c % d === 0) { ok = false; break; }
      if (ok) out.push(c);
      c++;
    }
    return out;
  }
  // The round constants and the initial hash are the fractional parts of the cube roots and square roots of the first primes.
  function frac32(x) { return Math.floor((x - Math.floor(x)) * 4294967296) >>> 0; }
  var K = primes(64).map(function (p) { return frac32(Math.cbrt(p)); });
  var H0 = primes(8).map(function (p) { return frac32(Math.sqrt(p)); });
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256(bytes) {
    var l = bytes.length, padLen = ((l + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(padLen);
    buf.set(bytes); buf[l] = 0x80;
    var hi = Math.floor(l / 536870912), lo = (l << 3) >>> 0;   // bit length as two 32-bit words, big-endian
    buf[padLen - 8] = hi >>> 24; buf[padLen - 7] = hi >>> 16; buf[padLen - 6] = hi >>> 8; buf[padLen - 5] = hi;
    buf[padLen - 4] = lo >>> 24; buf[padLen - 3] = lo >>> 16; buf[padLen - 2] = lo >>> 8; buf[padLen - 1] = lo;
    var H = H0.slice(), W = new Array(64), i;
    for (var off = 0; off < padLen; off += 64) {
      for (i = 0; i < 16; i++) {
        var j = off + 4 * i;
        W[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = (rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)) >>> 0;
        var s1 = (rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)) >>> 0;
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = H[i] >>> 16; out[4 * i + 2] = H[i] >>> 8; out[4 * i + 3] = H[i]; }
    return out;
  }

  function concatBytes(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    return sha256(concatBytes(opad, sha256(concatBytes(ipad, msg))));
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  /** Constant-time compare of two strings. Unequal lengths are unequal at once (the lengths of signatures and hashes are public). */
  function timingSafeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ---- keys ----
  /** Base62 text of length n from random bytes, dropping bytes >= 248 (62 * 4) so no character is favoured. Null if the bytes run out. */
  function fromRandom(prefix, bytes, n) {
    var out = '';
    for (var i = 0; i < bytes.length && out.length < n; i++) if (bytes[i] < 248) out += BASE62[bytes[i] % 62];
    return out.length === n ? prefix + out : null;
  }
  /** st_live_ plus 32 base62 characters, or null when the random bytes are too few (the caller asks for more). */
  function makeApiKey(bytes) { return fromRandom(KEY_PREFIX, bytes, KEY_LEN); }
  /** A key id, shown in the panel. Not a secret. */
  function makeKeyId(bytes) { return fromRandom('ak_', bytes, KEY_ID_LEN); }
  /** A random token with a prefix and n characters: order tokens, webhook secrets, webhook ids. Null when the bytes run out. */
  function makeToken(prefix, bytes, n) { return fromRandom(prefix, bytes, n); }
  /** A customer's order token (the order status route). */
  function makeOrderToken(bytes) { return fromRandom('ot_', bytes, 40); }
  function keyHash(rawKey) { return hex(sha256(utf8(rawKey))); }
  function isKeyFormat(raw) { return KEY_RE.test(String(raw || '')); }
  /** The key from an Authorization header value, or '' when it is not a Bearer key of the right shape. */
  function bearerKey(header) {
    var m = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
    return m && isKeyFormat(m[1]) ? m[1] : '';
  }

  function checkScopes(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: 'Choose at least one scope.' };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i]);
      if (SCOPES.indexOf(s) < 0) return { ok: false, error: 'Unknown scope ' + s + '.' };
      if (out.indexOf(s) < 0) out.push(s);
    }
    return { ok: true, scopes: out };
  }
  function hasScope(keyRow, scope) { return !!keyRow && Array.isArray(keyRow.scopes) && keyRow.scopes.indexOf(scope) >= 0; }

  /** Lower-case origin (scheme, host, port) or null. A path, a trailing slash, a wildcard or a plain http site is refused. */
  function normalizeOrigin(o) {
    var s = String(o === undefined || o === null ? '' : o).trim().toLowerCase();
    return ORIGIN_RE.test(s) ? s : null;
  }
  function checkOrigins(list) {
    if (!Array.isArray(list)) return { ok: false, error: 'Origins must be a list.' };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = normalizeOrigin(list[i]);
      if (!n) return { ok: false, error: 'Origin ' + String(list[i]) + ' is not a site address such as https://shop.example.' };
      if (out.indexOf(n) < 0) out.push(n);
    }
    return { ok: true, origins: out };
  }
  /** A request with no Origin header is server to server and passes. A browser call must come from an origin the key lists. */
  function originAllowed(keyRow, origin) {
    if (!origin) return true;
    var n = normalizeOrigin(origin);
    return !!n && (keyRow.origins || []).indexOf(n) >= 0;
  }

  // ---- rate limits (fixed window of one minute) ----
  function windowStart(nowMs) { return Math.floor(Number(nowMs) / WINDOW_MS) * WINDOW_MS; }
  function retryAfterSeconds(nowMs) { return Math.max(1, Math.ceil((windowStart(nowMs) + WINDOW_MS - Number(nowMs)) / 1000)); }
  function overLimit(count, limit) { return Number(count) > Number(limit); }
  function ipBucket(ip, method) { return 'ip:' + (method === 'POST' ? 'post' : 'read') + ':' + String(ip || 'unknown'); }
  function ipLimit(method) { return method === 'POST' ? LIMITS.ipPostPerMinute : LIMITS.ipReadPerMinute; }
  function keyBucket(keyId) { return 'key:' + String(keyId); }

  // ---- public projections: whitelists, so a field added to the panel never reaches a website by accident ----
  function isAvailable(state, product) {
    var kind = Core.sales.deliversAs(product);
    if (kind === 'code') {
      var sold = {};
      (state.sales || []).forEach(function (s) { if (s.Code_ID && s.Record_Status !== 'Void') sold[s.Code_ID] = true; });
      return (state.codes || []).some(function (c) {
        return c.Product_ID === product.Product_ID && !sold[c.Code_ID] && (!c.Status || c.Status === 'Available');
      });
    }
    if (kind === 'account') {
      var pool = Core.sales.accountPoolId(state, product);
      return (state.accounts || []).some(function (a) {
        return a.Product_ID === pool && a.Account_Status !== 'Deleted' && Core.sales.freeSlots(state, a) > 0;
      });
    }
    return false;
  }
  /** One product for the website. Only these fields leave the server. */
  function productView(state, p) {
    return {
      slug: String(p.Slug || ''),
      name: String(p.Product_Name || ''),
      description: String(p.Description || ''),
      public_price: Core.orders.catalogPrice(p),
      currency: 'BDT',
      available: isAvailable(state, p),
      image_path: String(p.Image_Path || '')
    };
  }
  /** The website catalog: public products only, in sort order then name. */
  function catalogView(state) {
    return (state.products || []).filter(Core.orders.isPublic).map(function (p) {
      return { sort: Number(p.Sort_Order) || 0, name: String(p.Product_Name || ''), view: productView(state, p) };
    }).sort(function (a, b) {
      return a.sort - b.sort || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }).map(function (x) { return x.view; });
  }
  /** An order as the website sees it. The payment link is included so the customer can pay; no contact details. */
  function orderView(order, product, payRequest, payUrl) {
    return {
      id: String(order.Order_ID),
      status: String(order.Status),
      created: String(order.Created || ''),
      product: product ? { slug: String(product.Slug || ''), name: String(product.Product_Name || '') } : null,
      months: Number(order.Months) || 1,
      total: Number(order.Total) || 0,
      currency: 'BDT',
      payment: { status: payRequest ? String(payRequest.Status) : '', url: payUrl || '' }
    };
  }
  /** A customer's own lines, from one pay token: product, paid till and amount owed. Nothing else about the customer. */
  function portalView(lines) {
    var owes = 0;
    var out = (lines || []).map(function (l) {
      owes += Number(l.owes) || 0;
      return { product: String(l.productName || ''), paid_till: String(l.paidTill || ''), owes: Number(l.owes) || 0 };
    });
    return { lines: out, owes: Math.round(owes * 100) / 100, currency: 'BDT' };
  }
  /** An API key for the panel: never the hash, never the raw key. */
  function keyView(row) {
    return { id: row.key_id, name: row.name, scopes: (row.scopes || []).slice(), origins: (row.origins || []).slice(), active: row.active === true,
      created: row.created_at || '', last_used: row.last_used_at || '' };
  }
  /** A webhook endpoint for the panel: never the signing secret. */
  function endpointView(row) {
    return { id: row.id, url: row.url, events: (row.events || []).slice(), active: row.active === true, created: row.created_at || '' };
  }
  function deliveryView(row) {
    return { id: row.id, endpoint_id: row.endpoint_id, event: row.event, status: row.status, attempts: Number(row.attempts) || 0,
      next_try: row.next_try_at || '', last_error: row.last_error || '', created: row.created_at || '', delivered: row.delivered_at || '' };
  }

  // ---- order input from a website ----
  var ORDER_FIELDS = ['product', 'months', 'price', 'customer', 'note'];
  var CUSTOMER_FIELDS = ['name', 'contact', 'channel'];
  function plainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  /** Text with runs of spaces collapsed; null when it is not text or is longer than max. */
  function textField(v, max) {
    if (typeof v !== 'string') return null;
    var t = v.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : null;
  }
  /**
   * Shape of a website order: { product (slug), months?, price (the amount the customer saw), customer { name, contact, channel? }, note? }.
   * Returns { ok, value } or { ok: false, errors, code }. The planner (Core.orders) still checks the product is on sale and the price.
   */
  function orderRequest(body) {
    var errors = [];
    if (!plainObject(body)) return { ok: false, code: 'validation_failed', errors: ['Send a JSON object.'] };
    Object.keys(body).forEach(function (k) { if (ORDER_FIELDS.indexOf(k) < 0) errors.push('Unknown field ' + k + '.'); });
    var product = textField(body.product, SLUG_MAX);
    if (!product) errors.push('product is required (the web address of the product).');
    var months = body.months === undefined ? 1 : body.months;
    if (typeof months === 'string' && /^\s*\d+\s*$/.test(months)) months = Number(months);
    if (typeof months !== 'number' || months !== Math.floor(months) || months < 1 || months > 12) errors.push('months must be a whole number from 1 to 12.');
    var price = body.price;
    if (typeof price === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(price)) price = Number(price);
    if (price === undefined || price === null) errors.push('price is required: send the price the customer saw.');
    else if (typeof price !== 'number' || !isFinite(price) || price < 0) errors.push('price must be a number, 0 or more.');
    var customer = plainObject(body.customer) ? body.customer : null;
    if (!customer) errors.push('customer is required (name and contact).');
    var name = null, contact = '', channel = '';
    if (customer) {
      Object.keys(customer).forEach(function (k) { if (CUSTOMER_FIELDS.indexOf(k) < 0) errors.push('Unknown field customer.' + k + '.'); });
      name = textField(customer.name, CUSTOMER_MAX);
      if (!name) errors.push('customer.name is required (up to ' + CUSTOMER_MAX + ' characters).');
      contact = customer.contact === undefined ? '' : textField(customer.contact, CUSTOMER_MAX);
      if (contact === null) { errors.push('customer.contact must be text up to ' + CUSTOMER_MAX + ' characters.'); contact = ''; }
      if (!contact) errors.push('customer.contact is required: a phone number or email.');
      channel = customer.channel === undefined ? '' : textField(customer.channel, CHANNEL_MAX);
      if (channel === null) { errors.push('customer.channel must be text up to ' + CHANNEL_MAX + ' characters.'); channel = ''; }
    }
    var note = body.note === undefined ? '' : textField(body.note, NOTE_MAX);
    if (note === null) { errors.push('note must be text up to ' + NOTE_MAX + ' characters.'); note = ''; }
    if (errors.length) return { ok: false, code: 'validation_failed', errors: errors };
    return { ok: true, value: { product: product, months: months, price: price, customer: { name: name, contact: contact, channel: channel }, note: note } };
  }

  /** Idempotency-Key header: 8 to 128 letters, digits, '-' or '_'. Returns the key or ''. */
  function idempotencyKey(header) {
    var s = String(header === undefined || header === null ? '' : header).trim();
    return IDEM_RE.test(s) ? s : '';
  }
  /** Canonical JSON (keys sorted, undefined dropped) so the same body always gives the same text. */
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (plainObject(v)) return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  /** Fingerprint of a request body: hex SHA-256 of its canonical JSON. */
  function fingerprint(v) { return hex(sha256(utf8(canonical(v)))); }

  // ---- webhooks ----
  function isEvent(type) { return EVENTS.indexOf(type) >= 0; }
  /** Endpoints that are on and asked for this event. */
  function subscribers(endpoints, type) {
    return (endpoints || []).filter(function (e) { return e.active === true && (e.events || []).indexOf(type) >= 0; });
  }
  /** JSON body of one event: id, type, created (Unix seconds) and data. Field order is fixed so the signature is reproducible. */
  function eventBody(id, type, nowMs, data) {
    return JSON.stringify({ id: String(id), type: String(type), created: Math.floor(Number(nowMs) / 1000), data: data || {} });
  }
  /** Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>. */
  function signatureHeader(secret, tSec, body) {
    var mac = hmacSha256(utf8(String(secret)), utf8(String(tSec) + '.' + String(body)));
    return 't=' + String(tSec) + ',v1=' + hex(mac);
  }
  function parseSignature(header) {
    var t = null, v1 = [];
    String(header || '').split(',').forEach(function (part) {
      var kv = part.trim().split('=');
      if (kv[0] === 't') t = kv[1];
      else if (kv[0] === 'v1') v1.push(kv[1] || '');
    });
    if (!/^\d+$/.test(String(t)) || !v1.length) return null;
    return { t: Number(t), v1: v1 };
  }
  /**
   * Receiver side: checks the header against the raw body. Stale timestamps are refused (replay), and every compare is constant time.
   * Returns { ok: true } or { ok: false, reason: 'bad_format' | 'stale' | 'mismatch' }.
   */
  function verifySignature(secret, header, body, nowSec, toleranceSec) {
    var p = parseSignature(header);
    if (!p) return { ok: false, reason: 'bad_format' };
    var tol = toleranceSec === undefined ? SIG_TOLERANCE_S : toleranceSec;
    if (Math.abs(Number(nowSec) - p.t) > tol) return { ok: false, reason: 'stale' };
    var expect = signatureHeader(secret, p.t, body).split('v1=')[1];
    var good = false;
    p.v1.forEach(function (v) { if (timingSafeEqual(v, expect)) good = true; });
    return good ? { ok: true } : { ok: false, reason: 'mismatch' };
  }
  /** After a failed send: the next try, or 'failed' once the attempts are used up. attempts counts the sends made so far. */
  function retryPlan(attempts, nowMs) {
    if (Number(attempts) >= MAX_ATTEMPTS) return { status: 'failed' };
    var delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, Number(attempts) - 1), BACKOFF_CAP_MS);
    return { status: 'pending', nextTryMs: Number(nowMs) + delay };
  }

  // ---- validators for owner settings ----
  /** https only (http is allowed for localhost, for trying things out), no user name or password in the address. Returns the address or null. */
  function webhookUrl(u) {
    var s = String(u === undefined || u === null ? '' : u).trim();
    if (!s || s.length > URL_MAX) return null;
    var parsed;
    try { parsed = new URL(s); } catch (e) { return null; }
    if (parsed.username || parsed.password) return null;
    var local = parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    if (parsed.protocol !== 'https:' && !local) return null;
    return parsed.href;
  }
  function keyName(v) { return textField(v, NAME_MAX); }

  return {
    SCOPES: SCOPES, EVENTS: EVENTS, LIMITS: LIMITS, MAX_ATTEMPTS: MAX_ATTEMPTS, SIG_TOLERANCE_S: SIG_TOLERANCE_S,
    sha256: sha256, hmacSha256: hmacSha256, hex: hex, utf8: utf8, timingSafeEqual: timingSafeEqual,
    makeApiKey: makeApiKey, makeKeyId: makeKeyId, makeOrderToken: makeOrderToken, makeToken: makeToken, keyHash: keyHash, isKeyFormat: isKeyFormat, bearerKey: bearerKey,
    checkScopes: checkScopes, hasScope: hasScope, normalizeOrigin: normalizeOrigin, checkOrigins: checkOrigins, originAllowed: originAllowed,
    windowStart: windowStart, retryAfterSeconds: retryAfterSeconds, overLimit: overLimit, ipBucket: ipBucket, ipLimit: ipLimit, keyBucket: keyBucket,
    isAvailable: isAvailable, productView: productView, catalogView: catalogView, orderView: orderView, portalView: portalView,
    keyView: keyView, endpointView: endpointView, deliveryView: deliveryView,
    orderRequest: orderRequest, idempotencyKey: idempotencyKey, fingerprint: fingerprint,
    isEvent: isEvent, subscribers: subscribers, eventBody: eventBody, signatureHeader: signatureHeader, parseSignature: parseSignature,
    verifySignature: verifySignature, retryPlan: retryPlan, webhookUrl: webhookUrl, keyName: keyName
  };
})();
if (typeof module !== 'undefined') module.exports = Core.publicapi;

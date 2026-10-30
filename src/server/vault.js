// Vault crypto for stored login details (Deno Web Crypto, no dependencies). Plain functions the router calls, bundled ahead of edge.js.
//   AES-256-GCM, key from the env VAULT_KEY (base64 of 32 bytes), a fresh random 12-byte IV per encryption, AAD = the row id.
//   PIN: PBKDF2-SHA256, random 16-byte salt, stored as pbkdf2$<iterations>$<saltB64>$<hashB64>.
// Without VAULT_KEY every vault call throws VAULT_NOT_CONFIGURED_ (fail closed): plaintext is never stored.
var VAULT_NOT_CONFIGURED_ = 'Vault not configured: set VAULT_KEY.';
var VAULT_PBKDF2_ITER_ = 210000;

function vaultB64_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function vaultUnb64_(str) {
  var s = atob(String(str)), out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** The raw key bytes, or null when VAULT_KEY is missing or is not 32 bytes of base64. */
function vaultKeyBytes_() {
  var raw = Deno.env.get('VAULT_KEY') || '';
  if (!raw) return null;
  try { var b = vaultUnb64_(raw.trim()); return b.length === 32 ? b : null; } catch (e) { return null; }
}
function vaultConfigured_() { return vaultKeyBytes_() !== null; }
async function vaultKey_() {
  var kb = vaultKeyBytes_();
  if (!kb) throw new Error(VAULT_NOT_CONFIGURED_);
  return crypto.subtle.importKey('raw', kb, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/** vaultEncrypt_(plaintext, aad) -> { ciphertext, iv } (base64). aad is the row id the ciphertext belongs to. */
async function vaultEncrypt_(plaintext, aad) {
  var key = await vaultKey_();
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: new TextEncoder().encode(String(aad)) }, key, new TextEncoder().encode(String(plaintext)));
  return { ciphertext: vaultB64_(new Uint8Array(ct)), iv: vaultB64_(iv) };
}
/** vaultDecrypt_(ciphertext, iv, aad) -> plaintext. Throws when the key, the AAD or the data is wrong. */
async function vaultDecrypt_(ciphertext, iv, aad) {
  var key = await vaultKey_();
  try {
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vaultUnb64_(iv), additionalData: new TextEncoder().encode(String(aad)) }, key, vaultUnb64_(ciphertext));
    return new TextDecoder().decode(pt);
  } catch (e) {
    throw new Error('Could not decrypt this entry. The vault key may have changed.');
  }
}

function pinValid_(pin) { return typeof pin === 'string' && /^\d{4,12}$/.test(pin); }   // checking an existing PIN (older PINs may be 4 or 5 digits)
function pinNewValid_(pin) { return typeof pin === 'string' && /^\d{6,12}$/.test(pin); }   // a new PIN must be 6 to 12 digits
async function pinDerive_(pin, salt, iter) {
  var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, base, 256));
}
/** pinHash_(pin) -> 'pbkdf2$iter$saltB64$hashB64' */
async function pinHash_(pin) {
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var h = await pinDerive_(pin, salt, VAULT_PBKDF2_ITER_);
  return 'pbkdf2$' + VAULT_PBKDF2_ITER_ + '$' + vaultB64_(salt) + '$' + vaultB64_(h);
}
/** pinVerify_(pin, stored) -> boolean. Constant-time compare of the derived bytes. A malformed stored value never verifies. */
async function pinVerify_(pin, stored) {
  var p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  var iter = Number(p[1]);
  if (!(iter >= 210000 && iter <= 10000000)) return false;
  try {
    var want = vaultUnb64_(p[3]), got = await pinDerive_(pin, vaultUnb64_(p[2]), iter);
    if (want.length !== got.length) return false;
    var diff = 0;
    for (var i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch (e) { return false; }
}

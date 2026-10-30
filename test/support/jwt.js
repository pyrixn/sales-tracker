// Test-only token signing: HS256 with a given secret, shaped like a Supabase login token (aud 'authenticated', app_role claim).
const crypto = require('crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** signJwt(payload, secret, header?) -> "h.p.s". Pass a header to forge one (alg none, RS256 and so on). */
function signJwt(payload, secret, header) {
  const h = b64url(JSON.stringify(header || { alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  return h + '.' + p + '.' + b64url(sig);
}
/** loginToken({ sub, app_role, ... }, secret) -> a token a valid Supabase login would carry, valid for an hour unless overridden. */
function loginToken(over, secret) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({ sub: '11111111-1111-4111-8111-111111111111', email: 'staff@example.test', aud: 'authenticated',
    role: 'authenticated', iat: now, exp: now + 3600, app_role: 'staff' }, over || {});
  return signJwt(claims, secret);
}
module.exports = { signJwt, loginToken, b64url };

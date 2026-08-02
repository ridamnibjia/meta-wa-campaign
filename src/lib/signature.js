'use strict';
const crypto = require('crypto');

// Meta signs every POST with HMAC-SHA256 of the raw body, keyed on the app
// secret. Without this check anyone who finds the public URL can forge opt-outs,
// delivery stats and inbound messages. No secret configured = reject, rather
// than trust blindly.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(mine);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifySignature };

'use strict';
const crypto = require('crypto');

// Length first (timingSafeEqual throws on unequal lengths, and comparing
// lengths in JS first is not itself a timing leak — the secret's length is not
// secret), then constant time. Shared by the HMAC compare below and the
// webhook verify-token compare (routes/webhook.js): both check a
// caller-supplied string against a value that must not be guessable one
// character at a time via response timing.
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Meta signs every POST with HMAC-SHA256 of the raw body, keyed on the app
// secret. Without this check anyone who finds the public URL can forge opt-outs,
// delivery stats and inbound messages. No secret configured = reject, rather
// than trust blindly.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(header, mine);
}

module.exports = { verifySignature, safeEqual };

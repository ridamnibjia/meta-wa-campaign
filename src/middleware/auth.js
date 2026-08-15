'use strict';
const crypto = require('crypto');
const { CFG } = require('../config');
const { log }  = require('../state');

// ── Why this exists ────────────────────────────────────────────────────────────
// This app is served on a public URL through a Cloudflare Tunnel and holds a
// Meta access token that can spend money and message customers. Anyone who
// guessed the hostname could previously start a campaign. So it fails closed:
// no password configured means the API is unavailable, never "open".

const SESSION_COOKIE = 'wa_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In memory on purpose. A restart logs the operator out, which is the correct
// trade: persisting session tokens to disk would put a credential-equivalent
// next to the data files, for the convenience of not typing a password after a
// deploy.
const sessions = new Map();   // token → expiry timestamp

// Brute-force ceiling. One operator with one password does not need 10 attempts
// per quarter hour, and an attacker needs far more than that to be useful.
const MAX_ATTEMPTS  = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();   // ip → { count, resetAt }

const isConfigured = () => !!CFG.appPassword;

// Compare digests, not raw strings: timingSafeEqual needs equal-length buffers,
// and hashing first guarantees that regardless of what was typed. Comparing with
// === would leak the password's length and prefix through timing.
function checkPassword(input) {
  if (!isConfigured()) return false;
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(CFG.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

// Both maps are swept on write rather than on a timer. This URL is public and
// gets scanned: without a sweep, `attempts` grew one permanent entry per source
// IP that ever probed /api/login, and `sessions` kept every expired token until
// somebody happened to present it again. Neither is large per entry, and neither
// had anything at all that removed them — which is the shape of a leak that only
// shows up as an OOM months into an uptime.
//
// Sweeping on write is enough because both maps only grow on write, and the work
// is proportional to what is already there rather than to the request.
//
// RATE-LIMITED to once per window, and that matters under exactly the traffic
// this exists for. Sweeping on every first-sighting of an IP is O(n) per new IP,
// so a scan from many distinct addresses — which is what a botnet probing a
// public hostname looks like — made the defence O(n²) in the number of probes
// and turned the rate limiter into the cheapest way to burn this server's CPU.
// Entries only expire on a clock, so sweeping more often than the window cannot
// find anything a once-per-window sweep would miss; it can only cost more.
const SWEEP_EVERY_MS = 60 * 1000;
const lastSweep = new Map();   // map → timestamp of its last sweep

function sweep(map, expiryOf, now) {
  if (now - (lastSweep.get(map) || 0) < SWEEP_EVERY_MS) return;
  lastSweep.set(map, now);
  for (const [k, v] of map) if (now > expiryOf(v)) map.delete(k);
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    sweep(attempts, r => r.resetAt, now);
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

const clearAttempts = ip => attempts.delete(ip);

function createSession() {
  const now = Date.now();
  sweep(sessions, expiry => expiry, now);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_TTL_MS);
  return token;
}

function validSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

const destroySession = token => sessions.delete(token);

// No cookie-parser dependency for something this small.
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieOptions(req) {
  // cloudflared terminates TLS and forwards over plain HTTP, so req.secure is
  // false in production; x-forwarded-proto is the honest signal. sameSite
  // 'strict' is the primary CSRF defence — a cross-site POST carries no cookie.
  const https = req.secure || req.get('x-forwarded-proto') === 'https';
  return { httpOnly: true, sameSite: 'strict', secure: https, maxAge: SESSION_TTL_MS, path: '/' };
}

// Belt and braces alongside sameSite: reject state-changing requests that
// announce an origin we do not serve. Same-origin browser requests either omit
// Origin or send our own.
function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  const host = req.get('host');
  try {
    const u = new URL(origin);
    if (u.host === host) return true;
  } catch { return false; }
  return CFG.frontendUrl ? origin === CFG.frontendUrl : false;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'APP_PASSWORD is not set on the server. Set it in .env and restart — the dashboard stays locked until then.',
      setupRequired: true,
    });
  }
  if (UNSAFE.has(req.method) && !originAllowed(req)) {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  if (!validSession(readCookie(req, SESSION_COOKIE))) {
    return res.status(401).json({ error: 'Not signed in', authRequired: true });
  }
  next();
}

// socket.io hands us the raw handshake, which carries the same cookie header.
// Without this check the password would be decorative: a stranger could open a
// socket and stream campaign state, logs and inbound customer messages.
function socketAuth(socket, next) {
  if (!isConfigured()) return next(new Error('APP_PASSWORD not configured'));
  const token = readCookie({ headers: socket.handshake.headers }, SESSION_COOKIE);
  if (!validSession(token)) return next(new Error('Not signed in'));
  next();
}

function mount(app) {
  app.post('/api/login', (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'APP_PASSWORD is not set on the server.', setupRequired: true });
    }
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      log('warn', `login blocked — too many attempts from ${ip}`);
      return res.status(429).json({ ok: false, error: 'Too many attempts. Wait 15 minutes and try again.' });
    }
    if (!checkPassword(req.body?.password)) {
      log('warn', `failed login from ${ip}`);
      return res.status(401).json({ ok: false, error: 'Wrong password' });
    }
    clearAttempts(ip);
    res.cookie(SESSION_COOKIE, createSession(), cookieOptions(req));
    log('info', `signed in from ${ip}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // The login screen calls this to decide what to render. It deliberately
  // reveals only whether a password exists and whether this caller is signed
  // in — never anything about the password itself.
  app.get('/api/session', (req, res) => res.json({
    authenticated: isConfigured() && validSession(readCookie(req, SESSION_COOKIE)),
    setupRequired: !isConfigured(),
  }));
}

module.exports = {
  mount, requireAuth, socketAuth, checkPassword, isConfigured,
  createSession, validSession, destroySession, readCookie, SESSION_COOKIE,
};

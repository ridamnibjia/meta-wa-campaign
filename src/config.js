'use strict';
// Every environment-derived value lives here. Nothing in this file imports from
// the rest of the app, which is what lets every other module depend on it.
require('dotenv').config();

const path = require('path');

const ROOT = path.join(__dirname, '..');

// Where every file this app WRITES lives. Unset means the app directory, which
// is where every deployment so far keeps them; a container points it at its
// volume so wa.db, the state files and both media stores survive an image
// update instead of being rebuilt away with the layer they were written into.
const DATA_DIR = process.env.WA_DATA_DIR || ROOT;

// Mutable at runtime: /api/config lets an operator override credentials for the
// current session without editing .env and restarting. Overrides do not persist.
const CFG = {
  phoneNumberId:      process.env.PHONE_NUMBER_ID      || '',
  accessToken:        process.env.ACCESS_TOKEN         || '',
  wabaId:             process.env.WABA_ID              || '',
  businessId:         process.env.BUSINESS_ID          || '',
  // No fallback on purpose. A default verify token would be a shared secret
  // published in the repo, and an empty one is refused outright (see
  // routes/webhook.js) rather than matching an empty query parameter.
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || '',
  appSecret:          process.env.APP_SECRET           || '',
  // The Resumable Upload API keys on the APP id — not the WABA id and not the
  // business id, neither of which substitutes. It is the only way to get the
  // h:… handle that template creation requires, so without it media headers
  // are unavailable and the composer says so rather than failing at submit.
  appId:              process.env.APP_ID               || '',
  appPassword:        process.env.APP_PASSWORD         || '',
  apiVersion:         process.env.API_VERSION          || 'v23.0',
  templateName:       process.env.TEMPLATE_NAME        || '',
  templateLanguage:   process.env.TEMPLATE_LANGUAGE    || 'en',
  templateCategory:   process.env.TEMPLATE_CATEGORY    || 'MARKETING',
  frontendUrl:        process.env.FRONTEND_URL         || '',
  port:               parseInt(process.env.PORT)       || 3000,
  // Loopback unless told otherwise. cloudflared or a reverse proxy on the same
  // host is meant to be the only public entrance, and that is also what keeps
  // `trust proxy 1` honest: a caller who can reach the port directly can put
  // anything in X-Forwarded-For, which is what the login limiter keys on.
  // Render routes traffic to 0.0.0.0, so it is detected rather than documented
  // as a trap; the Docker image sets BIND_HOST itself, because loopback inside
  // a container is unreachable through a published port.
  bindHost:           process.env.BIND_HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
};

// Every call to Meta carries one of these. Without a signal, fetch waits on
// undici's own ~5-minute timers, so one wedged connection held the single send
// loop — and Stop — for minutes per contact. JSON calls are small and get 30s;
// byte transfers (a 100 MB header upload, an inbound download) get 5 minutes.
const TIMEOUTS = { graphMs: 30_000, transferMs: 300_000 };

// `Number(x) || fallback` cannot express zero, and zero is a legitimate setting
// twice over: PRICE_UTILITY=0 (utility inside the service window is genuinely
// free in some markets) and WA_MEDIA_MIN_FREE_BYTES=0 (a dedicated media disk
// may want no floor). An unset or unparseable variable still falls back.
// Declared above PRICES because PRICES is its first consumer.
const num = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// ── Pricing ────────────────────────────────────────────────────────────────────
// Meta switched to per-message pricing on 1 July 2025: each *delivered* template
// message is billed at a per-category, per-country rate. These defaults are the
// India rates. Meta revises them without notice and this app does not fetch the
// rate card, so they are env-configurable and every figure the UI shows is
// labelled approximate.
const PRICES = {
  currency:    process.env.CURRENCY        || '₹',
  MARKETING:      num(process.env.PRICE_MARKETING, 0.78),
  UTILITY:        num(process.env.PRICE_UTILITY,   0.115),
  AUTHENTICATION: num(process.env.PRICE_AUTH,      0.125),
};

// ── Official Meta character limits ─────────────────────────────────────────────
const LIMITS = {
  templateName: 512, templateBody: 1024, templateHeader: 60,
  templateFooter: 60, templateButton: 25, textMessage: 4096, paramValue: 1024,
};

const OPT_OUT_LABEL = 'Stop promotions';

// The campaign loop refuses to send between 23:00 and 07:00 IST — night
// notifications are what recipients block and report, and that feeds the quality
// rating which gates the messaging tier.
//
// The knob exists for the test suite, which drives the real loop and would
// otherwise park until morning for anyone who runs `npm test` after 23:00. It is
// deliberately opt-OUT and not surfaced in the UI: an operator who wants to
// message people at 3am should have to write it down in a file.
const QUIET_HOURS = process.env.WA_QUIET_HOURS !== '0';

const FILES = {
  optOuts:  path.join(DATA_DIR, 'opt-outs.json'),
  warmup:   path.join(DATA_DIR, 'warmup.json'),
  msgIndex: path.join(DATA_DIR, 'msg-index.json'),
  inbox:    path.join(DATA_DIR, 'inbox.json'),
  campaign: path.join(DATA_DIR, 'campaign.json'),
  db:       path.join(DATA_DIR, 'wa.db'),
};

const PUBLIC_DIR = path.join(ROOT, 'public');

// Inbound media bytes land here when an operator saves them. Nothing writes to
// it until an operator clicks Save, so it is not created until then.
// WA_MEDIA_DIR is the test escape hatch, exactly like WA_UPLOAD_DIR.
const MEDIA_DIR = process.env.WA_MEDIA_DIR || path.join(DATA_DIR, 'media');

// ── ClamAV ─────────────────────────────────────────────────────────────────────
// Empty means "no scanner", which is a supported deployment: most self-hosters
// will not run clamd — it holds the whole signature database in RAM, about a
// gigabyte — and the app has to work without it. Set it to a unix socket path
// (/var/run/clamav/clamd.ctl) or host:port (127.0.0.1:3310) to turn scanning on.
//
// The distinction that matters: NOT CONFIGURED lets a save through, marked
// "not scanned". CONFIGURED BUT BROKEN refuses the save. An operator who asked
// for a scanner should never silently stop getting one.
const CLAMAV = {
  address:   process.env.CLAMAV_ADDRESS || '',
  timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS) || 30_000,
};

// Inbound media limits. The byte cap is Meta's own document maximum — a bigger
// response than that is a broken CDN, not a file. The free-space floor is what
// stops a save filling the boot disk out from under SQLite, which handles a
// full filesystem by refusing writes: an unbounded media save would take the
// message store down with it, which is far worse than a refused Save.
const MEDIA_LIMITS = {
  maxBytes:      num(process.env.WA_MEDIA_MAX_BYTES,      100 * 1024 * 1024),
  minFreeBytes:  num(process.env.WA_MEDIA_MIN_FREE_BYTES, 2 * 1024 * 1024 * 1024),
  retentionDays: num(process.env.WA_MEDIA_RETENTION_DAYS, 90),
  // How long a previewed-but-not-kept file stays on disk. Long enough that an
  // operator can look at something, get pulled away, and still find it after
  // lunch; short enough that browsing a thread does not quietly build a
  // permanent archive of every file anyone ever sent.
  previewHours:  num(process.env.WA_MEDIA_PREVIEW_HOURS, 24),
};

// Files uploaded for use as a template header. Separate from MEDIA_DIR, which
// holds INBOUND customer media — different provenance, different retention.
// WA_UPLOAD_DIR exists so test.js can point at a temp directory before
// requiring the app, exactly like WA_DB_PATH. It is not a deployment knob —
// WA_DATA_DIR is, and moves this along with everything else the app writes.
const UPLOAD_DIR = process.env.WA_UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

module.exports = { CFG, PRICES, LIMITS, OPT_OUT_LABEL, QUIET_HOURS, FILES, PUBLIC_DIR, MEDIA_DIR, UPLOAD_DIR, ROOT,
                   DATA_DIR, TIMEOUTS, CLAMAV, MEDIA_LIMITS };

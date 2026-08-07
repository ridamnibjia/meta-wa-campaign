'use strict';
// Every environment-derived value lives here. Nothing in this file imports from
// the rest of the app, which is what lets every other module depend on it.
require('dotenv').config();

const path = require('path');

const ROOT = path.join(__dirname, '..');

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
};

// ── Pricing ────────────────────────────────────────────────────────────────────
// Meta switched to per-message pricing on 1 July 2025: each *delivered* template
// message is billed at a per-category, per-country rate. These defaults are the
// India rates. Meta revises them without notice and this app does not fetch the
// rate card, so they are env-configurable and every figure the UI shows is
// labelled approximate.
const PRICES = {
  currency:    process.env.CURRENCY        || '₹',
  MARKETING:      Number(process.env.PRICE_MARKETING) || 0.78,
  UTILITY:        Number(process.env.PRICE_UTILITY)   || 0.115,
  AUTHENTICATION: Number(process.env.PRICE_AUTH)      || 0.125,
};

// ── Official Meta character limits ─────────────────────────────────────────────
const LIMITS = {
  templateName: 512, templateBody: 1024, templateHeader: 60,
  templateFooter: 60, templateButton: 25, textMessage: 4096, paramValue: 1024,
};

const OPT_OUT_LABEL = 'Stop promotions';

const FILES = {
  optOuts:  path.join(ROOT, 'opt-outs.json'),
  warmup:   path.join(ROOT, 'warmup.json'),
  msgIndex: path.join(ROOT, 'msg-index.json'),
  inbox:    path.join(ROOT, 'inbox.json'),
  campaign: path.join(ROOT, 'campaign.json'),
  db:       path.join(ROOT, 'wa.db'),
};

const PUBLIC_DIR = path.join(ROOT, 'public');

// Inbound media bytes land here when an operator saves them. Nothing writes to
// it until an operator clicks Save, so it is not created until then.
// WA_MEDIA_DIR is the test escape hatch, exactly like WA_UPLOAD_DIR.
const MEDIA_DIR = process.env.WA_MEDIA_DIR || path.join(ROOT, 'media');

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
  maxBytes:      Number(process.env.WA_MEDIA_MAX_BYTES)      || 100 * 1024 * 1024,
  minFreeBytes:  Number(process.env.WA_MEDIA_MIN_FREE_BYTES) || 2 * 1024 * 1024 * 1024,
  retentionDays: Number(process.env.WA_MEDIA_RETENTION_DAYS) || 90,
};

// Files uploaded for use as a template header. Separate from MEDIA_DIR, which
// holds INBOUND customer media — different provenance, different retention.
// WA_UPLOAD_DIR exists so test.js can point at a temp directory before
// requiring the app, exactly like WA_DB_PATH. It is not a deployment knob.
const UPLOAD_DIR = process.env.WA_UPLOAD_DIR || path.join(ROOT, 'uploads');

module.exports = { CFG, PRICES, LIMITS, OPT_OUT_LABEL, FILES, PUBLIC_DIR, MEDIA_DIR, UPLOAD_DIR, ROOT,
                   CLAMAV, MEDIA_LIMITS };

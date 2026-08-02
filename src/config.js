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
};

const PUBLIC_DIR = path.join(ROOT, 'public');

module.exports = { CFG, PRICES, LIMITS, OPT_OUT_LABEL, FILES, PUBLIC_DIR, ROOT };

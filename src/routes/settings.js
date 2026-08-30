'use strict';
const express = require('express');
const { CFG, LIMITS, PRICES } = require('../config');
const { S, log } = require('../state');
const { buildState, broadcast } = require('../services/status');
const { fetchAccountInfo } = require('../services/graph');
const { CONTACT_FIELDS } = require('../services/campaign');
const { W, saveWarmup, warmupCap, warmupStep, graduated } = require('../services/warmup');
const { missingParams } = require('../services/campaign');
const diagnostics = require('../services/diagnostics');
const { replayUnprocessed } = require('../services/ingest');

const router = express.Router();

router.post('/config', (req, res) => {
  const { phoneNumberId, accessToken, wabaId, templateName, templateLanguage,
          templateCategory, delaySec, dailyCap, prices } = req.body;
  if (phoneNumberId)    CFG.phoneNumberId    = phoneNumberId;
  if (accessToken)      CFG.accessToken      = accessToken;
  if (wabaId)           CFG.wabaId           = wabaId;
  if (templateName)     { CFG.templateName     = templateName;     S.config.templateName     = templateName; }
  if (templateLanguage) { CFG.templateLanguage = templateLanguage; S.config.templateLanguage = templateLanguage; }
  if (templateCategory) { CFG.templateCategory = templateCategory; S.config.templateCategory = templateCategory; }
  // parseInt is not a validator. Both of these used to coerce anything
  // unparseable into a working setting, and both failed towards MORE sending:
  //   · delaySec "abc" → Math.max(1, NaN) → NaN → sleep(NaN) fires immediately,
  //     so a typo removed the delay between sends entirely;
  //   · dailyCap "abc" → NaN || 0 → 0, and 0 is the operator's own "no cap",
  //     so a typo silently uncapped the account.
  // A number that does not parse is a mistake, and the honest answer to a
  // mistake is to refuse it rather than to guess a value that spends money.
  const asInt = v => {
    const n = Number(String(v).trim());
    return Number.isInteger(n) ? n : null;
  };

  if (delaySec !== undefined && delaySec !== null && String(delaySec).trim() !== '') {
    const n = asInt(delaySec);
    if (n === null || n < 1) {
      return res.json({ ok: false, error: 'Delay between sends must be a whole number of seconds, 1 or more.' });
    }
    S.config.delaySec = n;
  }
  // 0 is a legitimate value and means "no cap of mine" — the warm-up ladder and
  // Meta's own messaging tier are then the only ceilings. `if (dailyCap)` could
  // not express it, so an operator who typed 0 silently kept their old cap.
  if (dailyCap !== undefined && dailyCap !== null && String(dailyCap).trim() !== '') {
    const n = asInt(dailyCap);
    if (n === null || n < 0) {
      return res.json({ ok: false, error: 'Daily cap must be a whole number. Use 0 for no cap of your own.' });
    }
    S.config.dailyCap = n;
  }

  // Boolean, checked by type: a checkbox posts true or false and nothing else
  // may flip where marketing sends are routed.
  if (typeof req.body.mmLite === 'boolean') S.config.mmLite = req.body.mmLite;

  // Checked with `in` rather than truthiness so null can clear it. The
  // template's own approval example is restored on the next adoptTemplate, so
  // clearing is never destructive.
  if ('headerAssetId' in req.body) {
    S.config.headerAssetId = req.body.headerAssetId ? Number(req.body.headerAssetId) : null;
  }

  // Session-only rate overrides. The .env values are the defaults every restart
  // returns to — nothing here writes to disk, matching how credentials behave.
  if (prices && typeof prices === 'object') {
    for (const k of ['MARKETING', 'UTILITY', 'AUTHENTICATION']) {
      // Blank is skipped, the same way dailyCap above treats it: an untouched
      // empty form field serialises as '', and Number('') is 0 — a valid price
      // this loop would otherwise adopt, silently zeroing every spend figure.
      const raw = prices[k];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) PRICES[k] = v;
    }
    if (typeof prices.currency === 'string' && prices.currency.trim()) {
      PRICES.currency = prices.currency.trim().slice(0, 4);
    }
    log('info', `Pricing updated — marketing ${PRICES.currency}${PRICES.MARKETING} per delivered message`);
  }

  broadcast();
  res.json({ ok: true, configured: !!(CFG.phoneNumberId && CFG.accessToken) });
});

// Set what goes into each {{n}} for this campaign. Values are validated here and
// sanitized again at send time, since this endpoint is the trust boundary for
// text that ends up in a message to a real customer.
router.post('/params', (req, res) => {
  const incoming = req.body?.paramValues;
  if (!Array.isArray(incoming)) return res.json({ ok: false, error: 'paramValues must be an array' });

  S.config.paramValues = Array.from({ length: S.config.paramCount || 0 }, (_, i) => {
    const p = incoming[i] || {};
    const source = CONTACT_FIELDS.includes(p.source) ? p.source : 'fixed';
    return { source, value: source === 'fixed' ? String(p.value ?? '').slice(0, LIMITS.paramValue) : '' };
  });

  broadcast();
  res.json({ ok: true, paramValues: S.config.paramValues, missing: missingParams() });
});

router.get('/account-info', async (req, res) => {
  try {
    const info = await fetchAccountInfo();
    if (info.qualityRating) S.quality = info.qualityRating;
    res.json(info);
  } catch (e) { res.json({ error: e.message }); }
});

router.post('/warmup', (req, res) => {
  if (typeof req.body.enabled === 'boolean') { W.enabled = req.body.enabled; saveWarmup(); }
  broadcast();
  res.json({ ok: true, enabled: W.enabled, cap: warmupCap(), step: warmupStep(),
             daysSent: W.days.length, graduated: graduated() });
});

// ── Diagnostics ────────────────────────────────────────────────────────────────
router.get('/diagnostics', (req, res) => {
  try { res.json(diagnostics.snapshot()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// The only state-changing thing on that page. Replay is idempotent by
// construction — messages dedupes on its primary key, applyStatus only moves a
// status forward, and disable() is a no-op when the contact is already off for
// that reason — so pressing it twice costs nothing but a little work.
router.post('/diagnostics/replay', (req, res) => {
  const r = replayUnprocessed({ limit: req.body?.limit });
  broadcast();
  res.json({ ok: true, ...r });
});

router.get('/state',   (req, res) => res.json(buildState()));
router.get('/logs',    (req, res) => res.json(S.logs));
router.get('/faillog', (req, res) => res.json(S.failLog));

module.exports = router;

'use strict';
const express = require('express');
const { CFG } = require('../config');
const { S, flags, log, todayKey } = require('../state');
const { broadcast } = require('../services/status');
const { isDisabled, markMessaged, getRow } = require('../services/contacts');
const { W, effectiveCap } = require('../services/warmup');
const { recordOutbound, progressForRun, skippedForRun } = require('../services/messages');
const { normalizePhone } = require('../lib/phone');
const { validateTemplate, adoptTemplate, renderBody } = require('../services/templates');
const { fetchAccountInfo } = require('../services/graph');
const { skipDisposition, explainError, SKIP_DISPOSITIONS } = require('../lib/errors');
const {
  sendTemplate, missingParams, startLoop, saveCampaignNow, clearCampaignFile,
} = require('../services/campaign');

const router = express.Router();

// Fire the active template at a few numbers right now, outside the campaign loop
// and outside the warm-up ceiling. This is how you confirm delivered/read
// webhooks actually arrive before committing a whole list to it.
router.post('/test-send', async (req, res) => {
  const raw = [].concat(req.body.numbers || []).slice(0, 5);
  if (!raw.length) return res.json({ ok: false, error: 'Give at least one number' });
  if (!CFG.accessToken || !CFG.phoneNumberId) return res.json({ ok: false, error: 'Credentials not configured' });

  const check = await validateTemplate(S.config.templateName).catch(e => ({ error: e.message }));
  adoptTemplate(S.config.templateName, check);
  if (check.error) return res.json({ ok: false, error: `Could not verify template: ${check.error}` });
  if (S.config.templateStatus !== 'APPROVED') {
    return res.json({ ok: false, error: `Template "${S.config.templateName}" is ${S.config.templateStatus || 'not found'} — only APPROVED templates can be sent` });
  }

  const results = [];
  for (const n of raw) {
    const dialStr = normalizePhone(n);
    if (!dialStr) { results.push({ input: n, ok: false, error: 'Not a valid phone number' }); continue; }
    // A disabled contact is disabled even when you are only testing.
    if (isDisabled(dialStr)) {
      const why = getRow(dialStr)?.disabled_reason || 'disabled';
      results.push({ input: n, dialStr, ok: false,
        error: why === 'opt_out' ? 'This number has opted out' : `This contact is disabled (${why})` });
      continue;
    }
    const contact = { name: req.body.name || 'there', phone: n, dialStr };
    log('info', `test send → +${dialStr}`);
    const r = await sendTemplate(contact);
    if (r.ok) {
      // Counted like any other send so the stat tiles walk accepted → delivered
      // → read in front of you; /api/start opens a new run before the campaign.
      S.dailyCount++;
      markMessaged(dialStr);
      recordOutbound({ wamid: r.messageId, waId: dialStr, name: contact.name,
                       body: renderBody(S.config.templateBody, r.params)
                             ?? `[template: ${S.config.templateName}]`,
                       runId: S.currentRunId });
      log('success', `test send accepted — +${dialStr}`);
    } else {
      log('error', `test send failed — +${dialStr} [${r.errorCode}] ${r.error}`);
      if (r.hint) log('error', `   ↳ ${r.hint}`);
    }
    results.push({ input: n, dialStr, ok: !!r.ok, error: r.error || null, hint: r.hint || null });
  }
  broadcast();
  res.json({ ok: results.some(r => r.ok), results });
});

router.post('/start', async (req, res) => {
  if (!CFG.phoneNumberId) return res.json({ ok: false, error: 'Phone Number ID not configured' });
  if (!CFG.accessToken)   return res.json({ ok: false, error: 'Access Token not configured' });
  const staged = progressForRun(S.currentRunId);
  if (!staged.total) return res.json({ ok: false, error: 'Upload a CSV first' });
  if (!staged.pending) return res.json({ ok: false, error: 'Every contact in this run has already been attempted. Upload a CSV to start a new one.' });

  // Re-check with Meta rather than trusting the client. A stale browser tab
  // could otherwise launch a campaign against a template that was since rejected.
  try {
    const r = await validateTemplate(S.config.templateName);
    adoptTemplate(S.config.templateName, r);
    if (r.error) return res.json({ ok: false, error: `Could not verify template: ${r.error}` });
    if (S.config.templateStatus !== 'APPROVED') {
      return res.json({ ok: false, error: `Template "${S.config.templateName}" is ${S.config.templateStatus || 'not found'} — only APPROVED templates can be sent` });
    }
  } catch (e) {
    return res.json({ ok: false, error: `Could not verify template: ${e.message}` });
  }

  // adoptTemplate just resized the slots from Meta's current copy of the body,
  // so an empty one here means the template really does have a variable nobody
  // filled in — not a stale count from a previously selected template.
  const missing = missingParams();
  if (missing.length) {
    return res.json({ ok: false, error: `Fill in a value for ${missing.map(n => `{{${n}}}`).join(', ')} before sending` });
  }

  // Quality gates the warm-up climb, so read it fresh rather than trusting a
  // value cached from whenever the dashboard last loaded.
  const info = await fetchAccountInfo().catch(() => ({}));
  if (info.qualityRating) S.quality = info.qualityRating;

  // The queue was staged at upload and is NOT rebuilt here. Rebuilding would
  // reset every wamid, and /start after a pause would re-send to everyone who
  // had already received the message.
  S.failed = 0; S.failLog = []; S.logs = [];
  flags.stopFlag = false; flags.pauseFlag = false; flags.running = false;
  S.phase = 'running'; S.pauseReason = null; saveCampaignNow(); broadcast();
  if (W.enabled) log('info', `Warm-up on — day ${W.days.includes(todayKey()) ? W.days.length : W.days.length + 1}, ceiling ${effectiveCap()} today`);
  startLoop();
  res.json({ ok: true });
});

router.post('/pause',  (req, res) => { flags.pauseFlag = true;  S.phase = 'paused'; S.pauseReason = 'Paused by user'; saveCampaignNow(); broadcast(); log('info', 'Paused'); res.json({ ok: true }); });
router.post('/resume', (req, res) => { flags.pauseFlag = false; S.phase = 'running'; S.pauseReason = null; saveCampaignNow(); broadcast(); log('info', 'Resumed'); if (!flags.running) startLoop(); res.json({ ok: true }); });
router.post('/stop',   (req, res) => { flags.stopFlag = true; flags.running = false; flags.pauseFlag = false; S.phase = 'idle'; S.pauseReason = null; saveCampaignNow(); broadcast(); log('info', 'Stopped'); res.json({ ok: true }); });

router.post('/reset',  (req, res) => {
  flags.stopFlag = true; flags.running = false; flags.pauseFlag = false;
  // A reset abandons the current run rather than deleting it: campaign_runs and
  // run_recipients are history, and the counters were never the history.
  Object.assign(S, { failed: 0, dailyCount: 0, phase: 'idle', logs: [], failLog: [],
                     pauseReason: null, currentRunId: null });
  clearCampaignFile();
  broadcast(); log('info', 'Reset'); res.json({ ok: true });
});

// ── The skip report ────────────────────────────────────────────────────────────
// After a run: who did not get the message, and what — if anything — you can do
// about it. Two questions, and they have different answers, which is why this is
// grouped by disposition rather than by error code.
//
// The grouping is lib/errors.js:skipDisposition. Until that function has a body
// every failed send lands in `unclassified`, which the report says plainly
// rather than guessing on the operator's behalf — a wrong "retry these" is a
// list of people you message again for no reason, and a wrong "give up on
// these" is customers you quietly stop talking to.
router.get('/campaign/skips', (req, res) => {
  const runId = req.query.run ? Number(req.query.run) : S.currentRunId;
  const rows  = skippedForRun(runId);

  const groups = {};
  for (const r of rows) {
    // A contact who was switched off before the run started is not a failure
    // and does not belong in either "try again" or "give up" — nobody attempted
    // anything.
    const key = r.skipped_reason === 'disabled' ? 'disabled' : skipDisposition(r.error_code);
    (groups[key] ||= []).push({
      phone: r.phone, name: r.name,
      reason: r.skipped_reason, code: r.error_code,
      explanation: explainError(r.error_code),
      at: r.attempted_at,
    });
  }

  res.json({
    runId,
    progress: progressForRun(runId),
    total: rows.length,
    // Named so the UI does not have to know the vocabulary, and so an empty
    // group is still a group the operator can see is empty.
    groups: {
      retry:        groups.retry        || [],
      fix:          groups.fix          || [],
      permanent:    groups.permanent    || [],
      disabled:     groups.disabled     || [],
      unclassified: groups.unclassified || [],
    },
    classifierReady: SKIP_DISPOSITIONS.some(d => d !== 'unclassified' && (groups[d] || []).length > 0)
      || rows.length === 0,
  });
});

module.exports = router;

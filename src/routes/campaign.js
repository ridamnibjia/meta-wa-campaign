'use strict';
const express = require('express');
const { CFG } = require('../config');
const { S, flags, log, todayKey } = require('../state');
const { broadcast } = require('../services/status');
const { isDisabled, markMessaged, getRow } = require('../services/contacts');
const { W, effectiveCap, graduated } = require('../services/warmup');
const { recordOutbound, progressForRun, skippedForRun,
        listRuns, runDetail } = require('../services/messages');
const { normalizePhone } = require('../lib/phone');
const { validateTemplate, adoptTemplate, renderBody } = require('../services/templates');
const { fetchAccountInfo } = require('../services/graph');
const { skipDisposition, explainError } = require('../lib/errors');
const {
  sendTemplate, missingParams, startLoop, saveCampaignNow, clearCampaignFile,
  campaignBlocker, campaignActive, suppressIfPermanent, USER_PAUSE,
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
      // Recorded like any other send so the stat tiles walk accepted → delivered
      // → read in front of you. It counts against the daily cap for free: that
      // figure is a query over these rows, not a counter this route increments.
      markMessaged(dialStr);
      recordOutbound({ wamid: r.messageId, waId: dialStr, name: contact.name,
                       body: renderBody(S.config.templateBody, r.params)
                             ?? `[template: ${S.config.templateName}]`,
                       runId: S.currentRunId });
      log('success', `test send accepted — +${dialStr}`);
    } else {
      log('error', `test send failed — +${dialStr} [${r.errorCode}] ${r.error}`);
      if (r.hint) log('error', `   ↳ ${r.hint}`);
      // A test send is the cheapest place to learn a number is not on WhatsApp,
      // and the campaign loop already acts on it. Not doing the same here meant
      // the operator had to be told twice before the contact was switched off.
      suppressIfPermanent(dialStr, r.errorCode, contact.name);
    }
    results.push({ input: n, dialStr, ok: !!r.ok, error: r.error || null, hint: r.hint || null });
  }
  broadcast();
  res.json({ ok: results.some(r => r.ok), results });
});

router.post('/start', async (req, res) => {
  // One campaign at a time, checked before anything else. On the server rather
  // than only in the UI: a second tab, a stale page or a curl is otherwise
  // enough to start a second walk over the same queue, and two loops sharing
  // one run means duplicate sends to whoever they both reach.
  //
  // First, ahead of the credential checks, because it is the more useful answer
  // when both are true — "your campaign is still going" is what the operator
  // needs to hear, not a config note about a server that is evidently sending.
  const blocked = campaignBlocker();
  if (blocked) return res.json({ ok: false, error: blocked });
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
  // No failure counter to clear — the queue rows are the count now, and a Start
  // must not appear to erase failures that really happened.
  S.failLog = []; S.logs = [];
  // `running` is NOT cleared here. It means "a loop is executing" and only the
  // loop may set it — clearing it from a route was what let startLoop() spawn a
  // second walk over one queue while the first was still inside an await.
  flags.stopFlag = false; flags.pauseFlag = false;
  S.phase = 'running'; S.pauseReason = null; saveCampaignNow(); broadcast();
  const cap = effectiveCap();
  if (W.enabled && !graduated()) {
    log('info', `Warm-up on — day ${W.days.includes(todayKey()) ? W.days.length : W.days.length + 1}, ceiling ${cap} today`);
  } else {
    log('info', cap === null
      ? `No daily cap — this number has ${W.enabled ? 'finished its warm-up' : 'warm-up switched off'} and no cap of your own is set, so Meta's messaging tier is the only limit`
      : `Warm-up complete — today's ceiling is your own cap of ${cap}`);
  }
  startLoop();
  res.json({ ok: true });
});

// USER_PAUSE, not a literal: this exact string is what resumeIfInterrupted reads
// on the next boot to tell an operator's pause from one the loop gave itself.
router.post('/pause',  (req, res) => { flags.pauseFlag = true;  S.phase = 'paused'; S.pauseReason = USER_PAUSE; saveCampaignNow(); broadcast(); log('info', 'Paused'); res.json({ ok: true }); });
router.post('/resume', (req, res) => { flags.pauseFlag = false; S.phase = 'running'; S.pauseReason = null; saveCampaignNow(); broadcast(); log('info', 'Resumed'); if (!flags.running) startLoop(); res.json({ ok: true }); });
// stopFlag is a request, not a fact: the loop reads it within a second and then
// clears `running` itself. Setting `running = false` from here was a lie the loop
// had not yet caught up with, and campaignBlocker() believed it — long enough for
// a Start or a CSV upload to slip in beside a loop that was still sending.
router.post('/stop',   (req, res) => { flags.stopFlag = true; flags.pauseFlag = false; S.phase = 'idle'; S.pauseReason = null; saveCampaignNow(); broadcast(); log('info', 'Stopped'); res.json({ ok: true }); });

router.post('/reset',  (req, res) => {
  flags.stopFlag = true; flags.pauseFlag = false;
  // A reset abandons the current run rather than deleting it: campaign_runs and
  // run_recipients are history, and the counters were never the history.
  // Today's send count is deliberately NOT reset: it is a query over the message
  // rows, and a Reset is an operator tidying their screen, not a claim that the
  // messages already sent today never went out. Zeroing it used to hand back a
  // day's worth of allowance the number had genuinely spent.
  Object.assign(S, { phase: 'idle', logs: [], failLog: [],
                     pauseReason: null, currentRunId: null });
  clearCampaignFile();
  broadcast(); log('info', 'Reset'); res.json({ ok: true });
});

// ── The skip report ────────────────────────────────────────────────────────────
// After a run: who did not get the message, and what — if anything — you can do
// about it. Two questions, and they have different answers, which is why this is
// grouped by disposition rather than by error code.
//
// The grouping is lib/errors.js:skipDisposition. A code that function does not
// name lands in `unclassified`, which the report says plainly rather than
// guessing on the operator's behalf — a wrong "retry these" is a list of people
// you message again for no reason, and a wrong "give up on these" is customers
// you quietly stop talking to.
const timeIST = ms => new Date(ms).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

// One plain sentence per contact: how many times we tried, what came back, and
// what it means. Composed here rather than in the browser so the log, the API
// and the screen cannot end up telling three versions of the same story.
// `active` matters: a row on the retry ladder is only going to be tried again if
// a campaign is still walking the queue. After a Stop the same row is a person
// left un-messaged, and telling the operator "next attempt 01:21" about a
// campaign that ended an hour ago is the report lying to them.
function detailFor(r, active) {
  if (r.skipped_reason === 'disabled') {
    return 'Switched off before this run was built — nothing was attempted, and nothing was billed.';
  }
  const meaning = explainError(r.error_code)
    || `Meta returned code ${r.error_code ?? 'none'}, which this app has no description for. Look it up in Meta's error reference before deciding what to do.`;
  const tried = r.skipped_reason !== 'retry' ? `Tried ${(r.attempts || 0) + 1}×`
    : active ? `Tried ${r.attempts || 1}× so far, next attempt ${r.retry_after ? timeIST(r.retry_after) : 'shortly'}`
    : `Tried ${r.attempts || 1}×, then the campaign was stopped before the next attempt`;
  // A full stop, not a third dash: `meaning` already carries a "what — what to
  // do" dash of its own, and three in one line stops being a sentence.
  return `${tried}. ${meaning}`;
}

router.get('/campaign/skips', (req, res) => {
  const runId = req.query.run ? Number(req.query.run) : S.currentRunId;
  const rows  = skippedForRun(runId);
  // Only meaningful for the CURRENT run: an old run's rows are never picked up
  // again whatever the loop is doing now.
  const active = campaignActive() && runId === S.currentRunId;

  const groups = {};
  for (const r of rows) {
    // Three cases that are not a disposition at all:
    // `disabled` — nobody attempted anything, so it belongs in neither "try
    // again" nor "give up"; and `retry` — the contact is still queued, on the
    // backoff ladder, and reporting them as not-messaged would be premature.
    const key = r.skipped_reason === 'disabled' ? 'disabled'
              : r.skipped_reason === 'retry'    ? 'waiting'
              : skipDisposition(r.error_code);
    (groups[key] ||= []).push({
      phone: r.phone, name: r.name,
      reason: r.skipped_reason, code: r.error_code,
      explanation: explainError(r.error_code),
      detail: detailFor(r, active),
      // A disabled row was never sent to, so its attempt count is zero — not the
      // "one attempt" every other row has had by the time it lands here.
      attempts: r.skipped_reason === 'disabled' ? 0
              : r.skipped_reason === 'retry'    ? (r.attempts || 0)
              : (r.attempts || 0) + 1,
      retryAt: r.skipped_reason === 'retry' ? r.retry_after : null,
      at: r.attempted_at,
    });
  }

  res.json({
    runId,
    active,
    progress: progressForRun(runId),
    total: rows.length,
    // Named so the UI does not have to know the vocabulary, and so an empty
    // group is still a group the operator can see is empty.
    groups: {
      waiting:      groups.waiting      || [],
      retry:        groups.retry        || [],
      fix:          groups.fix          || [],
      permanent:    groups.permanent    || [],
      disabled:     groups.disabled     || [],
      unclassified: groups.unclassified || [],
    },
  });
});

// ── History ────────────────────────────────────────────────────────────────────
// Read-only, both of them. Mounted after /webhook like everything else here, so
// requireAuth already covers them without saying so.
router.get('/runs', (req, res) => res.json({ runs: listRuns({ limit: req.query.limit }) }));

// 404, never the current run. A bookmark to a campaign that no longer exists
// must not quietly render a different one — the operator would read that as an
// answer and act on it.
router.get('/runs/:id', (req, res) => {
  const detail = runDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'No campaign with that id' });
  res.json(detail);
});

module.exports = router;

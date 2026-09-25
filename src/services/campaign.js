'use strict';
const { CFG, FILES, QUIET_HOURS, TIMEOUTS } = require('../config');
const { readJSON, writeJSON, debouncedWriter } = require('../lib/store');
const { S, flags, ACTIVE_PHASES, campaignActive, log, sleep } = require('../state');
const { broadcast } = require('./status');
const { isDisabled, disable, markMessaged, getRow } = require('./contacts');
const { effectiveCap, markWarmupDay, capWindow, capCount, warmupDay } = require('./warmup');
const { recordOutbound, funnelForRun, startRun, buildRun, nextPending,
        recordRecipientSent, recordRecipientSkipped, recordRecipientRetry,
        requeueFailedRecipient, recipientFor, runExists, discardUnstartedRun,
        nextRetryForRun, progressForRun, senderThrottleUntil, slotFreesAt } = require('./messages');
const { sanitizeParam, renderBody } = require('./templates');
const { explainError, skipDisposition, haltsCampaign, disableReasonFor } = require('../lib/errors');
const { deferPastQuietHours, nextIstMidnight } = require('../lib/schedule');
const { graphHeaders, fetchAccountInfo } = require('./graph');
const { headerComponent } = require('./media');

// ── Campaign persistence ───────────────────────────────────────────────────────
// Without this the send queue lives only in memory: a VM reboot, a systemd
// restart or an OOM kill loses which contacts were already messaged, and the
// operator has no way to resume without risking a full re-send.
const writer = debouncedWriter(FILES.campaign, 2000);

// The contacts array and currentIdx are deliberately gone from this file. The
// queue lives in run_recipients and the resume point is derived from it, so all
// that is left here is the pacing state a database row has no opinion about:
// which run is current, and how much of today's cap is spent.

// The exact sentence /api/pause writes, and the one thing that distinguishes an
// operator's pause from one the loop gave itself. A crash during a daily-cap or
// rate-limit pause used to be unrecoverable: resumeIfInterrupted only picked up
// 'running' and 'waiting', so the run sat at 'paused' with no loop behind it —
// and 'paused' is in ACTIVE_PHASES, so campaignBlocker() then refused every
// Start and every CSV upload until someone found the Stop button.
const USER_PAUSE = 'Paused by user';

const snapshot = () => ({
  phase:        S.phase,
  config:       S.config,
  // Persisted for one reason only: telling an operator's pause from the loop's
  // own on the next boot. See USER_PAUSE above.
  pauseReason:  S.pauseReason,
  // Without this a restart forgets which run is current, applyStatus/recordOutbound
  // fall back to run_id NULL, and a resumed send merges into the inbox-reply /
  // migrated-legacy bucket that countsForRun(null) used to expose (see F1).
  currentRunId: S.currentRunId,
  savedAt:      Date.now(),
});

const saveCampaign      = () => writer.schedule(snapshot);
const saveCampaignNow   = () => writer.flush(snapshot);
const clearCampaignFile = () => writeJSON(FILES.campaign, {});

function loadCampaign() {
  const d = readJSON(FILES.campaign, {});
  if (d.currentRunId == null) {
    // A campaign.json written before run_recipients existed carried the queue
    // as an array in this file. There is no queue to rebuild from it — the
    // contacts are in SQL now but the ORDER and the already-sent marks are not
    // — so resuming would either re-send to everyone or to nobody. Say so
    // loudly: an operator whose run stopped at a deploy needs to know it did.
    if (Array.isArray(d.contacts) && d.contacts.length) {
      log('warn', `campaign.json is from before the durable send queue — its ${d.contacts.length} contacts were NOT resumed. Re-upload the CSV to start a run; anyone already messaged is in the thread list.`);
    }
    return null;
  }
  // A campaign.json that outlived its database — a wa.db restored from an older
  // backup, or recreated — points at a run that does not exist. node:sqlite
  // enforces the run_id REFERENCES, so restoring that id would make the first
  // test-send's INSERT throw "FOREIGN KEY constraint failed" outside any
  // try/catch and kill the process; and a saved active phase with no real run
  // behind it leaves campaignBlocker() refusing every Start until Stop is
  // pressed. Same state-file/DB skew reconcileWarmupDays exists for.
  if (d.currentRunId != null && !runExists(d.currentRunId)) {
    log('warn', `campaign.json points at run ${d.currentRunId}, which is not in the database — the state files and wa.db are out of step, so starting idle`);
    // The operator's own settings are still theirs; only the phantom run and
    // the phase that depended on it are dropped.
    if (d.config) Object.assign(S.config, d.config);
    return null;
  }
  // dailyCount / dailyDate are not restored, and a file that still carries them
  // is simply ignored: today's count is derived from the message rows now, so a
  // restart re-reads it rather than trusting a number written before the crash.
  Object.assign(S, {
    phase:        d.phase        || 'idle',
    pauseReason:  d.pauseReason  ?? null,
    currentRunId: d.currentRunId,
  });
  if (d.config) Object.assign(S.config, d.config);
  return d;
}

// Fills {{1}}, {{2}}… for one contact. Each slot is either a contact field that
// varies per recipient, or one fixed value typed once for the whole campaign —
// which is how you change a figure (a price, a date) without Meta re-approving
// anything. Approved text is frozen; the values in it are not.
//
// ponytail: 'name' is the only per-contact field the CSV carries today. Add to
// CONTACT_FIELDS when the parser learns more columns.
const CONTACT_FIELDS = ['name'];

function buildParams(contact) {
  return (S.config.paramValues || []).map(p => ({
    type: 'text',
    text: sanitizeParam(p.source === 'fixed' ? p.value : contact[p.source] ?? contact.name),
  }));
}

// A slot is unusable if it is a fixed value nobody filled in — sending would put
// the literal fallback "there" where a price was meant to go.
function missingParams() {
  return (S.config.paramValues || [])
    .map((p, i) => (p.source === 'fixed' && !String(p.value || '').trim() ? i + 1 : 0))
    .filter(Boolean);
}

// The codes sendTemplate reports as a skip rather than a failure — each one is
// about the recipient or the moment, never about the request itself. One list,
// asked of both the code and the subcode. 131050 (marketing turned off by the
// person, in WhatsApp) is about the recipient like 131026: a skip, not a failure
// the operator can fix, and one Meta can signal as a subcode too.
const SKIPPABLE = [131026, 131047, 131049, 131050, 131051];

// ── Meta Cloud API — send one template message ─────────────────────────────────
async function sendTemplate(contact) {
  if (!CFG.accessToken || !CFG.phoneNumberId) {
    return { ok: false, error: 'Missing credentials', errorCode: -1 };
  }
  const params = buildParams(contact);

  // The template a campaign sends is approved for the SHAPE of its header — a
  // document — not for a particular document. Resolving the asset here rather
  // than at approval is what lets next month's price list reuse this month's
  // approved template.
  const attach = async ({ force = false } = {}) => {
    if (!S.config.headerAssetId) return null;
    const h = await headerComponent(S.config.headerAssetId, { force });
    if (!h.ok) throw new Error(h.error);
    return h.component;
  };

  // MM Lite: Meta's Marketing Messages API takes the identical payload on a
  // sibling endpoint and optimises delivery timing on Meta's side. MARKETING
  // templates only — /marketing_messages rejects every other category — and a
  // WABA that has not finished MM Lite onboarding is routed back through the
  // Cloud API by Meta itself (CLOUD_API_FALLBACK is the default product
  // policy), so the flag is safe to have on before onboarding completes.
  const endpoint = S.config.mmLite && S.config.templateCategory === 'MARKETING'
    ? 'marketing_messages' : 'messages';

  const post = async header => {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                contact.dialStr,
      type:              'template',
      template: {
        name:     S.config.templateName,
        language: { code: S.config.templateLanguage },
      },
    };
    // Meta requires header before body, and rejects an empty parameters array
    // as readily as a missing required one (132000) — so each component is
    // attached only when it actually carries something.
    const components = [];
    if (header)        components.push(header);
    if (params.length) components.push({ type: 'body', parameters: params });
    if (components.length) body.template.components = components;

    // A timeout of its own, read per call: the loop is single, and with no
    // signal a wedged connection held it — and Stop — on undici's five-minute
    // timers, once per contact. An abort throws into the catch below, which is
    // already the transient -1 path: back off seconds, retry this contact.
    const res = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${CFG.phoneNumberId}/${endpoint}`,
      { method: 'POST', headers: graphHeaders(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUTS.graphMs) }
    );
    return { res, data: await res.json() };
  };

  try {
    let header = await attach();
    let { res, data } = await post(header);

    // Meta deletes media at 30 days and our refresh clock is not their clock.
    // Re-uploading the file and retrying once turns an expired attachment into
    // a hiccup instead of the point where a campaign of hundreds stops.
    //
    // Keyed on data.error, not res.ok: Graph returns HTTP 200 carrying an
    // error object for this class of failure.
    if (header && /media/i.test(data.error?.message || '')) {
      log('warn', 'Send rejected over the header media — re-uploading it and retrying once');
      header = await attach({ force: true });
      ({ res, data } = await post(header));
    }

    // params travels back with the result so the caller renders the stored body
    // from exactly what was sent, rather than rebuilding it and hoping the two
    // agree. This is the whole "cannot drift" guarantee.
    if (res.ok && data.messages?.[0]?.id) return { ok: true, messageId: data.messages[0].id, params };
    const err     = data.error || {};
    const code    = err.code        || 0;
    const subcode = err.error_subcode || 0;
    const msg     = err.message     || JSON.stringify(data);
    // Skippable: undeliverable, ecosystem health, re-engagement window. Meta
    // can signal one in error_subcode under a generic code (100 carrying
    // 131026), and the code that MATCHED is the one everything downstream must
    // act on: reporting the generic 100 made skipDisposition call a dead number
    // 'fix' — never switched off, re-tried by every later run, and explained to
    // the operator as a template problem. Resolved once, so the hint and the
    // code cannot describe two different failures.
    const eff  = SKIPPABLE.includes(code) ? code
               : SKIPPABLE.includes(subcode) ? subcode
               : code;
    const hint = explainError(eff) || explainError(code) || explainError(subcode);
    if (SKIPPABLE.includes(eff)) {
      return { ok: false, skip: true, error: msg, errorCode: eff, hint };
    }
    // Rate limit: back off and retry same contact
    if ([130429, 80007, 4].includes(code)) {
      const retryMs = res.headers.get('retry-after')
        ? parseInt(res.headers.get('retry-after')) * 1000 : 60000;
      return { ok: false, rateLimit: true, error: msg, errorCode: code, retryAfter: retryMs, hint };
    }
    return { ok: false, error: msg, errorCode: code, hint };
  } catch (e) {
    // fetch itself threw — DNS, TLS, or no outbound network from this host — or
    // the header asset could not be uploaded, which attach() raises.
    // `transient` routes it through the same in-loop backoff a rate limit gets:
    // a 30-second blip at contact #340 should cost 30 seconds, not park that
    // contact — and, one by one, the whole rest of the list — three hours out
    // on the ladder.
    return { ok: false, error: `Could not send: ${e.message}`, errorCode: -1,
             transient: true, retryAfter: 30000,
             hint: 'Network problem on the machine running this server, or the header file could not be uploaded to Meta.' };
  }
}

// ── Retrying a failure that was about the moment ───────────────────────────────
// One DNS blip while sending to contact #340 used to drop that person from the
// run permanently, and the only way to reach them again was re-uploading the CSV
// — which opens a new run and messages everyone a second time. That is the leak
// this closes.
//
// The DEFAULT ladder: five waits of three hours, so six attempts in total, for
// failures that really are about the moment — a network blip, a Meta fault, a
// throughput limit. Any deadline landing in the night is pushed to 08:00 IST by
// deferPastQuietHours.
//
// WHICH failures come back here is lib/errors.js:skipDisposition, not a list
// kept here. A code has to be named 'retry' there to get a second attempt.
const RETRY_BACKOFF_MS = [3, 3, 3, 3, 3].map(h => h * 3600000);

// Per-code ladders, for the failures whose clock is not ours.
//
// 131049 is Meta's per-user marketing cap: a ROLLING per-person window counted
// across every business that messages that person. It used to walk the default
// ladder — five retries inside fifteen hours — and Meta's own per-user-limits
// page says two things that make that actively harmful: wait AT LEAST 24 hours
// before resending, and repeated resends inside a 24-hour window can extend the
// block by up to another 24 hours. So these rungs are a day apart, which is
// also the industry norm (WATI retries every 24h for up to 7 days; Gallabox
// 24h/12h/12h; WANotifier and QuickReply 3×24h — QuickReply reports recovering
// about half of initially-refused sends this way).
//
// No ladder reaches zero on 131049: the cap belongs to the recipient, not to
// the attempt. Reaching a capped person reliably means the 24-hour service
// window — a template that invites a reply, then a free-form send — which is
// what services/inbox.js sendMedia exists for.
//
// 131048 is the sender-level spam throttle: it lifts on its own, on a scale of
// hours, and hammering it feeds the very signal that raised it. Because it is
// about the NUMBER, the loop also parks on these rungs (senderThrottleUntil in
// campaignLoop) — so they are how long the whole run waits, not just one row.
const RETRY_LADDERS = {
  131049: [24, 24, 24].map(h => h * 3600000),
  131048: [4, 12, 24].map(h => h * 3600000),
};

// One place answers "how long until this code's next go" for BOTH entrances —
// the send response and the failure webhook — so they cannot walk two ladders.
const backoffFor = code => RETRY_LADDERS[Number(code)] || RETRY_BACKOFF_MS;

// The ceiling over every ladder a contact climbs in one run: the default five
// plus 131049's three. Each code's rung count restarts when a different code
// interrupts it, so a contact whose sends alternate between a network blip and
// a 131049 refusal never finishes either ladder — without a cap on the TOTAL
// they would be retried, and billed, forever.
const MAX_RETRIES_TOTAL = 8;

// A contact's position on the ladder for THIS code, asked by both entrances so
// they cannot disagree about which rung someone is on. `attempts` is the total —
// what the report shows as "tried N×" — and never resets; `ladder_attempts` is
// the rung of `ladder_code`'s ladder, so a contact who burned three network
// blips still gets all three of 131049's day-spaced rungs. Number() on both
// sides because a code can come back from SQL or a webhook as text; the null
// check because Number(null) is 0, and a fresh row must not match code 0.
function ladderPosition(row, code) {
  const ladder = backoffFor(code);
  const made = row.ladder_code != null && Number(row.ladder_code) === Number(code)
    ? (row.ladder_attempts || 0) : 0;
  return { ladder, made, exhausted: made >= ladder.length || (row.attempts || 0) >= MAX_RETRIES_TOTAL };
}

// Below this, a wait for the next retry deadline is spent silently — see the
// long note at the `waiting` branch in campaignLoop. One minute rather than a
// few seconds because the deadlines inside one rung are smeared across however
// long the previous rung took to send, and every gap inside that smear is a gap
// nothing useful can be said about.
const ANNOUNCE_WAIT_MS = 60000;

// How many times in a row the loop will sleep off a rate limit for ONE contact
// before handing them to the retry ladder and moving on.
//
// The in-loop backoff is right for a burst: Meta says "wait 60s", the loop
// waits, the send goes through, nobody is inconvenienced. It is wrong for a
// throughput limit the account is genuinely sitting against, because that branch
// re-sends the SAME contact with no counter — a persistent 130429 parked a whole
// campaign on contact #340 indefinitely, with the phase stuck on 'paused', every
// other contact untouched, and nothing on screen saying it was one number rather
// than the account.
//
// Three, because the useful case is a burst that clears in a minute or two.
// After that it is not a hiccup, and the honest thing is to park that contact on
// the ladder — 130429 / 80007 / 4 are all in skipDisposition's RETRY set, so the
// hand-off costs nothing and picks them up hours later — and let the loop reach
// everyone else in the meantime.
const RATE_LIMIT_RETRIES = 3;

const clockIST = ms => new Date(ms).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

// The one rule for all three sites that touch the night: the loop's clock gate
// and both retry-deadline writers. WA_QUIET_HOURS=0 is the operator's sanctioned
// opt-out, and it used to apply only to the clock gate — a failure at 23:30 was
// still deferred to 08:00, so the deployment that explicitly disabled quiet
// hours parked all night anyway. Not pushed into lib/schedule.js: the suite runs
// with the flag off and still has to test the deferral arithmetic itself.
const deferIfQuiet = t => (QUIET_HOURS ? deferPastQuietHours(t) : t);

// True when the contact was put back in the queue; false when the caller should
// record a terminal skip. Which rung this contact is on is ladderPosition's
// answer, read off the row — the SQL increments both counts, so neither can
// drift.
// `runId` is passed in rather than read from S here, and for the same reason the
// loop captures it before the await: this runs after sendTemplate() has resolved,
// and a /api/reset landing in that window would otherwise park the contact on a
// null run — a row that matches nothing, so the retry is simply lost.
function scheduleRetry(contact, row, result, n, runId = S.currentRunId) {
  if (skipDisposition(result.errorCode) !== 'retry') return false;
  const { ladder, made, exhausted } = ladderPosition(row, result.errorCode);
  if (exhausted) {
    log('warn', `${n} ${contact.name} — still failing after ${(row.attempts || 0) + 1} attempts, reporting it [${result.errorCode}]`);
    return false;
  }
  // Deferred before it is stored, not before it is read: retry_after is both
  // what nextPending compares against and what the "next attempt" sentence shows
  // the operator, so nudging the deadline anywhere else would leave the queue
  // and the screen disagreeing about when this contact is due.
  const at = deferIfQuiet(Date.now() + ladder[made]);
  recordRecipientRetry(runId, contact.dialStr, result.errorCode, at);
  log('warn', `${n} ${contact.name} — ${result.hint || result.error} [${result.errorCode}]. Retry ${made + 1} of ${ladder.length} at ${clockIST(at)}`);
  return true;
}

// ── A number Meta says cannot receive messages ─────────────────────────────────
// "Not on WhatsApp" is the common case, and it is a fact about the NUMBER rather
// than about this attempt: no ladder changes the answer, and a contact left
// enabled burns one send slot on every run for the rest of the list's life.
//
// The three places that can learn it — the send response, the delivery-failure
// webhook, and a test send — all route through here, so none of them can grow a
// different idea of which codes count. Which ones do is
// lib/errors.js:skipDisposition; `permanent` is its name for exactly this.
//
// Not every permanent code is about the number. 131050 is the person turning
// marketing from this business off inside WhatsApp: switched off just the same,
// but as an opt-out (lib/errors.js:disableReasonFor), so the report files them
// with the people who asked us to stop rather than calling them "not on
// WhatsApp" — and the log line says which of the two it was.
//
// disable() writes both the contacts row and the suppressed row, and it is a
// no-op when the contact is already off for the same reason — so a redelivered
// webhook, a replayed envelope and a second run all cost nothing. The
// suppression outlives the contacts row on purpose: re-uploading the CSV brings
// the person back already switched off.
//
// Returns true only on the transition, so the caller logs once.
function suppressIfPermanent(dialStr, code, name = null, prefix = '') {
  if (skipDisposition(code) !== 'permanent') return false;
  const reason = disableReasonFor(code);
  if (!disable(dialStr, reason, name)) return false;
  log('warn', `${prefix} ${name || '+' + dialStr} switched off — ${reason === 'opt_out'
    ? 'they turned off marketing from you in WhatsApp, so no later run will message them unless they opt back in'
    : 'Meta reports this number as undeliverable (usually: not on WhatsApp), so no later run will try it'}`.trim());
  return true;
}

// ── The other half of the ladder: a failure that arrived after the accept ──────
// Meta answers the send with HTTP 200 and a wamid, then decides minutes or hours
// later that it will not deliver it and says so over the status webhook. The
// send-time ladder above never sees these, which is how a run finished
// "5 of 5 sent, 1 failed" with the failure permanently un-retried — and 131049,
// the per-user marketing cap the ladder was lengthened to five rungs FOR, almost
// always arrives this way rather than in the send response.
//
// This runs on the webhook thread, never inside the loop, and a retry does not
// interrupt anything: it only edits the queue row. A campaign still sending
// walks past the row and picks it up when the deadline comes due; a campaign
// that already finished is restarted below. Either way the contacts still
// un-messaged are reached first, and the parked failures come after. The one
// interruption is a fault that fails every send (the halt at the top), which
// stops the loop through the same pauseFlag an operator's Pause sets.
//
// Which codes get a second attempt is lib/errors.js:skipDisposition, the same
// whitelist the send-time path uses — a wrong number or a number not on
// WhatsApp is 'permanent' and is switched off rather than retried, because no
// number of attempts changes the answer and each one costs a send slot.
function handleDeliveryFailure({ waId, runId, wamid, code }) {
  // ── A fault that fails EVERY send, arriving after the accept ──────────────────
  // Billing holds, paused templates and account restrictions mostly arrive here
  // rather than in the send response — Meta accepts, then refuses. The loop's
  // halt only saw the send-time half, so a campaign walked on into the fault and
  // every accepted send came back refused: the whole list spent on one fact.
  // Same park the loop uses (lib/errors.js:haltsCampaign), minus the skip: the
  // row already carries its failure, and the contacts still pending stay
  // pending, so Resume after the fix loses nobody.
  //
  // Only the live campaign, and only the current run. A stale run has nothing
  // walking it; an idle or finished one has no loop to stop, and a flag left set
  // there would greet the next Start as a pause. Parks once: a second halt, or
  // one landing on a pause already under the flag — the operator's own included
  // — changes nothing, so a redelivery or a replay is free. And a Stop in flight
  // is final: /stop has cleared the flag and said idle, but campaignActive()
  // stays true until the loop notices, and a pause repainted in that window is
  // what used to let a stopped run come back.
  if (haltsCampaign(code) && runId === S.currentRunId && campaignActive() && !flags.stopFlag) {
    if (!flags.pauseFlag) {
      const hint = explainError(code);
      flags.pauseFlag = true;
      S.phase = 'paused';
      S.pauseReason = `Campaign paused — ${hint || 'Meta refused a delivery for a reason that fails every send'} [${code}]`;
      log('error', `+${waId} — Meta refused a delivery [${code}] for a reason that fails every send — campaign paused. Fix the cause, then press Resume.`);
      if (hint) log('error', `   ↳ ${hint}`);
      saveCampaignNow(); broadcast();
    }
    return 'halted';
  }

  const disp = skipDisposition(code);

  // About the NUMBER, not about the moment. The send-time path disables these
  // too; this is the same fact arriving late, and disable() is a no-op when the
  // contact is already off for that reason, so replay is free.
  if (disp === 'permanent') {
    if (suppressIfPermanent(waId, code)) broadcast();
    return 'permanent';
  }
  // 'fix' is a fault a human has to correct and 'unclassified' is a code nobody
  // has ruled on. Retrying either unchanged reproduces the failure once per
  // contact, which is the cost the whitelist exists to refuse.
  if (disp !== 'retry') return disp;

  // Only the CURRENT run has anything walking its queue. A campaign finishes,
  // the operator uploads a new CSV — which opens a new run and makes it current
  // — and then a late failure webhook arrives for the old one. Requeuing there
  // un-stamps a wamid nothing will ever re-send: the old run's report flips from
  // "completed" to "incomplete", that contact moves out of `delivered`/`sent`
  // and into `retrying`, and the card then promises an attempt that has no loop
  // to make it. The failure is still recorded on the message row by applyStatus,
  // which is the honest outcome — the send did fail, and this run is over.
  if (runId !== S.currentRunId) return 'stale';

  const row = recipientFor(runId, waId);
  // No row means the failure belongs to an inbox reply or a run whose queue was
  // rebuilt. Nothing to put back.
  if (!row || row.wamid !== wamid) return 'stale';

  const { ladder, made, exhausted } = ladderPosition(row, code);
  if (exhausted) {
    // This code's whole ladder is spent, or the contact has used up the total
    // ceiling. The cap belongs to the recipient, not to the attempt, so there is
    // no ladder length that zeroes it — see the note above RETRY_LADDERS. They
    // stay in `failed` and the run closes.
    log('warn', `+${waId} — still not delivered after ${(row.attempts || 0) + 1} attempts, giving up [${code}]`);
    return 'exhausted';
  }
  const at = deferIfQuiet(Date.now() + ladder[made]);
  if (!requeueFailedRecipient(runId, waId, wamid, code, at)) return 'stale';
  log('warn', `+${waId} — back on the queue, retry ${made + 1} of ${ladder.length} at ${clockIST(at)}`);

  // Reopening a finished run. The run is already known to be the current one —
  // the guard above returned 'stale' otherwise — so what is left to establish is
  // that the loop is not already walking it. `S.phase === 'done'` is the test
  // rather than `!campaignActive()` alone, because it is the one phase that
  // means the loop ran out of work by itself: a Stop leaves 'idle' and a Reset
  // drops the run id, and a webhook must not restart a campaign the operator
  // ended. The loop sets the phase to 'waiting' as soon as it sees the deadline
  // is in the future, so the dashboard goes back to "In progress — retrying".
  if (S.phase === 'done' && !campaignActive()) {
    log('info', 'Campaign reopened — a delivery failure came back after it had finished');
    startLoop();
  }
  broadcast();
  return 'retrying';
}

// Waits in slices rather than in one call, so Stop and Pause are answered in a
// second instead of in hours. A four-hour `await sleep()` would leave the
// operator holding a button that does nothing.
//
// One second, not fifteen: the slice length is also how long `flags.running`
// stays true after a Stop, and that window is what /upload-csv and /start refuse
// through campaignBlocker(). Fourteen thousand no-op timer wakeups over a
// four-hour wait cost nothing measurable; fifteen seconds of "still stopping"
// after clicking Stop reads as the button having failed.
async function sleepUntil(at) {
  while (Date.now() < at) {
    if (flags.stopFlag || flags.pauseFlag) return;
    await sleep(Math.min(1000, at - Date.now()));
  }
}

// Quality gates the warm-up climb (warmup.js:rawStep), and the rating the loop
// holds was read at /start — or whenever someone last opened Settings. A
// campaign parked overnight on the cap woke into a new day and climbed a rung
// on a rating that could have turned RED hours before. So the cap park asks
// again as it ends, before the cap is re-derived — belt and braces beside
// Meta's phone_number_quality_update webhook, which can be unsubscribed or lost.
//
// Never throws — the loop awaits it — and a failure keeps the last rating: no
// answer is not a GREEN answer. fetchAccountInfo resolves { error } for a Graph
// refusal and rejects on a network one (or its timeout); both are said.
async function refreshQuality() {
  const keep = () => `Keeping the last rating (${S.quality ?? 'none yet'}).`;
  try {
    const info = await fetchAccountInfo();
    if (info?.qualityRating) S.quality = info.qualityRating;
    else log('warn', `Could not re-read the quality rating — ${info?.error || 'no rating in the answer'}. ${keep()}`);
  } catch (e) {
    log('warn', `Could not re-read the quality rating — ${e?.message ?? e}. ${keep()}`);
  }
}

// ── One campaign at a time ─────────────────────────────────────────────────────
// stageRun REPLACES run_recipients for the run it is given and /upload-csv opens
// a new run, so a CSV uploaded mid-flight would abandon a queue that is still
// being walked — every wamid lost, every un-messaged contact orphaned in a run
// nothing points at any more. The guard is here rather than in the routes so
// both entry points cannot disagree about what "active" means.
//
// `flags.running` is in the test deliberately, and it is the half that matters:
// a Stop sets the phase to idle immediately, but the loop is still inside an
// await for up to a second afterwards. Trusting the phase alone let a Start in
// that window spawn a SECOND loop over the same queue, and two loops walking one
// run message whoever they both reach twice.
// 'waiting' is the retry phase. Every label the operator sees for it says "In
// progress" instead — this string is state, that string is presentation, and
// they are allowed to differ. Renaming it to match the label silently changes
// what campaignBlocker() refuses and what resumeIfInterrupted() picks back up,
// which is how the two-loops-on-one-queue double send got in before. The list
// itself lives in state.js: three modules ask this question.

// The sentence a route hands the operator, or null when nothing is in the way.
function campaignBlocker() {
  if (!campaignActive()) return null;
  // Stopped, but the loop has not returned yet. Reporting progress here would
  // read as nonsense — a reset has already cleared currentRunId, so the counts
  // are zeroes — and the honest answer is that it takes a moment.
  if (!ACTIVE_PHASES.includes(S.phase)) {
    return 'The previous campaign is still stopping — try that again in a second.';
  }
  const p = progressForRun(S.currentRunId);
  const what = S.phase === 'waiting'
      ? `in progress — retrying ${p.retrying} contact${p.retrying === 1 ? '' : 's'}`
    : S.phase === 'paused' ? 'paused part-way through'
    : 'still sending';
  return `A campaign is ${what} — ${p.sent + p.skipped} of ${p.total} done, ${p.pending} left. Stop it, or let it finish, before starting another.`;
}

// ── Campaign loop ──────────────────────────────────────────────────────────────
function startLoop() {
  if (flags.running) return;
  flags.pauseFlag = false; flags.stopFlag = false; flags.running = true;
  campaignLoop().catch(e => {
    flags.running = false;
    // Park honestly. Left as it was, the phase went on saying 'running' with no
    // loop behind it: the dashboard showed a campaign in progress that would
    // never move, and campaignBlocker() answered every Start and upload with
    // "still sending". pauseFlag is what makes /api/resume treat this as the
    // operator's pause to lift — Resume restarts the loop at the same row,
    // because the queue is on disk — and the reason is not USER_PAUSE, so a
    // reboot resumes it on its own like every other pause the loop gave itself.
    log('error', 'Loop: ' + (e?.message ?? e));
    if (flags.stopFlag) {
      // A Stop or Reset already in flight is the operator's last word: both
      // mean idle, exactly as the loop's own stop exit leaves it. Parking it as
      // a resumable pause would bring back a campaign they stopped, one Resume
      // or one reboot later.
      S.phase = 'idle'; S.pauseReason = null; flags.pauseFlag = false;
    } else {
      flags.pauseFlag = true;
      S.phase = 'paused';
      // The operator's own Pause stays theirs. Any other reason makes the next
      // boot resume it on its own (resumeIfInterrupted), which is right for the
      // crash and wrong for a pause somebody chose; the error is in the log.
      if (S.pauseReason !== USER_PAUSE) {
        S.pauseReason = `The send loop stopped on an error — ${e?.message ?? e}. Press Resume to carry on from the same contact.`;
      }
    }
    // Its own try: the crash may have BEEN the disk or the database, and a throw
    // from here would be an unhandled rejection that takes the process down.
    try { saveCampaignNow(); broadcast(); } catch { /* the park above is what matters */ }
  });
}

async function campaignLoop() {
  log('info', `Campaign started — ${progressForRun(S.currentRunId).pending} contacts queued`);
  // Which contact the rate-limit branch is currently sleeping off, and how many
  // times in a row it has done so. Loop-local rather than on S: it is about this
  // walk of the queue and means nothing across a restart, and the durable answer
  // — the ladder — is a column on the row.
  let rateLimited = { phone: null, n: 0 };
  while (true) {
    // Only /stop and /reset set stopFlag, and both mean idle — so a Stop leaves
    // the campaign idle, whatever was painted since. It used to keep any phase
    // but idle and promote it to 'done', and 'done' is the one phase a failure
    // webhook reopens: a halt that repainted a pause between the Stop and this
    // exit let a later 131049 restart a campaign the operator had stopped. Never
    // 'done' either for the plain case — that told the operator "Finished" about
    // a run they stopped.
    if (flags.stopFlag) {
      log('info', 'Stopped');
      S.phase = 'idle'; S.pauseReason = null; flags.pauseFlag = false;
      saveCampaignNow(); broadcast(); break;
    }
    if (flags.pauseFlag) { await sleep(500); continue; }
    // The queue is asked, never counted. Nothing in this loop holds a cursor
    // that a crash could leave ahead of what was actually sent.
    const c = nextPending(S.currentRunId);
    if (!c) {
      // Nothing sendable RIGHT NOW is not the same as nothing left. A run with
      // contacts on the retry ladder stays open and sleeps to the earliest of
      // them; declaring it done here is what used to lose those people.
      const retry = nextRetryForRun(S.currentRunId);
      if (retry) {
        // A rung does not come due all at once. Each contact's retry_after is
        // written when that contact's OWN failure webhook lands, so a rung of a
        // hundred is a hundred deadlines smeared across however long the
        // previous rung took to send. nextPending only returns what is due this
        // instant, so the loop drains them one at a time — send one, nothing due
        // for three seconds, send the next.
        //
        // Announcing that three-second gap is what turned a working ladder into
        // a crawl. The block below is a log line, a SYNCHRONOUS fsync
        // (saveCampaignNow) and two full buildState() rebuilds — eight SQL
        // aggregates including a three-table join — and on the 775-contact run
        // in production it fired 340 times for 549 retry sends. The rung took
        // hours instead of minutes, and the ladder's deadlines then cascaded
        // past midnight, which is the other half of the bug below.
        //
        // Nothing an operator can act on happens in a wait this short, so it is
        // spent silently: same sleep, no phase flap, no fsync, no broadcast.
        if (retry.at - Date.now() <= ANNOUNCE_WAIT_MS) { await sleepUntil(retry.at); continue; }
        S.phase = 'waiting';
        // "In progress", not "Waiting". The ladder runs for up to a day now, and
        // an operator who reads this as stalled presses Stop — which abandons
        // precisely the contacts the ladder exists to recover.
        S.pauseReason = `In progress — retrying ${retry.count} contact${retry.count === 1 ? '' : 's'}, next attempt ${clockIST(retry.at)}`;
        log('info', S.pauseReason);
        saveCampaignNow(); broadcast();
        await sleepUntil(retry.at);
        // Stop and Pause are handled at the top of the loop; falling through
        // with the phase still 'waiting' would strand it there.
        if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
        continue;
      }
      const f = funnelForRun(S.currentRunId);
      log('info', `Done — ${f.total} contacts: ${f.delivered} delivered, ${f.sent} awaiting confirmation, `
        + `${f.failed} failed, ${f.unreachable} not on WhatsApp, ${f.optedOut} opted out`);
      S.phase = 'done'; saveCampaignNow(); broadcast(); break;
    }
    // null is "no cap at all": the warm-up ladder is complete (or off) and the
    // operator has set no number of their own, so how much this number may send
    // today is Meta's business and the loop does not park for it.
    //
    // Compared against capCount(), not today's count: while the warm-up rung is
    // the cap in force it is counted over Meta's rolling 24 hours, and your own
    // cap over the IST day — warmup.js:capWindow says which, and why.
    const cap = effectiveCap();
    if (cap !== null && capCount() >= cap) {
      // When a slot comes back depends on the window. A day frees everything at
      // IST midnight. The rolling window frees one contact at a time, 24 hours
      // after their latest send, so the next send is due when the earliest of
      // those leaves — hours before midnight, or long after it. The fallback only
      // guards the two queries disagreeing (every counted send leaving the window
      // between them): a short silent wait, then the count is asked again.
      //
      // The rung itself moves at IST midnight — a new sending day climbs one,
      // and graduation lifts it after the top rung — so a rolling park wakes at
      // whichever comes first and lets the wake re-derive the cap. Sleeping to
      // the seat alone slept through the climb: a window filled at 20:00 waited
      // until 20:00 the next day while the new rung had room from midnight.
      const rolling = capWindow() === '24h';
      const midnight = nextIstMidnight();
      const slot = rolling ? (slotFreesAt() ?? Date.now() + ANNOUNCE_WAIT_MS) : null;
      const until = rolling ? Math.min(slot, midnight) : midnight;
      // Yesterday's contacts leave the rolling window as far apart as they were
      // sent — seconds, at campaign pace — so a loop at the ceiling parks once
      // per freed slot. Announcing each of those is the slowdown described at
      // the `waiting` branch above: a log line, a broadcast and a phase flap per
      // send. Same rule as there: a wait this short is slept, silently.
      if (until - Date.now() <= ANNOUNCE_WAIT_MS) { await sleepUntil(until); continue; }
      // The sentence names the ceiling that said no and the window it counts,
      // because "why did the campaign stop at 50" has two answers now.
      S.phase = 'paused';
      S.pauseReason = rolling
        ? `Warm-up ceiling: ${cap} people in the last 24 hours (day ${warmupDay()}). Next send at ${clockIST(slot)}`
          + `${midnight < slot ? ' — sooner if the new day\'s rung is higher' : ''}.`
        : `Daily cap reached (${cap}/day). Resumes at ${clockIST(until)}.`;
      log('info', S.pauseReason);
      broadcast();
      // sleepUntil, not sleep: this wait is up to a full day. A bare sleep here
      // meant a Stop set stopFlag that nothing read until tomorrow — and since
      // `flags.running` stays true until the loop exits, campaignBlocker()
      // refused every Start and every CSV upload for those hours with "still
      // stopping, try again in a second".
      await sleepUntil(until);
      // The rating before the rung: the next capCount() check is asked of it.
      // The flags are read again after the await — a Stop or a Pause that lands
      // while Meta is answering must not be painted over with 'running'.
      if (!flags.stopFlag && !flags.pauseFlag) await refreshQuality();
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue;
    }
    // A contact is { name, dialStr } to everything below; run_recipients stores
    // the same two fields under SQL names.
    const contact = { name: c.name, dialStr: c.phone };
    // Read ONCE, before the await, and used for every write about this send.
    // /api/reset sets S.currentRunId to null synchronously, and it can land while
    // the loop is inside sendTemplate() — so reading S.currentRunId again after
    // the await gave the queue stamp a null run (matching no row, leaving the
    // contact pending) while the message row was filed under run_id NULL, which
    // is the bucket inbox replies live in and the one countsForRun(null) exists
    // to keep clean. One template send, mis-filed, and one contact who would be
    // messaged twice on a resume. The run this message belongs to was decided
    // when nextPending returned it.
    const runId = S.currentRunId;
    const p = progressForRun(runId);
    // Contacts attempted, this one included. `p.attempted` already counts a row
    // the ladder put back, so a contact on their second go must not be added a
    // second time — untried is the only state that has not been counted yet,
    // and `skipped_reason` is what nextPending's two halves are told apart on.
    // This is why the index cannot pass the total, and why it never counts down.
    const n = `[${p.attempted + (c.skipped_reason ? 0 : 1)}/${p.total}]`;

    // Re-checked here, not only at run build: a customer can tap "Stop
    // promotions" while the run this row belongs to is halfway through it.
    if (isDisabled(contact.dialStr)) {
      // The reason is worth saying out loud: "opted out" and "Meta says this
      // number is undeliverable" are the same skip to the loop and completely
      // different problems to the operator.
      const why = getRow(contact.dialStr)?.disabled_reason || 'disabled';
      // c.error_code, not null: a contact parked on the retry ladder and then
      // disabled mid-run was really attempted — nulling the code here made the
      // skip report claim "nothing was attempted" about someone this run
      // messaged. NULL for a fresh row, so this is a no-op on the common path.
      recordRecipientSkipped(runId, contact.dialStr, 'disabled', c.error_code ?? null);
      log('warn', `${n} skipped — ${contact.name} is disabled (${why})`);
      saveCampaign();
      broadcast();
      continue;   // no delay: nothing was sent
    }
    // ── Quiet hours, asked of the clock rather than of the deadline ───────────
    // scheduleRetry defers the retry_after it WRITES, and that is right, but a
    // deadline is a promise about when a contact becomes sendable — not about
    // when the loop gets to them. A rung due at 21:30 that the loop only reaches
    // at 00:02 sends at 00:02, and production did exactly that: 113 marketing
    // templates went out between midnight and 01:00 IST on a run whose every
    // retry_after had been correctly deferred.
    //
    // Same function as the scheduler uses, so there is one definition of night.
    // It applies to the first pass too: a campaign started at 23:30 is the same
    // notification at the same hour, and the quality rating that gates the
    // messaging tier does not care which rung woke the recipient up.
    const gate = deferIfQuiet(Date.now());
    if (gate > Date.now()) {
      S.phase = 'paused';
      S.pauseReason = `Quiet hours — sending pauses 23:00–07:00 IST and resumes at ${clockIST(gate)}.`;
      log('info', S.pauseReason);
      saveCampaignNow(); broadcast();
      await sleepUntil(gate);
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue;
    }
    // ── A throttle on the NUMBER, not on this contact ─────────────────────────
    // 131048 fails every send while it is in force. The loop used to park only
    // the contact who met it and walk straight on to the next — on a long list,
    // hundreds of guaranteed failures at full tempo, each burning a rung and
    // feeding the spam signal that raised the throttle. The deadline is the
    // latest live 131048 rung on this run's queue, written by either ladder
    // entrance; when it passes, the next contact is the probe, and a probe that
    // fails again gets its own rung and parks the loop again. One probe per rung,
    // never a walk. No pauseFlag: like the cap, this is the loop's own pause, so
    // /resume refuses with the sentence and a crash resumes it on the next boot.
    // ponytail: the sentence names 131048 because it is the only SENDER_LEVEL
    // code; a second one would need the query to return which code it found.
    const throttle = senderThrottleUntil(runId);
    if (throttle) {
      S.phase = 'paused';
      S.pauseReason = `Meta is limiting this number over spam signals [131048] — sending pauses until ${clockIST(throttle)}. Contacts already reached are unaffected.`;
      log('warn', S.pauseReason);
      saveCampaignNow(); broadcast();
      await sleepUntil(throttle);
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue;
    }
    // `attempt` is on the line because the index in front of it moves BACKWARDS
    // when the webhook ladder un-stamps a wamid, and a reader with no other
    // signal reads that as the loop starting over.
    const attempt = (c.attempts || 0) + 1;
    // The counter only ever describes the contact in hand. Moving on to anyone
    // else means the last one's rate-limit history is spent — otherwise a contact
    // handed to the ladder here would come back hours later already at the
    // ceiling and skip its inline backoff, which is the cheap fix for a burst.
    if (rateLimited.phone !== contact.dialStr) rateLimited = { phone: null, n: 0 };
    log('info', `${n} ${contact.name} +${contact.dialStr}${attempt > 1 ? ` — attempt ${attempt}` : ''}`);
    const result = await sendTemplate(contact);
    // A fault that fails EVERY send the same way — an expired token, a billing
    // hold, a template Meta paused. Walking on would write the identical
    // failure once per remaining contact, burn the whole list into a skip
    // report of one fact, and charge each row an attempt. Park the campaign
    // instead, with THIS contact still pending: pauseFlag keeps the loop awake
    // and answering, and /api/resume (allowed because the flag is set) retries
    // the same contact first — so a fixed fault costs nobody anything.
    // Which codes qualify is lib/errors.js:haltsCampaign, a whitelist beside
    // skipDisposition, and deliberately not every 'fix' code: a bad CSV value
    // is one row's problem and must not stop the other nine hundred.
    if (!result.ok && haltsCampaign(result.errorCode)) {
      flags.pauseFlag = true;
      S.phase = 'paused';
      S.pauseReason = `Campaign paused — ${result.hint || result.error} [${result.errorCode}]`;
      log('error', `${n} [${result.errorCode}] ${result.error} — campaign paused, nobody was skipped. Fix the cause, then press Resume.`);
      if (result.hint) log('error', `   ↳ ${result.hint}`);
      saveCampaignNow(); broadcast();
      continue;
    }
    if (result.ok) {
      markWarmupDay();
      markMessaged(contact.dialStr);
      // The recipient row is stamped BEFORE the message row. If the process
      // dies between them the worst case is a message with no queue entry —
      // visible in the thread, counted by countsForRun. The other order would
      // leave a sent message the queue still considers pending, and the resume
      // would message that person twice.
      recordRecipientSent(runId, contact.dialStr, result.messageId);
      recordOutbound({ wamid: result.messageId, waId: contact.dialStr, name: contact.name,
                       body: renderBody(S.config.templateBody, result.params)
                             ?? `[template: ${S.config.templateName}]`,
                       runId });
      // Re-read rather than a count plus one: the message row is already written,
      // and asking again is what keeps this line and the cap check reading the
      // same number — over the same window — even when a failure webhook landed
      // mid-send.
      log('success', `${n} accepted — ${capWindow() === '24h' ? 'last 24h' : 'today'}:${capCount()}/${cap ?? 'no cap'}`);
    } else if (result.skip) {
      // A property of the NUMBER, not of the attempt: not on WhatsApp, or
      // blocked by Meta on quality grounds — or the person's own choice, having
      // turned our marketing off in WhatsApp (131050, switched off as an
      // opt-out). Retrying is never right, and left enabled it burns a send
      // slot on every run, forever. The other skippable codes are about the
      // moment, so they change nothing.
      suppressIfPermanent(contact.dialStr, result.errorCode, contact.name, n);
      // 131049 lands here: the per-person marketing cap is about the moment, so
      // it goes back on the queue rather than out of the run.
      if (!scheduleRetry(contact, c, result, n, runId)) {
        recordRecipientSkipped(runId, contact.dialStr, 'skipped', result.errorCode);
        log('warn', `${n} skipped — ${result.hint || result.error} [${result.errorCode}]`);
      }
    } else if ((result.rateLimit || result.transient) && rateLimited.n < RATE_LIMIT_RETRIES) {
      // Counted per contact — the reset above guarantees this counter is about
      // the contact in hand. A limit that clears after one wait is a burst and
      // costs nobody anything; this branch re-sends the SAME contact with no
      // counter, so a limit the account is genuinely sitting against parked the
      // whole campaign on one number. Past the ceiling this condition is false
      // and the row falls through to scheduleRetry below — 130429 / 80007 / 4
      // are all in skipDisposition's RETRY set, so the ladder takes them.
      rateLimited = { phone: contact.dialStr, n: rateLimited.n + 1 };
      const what = result.rateLimit ? 'Rate limit' : 'Network problem';
      log('warn', `${what} — backing off ${Math.round(result.retryAfter / 1000)}s (${rateLimited.n} of ${RATE_LIMIT_RETRIES}). ${result.hint || result.error} [${result.errorCode}]`);
      S.phase = 'paused'; S.pauseReason = `${what} — auto-resuming`; broadcast();
      // Same reason as the daily cap above: Meta's retry-after is minutes, not
      // seconds, and a Stop must not wait it out.
      await sleepUntil(Date.now() + result.retryAfter);
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue; // retry same contact
    } else if (!scheduleRetry(contact, c, result, n, runId)) {
      // Not every permanent code arrives with result.skip set — Meta can return
      // one as a plain rejection — and a number nothing will ever deliver to has
      // to be switched off whichever branch learns it. No-op for every other code.
      suppressIfPermanent(contact.dialStr, result.errorCode, contact.name, n);
      // Recorded ONLY on the queue row. There is no counter to bump: the row is
      // what the dashboard counts, so a network blip that is about to be retried
      // cannot show up as a failure and a restart cannot forget one that is.
      recordRecipientSkipped(runId, contact.dialStr, 'failed', result.errorCode);
      S.failLog.push({ time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), phone: contact.dialStr, name: contact.name, error: result.error, code: result.errorCode, hint: result.hint, attempts: (c.attempts || 0) + 1 });
      if (S.failLog.length > 50) S.failLog.shift();
      log('error', `${n} failed [${result.errorCode}] ${result.error}`);
      if (result.hint) log('error', `   ↳ ${result.hint}`);
    }
    saveCampaign();   // debounced — only pacing state; the queue is already on disk
    broadcast();
    if (!flags.pauseFlag && !flags.stopFlag && nextPending(runId)) {
      await sleep(S.config.delaySec * 1000);
    }
  }
  flags.running = false;
}

// ── Restart recovery ───────────────────────────────────────────────────────────
// A campaign interrupted mid-flight resumes on its own, and the point it
// resumes at is a QUERY over what was actually sent — not a counter that a
// crash can leave ahead of reality. The recipient row is stamped before the
// message row, so the worst case is a row still marked pending for a send that
// did go out, which costs one duplicate message. The old failure mode was the
// opposite and far worse: an index too high silently skipped people, and
// nothing downstream could tell.
//
// The grace period gives the network and Meta's API time to come back first.
// It is a parameter below only so test.js can drive the timer without waiting
// ten real seconds; server.js always takes the default.
const RESUME_GRACE_MS = 10000;

function resumeIfInterrupted({ graceMs = RESUME_GRACE_MS } = {}) {
  const saved = loadCampaign();
  if (!saved) return;
  const p = progressForRun(S.currentRunId);
  // 'waiting' resumes exactly like 'running': the backoff deadline is a column
  // on the queue row, so the wait carries on across the restart by itself — the
  // loop simply re-derives how long is left.
  //
  // 'paused' resumes too, unless the operator is the one who paused it. Every
  // other pause is the loop's own — the daily cap, a rate limit, quiet hours —
  // and each of them re-derives its condition on the next iteration, so
  // resuming costs nothing and NOT resuming was a trap: the run sat at 'paused'
  // with no loop behind it, and 'paused' is in ACTIVE_PHASES, so
  // campaignBlocker() then refused every Start and every CSV upload with "a
  // campaign is paused part-way through" until someone thought to press Stop.
  //
  // A campaign.json written BEFORE this field existed carries no pauseReason at
  // all, and the truthiness check is what makes that case fail closed: the first
  // boot after upgrading must not restart a campaign the operator had paused on
  // purpose, just because the file cannot say who paused it. Every file written
  // from now on carries the field, so this only ever applies once.
  const autoResumable = saved.phase === 'paused'
    && !!saved.pauseReason && saved.pauseReason !== USER_PAUSE;
  if (!(['running', 'waiting'].includes(saved.phase) || autoResumable) || p.pending <= 0) {
    log('info', `Campaign restored — ${p.sent + p.skipped}/${p.total} done, phase ${S.phase}`);
    return;
  }
  // The exact sentence, kept: it is how the timer below knows nobody has acted
  // on the announcement since.
  const graceReason = `Server restarted — resuming ${p.pending} remaining contacts in ${graceMs / 1000}s`;
  S.phase       = 'paused';
  S.pauseReason = graceReason;
  log('warn', `Campaign was interrupted at ${p.sent + p.skipped}/${p.total} — auto-resuming in ${graceMs / 1000}s`);
  setTimeout(() => {
    // Stop, Pause and Reset each change the phase or the reason, and an operator
    // who answers the "resuming in 10s" banner with one of them meant it.
    // Resuming anyway erased the command — startLoop() clears both flags — and
    // sent a campaign the operator had just ended. Nothing resurrects a
    // campaign the operator ended: that rule binds this timer exactly as it
    // binds the webhook ladder. `flags.running` covers anything that already
    // started a loop in the window, so this can never put a second one on the
    // queue.
    if (S.phase !== 'paused' || S.pauseReason !== graceReason || flags.running) return;
    S.phase = 'running'; S.pauseReason = null;
    log('info', `Auto-resumed — ${progressForRun(S.currentRunId).pending} contacts left`);
    broadcast();
    startLoop();
  }, graceMs).unref();
}

// Open a run and stage its queue in one step, so no caller can create one
// without the other. `disabled` rows are written rather than omitted: the skip
// report's whole job is saying who was not messaged and why, and a row that
// was never inserted cannot say anything.
function stageRun(contacts, label = S.config.templateName) {
  // Staging over a run that was itself only staged discards it — otherwise its
  // untouched rows survive as a run nothing points at and the Dashboard's
  // stranded-contacts banner reports people who were never in a campaign.
  // A run the loop has walked at all is kept: that is history.
  discardUnstartedRun(S.currentRunId);
  const runId = startRun(label);
  buildRun(runId, contacts, phone => (isDisabled(phone) ? 'disabled' : null));
  return runId;
}

module.exports = {
  CONTACT_FIELDS, buildParams, missingParams, sendTemplate, stageRun, suppressIfPermanent,
  startLoop, saveCampaign, saveCampaignNow, clearCampaignFile, loadCampaign, resumeIfInterrupted,
  campaignActive, campaignBlocker, scheduleRetry, handleDeliveryFailure, RETRY_BACKOFF_MS,
  RETRY_LADDERS, backoffFor, MAX_RETRIES_TOTAL, ladderPosition,
  USER_PAUSE, RATE_LIMIT_RETRIES, refreshQuality,
};

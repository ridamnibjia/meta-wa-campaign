'use strict';
const { CFG, FILES, QUIET_HOURS } = require('../config');
const { readJSON, writeJSON, debouncedWriter } = require('../lib/store');
const { S, flags, ACTIVE_PHASES, campaignActive, log, sleep } = require('../state');
const { broadcast } = require('./status');
const { isDisabled, disable, markMessaged, getRow } = require('./contacts');
const { W, warmupCap, effectiveCap, markWarmupDay, dailyCount } = require('./warmup');
const { recordOutbound, funnelForRun, startRun, buildRun, nextPending,
        recordRecipientSent, recordRecipientSkipped, recordRecipientRetry,
        requeueFailedRecipient, recipientFor,
        nextRetryForRun, progressForRun } = require('./messages');
const { sanitizeParam, renderBody } = require('./templates');
const { explainError, skipDisposition } = require('../lib/errors');
const { deferPastQuietHours, nextIstMidnight } = require('../lib/schedule');
const { graphHeaders } = require('./graph');
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

    const res = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${CFG.phoneNumberId}/messages`,
      { method: 'POST', headers: graphHeaders(), body: JSON.stringify(body) }
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
    // Skippable: opted out, ecosystem health, re-engagement window
    const hint = explainError(code) || explainError(subcode);
    if ([131026, 131047, 131049, 131051].includes(code) ||
        [131026, 131047, 131049, 131051].includes(subcode)) {
      return { ok: false, skip: true, error: msg, errorCode: code, hint };
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
    return { ok: false, error: `Could not send: ${e.message}`, errorCode: -1,
             hint: 'Network problem on the machine running this server, or the header file could not be uploaded to Meta.' };
  }
}

// ── Retrying a failure that was about the moment ───────────────────────────────
// One DNS blip while sending to contact #340 used to drop that person from the
// run permanently, and the only way to reach them again was re-uploading the CSV
// — which opens a new run and messages everyone a second time. That is the leak
// this closes.
//
// Five waits, so six attempts in total: the original send, then one every three
// hours. Any deadline landing in the night is pushed to 08:00 IST by
// deferPastQuietHours, so the ladder is 15 hours of send time spread over at
// most about a day.
//
// It was three waits — 1h, 2h, 4h — and that was too short for the failure it
// mostly absorbs. 131049 is Meta's per-user marketing cap: a ROLLING per-person
// window counted across every business that messages that person, not a counter
// that resets. Seven hours of retries closed runs with hundreds still owed a
// message, and the only way to reach them was re-uploading the CSV — which
// opens a new run and messages everyone a second time.
//
// It is not longer than five because no ladder reaches zero on 131049: the cap
// belongs to the recipient, not to the attempt. Reaching those people reliably
// means the 24-hour service window — a template that invites a reply, then a
// free-form send — which is what services/inbox.js sendMedia exists for.
//
// WHICH failures come back here is lib/errors.js:skipDisposition, not a list
// kept here. A code has to be named 'retry' there to get a second attempt.
const RETRY_BACKOFF_MS = [3, 3, 3, 3, 3].map(h => h * 3600000);

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

// True when the contact was put back in the queue; false when the caller should
// record a terminal skip. `row.attempts` is how many retries this contact has
// already had — the SQL increments it, so it cannot drift.
// `runId` is passed in rather than read from S here, and for the same reason the
// loop captures it before the await: this runs after sendTemplate() has resolved,
// and a /api/reset landing in that window would otherwise park the contact on a
// null run — a row that matches nothing, so the retry is simply lost.
function scheduleRetry(contact, row, result, n, runId = S.currentRunId) {
  if (skipDisposition(result.errorCode) !== 'retry') return false;
  const made = row.attempts || 0;
  if (made >= RETRY_BACKOFF_MS.length) {
    log('warn', `${n} ${contact.name} — still failing after ${made + 1} attempts, reporting it [${result.errorCode}]`);
    return false;
  }
  // Deferred before it is stored, not before it is read: retry_after is both
  // what nextPending compares against and what the "next attempt" sentence shows
  // the operator, so nudging the deadline anywhere else would leave the queue
  // and the screen disagreeing about when this contact is due.
  const at = deferPastQuietHours(Date.now() + RETRY_BACKOFF_MS[made]);
  recordRecipientRetry(runId, contact.dialStr, result.errorCode, at);
  log('warn', `${n} ${contact.name} — ${result.hint || result.error} [${result.errorCode}]. Retry ${made + 1} of ${RETRY_BACKOFF_MS.length} at ${clockIST(at)}`);
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
// disable() writes both the contacts row and the suppressed row, and it is a
// no-op when the contact is already off for the same reason — so a redelivered
// webhook, a replayed envelope and a second run all cost nothing. The
// suppression outlives the contacts row on purpose: re-uploading the CSV brings
// the person back already switched off.
//
// Returns true only on the transition, so the caller logs once.
function suppressIfPermanent(dialStr, code, name = null, prefix = '') {
  if (skipDisposition(code) !== 'permanent') return false;
  if (!disable(dialStr, 'failed_hard', name)) return false;
  log('warn', `${prefix} ${name || '+' + dialStr} switched off — Meta reports this number as undeliverable (usually: not on WhatsApp), so no later run will try it`.trim());
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
// This runs on the webhook thread, never inside the loop, and it deliberately
// does not interrupt anything: it only edits the queue row. A campaign still
// sending walks past the row and picks it up when the deadline comes due; a
// campaign that already finished is restarted below. Either way the contacts
// still un-messaged are reached first, and the parked failures come after.
//
// Which codes get a second attempt is lib/errors.js:skipDisposition, the same
// whitelist the send-time path uses — a wrong number or a number not on
// WhatsApp is 'permanent' and is switched off rather than retried, because no
// number of attempts changes the answer and each one costs a send slot.
function handleDeliveryFailure({ waId, runId, wamid, code }) {
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

  const made = row.attempts || 0;
  if (made >= RETRY_BACKOFF_MS.length) {
    // Six attempts over about fifteen hours. The cap belongs to the recipient,
    // not to the attempt, so there is no ladder length that zeroes it — see the
    // note above RETRY_BACKOFF_MS. They stay in `failed` and the run closes.
    log('warn', `+${waId} — still not delivered after ${made + 1} attempts, giving up [${code}]`);
    return 'exhausted';
  }
  const at = deferPastQuietHours(Date.now() + RETRY_BACKOFF_MS[made]);
  if (!requeueFailedRecipient(runId, waId, wamid, code, at)) return 'stale';
  log('warn', `+${waId} — back on the queue, retry ${made + 1} of ${RETRY_BACKOFF_MS.length} at ${clockIST(at)}`);

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
  campaignLoop().catch(e => { log("error", "Loop: " + e.message); flags.running = false; });
}

async function campaignLoop() {
  log('info', `Campaign started — ${progressForRun(S.currentRunId).pending} contacts queued`);
  // Which contact the rate-limit branch is currently sleeping off, and how many
  // times in a row it has done so. Loop-local rather than on S: it is about this
  // walk of the queue and means nothing across a restart, and the durable answer
  // — the ladder — is a column on the row.
  let rateLimited = { phone: null, n: 0 };
  while (true) {
    // The phase is only set here if nobody has already set it. /stop and /reset
    // say 'idle' the moment they are called, and overwriting that with 'done' a
    // second later told the operator "Finished" about a run they stopped.
    if (flags.stopFlag)  { log('info', 'Stopped'); if (S.phase !== 'idle') S.phase = 'done'; saveCampaignNow(); broadcast(); break; }
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
    const cap   = effectiveCap();
    const today = dailyCount();
    if (cap !== null && today >= cap) {
      const nextMidnight = nextIstMidnight();
      const wait = nextMidnight - Date.now();
      const h = Math.floor(wait / 3600000), m = Math.floor((wait % 3600000) / 60000);
      const w = warmupCap();
      const why = w !== null && w === cap
        ? `Warm-up ceiling for day ${W.days.length}` : 'Daily cap';
      log('info', `${why} ${today}/${cap} — resuming in ${h}h ${m}m`);
      S.phase = 'paused'; S.pauseReason = `${why} reached (${cap}/day). Resumes in ${h}h ${m}m.`; broadcast();
      // sleepUntil, not sleep: this wait is up to a full day. A bare sleep here
      // meant a Stop set stopFlag that nothing read until tomorrow — and since
      // `flags.running` stays true until the loop exits, campaignBlocker()
      // refused every Start and every CSV upload for those hours with "still
      // stopping, try again in a second".
      await sleepUntil(nextMidnight);
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
    const n = `[${p.sent + p.skipped + 1}/${p.total}]`;

    // Re-checked here, not only at run build: a customer can tap "Stop
    // promotions" while the run this row belongs to is halfway through it.
    if (isDisabled(contact.dialStr)) {
      // The reason is worth saying out loud: "opted out" and "Meta says this
      // number is undeliverable" are the same skip to the loop and completely
      // different problems to the operator.
      const why = getRow(contact.dialStr)?.disabled_reason || 'disabled';
      recordRecipientSkipped(runId, contact.dialStr, 'disabled', null);
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
    const gate = QUIET_HOURS ? deferPastQuietHours(Date.now()) : 0;
    if (gate > Date.now()) {
      S.phase = 'paused';
      S.pauseReason = `Quiet hours — sending pauses 23:00–07:00 IST and resumes at ${clockIST(gate)}.`;
      log('info', S.pauseReason);
      saveCampaignNow(); broadcast();
      await sleepUntil(gate);
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
      // Re-read rather than `today + 1`: the message row is already written, and
      // asking the queue again is what keeps this line and the cap check reading
      // the same number even when a failure webhook landed mid-send.
      log('success', `${n} accepted — today:${dailyCount()}/${cap ?? 'no cap'}`);
    } else if (result.skip) {
      // A property of the NUMBER, not of the attempt: not on WhatsApp, or
      // blocked by Meta on quality grounds. Retrying it is never right, and left
      // enabled it burns a send slot on every run, forever. The other skippable
      // codes are about the moment, so they change nothing.
      suppressIfPermanent(contact.dialStr, result.errorCode, contact.name, n);
      // 131049 lands here: the per-person marketing cap is about the moment, so
      // it goes back on the queue rather than out of the run.
      if (!scheduleRetry(contact, c, result, n, runId)) {
        recordRecipientSkipped(runId, contact.dialStr, 'skipped', result.errorCode);
        log('warn', `${n} skipped — ${result.hint || result.error} [${result.errorCode}]`);
      }
    } else if (result.rateLimit && rateLimited.n < RATE_LIMIT_RETRIES) {
      // Counted per contact — the reset above guarantees this counter is about
      // the contact in hand. A limit that clears after one wait is a burst and
      // costs nobody anything; this branch re-sends the SAME contact with no
      // counter, so a limit the account is genuinely sitting against parked the
      // whole campaign on one number. Past the ceiling this condition is false
      // and the row falls through to scheduleRetry below — 130429 / 80007 / 4
      // are all in skipDisposition's RETRY set, so the ladder takes them.
      rateLimited = { phone: contact.dialStr, n: rateLimited.n + 1 };
      log('warn', `Rate limit — backing off ${Math.round(result.retryAfter / 1000)}s (${rateLimited.n} of ${RATE_LIMIT_RETRIES}). ${result.hint || result.error} [${result.errorCode}]`);
      S.phase = 'paused'; S.pauseReason = 'Rate limit — auto-resuming'; broadcast();
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
const RESUME_GRACE_MS = 10000;

function resumeIfInterrupted() {
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
  S.phase       = 'paused';
  S.pauseReason = `Server restarted — resuming ${p.pending} remaining contacts in ${RESUME_GRACE_MS / 1000}s`;
  log('warn', `Campaign was interrupted at ${p.sent + p.skipped}/${p.total} — auto-resuming in ${RESUME_GRACE_MS / 1000}s`);
  setTimeout(() => {
    S.phase = 'running'; S.pauseReason = null;
    log('info', `Auto-resumed — ${progressForRun(S.currentRunId).pending} contacts left`);
    broadcast();
    startLoop();
  }, RESUME_GRACE_MS).unref();
}

// Open a run and stage its queue in one step, so no caller can create one
// without the other. `disabled` rows are written rather than omitted: the skip
// report's whole job is saying who was not messaged and why, and a row that
// was never inserted cannot say anything.
function stageRun(contacts, label = S.config.templateName) {
  const runId = startRun(label);
  buildRun(runId, contacts, phone => (isDisabled(phone) ? 'disabled' : null));
  return runId;
}

module.exports = {
  CONTACT_FIELDS, buildParams, missingParams, sendTemplate, stageRun, suppressIfPermanent,
  startLoop, saveCampaign, saveCampaignNow, clearCampaignFile, loadCampaign, resumeIfInterrupted,
  campaignActive, campaignBlocker, scheduleRetry, handleDeliveryFailure, RETRY_BACKOFF_MS,
  USER_PAUSE, RATE_LIMIT_RETRIES,
};

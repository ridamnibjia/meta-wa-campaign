'use strict';
const { CFG, FILES } = require('../config');
const { readJSON, writeJSON, debouncedWriter } = require('../lib/store');
const { S, flags, log, sleep, todayKey, checkDaily } = require('../state');
const { broadcast } = require('./status');
const { isDisabled, disable, markMessaged, getRow } = require('./contacts');
const { W, warmupCap, effectiveCap, markWarmupDay } = require('./warmup');
const { recordOutbound, countsForRun, startRun, buildRun, nextPending,
        recordRecipientSent, recordRecipientSkipped, recordRecipientRetry,
        nextRetryForRun, progressForRun } = require('./messages');
const { sanitizeParam, renderBody } = require('./templates');
const { explainError, skipDisposition } = require('../lib/errors');
const { deferPastQuietHours } = require('../lib/schedule');
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
const snapshot = () => ({
  phase:        S.phase,
  dailyCount:   S.dailyCount,
  dailyDate:    S.dailyDate,
  config:       S.config,
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
  Object.assign(S, {
    phase:        d.phase        || 'idle',
    dailyCount:   d.dailyCount   || 0,
    dailyDate:    d.dailyDate    || null,
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

const clockIST = ms => new Date(ms).toLocaleTimeString('en-IN',
  { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

// True when the contact was put back in the queue; false when the caller should
// record a terminal skip. `row.attempts` is how many retries this contact has
// already had — the SQL increments it, so it cannot drift.
function scheduleRetry(contact, row, result, n) {
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
  recordRecipientRetry(S.currentRunId, contact.dialStr, result.errorCode, at);
  log('warn', `${n} ${contact.name} — ${result.hint || result.error} [${result.errorCode}]. Retry ${made + 1} of ${RETRY_BACKOFF_MS.length} at ${clockIST(at)}`);
  return true;
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
// they are allowed to differ. Renaming this one to match the label silently
// changes what campaignBlocker() refuses and what resumeIfInterrupted() picks
// back up, which is how the two-loops-on-one-queue double send got in before.
const ACTIVE_PHASES = ['running', 'waiting', 'paused'];
const campaignActive = () => flags.running || ACTIVE_PHASES.includes(S.phase);

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
      const counts = countsForRun(S.currentRunId);
      const p = progressForRun(S.currentRunId);
      log('info', `Done — accepted:${counts.accepted} failed:${S.failed} skipped:${p.skipped}`);
      S.phase = 'done'; saveCampaignNow(); broadcast(); break;
    }
    checkDaily();
    const cap = effectiveCap();
    if (S.dailyCount >= cap) {
      // Compute ms until 00:02 IST regardless of the server's TZ.
      // IST is UTC+05:30, so offset the current UTC time by +5.5h to get
      // "IST wall-clock" as a Date, ceil to the next midnight, then undo.
      const IST_OFFSET_MS = 5.5 * 3600000;
      const nowMs = Date.now();
      const istNow = new Date(nowMs + IST_OFFSET_MS);
      istNow.setUTCHours(0, 2, 0, 0);                  // midnight IST + 2m in UTC terms
      istNow.setUTCDate(istNow.getUTCDate() + 1);       // next occurrence
      const nextIstMidnight = istNow.getTime() - IST_OFFSET_MS;
      const wait = nextIstMidnight - nowMs;
      const h = Math.floor(wait / 3600000), m = Math.floor((wait % 3600000) / 60000);
      const why = warmupCap() !== null && warmupCap() <= S.config.dailyCap
        ? `Warm-up ceiling for day ${W.days.length}` : 'Daily cap';
      log('info', `${why} ${S.dailyCount}/${cap} — resuming in ${h}h ${m}m`);
      S.phase = 'paused'; S.pauseReason = `${why} reached (${cap}/day). Resumes in ${h}h ${m}m.`; broadcast();
      // sleepUntil, not sleep: this wait is up to a full day. A bare sleep here
      // meant a Stop set stopFlag that nothing read until tomorrow — and since
      // `flags.running` stays true until the loop exits, campaignBlocker()
      // refused every Start and every CSV upload for those hours with "still
      // stopping, try again in a second".
      await sleepUntil(nextIstMidnight);
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue;
    }
    // A contact is { name, dialStr } to everything below; run_recipients stores
    // the same two fields under SQL names.
    const contact = { name: c.name, dialStr: c.phone };
    const p = progressForRun(S.currentRunId);
    const n = `[${p.sent + p.skipped + 1}/${p.total}]`;

    // Re-checked here, not only at run build: a customer can tap "Stop
    // promotions" while the run this row belongs to is halfway through it.
    if (isDisabled(contact.dialStr)) {
      // The reason is worth saying out loud: "opted out" and "Meta says this
      // number is undeliverable" are the same skip to the loop and completely
      // different problems to the operator.
      const why = getRow(contact.dialStr)?.disabled_reason || 'disabled';
      recordRecipientSkipped(S.currentRunId, contact.dialStr, 'disabled', null);
      log('warn', `${n} skipped — ${contact.name} is disabled (${why})`);
      saveCampaign();
      broadcast();
      continue;   // no delay: nothing was sent
    }
    log('info', `${n} ${contact.name} +${contact.dialStr}`);
    const result = await sendTemplate(contact);
    if (result.ok) {
      S.dailyCount++;
      markWarmupDay();
      markMessaged(contact.dialStr);
      // The recipient row is stamped BEFORE the message row. If the process
      // dies between them the worst case is a message with no queue entry —
      // visible in the thread, counted by countsForRun. The other order would
      // leave a sent message the queue still considers pending, and the resume
      // would message that person twice.
      recordRecipientSent(S.currentRunId, contact.dialStr, result.messageId);
      recordOutbound({ wamid: result.messageId, waId: contact.dialStr, name: contact.name,
                       body: renderBody(S.config.templateBody, result.params)
                             ?? `[template: ${S.config.templateName}]`,
                       runId: S.currentRunId });
      log('success', `${n} accepted — today:${S.dailyCount}/${cap}`);
    } else if (result.skip) {
      // 131026 is a property of the NUMBER, not of the attempt: not on
      // WhatsApp, or blocked by Meta on quality grounds. Retrying it is never
      // right, and left enabled it burns a send slot on every run, forever.
      // The other skippable codes are about the moment, so they change nothing.
      if (result.errorCode === 131026 && disable(contact.dialStr, 'failed_hard', contact.name)) {
        log('warn', `${n} ${contact.name} disabled — Meta reports this number as undeliverable, so later runs will not retry it`);
      }
      // 131049 lands here: the per-person marketing cap is about the moment, so
      // it goes back on the queue rather than out of the run.
      if (!scheduleRetry(contact, c, result, n)) {
        recordRecipientSkipped(S.currentRunId, contact.dialStr, 'skipped', result.errorCode);
        log('warn', `${n} skipped — ${result.hint || result.error} [${result.errorCode}]`);
      }
    } else if (result.rateLimit) {
      log('warn', `Rate limit — backing off ${Math.round(result.retryAfter / 1000)}s. ${result.hint || result.error} [${result.errorCode}]`);
      S.phase = 'paused'; S.pauseReason = 'Rate limit — auto-resuming'; broadcast();
      // Same reason as the daily cap above: Meta's retry-after is minutes, not
      // seconds, and a Stop must not wait it out.
      await sleepUntil(Date.now() + result.retryAfter);
      if (!flags.stopFlag && !flags.pauseFlag) { S.phase = 'running'; S.pauseReason = null; broadcast(); }
      continue; // retry same contact
    } else if (!scheduleRetry(contact, c, result, n)) {
      // Only counted as failed once the ladder is exhausted or the code was
      // never retryable. A network blip that is about to be retried is not a
      // failed send, and counting it as one would put a number on the dashboard
      // that the queue disagrees with.
      S.failed++;
      // Recorded on the queue row too, so this person appears in the skip
      // report rather than only in a 50-entry ring buffer that /api/start wipes.
      recordRecipientSkipped(S.currentRunId, contact.dialStr, 'failed', result.errorCode);
      S.failLog.push({ time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), phone: contact.dialStr, name: contact.name, error: result.error, code: result.errorCode, hint: result.hint, attempts: (c.attempts || 0) + 1 });
      if (S.failLog.length > 50) S.failLog.shift();
      log('error', `${n} failed [${result.errorCode}] ${result.error}`);
      if (result.hint) log('error', `   ↳ ${result.hint}`);
    }
    saveCampaign();   // debounced — only pacing state; the queue is already on disk
    broadcast();
    if (!flags.pauseFlag && !flags.stopFlag && nextPending(S.currentRunId)) {
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
  if (!['running', 'waiting'].includes(saved.phase) || p.pending <= 0) {
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
  CONTACT_FIELDS, buildParams, missingParams, sendTemplate, stageRun,
  startLoop, saveCampaign, saveCampaignNow, clearCampaignFile, loadCampaign, resumeIfInterrupted,
  campaignActive, campaignBlocker, scheduleRetry, RETRY_BACKOFF_MS,
};

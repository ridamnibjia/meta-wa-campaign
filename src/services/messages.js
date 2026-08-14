'use strict';
const { db } = require('../lib/db');
const { S, flags, log } = require('../state');
const { explainError } = require('../lib/errors');

// An unknown ID means a message this server never sent — traffic from another
// tool on the same number, or a status for a message from before the SQL store.
// Log it rather than swallow it.
function onUnknownStatus(status) {
  log('warn', `status "${status.status}" for unknown message ${status.id} — ignored`);
}

// Meta redelivers statuses and does not promise order, so a `delivered` can land
// after its own `read`. Ranking them means a message only ever moves forward.
// A `read` with no preceding `delivered` still counts as delivered — you cannot
// read what was never delivered — which is why `delivered` below is a rank
// comparison rather than a string equality.
const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };

// The guard lives in the WHERE clause, so an out-of-order redelivery is handled
// by the database rather than by read-then-branch bookkeeping in JS.
// 'failed' ranks 4 — above every value an incoming status can carry — because
// it is terminal. Meta gives a retried send a new wamid, so a `delivered` that
// arrives after a `failed` for the SAME wamid is always a stale redelivery of
// an earlier event, never a real recovery.
const advance = db.prepare(`
  UPDATE messages
     SET status = ?, status_at = ?
   WHERE wamid = ?
     AND (status IS NULL OR ? > CASE status
            WHEN 'accepted' THEN 0 WHEN 'sent' THEN 1
            WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
            WHEN 'failed' THEN 4 ELSE -1 END)
`);

const markFailed = db.prepare(`
  UPDATE messages SET status = 'failed', status_at = ?, error_code = ?, error_title = ?
   WHERE wamid = ?
`);

const exists = db.prepare('SELECT wa_id, status FROM messages WHERE wamid = ?');

function applyStatus(status) {
  const id = status.id;
  const st = status.status;
  const row = exists.get(id);
  if (!row) return onUnknownStatus(status);

  const now = Date.now();

  if (st === 'failed') {
    const code  = status.errors?.[0]?.code ?? null;
    const title = status.errors?.[0]?.title ?? null;
    const hint  = explainError(code);
    // markFailed always runs — a later failure webhook can carry a better
    // error code/title than an earlier one — but failLog and the operator log
    // are gated on the transition INTO 'failed'. Meta redelivers, and unlike
    // `advance` this path has no rank guard, so without this check every
    // redelivery of the same failure pushed another failLog entry; failLog is
    // capped at 50, so a handful of redelivered duplicates could evict every
    // genuinely distinct failure from the operator's view (F6).
    const alreadyFailed = row.status === 'failed';
    markFailed.run(now, code, title, id);
    if (!alreadyFailed) {
      S.failLog.push({ time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), phone: row.wa_id, error: title, code, hint, source: 'webhook' });
      if (S.failLog.length > 50) S.failLog.shift();
      log('warn', `delivery failed — +${row.wa_id} [${code}] ${title || ''}`);
      if (hint) log('warn', `   ↳ ${hint}`);
    }
    return;
  }

  const rank = STATUS_RANK[st];
  if (rank === undefined) return;          // a status value this app does not model
  advance.run(st, now, id, rank);
}

// Counters are derived, not incremented. This removes the drift class of bug
// entirely: there is no number that can disagree with the messages it counts.
const runCounts = db.prepare(`
  SELECT count(*)                                                     AS accepted,
         sum(CASE WHEN status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,
         sum(CASE WHEN status = 'read'   THEN 1 ELSE 0 END)           AS read,
         sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)           AS failed
    FROM messages
   WHERE dir = 'out' AND run_id IS ?
`);

const ZERO_COUNTS = { accepted: 0, delivered: 0, read: 0, failed: 0 };

function countsForRun(runId) {
  // run_id IS NULL is not "no current campaign" in the messages table — it is
  // the bucket inbox replies (services/inbox.js) and migrated legacy rows
  // (services/migrate.js) deliberately land in, by design. Querying it for a
  // null run would report every inbox reply and migrated row as if it were
  // the current campaign's traffic — a self-hoster who just migrated sees a
  // campaign that looks already run, and a resumed campaign with a forgotten
  // run id would bill free-form replies at the template rate (F1). "No
  // current run" means zero, full stop.
  if (runId == null) return { ...ZERO_COUNTS };
  const r = runCounts.get(runId);
  return {
    accepted:  r.accepted  || 0,
    delivered: r.delivered || 0,
    read:      r.read      || 0,
    failed:    r.failed    || 0,
  };
}

// ── The durability boundary ────────────────────────────────────────────────────
// Meta's Cloud API is webhook-push only: there is no endpoint that returns past
// messages. A batch lost between the 200 OK and the disk is lost permanently,
// so the raw envelope is written first and the ACK depends on it. An un-ACKed
// webhook is one Meta redelivers, which is a problem that fixes itself.
const insertEvent = db.prepare('INSERT INTO webhook_events (received_at, body) VALUES (?, ?)');
const stampEvent  = db.prepare('UPDATE webhook_events SET processed_at = ? WHERE id = ?');
const countUnprocessed = db.prepare('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL');

// Throws on failure by design. The route turns that throw into a 500.
function recordEnvelope(rawText) {
  return Number(insertEvent.run(Date.now(), rawText).lastInsertRowid);
}

function markEnvelopeProcessed(id) {
  stampEvent.run(Date.now(), id);
}

// Nothing in this app replays webhook_events yet — this is the only signal
// that it needs to. Surfaced on /health (F5) rather than left to a log line in
// the 500-entry ring buffer that /api/start wipes.
function unprocessedWebhookCount() {
  return countUnprocessed.get().n;
}

// ── Campaign runs ──────────────────────────────────────────────────────────────
// A reset starts a new run; it never deletes. The five counter integers this
// replaces used to be zeroed on /start, which was harmless when the message
// index was throwaway bookkeeping and would now mean deleting history.
const insertRun = db.prepare(`
  INSERT INTO campaign_runs (started_at, label, template_body, template_lang, header_asset)
  VALUES (?, ?, ?, ?, ?)
`);

// One argument on purpose. Three of the four call sites (CSV upload, reset,
// crash resume) have no template body in hand and would have to invent one for
// an object signature — but all four already read the label out of S.config, so
// reading the body from there too adds no coupling that was not already here.
// If the body is stale at one of those sites, so is the name: they fail
// together or not at all, which is the honest outcome.
//
// ?? null on every bind is required: node:sqlite throws on an undefined bind,
// and a campaign.json saved before this change carries no headerAssetId.
function startRun(label) {
  const id = Number(insertRun.run(
    Date.now(),
    label ?? null,
    S.config.templateBody     ?? null,
    S.config.templateLanguage ?? null,
    S.config.headerAssetId    ?? null,
  ).lastInsertRowid);
  S.currentRunId = id;
  return id;
}

// The single outbound write path. Both the campaign loop and the test-send
// route call this, which is what ends the two-parallel-stores problem — and it
// is why a thread now shows the template that opened the conversation.
const insertOut = db.prepare(`
  INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status, run_id)
  VALUES (?, ?, 'out', ?, ?, ?, 'accepted', ?)
`);

// last_inbound_at is untouched: an outbound message does not open the customer
// service window, and unread counts inbound only.
const upsertOutThread = db.prepare(`
  INSERT INTO threads (wa_id, name, unread, last_inbound_at, last_at)
  VALUES (?, ?, 0, 0, ?)
  ON CONFLICT(wa_id) DO UPDATE SET
    name    = COALESCE(NULLIF(excluded.name, threads.wa_id), threads.name),
    last_at = max(threads.last_at, excluded.last_at)
`);

function recordOutbound({ wamid, waId, name, type = 'template', body = null, at = Date.now(), runId = null }) {
  db.exec('BEGIN');
  try {
    insertOut.run(wamid, waId, type, body, at, runId);
    upsertOutThread.run(waId, name || waId, at);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── The send queue ─────────────────────────────────────────────────────────────
// Written when a CSV is uploaded, walked when the campaign runs. The resume
// point is a query, never a saved integer: a counter that a crash leaves ahead
// of reality silently skips people, and this is the shape that cannot.
const insertRecipient = db.prepare(`
  INSERT OR REPLACE INTO run_recipients (run_id, phone, name, seq, skipped_reason, error_code)
  VALUES (?, ?, ?, ?, ?, NULL)
`);

// LIMIT 1, ORDER BY seq, on the partial index. The loop asks this once per
// message rather than holding the list in memory.
//
// A 'retry' row whose retry_after has passed is pending again — that is the
// whole retry feature, expressed as a widening of this WHERE rather than as a
// second queue the loop would have to merge. `attempts` comes back with it so
// the caller can decide whether this is the last go.
//
// The two `?` for the clock are the same value bound twice: node:sqlite binds
// anonymous placeholders strictly by position and throws if you mix in ?2.
const nextPendingQ = db.prepare(`
  SELECT phone, name, seq, attempts, retry_after FROM run_recipients
   WHERE run_id = ? AND wamid IS NULL
     AND (skipped_reason IS NULL OR (skipped_reason = 'retry' AND retry_after <= ?))
   ORDER BY seq LIMIT 1
`);

// The soonest a row waiting on backoff becomes sendable, or null when none are.
// This is what tells a drained-but-not-finished run to wait rather than declare
// itself done.
const nextRetryAtQ = db.prepare(`
  SELECT min(retry_after) AS at, count(*) AS n FROM run_recipients
   WHERE run_id = ? AND wamid IS NULL AND skipped_reason = 'retry'
`);

// skipped_reason and retry_after are cleared on success: a row that failed
// once, waited, and then went out is a SENT row, not a sent-and-also-retrying
// one. Leaving them set would double-count it in every progress query below.
const markSent = db.prepare(`
  UPDATE run_recipients
     SET wamid = ?, attempted_at = ?, skipped_reason = NULL, error_code = NULL, retry_after = NULL
   WHERE run_id = ? AND phone = ?
`);
// retry_after is cleared here too — a permanently skipped row must never look
// pending again, whatever it was waiting for before.
const markSkipped = db.prepare(`
  UPDATE run_recipients
     SET skipped_reason = ?, error_code = ?, attempted_at = ?, retry_after = NULL
   WHERE run_id = ? AND phone = ?
`);
// attempts is incremented in SQL rather than read-modify-written in JS: the row
// is the only place the count lives, and a crash between the read and the write
// would otherwise hand the contact a free extra attempt on every restart.
const markRetry = db.prepare(`
  UPDATE run_recipients
     SET skipped_reason = 'retry', error_code = ?, attempted_at = ?,
         retry_after = ?, attempts = attempts + 1
   WHERE run_id = ? AND phone = ?
`);

// `disabled` is broken out from `skipped` because it is the only skip that
// costs nothing and was known in advance: pricing subtracts it to get the
// billable count, and the operator reads it as "these people are on your list
// but switched off" rather than "these sends failed".
//
// 'retry' is counted apart from every other skipped_reason and NOT as skipped:
// a row waiting on backoff has not been given up on, it is queued for later.
// Folding it into `skipped` would make a run with people still to message
// report itself as finished — which is exactly the leak the retry ladder exists
// to close.
const progressQ = db.prepare(`
  SELECT count(*)                                                    AS total,
         sum(CASE WHEN wamid IS NOT NULL THEN 1 ELSE 0 END)          AS sent,
         sum(CASE WHEN skipped_reason IS NOT NULL
                   AND skipped_reason <> 'retry' THEN 1 ELSE 0 END)  AS skipped,
         sum(CASE WHEN skipped_reason = 'disabled' THEN 1 ELSE 0 END) AS disabled,
         sum(CASE WHEN wamid IS NULL
                   AND skipped_reason = 'retry' THEN 1 ELSE 0 END)   AS retrying
    FROM run_recipients WHERE run_id = ?
`);

// What this run will actually cost, asked against the CURRENT enabled flags
// rather than against the snapshot taken when the queue was staged. Disabling
// someone mid-run stops them being messaged — the loop re-checks — but without
// this join the estimate went on including them until the loop got that far,
// and an operator who has just disabled a contact reasonably expects the number
// to move.
//
// A row that already went out is counted whatever happened to the contact
// afterwards: that message was sent and will be billed. A row skipped for any
// reason cost nothing and is not — but a row waiting on a retry is still going
// to be attempted, so it is billable exactly like an untouched one.
const billableQ = db.prepare(`
  SELECT count(*) AS n
    FROM run_recipients r
    LEFT JOIN contacts c ON c.phone = r.phone
   WHERE r.run_id = ?
     AND ( r.wamid IS NOT NULL
        OR ((r.skipped_reason IS NULL OR r.skipped_reason = 'retry')
             AND COALESCE(c.enabled, 1) = 1) )
`);

// attempts and retry_after travel with the report: "we tried this person three
// times and Meta said the same thing each time" is a different sentence to "we
// tried once", and the operator is the one who has to act on the difference.
const skippedQ = db.prepare(`
  SELECT phone, name, skipped_reason, error_code, attempted_at, attempts, retry_after
    FROM run_recipients
   WHERE run_id = ? AND skipped_reason IS NOT NULL
   ORDER BY seq
`);

const recipientsQ = db.prepare(
  `SELECT phone, name, seq, wamid, skipped_reason, error_code, attempts, retry_after
     FROM run_recipients WHERE run_id = ? ORDER BY seq`);

// Building a run twice for the same id replaces it: /upload-csv opens a fresh
// run for every upload, so this only ever fires if a caller reuses one.
const clearRun = db.prepare('DELETE FROM run_recipients WHERE run_id = ?');

// `disabledFor` is passed in rather than imported, because services/messages.js
// has no business knowing why a contact is off — services/campaign.js supplies
// the predicate from services/contacts.js. A disabled contact is recorded as a
// SKIPPED ROW, not omitted: "we did not message these 40 people, and here is
// why" is the report, and a row that was never written cannot say anything.
function buildRun(runId, contacts, disabledFor = () => null) {
  db.exec('BEGIN');
  try {
    clearRun.run(runId);
    let seq = 0;
    for (const c of contacts) {
      insertRecipient.run(runId, c.dialStr, c.name || c.dialStr, seq++,
        disabledFor(c.dialStr) ? 'disabled' : null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return progressForRun(runId);
}

// `now` is a parameter rather than a Date.now() inside the query so a test can
// ask "what is pending at 9pm" without waiting until 9pm.
const nextPending = (runId, now = Date.now()) =>
  (runId == null ? null : nextPendingQ.get(runId, now) || null);

const recordRecipientSent = (runId, phone, wamid) =>
  markSent.run(wamid, Date.now(), runId, phone);

const recordRecipientSkipped = (runId, phone, reason, errorCode = null) =>
  markSkipped.run(reason, errorCode, Date.now(), runId, phone);

// Puts a contact back in the queue at a stated time instead of dropping them.
const recordRecipientRetry = (runId, phone, errorCode, retryAfter) =>
  markRetry.run(errorCode, Date.now(), retryAfter, runId, phone);

// { at, count } for the rows waiting on backoff, or null when there are none.
function nextRetryForRun(runId) {
  if (runId == null) return null;
  const r = nextRetryAtQ.get(runId);
  return r && r.n ? { at: r.at, count: r.n } : null;
}

function progressForRun(runId) {
  if (runId == null) return { total: 0, sent: 0, skipped: 0, disabled: 0, retrying: 0, pending: 0 };
  const r = progressQ.get(runId);
  const total = r.total || 0, sent = r.sent || 0, skipped = r.skipped || 0;
  // `pending` therefore includes the rows waiting on backoff. That is the point:
  // the run is not finished while any of them are outstanding.
  return { total, sent, skipped, disabled: r.disabled || 0, retrying: r.retrying || 0,
           pending: total - sent - skipped };
}

const billableForRun  = runId => (runId == null ? 0 : billableQ.get(runId).n || 0);
const skippedForRun   = runId => (runId == null ? [] : skippedQ.all(runId));
const recipientsForRun = runId => (runId == null ? [] : recipientsQ.all(runId));

// ── The last campaign ──────────────────────────────────────────────────────────
// Read from campaign_runs rather than from S.currentRunId, so it still answers
// "what did the last send do" after a Reset has dropped the current run — which
// is precisely when an operator asks. Everything in it is derived; there is no
// stored summary that can disagree with the rows.
const lastRunQ = db.prepare(
  'SELECT id, started_at, label, template_lang FROM campaign_runs ORDER BY id DESC LIMIT 1');

function lastRunSummary() {
  const r = lastRunQ.get();
  if (!r) return null;
  const progress = progressForRun(r.id);
  return {
    id: r.id, label: r.label, startedAt: r.started_at, language: r.template_lang,
    progress, counts: countsForRun(r.id), nextRetry: nextRetryForRun(r.id),
    // "Unfinished" is a property of the queue, not of S.phase: a run with rows
    // still pending is unfinished even if the process died and forgot it.
    unfinished: progress.pending > 0,
  };
}

// ── History ────────────────────────────────────────────────────────────────────
// Everything below is derived. campaign_runs deliberately gains no ended_at and
// no status column: ended-at is the last attempt on the queue, and status is a
// property of what is left in it. A stored ended_at would need writing on the
// normal finish, on Stop, on the ladder exhausting and after a crash-and-resume
// — four places to forget, and a forgotten one shows a campaign that never
// ended. Exactly the rule the counters already follow.
const runsQ = db.prepare(`
  SELECT r.id, r.started_at, r.label, r.template_lang, r.template_body, r.header_asset,
         (SELECT max(attempted_at) FROM run_recipients rr WHERE rr.run_id = r.id) AS ended_at,
         (SELECT count(*)          FROM run_recipients rr WHERE rr.run_id = r.id) AS queued
    FROM campaign_runs r
   ORDER BY r.id DESC
   LIMIT ?
`);

const runRowQ = db.prepare(`
  SELECT r.id, r.started_at, r.label, r.template_lang, r.template_body, r.header_asset,
         (SELECT max(attempted_at) FROM run_recipients rr WHERE rr.run_id = r.id) AS ended_at
    FROM campaign_runs r
   WHERE r.id = ?
`);

// Three words an operator can act on, none of them stored.
//
// ponytail: 'incomplete' cannot tell a campaign the operator stopped from one a
// crash abandoned — both leave pending rows on a run nothing points at. The
// label is honest either way ("Incomplete — 640 of 800 sent") and it costs no
// column. If that distinction ever drives a decision, add a stopped_at written
// by the /stop route alone and leave every other status derived.
function statusForRun(runId, pending) {
  const isCurrent = runId === S.currentRunId;
  if (isCurrent && (flags.running || ACTIVE_PHASES.includes(S.phase))) return 'in-progress';
  return pending > 0 ? 'incomplete' : 'completed';
}

// Duplicated from services/campaign.js rather than imported: services/campaign
// requires this file, and importing it back would be a cycle. Three strings.
const ACTIVE_PHASES = ['running', 'waiting', 'paused'];

// ponytail: LIMIT 100, no cursor. One campaign per CSV upload means a hundred
// rows is a year of history for one business. If it ever needs paging, the
// cursor is (started_at, id) and never started_at alone — timestamps tie.
function listRuns({ limit = 100 } = {}) {
  return runsQ.all(Math.min(Math.max(Number(limit) || 100, 1), 500))
    // A run staged and never started has no recipients. It is noise, not history.
    .filter(r => r.queued > 0)
    .map(r => {
      const progress = progressForRun(r.id);
      return {
        id: r.id, label: r.label, startedAt: r.started_at, endedAt: r.ended_at,
        status: statusForRun(r.id, progress.pending),
        counts: countsForRun(r.id), progress,
      };
    });
}

function runDetail(runId) {
  const id = Number(runId);
  // Null, never a quiet fall back to the current run. A stale bookmark that
  // renders a different campaign reads as an answer, and the operator would act
  // on it — which is strictly worse than a 404.
  if (!Number.isInteger(id) || id <= 0) return null;
  const r = runRowQ.get(id);
  if (!r) return null;

  const progress = progressForRun(id);
  return {
    id: r.id, label: r.label,
    startedAt: r.started_at, endedAt: r.ended_at,
    status: statusForRun(id, progress.pending),
    language: r.template_lang, body: r.template_body, headerAsset: r.header_asset,
    counts: countsForRun(id), progress,
    billable: billableForRun(id), nextRetry: nextRetryForRun(id),
    recipients: recipientsForRun(id),
    // The explanation is attached here rather than in the view, because
    // lib/errors.js is the one table that turns a Meta code into "what happened
    // — what to do" and it lives on this side. A second copy in the browser
    // would be a second thing to update when Meta adds a code.
    skips: skippedForRun(id).map(s => ({ ...s, explanation: explainError(s.error_code) })),
  };
}

module.exports = {
  applyStatus, STATUS_RANK, countsForRun, listRuns, runDetail,
  recordEnvelope, markEnvelopeProcessed, unprocessedWebhookCount,
  startRun, recordOutbound,
  buildRun, nextPending, recordRecipientSent, recordRecipientSkipped,
  recordRecipientRetry, nextRetryForRun, lastRunSummary,
  progressForRun, skippedForRun, recipientsForRun, billableForRun,
};

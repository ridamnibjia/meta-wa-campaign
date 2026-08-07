'use strict';
const { db } = require('../lib/db');
const { S, log } = require('../state');
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
const nextPendingQ = db.prepare(`
  SELECT phone, name, seq FROM run_recipients
   WHERE run_id = ? AND wamid IS NULL AND skipped_reason IS NULL
   ORDER BY seq LIMIT 1
`);

const markSent = db.prepare(
  'UPDATE run_recipients SET wamid = ?, attempted_at = ? WHERE run_id = ? AND phone = ?');
const markSkipped = db.prepare(
  'UPDATE run_recipients SET skipped_reason = ?, error_code = ?, attempted_at = ? WHERE run_id = ? AND phone = ?');

// `disabled` is broken out from `skipped` because it is the only skip that
// costs nothing and was known in advance: pricing subtracts it to get the
// billable count, and the operator reads it as "these people are on your list
// but switched off" rather than "these sends failed".
const progressQ = db.prepare(`
  SELECT count(*)                                                    AS total,
         sum(CASE WHEN wamid IS NOT NULL THEN 1 ELSE 0 END)          AS sent,
         sum(CASE WHEN skipped_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped,
         sum(CASE WHEN skipped_reason = 'disabled' THEN 1 ELSE 0 END) AS disabled
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
// reason cost nothing and is not.
const billableQ = db.prepare(`
  SELECT count(*) AS n
    FROM run_recipients r
    LEFT JOIN contacts c ON c.phone = r.phone
   WHERE r.run_id = ?
     AND ( r.wamid IS NOT NULL
        OR (r.skipped_reason IS NULL AND COALESCE(c.enabled, 1) = 1) )
`);

const skippedQ = db.prepare(`
  SELECT phone, name, skipped_reason, error_code, attempted_at
    FROM run_recipients
   WHERE run_id = ? AND skipped_reason IS NOT NULL
   ORDER BY seq
`);

const recipientsQ = db.prepare(
  'SELECT phone, name, seq, wamid, skipped_reason, error_code FROM run_recipients WHERE run_id = ? ORDER BY seq');

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

const nextPending = runId => (runId == null ? null : nextPendingQ.get(runId) || null);

const recordRecipientSent = (runId, phone, wamid) =>
  markSent.run(wamid, Date.now(), runId, phone);

const recordRecipientSkipped = (runId, phone, reason, errorCode = null) =>
  markSkipped.run(reason, errorCode, Date.now(), runId, phone);

function progressForRun(runId) {
  if (runId == null) return { total: 0, sent: 0, skipped: 0, disabled: 0, pending: 0 };
  const r = progressQ.get(runId);
  const total = r.total || 0, sent = r.sent || 0, skipped = r.skipped || 0;
  return { total, sent, skipped, disabled: r.disabled || 0, pending: total - sent - skipped };
}

const billableForRun  = runId => (runId == null ? 0 : billableQ.get(runId).n || 0);
const skippedForRun   = runId => (runId == null ? [] : skippedQ.all(runId));
const recipientsForRun = runId => (runId == null ? [] : recipientsQ.all(runId));

module.exports = {
  applyStatus, STATUS_RANK, countsForRun,
  recordEnvelope, markEnvelopeProcessed, unprocessedWebhookCount,
  startRun, recordOutbound,
  buildRun, nextPending, recordRecipientSent, recordRecipientSkipped,
  progressForRun, skippedForRun, recipientsForRun, billableForRun,
};

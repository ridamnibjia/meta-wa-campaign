'use strict';
const { db } = require('../lib/db');
const { S, flags, campaignActive, log } = require('../state');
const { explainError, skipDisposition } = require('../lib/errors');

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

// threads.last_at is stamped when the send is ACCEPTED, which is the only moment
// we have — Meta refuses hours later. So a thread whose newest message is one
// nobody received sorted by that message's clock, and since the transcript no
// longer renders it (services/inbox.js:VISIBLE) the inbox showed a thread at the
// top of the list whose preview was older than its own timestamp.
//
// Recomputed from the messages that are still part of the conversation, using
// the same rule the transcript does. COALESCE to last_inbound_at then to 0 for a
// thread whose every outbound was refused and which never replied: dropping to 0
// sorts it to the bottom, which is correct — nothing has happened in it.
const restampThread = db.prepare(`
  UPDATE threads SET last_at = COALESCE(
      (SELECT max(m.at) FROM messages m
        WHERE m.wa_id = threads.wa_id AND NOT (m.dir = 'out' AND m.status IS 'failed')),
      last_inbound_at, 0)
   WHERE wa_id = ?
`);

// run_id travels back with the row because a delivery failure has to be handed
// to the queue it belongs to, and the wamid is the only thing the webhook
// carries — see the `failed` branch below.
const exists = db.prepare('SELECT wa_id, run_id, status FROM messages WHERE wamid = ?');

// Returns a descriptor on the transition INTO 'failed', so the caller can put
// the contact back on the retry ladder; undefined for every other status and
// for a redelivery of a failure already recorded. Meta accepts most sends and
// reports the refusal minutes or hours later over this webhook, so this is the
// path most 131049s actually take — the send-time ladder in services/campaign.js
// never sees them.
function applyStatus(status) {
  const id = status.id;
  const st = status.status;
  const row = exists.get(id);
  if (!row) return onUnknownStatus(status);

  const now = Date.now();

  if (st === 'failed') {
    // A device that has acknowledged delivery cannot un-receive the message.
    // Meta redelivers statuses and promises no order, so a `failed` landing
    // after `delivered`/`read` for the SAME wamid is a stale or contradictory
    // event, never a real refusal — and acting on it walked a contact whose
    // message was on their phone onto the retry ladder, re-sending the same
    // campaign copy every three hours. `advance` already refuses the mirror
    // case (a `delivered` after a `failed`); this is the same rank rule, from
    // the other side. markFailed is unguarded below only for rows that have
    // not reached `delivered`, where a later failure genuinely can carry a
    // better error code than an earlier one.
    if (row.status === 'delivered' || row.status === 'read') {
      log('warn', `stale "failed" for ${id} ignored — already ${row.status}`);
      return;
    }
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
    // The message just left the conversation, so the thread's clock has to stop
    // counting it. Idempotent — it recomputes from the rows rather than adjusting
    // a value — so a redelivered failure webhook costs one UPDATE and changes
    // nothing.
    restampThread.run(row.wa_id);
    if (!alreadyFailed) {
      S.failLog.push({ time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), phone: row.wa_id, error: title, code, hint, source: 'webhook' });
      if (S.failLog.length > 50) S.failLog.shift();
      log('warn', `delivery failed — +${row.wa_id} [${code}] ${title || ''}`);
      if (hint) log('warn', `   ↳ ${hint}`);
    }
    // Gated on the same transition as the log for the same reason: replay and
    // Meta's own redeliveries must not each hand the contact another attempt.
    // Only the descriptor is returned — what to DO about a failure is a
    // campaign decision, and services/messages.js does not import the loop.
    return alreadyFailed ? undefined
      : { failed: true, waId: row.wa_id, runId: row.run_id, wamid: id, code, title };
  }

  const rank = STATUS_RANK[st];
  if (rank === undefined) return;          // a status value this app does not model
  advance.run(st, now, id, rank);
}

// Counters are derived, not incremented. This removes the drift class of bug
// entirely: there is no number that can disagree with the messages it counts.
//
// Counted per CONTACT, not per row. A delivery failure that comes back over the
// webhook puts the contact back on the ladder, and the next attempt writes a
// SECOND outbound row for the same person — so `count(*)` reported six accepted
// on a run of five, and a contact reached on attempt two stayed in `failed`
// forever beside their own `delivered`. The inner query collapses each contact
// to their best outcome, which is also the only reading an operator has: one
// person either heard from us or did not.
//
// 'failed' ranks BELOW every other status rather than above it, the opposite of
// STATUS_RANK. That rank is about one wamid, where a failure is terminal;
// this one is about one person across several attempts, where any attempt that
// landed is the answer.
const runCounts = db.prepare(`
  SELECT count(*)                                        AS accepted,
         sum(CASE WHEN best >= 2 THEN 1 ELSE 0 END)      AS delivered,
         sum(CASE WHEN best  = 3 THEN 1 ELSE 0 END)      AS read,
         sum(CASE WHEN best  < 0 THEN 1 ELSE 0 END)      AS failed
    FROM (
      SELECT max(CASE status
                   WHEN 'read'      THEN 3 WHEN 'delivered' THEN 2
                   WHEN 'sent'      THEN 1 WHEN 'accepted'  THEN 0
                   WHEN 'failed'    THEN -1 ELSE 0 END)  AS best
        FROM messages
       WHERE dir = 'out' AND run_id IS ?
       GROUP BY wa_id
    )
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

// ── What today's sending has actually cost the daily cap ───────────────────────
// Derived, like every other counter in this file, and for a reason an operator
// hit directly: Meta answers most sends with HTTP 200 and a wamid, then decides
// minutes or hours later that it will not deliver — for the recipient's per-user
// marketing cap, or on quality grounds — and says so over the status webhook.
//
// The incremented counter this replaces had already spent that slot and never
// got it back. A day of 800 accepts with 200 later refused reported 800 against
// the cap when only 600 messages existed, so the loop parked for the night with
// a fifth of the day's allowance burnt on messages nobody received. Counting the
// rows instead hands the slot back the instant the failure webhook lands, and
// there is no second number to keep in step with the first.
//
// Counted per CONTACT, not per row, and for two reasons: the retry ladder writes
// a second outbound row for the same person, and Meta's own messaging limit is
// on unique users per day rather than on messages.
//
// A contact counts if ANY of their sends today is not `failed` — the same
// "best outcome per person" rule runCounts uses above.
//
// `type = 'template'` matters: services/inbox.js writes free-form replies here
// too, with type 'text' or a media kind. Those go out inside the 24-hour service
// window, are not marketing, and Meta does not count them against the messaging
// tier this cap exists to stay under — so answering a customer must not spend a
// campaign's allowance. Campaign sends and test sends are the 'template' rows.
const sentSinceQ = db.prepare(`
  SELECT count(*) AS n FROM (
      SELECT wa_id FROM messages
       WHERE dir = 'out' AND type = 'template' AND at >= ?
       GROUP BY wa_id
      HAVING sum(CASE WHEN status = 'failed' THEN 0 ELSE 1 END) > 0
  )
`);

const sentSince = at => sentSinceQ.get(at).n || 0;

// Which IST days this number actually sent on, as 'YYYY-MM-DD'. The warm-up
// ladder counts sending days, and it used to know about them only from
// warmup.json — a file that did not exist before the ladder was written, is not
// in the backup a self-hoster is most likely to take (the database is), and is
// absent on a machine the deployment moved to. Losing it silently restarted a
// mature number at twenty messages a day.
//
// SQLite's date() works on seconds, hence /1000; '+5 hours','+30 minutes' shifts
// UTC to IST, which has no daylight saving so the constant is the whole zone.
// Rows Meta refused are excluded on purpose: a day whose every send was refused
// is not evidence the number sends steadily, which is the only thing the ladder
// is measuring.
// Templates only, for the same reason sentSince filters on them: a day spent
// answering the inbox is not a day this number sent marketing traffic, and the
// ladder is measuring the latter.
const sendingDaysQ = db.prepare(`
  SELECT DISTINCT date(at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS day
    FROM messages
   WHERE dir = 'out' AND type = 'template' AND (status IS NULL OR status <> 'failed')
   ORDER BY day
`);

const sendingDays = () => sendingDaysQ.all().map(r => r.day);

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
  // The picked header is validated against the library before it is bound:
  // node:sqlite enforces the header_asset REFERENCES, so a pick whose row was
  // since deleted would make this INSERT throw "FOREIGN KEY constraint failed"
  // and every CSV upload with it. A tombstoned pick is nulled too — its bytes
  // are gone and every send of it would be refused by name anyway.
  let headerAsset = S.config.headerAssetId ?? null;
  if (headerAsset != null) {
    const a = require('./media').getAsset(headerAsset);
    if (!a || a.deleted_at) headerAsset = S.config.headerAssetId = null;
  }
  const id = Number(insertRun.run(
    Date.now(),
    label ?? null,
    S.config.templateBody     ?? null,
    S.config.templateLanguage ?? null,
    headerAsset,
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

// TWO queries, asked in order, rather than one with a disjunction — and the
// order is the point twice over.
//
// Behaviour: a contact nobody has tried yet comes before a retry that has come
// due. One ORDER BY seq over both could not express that, because a retry row
// keeps the seq it was staged with — so a failure at seq 12 coming due jumped
// ahead of six hundred people the run had never attempted, spending the day's
// cap on second attempts while first attempts waited. Reaching everyone once is
// what a campaign is for; the ladder is what happens afterwards.
//
// Plan: each half is a clean index seek, which the merged version was not. The
// disjunction implied neither index's predicate, so SQLite fell back to the
// primary key plus a temp b-tree sort — a full scan of the run, once per
// message. Split, the first half is exactly idx_run_recipients_pending and the
// second is exactly idx_run_recipients_retry, ORDER BY included. Both are
// asserted on the query plan in test.js.
// skipped_reason and error_code travel with the row: the loop's progress index
// adds one only for an untried row (a due retry is already inside `attempted`
// as `retrying`), and the disabled branch preserves the ladder's last error
// code — neither can work if the column stays behind in the table.
const nextUntriedQ = db.prepare(`
  SELECT phone, name, seq, attempts, retry_after, skipped_reason, error_code FROM run_recipients
   WHERE run_id = ? AND wamid IS NULL AND skipped_reason IS NULL
   ORDER BY seq LIMIT 1
`);

// Ordered by DEADLINE, not by seq: within the ladder the honest queue is "whose
// turn came up first", and idx_run_recipients_retry is (run_id, retry_after) so
// this is the same seek that answers nextRetryAtQ.
const nextDueRetryQ = db.prepare(`
  SELECT phone, name, seq, attempts, retry_after, skipped_reason, error_code FROM run_recipients
   WHERE run_id = ? AND wamid IS NULL AND skipped_reason = 'retry' AND retry_after <= ?
   ORDER BY retry_after LIMIT 1
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

// The same ladder, entered from the other end. Meta accepted the send — so this
// row already carries a wamid and the queue reads it as done — and only failed
// it later, over a webhook. Un-stamping the wamid is what puts the contact back
// in front of nextPending; without it the run closes with them never reached,
// which is the whole bug this closes.
//
// `AND wamid = ?` is the idempotency guard, and it is load-bearing twice over.
// Meta redelivers statuses and the Diagnostics replay button re-runs stored
// envelopes, so this statement must be safe to run again: a second webhook for
// a wamid the row no longer carries matches nothing. It also protects against
// the out-of-order case — a stale failure for attempt two arriving after
// attempt three has already gone out must not un-send attempt three.
const requeueAfterDelivery = db.prepare(`
  UPDATE run_recipients
     SET wamid = NULL, skipped_reason = 'retry', error_code = ?,
         attempted_at = ?, retry_after = ?, attempts = attempts + 1
   WHERE run_id = ? AND phone = ? AND wamid = ?
`);

const recipientQ = db.prepare(
  'SELECT phone, name, seq, wamid, skipped_reason, error_code, attempts, retry_after '
  + 'FROM run_recipients WHERE run_id = ? AND phone = ?');

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

// ── Where every contact in the run actually ended up ───────────────────────────
// progressForRun answers "how far along is this", which is a different question
// to "what happened to my list". An operator reading `failed: 180` next to
// `retrying: 40` cannot tell whether those forty are inside the hundred and
// eighty or beside it, and the honest answer — beside — was nowhere on screen.
//
// Every recipient row lands in exactly ONE bucket here, and the buckets sum to
// `total`. That is the whole contract: if a number is missing from the screen it
// is missing from the sum, and the sum is the CSV. `read` is the one deliberate
// exception — it is a subset of `delivered`, not a bucket beside it, because a
// message that was read was also delivered.
//
// The join is on the wamid the queue row currently CARRIES. A contact the
// webhook ladder put back has no wamid, so they read as retrying rather than as
// the send Meta already refused — which is the correct answer while another
// attempt is still owed to them.
// ONE copy of the rule, interpolated into both the count query and the list
// query below. The count on the card and the names behind it have to be the same
// answer to the same question — an operator who clicks "12 failed" and is shown
// eleven contacts has been told the app is lying, and cannot tell which half.
// A second hand-written CASE is exactly how those two drift apart.
const BUCKET_CASE = `CASE
    -- Never attempted: switched off before the queue was built. Split by WHY,
    -- because "asked us to stop" and "Meta says this number cannot receive
    -- messages" are the same skip to the loop and completely different facts to
    -- the person reading the report.
    WHEN r.skipped_reason = 'disabled' AND c.disabled_reason = 'failed_hard' THEN 'unreachable'
    WHEN r.skipped_reason = 'disabled'                                       THEN 'optedOut'
    WHEN r.skipped_reason = 'retry'                                          THEN 'retrying'
    -- Attempted and given up on: the send-time ladder exhausted, or a code that
    -- was never retryable. Which of the two buckets it belongs to is the error
    -- code's business — bucketOf() below, never a code list repeated in SQL.
    WHEN r.skipped_reason IS NOT NULL                                        THEN 'gaveUp'
    WHEN r.wamid IS NULL                                                     THEN 'pending'
    WHEN m.status = 'failed'                                                 THEN 'gaveUp'
    WHEN m.status = 'read'                                                   THEN 'read'
    WHEN m.status = 'delivered'                                              THEN 'delivered'
    ELSE 'sent'
  END`;

const BUCKET_FROM = `
    FROM run_recipients r
    LEFT JOIN messages m ON m.wamid = r.wamid
    LEFT JOIN contacts c ON c.phone = r.phone
   WHERE r.run_id = ?`;

const funnelQ = db.prepare(`
  SELECT ${BUCKET_CASE}                         AS bucket,
         COALESCE(r.error_code, m.error_code)   AS code,
         count(*)                               AS n
  ${BUCKET_FROM}
   GROUP BY bucket, code
`);

// The half of the rule SQL cannot express, because it is a policy call in
// lib/errors.js rather than a value in a column. Both the aggregate and the
// per-contact list run their raw bucket through this, so neither can decide a
// 131026 differently from the other.
//
// 'read' resolves to 'delivered' here: a message that was read was also
// delivered, so it belongs in that bucket for the purpose of "which list is this
// contact in". The read COUNT is kept separately by funnelForRun.
function bucketOf(raw, code) {
  if (raw === 'read')   return 'delivered';
  if (raw !== 'gaveUp') return raw;
  return skipDisposition(code) === 'permanent' ? 'unreachable' : 'failed';
}

const ZERO_FUNNEL = {
  total: 0, delivered: 0, read: 0, sent: 0, pending: 0,
  retrying: 0, failed: 0, unreachable: 0, optedOut: 0,
};

// `unreachable` is the one an operator asked for by name: contacts nothing will
// ever try again, because Meta reports the number as undeliverable — usually
// "not on WhatsApp". It gathers both halves of that fact: someone disabled by an
// EARLIER run's hard failure and never attempted here, and someone attempted
// here who came back 131026. Which codes count is lib/errors.js:skipDisposition,
// not a list kept twice.
function funnelForRun(runId) {
  const f = { ...ZERO_FUNNEL };
  if (runId == null) return f;
  for (const r of funnelQ.all(runId)) {
    const n = r.n || 0;
    f.total += n;
    // Counted twice on purpose, and only here: read ⊂ delivered, so folding it
    // into the sum as its own bucket would make the buckets miss `total` by
    // exactly the number of people who have read receipts switched on.
    if (r.bucket === 'read') f.read += n;
    f[bucketOf(r.bucket, r.code)] += n;
  }
  return f;
}

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

// The message status is joined in rather than inferred from the queue row. A
// row with a wamid means "Meta accepted this", which the list rendered as
// "sent" — and went on saying it about a contact Meta had since refused to
// deliver to. The join is on the wamid the row currently carries, so a contact
// waiting on the ladder (wamid NULL) matches nothing and reads as retrying.
// `bucket` and `code` come back with every row, from the same CASE the counts
// are made of — so "show me the 12 that failed" filters on the identical rule
// rather than on the view's own re-reading of skipped_reason and status. The old
// version left that re-reading to history.jsx, which is how a list can quietly
// stop matching the number above it.
const recipientsQ = db.prepare(
  `SELECT r.phone, r.name, r.seq, r.wamid, r.skipped_reason, r.error_code,
          r.attempts, r.retry_after, r.attempted_at, m.status,
          m.at AS sent_at, m.status_at,
          ${BUCKET_CASE} AS raw_bucket,
          COALESCE(r.error_code, m.error_code) AS code,
          c.disabled_reason
   ${BUCKET_FROM} ORDER BY r.seq`);

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
  (runId == null ? null
    : nextUntriedQ.get(runId) || nextDueRetryQ.get(runId, now) || null);

const recordRecipientSent = (runId, phone, wamid) =>
  markSent.run(wamid, Date.now(), runId, phone);

const recordRecipientSkipped = (runId, phone, reason, errorCode = null) =>
  markSkipped.run(reason, errorCode, Date.now(), runId, phone);

// Puts a contact back in the queue at a stated time instead of dropping them.
const recordRecipientRetry = (runId, phone, errorCode, retryAfter) =>
  markRetry.run(errorCode, Date.now(), retryAfter, runId, phone);

// Same, for a send Meta accepted and then failed hours later. True when the row
// was actually put back — false means the webhook was a redelivery, or was
// about an attempt this contact has already moved past.
const requeueFailedRecipient = (runId, phone, wamid, errorCode, retryAfter) =>
  (runId == null || !wamid ? false
    : requeueAfterDelivery.run(errorCode, Date.now(), retryAfter, runId, phone, wamid).changes > 0);

// One queue row, or null. The caller needs `attempts` to know which rung of the
// ladder this contact is on, and `wamid` to know the webhook is not stale.
const recipientFor = (runId, phone) =>
  (runId == null ? null : recipientQ.get(runId, phone) || null);

// { at, count } for the rows waiting on backoff, or null when there are none.
function nextRetryForRun(runId) {
  if (runId == null) return null;
  const r = nextRetryAtQ.get(runId);
  return r && r.n ? { at: r.at, count: r.n } : null;
}

function progressForRun(runId) {
  if (runId == null) {
    return { total: 0, sent: 0, skipped: 0, disabled: 0, retrying: 0, pending: 0, attempted: 0 };
  }
  const r = progressQ.get(runId);
  const total = r.total || 0, sent = r.sent || 0, skipped = r.skipped || 0;
  const retrying = r.retrying || 0;
  // `pending` therefore includes the rows waiting on backoff. That is the point:
  // the run is not finished while any of them are outstanding.
  //
  // `attempted` is the one figure here that only ever goes UP: a row leaves
  // "never tried" exactly once and can never return to it. `sent + skipped`
  // cannot say that — requeueAfterDelivery nulls the wamid, so a contact Meta
  // accepted and later refused moves back OUT of `sent`, and the "663 of 775"
  // an operator was watching counted down. Nothing had been un-sent; the queue
  // had simply stopped calling that attempt finished. Retries are inside it for
  // the same reason: we did message that person, and the ladder owing them
  // another go is what `pending` and `retrying` are for.
  return { total, sent, skipped, disabled: r.disabled || 0, retrying,
           pending: total - sent - skipped, attempted: sent + skipped + retrying };
}

const billableForRun  = runId => (runId == null ? 0 : billableQ.get(runId).n || 0);
const skippedForRun   = runId => (runId == null ? [] : skippedQ.all(runId));

// Every contact in the run with the bucket the funnel counted them in, plus the
// sentence explaining what happened. Composed here rather than in the browser
// for the same reason the skip report's is: the log, the API and the screen must
// not tell three versions of one story.
//
// `read` is folded into `delivered` by bucketOf, so `wasRead` carries the
// distinction the list still wants to show.
function recipientsForRun(runId) {
  if (runId == null) return [];
  return recipientsQ.all(runId).map(r => ({
    phone: r.phone, name: r.name, seq: r.seq, wamid: r.wamid,
    skipped_reason: r.skipped_reason, error_code: r.error_code,
    attempts: r.attempts, retry_after: r.retry_after, status: r.status,
    bucket:      bucketOf(r.raw_bucket, r.code),
    wasRead:     r.raw_bucket === 'read',
    code:        r.code,
    // Why this contact is in this bucket, in one sentence. Meta's own code is
    // shown beside it rather than instead of it — an operator who has to look a
    // bare number up in Meta's reference has not been told anything.
    explanation: explainError(r.code),
    disabledReason: r.disabled_reason,
    at: r.status_at || r.sent_at || r.attempted_at || null,
  }));
}

// ── People a finished campaign still owes a message to ─────────────────────────
// Only S.currentRunId has anything walking it. A campaign ends, the operator
// uploads a new CSV — which opens a new run and makes it current — and every row
// the old run had not resolved is stranded: parked on the retry ladder with no
// loop to pick it up, or never attempted because the run was stopped.
//
// handleDeliveryFailure already refuses to requeue those (it returns 'stale'),
// and that is the right call — reopening a run nothing points at promises an
// attempt that will never be made. But the operator was never TOLD. Production
// had one contact sitting on run 9 with attempts = 4 and a deadline 32 hours in
// the past, invisible on every screen, and the only honest thing to do with a
// person still owed a message is say so.
//
// Deliberately a COUNT and a run list, not a re-send: what to do about it is the
// operator's call — usually putting those numbers in the next CSV — and a button
// that silently reopened an old run is how a campaign messages people twice.
//
// TWO queries again, and for the same reason nextPending is two: one WHERE
// carrying `skipped_reason IS NULL OR skipped_reason = 'retry'` implies neither
// partial index's predicate, so SQLite would scan the whole table — every run
// ever, on a query that runs on every broadcast. Split, each arm scans only its
// own partial index, and those hold ONLY unresolved rows: at rest, one is the
// current run's remainder and the other is whatever is parked. Both are
// typically near-empty, which is what makes asking this often affordable.
//
// `IS NOT ?` rather than `<> ?`: currentRunId is null after a Reset, and
// `<> NULL` is NULL, which a WHERE treats as not-true — so every stranded row in
// the database would vanish from this answer at exactly the moment the operator
// has no campaign open and is most likely to be looking.
const strandedUntriedQ = db.prepare(`
  SELECT run_id, count(*) AS n FROM run_recipients
   WHERE run_id IS NOT ? AND wamid IS NULL AND skipped_reason IS NULL
   GROUP BY run_id`);

const strandedRetryQ = db.prepare(`
  SELECT run_id, count(*) AS n FROM run_recipients
   WHERE run_id IS NOT ? AND wamid IS NULL AND skipped_reason = 'retry'
   GROUP BY run_id`);

const runLabelQ = db.prepare('SELECT id, label, started_at FROM campaign_runs WHERE id = ?');

// For loadCampaign's sanity check on a restored id: node:sqlite enforces the
// run_id REFERENCES, so a campaign.json that outlived its database must not
// hand the loop a run nothing can insert against.
const runExists = id => !!runLabelQ.get(Number(id));

function strandedWork(currentRunId = S.currentRunId) {
  const id = currentRunId ?? null;
  const byRun = new Map();
  const add = (rows, key) => {
    for (const r of rows) {
      const e = byRun.get(r.run_id) || { contacts: 0, retrying: 0 };
      e.contacts += r.n || 0;
      if (key === 'retrying') e.retrying += r.n || 0;
      byRun.set(r.run_id, e);
    }
  };
  add(strandedUntriedQ.all(id), 'untried');
  add(strandedRetryQ.all(id),   'retrying');

  const all = [...byRun.entries()].sort((a, b) => b[0] - a[0]);
  // The headline counts EVERY stranded run; only the per-run breakdown is
  // capped, because the banner cannot list fifty of them. Summing the slice
  // instead would quietly under-report the moment there were more than twenty —
  // a number that leaves people out is the one thing this banner exists to stop.
  const contacts = all.reduce((n, [, e]) => n + e.contacts, 0);
  const runs = all.slice(0, 20).map(([runId, e]) => {
    const row = runLabelQ.get(runId);
    return { id: runId, label: row?.label ?? null, startedAt: row?.started_at ?? null, ...e };
  });

  return { contacts, runs };
}

// ── The last campaign ──────────────────────────────────────────────────────────
// Read from campaign_runs rather than from S.currentRunId, so it still answers
// "what did the last send do" after a Reset has dropped the current run — which
// is precisely when an operator asks. Everything in it is derived; there is no
// stored summary that can disagree with the rows.
const lastRunQ = db.prepare(
  'SELECT id, started_at, label, template_lang FROM campaign_runs ORDER BY id DESC LIMIT 1');

// `already` lets the caller hand in the aggregates it has just computed. Almost
// every call comes from buildState(), which runs on every broadcast — once per
// message sent — and had already asked progressForRun, countsForRun,
// funnelForRun and nextRetryForRun about the CURRENT run a few lines earlier.
// The last run is the current run except in the moments right after a Reset, so
// that was four aggregate queries, one of them a three-table join, re-answering
// a question whose answer was already in a local variable.
//
// Passed in rather than memoised on purpose: a cache here would need invalidating
// on every webhook, and the whole point of deriving these numbers is that there
// is nothing to keep in step. This is the caller saying "I asked a moment ago",
// which is true within one synchronous snapshot and is not a claim about later.
function lastRunSummary(already = null) {
  const r = lastRunQ.get();
  if (!r) return null;
  const same     = already && already.runId === r.id;
  const progress = same ? already.progress : progressForRun(r.id);
  return {
    id: r.id, label: r.label, startedAt: r.started_at, language: r.template_lang,
    progress,
    counts:    same ? already.counts    : countsForRun(r.id),
    funnel:    same ? already.funnel    : funnelForRun(r.id),
    nextRetry: same ? already.nextRetry : nextRetryForRun(r.id),
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
  if (isCurrent && campaignActive()) return 'in-progress';
  return pending > 0 ? 'incomplete' : 'completed';
}

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
        // The list line and the campaign it opens must not report different
        // numbers for one run, so both read the funnel.
        counts: countsForRun(r.id), progress, funnel: funnelForRun(r.id),
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
    counts: countsForRun(id), progress, funnel: funnelForRun(id),
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
  recordRecipientRetry, requeueFailedRecipient, recipientFor, runExists,
  nextRetryForRun, lastRunSummary, sentSince, sendingDays, strandedWork,
  progressForRun, funnelForRun, bucketOf, skippedForRun, recipientsForRun, billableForRun,
};

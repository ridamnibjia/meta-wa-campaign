'use strict';
const { CFG, LIMITS, MEDIA_LIMITS } = require('../config');
const { db } = require('../lib/db');
const { log, emit } = require('../state');
const { normalizePhone } = require('../lib/phone');
const { graphSend } = require('./graph');
const { explainError } = require('../lib/errors');
const { INBOUND_TTL_MS, getAsset, ensureMediaId, holdAsset } = require('./media');
const { effectiveRisk } = require('../lib/filerisk');

// An inbound message opens a 24-hour "customer service window" during which the
// business may send free-form text — no template, no approval. Outside it, Meta
// rejects anything that is not an approved template (error 131047).
const WINDOW_MS = 24 * 60 * 60 * 1000;

// The message types that carry a media asset. Meta nests the descriptor under a
// key named after the type, so `m[m.type]` is the descriptor for all of them.
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

function isWindowOpen(thread, now = Date.now()) {
  if (!thread || !thread.lastInboundAt) return false;
  return now - thread.lastInboundAt < WINDOW_MS;
}

// Meta's own text for the message types this app does not render. Showing
// "[image]" is honest; showing nothing would look like an empty reply and the
// operator would never know the customer sent something.
function describe(m) {
  if (m.type === 'text')        return m.text?.body || '';
  if (m.type === 'button')      return m.button?.text || '[button]';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title
                                    || m.interactive?.list_reply?.title || '[interactive]';
  if (m.type === 'reaction')    return m.reaction?.emoji || '[reaction]';
  return `[${m.type || 'unsupported'}]`;
}

// Learn the profile name once Meta sends it, but never overwrite a real name
// with the number — COALESCE(NULLIF(...)) keeps whichever is more informative.
const upsertInboundThread = db.prepare(`
  INSERT INTO threads (wa_id, name, unread, last_inbound_at, last_at)
  VALUES (?, ?, 1, ?, ?)
  ON CONFLICT(wa_id) DO UPDATE SET
    name            = COALESCE(NULLIF(excluded.name, threads.wa_id), threads.name),
    unread          = threads.unread + 1,
    last_inbound_at = max(threads.last_inbound_at, excluded.last_inbound_at),
    last_at         = max(threads.last_at, excluded.last_at)
`);

const insertInbound = db.prepare(`
  INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, raw, at)
  VALUES (?, ?, 'in', ?, ?, ?, ?)
`);

const insertMedia = db.prepare(`
  INSERT OR IGNORE INTO media (media_id, wamid, mime_type, filename, file_size, sha256)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const seenWamid = db.prepare('SELECT 1 AS ok FROM messages WHERE wamid = ?');
const zeroUnread = db.prepare('UPDATE threads SET unread = 0 WHERE wa_id = ?');
const threadExists = db.prepare('SELECT wa_id FROM threads WHERE wa_id = ?');

// run_id is left to its NULL default: an inbox reply is not part of any
// campaign, and the campaign counters must not count it.
const insertOutbound = db.prepare(`
  INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status, asset_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const touchThread = db.prepare('UPDATE threads SET last_at = max(last_at, ?) WHERE wa_id = ?');

// Meta redelivers webhooks it did not get a 200 for, so the same wamid can
// arrive more than once. The dedupe is now the messages primary key, checked
// before the thread upsert so a retry cannot re-increment the unread badge.
function recordInbound(m, profileName) {
  const waId = normalizePhone(m.from) || m.from;
  if (seenWamid.get(m.id)) return null;

  const at   = Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now();
  const text = describe(m);
  const name = profileName || waId;

  db.exec('BEGIN');
  try {
    insertInbound.run(m.id, waId, m.type || 'text', text, JSON.stringify(m), at);
    upsertInboundThread.run(waId, name, at, at);
    // Recorded, not downloaded. Bytes are fetched on operator request in P3;
    // this row is what makes that possible after the envelope is gone.
    const desc = MEDIA_TYPES.includes(m.type) ? m[m.type] : null;
    if (desc?.id) {
      insertMedia.run(desc.id, m.id, desc.mime_type ?? null, desc.filename ?? null,
                      desc.file_size ?? null, desc.sha256 ?? null);
    } else if (desc) {
      log('warn', `inbound ${m.type} ${m.id} carried no media id — nothing to fetch later`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  emit('inbox', summary());
  log('info', `reply from ${name} (+${waId}): ${text.slice(0, 60)}`);
  return { id: m.id, dir: 'in', type: m.type || 'text', text, at };
}

function markRead(waId) {
  if (!threadExists.get(waId)) return null;
  zeroUnread.run(waId);
  emit('inbox', summary());
  return { waId };
}

// Free-form text, only inside the window. The check lives here rather than in
// the route so it cannot be skipped by a caller — and it is re-checked against
// the clock at send time, not against whatever the browser last rendered.
async function sendReply(waId, text) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Message is empty' };
  if (body.length > LIMITS.textMessage) {
    return { ok: false, error: `Message is ${body.length} characters — WhatsApp allows ${LIMITS.textMessage}` };
  }
  if (!CFG.accessToken || !CFG.phoneNumberId) return { ok: false, error: 'Credentials not configured' };

  const t = getThread.get(waId);
  if (!isWindowOpen(t && { lastInboundAt: t.last_inbound_at })) {
    return { ok: false, error: 'The 24-hour reply window for this contact has closed. Only an approved template can reopen the conversation.' };
  }

  try {
    const { res, data } = await graphSend('POST', `${CFG.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                waId,
      type:              'text',
      text:              { body },
    });
    if (!res.ok || !data.messages?.[0]?.id) {
      const code = data.error?.code || 0;
      const hint = explainError(code) || explainError(data.error?.error_subcode);
      log('error', `reply to +${waId} failed [${code}] ${data.error?.message || 'unknown'}`);
      return { ok: false, error: data.error?.message || 'Send failed', hint };
    }
    const entry = { id: data.messages[0].id, dir: 'out', type: 'text', text: body, at: Date.now(), status: 'sent' };
    db.exec('BEGIN');
    try {
      insertOutbound.run(entry.id, waId, 'out', 'text', body, entry.at, 'sent', null);
      touchThread.run(entry.at, waId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    emit('inbox', summary());
    log('success', `replied to ${t.name || waId} (+${waId})`);
    return { ok: true, message: entry };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// The same send as sendReply, with a file on it. Kept as its own function
// rather than an optional argument on sendReply: the failure modes genuinely
// differ — an asset can have been deleted, and Meta's media id can have expired
// — and folding them in would make one function's error handling answer for two
// different jobs.
//
// This is also the half of the 131049 answer the retry ladder cannot give. The
// per-user marketing cap does not apply inside the 24-hour service window, so a
// template that invites a reply followed by a free-form send here reaches people
// no amount of retrying a marketing template will.
//
// Meta caps a media caption well below a text message and rejects an over-long
// one with a code that never mentions the caption.
const CAPTION_LIMIT = 1024;

// The hold is a wrapper rather than a try/finally around the body: it has to
// cover the WHOLE send, including the re-upload-and-retry below, and wrapping is
// the version that cannot be defeated by adding an early return later.
// deleteAsset refuses while the hold is out, so a file cannot vanish between the
// media id being minted and the message that carries it being accepted.
const sendMedia = (waId, assetId, caption = '') => {
  const release = holdAsset(assetId);
  return sendMediaNow(waId, assetId, caption).finally(release);
};

async function sendMediaNow(waId, assetId, caption = '') {
  const text = String(caption || '').trim();
  if (text.length > CAPTION_LIMIT) {
    return { ok: false, error: `The caption is ${text.length} characters — WhatsApp allows ${CAPTION_LIMIT}. Shorten it, or send the file first and the rest as a separate message.` };
  }
  if (!CFG.accessToken || !CFG.phoneNumberId) return { ok: false, error: 'Credentials not configured' };

  const asset = getAsset(assetId);
  if (!asset) {
    return { ok: false, error: 'That file is no longer in the library. Upload it again and resend.' };
  }

  // Re-checked against the clock at send time, not against whatever the browser
  // last rendered — the picker may have been open for an hour.
  const t = getThread.get(waId);
  if (!isWindowOpen(t && { lastInboundAt: t.last_inbound_at })) {
    return { ok: false, error: 'The 24-hour reply window for this contact has closed. Only an approved template can reopen the conversation.' };
  }

  // Meta deletes uploaded media at 30 days. ensureMediaId refreshes at 29 and
  // re-uploads from local disk when the id has gone anyway, so sending a
  // six-month-old price list works and the operator never learns it expired.
  const got = await ensureMediaId(assetId);
  if (!got.ok) return got;

  // Meta nests the descriptor under a key named after the type, so `kind` is
  // both the type and the key. `filename` is only meaningful on a document — on
  // an image it is ignored, and on a video it is rejected.
  const payload = { id: got.mediaId };
  if (text) payload.caption = text;
  if (asset.kind === 'document') payload.filename = asset.filename;

  const post = body => graphSend('POST', `${CFG.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                waId,
    type:              asset.kind,
    [asset.kind]:      body,
  });

  try {
    let { res, data } = await post(payload);

    // Meta deletes media at 30 days and our 29-day refresh clock is not their
    // clock — they can drop it early, and a media id can also be invalidated by
    // things we never see. The campaign path already re-uploads and retries once
    // for exactly this; without the same here, a price list uploaded five weeks
    // ago fails at the moment a dealer is waiting for it.
    //
    // Keyed on data.error rather than res.ok: Graph answers this class of
    // failure with HTTP 200 carrying an error object.
    if (/media/i.test(data.error?.message || '')) {
      log('warn', `Send rejected over the media id for "${asset.filename}" — re-uploading it and retrying once`);
      const again = await ensureMediaId(assetId, { force: true });
      if (!again.ok) return again;
      ({ res, data } = await post({ ...payload, id: again.mediaId }));
    }

    if (!res.ok || !data.messages?.[0]?.id) {
      const code = data.error?.code || 0;
      const hint = explainError(code) || explainError(data.error?.error_subcode);
      log('error', `media reply to +${waId} failed [${code}] ${data.error?.message || 'unknown'}`);
      return { ok: false, error: data.error?.message || 'Send failed', hint };
    }
    // The body is what the transcript, the search index and every thread preview
    // read. A media message with a NULL body is a blank line in all three, so
    // the filename stands in when there is no caption.
    const body  = text || `[${asset.kind}] ${asset.filename}`;
    const entry = { id: data.messages[0].id, dir: 'out', type: asset.kind, text: body,
                    at: Date.now(), status: 'sent' };
    db.exec('BEGIN');
    try {
      insertOutbound.run(entry.id, waId, 'out', asset.kind, body, entry.at, 'sent', asset.id);
      touchThread.run(entry.at, waId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    emit('inbox', summary());
    log('success', `sent ${asset.filename} to ${t.name || waId} (+${waId})`);
    return { ok: true, message: entry };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// ── What is actually part of the conversation ─────────────────────────────────
// A transcript is what the two people said to each other. An outbound message
// Meta refused to deliver reached nobody: the customer has never seen it, has no
// way to answer it, and does not know it exists. Rendering it in the thread —
// even tagged "Not delivered" — puts words in our mouth that were never spoken,
// and an operator skimming a thread before replying reads it as context the
// customer shares. They do not.
//
// It is worse than cosmetic once the retry ladder runs. A contact Meta refuses
// and we later reach has TWO rows for one message: the refused attempt and the
// delivered one. The thread showed the same campaign copy twice, which reads as
// the business having spammed them.
//
// The rows are NOT deleted, and must not be. services/messages.js counts them
// (countsForRun), the funnel joins on them to decide the `gaveUp` bucket,
// applyStatus needs the row to exist so a redelivered webhook is recognised
// rather than logged as unknown, and the skip report is the audit trail. The
// campaign screens are where "we tried and Meta refused" is answered; the inbox
// is where "what did we say to each other" is answered. Two questions, two
// surfaces, one set of rows.
//
// ONE fragment, interpolated into every query that renders a transcript — the
// list preview, the page, the count and the search. A second hand-written copy
// is how the preview starts showing a message the thread below it does not.
//
// `IS`, not `=`, and this is not a style choice. status is NULL on an inbound
// row and on an outbound one Meta has not reported on yet, and in SQL
// `NULL = 'failed'` is NULL rather than false — so `NOT (dir = 'out' AND NULL)`
// is `NOT NULL`, which is NULL, which a WHERE clause treats as not-true. The `=`
// version therefore hid every outbound message that had no status yet: the whole
// transcript from the moment you sent it until the delivery receipt arrived.
// SQLite's IS is null-safe equality and yields a real false. There is a test.
const VISIBLE = `NOT (m.dir = 'out' AND m.status IS 'failed')`;

// ponytail: two correlated subqueries for the preview instead of a join with a
// window function — 0ms at this scale on the (wa_id, at DESC) index, and it
// reads like what it does. Revisit if a deployment ever measures otherwise.
const listThreads = db.prepare(`
  SELECT t.wa_id, t.name, t.unread, t.last_at, t.last_inbound_at,
         (SELECT m.body FROM messages m WHERE m.wa_id = t.wa_id AND ${VISIBLE} ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS preview,
         (SELECT m.dir  FROM messages m WHERE m.wa_id = t.wa_id AND ${VISIBLE} ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_dir
    FROM threads t
   WHERE (? = 1 OR t.last_inbound_at > 0)
   ORDER BY t.last_at DESC
`);

const getThread = db.prepare('SELECT wa_id, name, last_inbound_at FROM threads WHERE wa_id = ?');

// A page of transcript, newest first, walked backwards from a cursor. Served by
// idx_messages_thread (wa_id, at DESC) — the index has existed since P1 and this
// is the query it was built for.
//
// The cursor is (at, rowid), not `at` alone: timestamps come from Meta in whole
// seconds, so several messages in one conversation routinely share one. A cursor
// on `at` by itself would skip every message that ties with the page boundary,
// and the gap would be invisible — the transcript would simply be missing lines.
const PAGE_SIZE = 30;

const pageOfMessages = db.prepare(`
  SELECT m.wamid, m.dir, m.type, m.body, m.at, m.rowid AS rid, m.status,
         m.error_code, m.error_title,
         md.media_id, md.mime_type, md.filename, md.file_size, md.path,
         md.risk, md.risk_reason, md.scan_status, md.scan_signature, md.provisional,
         ma.id AS asset_id, ma.filename AS asset_filename,
         ma.mime_type AS asset_mime, ma.file_size AS asset_size, ma.kind AS asset_kind
    FROM messages m
    LEFT JOIN media md        ON md.wamid = m.wamid
    LEFT JOIN media_assets ma ON ma.id = m.asset_id
   WHERE m.wa_id = ? AND ${VISIBLE}
     AND (? IS NULL OR m.at < ? OR (m.at = ? AND m.rowid < ?))
   ORDER BY m.at DESC, m.rowid DESC
   LIMIT ?
`);

const countMessages = db.prepare(`SELECT count(*) AS n FROM messages m WHERE m.wa_id = ? AND ${VISIBLE}`);

// The ones deliberately left out, so the thread can say so in one line rather
// than leave the operator wondering whether a campaign reached this contact at
// all. Stating the number is the honest middle: the messages are not in the
// conversation, and the fact that we tried is not hidden either.
const countUndelivered = db.prepare(
  `SELECT count(*) AS n FROM messages m WHERE m.wa_id = ? AND m.dir = 'out' AND m.status = 'failed'`);

// "1712345678901:4821" — opaque to the client, which only ever echoes it back.
const encodeCursor = r => `${r.at}:${r.rid}`;
const decodeCursor = c => {
  const m = /^(\d+):(\d+)$/.exec(String(c || ''));
  return m ? { at: Number(m[1]), rid: Number(m[2]) } : null;
};

// wamid → id and body → text: public/views/inbox.jsx renders those two keys and
// this is the only place that knows the column names differ.
//
// `expired` is computed here rather than stored. Meta deletes inbound media 30
// days after the message, so the deadline is a property of a timestamp we
// already have — the UI needs it to render "gone" instead of a Save button that
// can only fail.
const toEntry = (r, now = Date.now()) => ({
  id: r.wamid, dir: r.dir, type: r.type, text: r.body ?? '', at: r.at, status: r.status,
  // A failed message used to say "failed" in a log the operator had to go
  // looking for, on a page that wipes it. The code and Meta's own title travel
  // with the message, and explainError turns the number into an instruction —
  // the same table the fail log has always used, now on the bubble itself.
  error: r.status === 'failed' ? {
    code:  r.error_code ?? null,
    title: r.error_title ?? null,
    hint:  explainError(r.error_code),
  } : null,
  // Outbound media the operator sent. A separate key from `media` above, which
  // is inbound: that one carries a risk verdict, a 30-day expiry and a
  // Keep/Discard decision, and not one of those means anything for a file the
  // operator uploaded themselves.
  outMedia: r.asset_id ? {
    assetId:  r.asset_id,
    filename: r.asset_filename,
    mime:     r.asset_mime,
    size:     r.asset_size,
    kind:     r.asset_kind,
  } : null,
  media: r.media_id ? {
    mediaId:  r.media_id,
    mime:     r.mime_type,
    filename: r.filename,
    size:     r.file_size,
    saved:    !!r.path,
    // Here to be looked at, not to be kept. The UI needs the difference so it
    // can offer Keep and Discard instead of pretending the decision is made.
    provisional: !!r.path && !!r.provisional,
    expired:  !r.path && (now - r.at) > INBOUND_TTL_MS,
    // A verdict is only meaningful once there are bytes to have a verdict
    // about. Reporting a tier for an unsaved row would put a red warning on a
    // file nothing has looked at.
    //
    // effectiveRisk, not the raw column: it is the same function the serve
    // route decides with, so the UI never renders an <img> for something the
    // server has already decided to hand back as a download.
    risk:          r.path ? effectiveRisk(r.risk, r.scan_status) : null,
    riskReason:    r.path ? r.risk_reason : null,
    scanStatus:    r.path ? (r.scan_status || 'skipped') : null,
    scanSignature: r.scan_signature || null,
  } : null,
});

// Thread list without message bodies — the nav badge and the inbox list poll
// this, and neither needs the transcript. Campaign sends give every recipient a
// thread, so the default view is "people who actually replied"; last_inbound_at
// already separates the two, and `all` shows everything.
function summary({ all = false, now = Date.now() } = {}) {
  const rows = listThreads.all(all ? 1 : 0);
  const threads = rows.map(t => ({
    waId:   t.wa_id,
    name:   t.name || t.wa_id,
    unread: t.unread,
    lastAt: t.last_at,
    windowOpen: isWindowOpen({ lastInboundAt: t.last_inbound_at }, now),
    windowClosesAt: t.last_inbound_at ? t.last_inbound_at + WINDOW_MS : null,
    preview: (t.preview || '').slice(0, 90),
    lastDir: t.last_dir,
  }));
  return { threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
}

// `before` is the cursor from a previous page; omit it for the newest page.
// Messages come back oldest-first because that is the order a transcript reads,
// even though the query walks backwards to find them.
function thread(waId, { now = Date.now(), before = null, limit = PAGE_SIZE } = {}) {
  const t = getThread.get(waId);
  if (!t) return null;

  const cur = decodeCursor(before);
  const size = Math.min(Math.max(Number(limit) || PAGE_SIZE, 1), 200);
  // One extra row, then dropped: asking for 31 to show 30 is how "is there more"
  // is answered without a second COUNT over the whole thread.
  const at = cur ? cur.at : null, rid = cur ? cur.rid : 0;
  // node:sqlite binds anonymous ? placeholders strictly by position, so the
  // cursor is repeated rather than written as ?2 three times.
  const rows = pageOfMessages.all(waId, at, at, at, rid, size + 1);
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);

  return {
    waId: t.wa_id,
    name: t.name || t.wa_id,
    messages: page.slice().reverse().map(r => toEntry(r, now)),
    total: countMessages.get(waId).n,
    // Not in the transcript, and not hidden either: the thread states the count
    // so an operator is never left wondering whether a campaign reached this
    // contact. Campaign history is where the codes and the reasons live.
    undelivered: countUndelivered.get(waId).n,
    hasMore,
    // The cursor for the NEXT page back — the oldest row on this one.
    nextBefore: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    windowOpen: isWindowOpen({ lastInboundAt: t.last_inbound_at }, now),
    windowClosesAt: t.last_inbound_at ? t.last_inbound_at + WINDOW_MS : null,
    // Once per thread, not once per attachment: the UI states this number in
    // two places and neither should be a literal that drifts from config.
    previewHours: MEDIA_LIMITS.previewHours,
  };
}

// ── Search ─────────────────────────────────────────────────────────────────────
// LIKE '%…%' over messages.body, global or scoped to one thread. Measured at
// 40ms across 200k rows on this hardware, so there is no FTS5 table, no shadow
// index and nothing to keep in step with the messages table.
//
// ponytail: revisit only if a real deployment measures worse. An FTS5 index is
// a second copy of every message body, and the day it drifts from the first one
// the symptom is a search that quietly cannot find a conversation you are
// looking at.
const searchAll = db.prepare(`
  SELECT m.wamid, m.wa_id, m.dir, m.type, m.body, m.at, t.name
    FROM messages m JOIN threads t ON t.wa_id = m.wa_id
   WHERE m.body LIKE ? ESCAPE '\\' AND ${VISIBLE}
   ORDER BY m.at DESC LIMIT ?
`);

const searchThread = db.prepare(`
  SELECT m.wamid, m.wa_id, m.dir, m.type, m.body, m.at, t.name
    FROM messages m JOIN threads t ON t.wa_id = m.wa_id
   WHERE m.wa_id = ? AND m.body LIKE ? ESCAPE '\\' AND ${VISIBLE}
   ORDER BY m.at DESC LIMIT ?
`);

// Also searches who you were talking to, not only what was said: an operator
// looking for "Asha" means the person at least as often as the word.
const searchPeople = db.prepare(`
  SELECT wa_id, name, last_at FROM threads
   WHERE wa_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
   ORDER BY last_at DESC LIMIT ?
`);

// % and _ are LIKE wildcards. Left unescaped, a search for "50%" matches every
// message ever sent — which reads as a broken search rather than a broken query.
const likeEscape = s => String(s).replace(/[\\%_]/g, c => '\\' + c);

function search(q, { waId = null, limit = 50 } = {}) {
  const term = String(q || '').trim();
  // One character matches most of the database and tells the operator nothing.
  if (term.length < 2) return { query: term, tooShort: true, messages: [], people: [] };

  const like = `%${likeEscape(term)}%`;
  const n    = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = waId ? searchThread.all(waId, like, n) : searchAll.all(like, n);

  return {
    query: term,
    scope: waId || null,
    tooShort: false,
    messages: rows.map(r => ({
      id: r.wamid, waId: r.wa_id, name: r.name || r.wa_id,
      dir: r.dir, type: r.type, text: r.body ?? '', at: r.at,
    })),
    // Only for a global search: inside one thread you already know who it is.
    people: waId ? [] : searchPeople.all(like, like, 10).map(t => ({
      waId: t.wa_id, name: t.name || t.wa_id, lastAt: t.last_at,
    })),
  };
}

module.exports = { WINDOW_MS, PAGE_SIZE, CAPTION_LIMIT, isWindowOpen, recordInbound, markRead,
                   sendReply, sendMedia, summary, thread, describe, search };

'use strict';
const { CFG, LIMITS } = require('../config');
const { db } = require('../lib/db');
const { log, emit } = require('../state');
const { normalizePhone } = require('../lib/phone');
const { graphSend } = require('./graph');
const { explainError } = require('../lib/errors');
const { INBOUND_TTL_MS } = require('./media');
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
  INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
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
      insertOutbound.run(entry.id, waId, 'out', 'text', body, entry.at, 'sent');
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

// ponytail: two correlated subqueries for the preview instead of a join with a
// window function — 0ms at this scale on the (wa_id, at DESC) index, and it
// reads like what it does. Revisit if a deployment ever measures otherwise.
const listThreads = db.prepare(`
  SELECT t.wa_id, t.name, t.unread, t.last_at, t.last_inbound_at,
         (SELECT m.body FROM messages m WHERE m.wa_id = t.wa_id ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS preview,
         (SELECT m.dir  FROM messages m WHERE m.wa_id = t.wa_id ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_dir
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
         md.media_id, md.mime_type, md.filename, md.file_size, md.path,
         md.risk, md.risk_reason, md.scan_status, md.scan_signature
    FROM messages m
    LEFT JOIN media md ON md.wamid = m.wamid
   WHERE m.wa_id = ?
     AND (? IS NULL OR m.at < ? OR (m.at = ? AND m.rowid < ?))
   ORDER BY m.at DESC, m.rowid DESC
   LIMIT ?
`);

const countMessages = db.prepare('SELECT count(*) AS n FROM messages WHERE wa_id = ?');

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
  media: r.media_id ? {
    mediaId:  r.media_id,
    mime:     r.mime_type,
    filename: r.filename,
    size:     r.file_size,
    saved:    !!r.path,
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
    hasMore,
    // The cursor for the NEXT page back — the oldest row on this one.
    nextBefore: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    windowOpen: isWindowOpen({ lastInboundAt: t.last_inbound_at }, now),
    windowClosesAt: t.last_inbound_at ? t.last_inbound_at + WINDOW_MS : null,
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
   WHERE m.body LIKE ? ESCAPE '\\'
   ORDER BY m.at DESC LIMIT ?
`);

const searchThread = db.prepare(`
  SELECT m.wamid, m.wa_id, m.dir, m.type, m.body, m.at, t.name
    FROM messages m JOIN threads t ON t.wa_id = m.wa_id
   WHERE m.wa_id = ? AND m.body LIKE ? ESCAPE '\\'
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

module.exports = { WINDOW_MS, PAGE_SIZE, isWindowOpen, recordInbound, markRead, sendReply,
                   summary, thread, describe, search };

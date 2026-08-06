'use strict';
// One-shot move of inbox.json and msg-index.json into SQL. Runs at boot, does
// nothing once messages has rows, and renames the source files afterwards so a
// later boot has nothing to find. Kept in its own module so deleting it in six
// months is a `git rm` rather than an archaeology exercise.
const fs = require('node:fs');
const { FILES } = require('../config');
const { readJSON } = require('../lib/store');
const { db } = require('../lib/db');
const { log } = require('../state');

function migrateJsonToSql(handle = db, files = FILES) {
  const already = handle.prepare('SELECT count(*) AS n FROM messages').get().n;
  if (already > 0) return { threads: 0, inboundMessages: 0, outboundMessages: 0, skipped: true };

  const haveInbox = fs.existsSync(files.inbox);
  const haveIndex = fs.existsSync(files.msgIndex);
  if (!haveInbox && !haveIndex) return { threads: 0, inboundMessages: 0, outboundMessages: 0, skipped: false };

  const insertThread = handle.prepare(
    'INSERT OR IGNORE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES (?, ?, ?, ?, ?)');
  const insertMsg = handle.prepare(
    'INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const counts = { threads: 0, inboundMessages: 0, outboundMessages: 0, skipped: false };
  // Per-source write tallies. store.js:readJSON swallows a JSON.parse throw and
  // returns {} — indistinguishable, at this level, from a source file that
  // genuinely had nothing in it. Either way, if a file that existed produced
  // zero writes, it must not be renamed away: renaming it declares success on
  // what could be a total, silent loss of visible history (F7).
  let inboxWrites = 0;
  let indexWrites = 0;

  handle.exec('BEGIN');
  try {
    const inbox = haveInbox ? readJSON(files.inbox, {}) : {};
    for (const t of Object.values(inbox)) {
      if (!t || !t.waId) continue;
      insertThread.run(t.waId, t.name ?? t.waId, t.unread ?? 0, t.lastInboundAt ?? 0, t.lastAt ?? 0);
      counts.threads++;
      inboxWrites++;
      for (const m of (t.messages || [])) {
        if (!m || !m.id) continue;
        insertMsg.run(m.id, t.waId, m.dir === 'out' ? 'out' : 'in', m.type || 'text',
                      m.text ?? null, m.at ?? 0, m.status ?? null);
        if (m.dir === 'out') counts.outboundMessages++; else counts.inboundMessages++;
        inboxWrites++;
      }
    }

    // msgIndex entries carry no timestamp. The file's own mtime is the closest
    // honest answer — better than 0, which would sort them before the epoch.
    const indexAt = haveIndex ? fs.statSync(files.msgIndex).mtimeMs : Date.now();
    const idx = haveIndex ? (readJSON(files.msgIndex, {}).msgIndex || {}) : {};
    for (const [wamid, m] of Object.entries(idx)) {
      if (!m || !m.phone) continue;
      // A msgIndex-only recipient (no inbox.json thread) still opened a
      // thread and was previously left out of counts.threads entirely (F9).
      // INSERT OR IGNORE means `changes` is 0 when the inbox loop above
      // already created this thread — only count it once, for whichever
      // source actually created the row.
      const r = insertThread.run(m.phone, m.name ?? m.phone, 0, 0, indexAt);
      if (r.changes > 0) counts.threads++;
      insertMsg.run(wamid, m.phone, 'out', 'template', m.name ?? null, indexAt, m.status ?? null);
      counts.outboundMessages++;
      indexWrites++;
    }
    handle.exec('COMMIT');
  } catch (e) {
    handle.exec('ROLLBACK');
    throw e;
  }

  // Rename only after the transaction commits: a crash before this point leaves
  // the JSON intact and the migration re-runnable. Renamed relative to `files`,
  // not the module-level FILES — a test pointed at a tmpdir must never touch
  // the real repo paths. A file that existed but produced no writes — corrupt
  // JSON, or genuinely empty — is left exactly where it was, and logged loudly,
  // rather than renamed out from under a "0 threads, 0 messages" success line.
  if (haveInbox) {
    if (inboxWrites > 0) fs.renameSync(files.inbox, `${files.inbox}.migrated`);
    else log('error', `${files.inbox} could not be read (or contained nothing) — left in place, NOT migrated`);
  }
  if (haveIndex) {
    if (indexWrites > 0) fs.renameSync(files.msgIndex, `${files.msgIndex}.migrated`);
    else log('error', `${files.msgIndex} could not be read (or contained nothing) — left in place, NOT migrated`);
  }

  log('info', `Migrated to SQL — ${counts.threads} threads, ${counts.inboundMessages} inbound, ${counts.outboundMessages} outbound`);
  return counts;
}

module.exports = { migrateJsonToSql };

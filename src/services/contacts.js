'use strict';
// The customer list, and the one switch that decides whether a campaign may
// message any given row. This module replaces services/optouts.js, which held a
// flat Set of phone numbers with no names, no history, and no relationship to
// the CSV beyond a `.has()` check at send time.
//
// The distinction that runs through the whole file: a disabled contact is
// excluded from CAMPAIGNS and fully replyable in the INBOX. Someone who opted
// out of promotions and then writes in with a question still deserves an
// answer, and answering them is not a marketing message. services/inbox.js
// therefore never consults this module — its only gate is the 24-hour window.
const fs = require('node:fs');
const { FILES } = require('../config');
const { db } = require('../lib/db');
const { log } = require('../state');
const { readJSON } = require('../lib/store');
const { normalizePhone } = require('../lib/phone');

const REASONS = ['manual', 'opt_out', 'failed_hard'];

// ── The upsert that must never re-enable ───────────────────────────────────────
// enabled / disabled_reason / disabled_at are deliberately absent from the SET
// list. Re-uploading a CSV must never resurrect someone who opted out, and the
// entire requirement is that one omitted assignment — an absence, not a guard,
// which is exactly the kind of thing a future contributor breaks by helpfully
// adding `enabled = excluded.enabled`. Hence this comment, and the test that
// uploads the same file twice around a disable.
//
// ON CONFLICT … DO UPDATE is one statement: no SELECT-then-branch, and so no
// race between the check and the write.
const upsertContact = db.prepare(`
  INSERT INTO contacts (phone, name, fields_json, first_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET
    name        = excluded.name,
    -- COALESCE, because the two-column CSV the export route produces carries no
    -- extra fields, and the round trip it advertises ("re-upload when the
    -- original file is gone") must not be the thing that wipes the fields the
    -- column exists to preserve. A file WITH extra columns still overwrites.
    fields_json = COALESCE(excluded.fields_json, contacts.fields_json)
`);

const reapplySuppression = db.prepare(`
  UPDATE contacts
     SET enabled         = 0,
         disabled_reason = (SELECT s.reason FROM suppressed s WHERE s.phone = contacts.phone),
         disabled_at     = (SELECT s.at     FROM suppressed s WHERE s.phone = contacts.phone)
   WHERE enabled = 1 AND phone IN (SELECT phone FROM suppressed)
`);

const insertUpload = db.prepare(`
  INSERT INTO csv_uploads (uploaded_at, filename, row_count, new_count, skipped_count)
  VALUES (?, ?, ?, ?, ?)
`);

const getRow      = db.prepare('SELECT * FROM contacts WHERE phone = ?');
// Two tables, one question, and the OR is the point: the contacts row can be
// deleted or re-created by a CSV, and the suppression outlives both. Fail
// closed — a number named in either place is not messaged.
const isDisabledQ = db.prepare(`
  SELECT 1 AS hit FROM contacts   WHERE phone = ? AND enabled = 0
   UNION ALL
  SELECT 1 AS hit FROM suppressed WHERE phone = ?`);
// enabled DESC — messageable contacts first. Both callers are operator-facing
// lists of "who a campaign reaches": the CSV export and /stage-contacts, whose
// first five rows become the step-1 preview. enabled ASC led that preview with
// exactly the people the run will skip.
const allRows     = db.prepare('SELECT * FROM contacts ORDER BY enabled DESC, name COLLATE NOCASE ASC, phone ASC');
const disabledQ   = db.prepare('SELECT * FROM contacts WHERE enabled = 0 ORDER BY disabled_at DESC');
const countsQ     = db.prepare(`
  SELECT count(*)                                       AS total,
         sum(CASE WHEN enabled = 1 THEN 1 ELSE 0 END)   AS enabled,
         sum(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)   AS disabled
    FROM contacts
`);

// A number nobody has ever recorded is not disabled. The test-send box accepts
// a number typed by hand, and refusing it because it is absent from the table
// would be an odd reading of "this person asked us to stop".
function isDisabled(phone) {
  const d = normalizePhone(phone);
  return !!d && !!isDisabledQ.get(d, d);
}

const isEnabled = phone => !isDisabled(phone);

// Creates the row when it is missing: a customer can tap the opt-out button on
// a message sent by a previous tool, or from a number that never came from any
// CSV, and "we have no row for you" is not a reason to keep messaging them.
const disableQ = db.prepare(`
  INSERT INTO contacts (phone, name, first_seen, enabled, disabled_reason, disabled_at)
  VALUES (?, ?, ?, 0, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET
    enabled         = 0,
    disabled_reason = excluded.disabled_reason,
    disabled_at     = excluded.disabled_at,
    name            = COALESCE(NULLIF(excluded.name, excluded.phone), contacts.name)
`);

// The compliance half of a disable, written alongside the contacts row and in
// the same call, so there is no path that produces one without the other.
const suppressQ = db.prepare(`
  INSERT INTO suppressed (phone, reason, at) VALUES (?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, at = excluded.at
`);
const unsuppressQ  = db.prepare('DELETE FROM suppressed WHERE phone = ?');
const isSuppressed = db.prepare('SELECT 1 AS hit FROM suppressed WHERE phone = ?');

function disable(phone, reason = 'manual', name = null) {
  const d = normalizePhone(phone);
  if (!d) return false;
  const why = REASONS.includes(reason) ? reason : 'manual';
  // Already off for the same reason: nothing to write, and nothing to log at
  // the caller either. A webhook redelivery of one opt-out tap is not two.
  // The suppression row is part of "already off" — a contact disabled before
  // that table existed must still get one, and the backfill only runs at boot.
  const before = getRow.get(d);
  if (before && !before.enabled && before.disabled_reason === why && isSuppressed.get(d)) return false;
  const now = Date.now();
  disableQ.run(d, name || d, now, why, now);
  suppressQ.run(d, why, now);
  return true;
}

// Re-enabling is always manual — nothing automatic ever turns a contact back
// on, because every automatic path here is a reason to stay off.
const enableQ = db.prepare(
  'UPDATE contacts SET enabled = 1, disabled_reason = NULL, disabled_at = NULL WHERE phone = ? AND enabled = 0');

// Clearing the suppression is what makes an explicit re-enable stick: leave the
// row and the next CSV upload would turn the contact straight back off, which
// reads as the app ignoring the operator.
function enable(phone) {
  const d = normalizePhone(phone);
  if (!d) return false;
  const rows = enableQ.run(d).changes;
  const lifted = unsuppressQ.run(d).changes;
  return rows + lifted > 0;
}

const touchMessaged = db.prepare('UPDATE contacts SET last_messaged = ? WHERE phone = ?');
const markMessaged = (phone, at = Date.now()) => {
  const d = normalizePhone(phone);
  if (d) touchMessaged.run(at, d);
};

// ── CSV upload ─────────────────────────────────────────────────────────────────
// Returns the provenance row so the route can tell the operator what actually
// happened to their file, rather than only how many contacts came out.
function upsertFromCsv(contacts, { filename = null, skippedCount = 0 } = {}) {
  const now = Date.now();
  let newCount = 0;

  db.exec('BEGIN');
  try {
    for (const c of contacts) {
      if (!getRow.get(c.dialStr)) newCount++;
      // Everything the parser found beyond name and number, kept verbatim. No
      // caller reads it yet; storing it is what stops a later phase needing a
      // re-upload of a file the operator may no longer have.
      const extra = c.fields && Object.keys(c.fields).length ? JSON.stringify(c.fields) : null;
      upsertContact.run(c.dialStr, c.name || c.dialStr, extra, now);
    }
    // The upsert above cannot re-enable anyone — `enabled` is absent from its
    // SET list — but it does INSERT, and an insert of a contact who was deleted
    // after opting out arrives with the default `enabled = 1`. This puts them
    // back off, in the same transaction, before any queue is staged from the
    // list. Inside the transaction on purpose: a crash between the two would
    // otherwise leave a suppressed number enabled.
    reapplySuppression.run();
    const uploadId = Number(insertUpload.run(
      now, filename, contacts.length, newCount, skippedCount).lastInsertRowid);
    db.exec('COMMIT');
    return { uploadId, rowCount: contacts.length, newCount, skippedCount };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const list         = () => allRows.all();
const disabledRows = () => disabledQ.all();

// ── The directory, a page at a time ────────────────────────────────────────────
// Searching and paging in SQL rather than in the browser: this list is the one
// table in the app that grows with the business, and shipping 40k rows to a
// React view to filter them there is a page that gets slower every upload.
//
// % and _ are LIKE wildcards. Unescaped, a search for "50%" matches every row —
// same escape treatment as inbox search, and the reason both use ESCAPE '\\'.
const likeEscape = s => String(s).replace(/[\\%_]/g, c => '\\' + c);

// node:sqlite binds anonymous placeholders strictly by position, so a value
// needed twice is passed twice. Mixing ? and ?2 here throws "column index out
// of range" — see pageOfMessages in services/inbox.js.
const WHERE = `
   WHERE (? = '' OR phone LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
     AND (? = 'all' OR (? = 'enabled' AND enabled = 1) OR (? = 'disabled' AND enabled = 0))`;

const pageQ = db.prepare(`
  SELECT * FROM contacts ${WHERE}
   ORDER BY enabled ASC, name COLLATE NOCASE ASC, phone ASC
   LIMIT ? OFFSET ?`);
const pageCountQ = db.prepare(`SELECT count(*) AS n FROM contacts ${WHERE}`);

const STATUSES = ['all', 'enabled', 'disabled'];

function page({ q = '', status = 'all', limit = 50, offset = 0 } = {}) {
  const term = String(q || '').trim();
  const like = `%${likeEscape(term)}%`;
  const st   = STATUSES.includes(status) ? status : 'all';
  // Clamped rather than trusted: these arrive from a query string, and a
  // hand-edited limit=1000000 is a page that reads the whole table.
  const lim  = Math.min(200, Math.max(1, Number(limit) || 50));
  const off  = Math.max(0, Number(offset) || 0);
  const args = [term, like, like, st, st, st];

  return {
    rows:  pageQ.all(...args, lim, off),
    total: pageCountQ.get(...args).n,
    limit: lim, offset: off, q: term, status: st,
  };
}

// ── Manual edits to one row ────────────────────────────────────────────────────
// The name only. phone is the primary key and the thing every message, queue row
// and thread joins on — editing it would silently orphan all of them, so a wrong
// number is a delete and a re-add, not a rename.
const renameQ = db.prepare('UPDATE contacts SET name = ? WHERE phone = ?');

function rename(phone, name) {
  const d = normalizePhone(phone);
  if (!d) return { ok: false, error: 'That is not a valid phone number.' };
  if (!getRow.get(d)) return { ok: false, error: 'No contact with that number.' };
  const next = String(name || '').trim();
  if (!next) return { ok: false, error: 'Give the contact a name.' };
  if (next.length > 120) return { ok: false, error: 'That name is too long — keep it under 120 characters.' };
  // The name is interpolated into template variables and sent to Meta. Control
  // characters have no business in that string.
  if (/[\u0000-\u001f]/.test(next)) return { ok: false, error: 'A name cannot contain control characters.' };
  renameQ.run(next, d);
  return { ok: true, contact: getRow.get(d) };
}

// Deleting a contact removes them from the customer list and from nothing else.
// The suppressed row stays — that is the whole point of it being a separate
// table — so a later CSV that re-introduces the number brings them back
// disabled. Messages and campaign history are keyed by phone number, not by a
// contacts row, so they are unaffected.
const deleteQ = db.prepare('DELETE FROM contacts WHERE phone = ?');

function remove(phone) {
  const d = normalizePhone(phone);
  if (!d) return { ok: false, error: 'That is not a valid phone number.' };
  if (!deleteQ.run(d).changes) return { ok: false, error: 'No contact with that number.' };
  return { ok: true, phone: d, stillSuppressed: !!isSuppressed.get(d) };
}

function counts() {
  const r = countsQ.get();
  return { total: r.total || 0, enabled: r.enabled || 0, disabled: r.disabled || 0 };
}

// ── One-shot import of opt-outs.json ───────────────────────────────────────────
// Same shape as services/migrate.js: import, then rename the source so a later
// boot has nothing to find. Losing this list silently would be a compliance
// failure, not a cosmetic one, so a file that produced no writes is left where
// it is rather than renamed away behind a "0 imported" success line.
//
// Called from server.js's require.main block, never at require time — it
// defaults to the real FILES paths, and test.js requires the app without
// overriding them.
function migrateOptOuts(files = FILES) {
  if (!fs.existsSync(files.optOuts)) return { imported: 0, skipped: true };

  const numbers = readJSON(files.optOuts, []);
  if (!Array.isArray(numbers) || !numbers.length) {
    log('error', `${files.optOuts} could not be read (or contained nothing) — left in place, NOT imported`);
    return { imported: 0, skipped: false };
  }

  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const n of numbers) if (disable(n, 'opt_out')) imported++;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  fs.renameSync(files.optOuts, `${files.optOuts}.migrated`);
  log('info', `Imported ${imported} opt-out(s) from opt-outs.json into contacts`);
  return { imported, skipped: false };
}

module.exports = {
  REASONS, isDisabled, isEnabled, disable, enable, markMessaged,
  upsertFromCsv, list, disabledRows, counts, getRow: p => getRow.get(normalizePhone(p) || ''),
  page, rename, remove,
  migrateOptOuts,
};

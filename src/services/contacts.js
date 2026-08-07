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
    fields_json = excluded.fields_json
`);

const insertUpload = db.prepare(`
  INSERT INTO csv_uploads (uploaded_at, filename, row_count, new_count, skipped_count)
  VALUES (?, ?, ?, ?, ?)
`);

const getRow      = db.prepare('SELECT * FROM contacts WHERE phone = ?');
const isDisabledQ = db.prepare('SELECT 1 AS hit FROM contacts WHERE phone = ? AND enabled = 0');
const allRows     = db.prepare('SELECT * FROM contacts ORDER BY enabled ASC, name COLLATE NOCASE ASC, phone ASC');
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
  return !!d && !!isDisabledQ.get(d);
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

function disable(phone, reason = 'manual', name = null) {
  const d = normalizePhone(phone);
  if (!d) return false;
  const why = REASONS.includes(reason) ? reason : 'manual';
  // Already off for the same reason: nothing to write, and nothing to log at
  // the caller either. A webhook redelivery of one opt-out tap is not two.
  const before = getRow.get(d);
  if (before && !before.enabled && before.disabled_reason === why) return false;
  disableQ.run(d, name || d, Date.now(), why, Date.now());
  return true;
}

// Re-enabling is always manual — nothing automatic ever turns a contact back
// on, because every automatic path here is a reason to stay off.
const enableQ = db.prepare(
  'UPDATE contacts SET enabled = 1, disabled_reason = NULL, disabled_at = NULL WHERE phone = ? AND enabled = 0');

function enable(phone) {
  const d = normalizePhone(phone);
  if (!d) return false;
  return enableQ.run(d).changes > 0;
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
  migrateOptOuts,
};

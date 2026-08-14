'use strict';
// The message store. node:sqlite is built into Node 22.5+, so this file adds a
// database without adding a dependency and without a native compile step —
// which is the whole reason it is not better-sqlite3. Two previous Linux
// deploys of this project were broken by npm native bindings.
const { FILES } = require('../config');

// Must run before the node:sqlite require below: on Node 20 that require throws
// "Cannot find module 'node:sqlite'", which tells a self-hoster nothing.
// Function declarations hoist, so calling it above the require is safe.
function nodeVersionOk(version = process.versions.node) {
  const [maj, min] = version.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

if (!nodeVersionOk()) {
  console.error(`[FATAL] Node ${process.versions.node} is too old. This app stores messages in SQLite via the built-in node:sqlite module, which needs Node 22.5.0 or newer.`);
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');

// Every statement is IF NOT EXISTS so boot is idempotent and a schema addition
// is a line in this string rather than a migration framework.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
  id           INTEGER PRIMARY KEY,
  received_at  INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  processed_at INTEGER
);

CREATE TABLE IF NOT EXISTS threads (
  wa_id           TEXT PRIMARY KEY,
  name            TEXT,
  unread          INTEGER NOT NULL DEFAULT 0,
  last_inbound_at INTEGER NOT NULL DEFAULT 0,
  last_at         INTEGER NOT NULL DEFAULT 0
);

-- Files uploaded for use as a template header. sha256 is the dedupe key: the
-- same PDF dragged in twice is one row and one file on disk, which also means
-- one Resumable Upload and one media id.
--
-- Two Meta identifiers for the same bytes, and they are not interchangeable.
-- meta_handle (h:…) is what template CREATION requires and is single-use per
-- submission; media_id is what SENDING requires and Meta deletes it at 30 days.
-- A template approved with a handle cannot be sent with that handle, which is
-- why the file needs a row rather than a variable.
CREATE TABLE IF NOT EXISTS media_assets (
  id           INTEGER PRIMARY KEY,
  sha256       TEXT NOT NULL UNIQUE,
  path         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image','video','document')),
  meta_handle  TEXT,
  media_id     TEXT,
  media_id_at  INTEGER,
  uploaded_at  INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Local memory of what WE submitted, not a cache of Meta's copy. Meta stays the
-- source of truth for the status column — the approval poller keeps reading it
-- from Graph. But GET /message_templates returns no display name and no link
-- back to the file on our disk, so without this row a template approved with an
-- attachment cannot find its own attachment.
CREATE TABLE IF NOT EXISTS templates (
  name          TEXT PRIMARY KEY,
  display_name  TEXT,
  language      TEXT NOT NULL,
  category      TEXT NOT NULL,
  header_format TEXT,
  header_text   TEXT,
  header_asset  INTEGER REFERENCES media_assets(id),
  body_text     TEXT NOT NULL,
  footer_text   TEXT,
  buttons_json  TEXT,
  var_count     INTEGER NOT NULL DEFAULT 0,
  status        TEXT,
  created_at    INTEGER NOT NULL
);

-- One list with one switch. Before this table there were two — the CSV array in
-- memory and a flat Set in opt-outs.json — and a person who was in both existed
-- twice with no single row to look at.
--
-- Three things write the enabled column: the customer tapping the quick-reply button
-- ('opt_out'), the operator clicking disable ('manual'), and a hard send failure
-- ('failed_hard'). Keeping the compliance path costs nothing here and losing it
-- is expensive: Meta drops the number's quality rating for messaging people who
-- opted out, and quality gates the tier the warm-up ladder is climbing.
CREATE TABLE IF NOT EXISTS contacts (
  phone           TEXT PRIMARY KEY,       -- normalized dial string, no +
  name            TEXT,
  fields_json     TEXT,                   -- other CSV columns, verbatim
  first_seen      INTEGER NOT NULL,
  last_messaged   INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,                   -- 'manual' | 'opt_out' | 'failed_hard'
  disabled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_enabled ON contacts(enabled);

-- The opt-out, kept apart from the contact it is about.
--
-- contacts.enabled used to be the whole record, which made "delete this
-- contact" and "forget they opted out" the same action — and the next CSV
-- upload then re-created them as enabled and messaged them again. A row here
-- outlives the contacts row on purpose: it is the compliance record, and the
-- contacts row is only the customer list.
--
-- Only an explicit manual re-enable removes a row from this table. Nothing
-- automatic does, because every automatic path into disabled is a reason to
-- stay there.
CREATE TABLE IF NOT EXISTS suppressed (
  phone  TEXT PRIMARY KEY,   -- normalized dial string, no +
  reason TEXT,               -- 'manual' | 'opt_out' | 'failed_hard'
  at     INTEGER NOT NULL
);

-- Provenance. Which upload introduced which contacts, and what the file was.
-- skipped_count is the number this app used to throw away in silence.
CREATE TABLE IF NOT EXISTS csv_uploads (
  id            INTEGER PRIMARY KEY,
  uploaded_at   INTEGER NOT NULL,
  filename      TEXT,
  row_count     INTEGER NOT NULL,
  new_count     INTEGER NOT NULL,   -- rows that were not already contacts
  skipped_count INTEGER NOT NULL    -- rows with no usable phone number
);

CREATE TABLE IF NOT EXISTS campaign_runs (
  id         INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  label      TEXT
);

-- The send queue, on disk. This replaces the contacts array that used to be
-- snapshotted into campaign.json and the S.currentIdx integer that walked it.
--
-- The resume point is DERIVED from what was actually sent rather than saved as
-- a counter. An index that a crash leaves ahead of reality silently skips
-- people, and nothing downstream can tell — the old design's worst failure mode
-- and the reason this table exists at all.
--
-- Rows are written at CSV upload, not at /start: the queue is then durable from
-- the moment the operator has one, so a restart before sending begins loses
-- nothing either.
CREATE TABLE IF NOT EXISTS run_recipients (
  run_id         INTEGER NOT NULL REFERENCES campaign_runs(id),
  phone          TEXT    NOT NULL,
  name           TEXT,
  seq            INTEGER NOT NULL,   -- send order, fixed when the run is built
  wamid          TEXT,               -- set on accept; NULL = not yet attempted
  skipped_reason TEXT,               -- 'disabled' | 'failed' | 'skipped' | 'retry'
  error_code     INTEGER,            -- Meta's code, for the skip report
  attempted_at   INTEGER,
  PRIMARY KEY (run_id, phone)
);
-- Partial index: the pending query is the hot one, and it only ever looks at
-- rows that are neither sent nor skipped.
CREATE INDEX IF NOT EXISTS idx_run_recipients_pending ON run_recipients(run_id, seq)
  WHERE wamid IS NULL AND skipped_reason IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  wamid       TEXT PRIMARY KEY,
  wa_id       TEXT NOT NULL,
  dir         TEXT NOT NULL CHECK (dir IN ('in','out')),
  type        TEXT NOT NULL,
  body        TEXT,
  raw         TEXT,
  at          INTEGER NOT NULL,
  status      TEXT,
  status_at   INTEGER,
  error_code  INTEGER,
  error_title TEXT,
  run_id      INTEGER REFERENCES campaign_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(wa_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_run    ON messages(run_id, status);

CREATE TABLE IF NOT EXISTS media (
  media_id      TEXT PRIMARY KEY,
  wamid         TEXT NOT NULL,
  mime_type     TEXT,
  filename      TEXT,
  file_size     INTEGER,
  sha256        TEXT,
  path          TEXT,
  downloaded_at INTEGER
);
`;

// SQLite has no ALTER TABLE … ADD COLUMN IF NOT EXISTS, and openDb runs on
// every boot, so a bare ALTER would throw "duplicate column name" the second
// time any real deployment started. Reading the current columns first is what
// keeps a schema addition a line of code rather than a migration framework.
function addColumn(d, table, column, decl) {
  const present = d.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!present) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function openDb(file) {
  const d = new DatabaseSync(file);
  // WAL lets the socket broadcast read while a webhook batch writes. It is a
  // no-op on :memory:, which is why the tests still pass against one.
  d.exec('PRAGMA journal_mode = WAL');
  // FULL, not NORMAL: in WAL mode NORMAL fsyncs at checkpoints only, so a
  // committed webhook survives a process crash but not a host crash, power
  // loss, or VM hard-reset — and a lost webhook cannot be re-fetched from
  // Meta's push-only API, so that gap makes the 200 OK a lie. FULL fsyncs on
  // every commit instead: one fsync per webhook batch, which is cheap at
  // single-business volume and is what makes the acknowledgement truthful.
  d.exec('PRAGMA synchronous  = FULL');
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec(SCHEMA);
  // A run records which template it sent, so a thread read months later is not
  // dependent on that template still existing on Meta's side.
  addColumn(d, 'campaign_runs', 'template_body', 'TEXT');
  addColumn(d, 'campaign_runs', 'template_lang', 'TEXT');
  addColumn(d, 'campaign_runs', 'header_asset',  'INTEGER REFERENCES media_assets(id)');
  // Outbound media on an inbox message points at the operator's own upload.
  // Deliberately NOT the `media` table: that one holds what customers sent us,
  // lives in MEDIA_DIR and is swept at 90 days by services/retention.js.
  // Pointing an outbound send at it would put the operator's price list under
  // that sweep and delete it from disk with nothing anywhere to say why.
  addColumn(d, 'messages', 'asset_id', 'INTEGER REFERENCES media_assets(id)');
  // Inbound media carries a verdict, not just bytes. `risk` is the
  // worst-of-three-signals tier from lib/filerisk; `scan_status` is ClamAV's
  // answer. Two columns because they answer different questions — "what kind
  // of file is this" and "do these exact bytes match a malware signature" —
  // and a row can be entirely ordinary on one and infected on the other.
  addColumn(d, 'media', 'risk',           'TEXT');
  addColumn(d, 'media', 'risk_reason',    'TEXT');
  addColumn(d, 'media', 'sniffed_mime',   'TEXT');
  addColumn(d, 'media', 'scan_status',    'TEXT');
  addColumn(d, 'media', 'scan_signature', 'TEXT');
  addColumn(d, 'media', 'scan_at',        'INTEGER');
  // A file fetched to be LOOKED at, not to be kept. It has been scanned and
  // classified like any other — the flag says nothing about safety, only that
  // no operator has yet said "keep this", so the retention sweep removes it in
  // hours rather than in 90 days.
  //
  // DEFAULT 0 is the safe direction for an ALTER on a live table: every row
  // that already exists was saved deliberately, and reads as kept.
  addColumn(d, 'media', 'provisional',    'INTEGER NOT NULL DEFAULT 0');
  // A failure that was about the MOMENT rather than about the number gets
  // rescheduled instead of dropped: skipped_reason = 'retry' plus the wall-clock
  // time it becomes pending again. Both live on the queue row rather than in the
  // loop, because a timer in memory does not survive the restart the retry is
  // most likely to be waiting through.
  addColumn(d, 'run_recipients', 'attempts',    'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'run_recipients', 'retry_after', 'INTEGER');
  // After addColumn, not in SCHEMA: SCHEMA runs first on every boot, so an index
  // naming retry_after would throw "no such column" on any database created
  // before this change — the exact upgrade this file exists to make painless.
  d.exec(`CREATE INDEX IF NOT EXISTS idx_run_recipients_retry
            ON run_recipients(run_id, retry_after)
            WHERE skipped_reason = 'retry' AND wamid IS NULL`);
  // A file an operator deleted while history still pointed at it. The row stays
  // so the template and the sent message can still name what they sent; the
  // bytes are gone. NULL means the file is really here.
  addColumn(d, 'media_assets', 'deleted_at', 'INTEGER');
  // Backfill: every contact disabled before the suppressed table existed. An
  // INSERT OR IGNORE over a table that is usually empty, so it is idempotent and
  // free on every later boot. Without it, the first CSV re-upload after this
  // upgrade would re-enable everyone who had ever opted out.
  d.exec(`INSERT OR IGNORE INTO suppressed (phone, reason, at)
          SELECT phone, disabled_reason, coalesce(disabled_at, first_seen)
            FROM contacts WHERE enabled = 0`);
  return d;
}

// WA_DB_PATH exists so test.js can point at ':memory:' before requiring the app.
// It is not a documented deployment knob.
const db = openDb(process.env.WA_DB_PATH || FILES.db);

module.exports = { db, openDb, nodeVersionOk, SCHEMA, addColumn };

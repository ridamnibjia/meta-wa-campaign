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

CREATE TABLE IF NOT EXISTS campaign_runs (
  id         INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  label      TEXT
);

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
  return d;
}

// WA_DB_PATH exists so test.js can point at ':memory:' before requiring the app.
// It is not a documented deployment knob.
const db = openDb(process.env.WA_DB_PATH || FILES.db);

module.exports = { db, openDb, nodeVersionOk, SCHEMA, addColumn };

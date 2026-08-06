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
  return d;
}

// WA_DB_PATH exists so test.js can point at ':memory:' before requiring the app.
// It is not a documented deployment knob.
const db = openDb(process.env.WA_DB_PATH || FILES.db);

module.exports = { db, openDb, nodeVersionOk, SCHEMA };

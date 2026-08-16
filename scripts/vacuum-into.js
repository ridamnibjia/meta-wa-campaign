'use strict';
// node scripts/vacuum-into.js <source.db> <dest.db>
//
// VACUUM INTO, never `cp wa.db`. In WAL mode the main file is not the database:
// committed transactions live in wa.db-wal until a checkpoint moves them, so a
// copy of wa.db alone is the database as of some checkpoint in the past —
// silently missing the most recent webhooks, which are exactly the ones that
// cannot be re-fetched from Meta's push-only API.
//
// It takes a read transaction, so it is consistent as of the instant it starts
// and does not block the app; it can safely run mid-campaign. It also compacts,
// which is why the output is smaller than the live file.
//
// node:sqlite because the app already requires Node 22.5+ for it — a backup that
// needs the sqlite3 CLI installed is a backup that stops working on a fresh box.
const { DatabaseSync } = require('node:sqlite');

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: node vacuum-into.js <source.db> <dest.db>');
  process.exit(2);
}

// VACUUM INTO takes a string LITERAL — it is one of the few statements that
// accepts no bind parameter — so the path is escaped by hand. Doubling the
// single quote is the whole of SQL string escaping, and the alternative is a
// filename with an apostrophe in it becoming a syntax error at 3am.
const literal = `'${dest.replace(/'/g, "''")}'`;

const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO ${literal}`);

// A copy nobody has read is not a backup. This is the cheapest thing that
// separates "a file exists" from "the file is a database", and it is the check
// that would have caught every silent-corruption story worth telling.
const out = new DatabaseSync(dest, { readOnly: true });
const check = Object.values(out.prepare('PRAGMA integrity_check').get())[0];
if (check !== 'ok') throw new Error(`integrity_check failed: ${check}`);

const n = out.prepare('SELECT count(*) AS n FROM messages').get().n;
const c = out.prepare('SELECT count(*) AS n FROM contacts').get().n;
console.log(`verified — ${n} messages, ${c} contacts`);

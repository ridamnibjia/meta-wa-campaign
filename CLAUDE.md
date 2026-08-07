# CLAUDE.md

A self-hosted WhatsApp Cloud API campaign manager for one business. Node 22.5+,
four dependencies, no build step.

Every session starts cold without this file. It records the decisions that are
not visible in the code, and the ones that look like they could be changed but
should not be.

## Running it

```bash
npm start          # node server.js
npm test           # node test.js — no framework, no fixtures
npm run dev        # node --watch server.js
```

`npm test` is the whole suite and takes about four seconds. Run it before every
commit. It uses an in-memory database and temp directories, so it never touches
the repo's own state files.

## Layering

```
routes → services → lib → config
```

Enforced by convention and worth keeping: **nothing in `lib/` knows about
Express, nothing in `services/` knows about HTTP, and `config.js` imports
nothing.** That is what lets `test.js` call the real logic with no server and no
mocks.

`lib/` must not import `lib/db`. When a pure helper needs a database answer, pass
it in — `billableCount(contacts, isDisabled)` takes a predicate for exactly this
reason.

`server.js` is wiring only. It re-exports the service surface so `test.js`
imports from one place.

## The database

`node:sqlite`, built into Node 22.5+. **Not `better-sqlite3`** — two previous
Linux deploys of this project were broken by npm native bindings, and a
self-hoster hitting a native compile failure has no way to diagnose it.

Schema lives in one `SCHEMA` string in `src/lib/db.js`, every statement
`IF NOT EXISTS`, so boot is idempotent and a schema addition is a line of code
rather than a migration framework. New columns on existing tables go through
`addColumn()`, which reads `PRAGMA table_info` first because SQLite has no
`ADD COLUMN IF NOT EXISTS`.

`SCHEMA` is a JavaScript template literal. **Do not put backticks in the SQL
comments** — they terminate the string, and the error you get points at the
comment rather than at the cause.

Pragmas: `journal_mode = WAL`, `synchronous = FULL`, `busy_timeout = 5000`.
FULL rather than NORMAL is deliberate: NORMAL fsyncs at checkpoints only, so a
committed webhook survives a process crash but not a power loss — and a lost
webhook cannot be re-fetched from Meta's push-only API, which would make the
200 OK a lie.

### Tables

| Table | Holds |
|---|---|
| `webhook_events` | Raw envelopes, written before the 200 OK. `processed_at IS NULL` means it needs replay. |
| `threads` | One per `wa_id`. `last_inbound_at` drives the 24-hour window. |
| `messages` | Both directions. `wamid` primary key is the dedupe. |
| `media` | Inbound descriptors, and bytes once an operator saves them. |
| `media_assets` | Outbound template header files, deduped on sha256. |
| `templates` | What we submitted. Meta stays the source of truth for `status`. |
| `contacts` | The customer list and the one `enabled` switch. |
| `csv_uploads` | Provenance: what each upload did, including rows it could not read. |
| `campaign_runs` | One per upload/start. Scopes every derived counter. |
| `run_recipients` | The send queue on disk. Resume point is derived from it. |

## Decisions that look changeable but are not

**Counters are derived, never incremented.** `countsForRun()` is a `GROUP BY`
over `messages`. There is no integer anywhere that can disagree with the rows it
counts. Do not add one back.

**`countsForRun(null)` returns zeroes.** `run_id IS NULL` is not "no campaign" —
it is the bucket inbox replies and migrated legacy rows deliberately land in.
Querying it for a null run reports every reply as campaign traffic.

**The resume point is a query, not a counter.** `run_recipients` is walked with
`WHERE wamid IS NULL AND skipped_reason IS NULL ORDER BY seq LIMIT 1`. The
recipient row is stamped *before* the message row, so the residual risk is one
duplicate message — never an omission. The previous design saved an index, and
an index a crash leaves ahead of reality silently skips people.

**The CSV upsert does not touch `enabled`.** Re-uploading a file must never
resurrect someone who opted out. The requirement is an *absence* in the
`ON CONFLICT DO UPDATE` set list, which is exactly the kind of thing a future
contributor "fixes" by adding `enabled = excluded.enabled`. There is a test.

**Disabled blocks campaigns only.** `services/inbox.js` does not import
`services/contacts.js` and a test asserts it never will. Someone who opted out of
promotions and then writes in with a question still deserves an answer, and
answering them is not a marketing message.

**Media risk is the worst of three signals.** `lib/filerisk.js` combines the
declared mime, the extension and the actual bytes; the worst verdict wins.
Forging a `safe` verdict requires actually being the harmless thing. `safe` is
the only tier that renders inline, and it needs positive evidence from all three.

**Inline rendering needs two gates that agree.** `effectiveRisk()` must say
`safe` *and* the mime must be on `INLINE_SAFE` in `routes/media.js`. One is
derived from evidence, the other is a list somebody wrote down, and a bug in
either alone should not put a customer's file in an `<img>` on this origin.

**Saved media files are named by content hash**, so identical bytes from two
messages are two rows over one file. Nothing may unlink a file without checking
`pathIsShared()` first — see the retention sweep and `rescanIfNeeded`.

**`Number(x) || fallback` cannot express zero.** `src/config.js` has a `num()`
helper for this. `WA_MEDIA_MIN_FREE_BYTES=0` is a legitimate setting.

**Replay is idempotent by construction.** `messages` dedupes on its primary key,
`applyStatus` only moves a status forward, `disable()` is a no-op when already
off for that reason. That is the only reason the Diagnostics replay button can
exist. Do not add a non-idempotent write to `processEnvelope`.

## Gotchas

- **`node:sqlite` binds anonymous `?` placeholders strictly by position.**
  Mixing `?` and `?2` in one statement throws "column index out of range".
  Repeat the value instead — see `pageOfMessages` in `services/inbox.js`.
- **Escape `%` and `_` in LIKE patterns.** Unescaped, a search for `50%` matches
  every row.
- **Pagination cursors are `(at, rowid)`, not `at`.** Meta timestamps in whole
  seconds, so ties are routine, and an `at`-only cursor silently drops every
  message that ties with a page boundary.
- **Route order is a security boundary.** `/webhook` mounts before `requireAuth`;
  everything after it is protected by default. Also mount specific paths before
  parameterised ones — `/inbox/search` before `/inbox/:waId`.
- **`migrateJsonToSql` and `migrateOptOuts` rename their source files.** They run
  only under `require.main === module` in `server.js`. Never call them at require
  time, or `npm test` renames the repo's own state files.
- **The Resumable Upload API keys on `APP_ID`**, not the WABA id. Its second call
  needs `Authorization: OAuth`, not `Bearer` — the one documented exception in
  the whole Graph surface.
- **Template creation needs an `h:…` handle; sending needs a `media_id`.** Same
  bytes, two identifiers, not interchangeable. Meta deletes media at 30 days.
- **Frontend scripts share one global scope** and load in the order listed in
  `index.html`. A `const` used by two views belongs in `ui.jsx`, which loads
  first.

## Conventions

- Comments explain **why**, not what. If a line looks removable and is not, the
  comment says what breaks.
- Errors returned to routes are `{ ok: false, error }` objects, never throws —
  every caller has to turn the failure into a sentence an operator can act on.
- Error messages name the fix, not just the fault. `lib/errors.js` maps Meta's
  numeric codes to "what happened — what to do".
- `ponytail:` marks a deliberate simplification and names its ceiling and
  upgrade path.
- Tests assert behaviour, and the assertion message says why it matters.
- **Commits carry no `Co-Authored-By` trailer.**

## Public repo

This repository is public and is the subject of a YouTube explainer. History was
rewritten once with `git filter-repo` to purge real data.

- No real phone numbers or names. Fixtures use `9000000001`+ and names like
  Asha / Rahul / Marco / Sarah.
- No real Meta IDs or tokens in `src/config.js` fallbacks — they default to `''`.
- `docs/` is gitignored on purpose. The public docs are `README.md`,
  `CSV-FORMAT.md` and this file.
- `*.csv` is gitignored except `contacts-template.csv`.
- The deployment URL and hosting details are not mentioned publicly.

## Known open items

- `skipDisposition()` in `src/lib/errors.js` has no body. It is a policy call
  reserved for the maintainer. Until it returns something, the skip report shows
  every failed send under "Not yet classified" rather than guessing.
- `scanBuffer` holds the whole file in memory. Backpressure is handled, so the
  cost is one copy rather than two, but true streaming to clamd is still future
  work.
- Outbound uploads in `saveUpload` trust the browser-supplied mime type and do
  not run `classify()`. The uploader is the authenticated operator and the mime
  allowlist excludes script-capable types, so this is low risk — but it is the
  one path the file-risk engine does not cover.

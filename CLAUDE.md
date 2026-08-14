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
| `media` | Inbound descriptors, and bytes once an operator asks. `provisional` = previewed, not yet kept. |
| `media_assets` | Operator uploads — template headers and inbox sends, deduped on sha256. Never swept. |
| `templates` | What we submitted. Meta stays the source of truth for `status`. |
| `contacts` | The customer list and the one `enabled` switch. |
| `csv_uploads` | Provenance: what each upload did, including rows it could not read. |
| `campaign_runs` | One per upload/start. Scopes every derived counter. |
| `run_recipients` | The send queue on disk. Resume point is derived from it. |

## Decisions that look changeable but are not

**Counters are derived, never incremented.** `countsForRun()` is a `GROUP BY`
over `messages`. There is no integer anywhere that can disagree with the rows it
counts. Do not add one back.

**`campaign_runs` has no `ended_at` and no `status` column, deliberately.**
Ended-at is `max(attempted_at)` over that run's `run_recipients`; status is
derived from what is left pending — `in-progress`, `completed`, `incomplete`. A
stored `ended_at` would need writing on the normal finish, on Stop, on the ladder
exhausting and after a crash-and-resume: four places to forget, and a forgotten
one shows a campaign that never ended. Same rule as the counters, and there is a
test asserting neither column ever appears. `ponytail:` "incomplete" cannot tell
a campaign the operator stopped from one a crash abandoned — both leave pending
rows on a run nothing points at. The label is honest either way; if that
distinction ever drives a decision, add a `stopped_at` written by `/stop` alone.

**`runDetail` returns null for an unknown id, never the current run.** A stale
bookmark that quietly renders a different campaign reads as an answer, and the
operator acts on it. The route turns null into a 404.

**The read count undercounts, and the UI must keep saying so.** WhatsApp only
sends a `read` status when the recipient has read receipts switched on. Presented
as a plain open rate it is a number an operator would make real decisions on, and
it is not that number — delivered is. `STATUS_RANK` already counts a `read` that
arrives with no preceding `delivered` as both, because Meta does not promise
status order. Do not remove the caveat from the History view to tidy it up.

**`countsForRun(null)` returns zeroes.** `run_id IS NULL` is not "no campaign" —
it is the bucket inbox replies and migrated legacy rows deliberately land in.
Querying it for a null run reports every reply as campaign traffic.

**The resume point is a query, not a counter.** `run_recipients` is walked with
`WHERE wamid IS NULL AND (skipped_reason IS NULL OR (skipped_reason = 'retry' AND
retry_after <= ?)) ORDER BY seq LIMIT 1`. The recipient row is stamped *before*
the message row, so the residual risk is one duplicate message — never an
omission. The previous design saved an index, and an index a crash leaves ahead
of reality silently skips people.

**The retry deadline is a column, not a timer.** A failure `skipDisposition()`
calls `retry` gets `skipped_reason = 'retry'` plus `retry_after`, and becomes
pending again by widening the query above — not by a second queue the loop has to
merge, and not by a `setTimeout` that a restart forgets. `attempts` is
incremented in SQL for the same reason: read-modify-write in JS hands the contact
a free extra attempt on every crash. Five waits of three hours, so six attempts.
`retrying` is counted apart from `skipped` — folding it in would report a run
finished with people still owed a message, which is the leak the ladder exists to
close.

**Five rungs, not three, and never zero failures.** It was 1h → 2h → 4h. That is
too short for the failure it mostly absorbs: **131049 is Meta's per-user
marketing cap — a rolling, per-person window counted across every business that
messages that person**, not a counter that resets at midnight. Seven hours of
retries closed runs with hundreds still owed a message, and the only way to reach
them was re-uploading the CSV, which opens a new run and messages everyone twice.
It is not longer than five because **no ladder reaches zero on 131049**: the cap
belongs to the recipient, not to the attempt. Reaching those people reliably
means the 24-hour service window — a template that invites a reply, then a
free-form send — which is what `sendMedia` exists for. Do not re-shorten this
ladder, and do not expect it to zero the failures on its own.

**Quiet hours are a deferral, applied before the row is written.**
`lib/schedule.js` pushes any deadline landing 23:00–07:00 IST to 08:00. Night
notifications are what recipients block and report, and that feeds the quality
rating which gates the messaging tier. It is applied inside `scheduleRetry`
before `retry_after` is stored, because that column is both what `nextPending`
compares against and what the operator is shown — nudging the deadline anywhere
else leaves the queue and the screen disagreeing. The 07:00–08:00 gap is grace,
not an oversight: a whole night of deferred retries comes due at one instant, and
releasing that herd at 07:00 sharp releases it while people are still asleep. The
wrap-across-midnight branch is load-bearing — a plain range check is wrong, and
there is a test for a non-wrapping window that proves it.

**The phase string is `waiting`; every label says "In progress".** State and
presentation are allowed to differ. `ACTIVE_PHASES`, `campaignBlocker()` and
`resumeIfInterrupted()` all match on the string. Renaming it to match the label
silently changes what a second Start is refused on, which is how the
two-loops-on-one-queue double send got in before. The label changed because the
ladder now runs for up to a day, and an operator who reads "waiting" assumes the
campaign is stuck and presses Stop — abandoning exactly the contacts it exists to
recover.

**`flags.running` is owned by the loop.** It means "a loop is executing", and only
`startLoop()` and the loop's own exit may write it. Routes set `stopFlag` /
`pauseFlag`, which are *requests*. Three routes used to set `running = false`
themselves, which made `campaignBlocker()` believe a loop that was still inside an
`await` had finished — long enough for a Start to put a second loop on the same
queue and message people twice. A `waiting` phase made that window hours long.

**One campaign at a time, enforced server-side.** `campaignBlocker()` guards both
`/api/start` and `/api/upload-csv`, because `stageRun` *replaces* `run_recipients`
and an upload opens a new run: uploading mid-flight orphans everyone the live run
had not reached, including everyone parked on the retry ladder. The UI says so
too, but the server is the one that counts — a second tab or a curl is otherwise
enough.

**`skipDisposition` is a whitelist in both directions.** A code has to be named
to be retried, and named to be given up on; anything unlisted is `unclassified`,
which never retries and is reported with its raw code. A new Meta code must not
silently cost re-sends, nor silently write a customer off. `-1` is ours, not
Meta's — fetch threw, so there is no Meta response to carry a code — and it sits
in `META_ERRORS` only so the report stops telling operators to look it up in
Meta's reference, which will never list it.

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

**PDF is the one exception, and it is deliberately narrow.** `classify()` caps a
PDF at `ok` — correctly, it is a document format with a scripting engine behind
it — so it can never reach `safe`, and operators were downloading invoices to a
desktop reader to find out whether they were the invoice. The rule that lets it
preview reads `bare === 'application/pdf' && row.risk === 'ok' && risk === 'ok'`:
the **raw** column, because a NULL tier also reads as `ok` and a row nothing ever
classified has a default rather than evidence; and the effective tier, because an
oversize scan must still take the preview away. What makes it affordable is the
`Content-Security-Policy: sandbox; default-src 'none'` this route already sent on
every response — a unique opaque origin, so the viewer cannot reach this origin's
cookies. Verified rendering in Chrome under that header. Do not widen this to
`risk === 'ok'` generally; there is a test for each edge.

**Saved media files are named by content hash**, so identical bytes from two
messages are two rows over one file. Nothing may unlink a file without checking
`pathIsShared()` first. `dropBytes()` in `services/media.js` is the only place
that unlinks inbound bytes, and it holds both guards — the sibling check and the
"does this path resolve inside MEDIA_DIR" check. Three callers need them (the
90-day sweep, the preview sweep, Discard); a second copy is a second thing to
get wrong.

**Two media stores, two lifetimes, never mixed.** `media` holds what customers
sent us, lives in `MEDIA_DIR`, and is swept at 90 days. `media_assets` holds what
the operator uploaded, lives in `UPLOAD_DIR`, and is **never** swept. An outbound
message links through `messages.asset_id` to `media_assets` — never through the
`media` table, which would put the operator's price list under the retention
sweep and delete it from disk with nothing anywhere to say why. There is a test
that ages an inbound file past the cutoff, runs the sweep for real, and asserts
`UPLOAD_DIR` is untouched.

**Storage is managed by the operator, and the two stores are not symmetrical.**
`services/storage.js` lists both, but what it will *do* to them differs by owner.
An upload is ours: deletable when nothing references it, renameable. A customer
file an operator chose to **Save** cannot be deleted from the Storage page at
all — the UI promised a retention window, and a promise that can be cancelled
early on a whim is not a retention window. It goes when the sweep says. The only
lever offered is running that sweep early, which removes solely what is already
past its cutoff. A **previewed** file is deletable because nothing ever committed
to it. Bulk selection is a convenience, never a way past a refusal: `removeMany`
puts every item through the same per-item guard a single delete uses and reports
per-item outcomes. Nothing in `storage.js` unlinks anything itself — it delegates
to `deleteAsset` and `discardInbound`, which hold the containment and sibling
guards.

**Renaming touches the display name and nothing else.** `sha256`, `path` and the
bytes are untouched, so dedupe still works and every campaign that already
reported sending an asset still reported the truth. Slashes and control
characters are refused because that string is sent to Meta as a document
filename. Inbound files are not renameable at all: the name is part of what the
customer sent.

**`saveUpload` runs `classify()` and refuses the `block` tier only.** The
uploader is the authenticated operator, but an authenticated operator can be
handed a file and asked to forward it, and this path reaches every dealer on the
list. Only the worst tier is refused because a PDF caps at `ok` by design and is
the most common thing this business sends — anything stricter blocks the job the
app exists to do. ClamAV deliberately does **not** run here: it runs on the
inbound path where the bytes are a stranger's, and a clamd outage must not stop
an operator sending a price list.

**`sendMedia` is a sibling of `sendReply`, not a flag on it.** Same 24-hour
window gate, same `{ ok, error }` contract, but the failure modes differ — an
asset can have been deleted and Meta's media id can have expired — and folding
them together makes one function's error handling answer for two jobs. It is
also the half of the 131049 answer the retry ladder cannot give: the per-user
marketing cap does not apply inside the service window. Outbound media is its own
key (`outMedia`) in the transcript, because inbound carries a risk verdict, a
30-day expiry and a Keep/Discard decision, and not one of those means anything
for a file the operator uploaded themselves.

**Preview and Save are the same fetch on different clocks.** `saveInbound(id,
{ provisional: true })` runs every check a Save runs — size cap, free space,
checksum, ClamAV, `classify()` — because the risk is in the file and not in the
button that asked for it. `media.provisional` changes exactly one thing: which
cutoff `sweepMedia` applies. Do not let it come to mean "less trusted", and do
not add a path that renders bytes before the scan — the reason Preview exists at
all is that an operator cannot decide whether to keep a file without seeing it,
and cannot see it while it is still on Meta's servers behind a token the browser
does not have. `ALTER TABLE` defaults it to `0` so every row that predates it
reads as kept. `discardInbound` refuses a kept file outright.

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
- **Meta states one media `sha256` in two encodings.** The webhook envelope
  carries **base64** (`/ZYvm28…D6xw=`); `GET /{media-id}` carries **hex**
  (`fd962f9b…43eb1c`). Same 32 bytes. `sha256Hex()` in `services/media.js`
  normalises before comparing, and every comparison must go through it. The
  original code compared the preferred webhook value against a hex digest, so it
  refused **every** inbound file on every deployment that had one — and the test
  suite missed it for 400+ tests because the fixtures seeded hex. If you write a
  media fixture, seed base64: that is what production sends.
- **The Resumable Upload API keys on `APP_ID`**, not the WABA id. Its second call
  needs `Authorization: OAuth`, not `Bearer` — the one documented exception in
  the whole Graph surface.
- **Template creation needs an `h:…` handle; sending needs a `media_id`.** Same
  bytes, two identifiers, not interchangeable. Meta deletes media at 30 days.
- **Frontend scripts share one global scope** and load in the order listed in
  `index.html`. A `const` used by two views belongs in `ui.jsx`, which loads
  first.
- **React, Babel and Tailwind are vendored in `public/vendor/`, not on a CDN.**
  This dashboard holds a session cookie and a Meta token that can spend money, so
  a compromised unpkg would own both. Committing the prebuilt files keeps the
  no-build-step property *and* removes the supply chain — do not "tidy" them back
  into `<script src="https://…">`. Versions are pinned in the filenames' own
  provenance: React 18.3.1, Babel standalone 7.28.4, Tailwind CDN 3.4.16. Babel
  must stay on 7 — 8 defaults JSX to the automatic runtime, which emits an ESM
  `import` that Babel standalone cannot execute as a classic script.

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

- `skipDisposition()` is written, but its tables are a policy call, not a
  reference: adding a code to `RETRY` costs re-sends if it was wrong, and adding
  one to `PERMANENT` quietly writes a customer off. Unlisted codes stay
  `unclassified` on purpose.
- `scanBuffer` holds the whole file in memory. Backpressure is handled, so the
  cost is one copy rather than two, but true streaming to clamd is still future
  work.
- Inbox media sends one thread at a time. Sending one file to several
  conversations at once needs its own queue, per-recipient reporting and
  per-contact window filtering, which starts to be the campaign loop's job. The
  library already makes the file free to reuse, so the saving would only be in
  clicks.

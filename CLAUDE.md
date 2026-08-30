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
| `suppressed` | The opt-out, kept apart from the contact it is about, so it outlives a deleted row. |
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

**`countsForRun` counts people, not rows.** It used to be `count(*)` over
`messages`, which was the same thing while one contact meant one outbound row per
run. The webhook retry ladder below breaks that: a contact Meta accepted and then
refused gets a second send, so `accepted` read 6 on a run of 5 and the recovered
contact sat in `failed` beside their own `delivered`. The query groups by `wa_id`
and takes each contact's best outcome, with `failed` ranked *below* every other
status — the opposite of `STATUS_RANK`, deliberately. That rank is about one
wamid, where a failure is terminal and a later `delivered` for it is a stale
redelivery; this one is about one person across several attempts, where any
attempt that landed is the answer.

**The bucket rule is ONE SQL string, and the list is filtered on it.**
`BUCKET_CASE` in `services/messages.js` is interpolated into both `funnelQ` (the
counts) and `recipientsQ` (the contacts), and the half SQL cannot express —
`gaveUp` splitting into `failed` vs `unreachable` by `skipDisposition` — is
`bucketOf()`, which both call. So clicking "12 failed" in History filters on the
identical rule that produced the 12. A second hand-written CASE, or the view
re-deriving an outcome from `skipped_reason` and `status` the way `history.jsx`
used to, is how a list quietly stops matching the number above it. The Funnel
component asserts both invariants on screen: the buckets summing to `total`, and
each opened list's length matching its own count. There is a test that groups
`recipientsForRun` by bucket and compares it to `funnelForRun` field by field.

**`S.failed` is gone — Failed comes from the queue only.** It was an in-memory
integer the loop incremented, and `buildState` did `S.failed + c.failed`: a
counter plus a count over `messages`, with the same contact inside both, because
an API refusal is ALSO written to the queue as `skipped_reason = 'failed'`. The
tile over-reported, and a restart zeroed the integer while the rows still
remembered. `buildState().failed` is now `funnel.failed`, with `unreachable`
beside it rather than folded in. That does mean the tile counts only contacts
that have a `run_recipients` row: a failed *test send* is not a campaign contact
and no longer appears there, which is correct. Do not add the counter back.

**The app must not suggest re-sending marketing copy as UTILITY.** Both
`errors.js` (131049) and the skip report used to. The category describes what the
message IS — transactional content the customer is expecting — not which cap it
avoids; promotional copy submitted under it is category misuse, which Meta
re-categorises or rejects, and repeat offences cost the quality rating that gates
the messaging tier. The retry ladder is the answer to 131049 and it is already
running. Say that instead.

**`funnelForRun` is the one set of numbers on screen that DOES add up.** Every
row in `run_recipients` lands in exactly one bucket — `delivered`, `sent`,
`pending`, `retrying`, `failed`, `unreachable`, `optedOut` — and they sum to
`total`, which is the CSV. It exists because the stat tiles could not answer
"what happened to my list": `failed` and `retrying` sat side by side with no way
to tell whether one contained the other (it does not), and there was nowhere at
all for the contacts nothing would even attempt. `read` is deliberately shown
*inside* `delivered` rather than beside it, and is the only figure on the card
that is a subset rather than a slice — counting it as its own bucket would make
the rows miss `total` by exactly the number of people with read receipts on. The
Dashboard and History both render it from `ui.jsx:Funnel`, and that component
asserts the sum out loud rather than trusting it. `unreachable` gathers both
halves of one fact: a contact attempted here who came back `131026`, and one an
*earlier* run already switched off with `failed_hard` and so was never attempted.
Which codes qualify is `skipDisposition`, never a second list.

**Today's send count is a query, and a refused send hands its slot back.**
`S.dailyCount` is gone. `warmup.js:dailyCount()` is `sentSince(startOfIstDay())`,
a `GROUP BY wa_id` over `messages` that drops any contact whose every send today
is `failed`. Meta accepts most sends with a 200 and refuses minutes or hours
later over the status webhook — that is how 131049 and most quality blocks
actually arrive — and the incremented counter had already spent that slot
permanently: a day of 800 accepts with 200 refusals parked the loop overnight on
600 real messages. Counted per CONTACT, not per row, because the retry ladder
writes a second outbound row for the same person and Meta's own limit is on
unique recipients per 24h. It filters `type = 'template'`: `services/inbox.js`
writes free-form replies into the same table, those go out inside the 24-hour
service window, are not marketing, and Meta does not count them against the
messaging tier this cap exists to respect — answering a customer must not spend a
campaign's allowance. `sendingDays()` filters the same way for the same reason.
`/api/reset` deliberately does **not** zero the count: a Reset is an operator
tidying their screen, not a claim that today's messages never went out.

**The warm-up ladder ENDS, and graduation is asked of the RUNG, not the day
count.** `graduated()` is `rawStep() >= WARMUP_PLAN.length && quality is not
RED/YELLOW`, and `warmupCap()` then returns null. It was
`W.days.length >= WARMUP_PLAN.length`, which was off by a whole rung:
`markWarmupDay()` appends today after the FIRST send of the day, so on the top
rung's own day the length reached the plan length one message in and the ceiling
lifted for the rest of that day — the real ladder was 20 → 50 → 100 → 250 → 500
→ uncapped, which is not the ladder the README documents. `rawStep()` is
`warmupStep()` before the clamp, and it is unclamped precisely so the value past
the last rung can distinguish "the top rung, today" from "the ladder is behind
us"; clamping first made those two indistinguishable. There is a test for the top
rung holding for its whole day. The ladder's job is to prove a
new number sends steadily; once it has, Meta's messaging tier is the real limit
and a homemade 1000 on top of it refuses campaigns the account is entitled to
send, with nothing on screen saying which cap said no. It is re-checked every
call, not persisted, so a quality slip puts the number back — falling quality is
exactly when volume should come down. Nothing about it is per-account: every
install still walks the full ladder from rung one, and there is no business's
number written down anywhere in this repo. `S.config.dailyCap = 0` is the
operator's own "no cap", and `effectiveCap()` returns null when neither applies —
**null is no ceiling, not zero**, and every view must render it as such, because
`num(null)` is `"0"` and reads as a cap that blocks every send. The config route
uses an explicit presence check rather than `if (dailyCap)` for the same reason.

**The app ships with `dailyCap: 0`, and the tile names the cap actually in
force.** The default was `1000` — a number this repo invented, not one any
operator chose — and `campaign.json` persists it on the first save, so it
outlived the warm-up ladder it was shadowing. Production ran for weeks showing
`0 / 1,000` under the caption "Warm-up complete — Meta's tier is the limit now":
two true sentences and one impossible screen, with campaigns stopping at a
thousand and nothing anywhere naming what stopped them. `effectiveCap()` was
right throughout; the caption printed the warm-up sentence whatever the number
above it was. `dashboard.jsx` now derives `capSource` from `config.dailyCap`
against the published cap and says which ceiling won — your own cap (the only one
that screen can turn off), today's warm-up rung, or none at all. There is a test
that re-requires `src/state.js` from a pristine module cache to assert the
shipped default, because every other test writes to the shared `S`. A cap the
operator never chose is a cap they cannot find to turn off.

**`warmup.json` is reconciled against the message rows at every boot.**
`reconcileWarmupDays()` merges the distinct IST send-days in `messages` into
`W.days`. That file is the smallest and most losable thing in a deployment — it
is not in the database backup a self-hoster actually takes — and losing it put a
number that had been sending for months back on rung one at 20 a day, with
nothing explaining why every campaign suddenly stopped at 20. It merges rather
than replaces (either source knowing about a day is evidence the day happened)
and is idempotent. A day whose every send Meta refused is not a sending day: it
is no evidence the number sends steadily, which is the only thing the ladder
measures.

**One place decides that a number is undeliverable.**
`campaign.js:suppressIfPermanent()` is called by all three paths that can learn
it — the send response, the delivery-failure webhook, and a test send — so none
of them can grow its own idea of which codes mean "not on WhatsApp". It routes
through `skipDisposition() === 'permanent'` and `disable(…, 'failed_hard')`,
which writes both the `contacts` row and the `suppressed` row and is a no-op when
the contact is already off for that reason, so webhook redeliveries and envelope
replays cost nothing. The suppression outlives the contacts row, so re-uploading
the CSV brings the person back already switched off.

**Pause / Resume / Stop live in a sticky bar at the top of the Campaign screen,
and are not repeated in step 3.** They used to exist only at the bottom of a
column that grows a template composer, a preview and a skip report above them —
a scroll away from the one control an operator wants in a hurry, and "I could not
find Stop" is measured in messages sent. Two copies would be two things to keep
in step; the bar renders only while a campaign is actually under way.

**Every number on a screen comes from the funnel, and `countsForRun` renders
nowhere.** The Dashboard tiles and the breakdown card under them used to be
split — `accepted`/`delivered`/`read` from `countsForRun` (the `messages` table)
beside `failed`/`unreachable` from `funnelForRun` (the queue) — so a tile could
disagree with the row directly beneath it, and did. The everyday way in is a test
send: `/api/test-send` stamps its message row with the current run *deliberately*,
so the operator watches accepted → delivered → read in front of them, but it
stages no `run_recipients` row. That moved the top three tiles and nothing else.
`pricing.spent` had the same split against an estimate derived from the queue.
Both now read the funnel. `buildState` still publishes `accepted`/`delivered`/
`read` because "what has this number actually sent" is a real question and
`countsForRun` is the only thing that answers it — but nothing renders them, and
nothing new should. `Funnel`'s `live` prop is the same rule for wording: a parked
retry row looks identical whether a loop is about to pick it up or the campaign
was stopped an hour ago, so History passes `status === 'in-progress'` rather than
letting the card guess.

**Never add a message count to a queue count.** `countsForRun` counts contacts in
`messages`; `progressForRun` counts contacts in `run_recipients`. The same
failure appears in both — a webhook failure is inside `accepted` *and* inside
`failed`; an API refusal is inside
`S.failed` *and* inside `skipped`, because it is written to the queue as
`skipped_reason = 'failed'`. The dashboard summed them and read "74 of 57
processed, 130%". Anything meaning "contacts attempted" reads `currentIdx`
(`p.attempted`) — one table, one question.

**`currentIdx` counts contacts ATTEMPTED, and that is the only figure here that
cannot go down.** It was `p.sent + p.skipped`, which the webhook ladder walks
backwards: `requeueAfterDelivery` nulls the wamid so `nextPending` can see the
row again, the contact leaves `sent`, and the `[663/775]` in the log and the
progress bar on two screens counted *down* while the run was going forwards —
which reads as the loop starting over. `progressForRun().attempted` is
`sent + skipped + retrying`, and it is monotonic because a row leaves "never
tried" exactly once and can never return to it. The loop's own index adds one
only for an untried row (`c.skipped_reason` is what `nextPending`'s two halves
are told apart on), so a contact on their second go is not counted twice and the
index can never pass the total. What is still owed to a requeued contact is
`retrying`, which every screen already renders beside this number — do not fold
it into the bar as well, and do not "fix" the bar back to counting resolutions.

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
a free extra attempt on every crash. The rung heights come from
`backoffFor(code)` — three hours apart by default, a day apart for 131049.
`retrying` is counted apart from `skipped` — folding it in would report a run
finished with people still owed a message, which is the leak the ladder exists to
close.

**Two ladders, not one, and 131049's is day-scale.** The ladder was five rungs
of three hours for every retryable code, and for 131049 that was actively
harmful: **131049 is Meta's per-user marketing cap — a rolling, per-person
window counted across every business that messages that person**, and Meta's
own per-user-limits page says wait AT LEAST 24 hours before resending AND that
repeated resends inside a 24-hour window can extend the block by up to another
24 hours. Five retries in fifteen hours was hammering the cap it was retrying.
`backoffFor(code)` in `services/campaign.js` now hands BOTH entrances the
code's own ladder: 131049 gets three rungs of 24h (the industry norm — WATI
retries daily for up to 7 days, Gallabox 24/12/12, WANotifier and QuickReply
3×24h), 131048 (the sender-level spam throttle) gets 4h/12h/24h, and everything
else keeps the default five rungs of three hours. Do not shorten either ladder,
and do not expect any ladder to zero 131049: the cap belongs to the recipient,
not to the attempt. Reaching capped people reliably means the 24-hour service
window — a template that invites a reply, then a free-form send — which is what
`sendMedia` exists for.

**The ladder has two entrances, and the webhook one is the busy entrance.** Meta
answers most sends with HTTP 200 and a wamid and only refuses to deliver minutes
or hours later, over a `statuses[].status = 'failed'` webhook. `scheduleRetry`
only ever saw the send-time half, so the code the ladder was lengthened *for*
almost never reached it: the run closed "5 of 5 sent, 1 failed" and that contact
was never tried again. `applyStatus` now returns a descriptor on the transition
into `failed` and `services/ingest.js` hands it to `handleDeliveryFailure` in
`services/campaign.js` — the descriptor, not the decision, because
`services/messages.js` does not import the loop. It un-stamps the `wamid` so
`nextPending` can see the row again, which is the only thing that makes a
resolved row pending. It runs on the webhook thread and never interrupts the
loop: a campaign still sending reaches everyone untouched first and picks the
parked failures up when their deadline comes due. A run that already ended is
restarted, gated on `S.phase === 'done'` — the one phase that means the loop ran
out of work by itself. A Stop leaves `idle` and a Reset drops the run id, and a
webhook must not resurrect a campaign the operator ended.

**The ladder only reopens the CURRENT run.** `handleDeliveryFailure` returns
`stale` when `runId !== S.currentRunId`, before it touches the queue. Only
`S.currentRunId` has anything walking it: a campaign finishes, the operator
uploads a new CSV — which opens a new run and makes it current — and then a late
failure webhook arrives for the old one. Requeuing there un-stamped a wamid
nothing would ever re-send, so the finished run flipped from `completed` to
`incomplete`, the contact moved out of `delivered`/`sent` into `retrying`, and
the breakdown card promised an attempt that had no loop to make it. The failure
is still recorded on the message row by `applyStatus` — the send really did fail
— which is the honest outcome for a run that is over.

**Both webhook writes are guarded on something that changes.** The requeue is
`WHERE run_id = ? AND phone = ? AND wamid = ?` and only fires on the transition
*into* `failed`. Meta redelivers statuses and the Diagnostics replay button
re-runs stored envelopes, so an unguarded version would walk a contact down the
whole ladder without a single extra attempt being made — and would un-send a
newer attempt when a stale failure for an older wamid arrived late.

**A fault that fails every send pauses the campaign; one row's fault skips one
row.** `haltsCampaign()` in `lib/errors.js` is a whitelist beside
`skipDisposition` — token/permission, billing, account restriction, template
codes, 131063 — and the loop checks it before every other branch on a failed
send: it sets `pauseFlag` (so the loop stays awake, and `/api/resume` treats a
flag-parked pause as operator-resumable — the sleepUntil pauses never set the
flag), phase `paused`, and a `pauseReason` naming the code, with the contact
left PENDING. Before this, an expired token burned the whole remaining list
into identical `failed` rows at delaySec intervals — a thousand-line report of
one fact, each line costing an attempt. Deliberately not every `fix` code:
131009 / 132005 / 132012 / 131021 are one row's problem, and pausing a campaign
over one bad CSV cell is the opposite failure. A crash during the halt is fine:
`pauseReason ≠ USER_PAUSE`, so `resumeIfInterrupted` retries once, hits the
same fault, and re-pauses — the probe costs one send.

**MM Lite is an opt-in flag, off by default, and only for MARKETING.**
`S.config.mmLite` routes template sends to `/PHONE_NUMBER_ID/marketing_messages`
when the adopted template's category is MARKETING — the endpoint rejects every
other category, so the gate lives in `sendTemplate`, the one door both the loop
and test sends pass through. Meta's default `product_policy` is
`CLOUD_API_FALLBACK`: a WABA that never signed the MM Lite ToS just keeps Cloud
API routing, which is why the Settings switch is safe to expose. It is
delivery-time optimisation on Meta's side (their A/B: ~9% delivery lift), NOT
an exemption from the per-user cap. The webhook's `pricing.category` becomes
`marketing_lite`; nothing here reads it. 131063 is what Meta returns when
marketing is disabled on Cloud API, and its `META_ERRORS` entry names this
switch as the fix.

**Quiet hours are asked TWICE — of the deadline, and of the clock.**
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

That was only half the guard, and the missing half shipped: **a deadline is a
promise about when a contact becomes SENDABLE, not about when the loop gets to
them.** A rung due at 21:30 that a backlog only reaches at 00:02 sends at 00:02,
and production did exactly that — 113 marketing templates between midnight and
01:00 IST on a run whose every `retry_after` had been correctly deferred.
`campaignLoop` now asks the same function of `Date.now()` before every send and
parks until 08:00 if the answer moves. It gates the first pass too: a campaign
started at 23:30 is the same notification at the same hour, and the quality
rating does not care which rung woke the recipient up. `QUIET_HOURS` in
`config.js` exists for `test.js`, which drives the real loop and would otherwise
park until morning for anyone running the suite at night — it is opt-OUT, env
only, and deliberately not in the UI.

**The phase string is `waiting`; every label says "In progress".** State and
presentation are allowed to differ. `ACTIVE_PHASES` (in `src/state.js`),
`campaignBlocker()`, `resumeIfInterrupted()`, `statusForRun()` and the
delete-while-in-use check all match on the string. Renaming it to match the label
silently changes what a second Start is refused on, which is how the
two-loops-on-one-queue double send got in before. The label changed because the
ladder now runs for up to a day, and an operator who reads "waiting" assumes the
campaign is stuck and presses Stop — abandoning exactly the contacts it exists to
recover.

**A pause the loop gave itself resumes after a crash; the operator's does not.**
`resumeIfInterrupted` used to pick up only `running` and `waiting`, which made a
crash inside the daily-cap, rate-limit or quiet-hours pause unrecoverable: the
run sat at `paused` with no loop behind it, and `paused` is in `ACTIVE_PHASES`,
so `campaignBlocker()` then refused every Start and every CSV upload with "a
campaign is paused part-way through" until someone thought to press Stop. Every
automatic pause re-derives its own condition on the next iteration, so resuming
one costs nothing. The two are told apart by `pauseReason`, which is now in the
`campaign.json` snapshot for exactly this and is written from the `USER_PAUSE`
constant rather than a literal — `/api/pause` and the boot check have to agree on
the string or the trap comes back silently.

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

**The CSV parser reads files as they actually arrive, and guesses out loud.**
`parseCSV` tokenizes the whole file RFC-4180 — a quoted field keeps its commas
AND its newlines, because Google Contacts and most CRMs export Notes/Address
columns with embedded newlines, and the old per-line split silently dropped a
third of such a file as "no usable phone number" (the reported symptom:
"uploaded 1000 contacts, only the old ones show"). It sniffs the delimiter from
the header line (`,` `;` tab — a `;` file split on `,` made the whole line one
field, and the name's digits fused into a plausible WRONG number), and decodes
UTF-16 by its BOM. Headers matching phone/mobile/whatsapp/"contact no" are
phone columns; when NOTHING matches, it falls back to the column whose VALUES
dial (≥90% of the first fifty non-empty cells), and a headerless bare-number
list is treated as data rather than eating its first contact as a header. Both
fallbacks come back as `guessedPhone`, which the upload route logs as a warning
— a guess that large must not be silent. A bare "Number"/"Account Number"
header still never outranks a named phone column, and the refusal for a file
with no phones at all now NAMES the columns it saw.

**The opt-out is a second table, and it outlives the contact.** `contacts.enabled`
used to be the whole record, which made "delete this contact" and "forget they
opted out" the same action — and the next CSV upload then re-created them as
`enabled = 1` and messaged them again. `disable()` writes both rows, `enable()`
deletes the `suppressed` row (an explicit re-enable must not be undone by the
next upload), `remove()` deletes only the contact, and `upsertFromCsv` re-applies
every suppression **inside the same transaction** as the inserts. `isDisabled()`
reads both tables with an OR and so fails closed. The reason the re-apply is a
statement after the loop rather than part of the upsert: the upsert cannot
re-enable anyone (`enabled` is absent from its SET list), but it can INSERT, and
an insert arrives with the column default. There is a test that deletes an
opted-out contact, re-uploads the CSV, and asserts they come back disabled.

**Nothing is deleted while it is in use, and `force` does not override that.**
Referenced-by is a fact about the past; `busyNow()` in `services/media.js` is
about this second. It refuses when either (a) a hold is out on the asset —
`holdAsset()` is taken for the whole of `ensureHandle`, `ensureMediaId` and
`sendMedia`, so it spans the awaits where bytes are actually travelling — or (b)
a campaign is live (`campaignActive()`) and that run's `header_asset`, or
`S.config.headerAssetId`, is this file. Force is the operator overruling a
judgement about history; nobody can overrule a send already in flight, so there
is deliberately no flag that skips this check. The hold is a **count**, not a
boolean: one asset can be inside a campaign send and an inbox send at once, and
the first to finish must not clear the second's hold. `sendMedia` wraps rather
than try/finally-s its body so a later early return cannot escape the release.
Deleting mid-send does not fail cleanly — the run writes an ENOENT against a
dealer's row, indistinguishable from a real Meta refusal.

**`ACTIVE_PHASES` lives in `src/state.js`, next to `S.phase`.** It had grown a
second copy in `services/messages.js` with a comment explaining the cycle that
forced it; a third consumer (`media.js`, for the check above) made that
untenable. `campaignActive()` — `flags.running || ACTIVE_PHASES.includes(phase)`
— lives there too, because the `flags.running` half is the one that matters and
it was being re-typed at each call site.

**A deleted asset that history points at becomes a tombstone, not a gap.**
**`node:sqlite` enforces FOREIGN KEY constraints by default** — an earlier
version of this file claimed the opposite, and code was written on that claim:
a dangling id bound into `messages.run_id` or `campaign_runs.header_asset`
throws `FOREIGN KEY constraint failed` at INSERT time, which is why
`loadCampaign` validates a restored `currentRunId` against `campaign_runs`,
`startRun` validates the picked header against the library, and `deleteAsset`
clears `S.config.headerAssetId` when it deletes the picked file. The tombstone
still earns its place: it is what lets history NAME what was sent, not just
survive the delete. `deleteAsset(id, { force: true })` unlinks
the bytes and stamps `media_assets.deleted_at` instead of deleting the row, so a
campaign report can still name what it sent. A plain delete still refuses. The
tombstone is invisible to `listAssets()` (picking it would build a send that
fails at Meta rather than here), weighs zero in the storage totals, is not
renameable, and every send path refuses it by name through `deletedMsg()`.
Re-uploading the same bytes **revives** the row rather than making a second one,
because `sha256` is UNIQUE and the tombstone is what history points at. It is
deliberately not a recycle bin: the bytes really are gone.

**The transcript is the conversation; a refused send is not in it.**
`services/inbox.js:VISIBLE` is `NOT (m.dir = 'out' AND m.status IS 'failed')`,
interpolated into the thread page, the list preview, the message count and both
search queries — one fragment, for the same reason `BUCKET_CASE` is one. A
message Meta refused reached nobody: the customer has never seen it, cannot
answer it, and does not know it exists, so rendering it — even tagged "Not
delivered" — puts words in our mouth that were never spoken, and an operator
skimming a thread before replying reads it as context the customer shares. Worse
once the ladder runs: a contact refused and later reached has two rows for one
message, and the thread showed the same campaign copy twice, which reads as the
business having spammed them. **The rows are not deleted and must not be** —
`countsForRun` counts them, `funnelQ` joins on them to reach the `gaveUp` bucket,
`applyStatus` needs the row so a redelivered webhook is recognised rather than
logged as unknown, and the skip report is the audit trail. Campaign history
answers "we tried and Meta refused"; the inbox answers "what did we say to each
other". The thread payload carries `undelivered` so the operator is told the
count rather than left wondering, and the per-bubble error panel is gone because
`error_code` is only ever written by `markFailed`, which also sets the status
that hides the row. `threads.last_at` is restamped by `applyStatus` on the
failure and backfilled once in `openDb`: it is stamped when the send is
*accepted*, which is the only moment available, so without that a thread whose
newest message nobody received sorted above conversations that had actually
moved.

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
off for that reason, and the retry requeue is guarded on the `failed` transition
*and* on the wamid the queue row still carries. That is the only reason the
Diagnostics replay button can exist. Do not add a non-idempotent write to
`processEnvelope`.

**The loop reads `S.currentRunId` once per contact, before the await.**
`campaignLoop` captures `const runId = S.currentRunId` and every write about that
send uses it. `/api/reset` nulls `S.currentRunId` synchronously and can land
while the loop is inside `sendTemplate()`; re-reading it afterwards gave the
queue stamp a null run — matching no row, leaving the contact pending — while the
message row was filed under `run_id NULL`, the inbox-reply bucket
`countsForRun(null)` exists to keep clean. One mis-filed template send and one
contact who would be messaged twice on a resume.

**`nextPending` is TWO queries, and the order is the point twice over.**
Untried contacts first, then retries that have come due. One `ORDER BY seq` over
both could not express that, because a retry row keeps the seq it was staged
with — so a failure at seq 12 coming due jumped ahead of six hundred people the
run had never attempted, spending the day's cap on second attempts while first
attempts waited. Reaching everyone once is what a campaign is for; the ladder is
what happens afterwards. Split, each half is also a clean index seek, which the
merged version was not: the first is exactly `idx_run_recipients_pending`
(partial, and it SHRINKS as the run drains), the second exactly
`idx_run_recipients_retry`, `ORDER BY retry_after` included. The retry half is
ordered by deadline rather than by seq, because within the ladder the honest
queue is whose turn came up first.

**An index that exists but is not chosen is worse than no index.** It costs a
write on every insert and buys nothing, and both of this app's per-message
queries regressed exactly that way. `nextPending` had a partial index carrying
`WHERE wamid IS NULL AND skipped_reason IS NULL`; the retry ladder widened the
query's WHERE into a disjunction that no longer *implied* that predicate, so
SQLite silently stopped selecting it and fell back to the primary key plus a temp
b-tree sort — a full scan of the run, once per message. It was dropped, correctly
at the time; splitting the query above makes the predicate exact again, so it is
back and `idx_run_recipients_seq` is left to the report queries that walk a whole
run in order. `sentSince` (today's cap) grouped by `wa_id`, which made SQLite prefer
`idx_messages_thread (wa_id, at)` — no way to seek on `at`, so it scanned the
whole message history on every send, a cost that grows with age rather than with
load. `idx_messages_cap` is covering, so the range seek answers it without
touching the table. All three are asserted on the **query plan** in `test.js`, not
on the schema: the schema test only proves the index exists, which is the half
that was never in doubt.

**A rung does not come due all at once, and announcing the gaps was the bug.**
Each contact's `retry_after` is written when that contact's own failure webhook
lands, so a rung of a hundred is a hundred deadlines smeared across however long
the previous rung took to send. `nextPending` returns only what is due this
instant, so the loop drains them one at a time — send one, nothing due for three
seconds, send the next. Taking the full `waiting` path for that three-second gap
is a log line, a **synchronous fsync** (`saveCampaignNow`) and two whole
`buildState()` rebuilds; on a real 775-contact run it fired **340 times for 549
retry sends**, the rung took hours instead of minutes, and the ladder's deadlines
then cascaded past midnight — which is how the quiet-hours bug above got its
backlog. Waits under `ANNOUNCE_WAIT_MS` are now spent silently: same sleep, no
phase flap, no fsync, no broadcast. Nothing an operator can act on happens in a
gap that short.

**`broadcast()` is coalesced, and the trailing edge is what makes that safe.**
One `buildState()` is eight aggregates over four tables including a three-table
join, and it is called after every send, every webhook envelope, every phase
change and every queue write — and Meta batches statuses. Leading edge fires
straight away so a single event still feels instant; a broadcast dropped inside
the window is not dropped but deferred to the end of it, so the LAST state always
arrives. Nothing is cached — every send is a fresh derivation, so a client can be
shown a slightly late number, never a stale one.

## Gotchas

- **`node:sqlite` binds anonymous `?` placeholders strictly by position.**
  Mixing `?` and `?2` in one statement throws "column index out of range".
  Repeat the value instead — see `pageOfMessages` in `services/inbox.js`.
- **Escape `%` and `_` in LIKE patterns.** Unescaped, a search for `50%` matches
  every row.
- **`= 'x'` is not `IS 'x'` when the column can be NULL, and a negated one fails
  open in the wrong direction.** `messages.status` is NULL on every inbound row
  and on an outbound one Meta has not reported on yet. `NULL = 'failed'` is
  **NULL**, not false — so `NOT (dir = 'out' AND status = 'failed')` evaluates to
  `NOT NULL` = NULL, and a WHERE clause treats NULL as not-true. Written that
  way, the inbox visibility rule hid *every* outbound message from the moment it
  was sent until its delivery receipt arrived. SQLite's `IS` is null-safe
  equality and yields a real false; the codebase already relies on it for
  `run_id IS ?`. There is a test asserting a status-less outbound stays visible.
- **Pagination cursors are `(at, rowid)`, not `at`.** Meta timestamps in whole
  seconds, so ties are routine, and an `at`-only cursor silently drops every
  message that ties with a page boundary.
- **Route order is a security boundary.** `/webhook` mounts before `requireAuth`;
  everything after it is protected by default. Also mount specific paths before
  parameterised ones — `/inbox/search` before `/inbox/:waId`.
- **`migrateJsonToSql` and `migrateOptOuts` rename their source files.** They run
  only under `require.main === module` in `server.js`. Never call them at require
  time, or `npm test` renames the repo's own state files. `reconcileWarmupDays`
  is in the same block for the same reason — it *writes* `warmup.json`, so the
  test that covers it snapshots and restores that file.
- **`Number(x)` is a validator; `parseInt(x)` is not.** `/api/config` used to
  coerce anything unparseable into a working setting, and both settings failed
  towards MORE sending: `delaySec: "abc"` became `Math.max(1, NaN)` → `NaN` →
  `sleep(NaN)` fires immediately, removing the pause between sends entirely, and
  `dailyCap: "abc"` became `NaN || 0` → `0`, which is the operator's own "no
  cap". Reject what does not parse rather than guess a value that spends money.
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
- **`statfs` reports three numbers, not two.** `bavail` is what a non-root
  process may use; `bfree - bavail` is the filesystem's root reserve (ext4 keeps
  5%, about 1 GB on a 20 GB disk). It is neither free nor used by anything, so
  subtracting only `free` folded it into "everything else" and overstated the OS
  by a gigabyte. `volume()` returns it and `overview()` subtracts it separately.
- **`buildState()` runs once per message sent, so nothing in it may ask twice.**
  `lastRunSummary(already)` takes the aggregates the caller has just computed and
  reuses them when the last run *is* the current run — which it is except in the
  moments after a Reset. It was re-running progress, counts, funnel and nextRetry
  independently, four aggregates including a three-table join, for numbers
  already in scope. Passed in rather than memoised: a cache would need
  invalidating on every webhook, and the point of deriving these numbers is that
  there is nothing to keep in step.
- **A sweep that runs per-request turns a defence into an amplifier.** The auth
  rate limiter's map sweep is throttled to once a minute. Sweeping on every
  first-sighting of an IP is O(n) per new IP, so a scan from many distinct
  addresses — exactly what probing a public hostname looks like — made it O(n²)
  in the number of probes. Entries expire on a clock, so a more frequent sweep
  cannot find anything a once-per-window one misses.
- **A CSV the operator downloads needs a UTF-8 BOM and must not be a `data:`
  URI.** Excel on Windows decodes a BOM-less CSV as the system codepage, which
  turns a customer's name into mojibake — not cosmetic when the file is a contact
  list. And the `data:` URI was built into the anchor's href on every render, so
  a large group serialised megabytes nobody had asked for and hit the browser's
  URL cap; it is a `Blob` created on click and revoked after.
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

**`failed` holds two populations, and each row says which.** A contact lands in
"Failed, given up on" either by exhausting all six attempts *or* by carrying a
code `skipDisposition()` does not name — `unclassified` never retries, so those
were tried exactly once. On a real run of 775 the bucket was thirteen contacts,
all `130472`, all with `attempts = 0`: none of them had ever been on the ladder,
while a hundred `131049`s were still climbing it. The count alone made that look
impossible ("how did thirteen finish before a hundred that started earlier?"), so
`FunnelContact` now prints `tried 6×` or `tried once · not retried` on every
given-up row. `attempts` counts RETRIES, so the number of tries is one more —
the CSV column follows the same rule.

**"How many times did we try" has three answers, and `triesFor()` in `ui.jsx` is
the only place that knows them.** `attempts + 1` for a contact that was actually
sent to; **zero** for `skipped_reason = 'disabled'` — switched off before the
queue reached them, so nothing went out and nothing was billed, and "tried once"
about someone we never messaged is the report inventing an attempt; and
`attempts` exactly for a `retrying` row, whose next go has not happened yet.
`routes/campaign.js:/campaign/skips` already drew these distinctions and the
funnel card did not, so the same contact was "never attempted" on one screen and
"tried once" on the other. The Download-full-report CSV and the on-screen row
both read this one function.

**The full-campaign report is built in the browser from rows already on screen.**
`Funnel`'s "Download full report" writes the funnel counts as a `Metric,Contacts`
block, a blank line, then every contact — one ragged CSV, because two files can
be separated from each other and a spreadsheet reads ragged rows without
complaint. The summary is the same `funnel` object the card renders and the rows
carry the server-stamped `bucket`, so the file and the screen cannot disagree;
nothing in it re-derives an outcome. It appears only where the contact rows are
actually loaded — History — because the live state broadcast deliberately does
not carry the list. UTF-8 BOM and `Blob`-on-click, for the reasons in Gotchas.

**`130472` is explained but deliberately unclassified.** It is Meta's marketing
holdout: a slice of recipients excluded to measure the effect on the rest. Not in
`RETRY`, because a holdout window runs for days or weeks and all six attempts
would land inside the same one — five guaranteed-useless sends per contact and a
report promising retries that cannot work. Not in `PERMANENT` either: switching
the contact off over a temporary holdout drops a real customer from every future
campaign. `unclassified` is exactly the behaviour wanted — reported, never
retried, never written off — and the `META_ERRORS` entry exists so that report is
a sentence rather than a bare number to look up.

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

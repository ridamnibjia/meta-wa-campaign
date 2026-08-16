# WhatsApp Cloud API Campaign Manager

Send approved WhatsApp marketing templates to bulk contacts using Meta's official API. Self-hosted, open source, no third-party services beyond Meta.

**Stack:** Node.js · Express · Socket.io · React (no build step) · Meta WhatsApp Cloud API

### What it does

- **Compose and submit templates** to Meta from the app, with local validation that catches the documented rejection causes before you spend a review cycle.
- **Bulk send** from a CSV, at a configurable pace, with live per-message state over WebSocket.
- **Survives restarts.** The send queue is a table in SQLite and the resume point is a query over what was actually sent — not a saved cursor a crash can leave ahead of reality — so a crash or deploy picks up where it stopped instead of re-sending.
- **Warm-up ladder.** A brand-new number climbs `20 → 50 → 100 → 250 → 500 → 1000` per sending day, holds its rung if quality drops to YELLOW or RED, and graduates off the ladder entirely once it has walked the whole thing at good quality.
- **One-tap opt-out.** A "Stop promotions" button on every template; taps arrive by webhook and disable that contact for campaigns — while leaving them replyable in the inbox.
- **Two-way inbox with attachments.** Inbound replies are threaded, and you can reply free-form — text or a file — inside Meta's 24-hour customer-service window. Files come from a reusable library, so one price list is uploaded once and sent to any number of contacts.
- **Campaign history, with a downloadable report.** Every past campaign with its start and end, the message body *as it was sent*, and who was reached, delivered to, read by, or missed and why — plus a one-click spreadsheet of the whole thing: totals per outcome, then every contact with Meta's code, how many times they were tried, and what it means.
- **A retry ladder that respects the night.** A failure about the moment rather than about the number goes back on the queue — six attempts, three hours apart — entered both from the send response *and* from the late `failed` webhook Meta actually uses. Nothing goes out between 23:00 and 07:00 IST, checked against the clock at send time and not only when the deadline is written.
- **Storage management.** One page showing what the disk holds, what it is filled with, and what can safely be removed — with a hard line between files you uploaded and customer files under a retention promise.
- **Cost estimates** before you start and a running spend figure while you send, per Meta's per-message pricing.
- **Password gate.** The whole API and the socket sit behind one password. Without `APP_PASSWORD` set, the app refuses to serve anything rather than opening up.
- **Signed webhooks.** Every `POST /webhook` is verified against your Meta App Secret with HMAC-SHA256; unsigned calls get a 401.

---

## Table of Contents

1. [Official Ways to Send WhatsApp Messages as a Business](#1-official-ways-to-send-whatsapp-messages-as-a-business)
2. [Meta WhatsApp Cloud API — Full Setup from Scratch](#2-meta-whatsapp-cloud-api--full-setup-from-scratch)
3. [Getting Your Credentials](#3-getting-your-credentials)
4. [Templates — How Approval Works](#4-templates--how-approval-works)
5. [Rate Limits, Tiers and the Warm-up Ladder](#5-rate-limits-tiers-and-the-warm-up-ladder)
6. [Contacts, CSV, Skips and Search](#6-contacts-csv-skips-and-search)
7. [Project Structure](#7-project-structure)
8. [Running Locally](#8-running-locally)
9. [Deployment](#9-deployment)
   - [Option A: Cloudflare Pages (frontend) + Render (backend)](#option-a-cloudflare-pages-frontend--render-backend-free)
   - [Option B: A small VM behind a Cloudflare Tunnel](#option-b-a-small-vm-behind-a-cloudflare-tunnel)
   - [Option C: DigitalOcean Droplet (everything)](#option-c-digitalocean-droplet-everything)
   - [Option D: Railway](#option-d-railway)
10. [Webhook Setup (delivery receipts, replies, opt-outs)](#10-webhook-setup-delivery-receipts-replies-opt-outs)
11. [How the Code Works](#11-how-the-code-works)
12. [Environment Variables](#12-environment-variables)
13. [Meta Error Codes](#13-meta-error-codes)
14. [Security](#14-security)

---

## 1. Official Ways to Send WhatsApp Messages as a Business

Meta offers four routes. Choose based on your technical capacity and scale.

### WhatsApp Business App — free, no API, manual only

The mobile/desktop app for small businesses. One phone number, manual replies, no bulk sending, no API. Fine for answering individual customer queries.

### WhatsApp Cloud API — what this app uses

Meta's hosted API. You send HTTP POST requests; Meta delivers the messages. No infrastructure to manage. Free to use the API — Meta charges per conversation, not per message (first 1,000 service conversations/month free; marketing conversations ~$0.006–$0.014 depending on country).

**This is the right choice if you want to send notifications, alerts, or promotions programmatically.**

### Business Solution Providers (BSPs)

Third-party companies — Twilio, Interakt, Wati, Gupshup, MessageBird — that wrap Meta's API in their own dashboards. They handle template management, opt-outs, analytics. You pay Meta's fees plus a BSP markup. Good if you want a no-code interface or CRM integration.

### WhatsApp On-Premises API

Deprecated. Meta is shutting it down. Do not use.

### Decision guide

| | WA Business App | Cloud API (this app) | BSP |
|---|---|---|---|
| Technical skill | None | Developer | Low-code |
| Bulk sending | No | Yes | Yes |
| Cost | Free | Meta fees only | Meta fees + markup |
| Self-hosted | — | Yes | No |
| Open source | — | Yes | No |

---

## 2. Meta WhatsApp Cloud API — Full Setup from Scratch

Follow these steps once before using this app.

### Step 1 — Create a Meta Business Account

Go to [business.facebook.com](https://business.facebook.com) and create a Business Portfolio. A personal Facebook account is required. Fill in your business name and details.

**Verify your business:** Settings → Business Info → Start Verification. Upload a business registration document or utility bill. Verification is not required to start testing but is required to scale above the default Tier 1 limit.

### Step 2 — Create a Meta App with WhatsApp

Go to [developers.facebook.com](https://developers.facebook.com):

1. Click **Create App** → choose type **Business**
2. On the app dashboard, find **WhatsApp** and click **Set Up**

Meta creates a test WhatsApp Business Account and a test phone number for you automatically. The test number lets you send to up to 5 manually registered recipients.

### Step 3 — Add a Real Phone Number

1. In **WhatsApp Manager** → **Phone Numbers** → **Add Phone Number**
2. The number must not be active on any WhatsApp account. If it is, delete that account from WhatsApp settings first.
3. WhatsApp sends a 6-digit code via SMS or call. Enter it to verify.
4. The number is now registered to your WABA.

> Once registered to the API, the number cannot be used on the WhatsApp mobile app.

### Step 4 — Add a Payment Method

Required before you can send to numbers outside the test list. Go to **WhatsApp Manager** → **Overview** → **Add Payment Method**.

### Step 5 — Generate a Permanent System User Token

1. **Meta Business Suite** → **Settings** → **System Users** → **Add**
2. Create a system user with **Admin** role
3. Click **Add Assets** → **Apps** → select your app → Full Control
4. Click **Generate New Token** → select your app → check:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the token immediately — it is shown only once

Store it in your `.env` file as `ACCESS_TOKEN`. Never commit it to git.

---

## 3. Getting Your Credentials

### Phone Number ID

Not the phone number itself — an internal Meta identifier.

**Where:** [developers.facebook.com](https://developers.facebook.com) → your app → **WhatsApp** → **API Setup** → select your number from the "From" dropdown → the **Phone Number ID** is shown below. It is a 15–16 digit number, e.g. `1########45`.

Alternatively: **WhatsApp Manager** → **Phone Numbers** → click your number → copy the ID from the details panel.

### WABA ID (WhatsApp Business Account ID)

**Where:** **Meta Business Suite** → **Settings** → **Accounts** → **WhatsApp Business Accounts** → click your WABA → copy the ID from the panel.

The app can auto-resolve this from your `BUSINESS_ID` if you leave `WABA_ID` blank.

### Business Portfolio ID

Shown in the URL when you are in Meta Business Suite:
`business.facebook.com/settings/?business_id=XXXXXXXXXX`

---

## 4. Templates — How Approval Works

The Cloud API can only send **pre-approved templates** when you initiate contact. You cannot send free-form messages to someone who has not messaged you in the last 24 hours.

### Categories

| Category | Use case | Pricing |
|---|---|---|
| MARKETING | Promotions, offers, announcements | Highest |
| UTILITY | Order confirmations, account updates, alerts | Medium |
| AUTHENTICATION | OTP, verification codes | Lowest |

### Creating a template — in this app

Use the **Compose Message** card in the left column. You do not need to leave the app.

1. Give the template a name. It is lowercased and underscored for you (`Diwali Offer 2026` → `diwali_offer_2026`).
2. Write the body. Insert `{{1}}` where the contact's name should go, and supply a sample value — Meta will not review a template with variables unless you give it an example.
3. Optionally add a footer (max 60 chars, no variables).
4. Leave **Stop promotions** checked. Taps on that button are captured by the webhook and disable that contact for every future campaign.
5. **Submit for Approval.** The app polls Meta every 15 seconds; the badge moves `PENDING` → `APPROVED` or `REJECTED` with the reason.

The app validates the body before submitting — variable numbering gaps, a body starting or ending with a variable, an over-length footer, missing samples. These are the documented rejection causes, and catching them locally saves a review cycle.

**Start Campaign stays disabled until the template is `APPROVED`.** The server re-checks with Meta at launch, so a stale browser tab cannot send against a rejected template.

### Creating a template — in Meta's UI

Still supported if you prefer it: **WhatsApp Manager** → **Message Templates** → **Create Template**. Type the resulting name into the **Active Template** field and the app will pick up its status and variable count automatically.

### After approval

- Status becomes `APPROVED`
- Valid across all phone numbers in the same WABA
- You send it by name — `diwali_offer_2026` — not by content

### Template quality and rejection

Meta monitors how recipients interact with your messages. High block or report rates will lower your quality rating and can result in template suspension. Only send to people who have opted in to receive messages from you.

---

## 5. Rate Limits, Tiers and the Warm-up Ladder

| Tier | Marketing messages per 24h rolling window |
|---|---|
| Tier 1 (new accounts) | 1,000 unique recipients |
| Tier 2 | 10,000 unique recipients |
| Tier 3 | 100,000 unique recipients |
| Unlimited | No limit |

Meta upgrades your tier automatically when you have sent at least the current tier limit within 7 days and your quality rating is not LOW.

The app counts how many people it has messaged today and pauses until midnight IST when the cap is reached, resuming on its own the next day.

At 2s per message, 2,238 contacts takes ~75 minutes. If you are on Tier 1 (1,000/day), the first 1,000 go out in ~33 minutes; the rest resume the following day.

### What counts against the daily cap

The count is a query over the messages actually sent today, not a running total,
and it counts **people, not messages**:

- A send Meta accepted counts from the moment it is accepted.
- A send Meta **later refuses** — the `failed` status webhook, which is how the
  per-user marketing cap (131049) and most quality blocks actually arrive —
  **stops counting**, and the slot goes back to the day the instant the webhook
  lands. A day of 800 accepts with 200 refusals is 600 against the cap, not 800.
- A contact reached on the second attempt costs one slot, not two, which matches
  how Meta counts its own limit (unique recipients per 24h).

Because it is derived, nothing can drift: there is no counter for a restart, a
midnight rollover or a replayed webhook to leave disagreeing with the rows.

### Removing the cap

Set **Daily cap** to `0` in Settings. That removes *your* limit; Meta's
messaging tier still applies, and the warm-up ladder below still applies until
it finishes. Both are shown on the Settings page, so you can always see which
one is holding a campaign back.

### The warm-up ladder

Your tier is what Meta *allows*. It is not what a brand-new number should send.
A number with no history that blasts 1,000 messages on day one gets throttled or
has its quality rating tanked, and quality is far harder to recover than volume.

So the app enforces its own ceiling on top of the tier cap:

| Sending day | Ceiling |
|---|---|
| 1 | 20 |
| 2 | 50 |
| 3 | 100 |
| 4 | 250 |
| 5 | 500 |
| 6 | 1,000 |
| 7+ | no ceiling — the ladder is finished |

- The rung advances per **sending day**, not per calendar day. A day you send
  nothing does not move you up.
- If your quality rating is `YELLOW` or `RED`, today holds one rung *below* where
  it would otherwise be, instead of climbing.
- **The ladder ends.** Once every rung has had a sending day and quality is not
  YELLOW or RED, the number has graduated and the warm-up ceiling is lifted
  entirely — the ladder exists to prove a new number sends steadily, and once it
  has, Meta's own tier is the real limit. This is automatic and applies to every
  install; there is no per-account setting anywhere in the repo.
- Graduation is re-checked live, not stamped once. A drop to YELLOW or RED puts
  the number back on the ladder until quality recovers, because falling quality
  is exactly when volume should come down.
- The effective cap is `min(warm-up rung, your own daily cap)`, and `null` — no
  cap at all — when neither applies.
- Progress persists in `warmup.json`, and is reconciled at every boot against the
  send days in the message store. A lost or left-behind `warmup.json` therefore
  does not put an established number back on rung one at 20 a day.
- Toggle it off in Settings if you want to skip it entirely.

---

## 6. Contacts, CSV, Skips and Search

### The CSV

Download [`contacts-template.csv`](contacts-template.csv), or export from Google
Contacts — that file works unchanged. A header row and one phone column are the
only hard requirements:

```csv
Name,Mobile Phone
Asha,9000000001
Rahul,+91 90000 00002
```

Headers are matched by name, so extra columns and any column order are fine.
Numbers are stripped to digits, given a `91` prefix if they are a bare 10 digits,
and de-duplicated. Toll-free prefixes are dropped.

**A repeated number is merged, and you are told.** The same number twice in one
file is one contact and one message — messaging a person twice in one campaign is
the worst outcome available here — but the upload reports how many rows were
merged and which line numbers they were on. A file that lost 25 rows to a broken
export and a file that simply lists 25 dealers twice produce the same contact
count, and only one of them is fine.

**[Full format rules, edge cases and gotchas → CSV-FORMAT.md](CSV-FORMAT.md)**

Fields are parsed per RFC 4180, so a quoted name like `"Doe, John"` does not
shift the phone column. Any row with no usable number is reported back with its
line number instead of being dropped in silence.

After uploading, **View all** shows every parsed row exactly as it will be sent —
name, `+number`, and whether it is disabled or already sent. Check it before you
spend money.

### Contacts, and the one switch

Every contact this server has seen lives in one `contacts` row with one
`enabled` flag. Three things turn it off:

| Trigger | Reason recorded |
|---|---|
| Customer taps **Stop promotions** | `opt_out` |
| You click Disable in Settings | `manual` |
| Meta returns `131026` on a send | `failed_hard` |

**A disabled contact is skipped by campaigns and stays fully replyable in the
inbox.** Someone who opted out of promotions and then writes in with a question
still deserves an answer, and answering them is not a marketing message.

`131026` means the number is not on WhatsApp, or Meta blocked it on quality
grounds. That is a property of the number rather than of the attempt, so it is
disabled automatically — otherwise it burns a send slot on every future run,
forever.

**Re-uploading a CSV never re-enables anybody.** The upsert updates the name and
the extra columns and deliberately does not touch `enabled`. Turning someone back
on is always a manual, confirmed action, because every automatic path into
`disabled` is a reason to stay there.

**Deleting a contact does not delete their opt-out.** The **Contacts** page can
remove a row from the customer list, but the opt-out is recorded in its own
`suppressed` table and outlives it. If a later CSV contains that number again,
the contact comes back **disabled**, with the original reason. The only thing
that clears a suppression is an explicit, confirmed Enable.

`GET /api/contacts/directory/download` exports the disabled list with names,
reasons and timestamps — the file you hand over when someone asks you to prove
you stopped messaging them.

### The Contacts page

The customer list itself, searched and paged on the server: type part of a name
or number, filter by Everyone / Messageable / Disabled, and page through. The
search, the filter and the page number live in the URL, so a link to page 3 of
the disabled contacts is a link you can send, and Back does what Back should.

Per row you can rename, disable, enable, or delete. Renaming touches the display
name only — the phone number is what every message, queue row and thread joins
on, so a wrong number is a delete and a re-add rather than an edit.

### The skip report

After a run, **Not messaged yet** on the Campaign page lists everyone who did not
get it, grouped by what you can do about it: waiting to retry, worth trying again
another day, fix something first, or Meta will never deliver these. Each row says
how many times it was attempted and what Meta answered.

The grouping comes from `skipDisposition()` in `src/lib/errors.js`, which is a
whitelist in both directions: a code has to be named to be retried, and a code
has to be named to be given up on. Anything Meta sends that is not in the table
shows under **Not yet classified** with its raw code — a wrong "retry these" is a
list of people you message again for no reason, and a wrong "give up on these" is
customers you quietly stop talking to.

### The retry ladder

A send that fails for a reason about the **moment** rather than about the
**number** goes back on the queue instead of out of the run: a network throw, a
Meta fault, or `131049` (the per-person marketing cap, which is counted across
every business messaging that person and has nothing to do with your settings).

Six attempts in all — the original, then five more three hours apart. The ladder
is therefore 15 hours of sending time spread over at most about a day.

**The ladder has two entrances, and the second is the busy one.** Meta answers
most sends with HTTP 200 and a message id and only decides minutes or hours later
that it will not deliver, over a `failed` status webhook — which is how `131049`
almost always arrives. Both the send-time failure and the late webhook feed the
same ladder and the same whitelist, so a run does not close with a contact that
Meta accepted and then refused.

### Quiet hours

Nothing goes out between **23:00 and 07:00 IST**. A notification at 3am is what
gets a business blocked and reported, and that feeds the quality rating which
gates your messaging limit.

This is checked twice, because once was not enough:

- Any retry deadline that would land in the window is moved to **08:00** when it
  is written. (08:00 and not 07:00 on purpose — a whole night of deferred retries
  comes due at one instant, and releasing that herd at 07:00 sharp releases it
  while people are still asleep.)
- The loop also checks the **clock** before every single send, retry or not. A
  deadline is a promise about when a contact becomes sendable, not about when the
  loop reaches them: a backlog due at 21:30 that the loop only gets to at 00:02
  sends at 00:02, and that is exactly what happened before this check existed.
  A campaign started at 23:30 parks until 08:00 for the same reason.

Set `WA_QUIET_HOURS=0` to disable it. There is no UI switch — sending marketing
at 3am should take writing it down in a file.

The deadline is a column on the queue row (`run_recipients.retry_after`), not a
timer in memory, so it survives a restart and the campaign resumes its own wait.
While any contact is on the ladder the run is **not finished**: the phase is
`waiting` and every label reads *"In progress — retrying"*, the contact still
counts as pending and as billable, and starting another campaign or uploading a
new list is refused until this one finishes or you stop it. Stopping leaves those
contacts un-messaged and says so.

**This will not take 131049 to zero, and no retry schedule can.** The per-person
marketing cap is a rolling window belonging to the recipient, counted across
every business that messages them — waiting longer helps, but the cap may still
be closed. The reliable way to reach a capped contact is the 24-hour service
window: send one marketing template that invites a reply (a quick-reply button),
and when they tap it, send the real content free-form from the inbox. Nothing
sent inside that window is subject to the cap, or to template pricing.

Before this, one DNS blip at contact #340 dropped that person from the run
permanently, and the only way to reach them was re-uploading the CSV — which
opens a new run and messages everyone a second time.

**Untried contacts always come before due retries.** A retry keeps the CSV
position it was staged with, so ordering the queue by position alone let a
failure near the top of the list jump ahead of hundreds of people the campaign
had never attempted — spending the day's cap on second attempts while first
attempts waited. Reaching everyone once is what a campaign is for; the ladder is
what happens afterwards.

**Uploading a new CSV strands whatever the last campaign had not finished.** Only
the current run has a loop walking it, so contacts parked on an old run's ladder
are never reached — and the ladder deliberately refuses to reopen a campaign
nothing points at, because that would promise an attempt nobody will make. The
Dashboard says so: a banner names how many contacts from earlier campaigns were
never reached, and which campaigns they were on. Put them in a later CSV.

### Search

The Inbox search box runs `LIKE '%…%'` over message bodies and thread names,
across every conversation or inside the open one. Measured at 40ms over 200k
rows, so there is no FTS index to drift out of step with the messages table.
`%` and `_` are escaped, so searching `50%` finds the discount rather than
everything.

### Inbox attachments

Inside the 24-hour window an operator can send an image, video or document as
well as text. The 📎 button opens a picker with two halves: the **library** of
everything uploaded so far, and a drop zone for a new file.

Files are deduplicated on **content hash**, not filename — a renamed copy of last
month's price list is the same file — so sending one document to fifty dealers is
one upload, one Meta media id and fifty sends. Meta deletes uploaded media after
30 days; the app refreshes the id at 29 and re-uploads transparently if a send
comes back complaining, so a file from six months ago still sends.

Uploads are checked the same way inbound files are: the declared type, the
extension and the actual magic bytes all have to agree, and anything whose bytes
identify it as a program is refused outright.

### Campaign history

Every campaign that has ever run, newest first, with when it started and when the
last attempt was made, and what happened to every contact in it. Opening one
shows the **message body as that campaign sent it** — editing a template later
does not rewrite history — plus the breakdown below and the full recipient list.

**Every contact, in exactly one group, and the groups add up to the CSV:**

| Group | Meaning |
|---|---|
| Delivered *(of which N read)* | Reached the phone. This is what Meta bills for. |
| Sent, no answer yet | Meta accepted it, delivery not confirmed. A recipient whose phone is offline sits here and moves to Delivered when they come back online — Meta holds it up to 30 days. |
| Queued for another try | On the retry ladder. Still owed a message; the campaign is not finished. |
| Not attempted yet | Still in the queue, in CSV order. |
| Failed, given up on | Every attempt used, or a code never worth retrying. Not billed. |
| Cannot receive messages | Meta reports the number as undeliverable — usually not on WhatsApp. Switched off automatically. |
| Opted out or switched off | Never attempted. Tapped "Stop promotions", or you disabled them. |

**Click any group to see exactly who is in it** — name, number, Meta's code, how
many attempts were made and a plain-English explanation — with a search box and a
CSV download of that group.

**Download full report** gives you the whole campaign in one spreadsheet: the
group counts as a summary block, then every contact with their outcome, whether
they read it, Meta's code, how many times they were tried, and the plain-English
explanation. The summary is the same object the card on screen renders and each
row carries the outcome the server stamped on it, so the file and the page cannot
disagree. It carries a UTF-8 byte-order mark, so Excel on Windows does not turn a
customer's name into mojibake.

"How many times tried" is honest about three different cases: a contact switched
off before the queue reached them shows **0** — nothing was sent and nothing was
billed — a contact still on the ladder shows the tries made *so far*, and
everyone else shows the total.

Nothing here is stored as a summary. Both the count and the list behind it come
from one SQL rule applied to one table, so the number on the card and the names
under it cannot disagree — and the card says so out loud if they ever do.

`read` is shown *inside* Delivered rather than beside it: a message that was read
was also delivered, so counting it separately would make the groups miss the
total by exactly the number of people with read receipts on.

**About the read count:** WhatsApp only reports a message as read when the
recipient has read receipts switched on, and many people turn them off. It
undercounts, sometimes badly. The page says so next to the number. Delivered is
the figure to trust.

### Storage

One page for the question "what is filling this disk, and what can I remove". It
reports the whole volume — total, free, what this app uses, and what belongs to
the OS — then breaks the app's share into four categories: the database, files
you uploaded, customer files you saved, and customer files you only previewed.

Two of those four can be removed, and the distinction is deliberate:

| Category | Removable | Why |
|---|---|---|
| Files you uploaded | Yes, and renameable | Yours. Refused only while a template, campaign or sent message still points at it — and it says which. |
| Customer files previewed only | Yes | Fetched to be looked at; nothing ever committed to keeping them. |
| Customer files you **saved** | **No** | The app promised a retention window when you saved it. A promise you can cancel early is not a retention window. It goes on its own date, shown on the row. |
| Database | No | It is the message history. |

The one lever over saved files is **Run sweep now**, which removes only what is
already past its window — it does not shorten anyone's window, it just means not
waiting for the timer when the disk is filling.

Renaming changes the display name only. The content hash and the bytes are
untouched, so deduplication still works and every campaign that reported sending
that file still reported the truth. Customer files cannot be renamed at all: the
name is part of what they sent.

**A file in use is never deleted, however you ask.** If the bytes are on their
way to Meta at that moment, or a campaign is running right now with that file as
its header, the delete is refused with a sentence saying which — and "Delete
anyway" does not override it. That override is about history pointing at a file;
it is not a way to pull a file out of a send that is already happening.

**Delete anyway.** A file a template or a sent message still points at is
refused by the checkbox, and offered its own **Delete anyway** button with its
own confirmation. Taking it removes the bytes and keeps the record: the row stays
with a deleted date, struck through on the page, so the campaign that sent it can
still say what it sent. Re-uploading the same file restores it — the row is
matched by content hash, so history keeps pointing at the same one. Until then,
sending it fails with a sentence saying it was deleted rather than a stack trace.

The disk breakdown also shows the filesystem's **root reserve** as its own line.
ext4 keeps about 5% back, roughly a gigabyte on a 20 GB disk; it is neither free
space this app may use nor space anything is using, and counting it as OS usage
overstated the OS by that much.

### Diagnostics

The **Diagnostics** page answers "is this thing working": stored webhooks and
how many were never processed, when the last one arrived, which credentials are
present (never their values), the warm-up rung and today's cap, database and
media sizes against the free-space floor, and row counts per table.

If envelopes are stuck, **Replay** re-runs them through the same code path the
live webhook uses. It is safe to press twice — messages are keyed on their
WhatsApp id, a status only ever moves forward, and an already-recorded opt-out
is not recorded again. An envelope that still cannot be parsed is kept rather
than marked done, because it is the only copy of what Meta sent.

Raw envelopes are swept after **90 days**, on the same daily timer as the media
retention sweep. Only *processed* ones: an unprocessed envelope is the replay
queue, and Meta's API is push-only, so deleting one deletes it for good — those
are kept however old they get.

---

## 7. Project Structure

```
meta-wa-campaign/
│
├── server.js            Entry point — wiring and listen only
│
├── src/
│   ├── config.js        CFG, LIMITS, PRICES, file paths (imports nothing)
│   ├── state.js         Campaign state, log(), socket registry
│   ├── lib/             Pure helpers: phone, errors, signature, pricing, store
│   ├── services/        Graph client, templates, campaign loop, inbox,
│   │                    contacts, media, retention, ingest, diagnostics,
│   │                    warm-up, messages, state snapshot
│   ├── middleware/
│   │   └── auth.js      Password gate, sessions, login rate limit
│   └── routes/          One router per resource; index.js mounts them and
│                        decides what sits behind the password
│
├── public/
│   ├── index.html       Shell — Tailwind CDN, design tokens, script tags
│   ├── ui.jsx           shadcn-shaped primitives (Card, Button, Dialog, …)
│   ├── app.jsx          API client, session gate, socket, hash router
│   └── views/           dashboard, campaign, inbox, settings, diagnostics
│
├── scripts/
│   ├── backup.sh        Nightly VACUUM INTO + state files, keep 7
│   ├── vacuum-into.js   The consistent DB copy, verified before it counts
│   ├── wa-backup.service
│   └── wa-backup.timer  systemd units — 21:30 UTC / 03:00 IST
│
├── test.js              Self-check — `node test.js`, ~5s, no framework and no
│                        fixtures. Runs against an in-memory database and temp
│                        directories, so it never touches the repo's own state.
│                        Covers template validation, payload building, phone
│                        normalising, pricing maths, the 24h reply window, the
│                        retry ladder and quiet hours, queue ordering and its
│                        query PLANS, webhook durability, retention and auth
│
├── CSV-FORMAT.md        What the contact CSV parser accepts
├── contacts-template.csv  Sample contact list to fill in
│
├── wa.db                SQLite message store — threads, messages, raw webhook
│                        events and campaign runs. Opened in WAL mode, so
│                        `wa.db-wal` and `wa.db-shm` sit alongside it; back up
│                        all three together, not just wa.db, or a backup can
│                        miss writes that were committed to the WAL sidecar
│                        but not yet checkpointed into the main file.
├── campaign.json        Pacing state and which run is current. The send queue
│                        itself is the run_recipients TABLE — a crash resumes
│                        from what was actually sent, never from a counter
├── warmup.json          Which sending days have happened
│                        (all created at runtime and gitignored)
│
├── package.json         4 deps: express, socket.io, multer, dotenv
├── Dockerfile           For containerised deployment (Render, DigitalOcean)
├── .gitignore           Excludes .env, node_modules and the runtime state
└── README.md
```

`inbox.json`, `msg-index.json` and `opt-outs.json` no longer exist in a fresh
install — all three moved into `wa.db`. A server that still has them from before
migrates them into SQLite once, automatically, on its next boot, then renames
each to `<name>.migrated` so a later boot has nothing left to do. The `.migrated`
files are not read again; delete them once you have confirmed the data is in
`wa.db`. A file that could not be read is left exactly where it is and logged
loudly rather than renamed away behind a "0 migrated" success line.

Dependencies run one way only: `routes → services → lib → config`. Nothing in
`lib/` knows about Express, and nothing in `services/` knows about HTTP.

**Why no build step?** The frontend loads React, ReactDOM, Babel and Tailwind from CDN. Babel compiles JSX in the browser. First load takes 3–5s; cached on repeat visits. For an internal tool this is acceptable and removes all build tooling.

This is also why the UI is *shadcn-shaped* rather than actual shadcn/ui: shadcn ships TSX components you compile yourself, which needs a bundler. `ui.jsx` reproduces its token names, variants and component API by hand, so adopting the real thing later is a find-and-replace rather than a rewrite.

---

## 8. Running Locally

```bash
git clone https://github.com/ridamnibjia/meta-wa-campaign
cd meta-wa-campaign

# Install — 4 packages, ~2MB
npm install

# Configure. At minimum:
cat > .env <<'EOF'
ACCESS_TOKEN=your_system_user_token
PHONE_NUMBER_ID=your_phone_number_id
APP_PASSWORD=pick_something_long
APP_SECRET=your_meta_app_secret
EOF

node server.js
open http://localhost:3000
```

Boot prints exactly which of those four are missing, and the app tells you at the
login screen if `APP_PASSWORD` is unset rather than silently letting you in.
Every boot also prints an `ExperimentalWarning: SQLite is an experimental
feature` from Node itself — that is expected, not a misconfiguration. It comes
from the built-in `node:sqlite` module this app stores messages in, and it is
deliberately not suppressed: it is Node's own way of telling a self-hoster if
that module's behaviour is about to change in a future release.

Run the self-check any time — no framework, no network, ~5 seconds:

```bash
npm test         # 564 cases
```

It runs against an in-memory database and temp directories, so it never touches
the repo's own state files. Run it before every commit.

### The three-step flow

The dashboard is the landing page; **New campaign** is the working screen, and it
is three steps top to bottom:

1. **Upload contacts** — drop a CSV. You immediately get the parsed count, the
   billable count after opt-outs, and the estimated spend.
2. **Pick or compose a template** — choose an existing `APPROVED` template, or
   write a new one and submit it for review without leaving the app. Validation
   runs as you type. If the template has `{{1}}`, `{{2}}` … you map each variable
   to a contact field or a fixed value here.
3. **Review and send** — pace, daily cap and warm-up rung, then **Start**. Send a
   single test message to your own number first; the button is right there.

**Start stays disabled until the template is `APPROVED`**, and the server
re-checks with Meta at launch, so a stale browser tab cannot send against a
template that was rejected five minutes ago.

---

## 9. Deployment

### Option A: Cloudflare Pages (frontend) + Render (backend) — Free

This is the split deployment. Frontend served from Cloudflare's global CDN; backend runs on Render's free tier.

**Architecture:**
```
User's browser
  ↕ loads index.html from Cloudflare Pages (global CDN, free)
  ↕ connects via HTTP + WebSocket to Render backend
Render backend (server.js)
  ↕ calls Meta WhatsApp Cloud API
```

#### Step 1 — Deploy backend to Render

1. Push your code to GitHub
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your GitHub repo
4. Set:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Under **Environment Variables**, add:
   ```
   ACCESS_TOKEN          = your_system_user_token
   PHONE_NUMBER_ID       = your_phone_number_id
   BUSINESS_ID           = your_business_portfolio_id
   WABA_ID               = (optional — auto-resolved)
   APP_SECRET            = your_meta_app_secret
   APP_ID                = your_meta_app_id   ← only for media headers
   APP_PASSWORD          = a_long_random_password_you_choose
   WEBHOOK_VERIFY_TOKEN  = any_random_string_you_choose
   FRONTEND_URL          = https://your-project.pages.dev   ← add after step 3
   ```

   `APP_PASSWORD` is not optional in practice — the API returns `503 setup required`
   for every call until it is set. Generate one with `openssl rand -base64 24`.

   Two easily confused names: **`APP_SECRET` is Meta's** (App → Settings → Basic →
   App Secret) and verifies webhook signatures. **`APP_PASSWORD` is yours** — you
   invent it, and it is the dashboard login. There is nowhere to "get" it.

   `APP_ID` (App → Settings → Basic → App ID) is only needed to attach an image,
   video or document header to a template: Meta's Resumable Upload API keys on the
   app id, and nothing else substitutes for it. Leave it unset and everything else
   works — the composer greys media headers out and says why.
6. Click **Create Web Service**. Render gives you a URL like `https://meta-wa-campaign.onrender.com`

> **Free tier caveat:** Render free tier sleeps after 15 minutes of inactivity. The frontend sends a keep-alive ping every 10 minutes when it has an open connection, so as long as you keep the browser tab open during a campaign, the backend stays awake. If you close the tab mid-campaign, it may sleep. For reliability on multi-day campaigns, upgrade to the Starter plan ($7/mo) or use DigitalOcean.

#### Step 2 — Deploy frontend to Cloudflare Pages

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com) → **Create a project**
2. **Connect to Git** → select your GitHub repo
3. Set build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. Click **Save and Deploy**
5. Cloudflare gives you a URL like `https://wa-campaign.pages.dev`

#### Step 3 — Connect them

1. Copy your Cloudflare Pages URL (e.g. `https://wa-campaign.pages.dev`)
2. Go back to your Render service → **Environment** → update `FRONTEND_URL` to that URL
3. Render auto-redeploys with the new CORS setting

#### Step 4 — First-time frontend setup

When you open your Cloudflare Pages URL for the first time, the app shows a one-time setup screen asking for your Render backend URL. Enter it (e.g. `https://meta-wa-campaign.onrender.com`) and click **Save and Connect**. The app tests the connection, then saves the URL to your browser's localStorage. You will not be asked again.

---

### Option B: A small VM behind a Cloudflare Tunnel

What the reference deployment actually runs, and the cheapest way to get a stable
public HTTPS URL on your own domain with **no open inbound ports at all** — the
tunnel dials out, so the VM's firewall stays shut.

- A free-tier / `e2-micro`-class VM on GCP, Oracle Cloud or similar
- `systemd` keeps the app up and restarts it on crash
- `cloudflared` provides TLS, DNS and DDoS protection for free
- Total cost on a free-tier VM with a domain you already own: **£0/month**

Outline — roughly 20 minutes end to end:

1. Create the VM, install Node 22 (22.5.0 or newer — the message store uses the built-in `node:sqlite` module, which does not exist before that) and clone the repo with a read-only deploy key.
2. Write `.env` by hand on the VM. It is gitignored, so it never arrives via `git pull`. `APP_PASSWORD` and `APP_SECRET` are both mandatory here — this box is on the public internet.
3. A `systemd` unit (`Restart=always`) keeps the app alive across crashes and reboots.
4. `cloudflared tunnel create`, then `cloudflared tunnel route dns <tunnel> your.domain`, then run `cloudflared` as its own service.
5. Point Meta's webhook at `https://your.domain/webhook` and subscribe the fields in §10.

Deploys are a deliberate three-liner, not a push-to-deploy hook — worth it when a
bad deploy mid-campaign costs real money:

```bash
git pull && npm ci --omit=dev && sudo systemctl restart wa-campaign
```

Safe to run mid-campaign: the queue is on disk and the resume point is derived
from it, so the app resumes at the next unsent contact rather than restarting the
list.

#### Backing it up

`wa.db` is opened in **WAL mode**, so the newest writes live in `wa.db-wal` until
SQLite checkpoints them into the main file. Copying `wa.db` alone from a running
server therefore produces a backup that is silently missing recent messages,
statuses and queue rows — and Meta's API is push-only, so nothing lost that way
can be fetched back.

`scripts/backup.sh` does it correctly, and is safe to run while a campaign is
sending:

```bash
sh scripts/backup.sh          # writes ~/backups/<ISO timestamp>/
```

It uses SQLite's `VACUUM INTO`, which takes a read transaction — consistent as of
the instant it starts, no service stop, no lock on the app — then **opens the
copy and runs `PRAGMA integrity_check` on it**. A copy nobody has read is not a
backup. It also copies `warmup.json`, `campaign.json` and a tarball of
`uploads/`, keeps the newest 7, and publishes each night's directory only once
everything above succeeded, so a run that died half way through can never be
mistaken for last night's.

`media/` is deliberately **not** backed up: inbound customer files expire at 90
days by design, and restoring them past their own retention would undo a promise
the UI made. `.env` is credentials, not state — keep it wherever you keep
secrets. `warmup.json` is reconciled against the message store at every boot, so
losing it alone is recoverable; losing the database is not.

To run it nightly, install the two units in `scripts/`:

```bash
sudo cp scripts/wa-backup.service scripts/wa-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wa-backup.timer
systemctl list-timers wa-backup.timer      # confirm the next run
```

The timer fires at 21:30 UTC — 03:00 IST, inside the app's own quiet-hours
window, so the database is at its quietest. `Persistent=true` means a box that
was off overnight backs up when it returns rather than skipping silently.

**Restoring** is a file copy, which is the whole point of doing this on top of
whatever disk-level snapshots your host takes:

```bash
sudo systemctl stop wa-campaign
cp ~/backups/<stamp>/wa.db       ~/app/wa.db
rm -f ~/app/wa.db-wal ~/app/wa.db-shm    # the copy is already checkpointed
cp ~/backups/<stamp>/warmup.json ~/app/warmup.json
tar -xzf ~/backups/<stamp>/uploads.tar.gz -C ~/app
sudo systemctl start wa-campaign
```

Deleting the `-wal` and `-shm` sidecars matters: they belong to the database you
just replaced, and leaving them beside a different file is how a restore turns
into a corrupt database.

If you are on a cloud VM, take disk snapshots as well — they cover losing the
machine, which a backup on that same machine does not. The two are complements:
snapshots restore a *host*, this restores a *database*, including from the case a
snapshot cannot help with — a database that is intact but wrong, and has been
faithfully snapshotted that way every night.

---

### Option C: DigitalOcean Droplet (everything)

Recommended for reliable multi-day campaigns. The existing `$8/mo` 1 GB droplet
works perfectly — this app uses ~50 MB RAM (no Chrome). **Unless you want
ClamAV**, which needs ~1 GB to itself and about 4 GB on the box; see the virus
scanning section.

```bash
ssh root@YOUR_DROPLET_IP
mkdir -p /opt/meta-wa && cd /opt/meta-wa
git clone https://github.com/YOUR_USERNAME/meta-wa-campaign .
cp .env.example .env && nano .env    # fill in token + phone number ID
ufw allow 3002/tcp
docker build -t meta-wa-img .
docker run -d --name meta-wa -p 3002:3000 --env-file .env --restart unless-stopped meta-wa-img
# Visit: http://YOUR_DROPLET_IP:3002
```

**Updating:**
```bash
cd /opt/meta-wa && git pull
docker stop meta-wa && docker rm meta-wa
docker build -t meta-wa-img . && docker run -d --name meta-wa -p 3002:3000 --env-file .env --restart unless-stopped meta-wa-img
```

**Full cleanup:**
```bash
docker stop meta-wa && docker rm meta-wa && docker rmi meta-wa-img
rm -rf /opt/meta-wa && ufw delete allow 3002/tcp
```

---

### Option D: Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select your repo
3. Railway auto-detects Node.js and runs `npm start`
4. Under **Variables**, add all keys from `.env.example`
5. Railway gives a public URL automatically

Railway provides $5/month free credit. This app easily stays within free limits.

---

## 10. Webhook Setup (delivery receipts, replies, opt-outs)

Campaigns send fine without a webhook. What you lose without one is everything
that comes *back*: `Delivered` and `Read` counts, inbound replies in the inbox,
one-tap opt-outs, and template approval notifications.

**Requirement:** a public HTTPS URL. Render, Railway and a Cloudflare Tunnel all
provide one.

### Two different secrets — do not mix them up

| | Purpose | Where it comes from |
|---|---|---|
| `WEBHOOK_VERIFY_TOKEN` | Answers Meta's one-time `GET` handshake when you click **Verify and Save** | Any random string **you invent**, typed identically in both places |
| `APP_SECRET` | Verifies that every subsequent `POST` really came from Meta | **Meta gives you this** — App Settings → Basic → App Secret → Show |

The verify token is used once at setup. `APP_SECRET` is what actually protects
the endpoint, on every request, forever. **If `APP_SECRET` is unset, every
webhook `POST` is rejected with 401** and it will look like Meta is not sending
anything.

### Setup

1. [Meta for Developers](https://developers.facebook.com) → your app → **WhatsApp** → **Configuration**
2. Under **Webhook**, click **Edit**
3. **Callback URL:** `https://your-domain/webhook`
4. **Verify Token:** the exact string in your `.env` as `WEBHOOK_VERIFY_TOKEN`
5. **Verify and Save** — the server logs `Webhook verified by Meta`
6. Click **Manage** and subscribe to these fields:
   - `messages` — delivery receipts, read receipts, inbound replies, opt-out taps
   - `message_template_status_update` — approval / rejection notifications

Step 6 is the one people miss. Without `message_template_status_update`, the app
falls back to polling Meta every 15 seconds for template status, which works but
is slower and noisier.

---

## 11. How the Code Works

### Backend

**Express routes.** `/webhook` mounts first and stays unauthenticated — Meta
cannot sign in, so it proves itself with an HMAC signature instead. Everything
under `/api` sits behind `requireAuth`. That ordering *is* the security boundary:
a new router added below the gate is protected by default.

```
— public —
GET  /health                    health check (Docker, keep-alive, uptime pings)
GET  /webhook                   Meta's verification challenge
POST /webhook                   signed: statuses, inbound messages, template updates
POST /api/login                 password → session cookie (rate limited)
POST /api/logout
GET  /api/session               is a password configured? am I signed in?

— behind the password —
POST   /api/config              save credentials and settings
POST   /api/params              map template {{n}} to a contact field or fixed value
GET    /api/account-info        quality rating + messaging tier from Meta
POST   /api/warmup              toggle the warm-up ladder
GET    /api/state               full campaign state snapshot
GET    /api/logs                server log buffer
GET    /api/faillog             per-contact failure detail

POST   /api/upload-csv          parse CSV → contacts + cost estimate
GET    /api/contacts            the full parsed list with sent / opted-out flags
GET    /api/contacts/directory           every known contact (?disabled=1 to filter)
POST   /api/contacts/directory           { disable: [...], enable: [...] }
GET    /api/contacts/directory/download  export the disabled list as JSON
GET    /api/campaign/skips               who was not messaged, grouped by what to do
GET    /api/inbox/search?q=              search messages, threads and numbers
GET    /api/inbox/:waId?before=          one page of transcript, newest first
GET    /api/diagnostics                  system state
POST   /api/diagnostics/replay           reprocess stored webhooks

GET    /api/templates           list templates from Meta
GET    /api/validate-template   status, category, language, body, variable count
POST   /api/template/create     compose and submit for review
GET    /api/template/status     poll approval status
DELETE /api/template/:name      delete a template

POST   /api/test-send           one message to a number you choose
POST   /api/start               start the campaign loop
POST   /api/pause               set pauseFlag
POST   /api/resume              clear pauseFlag, restart the loop
POST   /api/stop                set stopFlag
POST   /api/reset               clear counters and the queue

GET    /api/inbox               conversation summaries
GET    /api/inbox/:waId         one thread
POST   /api/inbox/:waId/reply   free-form reply inside the 24h window
```

**Layering.** Dependencies run one way: `routes → services → lib → config`.
Nothing in `lib/` knows about Express; nothing in `services/` knows about HTTP.
`config.js` imports nothing at all, which is what lets everything else depend on
it without a cycle.

**Durability.** The send queue is the `run_recipients` table in `wa.db`, written
when the CSV is uploaded rather than when sending starts, and
`resumeIfInterrupted()` runs at boot. There is deliberately **no cursor**: the
resume point is a query for the first row that has no message id yet, so a crash
cannot leave a saved index ahead of what was actually sent and silently skip
people. The recipient row is stamped before the message row, which means the
worst case is one duplicate rather than one omission. A crash, a redeploy or a
`systemctl restart` mid-campaign picks up at the next unsent contact.

**Late receipts.** Every message — inbound or outbound, campaign or reply — lives
in the `messages` table in `wa.db`, keyed by wamid. A read receipt that arrives
an hour after the campaign finished still updates the right row and the right
counter, because the row outlives the in-memory run: counters are derived by
querying `messages`, not incremented by hand.

**Campaign loop:** A `while` loop inside an async function. Uses `await sleep(ms)` to pause between sends — this yields the event loop so Express can still handle HTTP requests (pause, stop) while the campaign runs. No background threads. No workers. Just async/await.

```
while true:
  if stopFlag → exit
  if pauseFlag → sleep 500ms, continue

  ask the queue for the next contact (SQL, never a counter):
      first an untried row, in CSV order
      then a retry row whose deadline has passed, soonest first
  if none right now:
      if any contact is on the retry ladder:
          near deadline (<60s) → sleep to it quietly and continue
          further off        → phase = waiting, announce it, sleep in 1s
                               slices to the deadline, continue
      else → phase = done, exit

  if daily cap reached      → sleep until midnight IST, continue
  if inside quiet hours     → sleep until 08:00 IST, continue
  if contact disabled since the queue was built → record 'disabled', continue

  POST to Meta API with template name + recipient phone

  if rate limited  → sleep retry-after, retry the SAME contact,
                     up to 3 times; after that fall through to the ladder
  if retryable and attempts remain
                   → stamp retry_after on the row (+3h, deferred past
                     quiet hours), continue
  if undeliverable → disable the contact, record it, continue
  if other error   → record 'failed' on the queue row, log it, continue

  stamp the queue row, then write the message row, sleep delaySec
  broadcast the derived state to all browsers (coalesced, 4/second max)
```

The "quietly" in that third branch is not a detail. Each contact's retry deadline
is written when its own failure webhook lands, so a rung of a hundred is a
hundred deadlines smeared over minutes — and taking the full announce-and-save
path for every three-second gap between them cost a log line, a synchronous
`fsync` and two whole state rebuilds *per contact*. On a real 775-contact run
that fired 340 times, the rung took hours instead of minutes, and the deadlines
it pushed out then cascaded past midnight.

**Meta API call (one send):**
```
POST https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919000000001",
  "type": "template",
  "template": {
    "name": "your_template_name",
    "language": { "code": "en" }
  }
}
```

Response from Meta:
```json
{ "messages": [{ "id": "wamid.HBgL..." }] }
```

That message id is written to the `messages` table and stamped onto the queue
row. When the webhook later reports `delivered`, `read` or `failed` for it, the
row is updated — and every counter on screen is a `GROUP BY` over those rows
rather than an integer somebody incremented, so there is nothing that can drift
out of step with the messages it counts.

**Phone normalisation:** Indian numbers in any format (`9000000001`, `+91 90000 00001`, `09000000001`) are all normalised to `919000000001` — the format Meta requires (no `+`, digits only, country code prefix). A bare 10-digit number is assumed Indian; outside India write the full international form. Full rules in [CSV-FORMAT.md](CSV-FORMAT.md).

### Frontend (`public/`)

React 18, ReactDOM and Babel standalone from CDN; Babel compiles the JSX in the
browser on first load (~3–5s, cached after). No build step, no bundler, no
`package.json` on the frontend side. `index.html` is the shell, `ui.jsx` the
primitives, `app.jsx` the API client and router, and one file per view under
`views/`.

**Why no build step?** For a self-hosted internal tool, a bundler is tooling to
maintain, a CI step to debug and a `node_modules` to keep current, in exchange
for a few seconds on first paint. Not worth it here. The trade is deliberate,
not an oversight.

The UI is *shadcn-shaped* rather than actual shadcn/ui: shadcn ships TSX you
compile yourself, which needs the bundler we just declined. `ui.jsx` reproduces
its token names, variants and component API by hand, so adopting the real thing
later is a find-and-replace rather than a rewrite.

**Session gate:** the app calls `/api/session` on load and renders the login
screen, a "set `APP_PASSWORD` first" notice, or the dashboard accordingly. The
static files are public; everything behind them is not.

**Real-time updates:** one authenticated Socket.io connection. The server emits
`state` after every send, so counters and the progress bar move live in every
open tab.

**Backend URL detection:** relative URLs when the backend serves the UI. In the
split Pages + Render deployment it reads the backend URL from `localStorage`,
prompting once if unset.

**Template validation:** the template name input debounces 1.2s, then calls
`/api/validate-template` for status, category, language, body and variable count.
The category is saved back to config, which is what makes the cost estimate
correct without you telling it anything.

**Keep-alive:** pings `/health` every 10 minutes while a tab is open, to stop
Render's free tier sleeping mid-campaign.

---

## 12. Environment Variables

Create a `.env` in the project root. Everything except the four required keys has
a working default.

### Required

| Variable | Description |
|---|---|
| `ACCESS_TOKEN` | Permanent System User token from Meta. Equivalent to admin access to your WhatsApp account. |
| `PHONE_NUMBER_ID` | Phone Number ID from the Meta dashboard — not the phone number. |
| `APP_PASSWORD` | The password for the dashboard — **one you invent**, not one Meta issues. Do not confuse it with `APP_SECRET` below. **Until this is set, every API call returns 503 and the app is unusable.** Not a default on purpose. |
| `APP_SECRET` | Meta App Secret, used to verify webhook signatures. Without it every webhook `POST` is rejected with 401, so you get no delivery receipts, replies or opt-outs. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `WABA_ID` | auto-resolved | WhatsApp Business Account ID. Learned from the first webhook if blank. |
| `APP_ID` | unset | Meta App ID. Needed **only** to put an image, video or document header on a template — Meta's Resumable Upload API keys on the app id, and neither the WABA id nor the business id substitutes. Unset, the composer greys media headers out and explains why; everything else is unaffected. |
| `BUSINESS_ID` | — | Business Portfolio ID, used to auto-resolve `WABA_ID`. |
| `WEBHOOK_VERIFY_TOKEN` | — | Any random string. Must match what you type into Meta's webhook config. |
| `FRONTEND_URL` | (same-origin only) | Set to your exact frontend origin for the split Pages + Render deployment. |
| `TEMPLATE_NAME` | — | Pre-selected template name. |
| `TEMPLATE_LANGUAGE` | `en` | Template language code. |
| `TEMPLATE_CATEGORY` | `MARKETING` | Drives the cost estimate. |
| `API_VERSION` | `v23.0` | Meta Graph API version. |
| `PORT` | `3000` | Server port. |
| `WA_QUIET_HOURS` | on | Set to `0` to let campaigns send between 23:00 and 07:00 IST. Deliberately env-only — there is no UI switch, because night notifications are what get a number blocked and reported. |

### Backup (`scripts/backup.sh` only — the app never reads these)

| Variable | Default | Description |
|---|---|---|
| `WA_APP_DIR` | `/home/earlyearnly/app` | Where `wa.db` and the state files live. |
| `WA_BACKUP_DIR` | `/home/earlyearnly/backups` | Where nightly backups are written. |
| `WA_BACKUP_KEEP` | `7` | How many nightly directories to keep. |

### Inbound media safety

See [Inbound customer media](#inbound-customer-media) for what these actually do.

| Variable | Default | Description |
|---|---|---|
| `CLAMAV_ADDRESS` | unset | Unix socket path (`/var/run/clamav/clamd.ctl`) or `host:port` for `clamd`. Unset disables scanning and files are labelled "not virus-scanned". Set but unreachable **refuses saves** rather than silently passing them. Budget ~1 GB RAM for `clamd` and ~4 GB on the machine; under 3 GB the app warns at boot. |
| `CLAMAV_TIMEOUT_MS` | `30000` | How long to wait for a scan verdict before refusing the save. |
| `WA_MEDIA_RETENTION_DAYS` | `90` | How long a saved inbound file stays on this server. The row survives the sweep; only the bytes go. |
| `WA_MEDIA_PREVIEW_HOURS` | `24` | How long a file you only *previewed* is kept before the same sweep removes it. |
| `WA_MEDIA_MAX_BYTES` | `104857600` | Largest inbound file this server will download (100 MB — Meta's own document maximum). |
| `WA_MEDIA_MIN_FREE_BYTES` | `2147483648` | Free-disk floor (2 GB) below which saves are refused, so a download cannot fill the disk out from under SQLite. |

### Pricing (cost estimates only — never affects what Meta charges)

| Variable | Default | Description |
|---|---|---|
| `CURRENCY` | `₹` | Symbol shown in the UI. |
| `PRICE_MARKETING` | `0.78` | Per delivered marketing message. |
| `PRICE_UTILITY` | `0.115` | Per delivered utility message. |
| `PRICE_AUTH` | `0.125` | Per delivered authentication message. |

The defaults are India rates as of mid-2025. Meta revises its rate card without
notice and this app does not fetch it, so **every figure the UI shows is an
estimate.** Set these to your own country's rates from
[Meta's pricing page](https://developers.facebook.com/docs/whatsapp/pricing).

---

## 13. Meta Error Codes

The **App behavior** column is `skipDisposition()` in `src/lib/errors.js`, and it
is the same table the skip report groups by. `retry` puts the contact back on the
queue (six attempts, three hours apart, never at night); `fix` means retrying
unchanged just reproduces the failure once per contact.

| Code | Meaning | App behavior |
|---|---|---|
| `131026` | Not on WhatsApp, or blocked by Meta on quality grounds | `permanent` — contact disabled `failed_hard`, never retried |
| `131049` | Per-person marketing cap, counted across every business | `retry` — nothing on your side caused it or fixes it |
| `131000`, `131016` | Meta fault it tells you is transient | `retry` |
| `130429`, `80007`, `4` | Rate limit | Slept off in the loop **three times**, then handed to the ladder so one throttled number cannot own the campaign |
| `130472` | Meta held this recipient back for a marketing experiment | `unclassified` on purpose — a holdout window runs for days, so all six attempts would land inside it, but the contact is fine and must not be written off |
| `-1` | Network error (no response from Meta) | `retry` — the blip that used to drop one contact from a run forever |
| `131047` | Re-engagement window expired | `fix` — we sent the wrong kind of message |
| `132000`, `132001` | Template not found / not approved | `fix` — check the name, or approve it in the dashboard |
| `132015`, `132016` | Template paused or disabled by Meta | `fix` — every remaining send fails identically |
| `131042` | Billing not set up | `fix` |
| `131031` | Account locked on policy grounds | `fix` |
| `190`, `10`, `200` | Bad token / missing permission | `fix` — 400 identical failures otherwise |
| `100` | Invalid parameter | `fix` — check Phone Number ID format |
| anything else | Meta sent a code this app has no entry for | `unclassified` — shown raw, never guessed |

---

## 14. Security

This app holds a token that can spend money and message your customers, and it is
usually reachable on a public URL. It is built to fail closed.

### The password gate

`APP_PASSWORD` protects the entire `/api` surface **and** the Socket.io
connection. Without the socket check the password would be decorative — a
stranger could open a socket and stream campaign state, logs and inbound customer
messages without ever calling the REST API.

- No `APP_PASSWORD` set → every API call returns `503`. The app is never "open by default".
- Passwords are compared as SHA-256 digests through `crypto.timingSafeEqual`, so
  neither the length nor a matching prefix leaks through response timing.
- 10 failed attempts per IP per 15 minutes, then `429`.
- Sessions live in memory only. A restart logs you out — deliberate, because
  persisting session tokens would put a credential-equivalent on disk next to the
  data files just to save typing a password after a deploy.
- Session cookies are `httpOnly` + `sameSite=strict`; state-changing requests also
  have their `Origin` checked.

### Webhook authenticity

`POST /webhook` is the one route outside the password gate, because Meta cannot
sign in. Instead every payload is verified with HMAC-SHA256 over the **raw**
request bytes against `APP_SECRET`, compared in constant time. Unsigned or
mis-signed calls get a `401` before any handler runs.

This matters more than it looks: that endpoint writes to your opt-out list and
your inbox. Unverified, anyone who found the URL could forge opt-outs for your
best customers or plant fake conversations.

### Credentials

- `ACCESS_TOKEN` belongs in `.env` only. `.gitignore` excludes `.env` — verify
  before your first push: `git status` must not show it.
- If a token leaks: **Meta Business Suite → System Users → Generate New Token**.
  The old one dies instantly.
- If `APP_SECRET` leaks, rotate it in **App Settings → Basic → App Secret → Reset**.
- Never commit a real contact CSV. Phone numbers are personal data in most
  jurisdictions, and a public repo is a permanent, indexed, un-deletable copy.
- Set `FRONTEND_URL` to your exact frontend origin in production if you split the
  deployment. Leave it blank when the backend serves the UI itself.

### Inbound customer media

A customer can send you anything WhatsApp accepts. Everything below is about
that: files this app did not create, from people you may never have met.

**Nothing downloads automatically.** The webhook records a *descriptor* — media
id, mime type, filename, size, checksum — and stops there. The bytes only reach
this server when an operator asks for that specific attachment.

There are two ways to ask, and they differ in one thing only:

| Button | What it does | How long the copy lasts |
|---|---|---|
| **Preview** | Fetches the file so you can look at it before deciding | Hours (`WA_MEDIA_PREVIEW_HOURS`, default 24) unless you press **Keep** |
| **Save** | Fetches the file and commits to it | 90 days (`WA_MEDIA_RETENTION_DAYS`) |

A previewed file is size-capped, checksummed, virus-scanned and classified
exactly as a saved one is — the risk lives in the file, not in which button
asked for it. The only difference is which clock the retention sweep runs
against it. **Keep** moves it onto the 90-day clock; **Discard** removes it now.

This is also why **Download** appears only after the file is here. Before that,
the bytes are still on WhatsApp's servers behind an access token your browser
does not have, so there is nothing for a download link to point at.

#### Files are classified from three signals, not one

The mime type on the row is a string the sender chose, and so is the filename.
Trusting either alone is how `invoice.pdf` turns out to be an executable. So
every saved file gets a verdict from three independent signals — the declared
mime, the filename extension, and the file's actual leading bytes — and the
**worst** of the three wins.

| Tier | Examples | What happens |
|---|---|---|
| `safe` | JPEG, PNG, WebP, GIF, WhatsApp audio and video | Previews in the thread |
| `ok` | PDF, docx/xlsx/pptx, txt | Downloads as a file. Never rendered. |
| `warn` | zip/rar/7z, macro Office (docm/xlsm), csv, rtf, xml, legacy `.doc`/`.xls` | Downloads behind a confirmation |
| `block` | exe, msi, bat, vbs, ps1, jar, apk, dmg, iso, hta, reg, **html**, **svg** | Refused. Downloadable only by explicitly accepting the risk. |

Two rules are worth stating outright:

- **`safe` requires all three signals to agree.** A file declared `image/png`
  whose bytes match no image signature is demoted to `ok` and downloads instead
  of previewing. This costs inline preview on exotic formats like HEIC and TIFF.
  It buys the guarantee that nothing renders in your browser on a stranger's
  say-so.
- **Zip is resolved by extension**, because it cannot be resolved any other way:
  `.docx`, `.xlsx`, `.apk` and `.jar` are all literally zip files with identical
  magic bytes. `.apk`/`.jar` block, `.docm`/`.xlsm` warn, `.docx`/`.xlsx` are ok,
  a bare `.zip` warns.

Regardless of tier, every response carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'`, and anything but `safe`
is served as `application/octet-stream`.

#### Virus scanning with ClamAV (optional)

If you point the app at a running `clamd`, every file is scanned **in memory,
before a single byte is written to disk** — so a signature hit never leaves
malware on the filesystem at all, not even briefly.

```bash
# Debian / Ubuntu
sudo apt install clamav clamav-daemon
sudo systemctl enable --now clamav-freshclam clamav-daemon
```

```bash
# .env
CLAMAV_ADDRESS=/var/run/clamav/clamd.ctl
# or, if clamd listens on TCP:
# CLAMAV_ADDRESS=127.0.0.1:3310
CLAMAV_TIMEOUT_MS=30000
```

**Budget about 1 GB of RAM for `clamd` alone, and 4 GB on the machine.** `clamd`
holds the entire signature database in memory, and that number — not CPU, not
disk — is what decides whether you can run it. Worse, `freshclam` briefly holds
**two** copies while it swaps a new database in, which is why the crash tends to
arrive days after a deploy that looked fine.

The app checks this at boot and on the Diagnostics page: with `CLAMAV_ADDRESS` set
on a machine under 3 GB you get a warning naming both ways out. It is a warning
and not a refusal — which process the kernel kills is not ours to decide, and an
operator who has tuned `clamd`'s own limits may be fine. But know the failure
mode: if `clamd` is the one killed, it is then *configured but unreachable*, and
every media save is refused (by design — see the fail-closed rule above), which
reads like an app bug rather than an out-of-memory kill.

On 1–2 GB, leave `CLAMAV_ADDRESS` unset. The three-signal file-risk classifier
still runs and still labels every file; it needs no daemon.

Prove it actually works before you trust it. EICAR is a harmless standard test
string every scanner is required to flag:

```bash
curl -s https://secure.eicar.org/eicar.com -o /tmp/eicar.txt
clamdscan /tmp/eicar.txt      # must print: … Eicar-Signature FOUND
rm /tmp/eicar.txt
```

The unset-versus-broken distinction is deliberate and matters:

| `CLAMAV_ADDRESS` | Behaviour |
|---|---|
| Unset | Files save normally, labelled **"Not virus-scanned"** in the thread. The app works without a scanner. |
| Set, daemon healthy | Clean files save. A signature hit is **refused and never written**. |
| Set, daemon down or timing out | **Saves are refused.** Never a silent "clean". |

An operator who asked for a scanner should not quietly stop getting one. A file
saved before you installed ClamAV is scanned the first time anyone requests it,
so turning scanning on later still covers what is already on disk.

#### How long files are kept — two separate clocks

| Clock | Window | Who enforces it |
|---|---|---|
| Meta's copy | **30 days** from the message | Meta. Nothing you can do about it. |
| Your saved copy | **90 days** from download (`WA_MEDIA_RETENTION_DAYS`) | This app, swept on boot and daily. |
| A preview you never kept | **24 hours** (`WA_MEDIA_PREVIEW_HOURS`) | The same sweep, on a shorter cutoff. |
| The chat itself | Indefinite | Never swept — message history is not media. |

The preview clock is what stops browsing a thread from quietly building a
permanent archive of every file anyone ever sent you.

When a file is swept, only the bytes go: the message and its attachment row
survive, and the bubble reverts to a **Save** button. If the message is by then
older than 30 days, that Save honestly reports Meta deleted its copy too.

#### The honest limit

An operator who clicks through the confirmation on a `block` file can still put
an executable in their own Downloads folder. That is their machine and their
decision. What this app guarantees is narrower and worth stating plainly: such a
file is **never rendered inline, never content-sniffable, and never one click
away**.

---

## License

MIT. Fork it, modify it, deploy it.

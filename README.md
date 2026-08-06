# WhatsApp Cloud API Campaign Manager

Send approved WhatsApp marketing templates to bulk contacts using Meta's official API. Self-hosted, open source, no third-party services beyond Meta.

**Stack:** Node.js · Express · Socket.io · React (no build step) · Meta WhatsApp Cloud API

### What it does

- **Compose and submit templates** to Meta from the app, with local validation that catches the documented rejection causes before you spend a review cycle.
- **Bulk send** from a CSV, at a configurable pace, with live per-message state over WebSocket.
- **Survives restarts.** The send queue and cursor are written to disk, so a crash or deploy resumes where it stopped instead of re-sending.
- **Warm-up ladder.** A brand-new number climbs `20 → 50 → 100 → 250 → 500 → 1000` per sending day, and holds its rung if quality drops to YELLOW or RED.
- **One-tap opt-out.** A "Stop promotions" button on every template; taps arrive by webhook and that number is skipped forever after.
- **Two-way inbox.** Inbound replies are threaded, and you can reply free-form inside Meta's 24-hour customer-service window.
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
6. [Contacts, CSV and Opt-outs](#6-contacts-csv-and-opt-outs)
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
4. Leave **Stop promotions** checked. Taps on that button are captured by the webhook, written to `opt-outs.json`, and skipped on every future run.
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

This app tracks `dailyCount` and pauses at midnight when the cap is reached, automatically resuming the next day.

At 2s per message, 2,238 contacts takes ~75 minutes. If you are on Tier 1 (1,000/day), the first 1,000 go out in ~33 minutes; the rest resume the following day.

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
| 6+ | 1,000 |

- The rung advances per **sending day**, not per calendar day. A day you send
  nothing does not move you up.
- If your quality rating is `YELLOW` or `RED`, today holds one rung *below* where
  it would otherwise be, instead of climbing.
- The effective cap is always `min(warm-up rung, your own daily cap)`.
- Progress persists in `warmup.json`, because the whole point is spanning days.
- Toggle it off in Settings once the number is established.

---

## 6. Contacts, CSV and Opt-outs

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

**[Full format rules, edge cases and gotchas → CSV-FORMAT.md](CSV-FORMAT.md)**

After uploading, **View all** shows every parsed row exactly as it will be sent —
name, `+number`, and whether it is already opted out or already sent. Check it
before you spend money.

### Opt-outs

Every template the app composes carries a **Stop promotions** quick-reply button.
When someone taps it:

1. Meta delivers a `button` webhook to `POST /webhook`.
2. The signature is verified, then the number is appended to `opt-outs.json`.
3. Every future campaign skips it — including re-uploads of the same old list.

Opt-outs are also editable by hand, because people ask to be removed by phone or
in person and ask to be put back later. `GET /api/optouts/download` exports the
list as JSON so you can keep it when you move servers.

Meta *also* enforces its own opt-out signal: error `131026` means the recipient
blocked marketing at the WhatsApp level. Those are counted as **skipped**, not
failed — nothing was wrong with your send.

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
│   │                    opt-outs, warm-up, message index, state snapshot
│   ├── middleware/
│   │   └── auth.js      Password gate, sessions, login rate limit
│   └── routes/          One router per resource; index.js mounts them and
│                        decides what sits behind the password
│
├── public/
│   ├── index.html       Shell — Tailwind CDN, design tokens, script tags
│   ├── ui.jsx           shadcn-shaped primitives (Card, Button, Dialog, …)
│   ├── app.jsx          API client, session gate, socket, hash router
│   └── views/           dashboard, campaign, inbox, settings
│
├── test.js              Self-check for the pure functions — `node test.js`
│                        No framework. Covers template validation, payload
│                        building, phone normalising, pricing maths, the 24h
│                        reply window, webhook durability and auth
│
├── CSV-FORMAT.md        What the contact CSV parser accepts
├── contacts-template.csv  Sample contact list to fill in
│
├── opt-outs.json        Numbers that tapped "Stop promotions"
├── wa.db                SQLite message store — threads, messages, raw webhook
│                        events and campaign runs. Opened in WAL mode, so
│                        `wa.db-wal` and `wa.db-shm` sit alongside it; back up
│                        all three together, not just wa.db, or a backup can
│                        miss writes that were committed to the WAL sidecar
│                        but not yet checkpointed into the main file.
├── campaign.json        Send queue + cursor, so a restart resumes
├── warmup.json          Which sending days have happened
│                        (all created at runtime and gitignored)
│
├── package.json         4 deps: express, socket.io, multer, dotenv
├── Dockerfile           For containerised deployment (Render, DigitalOcean)
├── .gitignore           Excludes .env, node_modules and the runtime state
└── README.md
```

`inbox.json` and `msg-index.json` no longer exist in a fresh install — both moved
into `wa.db` (§ below). A server that still has them from before this change
migrates them into SQLite once, automatically, on its next boot, then renames
each to `<name>.migrated` so a later boot has nothing left to do. The `.migrated`
files are not read again; delete them once you have confirmed the data is in
`wa.db`.

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

Run the self-check any time — no framework, no network, ~1 second:

```bash
node test.js     # 176 cases
```

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
   APP_PASSWORD          = a_long_random_password_you_choose
   WEBHOOK_VERIFY_TOKEN  = any_random_string_you_choose
   FRONTEND_URL          = https://your-project.pages.dev   ← add after step 3
   ```

   `APP_PASSWORD` is not optional in practice — the API returns `503 setup required`
   for every call until it is set. Generate one with `openssl rand -base64 24`.
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

Safe to run mid-campaign: the queue and cursor are on disk, so the app resumes at
the next unsent contact rather than restarting the list.

---

### Option C: DigitalOcean Droplet (everything)

Recommended for reliable multi-day campaigns. The existing `$8/mo` 1GB droplet works perfectly — this app uses ~50MB RAM (no Chrome).

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
GET    /api/optouts             current opt-out list
POST   /api/optouts             add or remove numbers by hand
GET    /api/optouts/download    export opt-outs as JSON

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

**Durability.** The send queue and cursor are written to `campaign.json` as the
loop advances, and `resumeIfInterrupted()` runs at boot. A crash, a redeploy or
an `systemctl restart` mid-campaign picks up at the next unsent contact — it does
not restart the list, so nobody gets messaged twice.

**Late receipts.** Every message — inbound or outbound, campaign or reply — lives
in the `messages` table in `wa.db`, keyed by wamid. A read receipt that arrives
an hour after the campaign finished still updates the right row and the right
counter, because the row outlives the in-memory run: counters are derived by
querying `messages`, not incremented by hand.

**Campaign loop:** A `while` loop inside an async function. Uses `await sleep(ms)` to pause between sends — this yields the event loop so Express can still handle HTTP requests (pause, stop) while the campaign runs. No background threads. No workers. Just async/await.

```
while contacts remain:
  if stopFlag → exit
  if pauseFlag → sleep 500ms, continue
  if daily cap reached → sleep until midnight, continue
  POST to Meta API with template name + recipient phone
  if 429 rate limit → sleep retry-after seconds, retry same contact
  if skip code (opted out / ecosystem health) → increment skipped, continue
  if other error → increment failed, log it, continue
  increment accepted, sleep delaySec seconds
  broadcast updated state to all connected browsers via Socket.io
```

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

The message ID is stored in `S.msgIndex`. When the webhook later reports `delivered` or `read` for that ID, the counter is incremented and broadcast to the UI.

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
| `APP_PASSWORD` | The password for the dashboard. **Until this is set, every API call returns 503 and the app is unusable.** Not a default on purpose. |
| `APP_SECRET` | Meta App Secret, used to verify webhook signatures. Without it every webhook `POST` is rejected with 401, so you get no delivery receipts, replies or opt-outs. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `WABA_ID` | auto-resolved | WhatsApp Business Account ID. Learned from the first webhook if blank. |
| `BUSINESS_ID` | — | Business Portfolio ID, used to auto-resolve `WABA_ID`. |
| `WEBHOOK_VERIFY_TOKEN` | — | Any random string. Must match what you type into Meta's webhook config. |
| `FRONTEND_URL` | (same-origin only) | Set to your exact frontend origin for the split Pages + Render deployment. |
| `TEMPLATE_NAME` | — | Pre-selected template name. |
| `TEMPLATE_LANGUAGE` | `en` | Template language code. |
| `TEMPLATE_CATEGORY` | `MARKETING` | Drives the cost estimate. |
| `API_VERSION` | `v23.0` | Meta Graph API version. |
| `PORT` | `3000` | Server port. |

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

| Code | Meaning | App behavior |
|---|---|---|
| `131026` | Recipient opted out of marketing | Skipped (not counted as failure) |
| `131049` | Ecosystem health — Meta throttle | Skipped |
| `131047` | Re-engagement window expired | Skipped |
| `130429` | Rate limit hit | Auto-retry with backoff |
| `132000` | Template not found | Failed — check template name spelling |
| `132001` | Template not approved | Failed — approve in Meta dashboard |
| `131005` | Access denied | Failed — check token has correct permissions |
| `100` | Invalid parameter | Failed — check Phone Number ID format |
| `-1` | Network error (no response from Meta) | Failed — check server connectivity |

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

---

## License

MIT. Fork it, modify it, deploy it.

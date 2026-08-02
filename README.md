# WhatsApp Cloud API Campaign Manager

Send approved WhatsApp marketing templates to bulk contacts using Meta's official API. Self-hosted, open source, no third-party services beyond Meta.

**Stack:** Node.js · Express · Socket.io · React (no build step) · Meta WhatsApp Cloud API

---

## Table of Contents

1. [Official Ways to Send WhatsApp Messages as a Business](#1-official-ways-to-send-whatsapp-messages-as-a-business)
2. [Meta WhatsApp Cloud API — Full Setup from Scratch](#2-meta-whatsapp-cloud-api--full-setup-from-scratch)
3. [Getting Your Credentials](#3-getting-your-credentials)
4. [Templates — How Approval Works](#4-templates--how-approval-works)
5. [Rate Limits and Tier System](#5-rate-limits-and-tier-system)
6. [Project Structure](#6-project-structure)
7. [Running Locally](#7-running-locally)
8. [Deployment](#8-deployment)
   - [Option A: Cloudflare Pages (frontend) + Render (backend)](#option-a-cloudflare-pages-frontend--render-backend-free)
   - [Option B: DigitalOcean Droplet (everything)](#option-b-digitalocean-droplet-everything)
   - [Option C: Railway](#option-c-railway)
9. [Webhook Setup (delivery receipts)](#9-webhook-setup-delivery-receipts)
10. [How the Code Works](#10-how-the-code-works)
11. [Environment Variables](#11-environment-variables)
12. [Meta Error Codes](#12-meta-error-codes)
13. [Security](#13-security)

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

**Where:** [developers.facebook.com](https://developers.facebook.com) → your app → **WhatsApp** → **API Setup** → select your number from the "From" dropdown → the **Phone Number ID** is shown below (e.g. `YOUR_PHONE_NUMBER_ID`).

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
- You send it by name — `your_template_name` — not by content

### Template quality and rejection

Meta monitors how recipients interact with your messages. High block or report rates will lower your quality rating and can result in template suspension. Only send to people who have opted in to receive messages from you.

---

## 5. Rate Limits and Tier System

| Tier | Marketing messages per 24h rolling window |
|---|---|
| Tier 1 (new accounts) | 1,000 unique recipients |
| Tier 2 | 10,000 unique recipients |
| Tier 3 | 100,000 unique recipients |
| Unlimited | No limit |

Meta upgrades your tier automatically when you have sent at least the current tier limit within 7 days and your quality rating is not LOW.

This app tracks `dailyCount` and pauses at midnight when the cap is reached, automatically resuming the next day.

At 2s per message, 2,238 contacts takes ~75 minutes. If you are on Tier 1 (1,000/day), the first 1,000 go out in ~33 minutes; the rest resume the following day.

---

## 6. Project Structure

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
│                        No framework. 117 cases covering template validation,
│                        payload building, phone normalising, pricing maths,
│                        the 24h reply window, webhook dedupe and auth
│
├── opt-outs.json        Numbers that tapped "Stop promotions"
├── msg-index.json       messageId → status, so late read receipts still count
├── inbox.json           Conversation threads
├── campaign.json        Send queue + cursor, so a restart resumes
│                        (all four created at runtime and gitignored)
│
├── package.json         4 deps: express, socket.io, multer, dotenv
├── Dockerfile           For containerised deployment (Render, DigitalOcean)
├── .env.example         Template for credentials — copy to .env
├── .gitignore           Excludes .env, node_modules and the runtime JSON
└── README.md
```

Dependencies run one way only: `routes → services → lib → config`. Nothing in
`lib/` knows about Express, and nothing in `services/` knows about HTTP.

**Why no build step?** The frontend loads React, ReactDOM, Babel and Tailwind from CDN. Babel compiles JSX in the browser. First load takes 3–5s; cached on repeat visits. For an internal tool this is acceptable and removes all build tooling.

This is also why the UI is *shadcn-shaped* rather than actual shadcn/ui: shadcn ships TSX components you compile yourself, which needs a bundler. `ui.jsx` reproduces its token names, variants and component API by hand, so adopting the real thing later is a find-and-replace rather than a rewrite.

---

## 7. Running Locally

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/meta-wa-campaign
cd meta-wa-campaign

# Install (4 packages, ~2MB)
npm install

# Configure
cp .env.example .env
# Open .env and fill in ACCESS_TOKEN and PHONE_NUMBER_ID at minimum

# Start
node server.js

# Open
open http://localhost:3000
```

The app opens with the setup panel on the left. Three steps:
1. Paste your access token in the Credentials card — it auto-saves when you click away
2. Drop your Google Contacts CSV file on the Contacts card
3. Click **Start Campaign**

The template validates automatically as you type the name. No separate validate button needed.

---

## 8. Deployment

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
   ACCESS_TOKEN          = your_token
   PHONE_NUMBER_ID       = YOUR_PHONE_NUMBER_ID
   BUSINESS_ID           = YOUR_BUSINESS_ID
   WABA_ID               = (optional)
   WEBHOOK_VERIFY_TOKEN  = YOUR_WEBHOOK_VERIFY_TOKEN
   FRONTEND_URL          = https://your-project.pages.dev   ← add after step 3
   ```
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

### Option B: DigitalOcean Droplet (everything)

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

### Option C: Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select your repo
3. Railway auto-detects Node.js and runs `npm start`
4. Under **Variables**, add all keys from `.env.example`
5. Railway gives a public URL automatically

Railway provides $5/month free credit. This app easily stays within free limits.

---

## 9. Webhook Setup (delivery receipts)

Without a webhook, campaigns still send normally. The webhook adds `Delivered` and `Read` counts to the live stats.

**Requirement:** The backend must be reachable at a public HTTPS URL. Render and Railway both provide this automatically.

**Setup:**
1. Go to [Meta for Developers](https://developers.facebook.com) → your app → **WhatsApp** → **Configuration**
2. Under **Webhook**, click **Edit**
3. **Callback URL:** `https://your-backend-url.onrender.com/webhook`
4. **Verify Token:** must match `WEBHOOK_VERIFY_TOKEN` in your `.env` (default: `YOUR_WEBHOOK_VERIFY_TOKEN`)
5. Click **Verify and Save**
6. Click **Subscribe** next to the **messages** field

---

## 10. How the Code Works

### Backend (server.js)

**Express routes:**
```
POST /api/config           — save credentials and settings
POST /api/upload-csv       — parse CSV, store contacts in memory
POST /api/start            — start campaign loop
POST /api/pause            — set pauseFlag = true
POST /api/resume           — clear pauseFlag, restart loop
POST /api/stop             — set stopFlag = true
GET  /api/validate-template — call Meta Graph API to check template status
GET  /api/account-info     — fetch quality rating + tier from Meta
GET  /api/state            — return current campaign state
GET  /webhook              — respond to Meta's verification challenge
POST /webhook              — receive delivery/read status updates from Meta
GET  /health               — health check (used by keep-alive and Render)
```

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
POST https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages
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

**Phone normalisation:** Indian numbers in any format (`9000000001`, `+91 998 017 3311`, `09000000001`) are all normalised to `919000000001` — the format Meta requires (no `+`, digits only, country code prefix).

### Frontend (public/index.html)

A single HTML file. React 18, ReactDOM, and Babel standalone are loaded from CDN. Babel compiles the JSX in the browser on first load (~3-5 seconds). No build step, no webpack, no package.json on the frontend side.

**Backend URL detection:** On localhost the app uses relative URLs. On Cloudflare Pages, it reads the backend URL from `localStorage`. If not set, it shows a one-time setup screen asking for the Render URL. This handles both local dev and the split-deployment case from the same file.

**Real-time updates:** Socket.io maintains a persistent WebSocket connection. The server emits a `state` event after every message send, updating the stat cards and progress bar instantly.

**Template validation:** The template name input has a 1.2-second debounce. After you stop typing, the app calls `/api/validate-template`, which queries Meta's Graph API and returns the template's status, category, language, and body text. The category is auto-saved back to the config. No separate validate button needed.

**Keep-alive:** A `setInterval` pings `/health` every 10 minutes while the app is open. This prevents Render's free tier from sleeping during a campaign.

---

## 11. Environment Variables

Copy `.env.example` to `.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACCESS_TOKEN` | Yes | — | Permanent System User token from Meta |
| `PHONE_NUMBER_ID` | Yes | `YOUR_PHONE_NUMBER_ID` | Phone Number ID from Meta dashboard |
| `WABA_ID` | No | auto-resolved | WhatsApp Business Account ID |
| `BUSINESS_ID` | No | `YOUR_BUSINESS_ID` | Used to auto-resolve WABA_ID |
| `FRONTEND_URL` | No | (all origins) | Your Cloudflare Pages URL — set this to restrict CORS |
| `TEMPLATE_NAME` | No | `your_template_name` | Approved template name |
| `TEMPLATE_LANGUAGE` | No | `en` | Template language code |
| `TEMPLATE_CATEGORY` | No | `MARKETING` | Template category |
| `WEBHOOK_VERIFY_TOKEN` | No | `YOUR_WEBHOOK_VERIFY_TOKEN` | Webhook verification token |
| `API_VERSION` | No | `v20.0` | Meta Graph API version |
| `PORT` | No | `3000` | Server port |

---

## 12. Meta Error Codes

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

## 13. Security

- `ACCESS_TOKEN` belongs in `.env` only. It is equivalent to admin access to your WhatsApp account.
- `.gitignore` excludes `.env`. Verify before first push: `git status` must not show `.env`.
- If a token is compromised: **Meta Business Suite → System Users → Generate New Token** immediately. Old token is invalidated instantly.
- Set `FRONTEND_URL` to your exact Cloudflare Pages domain in production. Without it, the backend allows requests from any origin.
- The `/webhook` POST endpoint does not verify the sender (Meta does not sign webhook payloads with a secret by default on the free Cloud API). It is safe to leave public as it only updates in-memory delivery counters.

---

## License

MIT. Fork it, modify it, deploy it.

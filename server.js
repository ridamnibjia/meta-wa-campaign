'use strict';
// Entry point: wiring only. Behaviour lives in src/, layered strictly one way:
// routes → services → lib → config. Nothing in lib/ knows about Express and
// nothing in services/ knows about HTTP, which is what lets test.js call the
// real logic with no server and no mocks.
const express    = require('express');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { Server } = require('socket.io');

const { CFG, PUBLIC_DIR } = require('./src/config');
const { S, setIO, log }   = require('./src/state');
const auth   = require('./src/middleware/auth');
const routes = require('./src/routes');
const { buildState } = require('./src/services/status');
const { resumeIfInterrupted } = require('./src/services/campaign');
const { startRetention } = require('./src/services/retention');
const { migrateJsonToSql } = require('./src/services/migrate');
const { migrateOptOuts }   = require('./src/services/contacts');
const { unprocessedWebhookCount } = require('./src/services/messages');
const { memoryWarning } = require('./src/services/diagnostics');

const app    = express();
const server = http.createServer(app);

// cloudflared terminates TLS and forwards over plain HTTP. Without this, req.ip
// is the tunnel's address for every caller — which would make the login rate
// limiter throttle everyone at once — and secure cookies would never be set.
app.set('trust proxy', 1);

// ── CORS ───────────────────────────────────────────────────────────────────────
// Same-origin by default: express serves the frontend itself. FRONTEND_URL is
// only for the (optional) split deployment where the UI lives on Pages.
const allowedOrigins = CFG.frontendUrl
  ? [CFG.frontendUrl, 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500']
  : null;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins && origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// rawBody is kept so the webhook can verify Meta's X-Hub-Signature-256 over the
// exact bytes sent. Re-serialising the parsed object would change the digest.
//
// limit is raised well past Express's 100kb default on purpose: this is a bulk
// sender, so a batched status webhook covering hundreds of statuses is the
// normal shape, not an edge case. A rejected body here means a 413 BEFORE
// router.post('/webhook') ever runs — nothing reaches webhook_events, Meta
// retries the identical bytes, and gets an identical 413 forever. Since Meta's
// Cloud API is webhook-push only, that is not a failed request, it is a
// permanently lost batch — the exact loss this durability boundary exists to
// prevent, one layer above where it was defended.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// The frontend is public: it is a login screen until the API says otherwise.
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// Exempt from the password so the Docker healthcheck keeps working. It reveals
// nothing an unauthenticated caller could use.
//
// unprocessedWebhooks: nothing in this app replays webhook_events yet — this
// count is the only signal that it needs to. Without it the only trace of a
// parse failure is a log line in the 500-entry ring buffer that /api/start
// wipes (F5).
app.get('/health', (req, res) => res.json({
  status: 'ok', phase: S.phase, uptime: Math.round(process.uptime()),
  unprocessedWebhooks: unprocessedWebhookCount(),
}));

auth.mount(app);      // /api/login, /api/logout, /api/session — outside the gate
routes.mount(app);    // /webhook (signed), then everything behind requireAuth

// Anything under /api that no router claimed is a 404 in JSON, not the SPA
// shell. Without this the catch-all below answers a mistyped endpoint with a
// 200 and an HTML login page, which a client cannot tell apart from success.
app.use('/api', (req, res) => res.status(404).json({
  error: `No such endpoint: ${req.method} ${req.originalUrl}`,
}));

// Catch-all: serve the SPA shell for any non-API path.
app.get('*', (req, res) => {
  const f = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.json({ message: 'WA Campaign API — no frontend bundled' });
});

// ── Socket ─────────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: allowedOrigins || true, methods: ['GET', 'POST'], credentials: true },
});
// Same session check as the REST API. Without this the password would be
// decorative — anyone could stream state, logs and customer messages.
io.use(auth.socketAuth);
io.on('connection', socket => {
  socket.emit('state', buildState());
  socket.emit('logs',  S.logs);
});
setIO(io);

// ── Boot ───────────────────────────────────────────────────────────────────────
if (!CFG.accessToken)   console.warn('[WARN] ACCESS_TOKEN not set in .env');
if (!CFG.phoneNumberId) console.warn('[WARN] PHONE_NUMBER_ID not set in .env');
if (!CFG.appSecret)     console.warn('[WARN] APP_SECRET not set — /webhook will REJECT every POST from Meta');
if (!CFG.appPassword)   console.warn('[WARN] APP_PASSWORD not set — the API is LOCKED until you set one in .env');
{
  const pending = unprocessedWebhookCount();
  if (pending > 0) console.warn(`[WARN] ${pending} webhook event(s) recorded but never processed — check the logs around when they arrived`);
}
// Said at boot as well as on the Diagnostics page: the symptom it predicts is an
// OOM kill days later, and nobody opens Diagnostics before the thing breaks.
{
  const m = memoryWarning();
  if (m) console.warn(`[WARN] ${m}`);
}

// Only listen when run directly, so test.js can require the pure helpers. This
// also guards migrateJsonToSql(): it defaults to the real FILES paths, and
// test.js requires this module without overriding them — calling it
// unconditionally at require-time would rename the repo's own inbox.json and
// msg-index.json the moment `npm test` loaded this file.
if (require.main === module) {
  migrateJsonToSql(undefined, undefined, { templateName: S.config.templateName || null });
  // Losing the opt-out list would be a compliance failure, not a cosmetic one:
  // Meta drops the number's quality rating for messaging people who asked you
  // to stop. It folds into contacts.enabled = 0 with reason 'opt_out'.
  migrateOptOuts();
  resumeIfInterrupted();
  startRetention();
  server.listen(CFG.port, () => {
    console.log(`\n[WA-CAMPAIGN] Server running → http://localhost:${CFG.port}`);
    console.log(`[WA-CAMPAIGN] Phone Number ID : ${CFG.phoneNumberId || 'NOT SET'}`);
    console.log(`[WA-CAMPAIGN] Access Token    : ${CFG.accessToken ? 'SET' : 'NOT SET'}`);
    console.log(`[WA-CAMPAIGN] Password gate   : ${CFG.appPassword ? 'ON' : 'OFF — API LOCKED until APP_PASSWORD is set'}`);
    console.log(`[WA-CAMPAIGN] Webhook path    : /webhook (signature check ${CFG.appSecret ? 'ON' : 'OFF — POSTs will 401'})\n`);
  });
}

// Re-exported for test.js. The tests import from here rather than from a dozen
// module paths, so moving a function between modules does not break them.
module.exports = {
  ...require('./src/lib/phone'),
  ...require('./src/lib/errors'),
  ...require('./src/lib/signature'),
  ...require('./src/lib/pricing'),
  ...require('./src/services/templates'),
  ...require('./src/services/warmup'),
  ...require('./src/services/messages'),
  ...require('./src/services/campaign'),
  ...require('./src/services/graph'),
  ...require('./src/services/media'),
  ...require('./src/lib/filerisk'),
  ...require('./src/lib/clamav'),
  ...require('./src/services/retention'),
  isWindowOpen:   require('./src/services/inbox').isWindowOpen,
  recordInbound:  require('./src/services/inbox').recordInbound,
  inboxSummary:   require('./src/services/inbox').summary,
  inboxSearch:    require('./src/services/inbox').search,
  INBOX_PAGE_SIZE: require('./src/services/inbox').PAGE_SIZE,
  describeInbound: require('./src/services/inbox').describe,
  markRead:    require('./src/services/inbox').markRead,
  inboxThread: require('./src/services/inbox').thread,
  sendReply:   require('./src/services/inbox').sendReply,
  checkPassword:  auth.checkPassword,
  createSession:  auth.createSession,
  validSession:   auth.validSession,
  destroySession: auth.destroySession,
  buildState,
  todayKey: require('./src/state').todayKey,
  S,
  // The loop's control flags, so a test can assert what a Stop does and does not
  // touch. `running` is owned by the loop; a route only ever sets a *Flag.
  flags: require('./src/state').flags,
  memoryWarning,
  W: require('./src/services/warmup').W,
  // Namespaced rather than spread: `list`, `counts`, `enable` and `disable` are
  // too generic to sit at the top of a module that already re-exports thirteen
  // others.
  contacts: require('./src/services/contacts'),
  LIMITS: require('./src/config').LIMITS,
  PRICES: require('./src/config').PRICES,
  OPT_OUT_LABEL: require('./src/config').OPT_OUT_LABEL,
  nodeVersionOk: require('./src/lib/db').nodeVersionOk,
  openDb:        require('./src/lib/db').openDb,
  SCHEMA:        require('./src/lib/db').SCHEMA,
  db:            require('./src/lib/db').db,
  migrateJsonToSql,
  app, server, io,
};

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
const { loadMsgIndex } = require('./src/services/messages');
const { resumeIfInterrupted } = require('./src/services/campaign');

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
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// The frontend is public: it is a login screen until the API says otherwise.
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// Exempt from the password so the Docker healthcheck keeps working. It reveals
// nothing an unauthenticated caller could use.
app.get('/health', (req, res) => res.json({ status: 'ok', phase: S.phase, uptime: Math.round(process.uptime()) }));

auth.mount(app);      // /api/login, /api/logout, /api/session — outside the gate
routes.mount(app);    // /webhook (signed), then everything behind requireAuth

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

loadMsgIndex();

// Only listen when run directly, so test.js can require the pure helpers.
if (require.main === module) {
  resumeIfInterrupted();
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
  isWindowOpen:   require('./src/services/inbox').isWindowOpen,
  recordInbound:  require('./src/services/inbox').recordInbound,
  inboxSummary:   require('./src/services/inbox').summary,
  describeInbound: require('./src/services/inbox').describe,
  checkPassword:  auth.checkPassword,
  createSession:  auth.createSession,
  validSession:   auth.validSession,
  destroySession: auth.destroySession,
  buildState,
  todayKey: require('./src/state').todayKey,
  S,
  W: require('./src/services/warmup').W,
  optOuts: require('./src/services/optouts').optOuts,
  LIMITS: require('./src/config').LIMITS,
  PRICES: require('./src/config').PRICES,
  OPT_OUT_LABEL: require('./src/config').OPT_OUT_LABEL,
  app, server, io,
};

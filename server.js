'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const server = http.createServer(app);

// ── CORS ───────────────────────────────────────────────────────────────────────
// FRONTEND_URL is your Cloudflare Pages URL in production (e.g. https://wa-campaign.pages.dev)
// In local dev, leave it blank — all origins are allowed.
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const allowedOrigins = FRONTEND_URL
  ? [FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500']
  : '*';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins === '*') {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

// ── Config ─────────────────────────────────────────────────────────────────────
const CFG = {
  phoneNumberId:      process.env.PHONE_NUMBER_ID      || '',
  accessToken:        process.env.ACCESS_TOKEN         || '',
  wabaId:             process.env.WABA_ID              || '',
  businessId:         process.env.BUSINESS_ID          || 'YOUR_BUSINESS_ID',
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || 'YOUR_WEBHOOK_VERIFY_TOKEN',
  apiVersion:         process.env.API_VERSION          || 'v20.0',
  templateName:       process.env.TEMPLATE_NAME        || 'your_template_name',
  templateLanguage:   process.env.TEMPLATE_LANGUAGE    || 'en',
  templateCategory:   process.env.TEMPLATE_CATEGORY    || 'MARKETING',
  port:               parseInt(process.env.PORT)       || 3000,
};

if (!CFG.accessToken)   console.warn('[WARN] ACCESS_TOKEN not set in .env');
if (!CFG.phoneNumberId) console.warn('[WARN] PHONE_NUMBER_ID not set in .env');

// ── Static files (local dev only — Cloudflare Pages serves frontend in production) ──
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage() });

// ── Official Meta character limits ─────────────────────────────────────────────
const LIMITS = {
  templateName: 512, templateBody: 1024, templateHeader: 60,
  templateFooter: 60, templateButton: 25, textMessage: 4096, paramValue: 1024,
};

// ── Campaign state ─────────────────────────────────────────────────────────────
// All state is in memory. Restarting the server resets it.
const S = {
  phase:      'idle',   // idle | running | paused | done
  contacts:   [],
  currentIdx: 0,
  accepted:   0,        // Meta API accepted (queued for delivery)
  delivered:  0,        // webhook confirmed delivered to device
  read:       0,        // webhook confirmed read
  failed:     0,
  skipped:    0,        // opted out / ecosystem health skip
  dailyCount: 0,
  dailyDate:  null,
  msgIndex:   {},       // { messageId → { phone, name, status } }
  failLog:    [],       // last 50 failures
  config: {
    delaySec:         2,
    dailyCap:         1000,
    templateName:     CFG.templateName,
    templateLanguage: CFG.templateLanguage,
    templateCategory: CFG.templateCategory,
  },
  pauseReason: null,
  logs:        [],
};

let running   = false;
let stopFlag  = false;
let pauseFlag = false;

// ── Logging ────────────────────────────────────────────────────────────────────
function log(level, msg) {
  const entry = { level, msg, time: new Date().toLocaleTimeString('en-IN', { hour12: false }) };
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  io.emit('log', entry);
  console.log(`[${entry.time}] [${level.toUpperCase().padEnd(7)}] ${msg}`);
}

function broadcast() { io.emit('state', buildState()); }

function buildState() {
  return {
    phase:          S.phase,
    currentIdx:     S.currentIdx,
    total:          S.contacts.length,
    accepted:       S.accepted,
    delivered:      S.delivered,
    read:           S.read,
    failed:         S.failed,
    skipped:        S.skipped,
    dailyCount:     S.dailyCount,
    dailyCap:       S.config.dailyCap,
    pauseReason:    S.pauseReason,
    config:         S.config,
    configured:     !!(CFG.phoneNumberId && CFG.accessToken),
    currentContact: S.contacts[S.currentIdx] || null,
    limits:         LIMITS,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayKey() { return new Date().toISOString().split('T')[0]; }
function checkDaily() {
  const today = todayKey();
  if (S.dailyDate !== today) {
    S.dailyDate  = today;
    S.dailyCount = 0;
    log('info', `Daily counter reset — ${today}`);
  }
}

// ── Phone normalisation ────────────────────────────────────────────────────────
// Meta requires numbers without + prefix, e.g. 919000000001 for Indian numbers.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).trim().replace(/\D/g, '');
  if (!d || d.length < 7) return null;
  if (/^1(800|860|900)/.test(d)) return null;   // toll-free numbers
  if (d.length === 10)                  d = '91' + d;        // 10-digit Indian
  if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1); // 0xxxxxxxxxx
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

function parseCSV(buffer) {
  const lines = buffer.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const hdr   = lines[0].split(',');
  const nameI = hdr.findIndex(h => /first.?name|^name/i.test(h));
  const mobI  = hdr.findIndex(h => /mobile.?phone|mobile/i.test(h));
  const homeI = hdr.findIndex(h => /home.?phone|home/i.test(h));
  const out = [], seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const p    = lines[i].split(',');
    const name = (nameI >= 0 ? p[nameI] : '').replace(/"/g, '').trim() || 'Contact';
    for (const raw of [mobI >= 0 ? p[mobI] : '', homeI >= 0 ? p[homeI] : ''].filter(Boolean)) {
      const d = normalizePhone(raw.replace(/"/g, '').trim());
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push({ name, phone: raw.trim(), dialStr: d });
    }
  }
  return out;
}

// ── Meta Graph API helpers ─────────────────────────────────────────────────────
const graphHeaders = () => ({
  'Authorization': `Bearer ${CFG.accessToken}`,
  'Content-Type':  'application/json',
});

async function graphGet(endpoint, fields) {
  const qs  = fields ? `?fields=${encodeURIComponent(fields)}` : '';
  const res = await fetch(`https://graph.facebook.com/${CFG.apiVersion}/${endpoint}${qs}`, {
    headers: graphHeaders(),
  });
  return res.json();
}

// Fetch quality rating and messaging tier for the phone number
async function fetchAccountInfo() {
  if (!CFG.phoneNumberId || !CFG.accessToken) return { error: 'Credentials not configured' };
  const data = await graphGet(
    CFG.phoneNumberId,
    'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status'
  );
  if (data.error) return { error: data.error.message };
  return {
    displayPhone:  data.display_phone_number,
    verifiedName:  data.verified_name,
    qualityRating: data.quality_rating       || 'UNKNOWN',
    tier:          data.messaging_limit_tier || 'UNKNOWN',
    status:        data.status               || 'UNKNOWN',
    nameStatus:    data.name_status          || 'UNKNOWN',
  };
}

// Resolve WABA ID from Business Portfolio if not set directly
async function resolveWabaId() {
  if (CFG.wabaId) return CFG.wabaId;
  if (!CFG.businessId) return null;
  const data = await graphGet(`${CFG.businessId}/owned_whatsapp_business_accounts`, 'id,name');
  if (data.error || !data.data?.length) return null;
  CFG.wabaId = data.data[0].id;
  log('info', `WABA ID resolved: ${CFG.wabaId}`);
  return CFG.wabaId;
}

// Validate template — fetches status, category, language, body text from Meta
async function validateTemplate(templateName) {
  if (!CFG.accessToken) return { error: 'Access Token not set' };
  const wabaId = await resolveWabaId();
  if (!wabaId) {
    return { error: 'WABA ID unavailable. Set WABA_ID in .env or verify BUSINESS_ID.' };
  }
  const url  = `https://graph.facebook.com/${CFG.apiVersion}/${wabaId}/message_templates`
    + `?name=${encodeURIComponent(templateName)}`
    + `&fields=name,status,category,language,quality_score,rejected_reason,components`;
  const res  = await fetch(url, { headers: graphHeaders() });
  const data = await res.json();
  if (data.error) return { error: data.error.message };
  if (!data.data?.length) return { found: false, name: templateName };
  return {
    found:     true,
    templates: data.data.map(t => ({
      name:           t.name,
      status:         t.status,
      category:       t.category,
      language:       t.language,
      qualityScore:   t.quality_score?.score || null,
      rejectedReason: t.rejected_reason      || null,
      bodyText:       (t.components || []).find(c => c.type === 'BODY')?.text || null,
      headerText:     (t.components || []).find(c => c.type === 'HEADER' && c.format === 'TEXT')?.text || null,
      buttons:        (t.components || []).find(c => c.type === 'BUTTONS')?.buttons || [],
    })),
  };
}

// ── Meta Cloud API — send one template message ─────────────────────────────────
async function sendTemplate(contact) {
  if (!CFG.accessToken || !CFG.phoneNumberId) {
    return { ok: false, error: 'Missing credentials', errorCode: -1 };
  }
  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                contact.dialStr,
    type:              'template',
    template: {
      name:     S.config.templateName,
      language: { code: S.config.templateLanguage },
    },
  };
  try {
    const res  = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${CFG.phoneNumberId}/messages`,
      { method: 'POST', headers: graphHeaders(), body: JSON.stringify(body) }
    );
    const data = await res.json();
    if (res.ok && data.messages?.[0]?.id) return { ok: true, messageId: data.messages[0].id };
    const err     = data.error || {};
    const code    = err.code        || 0;
    const subcode = err.error_subcode || 0;
    const msg     = err.message     || JSON.stringify(data);
    // Skippable: opted out, ecosystem health, re-engagement window
    if ([131026, 131047, 131049, 131051].includes(code) ||
        [131026, 131047, 131049, 131051].includes(subcode)) {
      return { ok: false, skip: true, error: msg, errorCode: code };
    }
    // Rate limit: back off and retry same contact
    if ([130429, 80007, 4].includes(code)) {
      const retryMs = res.headers.get('retry-after')
        ? parseInt(res.headers.get('retry-after')) * 1000 : 60000;
      return { ok: false, rateLimit: true, error: msg, errorCode: code, retryAfter: retryMs };
    }
    return { ok: false, error: msg, errorCode: code };
  } catch (e) {
    return { ok: false, error: e.message, errorCode: -1 };
  }
}

// ── Campaign loop ──────────────────────────────────────────────────────────────
function startLoop() {
  if (running) return;
  pauseFlag = false; stopFlag = false; running = true;
  campaignLoop().catch(e => { log('error', 'Loop: ' + e.message); running = false; });
}

async function campaignLoop() {
  log('info', `Campaign started — ${S.contacts.length - S.currentIdx} contacts queued`);
  while (true) {
    if (stopFlag)  { log('info', 'Stopped'); S.phase = 'done'; broadcast(); break; }
    if (pauseFlag) { await sleep(500); continue; }
    if (S.currentIdx >= S.contacts.length) {
      log('info', `Done — accepted:${S.accepted} failed:${S.failed} skipped:${S.skipped}`);
      S.phase = 'done'; broadcast(); break;
    }
    checkDaily();
    if (S.dailyCount >= S.config.dailyCap) {
      const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(0, 2, 0, 0);
      const wait = next - Date.now();
      const h = Math.floor(wait / 3600000), m = Math.floor((wait % 3600000) / 60000);
      log('info', `Daily cap ${S.dailyCount}/${S.config.dailyCap} — resuming in ${h}h ${m}m`);
      S.phase = 'paused'; S.pauseReason = `Daily cap reached. Resumes in ${h}h ${m}m.`; broadcast();
      await sleep(wait);
      S.phase = 'running'; S.pauseReason = null; broadcast(); continue;
    }
    const c = S.contacts[S.currentIdx];
    const n = `[${S.currentIdx + 1}/${S.contacts.length}]`;
    log('info', `${n} ${c.name} +${c.dialStr}`);
    const result = await sendTemplate(c);
    if (result.ok) {
      S.accepted++; S.dailyCount++;
      S.msgIndex[result.messageId] = { phone: c.dialStr, name: c.name, status: 'accepted' };
      log('success', `${n} accepted — today:${S.dailyCount}/${S.config.dailyCap}`);
    } else if (result.skip) {
      S.skipped++;
      log('warn', `${n} skipped (${result.errorCode})`);
    } else if (result.rateLimit) {
      log('warn', `Rate limit — backing off ${Math.round(result.retryAfter / 1000)}s`);
      S.phase = 'paused'; S.pauseReason = 'Rate limit — auto-resuming'; broadcast();
      await sleep(result.retryAfter);
      S.phase = 'running'; S.pauseReason = null; broadcast();
      continue; // retry same contact
    } else {
      S.failed++;
      S.failLog.push({ time: new Date().toISOString(), phone: c.dialStr, name: c.name, error: result.error, code: result.errorCode });
      if (S.failLog.length > 50) S.failLog.shift();
      log('error', `${n} failed (${result.errorCode}): ${result.error}`);
    }
    S.currentIdx++;
    broadcast();
    if (!pauseFlag && !stopFlag && S.currentIdx < S.contacts.length) {
      await sleep(S.config.delaySec * 1000);
    }
  }
  running = false;
}

// ── Webhook ────────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === CFG.webhookVerifyToken) {
    log('info', 'Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // always ACK immediately
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      for (const status of (change.value?.statuses || [])) {
        const id = status.id, st = status.status;
        if (!S.msgIndex[id]) continue;
        const prev = S.msgIndex[id].status;
        S.msgIndex[id].status = st;
        if (st === 'delivered' && prev !== 'delivered' && prev !== 'read') {
          S.delivered++; log('info', `delivered — ${S.msgIndex[id].name}`);
        } else if (st === 'read' && prev !== 'read') {
          if (prev !== 'delivered') S.delivered++;
          S.read++; log('info', `read — ${S.msgIndex[id].name}`);
        } else if (st === 'failed') {
          const code = status.errors?.[0]?.code;
          S.failLog.push({ time: new Date().toISOString(), phone: S.msgIndex[id].phone, name: S.msgIndex[id].name, error: status.errors?.[0]?.title, code, source: 'webhook' });
          log('warn', `delivery failed — ${S.msgIndex[id].name} code:${code}`);
        }
        broadcast();
      }
    }
  }
});

// ── API routes ─────────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { phoneNumberId, accessToken, wabaId, templateName, templateLanguage, templateCategory, delaySec, dailyCap } = req.body;
  if (phoneNumberId)    CFG.phoneNumberId   = phoneNumberId;
  if (accessToken)      CFG.accessToken      = accessToken;
  if (wabaId)           CFG.wabaId           = wabaId;
  if (templateName)     { CFG.templateName     = templateName;     S.config.templateName     = templateName; }
  if (templateLanguage) { CFG.templateLanguage = templateLanguage; S.config.templateLanguage = templateLanguage; }
  if (templateCategory) { CFG.templateCategory = templateCategory; S.config.templateCategory = templateCategory; }
  if (delaySec)         S.config.delaySec = Math.max(1, parseInt(delaySec));
  if (dailyCap)         S.config.dailyCap = Math.max(1, parseInt(dailyCap));
  broadcast();
  res.json({ ok: true, configured: !!(CFG.phoneNumberId && CFG.accessToken) });
});

app.post('/api/upload-csv', upload.single('csv'), (req, res) => {
  try {
    const contacts = parseCSV(req.file.buffer);
    S.contacts = contacts; S.currentIdx = 0;
    S.accepted = S.failed = S.skipped = S.delivered = S.read = 0;
    S.msgIndex = {}; S.failLog = [];
    log('info', `CSV loaded — ${contacts.length} contacts`);
    res.json({ ok: true, count: contacts.length, sample: contacts.slice(0, 5) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/account-info', async (req, res) => {
  try { res.json(await fetchAccountInfo()); }
  catch (e) { res.json({ error: e.message }); }
});

app.get('/api/validate-template', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json({ error: 'Template name is required' });
  try { res.json(await validateTemplate(name)); }
  catch (e) { res.json({ error: e.message }); }
});

app.post('/api/start', (req, res) => {
  if (!CFG.phoneNumberId) return res.json({ ok: false, error: 'Phone Number ID not configured' });
  if (!CFG.accessToken)   return res.json({ ok: false, error: 'Access Token not configured' });
  if (!S.contacts.length) return res.json({ ok: false, error: 'Upload a CSV first' });
  S.accepted = S.failed = S.skipped = S.delivered = S.read = 0;
  S.currentIdx = 0; S.msgIndex = {}; S.failLog = []; S.logs = [];
  stopFlag = false; pauseFlag = false; running = false;
  S.phase = 'running'; S.pauseReason = null; broadcast();
  startLoop();
  res.json({ ok: true });
});

app.post('/api/pause',  (req, res) => { pauseFlag = true;  S.phase = 'paused'; S.pauseReason = 'Paused by user'; broadcast(); log('info', 'Paused'); res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { pauseFlag = false; S.phase = 'running'; S.pauseReason = null; broadcast(); log('info', 'Resumed'); if (!running) startLoop(); res.json({ ok: true }); });
app.post('/api/stop',   (req, res) => { stopFlag = true; running = false; pauseFlag = false; S.phase = 'idle'; S.pauseReason = null; broadcast(); log('info', 'Stopped'); res.json({ ok: true }); });
app.post('/api/reset',  (req, res) => {
  stopFlag = true; running = false; pauseFlag = false;
  Object.assign(S, { contacts: [], currentIdx: 0, accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0, dailyCount: 0, phase: 'idle', logs: [], msgIndex: {}, failLog: [], pauseReason: null });
  broadcast(); log('info', 'Reset'); res.json({ ok: true });
});

app.get('/api/state',   (req, res) => res.json(buildState()));
app.get('/api/logs',    (req, res) => res.json(S.logs));
app.get('/api/faillog', (req, res) => res.json(S.failLog));
app.get('/health',      (req, res) => res.json({ status: 'ok', phase: S.phase, uptime: Math.round(process.uptime()) }));

// Catch-all: serve frontend for local dev (when Cloudflare Pages is not used)
app.get('*', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.json({ message: 'WA Campaign API — frontend deployed separately on Cloudflare Pages' });
});

io.on('connection', socket => {
  socket.emit('state', buildState());
  socket.emit('logs',  S.logs);
});

server.listen(CFG.port, () => {
  console.log(`\n[WA-CAMPAIGN] Server running → http://localhost:${CFG.port}`);
  console.log(`[WA-CAMPAIGN] Phone Number ID : ${CFG.phoneNumberId || 'NOT SET'}`);
  console.log(`[WA-CAMPAIGN] Access Token    : ${CFG.accessToken ? 'SET' : 'NOT SET'}`);
  console.log(`[WA-CAMPAIGN] CORS origin     : ${FRONTEND_URL || '* (all origins — dev mode)'}`);
  console.log(`[WA-CAMPAIGN] Webhook path    : /webhook\n`);
});

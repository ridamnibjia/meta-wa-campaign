'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

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
  appSecret:          process.env.APP_SECRET           || '',
  apiVersion:         process.env.API_VERSION          || 'v23.0',
  templateName:       process.env.TEMPLATE_NAME        || 'your_template_name',
  templateLanguage:   process.env.TEMPLATE_LANGUAGE    || 'en',
  templateCategory:   process.env.TEMPLATE_CATEGORY    || 'MARKETING',
  port:               parseInt(process.env.PORT)       || 3000,
};

if (!CFG.accessToken)   console.warn('[WARN] ACCESS_TOKEN not set in .env');
if (!CFG.phoneNumberId) console.warn('[WARN] PHONE_NUMBER_ID not set in .env');
if (!CFG.appSecret)     console.warn('[WARN] APP_SECRET not set — /webhook will REJECT every POST from Meta');

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// rawBody is kept so the webhook can verify Meta's X-Hub-Signature-256 over the
// exact bytes sent. Re-serialising the parsed object would change the digest.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage() });

// ── Official Meta character limits ─────────────────────────────────────────────
const LIMITS = {
  templateName: 512, templateBody: 1024, templateHeader: 60,
  templateFooter: 60, templateButton: 25, textMessage: 4096, paramValue: 1024,
};

const OPT_OUT_LABEL = 'Stop promotions';

// ── Meta error codes → plain English + what to actually do ─────────────────────
// Meta returns bare numbers and a terse message. Without this table a failure log
// reads "(131042) Business eligibility payment issue", which tells you nothing
// about where to click. Only codes reachable from this app's flows are listed;
// anything unlisted falls through to Meta's own message.
const META_ERRORS = {
  4:      ['App hit its hourly API call limit',        'The loop backs off on its own. If it repeats, raise "Delay between sends".'],
  10:     ['Permission denied for this action',        'The token is missing whatsapp_business_messaging or whatsapp_business_management. Regenerate it with both.'],
  33:     ['Phone Number ID not found',                'PHONE_NUMBER_ID is wrong, or the token belongs to a different app. Recheck WhatsApp → API Setup.'],
  100:    ['Invalid parameter in the request',         'Usually a template name/language mismatch. Re-run Check Template.'],
  190:    ['Access token expired or invalid',          'Generate a fresh System User token (Business Settings → System Users → Generate Token) and update ACCESS_TOKEN.'],
  200:    ['Permission error on the WABA',             'The System User needs admin access to this WhatsApp Business Account. Add it under Business Settings → Users.'],
  80007:  ['WABA rate limit reached',                  'Slow down. Raise the delay, or lower the daily cap.'],
  130429: ['Throughput rate limit reached',           'Sending faster than the number is allowed to. The loop retries this contact automatically.'],
  131000: ['Meta-side error, cause unspecified',      'Transient. Retry the campaign; if every send fails, check status at metastatus.com.'],
  131008: ['A required parameter was missing',        'Template variables do not match the approved template. Re-run Check Template.'],
  131009: ['A parameter value was rejected',          'Usually a variable containing a newline, tab, or 4+ spaces. Check the CSV cell.'],
  131016: ['WhatsApp service temporarily unavailable','Transient on Meta\'s side. Pause and resume in a few minutes.'],
  131021: ['Sender and recipient are the same number','You are messaging your own business number. Remove it from the CSV.'],
  131026: ['Message undeliverable',                   'Number is not on WhatsApp, or Meta blocked it on quality grounds. Nothing to fix — it is counted as skipped.'],
  131031: ['Account locked for a policy violation',   'Check Business Support Home in Business Manager. Sending stays blocked until resolved.'],
  131042: ['Billing not set up for this business',    'Add or fix the payment method: Business Settings → Billing & Payments. Sends stay blocked until it clears.'],
  131047: ['Outside the 24-hour customer service window', 'Only approved templates can open a conversation. Confirm you are sending the template, not free text.'],
  131049: ['Meta chose not to deliver this one',      'Per-user marketing cap on Meta\'s side. Not your error and not retryable.'],
  131051: ['Unsupported message type',                'The template was changed after approval. Re-run Check Template.'],
  132000: ['Wrong number of template variables',      'The approved template expects a different variable count than the CSV supplies. Re-run Check Template.'],
  132001: ['Template not found in that language',     'Name or language code does not match an APPROVED template. Check spelling and the language code (en vs en_US).'],
  132005: ['Filled-in template text is too long',     'A CSV value is pushing the body past 1024 characters. Shorten the longest values.'],
  132007: ['Template content policy violation',       'Meta rejected the formatting. Rewrite the body and resubmit.'],
  132012: ['Template variable format mismatch',       'A value does not match the sample you submitted for approval.'],
  132015: ['Template is paused for low quality',      'Too many blocks or reports. Wait for the pause to lift, or submit a new template. Do not retry.'],
  132016: ['Template is disabled',                    'Permanently disabled by Meta. Create and submit a new template.'],
  133010: ['Phone number is not registered',          'Register the number under WhatsApp → API Setup before sending.'],
  2388023:['Template is missing example values',      'Meta requires a sample for every variable. Fill in the sample fields and resubmit.'],
};

// Returns "what — action", or null when the code is unknown to us.
function explainError(code) {
  const e = META_ERRORS[code];
  return e ? `${e[0]} — ${e[1]}` : null;
}

// ── Opt-out store ──────────────────────────────────────────────────────────────
// ponytail: flat JSON file, loaded into a Set on boot. Hundreds of numbers, not
// millions — swap for SQLite only if the list outgrows a single file read.
const OPT_OUT_FILE = path.join(__dirname, 'opt-outs.json');
const optOuts = new Set();

try {
  if (fs.existsSync(OPT_OUT_FILE)) {
    for (const n of JSON.parse(fs.readFileSync(OPT_OUT_FILE, 'utf8'))) optOuts.add(n);
  }
} catch (e) { console.warn('[WARN] Could not read opt-outs.json:', e.message); }

function addOptOut(phone) {
  const d = normalizePhone(phone);
  if (!d || optOuts.has(d)) return false;
  optOuts.add(d);
  try { fs.writeFileSync(OPT_OUT_FILE, JSON.stringify([...optOuts], null, 2)); }
  catch (e) { console.error('[ERROR] Could not write opt-outs.json:', e.message); }
  return true;
}

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
    templateStatus:   null,   // APPROVED | PENDING | REJECTED — gates /api/start
    paramCount:       0,      // number of {{n}} in the active template body
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
    optOutCount:    optOuts.size,
    optOutLabel:    OPT_OUT_LABEL,
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

// ── Template composition ───────────────────────────────────────────────────────
// Meta template names: lowercase, [a-z0-9_] only. Anything else is rejected.
function slugify(s) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LIMITS.templateName);
  return out || 'template';
}

// Returns the sorted, de-duplicated variable numbers found in a body: "Hi {{1}}" → [1]
function templateVars(text) {
  const nums = [...String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

// Meta rejects parameter values containing newlines, tabs, or 4+ consecutive
// spaces. Collapse all whitespace runs to a single space.
function sanitizeParam(v) {
  const out = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.paramValue);
  return out || 'there';
}

// Server-side pre-flight. Catches the documented rejection causes before we
// spend a Graph call and a review cycle on them.
function validateTemplateInput({ displayName, bodyText, footerText, sampleValues = [], category }) {
  const errors = [];
  const body   = String(bodyText || '').trim();

  if (!String(displayName || '').trim()) errors.push('Template name is required');
  if (!body) errors.push('Message body is required');
  if (body.length > LIMITS.templateBody) errors.push(`Body is ${body.length} chars — max ${LIMITS.templateBody}`);

  const vars = templateVars(body);
  vars.forEach((n, i) => {
    if (n !== i + 1) errors.push(`Variables must run {{1}}, {{2}}… with no gaps — found {{${n}}} at position ${i + 1}`);
  });
  if (vars.length && sampleValues.filter(v => String(v || '').trim()).length !== vars.length) {
    errors.push(`Provide a sample value for each of the ${vars.length} variable(s) — Meta requires them`);
  }
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) errors.push('Body cannot start with a variable');
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) errors.push('Body cannot end with a variable');

  const footer = String(footerText || '').trim();
  if (footer.length > LIMITS.templateFooter) errors.push(`Footer is ${footer.length} chars — max ${LIMITS.templateFooter}`);
  if (templateVars(footer).length) errors.push('Footer cannot contain variables');

  if (category && !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
    errors.push(`Unknown category "${category}"`);
  }
  return errors;
}

function buildTemplatePayload({ displayName, bodyText, footerText, sampleValues = [], addOptOut, category, language }) {
  const body   = String(bodyText || '').trim();
  const footer = String(footerText || '').trim();
  const vars   = templateVars(body);

  const bodyComponent = { type: 'BODY', text: body };
  // The example block is mandatory when the body has variables (error 2388023).
  if (vars.length) {
    bodyComponent.example = { body_text: [vars.map((_, i) => sanitizeParam(sampleValues[i]))] };
  }

  const components = [bodyComponent];
  if (footer) components.push({ type: 'FOOTER', text: footer });
  if (addOptOut) {
    components.push({
      type: 'BUTTONS',
      buttons: [{ type: 'QUICK_REPLY', text: OPT_OUT_LABEL.slice(0, LIMITS.templateButton) }],
    });
  }

  return {
    name:     slugify(displayName),
    language: language || 'en',
    category: category || 'MARKETING',
    components,
  };
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

// Maps {{1}}, {{2}}… onto contact fields, in order.
// ponytail: only the CSV name is available today, so anything past {{1}} reuses
// it. Add more fields here when the CSV parser learns to carry them.
const PARAM_FIELDS = ['name'];

function buildParams(contact) {
  const n = S.config.paramCount || 0;
  return Array.from({ length: n }, (_, i) => ({
    type: 'text',
    text: sanitizeParam(contact[PARAM_FIELDS[i]] ?? contact.name),
  }));
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
  // Only attach components when the template actually has variables — sending an
  // empty parameters array is itself an error, as is omitting a required one (132000).
  const params = buildParams(contact);
  if (params.length) {
    body.template.components = [{ type: 'body', parameters: params }];
  }
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
    const hint = explainError(code) || explainError(subcode);
    if ([131026, 131047, 131049, 131051].includes(code) ||
        [131026, 131047, 131049, 131051].includes(subcode)) {
      return { ok: false, skip: true, error: msg, errorCode: code, hint };
    }
    // Rate limit: back off and retry same contact
    if ([130429, 80007, 4].includes(code)) {
      const retryMs = res.headers.get('retry-after')
        ? parseInt(res.headers.get('retry-after')) * 1000 : 60000;
      return { ok: false, rateLimit: true, error: msg, errorCode: code, retryAfter: retryMs, hint };
    }
    return { ok: false, error: msg, errorCode: code, hint };
  } catch (e) {
    // fetch itself threw — DNS, TLS, or no outbound network from this host.
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}`, errorCode: -1,
             hint: 'Network problem on the machine running this server, not a Meta error. Check outbound HTTPS.' };
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
    if (optOuts.has(c.dialStr)) {
      S.skipped++; S.currentIdx++;
      log('warn', `${n} skipped — ${c.name} opted out`);
      broadcast();
      continue;   // no delay: nothing was sent
    }
    log('info', `${n} ${c.name} +${c.dialStr}`);
    const result = await sendTemplate(c);
    if (result.ok) {
      S.accepted++; S.dailyCount++;
      S.msgIndex[result.messageId] = { phone: c.dialStr, name: c.name, status: 'accepted' };
      log('success', `${n} accepted — today:${S.dailyCount}/${S.config.dailyCap}`);
    } else if (result.skip) {
      S.skipped++;
      log('warn', `${n} skipped — ${result.hint || result.error} [${result.errorCode}]`);
    } else if (result.rateLimit) {
      log('warn', `Rate limit — backing off ${Math.round(result.retryAfter / 1000)}s. ${result.hint || result.error} [${result.errorCode}]`);
      S.phase = 'paused'; S.pauseReason = 'Rate limit — auto-resuming'; broadcast();
      await sleep(result.retryAfter);
      S.phase = 'running'; S.pauseReason = null; broadcast();
      continue; // retry same contact
    } else {
      S.failed++;
      S.failLog.push({ time: new Date().toISOString(), phone: c.dialStr, name: c.name, error: result.error, code: result.errorCode, hint: result.hint });
      if (S.failLog.length > 50) S.failLog.shift();
      log('error', `${n} failed [${result.errorCode}] ${result.error}`);
      if (result.hint) log('error', `   ↳ ${result.hint}`);
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

// Meta signs every POST with HMAC-SHA256 of the raw body, keyed on the app
// secret. Without this check anyone who finds the public URL can forge opt-outs
// and delivery stats. No secret configured = reject, rather than trust blindly.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !rawBody) return false;
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(mine);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A status webhook can arrive for a message ID this process has never heard of:
// S.msgIndex is in memory, so a restart wipes it, and Meta retries for 7 days.
// Right now those events vanish — the counters under-report and a `failed` for
// yesterday's campaign is lost.
//
// TODO(ridam): decide what should happen here. Options, roughly:
//   a) leave it — accept that stats only cover the current process lifetime
//   b) log('warn', ...) so at least you can see how many you're dropping
//   c) push into a S.orphanStatuses array surfaced in the UI
//   d) persist msgIndex to disk like opt-outs.json so restarts keep counting
// (a) and (d) are the honest ends of the range; (b) is 1 line and tells you
// whether (d) is even worth building.
function onUnknownStatus(status) {
}

app.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), CFG.appSecret)) {
    log('warn', 'webhook POST rejected — bad or missing X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // always ACK immediately
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {

      // Inbound messages — we only care about the opt-out quick reply.
      // A quick-reply tap on a template arrives as type 'button'; the same label
      // sent from an interactive message arrives as button_reply.
      for (const m of (change.value?.messages || [])) {
        const label = m.button?.text || m.interactive?.button_reply?.title;
        if (!label || label.trim().toLowerCase() !== OPT_OUT_LABEL.toLowerCase()) continue;
        if (addOptOut(m.from)) log('warn', `opt-out — +${m.from} will be skipped from now on`);
        broadcast();
      }

      for (const status of (change.value?.statuses || [])) {
        const id = status.id, st = status.status;
        if (!S.msgIndex[id]) { onUnknownStatus(status); continue; }
        const prev = S.msgIndex[id].status;
        S.msgIndex[id].status = st;
        if (st === 'delivered' && prev !== 'delivered' && prev !== 'read') {
          S.delivered++; log('info', `delivered — ${S.msgIndex[id].name}`);
        } else if (st === 'read' && prev !== 'read') {
          if (prev !== 'delivered') S.delivered++;
          S.read++; log('info', `read — ${S.msgIndex[id].name}`);
        } else if (st === 'failed') {
          const code = status.errors?.[0]?.code;
          const hint = explainError(code);
          S.failLog.push({ time: new Date().toISOString(), phone: S.msgIndex[id].phone, name: S.msgIndex[id].name, error: status.errors?.[0]?.title, code, hint, source: 'webhook' });
          log('warn', `delivery failed — ${S.msgIndex[id].name} [${code}] ${status.errors?.[0]?.title || ''}`);
          if (hint) log('warn', `   ↳ ${hint}`);
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
  try {
    const r = await validateTemplate(name);
    adoptTemplate(name, r);
    res.json(r);
  } catch (e) { res.json({ error: e.message }); }
});

// When a template lookup succeeds, make it the active one: remember its status
// (gates Start) and how many variables its body needs (drives buildParams).
function adoptTemplate(name, result) {
  const t = result?.templates?.[0];
  if (!t) {
    if (result && result.found === false) S.config.templateStatus = 'NOT_FOUND';
    return;
  }
  S.config.templateName     = name;
  S.config.templateStatus   = t.status;
  S.config.templateCategory = t.category;
  S.config.templateLanguage = t.language;
  S.config.paramCount       = templateVars(t.bodyText).length;
  CFG.templateName          = name;
  broadcast();
}

// ── Compose: submit a new template to Meta for approval ────────────────────────
app.post('/api/template/create', async (req, res) => {
  const input = {
    displayName:  req.body.displayName,
    bodyText:     req.body.bodyText,
    footerText:   req.body.footerText,
    sampleValues: req.body.sampleValues || [],
    addOptOut:    req.body.addOptOut !== false,   // default on
    category:     req.body.category || 'MARKETING',
    language:     req.body.language || 'en',
  };

  const errors = validateTemplateInput(input);
  if (errors.length) return res.json({ ok: false, errors });

  if (!CFG.accessToken) return res.json({ ok: false, errors: ['Access Token not configured'] });
  const wabaId = await resolveWabaId();
  if (!wabaId) return res.json({ ok: false, errors: ['WABA ID unavailable. Set WABA_ID or verify BUSINESS_ID.'] });

  const payload = buildTemplatePayload(input);
  try {
    const r = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${wabaId}/message_templates`,
      { method: 'POST', headers: graphHeaders(), body: JSON.stringify(payload) }
    );
    const data = await r.json();
    if (data.error) {
      const code = data.error.code || 0;
      const hint = explainError(code) || explainError(data.error.error_subcode);
      log('error', `Template "${payload.name}" rejected on submit [${code}] ${data.error.message}`);
      if (hint) log('error', `   ↳ ${hint}`);
      const errs = [data.error.error_user_msg || data.error.message];
      if (hint) errs.push(hint);
      return res.json({ ok: false, errors: errs });
    }

    S.config.templateName     = payload.name;
    S.config.templateLanguage = payload.language;
    S.config.templateCategory = payload.category;
    S.config.templateStatus   = data.status || 'PENDING';
    S.config.paramCount       = templateVars(payload.components[0].text).length;
    CFG.templateName          = payload.name;
    broadcast();

    log('info', `Template "${payload.name}" submitted — status ${S.config.templateStatus}`);
    res.json({ ok: true, name: payload.name, id: data.id, status: S.config.templateStatus, payload });
  } catch (e) {
    res.json({ ok: false, errors: [e.message] });
  }
});

// Polled by the UI every 15s while a template is PENDING.
app.get('/api/template/status', async (req, res) => {
  const name = req.query.name || S.config.templateName;
  if (!name) return res.json({ error: 'Template name is required' });
  try {
    const r = await validateTemplate(name);
    adoptTemplate(name, r);
    const t = r?.templates?.[0];
    res.json({
      name,
      found:          !!t,
      status:         t?.status || (r.error ? null : 'NOT_FOUND'),
      category:       t?.category || null,
      language:       t?.language || null,
      bodyText:       t?.bodyText || null,
      rejectedReason: t?.rejectedReason || null,
      qualityScore:   t?.qualityScore || null,
      paramCount:     S.config.paramCount,
      error:          r.error || null,
    });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/optouts', (req, res) => res.json({ count: optOuts.size, numbers: [...optOuts] }));

app.post('/api/start', async (req, res) => {
  if (!CFG.phoneNumberId) return res.json({ ok: false, error: 'Phone Number ID not configured' });
  if (!CFG.accessToken)   return res.json({ ok: false, error: 'Access Token not configured' });
  if (!S.contacts.length) return res.json({ ok: false, error: 'Upload a CSV first' });

  // Re-check with Meta rather than trusting the client. A stale browser tab
  // could otherwise launch a campaign against a template that was since rejected.
  try {
    const r = await validateTemplate(S.config.templateName);
    adoptTemplate(S.config.templateName, r);
    if (r.error) return res.json({ ok: false, error: `Could not verify template: ${r.error}` });
    if (S.config.templateStatus !== 'APPROVED') {
      return res.json({ ok: false, error: `Template "${S.config.templateName}" is ${S.config.templateStatus || 'not found'} — only APPROVED templates can be sent` });
    }
  } catch (e) {
    return res.json({ ok: false, error: `Could not verify template: ${e.message}` });
  }

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

// Only listen when run directly, so test.js can require the pure helpers below.
if (require.main === module) {
  server.listen(CFG.port, () => {
    console.log(`\n[WA-CAMPAIGN] Server running → http://localhost:${CFG.port}`);
    console.log(`[WA-CAMPAIGN] Phone Number ID : ${CFG.phoneNumberId || 'NOT SET'}`);
    console.log(`[WA-CAMPAIGN] Access Token    : ${CFG.accessToken ? 'SET' : 'NOT SET'}`);
    console.log(`[WA-CAMPAIGN] CORS origin     : ${FRONTEND_URL || '* (all origins — dev mode)'}`);
    console.log(`[WA-CAMPAIGN] Opt-outs loaded : ${optOuts.size}`);
    console.log(`[WA-CAMPAIGN] Webhook path    : /webhook (signature check ${CFG.appSecret ? 'ON' : 'OFF — POSTs will 401'})\n`);
  });
}

module.exports = {
  slugify, templateVars, sanitizeParam, validateTemplateInput,
  buildTemplatePayload, normalizePhone, parseCSV, buildParams,
  verifySignature, explainError, META_ERRORS, OPT_OUT_LABEL, LIMITS, S,
};

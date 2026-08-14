'use strict';
const { CFG } = require('./config');

// ── Campaign state ─────────────────────────────────────────────────────────────
// Counters and the send queue. Persisted by services/campaign.js and
// services/messages.js — this module only owns the shape.
// The send queue is NOT here. It lives in run_recipients, keyed on the current
// run, and the resume point is derived from it — see services/messages.js. What
// is left is pacing state a database row has no opinion about.
const S = {
  // 'waiting' is running-but-idle: every contact left is on the retry ladder and
  // the loop is asleep until the earliest of them comes due. It is deliberately
  // not 'paused' — nobody paused it, and it resumes itself.
  phase:      'idle',   // idle | running | waiting | paused | done
  failed:     0,        // Graph API rejected the send — no wamid exists, so no row
  dailyCount: 0,
  dailyDate:  null,
  currentRunId: null,   // campaign_runs.id — scopes every derived counter
  failLog:    [],       // last 50 failures
  quality:    null,     // last quality_rating seen from Meta — gates the warm-up climb
  config: {
    delaySec:         2,
    dailyCap:         1000,
    templateName:     CFG.templateName,
    templateLanguage: CFG.templateLanguage,
    templateCategory: CFG.templateCategory,
    templateStatus:   null,   // APPROVED | PENDING | REJECTED — gates /api/start
    paramCount:       0,      // number of {{n}} in the active template body
    paramValues:      [],     // one per {{n}}: { source: 'name' | 'fixed', value }
    templateBody:     null,   // the approved, UNRENDERED body — snapshotted onto each run
    headerFormat:     null,   // null | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'
    headerAssetId:    null,   // media_assets.id sent as this campaign's header
  },
  pauseReason: null,
  logs:        [],
};

// The loop's control flags. Kept together so routes can flip them without
// importing the loop itself.
const flags = { running: false, stopFlag: false, pauseFlag: false };

// Which phases mean "a campaign is under way". It lives here, next to S.phase,
// because three modules ask the question and two of them had grown their own
// copy of the list — and this list is load-bearing: 'waiting' is the retry
// phase, it is what campaignBlocker() refuses a second Start on, and dropping
// it from one copy is how a second loop gets onto one queue.
const ACTIVE_PHASES = ['running', 'waiting', 'paused'];

// `flags.running` is in the test deliberately, and it is the half that matters:
// a Stop sets the phase to idle immediately, but the loop is still inside an
// await for up to a second afterwards.
const campaignActive = () => flags.running || ACTIVE_PHASES.includes(S.phase);

// ── Socket registry ────────────────────────────────────────────────────────────
// server.js hands the io instance over once it exists. Every module emits
// through here rather than importing express/socket.io, which keeps the service
// layer free of transport concerns.
let io = null;
const setIO = instance => { io = instance; };
const emit = (event, payload) => { if (io) io.emit(event, payload); };

function log(level, msg) {
  const entry = { level, msg, time: new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) };
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  emit('log', entry);
  console.log(`[${entry.time}] [${level.toUpperCase().padEnd(7)}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayKey() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }

function checkDaily() {
  const today = todayKey();
  if (S.dailyDate !== today) {
    S.dailyDate  = today;
    S.dailyCount = 0;
    log('info', `Daily counter reset — ${today}`);
  }
}

module.exports = { S, flags, ACTIVE_PHASES, campaignActive, setIO, emit, log, sleep, todayKey, checkDaily };

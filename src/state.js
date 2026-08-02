'use strict';
const { CFG } = require('./config');

// ── Campaign state ─────────────────────────────────────────────────────────────
// Counters and the send queue. Persisted by services/campaign.js and
// services/messages.js — this module only owns the shape.
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
  quality:    null,     // last quality_rating seen from Meta — gates the warm-up climb
  inbox:      {},       // { waId → thread } — see services/inbox.js
  config: {
    delaySec:         2,
    dailyCap:         1000,
    templateName:     CFG.templateName,
    templateLanguage: CFG.templateLanguage,
    templateCategory: CFG.templateCategory,
    templateStatus:   null,   // APPROVED | PENDING | REJECTED — gates /api/start
    paramCount:       0,      // number of {{n}} in the active template body
    paramValues:      [],     // one per {{n}}: { source: 'name' | 'fixed', value }
  },
  pauseReason: null,
  logs:        [],
};

// The loop's control flags. Kept together so routes can flip them without
// importing the loop itself.
const flags = { running: false, stopFlag: false, pauseFlag: false };

// ── Socket registry ────────────────────────────────────────────────────────────
// server.js hands the io instance over once it exists. Every module emits
// through here rather than importing express/socket.io, which keeps the service
// layer free of transport concerns.
let io = null;
const setIO = instance => { io = instance; };
const emit = (event, payload) => { if (io) io.emit(event, payload); };

function log(level, msg) {
  const entry = { level, msg, time: new Date().toLocaleTimeString('en-IN', { hour12: false }) };
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  emit('log', entry);
  console.log(`[${entry.time}] [${level.toUpperCase().padEnd(7)}] ${msg}`);
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

module.exports = { S, flags, setIO, emit, log, sleep, todayKey, checkDaily };

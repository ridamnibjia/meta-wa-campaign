'use strict';
const { FILES } = require('../config');
const { readJSON, debouncedWriter } = require('../lib/store');
const { S, log } = require('../state');
const { explainError } = require('../lib/errors');

// ── Message index persistence ──────────────────────────────────────────────────
// `read` webhooks arrive minutes to hours after send — long after a redeploy has
// restarted this process. Keeping msgIndex in memory only meant those events hit
// an unknown ID and were dropped, so `delivered` counted and `read` never did.
const writer = debouncedWriter(FILES.msgIndex, 2000);

function saveMsgIndex() {
  writer.schedule(() => ({
    msgIndex: S.msgIndex, delivered: S.delivered, read: S.read,
    accepted: S.accepted, failed: S.failed, failLog: S.failLog,
  }));
}

function loadMsgIndex() {
  const d = readJSON(FILES.msgIndex, {});
  Object.assign(S, {
    msgIndex: d.msgIndex || {}, delivered: d.delivered || 0, read: d.read || 0,
    accepted: d.accepted || 0, failed: d.failed || 0, failLog: d.failLog || [],
  });
}

// msgIndex now survives restarts (see MSG_FILE above), so an unknown ID means a
// message this server never sent — a stale retry from before persistence, or
// traffic from another tool on the same number. Log it rather than swallow it.
function onUnknownStatus(status) {
  log('warn', `status "${status.status}" for unknown message ${status.id} — ignored`);
}

// Meta redelivers statuses and does not promise order, so a `delivered` can land
// after its own `read`. Ranking them means a message only ever moves forward and
// each counter increments once. A `read` with no preceding `delivered` still
// counts as delivered — you cannot read what was never delivered.
const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };

function applyStatus(status) {
  const id = status.id, st = status.status;
  const m = S.msgIndex[id];
  if (!m) return onUnknownStatus(status);

  if (st === 'failed') {
    const code = status.errors?.[0]?.code;
    const hint = explainError(code);
    S.failLog.push({ time: new Date().toISOString(), phone: m.phone, name: m.name, error: status.errors?.[0]?.title, code, hint, source: 'webhook' });
    log('warn', `delivery failed — ${m.name} [${code}] ${status.errors?.[0]?.title || ''}`);
    if (hint) log('warn', `   ↳ ${hint}`);
    m.status = 'failed';
    return;
  }

  const now = STATUS_RANK[st], was = STATUS_RANK[m.status] ?? -1;
  if (now === undefined || now <= was) return;   // unknown or backwards — ignore
  if (now >= STATUS_RANK.delivered && was < STATUS_RANK.delivered) {
    S.delivered++; log('info', `delivered — ${m.name}`);
  }
  if (now >= STATUS_RANK.read && was < STATUS_RANK.read) {
    S.read++; log('info', `read — ${m.name}`);
  }
  m.status = st;
}

module.exports = { saveMsgIndex, loadMsgIndex, applyStatus, STATUS_RANK };

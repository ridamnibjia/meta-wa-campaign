'use strict';
const { CFG, FILES, LIMITS } = require('../config');
const { readJSON, debouncedWriter } = require('../lib/store');
const { S, log, emit } = require('../state');
const { normalizePhone } = require('../lib/phone');
const { graphSend } = require('./graph');
const { explainError } = require('../lib/errors');

// An inbound message opens a 24-hour "customer service window" during which the
// business may send free-form text — no template, no approval. Outside it, Meta
// rejects anything that is not an approved template (error 131047).
const WINDOW_MS = 24 * 60 * 60 * 1000;

// ponytail: 200 messages per thread. This is an operations console, not an
// archive — older messages stay in Meta's own records.
const MAX_PER_THREAD = 200;

S.inbox = readJSON(FILES.inbox, {});

const writer = debouncedWriter(FILES.inbox, 1500);
const saveInbox = () => writer.schedule(() => S.inbox);

function isWindowOpen(thread, now = Date.now()) {
  if (!thread || !thread.lastInboundAt) return false;
  return now - thread.lastInboundAt < WINDOW_MS;
}

function threadFor(waId, name) {
  if (!S.inbox[waId]) {
    S.inbox[waId] = { waId, name: name || waId, unread: 0, lastInboundAt: 0, lastAt: 0, messages: [] };
  }
  const t = S.inbox[waId];
  if (name && t.name === waId) t.name = name;   // learn the profile name once Meta sends it
  return t;
}

// Meta's own text for the message types this app does not render. Showing
// "[image]" is honest; showing nothing would look like an empty reply and the
// operator would never know the customer sent something.
function describe(m) {
  if (m.type === 'text')        return m.text?.body || '';
  if (m.type === 'button')      return m.button?.text || '[button]';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title
                                    || m.interactive?.list_reply?.title || '[interactive]';
  if (m.type === 'reaction')    return m.reaction?.emoji || '[reaction]';
  return `[${m.type || 'unsupported'}]`;
}

// Meta redelivers webhooks it did not get a 200 for, so the same wamid can
// arrive more than once. Without this check a retried batch would double every
// message in the thread and inflate the unread badge.
function recordInbound(m, profileName) {
  const waId = normalizePhone(m.from) || m.from;
  const t    = threadFor(waId, profileName);
  if (t.messages.some(x => x.id === m.id)) return null;

  const at = Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now();
  const entry = { id: m.id, dir: 'in', type: m.type || 'text', text: describe(m), at };
  t.messages.push(entry);
  if (t.messages.length > MAX_PER_THREAD) t.messages.shift();
  t.unread       += 1;
  t.lastInboundAt = Math.max(t.lastInboundAt, at);
  t.lastAt        = Math.max(t.lastAt, at);

  saveInbox();
  emit('inbox', summary());
  log('info', `reply from ${t.name} (+${waId}): ${entry.text.slice(0, 60)}`);
  return entry;
}

function markRead(waId) {
  const t = S.inbox[waId];
  if (!t) return null;
  t.unread = 0;
  saveInbox();
  emit('inbox', summary());
  return t;
}

// Free-form text, only inside the window. The check lives here rather than in
// the route so it cannot be skipped by a caller — and it is re-checked against
// the clock at send time, not against whatever the browser last rendered.
async function sendReply(waId, text) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Message is empty' };
  if (body.length > LIMITS.textMessage) {
    return { ok: false, error: `Message is ${body.length} characters — WhatsApp allows ${LIMITS.textMessage}` };
  }
  if (!CFG.accessToken || !CFG.phoneNumberId) return { ok: false, error: 'Credentials not configured' };

  const t = S.inbox[waId];
  if (!isWindowOpen(t)) {
    return { ok: false, error: 'The 24-hour reply window for this contact has closed. Only an approved template can reopen the conversation.' };
  }

  try {
    const { res, data } = await graphSend('POST', `${CFG.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                waId,
      type:              'text',
      text:              { body },
    });
    if (!res.ok || !data.messages?.[0]?.id) {
      const code = data.error?.code || 0;
      const hint = explainError(code) || explainError(data.error?.error_subcode);
      log('error', `reply to +${waId} failed [${code}] ${data.error?.message || 'unknown'}`);
      return { ok: false, error: data.error?.message || 'Send failed', hint };
    }
    const entry = { id: data.messages[0].id, dir: 'out', type: 'text', text: body, at: Date.now(), status: 'sent' };
    t.messages.push(entry);
    if (t.messages.length > MAX_PER_THREAD) t.messages.shift();
    t.lastAt = entry.at;
    saveInbox();
    emit('inbox', summary());
    log('success', `replied to ${t.name} (+${waId})`);
    return { ok: true, message: entry };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// Thread list without message bodies — the nav badge and the inbox list poll
// this, and neither needs the transcript.
function summary(now = Date.now()) {
  const threads = Object.values(S.inbox)
    .map(t => ({
      waId: t.waId,
      name: t.name,
      unread: t.unread,
      lastAt: t.lastAt,
      windowOpen: isWindowOpen(t, now),
      windowClosesAt: t.lastInboundAt ? t.lastInboundAt + WINDOW_MS : null,
      preview: t.messages.length ? t.messages[t.messages.length - 1].text.slice(0, 90) : '',
      lastDir: t.messages.length ? t.messages[t.messages.length - 1].dir : null,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
  return { threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
}

function thread(waId, now = Date.now()) {
  const t = S.inbox[waId];
  if (!t) return null;
  return {
    waId: t.waId, name: t.name, messages: t.messages,
    windowOpen: isWindowOpen(t, now),
    windowClosesAt: t.lastInboundAt ? t.lastInboundAt + WINDOW_MS : null,
  };
}

module.exports = { WINDOW_MS, isWindowOpen, recordInbound, markRead, sendReply, summary, thread, describe };

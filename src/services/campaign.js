'use strict';
const { CFG, FILES } = require('../config');
const { readJSON, writeJSON, debouncedWriter } = require('../lib/store');
const { S, flags, log, sleep, todayKey, checkDaily } = require('../state');
const { broadcast } = require('./status');
const { optOuts } = require('./optouts');
const { W, warmupCap, effectiveCap, markWarmupDay } = require('./warmup');
const { recordOutbound, countsForRun, startRun } = require('./messages');
const { sanitizeParam } = require('./templates');
const { explainError } = require('../lib/errors');
const { graphHeaders } = require('./graph');

// ── Campaign persistence ───────────────────────────────────────────────────────
// Without this the send queue lives only in memory: a VM reboot, a systemd
// restart or an OOM kill loses which contacts were already messaged, and the
// operator has no way to resume without risking a full re-send.
const writer = debouncedWriter(FILES.campaign, 2000);

const snapshot = () => ({
  contacts:     S.contacts,
  currentIdx:   S.currentIdx,
  phase:        S.phase,
  dailyCount:   S.dailyCount,
  dailyDate:    S.dailyDate,
  skipped:      S.skipped,
  config:       S.config,
  // Without this a restart forgets which run is current, applyStatus/recordOutbound
  // fall back to run_id NULL, and a resumed send merges into the inbox-reply /
  // migrated-legacy bucket that countsForRun(null) used to expose (see F1).
  currentRunId: S.currentRunId,
  savedAt:      Date.now(),
});

const saveCampaign      = () => writer.schedule(snapshot);
const saveCampaignNow   = () => writer.flush(snapshot);
const clearCampaignFile = () => writeJSON(FILES.campaign, {});

function loadCampaign() {
  const d = readJSON(FILES.campaign, {});
  if (!Array.isArray(d.contacts) || !d.contacts.length) return null;
  Object.assign(S, {
    contacts:     d.contacts,
    currentIdx:   d.currentIdx   || 0,
    phase:        d.phase        || 'idle',
    dailyCount:   d.dailyCount   || 0,
    dailyDate:    d.dailyDate    || null,
    skipped:      d.skipped      || 0,
    currentRunId: d.currentRunId ?? null,
  });
  if (d.config) Object.assign(S.config, d.config);
  return d;
}

// Fills {{1}}, {{2}}… for one contact. Each slot is either a contact field that
// varies per recipient, or one fixed value typed once for the whole campaign —
// which is how you change a figure (a price, a date) without Meta re-approving
// anything. Approved text is frozen; the values in it are not.
//
// ponytail: 'name' is the only per-contact field the CSV carries today. Add to
// CONTACT_FIELDS when the parser learns more columns.
const CONTACT_FIELDS = ['name'];

function buildParams(contact) {
  return (S.config.paramValues || []).map(p => ({
    type: 'text',
    text: sanitizeParam(p.source === 'fixed' ? p.value : contact[p.source] ?? contact.name),
  }));
}

// A slot is unusable if it is a fixed value nobody filled in — sending would put
// the literal fallback "there" where a price was meant to go.
function missingParams() {
  return (S.config.paramValues || [])
    .map((p, i) => (p.source === 'fixed' && !String(p.value || '').trim() ? i + 1 : 0))
    .filter(Boolean);
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
  if (flags.running) return;
  flags.pauseFlag = false; flags.stopFlag = false; flags.running = true;
  campaignLoop().catch(e => { log("error", "Loop: " + e.message); flags.running = false; });
}

async function campaignLoop() {
  log('info', `Campaign started — ${S.contacts.length - S.currentIdx} contacts queued`);
  while (true) {
    if (flags.stopFlag)  { log('info', 'Stopped'); S.phase = 'done'; saveCampaignNow(); broadcast(); break; }
    if (flags.pauseFlag) { await sleep(500); continue; }
    if (S.currentIdx >= S.contacts.length) {
      const c = countsForRun(S.currentRunId);
      log('info', `Done — accepted:${c.accepted} failed:${S.failed} skipped:${S.skipped}`);
      S.phase = 'done'; saveCampaignNow(); broadcast(); break;
    }
    checkDaily();
    const cap = effectiveCap();
    if (S.dailyCount >= cap) {
      // Compute ms until 00:02 IST regardless of the server's TZ.
      // IST is UTC+05:30, so offset the current UTC time by +5.5h to get
      // "IST wall-clock" as a Date, ceil to the next midnight, then undo.
      const IST_OFFSET_MS = 5.5 * 3600000;
      const nowMs = Date.now();
      const istNow = new Date(nowMs + IST_OFFSET_MS);
      istNow.setUTCHours(0, 2, 0, 0);                  // midnight IST + 2m in UTC terms
      istNow.setUTCDate(istNow.getUTCDate() + 1);       // next occurrence
      const nextIstMidnight = istNow.getTime() - IST_OFFSET_MS;
      const wait = nextIstMidnight - nowMs;
      const h = Math.floor(wait / 3600000), m = Math.floor((wait % 3600000) / 60000);
      const why = warmupCap() !== null && warmupCap() <= S.config.dailyCap
        ? `Warm-up ceiling for day ${W.days.length}` : 'Daily cap';
      log('info', `${why} ${S.dailyCount}/${cap} — resuming in ${h}h ${m}m`);
      S.phase = 'paused'; S.pauseReason = `${why} reached (${cap}/day). Resumes in ${h}h ${m}m.`; broadcast();
      await sleep(wait);
      S.phase = 'running'; S.pauseReason = null; broadcast(); continue;
    }
    const c = S.contacts[S.currentIdx];
    const n = `[${S.currentIdx + 1}/${S.contacts.length}]`;
    if (optOuts.has(c.dialStr)) {
      S.skipped++; S.currentIdx++;
      log('warn', `${n} skipped — ${c.name} opted out`);
      saveCampaign();
      broadcast();
      continue;   // no delay: nothing was sent
    }
    log('info', `${n} ${c.name} +${c.dialStr}`);
    const result = await sendTemplate(c);
    if (result.ok) {
      S.dailyCount++;
      markWarmupDay();
      recordOutbound({ wamid: result.messageId, waId: c.dialStr, name: c.name,
                       body: `[template: ${S.config.templateName}]`, runId: S.currentRunId });
      log('success', `${n} accepted — today:${S.dailyCount}/${cap}`);
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
      S.failLog.push({ time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }), phone: c.dialStr, name: c.name, error: result.error, code: result.errorCode, hint: result.hint });
      if (S.failLog.length > 50) S.failLog.shift();
      log('error', `${n} failed [${result.errorCode}] ${result.error}`);
      if (result.hint) log('error', `   ↳ ${result.hint}`);
    }
    S.currentIdx++;
    saveCampaign();   // debounced — the cursor is what a restart needs to resume
    broadcast();
    if (!flags.pauseFlag && !flags.stopFlag && S.currentIdx < S.contacts.length) {
      await sleep(S.config.delaySec * 1000);
    }
  }
  flags.running = false;
}

// ── Restart recovery ───────────────────────────────────────────────────────────
// A campaign interrupted mid-flight resumes on its own. `currentIdx` only
// advances after a send resolves, so the worst case is one duplicate message to
// the contact that was in flight when the process died — much better than a
// campaign that silently stops when the VM reboots and nobody notices for a day.
// The grace period gives the network and Meta's API time to come back first.
const RESUME_GRACE_MS = 10000;

function resumeIfInterrupted() {
  const saved = loadCampaign();
  if (!saved) return;
  const left = S.contacts.length - S.currentIdx;
  if (saved.phase !== 'running' || left <= 0) {
    log('info', `Campaign restored — ${S.currentIdx}/${S.contacts.length} done, phase ${S.phase}`);
    return;
  }
  // A campaign.json saved before run ids existed, or one whose run was
  // otherwise never opened, has no run id to restore. Resuming it silently
  // would attribute every resumed send to run_id NULL — the same bucket
  // inbox replies and migrated legacy messages live in — which merges the
  // campaign's counters and spend into unrelated traffic (F1). Open a run
  // rather than resume unattributed.
  if (S.currentRunId == null) {
    startRun(S.config.templateName);
    log('warn', `Resumed campaign had no run id on file — opened run ${S.currentRunId} so resumed sends are attributed`);
  }
  S.phase       = 'paused';
  S.pauseReason = `Server restarted — resuming ${left} remaining contacts in ${RESUME_GRACE_MS / 1000}s`;
  log('warn', `Campaign was interrupted at ${S.currentIdx}/${S.contacts.length} — auto-resuming in ${RESUME_GRACE_MS / 1000}s`);
  setTimeout(() => {
    S.phase = 'running'; S.pauseReason = null;
    log('info', `Auto-resumed — ${S.contacts.length - S.currentIdx} contacts left`);
    broadcast();
    startLoop();
  }, RESUME_GRACE_MS).unref();
}

module.exports = {
  CONTACT_FIELDS, buildParams, missingParams, sendTemplate,
  startLoop, saveCampaign, saveCampaignNow, clearCampaignFile, loadCampaign, resumeIfInterrupted,
};

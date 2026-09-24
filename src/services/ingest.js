'use strict';
// What a Meta webhook envelope MEANS, separated from how it arrived.
//
// This lived inside routes/webhook.js, which was fine while the only caller was
// the route. Replay needs the same function — and it has to be the SAME
// function, not a second implementation, because a replayed envelope that takes
// a different path is a bug that only shows up on the day you are already
// recovering from something.
const { CFG, OPT_OUT_LABEL } = require('../config');
const { db } = require('../lib/db');
const { S, log, emit } = require('../state');
const { broadcast } = require('./status');
const { disable } = require('./contacts');
const { applyStatus, markEnvelopeProcessed, waIdForWamid } = require('./messages');
const { handleDeliveryFailure } = require('./campaign');
const { fetchAccountInfo } = require('./graph');
const inbox = require('./inbox');

// One broadcast per envelope, not one per message and one per status.
// broadcast() rebuilds the whole state snapshot — several SQL aggregates,
// including the per-contact funnel — and Meta batches statuses, so a single
// webhook carrying fifty of them was fifty full rebuilds pushed down every open
// socket to render the same final number. The clients only ever see the last
// one; the other forty-nine were work nobody could observe. The inbox thread
// list follows the same rule, for the same reason (see `inbound` below).
function processEnvelope(body) {
  if (body.object !== 'whatsapp_business_account') return;
  let changed = false, inbound = 0;
  for (const entry of (body.entry || [])) {
    // Meta stamps every webhook with the WABA ID that produced it. A System User
    // token without business_management cannot look that ID up from the Business
    // Portfolio, so learning it here is often the only way the server gets it —
    // and without it template validation and the picker cannot work at all.
    if (!CFG.wabaId && entry.id) {
      CFG.wabaId = entry.id;
      log('info', `WABA ID learned from webhook: ${entry.id} — add WABA_ID=${entry.id} to .env so it survives a restart`);
    }

    for (const change of (entry.changes || [])) {

      // Template review finished. Meta only sends this if the app is subscribed
      // to the `message_template_status_update` field — App Dashboard →
      // WhatsApp → Configuration → Webhook fields.
      if (change.field === 'message_template_status_update') {
        const v = change.value || {};
        log(v.event === 'APPROVED' ? 'success' : 'warn',
            `template "${v.message_template_name}" is ${v.event}${v.reason && v.reason !== 'NONE' ? ` — ${v.reason}` : ''}`);
        emit('templates');
        continue;
      }

      // The number's quality rating moved, or its messaging tier did. The
      // warm-up gate re-derives its rung from S.quality on every send, and
      // until this nothing refreshed that value while a campaign ran — only an
      // operator opening a page, or the next Start — so on a retry ladder that
      // spans days, a slip to YELLOW on day two changed nothing. The payload
      // names an EVENT (FLAGGED, DOWNGRADE, …) and the tier, not the rating, so
      // the rating is re-read from Graph rather than guessed from the event.
      // Not awaited: this function stays synchronous, and a re-read is the one
      // write replay cannot get wrong — it only ever fetches the rating as it is
      // NOW. Subscribing to this field is README §10's job.
      if (change.field === 'phone_number_quality_update') {
        const v = change.value || {};
        log(['UPGRADE', 'UNFLAGGED'].includes(v.event) ? 'info' : 'warn',
            `Meta quality update: ${v.event || 'changed'}${v.current_limit ? ` · limit ${v.current_limit}` : ''}`);
        fetchAccountInfo()
          .then(i => {
            // fetchAccountInfo reports a Graph refusal as { error } rather than
            // throwing; both land in the same catch, so neither is silent.
            if (!i?.qualityRating) throw new Error(i?.error || 'Graph returned no rating');
            S.quality = i.qualityRating;
            broadcast();
          })
          .catch(e => log('warn', `Could not re-read the quality rating: ${e.message}`));
        continue;
      }

      // Inbound messages. A quick-reply tap on a template arrives as type
      // 'button'; the same label from an interactive message arrives as
      // button_reply. Everything — including the opt-out tap — is also recorded
      // in the inbox, so the operator can see what the customer actually did.
      // Resolved per MESSAGE, not per change: Meta batches several senders'
      // messages into one change.value with parallel messages[]/contacts[]
      // arrays, and reading contacts[0] for everyone stamped sender A's profile
      // name onto sender B's thread — and recorded B's opt-out under A's name.
      // find() on wa_id covers the single-entry case too.
      const contactsArr = change.value?.contacts || [];
      for (const m of (change.value?.messages || [])) {
        const profileName = contactsArr.find(c => c.wa_id === m.from)?.profile?.name;
        // Counted only when something new landed: a redelivery returns null,
        // and re-announcing an unchanged thread list is work nobody sees.
        if (inbox.recordInbound(m, profileName)) inbound++;

        const label = m.button?.text || m.interactive?.button_reply?.title;
        if (label && label.trim().toLowerCase() === OPT_OUT_LABEL.toLowerCase()) {
          // Campaigns only. The contact stays fully replyable in the inbox —
          // someone who opted out of promotions and then asks a question still
          // deserves an answer, and answering is not a marketing message.
          if (disable(m.from, 'opt_out', profileName)) {
            log('warn', `opt-out — +${m.from} will be skipped by campaigns from now on`);
          }
          // wa_id is not always the number we dialed: Brazil's ninth digit,
          // Mexico's 521 and Argentina's 9 all come back from Meta in a
          // different form from the one in the CSV, and the loop checks the
          // CSV form. The tap answers a template, and context.id is that
          // template's wamid — which names the form we dialed. disable() is a
          // no-op when that number is already off for this reason, so a
          // redelivered tap or a replay costs nothing.
          // ponytail: only a button tap is an opt-out here, and every tap
          // carries context.id. A typed stop word would not — learning wa_id
          // aliases from each send response (data.contacts[0].wa_id) is the
          // fix if that ever becomes an opt-out path.
          const dialed = m.context?.id ? waIdForWamid(m.context.id) : null;
          if (dialed && dialed !== m.from && disable(dialed, 'opt_out', profileName)) {
            log('warn', `opt-out — +${dialed} (the number campaigns dial for +${m.from}) will be skipped too`);
          }
        }
        changed = true;
      }

      for (const status of (change.value?.statuses || [])) {
        // applyStatus returns a descriptor only on the transition INTO 'failed'.
        // Meta accepts most sends and refuses them later over this webhook, so
        // without this hand-off the retry ladder never sees the failure it was
        // lengthened for and the run closes with the contact never reached.
        // Both sides are idempotent — the transition guard here, the wamid
        // guard in the UPDATE — which is what keeps Replay safe to press twice.
        const failure = applyStatus(status);
        if (failure) handleDeliveryFailure(failure);
        changed = true;
      }
    }
  }
  // One thread-list rebuild per envelope. recordInbound is the only writer of
  // inbound rows and emits nothing itself, so this is the one place a reply
  // reaches the open inbox screens.
  if (inbound) emit('inbox', inbox.summary());
  if (changed) broadcast();
}

// ── Replay ─────────────────────────────────────────────────────────────────────
// webhook_events rows with processed_at IS NULL are envelopes Meta delivered and
// this app stored but could not interpret — a parser bug, a shape nobody had
// seen. Until now nothing could act on them: /health counted them and that was
// the end of the road, which made the counter a dead end rather than a signal.
//
// Replay is safe to run more than once because every write underneath it is
// idempotent by construction: messages dedupes on the wamid primary key,
// applyStatus only ever moves a status forward, and disable() is a no-op when
// the contact is already off for that reason. That is a property worth stating
// out loud, because it is the reason this button can exist at all.
const unprocessed = db.prepare(
  'SELECT id, received_at, body FROM webhook_events WHERE processed_at IS NULL ORDER BY id LIMIT ?');

function replayUnprocessed({ limit = 100 } = {}) {
  const rows = unprocessed.all(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  const result = { attempted: rows.length, replayed: 0, failed: 0, errors: [] };

  for (const row of rows) {
    try {
      processEnvelope(JSON.parse(row.body));
      markEnvelopeProcessed(row.id);
      result.replayed++;
    } catch (e) {
      // Left unprocessed on purpose. An envelope that still cannot be parsed is
      // not one to mark done — it is the one to fix the parser for, and marking
      // it would throw away the only copy of what Meta sent.
      result.failed++;
      if (result.errors.length < 10) result.errors.push({ id: row.id, error: e.message });
      log('error', `replay of webhook ${row.id} failed again: ${e.message}`);
    }
  }

  if (result.replayed) log('info', `Replayed ${result.replayed} stored webhook(s)`);
  if (result.failed)   log('warn', `${result.failed} webhook(s) still cannot be processed — kept for a later attempt`);
  return result;
}

module.exports = { processEnvelope, replayUnprocessed };

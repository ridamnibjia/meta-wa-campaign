'use strict';
const express = require('express');
const { CFG, OPT_OUT_LABEL } = require('../config');
const { S, log, emit } = require('../state');
const { verifySignature } = require('../lib/signature');
const { broadcast } = require('../services/status');
const { disable } = require('../services/contacts');
const { applyStatus, recordEnvelope, markEnvelopeProcessed } = require('../services/messages');
const inbox = require('../services/inbox');

const router = express.Router();

// This router is mounted *before* requireAuth on purpose: Meta cannot sign in.
// Its authenticity comes from the HMAC signature check below, which is a
// stronger guarantee than a shared password anyway.
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // The token check must fail closed when none is configured. Without the first
  // clause an unset WEBHOOK_VERIFY_TOKEN would match `?hub.verify_token=` and
  // hand the challenge to anyone who asked.
  if (mode === 'subscribe' && CFG.webhookVerifyToken && token === CFG.webhookVerifyToken) {
    log('info', 'Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  if (!CFG.webhookVerifyToken) log('warn', 'webhook verification refused — WEBHOOK_VERIFY_TOKEN is not set');
  res.sendStatus(403);
});

function processEnvelope(body) {
  if (body.object !== 'whatsapp_business_account') return;
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

      // Inbound messages. A quick-reply tap on a template arrives as type
      // 'button'; the same label from an interactive message arrives as
      // button_reply. Everything — including the opt-out tap — is also recorded
      // in the inbox, so the operator can see what the customer actually did.
      const profileName = change.value?.contacts?.[0]?.profile?.name;
      for (const m of (change.value?.messages || [])) {
        inbox.recordInbound(m, profileName);

        const label = m.button?.text || m.interactive?.button_reply?.title;
        if (label && label.trim().toLowerCase() === OPT_OUT_LABEL.toLowerCase()) {
          // Campaigns only. The contact stays fully replyable in the inbox —
          // someone who opted out of promotions and then asks a question still
          // deserves an answer, and answering is not a marketing message.
          if (disable(m.from, 'opt_out', profileName)) {
            log('warn', `opt-out — +${m.from} will be skipped by campaigns from now on`);
          }
        }
        broadcast();
      }

      for (const status of (change.value?.statuses || [])) {
        applyStatus(status);
        broadcast();
      }
    }
  }
}

router.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), CFG.appSecret)) {
    log('warn', 'webhook POST rejected — bad or missing X-Hub-Signature-256');
    return res.sendStatus(401);
  }

  // Durability first, acknowledgement second. If this insert fails the batch is
  // NOT acknowledged: Meta retries, and a retry the system survives beats a 200
  // that was not true.
  let eventId;
  try {
    // req.rawBody is guaranteed here: verifySignature returns false without it
    // (lib/signature.js:9), so a request that got this far has the raw bytes.
    // Never re-serialise req.body as a fallback — that would store a
    // normalised copy, or `{}`, in place of what Meta actually sent.
    eventId = recordEnvelope(req.rawBody.toString('utf8'));
  } catch (e) {
    log('error', `webhook NOT stored — refusing to acknowledge so Meta retries: ${e.message}`);
    return res.sendStatus(500);
  }

  res.sendStatus(200);   // ~20s and Meta retries; everything below is after the ACK

  try {
    processEnvelope(req.body);
    markEnvelopeProcessed(eventId);
  } catch (e) {
    // The row keeps processed_at = NULL, so it can be replayed after a parser
    // fix without asking Meta for anything. Never crash the process.
    log('error', `webhook ${eventId} parsed with errors — kept for replay: ${e.message}`);
  }
});

module.exports = router;

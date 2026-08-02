'use strict';
const express = require('express');
const { CFG, OPT_OUT_LABEL } = require('../config');
const { S, log, emit } = require('../state');
const { verifySignature } = require('../lib/signature');
const { broadcast } = require('../services/status');
const { addOptOut } = require('../services/optouts');
const { applyStatus, saveMsgIndex } = require('../services/messages');
const inbox = require('../services/inbox');

const router = express.Router();

// This router is mounted *before* requireAuth on purpose: Meta cannot sign in.
// Its authenticity comes from the HMAC signature check below, which is a
// stronger guarantee than a shared password anyway.
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === CFG.webhookVerifyToken) {
    log('info', 'Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), CFG.appSecret)) {
    log('warn', 'webhook POST rejected — bad or missing X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // always ACK immediately — Meta retries anything slower than ~20s
  const body = req.body;
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
          if (addOptOut(m.from)) log('warn', `opt-out — +${m.from} will be skipped from now on`);
        }
        broadcast();
      }

      for (const status of (change.value?.statuses || [])) {
        applyStatus(status);
        saveMsgIndex();
        broadcast();
      }
    }
  }
});

module.exports = router;

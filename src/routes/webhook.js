'use strict';
const express = require('express');
const { CFG } = require('../config');
const { log } = require('../state');
const { verifySignature } = require('../lib/signature');
const { recordEnvelope, markEnvelopeProcessed } = require('../services/messages');
const { processEnvelope } = require('../services/ingest');

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
    // fix without asking Meta for anything — which the diagnostics page can now
    // actually do. Never crash the process.
    log('error', `webhook ${eventId} parsed with errors — kept for replay: ${e.message}`);
  }
});

module.exports = router;

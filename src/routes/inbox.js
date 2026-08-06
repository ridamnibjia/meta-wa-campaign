'use strict';
const express = require('express');
const inbox = require('../services/inbox');
const { normalizePhone } = require('../lib/phone');
const { broadcast } = require('../services/status');

const router = express.Router();

// ?all=1 includes threads that only ever received a campaign message. Default
// is replied-only, or a 1000-contact blast turns the console into a phone book.
router.get('/inbox', (req, res) => res.json(inbox.summary({ all: req.query.all === '1' })));

router.get('/inbox/:waId', (req, res) => {
  const waId = normalizePhone(req.params.waId) || req.params.waId;
  const t = inbox.thread(waId);
  if (!t) return res.status(404).json({ error: 'No conversation with that number' });
  inbox.markRead(waId);
  broadcast();   // the nav badge is part of campaign state
  res.json(t);
});

router.post('/inbox/:waId/reply', async (req, res) => {
  const waId = normalizePhone(req.params.waId) || req.params.waId;
  const r = await inbox.sendReply(waId, req.body?.text);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;

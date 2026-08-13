'use strict';
const express = require('express');
const inbox = require('../services/inbox');
const { normalizePhone } = require('../lib/phone');
const { broadcast } = require('../services/status');

const router = express.Router();

// ?all=1 includes threads that only ever received a campaign message. Default
// is replied-only, or a 1000-contact blast turns the console into a phone book.
router.get('/inbox', (req, res) => res.json(inbox.summary({ all: req.query.all === '1' })));

// Mounted BEFORE /inbox/:waId, or ":waId" would swallow "search" as a phone
// number and answer with a 404 for a conversation nobody asked about.
router.get('/inbox/search', (req, res) => {
  const waId = req.query.waId ? (normalizePhone(req.query.waId) || req.query.waId) : null;
  res.json(inbox.search(req.query.q, { waId, limit: req.query.limit }));
});

// `before` is the cursor from the previous page. Without it you get the newest
// 30 — which is what opening a conversation means.
router.get('/inbox/:waId', (req, res) => {
  const waId = normalizePhone(req.params.waId) || req.params.waId;
  const t = inbox.thread(waId, { before: req.query.before || null, limit: req.query.limit });
  if (!t) return res.status(404).json({ error: 'No conversation with that number' });
  // Only when the newest page was asked for. Paging backwards through history
  // is reading, not catching up, and should not clear a badge that arrived
  // while you were scrolling.
  if (!req.query.before) {
    inbox.markRead(waId);
    broadcast();   // the nav badge is part of campaign state
  }
  res.json(t);
});

router.post('/inbox/:waId/reply', async (req, res) => {
  const waId = normalizePhone(req.params.waId) || req.params.waId;
  const r = await inbox.sendReply(waId, req.body?.text);
  res.status(r.ok ? 200 : 400).json(r);
});

// Sends a file that is already in the library. Uploading is deliberately NOT
// here: it reuses POST /media/upload, which already dedupes on content hash and
// now runs the risk classifier. Two upload endpoints would be two places to keep
// those guarantees in step, and the second one is always the one that drifts.
router.post('/inbox/:waId/media', async (req, res) => {
  const waId = normalizePhone(req.params.waId) || req.params.waId;
  const assetId = Number(req.body?.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return res.status(400).json({ ok: false, error: 'Pick a file to send.' });
  }
  const r = await inbox.sendMedia(waId, assetId, req.body?.caption);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;

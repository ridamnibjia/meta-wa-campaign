'use strict';
const express = require('express');
const fs      = require('fs');
const multer  = require('multer');
const { MEDIA_KINDS, saveUpload, listAssets, getAsset, assetPath,
        getInbound, inboundPath, saveInbound } = require('../services/media');
const { log } = require('../state');

const router = express.Router();

// The ceiling is the largest kind Meta accepts (a 100 MB document). Per-kind
// limits are enforced in saveUpload, which knows the mime type; multer only
// knows the byte count, so this is the outer bound, not the real check.
const MAX_BYTES = Math.max(...Object.values(MEDIA_KINDS).map(k => k.maxBytes));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

router.post('/media/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    // multer aborts an oversized stream itself, before saveUpload ever sees it.
    // Translating the code here is what stops that arriving as a bare 500.
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `That file is over ${(MAX_BYTES / (1024 * 1024)).toFixed(0)} MB, which is Meta's largest header limit`
        : err.message;
      return res.json({ ok: false, error: msg });
    }
    const r = saveUpload(req.file);
    if (!r.ok) return res.json(r);
    log('info', `Media ${r.deduped ? 'reused' : 'saved'} — ${r.asset.filename} (${r.asset.kind})`);
    res.json({ ok: true, asset: r.asset, deduped: !!r.deduped });
  });
});

router.get('/media', (req, res) => res.json({ assets: listAssets() }));

// Streamed from disk behind the same auth as everything else, rather than
// mounted statically: a static mount would make every uploaded file readable by
// anyone who could guess a hash, and these are customer-facing documents.
router.get('/media/asset/:id', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'No such media asset' });
  const file = assetPath(asset);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file for this asset is missing from disk' });
  res.type(asset.mime_type);
  // inline, not attachment: the composer previews images in an <img>.
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.filename)}"`);
  fs.createReadStream(file).pipe(res);
});

// ── Inbound: what a customer sent us ───────────────────────────────────────────
// An allowlist, not a denylist: the set of types the inbox actually renders is
// short and known, and a denylist of script-capable types is a guess about
// every browser's future behaviour. PDF is deliberately absent — nothing
// renders one inline, so it downloads like any other document.
const INLINE_SAFE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/amr',
  'video/mp4', 'video/3gpp',
]);

// WhatsApp voice notes arrive as "audio/ogg; codecs=opus". The allowlist holds
// bare types, so the parameters come off before the lookup.
const bareMime = m => String(m || '').split(';')[0].trim().toLowerCase();


// Explicitly operator-triggered. Nothing downloads customer media automatically,
// so the bytes only ever land on this server because someone asked for them.
router.post('/media/inbound/:mediaId', async (req, res) => {
  const r = await saveInbound(req.params.mediaId);
  res.status(r.ok ? 200 : 400).json(r);
});

router.get('/media/inbound/:mediaId', (req, res) => {
  const row = getInbound(req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'No such media' });
  // 409, not 404. The row exists and the fix is "save it first" — a 404 would
  // send the operator looking for a message that is right in front of them.
  if (!row.path) return res.status(409).json({ error: 'This media has not been saved to the server yet' });

  const file = inboundPath(row);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file for this media is missing from disk' });

  // The mime type is whatever the customer's file carried — Meta relays it and
  // we stored it. Reflecting it back with `inline` on this origin would let a
  // customer who sends an SVG or an .html "document" run script against the
  // dashboard with the operator's own session cookie attached. So the type is
  // only honoured if it is on the list of things the inbox actually renders;
  // everything else downloads as opaque bytes.
  const mime = INLINE_SAFE.has(bareMime(row.mime_type)) ? bareMime(row.mime_type) : null;
  const name = row.filename || `${row.media_id}`;

  res.type(mime || 'application/octet-stream');
  // nosniff, because without it a browser will happily ignore
  // application/octet-stream and render whatever the bytes look like.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The backstop: even if a script-capable type ever reaches this line, a
  // sandboxed response with no permitted sources cannot execute anything.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Content-Disposition',
    `${mime && !req.query.download ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`);
  fs.createReadStream(file).pipe(res);
});

module.exports = router;

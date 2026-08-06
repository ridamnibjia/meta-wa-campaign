'use strict';
const express = require('express');
const fs      = require('fs');
const multer  = require('multer');
const { MEDIA_KINDS, saveUpload, listAssets, getAsset, assetPath } = require('../services/media');
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

module.exports = router;

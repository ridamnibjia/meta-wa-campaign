'use strict';
const express = require('express');
const fs      = require('fs');
const multer  = require('multer');
const { MEDIA_KINDS, saveUpload, listAssets, getAsset, assetPath,
        getInbound, inboundPath, saveInbound, rescanIfNeeded } = require('../services/media');
const { worst } = require('../lib/filerisk');
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
// The SECOND of two gates on inline rendering. lib/filerisk computes a tier
// from three signals; this is a fixed list of what the inbox actually renders.
// Inline needs both to agree, deliberately: the tier is derived from evidence
// and this is a list somebody wrote down, and a bug in either one alone should
// not be enough to put a customer's file in an <img> on this origin.
//
// An allowlist, not a denylist, for the same reason it always was: a denylist
// of script-capable types is a guess about every browser's future behaviour.
// PDF is deliberately absent — nothing renders one inline here.
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

// Content-Disposition with a non-ASCII filename is only portable through
// RFC 5987's filename*= form. The plain filename= stays as a fallback for
// anything that predates it, stripped to ASCII so a quote or a backslash in a
// customer's filename cannot break out of the header.
const disposition = (kind, name) => {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

router.get('/media/inbound/:mediaId', async (req, res) => {
  let row = getInbound(req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'No such media' });
  // 409, not 404. The row exists and the fix is "save it first" — a 404 would
  // send the operator looking for a message that is right in front of them.
  if (!row.path) return res.status(409).json({ error: 'This media has not been saved to the server yet' });

  // Saved before clamd existed on this host? Scan it now, on the first request
  // for it, rather than never.
  row = await rescanIfNeeded(row);
  if (row.scan_status === 'infected') {
    return res.status(403).json({
      scan: 'infected', signature: row.scan_signature,
      error: `This file matched a malware signature (${row.scan_signature}) and has been deleted from the server.`,
    });
  }
  if (!row.path) return res.status(409).json({ error: 'This media is no longer on the server' });

  const file = inboundPath(row);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file for this media is missing from disk' });

  // The stored tier is the worst of three signals taken at save time. NULL
  // means the row predates classification, and `ok` — downloads, never
  // renders — is the honest verdict for a file nothing has looked at.
  //
  // A file clamd could not scan because it was too big is nobody's vouched-for
  // file, so it floors at warn however innocent its bytes looked.
  let risk = row.risk || 'ok';
  if (row.scan_status === 'oversize') risk = worst(risk, 'warn');

  if (risk === 'block' && req.query.risk !== 'accept') {
    return res.status(403).json({
      risk: 'block',
      reason: row.risk_reason || 'This file type can run code on a computer that opens it.',
      error: 'This file is not served by default. Retry with risk=accept to download it anyway.',
    });
  }

  // The mime type is whatever the customer's file carried — Meta relays it and
  // we stored it. Reflecting it back with `inline` on this origin would let a
  // customer who sends an SVG or an .html "document" run script against the
  // dashboard with the operator's own session cookie attached. So inline needs
  // the tier AND the allowlist to agree; everything else is opaque bytes.
  const bare   = bareMime(row.mime_type);
  const inline = risk === 'safe' && INLINE_SAFE.has(bare) && !req.query.download;

  res.type(inline ? bare : 'application/octet-stream');
  // nosniff, because without it a browser will happily ignore
  // application/octet-stream and render whatever the bytes look like.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The backstop: even if a script-capable type ever reaches this line, a
  // sandboxed response with no permitted sources cannot execute anything.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Content-Disposition', disposition(inline ? 'inline' : 'attachment', row.filename || row.media_id));
  fs.createReadStream(file).pipe(res);
});

module.exports = router;

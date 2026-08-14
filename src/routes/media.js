'use strict';
const express = require('express');
const fs      = require('fs');
const multer  = require('multer');
const { MEDIA_KINDS, saveUpload, listAssets, getAsset, assetPath,
        getInbound, inboundPath, saveInbound, rescanIfNeeded,
        keepInbound, discardInbound, deleteAsset } = require('../services/media');
const { effectiveRisk } = require('../lib/filerisk');
const storage = require('../services/storage');
const { sweepMedia } = require('../services/retention');
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

// ── Storage management ─────────────────────────────────────────────────────────
// Mounted BEFORE /media/:id would ever see them: "/media/storage" is two
// segments and would otherwise be read as an asset id called "storage".
router.get('/media/storage', (req, res) => {
  res.json({ ...storage.overview(), ...storage.listStored() });
});

router.patch('/media/storage/rename/:id', (req, res) => {
  const r = storage.renameAsset(req.params.id, req.body?.filename);
  res.status(r.ok ? 200 : 400).json(r);
});

// Bulk. Each item is still checked one at a time by the same guards a single
// delete uses, and the response reports per-item outcomes — a selection is a
// convenience, never a way past a refusal.
router.post('/media/storage/remove', (req, res) => {
  const r = storage.removeMany(req.body?.items);
  res.status(r.ok ? 200 : 400).json(r);
});

// Runs the retention sweep early. It removes only what is ALREADY past its
// cutoff, so this changes nothing about the retention promise — it just means
// not waiting for the timer when the disk is filling now.
router.post('/media/storage/sweep', (req, res) => {
  const r = sweepMedia();
  log('info', `Sweep run from the Storage page — ${r.swept} file(s), ${r.freed} bytes`);
  res.json({ ok: true, ...r });
});

// Operator-controlled storage management. There is no auto-sweep of UPLOAD_DIR
// on purpose: nobody but the operator has a copy of their own file, Meta drops
// its copy at 30 days, and deleting one on a timer is the unrecoverable failure
// the two-store rule exists to prevent. The service refuses any delete that
// would leave a template, a campaign or a sent message unable to say what it
// sent, so this cannot be used to rewrite history either.
router.delete('/media/:id', (req, res) => {
  const r = deleteAsset(req.params.id);
  res.status(r.ok ? 200 : 409).json(r);
});


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
//
// PDF is the one entry that is NOT reachable from tier `safe`. classify() caps
// a PDF at `ok` — correctly, since a PDF is a document format with a scripting
// engine behind it — so it previews under a narrower rule below rather than
// through the general gate. The exception is worth it: operators were told to
// download an invoice to their own machine to find out whether it was the
// invoice, which puts the file in a desktop reader instead of a sandboxed tab.
const INLINE_SAFE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/amr',
  'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm', 'video/x-matroska',
  'application/pdf',
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

// The same fetch, on a shorter clock. An operator cannot decide whether a file
// is worth keeping without looking at it, and they cannot look at it while it
// is still on Meta's servers behind a token the browser does not have. So the
// bytes come here first — scanned and classified exactly as a Save is, because
// the risk is in the file and not in the button that asked for it — and the
// retention sweep removes them in hours unless someone says Keep.
router.post('/media/inbound/:mediaId/preview', async (req, res) => {
  const r = await saveInbound(req.params.mediaId, { provisional: true });
  res.status(r.ok ? 200 : 400).json(r);
});

router.post('/media/inbound/:mediaId/keep', (req, res) => {
  const r = keepInbound(req.params.mediaId);
  if (r.ok) log('info', `Operator kept inbound media ${req.params.mediaId}`);
  res.status(r.ok ? 200 : 400).json(r);
});

// DELETE, because it deletes. The service refuses to touch anything an operator
// has already kept, so the worst this can do is undo a preview.
router.delete('/media/inbound/:mediaId', (req, res) => {
  const r = discardInbound(req.params.mediaId);
  res.status(r.ok ? 200 : 400).json(r);
});

// Content-Disposition with a non-ASCII filename is only portable through
// RFC 5987's filename*= form. The plain filename= stays as a fallback for
// anything that predates it, stripped to ASCII so a quote or a backslash in a
// customer's filename cannot break out of the header.
// encodeURIComponent leaves !'()* alone, and none of those are attr-char in
// RFC 5987's ext-value grammar — an apostrophe in particular is the delimiter,
// so a filename containing one would split the header. Percent-encode them too.
const rfc5987 = s => encodeURIComponent(s).replace(/['()!*]/g,
  c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const disposition = (kind, name) => {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${rfc5987(String(name))}`;
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

  // The same function the inbox uses to decide whether to render an <img>.
  // Sharing it is what stops the UI asking for a preview this route has
  // already decided to refuse.
  const risk = effectiveRisk(row.risk, row.scan_status);

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

  // The one tier-`ok` exception, kept narrow on purpose. `row.risk` is the RAW
  // column, not effectiveRisk: a NULL tier also reads as `ok`, and a row saved
  // before classification existed has no evidence behind it — only a default.
  // Requiring both means the bytes were actually sniffed AND the scan was not
  // floored to `warn` for being oversize.
  //
  // What makes this safe is the sandbox header below, which is already sent on
  // every response from this route: `sandbox` with no allow- tokens puts the
  // document in a unique opaque origin, so the browser's PDF viewer cannot
  // reach this origin's cookies, storage or DOM even if the file is hostile.
  const pdfPreview = bare === 'application/pdf' && row.risk === 'ok' && risk === 'ok';
  const inline = (risk === 'safe' || pdfPreview) && INLINE_SAFE.has(bare) && !req.query.download;

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

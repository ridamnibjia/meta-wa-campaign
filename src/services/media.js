'use strict';
// The only module where an access token meets a file. Everything else in the
// app deals in ids: routes hand bytes in here, the send path asks for a header
// component, and neither knows that Meta needs two different identifiers for
// the same file.
const fs     = require('fs');
const path   = require('path');
const crypto = require('node:crypto');
const { UPLOAD_DIR } = require('../config');
const { db } = require('../lib/db');

// Meta's documented maxima for template header media. Enforced on our side
// because the alternative is pushing 100 MB over the wire for Meta to reject
// after every byte has already been sent.
const MEDIA_KINDS = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    types: ['image/jpeg', 'image/png'],
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    types: ['video/mp4', 'video/3gpp'],
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    types: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
  },
};

// Browsers send "text/plain; charset=utf-8"; Meta's list is the bare type.
const bareMime = m => String(m || '').split(';')[0].trim().toLowerCase();

function kindFor(mime) {
  const m = bareMime(mime);
  return Object.keys(MEDIA_KINDS).find(k => MEDIA_KINDS[k].types.includes(m)) || null;
}

const mb = n => `${(n / (1024 * 1024)).toFixed(1)} MB`;

// ── Rows ───────────────────────────────────────────────────────────────────────
const insertAsset = db.prepare(`
  INSERT INTO media_assets (sha256, path, filename, mime_type, file_size, kind, uploaded_at, last_used_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const byHash   = db.prepare('SELECT * FROM media_assets WHERE sha256 = ?');
const byId     = db.prepare('SELECT * FROM media_assets WHERE id = ?');
const allRows  = db.prepare('SELECT * FROM media_assets ORDER BY uploaded_at DESC, id DESC');
const touchRow = db.prepare('UPDATE media_assets SET last_used_at = ? WHERE id = ?');

const getAsset   = id => byId.get(Number(id));
const listAssets = () => allRows.all();

// `path` on the row is a bare filename, joined here. Storing it relative to
// UPLOAD_DIR is what lets WA_UPLOAD_DIR move the whole store — including in
// tests — without rewriting every row.
const assetPath = row => path.join(UPLOAD_DIR, row.path);

// ── Save ───────────────────────────────────────────────────────────────────────
// Returns { ok, asset } / { ok:false, error } rather than throwing, because
// every caller is an HTTP route that has to turn the failure into a message an
// operator can act on.
function saveUpload(file) {
  if (!file || !file.buffer) return { ok: false, error: 'No file received' };

  const mime = bareMime(file.mimetype);
  const kind = kindFor(mime);
  if (!kind) {
    return { ok: false, error: `WhatsApp does not accept ${mime || 'that file type'} as a template header. Use a JPEG or PNG image, an MP4 video, or a PDF/Office document.` };
  }

  const { maxBytes } = MEDIA_KINDS[kind];
  const size = file.buffer.length;
  if (size > maxBytes) {
    return { ok: false, error: `That ${kind} is ${mb(size)} — Meta's limit for a ${kind} header is ${mb(maxBytes)}` };
  }

  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // The same file dragged in twice is one row, one file on disk, one Resumable
  // Upload and one media id. Dedupe on content, not on name: a renamed copy of
  // last month's price list is still last month's price list.
  const existing = byHash.get(sha);
  if (existing) {
    touchRow.run(Date.now(), existing.id);
    return { ok: true, asset: byId.get(existing.id), deduped: true };
  }

  const ext  = (path.extname(file.originalname || '') || '').slice(0, 10).toLowerCase();
  const name = `${sha}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);

  const now = Date.now();
  const id  = Number(insertAsset.run(
    sha, name, file.originalname || name, mime, size, kind, now, now,
  ).lastInsertRowid);
  return { ok: true, asset: byId.get(id) };
}

module.exports = { MEDIA_KINDS, kindFor, saveUpload, listAssets, getAsset, assetPath };

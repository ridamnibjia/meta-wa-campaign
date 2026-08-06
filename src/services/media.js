'use strict';
// The only module where an access token meets a file. Everything else in the
// app deals in ids: routes hand bytes in here, the send path asks for a header
// component, and neither knows that Meta needs two different identifiers for
// the same file.
const fs     = require('fs');
const path   = require('path');
const crypto = require('node:crypto');
const { CFG, UPLOAD_DIR, MEDIA_DIR } = require('../config');
const { db }  = require('../lib/db');
const { log } = require('../state');

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
const setHandle  = db.prepare('UPDATE media_assets SET meta_handle = ? WHERE id = ?');
const setMediaId = db.prepare('UPDATE media_assets SET media_id = ?, media_id_at = ? WHERE id = ?');

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

// ── Meta's two identifiers ─────────────────────────────────────────────────────
// Meta deletes uploaded media at 30 days. Refreshing at 29 means a campaign that
// starts near the boundary does not fail halfway through, and ensureMediaId can
// also be forced when a send comes back "media not found" — a clock skew or a
// deletion we did not predict then resolves itself on the next attempt instead
// of failing the whole run.
const MEDIA_ID_TTL_MS = 29 * 24 * 60 * 60 * 1000;

const readBytes = row => fs.readFileSync(assetPath(row));

// Template CREATION wants an h:… handle from the Resumable Upload API, which
// keys on the APP id — not the WABA id, not the business id. It is a two-call
// protocol: open a session, then push the bytes into it. The handle is single
// use per submission, but caching it is still right: re-submitting the same
// template with the same file is the common case, and a stale handle fails at
// submit with a message Meta actually explains.
async function ensureHandle(id) {
  const asset = getAsset(id);
  if (!asset) return { ok: false, error: `Media asset ${id} not found` };
  if (asset.meta_handle) return { ok: true, handle: asset.meta_handle, asset };
  if (!CFG.accessToken) return { ok: false, error: 'Access Token not configured' };
  if (!CFG.appId) {
    return { ok: false, error: 'APP_ID is not set. A media header needs Meta\'s Resumable Upload API, which keys on the app id — copy it from Meta for Developers → your app → Settings → Basic, put it in .env as APP_ID, and restart.' };
  }

  try {
    const start = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${CFG.appId}/uploads`
      + `?file_name=${encodeURIComponent(asset.filename)}`
      + `&file_length=${asset.file_size}`
      + `&file_type=${encodeURIComponent(asset.mime_type)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${CFG.accessToken}` } },
    );
    const session = await start.json();
    if (session.error || !session.id) {
      return { ok: false, error: session.error?.message || 'Could not open an upload session' };
    }

    // OAuth, not Bearer. This second call is the one documented exception in
    // the whole Graph surface, and Bearer here returns a 400 that says nothing
    // useful about why.
    const put = await fetch(`https://graph.facebook.com/${CFG.apiVersion}/${session.id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${CFG.accessToken}`, file_offset: '0' },
      body: readBytes(asset),
    });
    const done = await put.json();
    if (done.error || !done.h) {
      return { ok: false, error: done.error?.message || 'Upload session did not return a handle' };
    }

    setHandle.run(done.h, asset.id);
    log('info', `Uploaded "${asset.filename}" for template approval`);
    return { ok: true, handle: done.h, asset: getAsset(asset.id) };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// SENDING wants a media id from the phone number's own /media endpoint. A
// template approved with a handle cannot be sent with that handle, which is the
// whole reason one file needs two identifiers and therefore a row.
async function ensureMediaId(id, { force = false } = {}) {
  const asset = getAsset(id);
  if (!asset) return { ok: false, error: `Media asset ${id} not found` };

  const fresh = asset.media_id && asset.media_id_at
    && (Date.now() - asset.media_id_at) < MEDIA_ID_TTL_MS;
  if (fresh && !force) return { ok: true, mediaId: asset.media_id, asset };

  if (!CFG.accessToken || !CFG.phoneNumberId) {
    return { ok: false, error: 'Credentials not configured' };
  }

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', asset.mime_type);
    // No Content-Type header below on purpose: fetch sets it, with the
    // multipart boundary, only when we leave it alone.
    form.append('file', new Blob([readBytes(asset)], { type: asset.mime_type }), asset.filename);

    const res = await fetch(
      `https://graph.facebook.com/${CFG.apiVersion}/${CFG.phoneNumberId}/media`,
      { method: 'POST', headers: { Authorization: `Bearer ${CFG.accessToken}` }, body: form },
    );
    const data = await res.json();
    if (data.error || !data.id) {
      return { ok: false, error: data.error?.message || 'Media upload returned no id' };
    }

    setMediaId.run(String(data.id), Date.now(), asset.id);
    log('info', `Uploaded "${asset.filename}" for sending — media id refreshed`);
    return { ok: true, mediaId: String(data.id), asset: getAsset(asset.id) };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// The per-message attachment. `filename` is what the recipient actually sees in
// WhatsApp, which is why the original name is carried on the row rather than
// reconstructed from the sha256 path. Images and videos show no filename, so
// sending one would be noise Meta ignores.
async function headerComponent(assetId, { force = false } = {}) {
  const r = await ensureMediaId(assetId, { force });
  if (!r.ok) return r;
  const kind  = r.asset.kind;
  const inner = kind === 'document'
    ? { id: r.mediaId, filename: r.asset.filename }
    : { id: r.mediaId };
  return { ok: true, component: { type: 'header', parameters: [{ type: kind, [kind]: inner }] } };
}

// ── Inbound: media a customer sent us ──────────────────────────────────────────
// The webhook records the descriptor and not the bytes, deliberately: the CDN
// url in a download response expires in minutes, but the media id stays
// resolvable for 30 days. The row is the receipt that makes a later,
// operator-triggered fetch possible at all — without it the envelope is gone
// the moment the webhook returns.
const INBOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const inboundRow = db.prepare(`
  SELECT md.*, m.at AS message_at
    FROM media md JOIN messages m ON m.wamid = md.wamid
   WHERE md.media_id = ?
`);
const setInboundFile = db.prepare(
  'UPDATE media SET path = ?, downloaded_at = ? WHERE media_id = ?');

const getInbound = mediaId => inboundRow.get(String(mediaId));

// Same rule as assetPath: the row stores a bare filename so WA_MEDIA_DIR can
// move the whole store without rewriting a single row.
const inboundPath = row => path.join(MEDIA_DIR, row.path);

// Computed, never stored. Meta deletes the file 30 days after the message, so
// the deadline is a property of the message we already have the timestamp for —
// there is nothing to migrate and nothing to age out.
const inboundExpired = (row, now = Date.now()) =>
  !row.path && (now - row.message_at) > INBOUND_TTL_MS;

// Two hops, both authenticated: GET /{media_id} returns a short-lived CDN url,
// and that url still 401s without the same bearer token. This is why the
// browser can never fetch customer media itself and the server has to proxy.
async function saveInbound(mediaId) {
  const row = getInbound(mediaId);
  if (!row) return { ok: false, error: `No inbound media found for ${mediaId}` };
  if (row.path) return { ok: true, media: row, already: true };
  if (inboundExpired(row)) {
    return { ok: false, error: 'Meta no longer has this file — it deletes inbound media 30 days after the message.' };
  }
  if (!CFG.accessToken) return { ok: false, error: 'Access Token not configured' };

  try {
    const res = await fetch(`https://graph.facebook.com/${CFG.apiVersion}/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${CFG.accessToken}` } });
    const meta = await res.json();
    if (meta.error || !meta.url) {
      return { ok: false, error: meta.error?.message || 'Meta returned no download url for this media' };
    }

    const dl = await fetch(meta.url, { headers: { Authorization: `Bearer ${CFG.accessToken}` } });
    if (!dl.ok) return { ok: false, error: `Download failed with HTTP ${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());

    // Verify before writing, not after. A truncated CDN response otherwise
    // lands on disk as a perfectly valid-looking file that nothing downstream
    // will ever question. Prefer the webhook's own checksum — it was recorded
    // before this fetch and cannot be forged by whatever answered it.
    const expected = row.sha256 || meta.sha256 || null;
    const actual   = crypto.createHash('sha256').update(buf).digest('hex');
    if (expected && expected !== actual) {
      return { ok: false, error: 'Checksum mismatch — the download did not match the sha256 WhatsApp reported, so nothing was saved.' };
    }

    const ext  = (path.extname(row.filename || '') || '').slice(0, 10).toLowerCase();
    const name = `${actual}${ext}`;
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
    setInboundFile.run(name, Date.now(), row.media_id);

    log('info', `Saved inbound ${row.mime_type || 'file'} from message ${row.wamid}`);
    return { ok: true, media: getInbound(mediaId) };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

module.exports = {
  MEDIA_KINDS, MEDIA_ID_TTL_MS, kindFor, saveUpload, listAssets, getAsset, assetPath,
  ensureHandle, ensureMediaId, headerComponent,
  INBOUND_TTL_MS, getInbound, inboundPath, inboundExpired, saveInbound,
};

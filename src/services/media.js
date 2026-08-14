'use strict';
// The only module where an access token meets a file. Everything else in the
// app deals in ids: routes hand bytes in here, the send path asks for a header
// component, and neither knows that Meta needs two different identifiers for
// the same file.
const fs     = require('fs');
const path   = require('path');
const crypto = require('node:crypto');
const { CFG, UPLOAD_DIR, MEDIA_DIR, MEDIA_LIMITS } = require('../config');
const { db }  = require('../lib/db');
const { log } = require('../state');
const { classify, extOf } = require('../lib/filerisk');
const { scanBuffer, scannerConfigured } = require('../lib/clamav');

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
// The library the pickers show. A tombstoned row is a record, not a file: it
// must not be offerable as a header or an attachment, because the bytes it
// names are gone and the send would fail at Meta rather than here.
const allRows  = db.prepare('SELECT * FROM media_assets WHERE deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC');
const reviveRow = db.prepare('UPDATE media_assets SET deleted_at = NULL, last_used_at = ? WHERE id = ?');
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

  // The last gap in the file-risk engine. saveUpload used to take the browser's
  // declared mime type on trust — the uploader is the authenticated operator, so
  // the risk was low, but low is not none: an operator can be handed a file and
  // asked to forward it, and this path reaches every dealer on the list.
  //
  // Only the worst tier is refused. A PDF caps at `ok` by design and is the most
  // common thing this business sends, so anything stricter would block the job
  // the app exists to do. ClamAV deliberately does NOT run here — it runs on the
  // inbound path where the bytes are a stranger's, and adding a clamd dependency
  // to an operator action would break uploads on every deployment where the
  // scanner happens to be down, which is a worse failure than the one it stops.
  const verdict = classify({ mime, filename: file.originalname, bytes: file.buffer });
  if (verdict.tier === 'block') {
    return { ok: false, error: `That file was refused. ${verdict.reason} Its name says ${mime}, but its actual contents do not agree — re-export it from the app that made it, or send a PDF instead.` };
  }

  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // The same file dragged in twice is one row, one file on disk, one Resumable
  // Upload and one media id. Dedupe on content, not on name: a renamed copy of
  // last month's price list is still last month's price list.
  const existing = byHash.get(sha);
  if (existing && !existing.deleted_at) {
    touchRow.run(Date.now(), existing.id);
    log('info', `Upload "${file.originalname}" matched an existing file — reusing asset ${existing.id}`);
    return { ok: true, asset: byId.get(existing.id), deduped: true };
  }

  // Re-uploading the exact bytes of a force-deleted file revives its row rather
  // than making a second one: sha256 is UNIQUE, and the tombstone is what the
  // template and the sent message still point at. The stored filename is kept —
  // history already reported that name, and the bytes are the same bytes.
  if (existing) {
    const free = freeBytes(UPLOAD_DIR);
    if (free - size < MEDIA_LIMITS.minFreeBytes) {
      return { ok: false, error: `Not enough disk space — ${mb(free)} free, and this server keeps ${mb(MEDIA_LIMITS.minFreeBytes)} in reserve. Nothing was saved.` };
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(assetPath(existing), file.buffer);
    reviveRow.run(Date.now(), existing.id);
    log('info', `Upload "${file.originalname}" restored deleted asset ${existing.id} ("${existing.filename}") — history points at it again`);
    return { ok: true, asset: byId.get(existing.id), revived: true };
  }

  // The same floor the inbound path enforces, and for a stronger reason now that
  // the inbox writes here too: this used to be a handful of template headers a
  // month, and it is now every file an operator sends to anyone. A disk that
  // fills takes the SQLite database down with it, and wa.db is the message
  // history — so refusing an upload is by far the cheaper failure.
  //
  // Checked after the dedupe, because a byte-identical re-upload writes nothing
  // and refusing it on space grounds would be a lie.
  // `free - size`, not `free`: this is the only space check in the app that
  // knows how big the incoming file is, and a 90 MB video landing on a disk
  // exactly at the floor should be refused before it is written, not after.
  // freeBytes answers Infinity when statfs cannot, which passes by design.
  const free = freeBytes(UPLOAD_DIR);
  if (free - size < MEDIA_LIMITS.minFreeBytes) {
    log('warn', `Upload "${file.originalname}" refused — ${mb(free)} free, reserve is ${mb(MEDIA_LIMITS.minFreeBytes)}`);
    return { ok: false, error: `Not enough disk space — ${mb(free)} free, and this server keeps ${mb(MEDIA_LIMITS.minFreeBytes)} in reserve. Delete a file you no longer send from the library, then try again. Nothing was saved.` };
  }

  const ext  = (path.extname(file.originalname || '') || '').slice(0, 10).toLowerCase();
  const name = `${sha}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);

  const now = Date.now();
  const id  = Number(insertAsset.run(
    sha, name, file.originalname || name, mime, size, kind, now, now,
  ).lastInsertRowid);
  // Every other path that puts bytes on this disk says so in the operator log.
  // Without this, a library that has quietly grown to 4 GB has no history
  // explaining how, and no way to tell an upload from a dedupe.
  log('info', `Uploaded "${file.originalname}" (${kind}, ${mb(size)}) — asset ${id}, risk ${verdict.tier}`);
  return { ok: true, asset: byId.get(id) };
}

// ── Deleting an asset ──────────────────────────────────────────────────────────
// The library only ever grew. Nothing swept it, which was right while it held a
// handful of template headers — and wrong once the inbox started writing every
// file an operator sends to anyone.
//
// This is a DELIBERATE refusal to auto-sweep. An operator's file is not like
// inbound bytes: nobody else can re-send it, Meta has no copy after 30 days, and
// deleting one silently is exactly the unrecoverable failure the two-store rule
// exists to prevent. So storage is managed by the operator, with the server
// refusing any delete that would break history.
//
// Three tables reference an asset, and all three are checked by name rather than
// by a foreign-key sweep: SQLite does not enforce REFERENCES unless
// foreign_keys is ON, and a silently-orphaned row here shows up months later as
// a campaign report that cannot say what it sent.
const assetRefs = {
  templates:     db.prepare('SELECT count(*) AS n FROM templates     WHERE header_asset = ?'),
  campaign_runs: db.prepare('SELECT count(*) AS n FROM campaign_runs WHERE header_asset = ?'),
  messages:      db.prepare('SELECT count(*) AS n FROM messages      WHERE asset_id     = ?'),
};
const deleteAssetRow = db.prepare('DELETE FROM media_assets WHERE id = ?');
// The tombstone. Bytes gone, row kept, so a template that names this file and a
// message that reported sending it can both still say what it was.
const tombstoneRow = db.prepare('UPDATE media_assets SET deleted_at = ? WHERE id = ?');

// `force` is the operator saying "delete it anyway" to a file history points at.
// It is never what a plain delete does: SQLite does not enforce the REFERENCES
// on these columns (foreign_keys is off), so a forced delete silently orphans
// three tables unless the row survives to be found. That is what the tombstone
// is — deliberately not a recycle bin, because the bytes really are gone.
function deleteAsset(id, { force = false } = {}) {
  const asset = getAsset(id);
  if (!asset) return { ok: false, error: 'That file is not in the library.' };
  if (asset.deleted_at) return { ok: false, error: `"${asset.filename}" was already deleted — only its record is kept, so history can still say what was sent.` };

  const used = {
    templates: assetRefs.templates.get(asset.id).n,
    runs:      assetRefs.campaign_runs.get(asset.id).n,
    messages:  assetRefs.messages.get(asset.id).n,
  };
  const referenced = used.templates || used.runs || used.messages;
  if (referenced && !force) {
    // Named parts, not a count: "in use" tells an operator nothing about what
    // they would have to undo, and they will just try again.
    const parts = [
      used.templates && `${used.templates} template${used.templates === 1 ? '' : 's'}`,
      used.runs      && `${used.runs} campaign${used.runs === 1 ? '' : 's'}`,
      used.messages  && `${used.messages} sent message${used.messages === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ');
    return { ok: false, error: `"${asset.filename}" is still referenced by ${parts}. Deleting it would leave that history unable to say what was sent, so it is kept.` };
  }

  // Same guard dropBytes holds, and for the same reason: `path` is a column, and
  // a column is data. Resolving it and checking it still lands inside UPLOAD_DIR
  // is what stops a crafted or corrupted row unlinking something else.
  const full = path.resolve(assetPath(asset));
  const root = path.resolve(UPLOAD_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    log('error', `Refused to delete asset ${asset.id}: ${asset.path} resolves outside UPLOAD_DIR`);
    return { ok: false, error: 'That file is stored outside the uploads directory and was not deleted.' };
  }

  let freed = 0;
  try {
    if (fs.existsSync(full)) { freed = fs.statSync(full).size; fs.unlinkSync(full); }
  } catch (e) {
    // The row stays. A row with no bytes is recoverable by re-uploading; bytes
    // with no row are invisible and leak the disk this function exists to free.
    log('error', `Could not delete "${asset.filename}": ${e.message}`);
    return { ok: false, error: `Could not remove the file from disk: ${e.message}` };
  }

  if (referenced) {
    tombstoneRow.run(Date.now(), asset.id);
    log('warn', `Force-deleted "${asset.filename}" — still referenced, record kept so history can name it. Freed ${mb(freed)}`);
    return { ok: true, freed, filename: asset.filename, tombstoned: true };
  }

  deleteAssetRow.run(asset.id);
  log('info', `Deleted "${asset.filename}" from the library — freed ${mb(freed)}`);
  return { ok: true, freed, filename: asset.filename };
}

// ── Meta's two identifiers ─────────────────────────────────────────────────────
// Meta deletes uploaded media at 30 days. Refreshing at 29 means a campaign that
// starts near the boundary does not fail halfway through, and ensureMediaId can
// also be forced when a send comes back "media not found" — a clock skew or a
// deletion we did not predict then resolves itself on the next attempt instead
// of failing the whole run.
const MEDIA_ID_TTL_MS = 29 * 24 * 60 * 60 * 1000;

const readBytes = row => fs.readFileSync(assetPath(row));

// A tombstoned row reaches every send path — a template still names it, an
// inbox message still links to it. Refusing here, by name, is the difference
// between an operator reading "that file was deleted, upload it again" and
// reading an ENOENT stack trace from a readFileSync.
const deletedMsg = a =>
  `"${a.filename}" was deleted from this server on ${new Date(a.deleted_at).toLocaleDateString('en-IN')}. Upload the same file again to restore it, or pick another.`;

// Template CREATION wants an h:… handle from the Resumable Upload API, which
// keys on the APP id — not the WABA id, not the business id. It is a two-call
// protocol: open a session, then push the bytes into it. The handle is single
// use per submission, but caching it is still right: re-submitting the same
// template with the same file is the common case, and a stale handle fails at
// submit with a message Meta actually explains.
async function ensureHandle(id) {
  const asset = getAsset(id);
  if (!asset) return { ok: false, error: `Media asset ${id} not found` };
  if (asset.deleted_at) return { ok: false, error: deletedMsg(asset) };
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
  if (asset.deleted_at) return { ok: false, error: deletedMsg(asset) };

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
const setInboundFile = db.prepare(`
  UPDATE media SET path = ?, downloaded_at = ?,
                   risk = ?, risk_reason = ?, sniffed_mime = ?,
                   scan_status = ?, scan_signature = ?, scan_at = ?,
                   provisional = ?
   WHERE media_id = ?`);
const setInboundVerdict = db.prepare(
  'UPDATE media SET scan_status = ?, scan_signature = ?, scan_at = ? WHERE media_id = ?');
// provisional goes back to 0 alongside the path: a row with no bytes is not
// "provisionally saved", it is simply not saved, and leaving the flag set would
// hand the next preview a row that already looks decided.
const clearInboundFile = db.prepare('UPDATE media SET path = NULL, provisional = 0 WHERE media_id = ?');
const setKept          = db.prepare('UPDATE media SET provisional = 0 WHERE media_id = ?');

// Every row sharing these bytes is the same malware, so they are condemned
// together. Clearing only the row that happened to be requested would leave a
// sibling reporting `clean` over a file that has just been deleted.
const condemnPath = db.prepare(`
  UPDATE media SET scan_status = 'infected', scan_signature = ?, scan_at = ?, path = NULL
   WHERE path = ?`);

const getInbound = mediaId => inboundRow.get(String(mediaId));

// Saved files are named for their own sha256, so the same bytes arriving twice
// — a forwarded photo, one price list sent to two customers — are TWO rows over
// ONE file. Nothing in the schema prevents that and nothing should: the dedupe
// is the point. But it means no row owns its file, and unlinking on behalf of
// one of them would leave the others still claiming `saved`, still rendering a
// preview, and 404ing on click. Ask before deleting.
const siblingCount = db.prepare(
  'SELECT count(*) AS n FROM media WHERE path = ? AND media_id != ?');
const pathIsShared = row => !!row.path && siblingCount.get(row.path, row.media_id).n > 0;

// Same rule as assetPath: the row stores a bare filename so WA_MEDIA_DIR can
// move the whole store without rewriting a single row.
const inboundPath = row => path.join(MEDIA_DIR, row.path);

// The ONE place inbound bytes are unlinked. Three callers now want to delete a
// file — the 90-day sweep, the preview sweep, and an operator clicking Discard
// — and every one of them needs the same two guards, so they share the code
// rather than each remembering:
//
//   1. A file shared with a sibling row is never unlinked. Files are named for
//      their own sha256, so one forwarded photo is two rows over one file.
//      Unlinking for one would leave the other claiming `saved` and 404ing.
//   2. A `path` that resolves outside MEDIA_DIR is a bug or a tampered row.
//      This function deletes things, so it does not take the column on trust.
//
// Returns rather than throws: every caller has to turn the outcome into either
// a log line or a sentence for an operator.
function dropBytes(row) {
  if (!row || !row.path) return { removed: false, freed: 0, shared: false };

  const file = inboundPath(row);
  const dir  = path.resolve(MEDIA_DIR);
  const rel  = path.relative(dir, path.resolve(file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { removed: false, freed: 0, shared: false,
             error: `the path stored for ${row.media_id} resolves outside the media directory` };
  }

  // The row retires, the bytes stay. The last row out deletes the file.
  if (pathIsShared(row)) {
    clearInboundFile.run(row.media_id);
    return { removed: false, freed: 0, shared: true };
  }

  // A file that is already gone is the end state this is trying to reach, not a
  // failure — so size it first and treat a missing one as zero bytes freed.
  let freed = 0;
  try { freed = fs.statSync(file).size; } catch { /* already gone */ }
  fs.rmSync(file, { force: true });
  clearInboundFile.run(row.media_id);
  return { removed: true, freed, shared: false };
}

// Meta reports one sha256 in two encodings — base64 in the webhook envelope,
// hex from GET /{media-id} — so a comparison has to normalise before it can
// mean anything. Returns null for anything that is not 32 bytes however it was
// written, because "unrecognised" and "does not match" are different answers
// and only one of them should refuse a file.
//
// The length check is the real gate: Buffer.from(…, 'base64') is lenient and
// will happily decode nonsense into something short.
function sha256Hex(digest) {
  const s = String(digest == null ? '' : digest).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  // base64 and base64url alike; padding optional.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return b.length === 32 ? b.toString('hex') : null;
  }
  return null;
}

// Computed, never stored. Meta deletes the file 30 days after the message, so
// the deadline is a property of the message we already have the timestamp for —
// there is nothing to migrate and nothing to age out.
const inboundExpired = (row, now = Date.now()) =>
  !row.path && (now - row.message_at) > INBOUND_TTL_MS;

// statfsSync is Node 18.15+, well inside this app's 22.5 floor. The guard is
// not about tidiness: this disk also holds wa.db, and SQLite handles a full
// filesystem by refusing writes — so an unbounded media save can take the
// message store down with it, which is a far worse outcome than a refused Save.
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir));
    return st.bavail * st.bsize;
  } catch {
    // ponytail: an unreadable statfs means "no opinion", not "no space". A
    // filesystem that cannot answer should not block every save on a host
    // where the call happens to be unimplemented.
    return Infinity;
  }
}

// Two hops, both authenticated: GET /{media_id} returns a short-lived CDN url,
// and that url still 401s without the same bearer token. This is why the
// browser can never fetch customer media itself and the server has to proxy.
//
// This function is the single choke point for customer bytes entering this
// machine. Everything that has to be true before they land on disk is checked
// here, in this order, because each step costs more than the one before it:
// size cap → free-space guard → download → checksum → virus scan →
// classification → write.
// `provisional` changes exactly one thing: which clock the retention sweep runs
// against this row. Every check below — the size cap, the free-space guard, the
// checksum, the virus scan, the classification — happens either way, because a
// file an operator is only LOOKING at is still a file that arrived on this
// machine from a stranger. The flag is about storage policy, never about trust.
async function saveInbound(mediaId, { provisional = false } = {}) {
  const row = getInbound(mediaId);
  if (!row) return { ok: false, error: `No inbound media found for ${mediaId}` };
  // Already here. A Preview on a kept file must not demote it back to
  // provisional and put a 24-hour clock on something an operator kept on
  // purpose, so this returns the row as it stands rather than re-stamping it.
  if (row.path) return { ok: true, media: row, already: true };
  // Terminal, and deliberately checked before the expiry and token checks: a
  // file we have already identified as malware must not be re-fetched just
  // because someone clicked Save twice.
  if (row.scan_status === 'infected') {
    return { ok: false, scan: 'infected', signature: row.scan_signature,
      error: `This file matched a malware signature (${row.scan_signature}) and will not be downloaded again.` };
  }
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

    // Refuse on the advertised length before pulling the body. Repeated on the
    // real buffer below, because a declared size is a claim like any other.
    const claimed = Number(meta.file_size || row.file_size || 0);
    if (claimed > MEDIA_LIMITS.maxBytes) {
      return { ok: false, error: `That file is ${mb(claimed)} — over this server's ${mb(MEDIA_LIMITS.maxBytes)} limit, so it was not downloaded.` };
    }

    const free = freeBytes(MEDIA_DIR);
    if (free < MEDIA_LIMITS.minFreeBytes) {
      return { ok: false, error: `Not enough disk space — ${mb(free)} free, and this server keeps ${mb(MEDIA_LIMITS.minFreeBytes)} in reserve. Nothing was saved.` };
    }

    const dl = await fetch(meta.url, { headers: { Authorization: `Bearer ${CFG.accessToken}` } });
    if (!dl.ok) return { ok: false, error: `Download failed with HTTP ${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());

    if (buf.length > MEDIA_LIMITS.maxBytes) {
      return { ok: false, error: `That file is ${mb(buf.length)} — over this server's ${mb(MEDIA_LIMITS.maxBytes)} limit, so nothing was saved.` };
    }

    // Verify before writing, not after. A truncated CDN response otherwise
    // lands on disk as a perfectly valid-looking file that nothing downstream
    // will ever question. Prefer the webhook's own checksum — it was recorded
    // before this fetch and cannot be forged by whatever answered it.
    //
    // Both sides are normalised first because Meta states the same digest in
    // two encodings depending on which surface you asked: the webhook envelope
    // carries base64, GET /{media-id} carries hex. Comparing the preferred
    // (webhook) value against a hex digest therefore failed for EVERY row that
    // carried a checksum, which is every row — the guard was not strict, it was
    // unconditional, and it had never once been in a position to catch the
    // truncation it exists for.
    const actual   = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = sha256Hex(row.sha256) || sha256Hex(meta.sha256);

    // A digest we cannot parse is not a digest we can check against. Falling
    // through to the next source is right, but doing it silently would turn a
    // changed Meta format back into "saves stopped working" with no trail.
    if (row.sha256 && !sha256Hex(row.sha256)) {
      log('warn', `Media ${row.media_id}: could not read the webhook sha256 as hex or base64 — falling back to the Graph value`);
    }
    if (expected && expected !== actual) {
      return { ok: false, error: 'Checksum mismatch — the download did not match the sha256 WhatsApp reported, so nothing was saved.' };
    }

    // Scanned in memory, before a single byte reaches the filesystem. Writing
    // first and unlinking on a hit would leave a window in which malware is on
    // disk, and on a host running its own on-access scanner that window is
    // enough to become an incident.
    const scan = await scanBuffer(buf);
    if (scan.status === 'infected') {
      setInboundVerdict.run('infected', scan.signature, Date.now(), row.media_id);
      log('warn', `Refused inbound media ${row.media_id} — ClamAV matched ${scan.signature}`);
      return { ok: false, scan: 'infected', signature: scan.signature,
        error: `This file matched a malware signature (${scan.signature}) and was not saved.` };
    }
    // Fail closed, and only here. An operator who configured a scanner and
    // whose daemon is down gets a refusal; one who never configured a scanner
    // gets 'skipped' and a working app.
    if (scan.status === 'error') {
      setInboundVerdict.run('error', scan.signature, Date.now(), row.media_id);
      return { ok: false, scan: 'error',
        error: `The virus scanner is configured but did not answer, so nothing was saved: ${scan.signature}` };
    }

    const verdict = classify({ mime: row.mime_type, filename: row.filename, bytes: buf });

    // extOf, not path.extname: the filename is a customer-supplied string and
    // this is the only one of them that reaches a filesystem path. Anything
    // outside [a-z0-9] is dropped rather than escaped.
    const name = `${actual}${extOf(row.filename)}`;
    fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
    // 0600, because customer media on a shared host has no business being
    // readable by every other account on it.
    fs.writeFileSync(path.join(MEDIA_DIR, name), buf, { mode: 0o600 });
    setInboundFile.run(name, Date.now(), verdict.tier, verdict.reason, verdict.sniffed,
      scan.status, scan.signature, Date.now(), provisional ? 1 : 0, row.media_id);

    log('info', `${provisional ? 'Fetched' : 'Saved'} inbound ${row.mime_type || 'file'} from message ${row.wamid}`
              + ` — risk ${verdict.tier}, scan ${scan.status}${provisional ? ', not kept' : ''}`);
    return { ok: true, media: getInbound(mediaId), risk: verdict.tier, provisional: !!provisional };
  } catch (e) {
    return { ok: false, error: `Could not reach graph.facebook.com: ${e.message}` };
  }
}

// The two halves of the decision a preview exists to enable.
function keepInbound(mediaId) {
  const row = getInbound(mediaId);
  if (!row) return { ok: false, error: `No inbound media found for ${mediaId}` };
  if (!row.path) {
    return { ok: false, error: 'There is nothing on this server to keep — preview or save it first.' };
  }
  setKept.run(row.media_id);
  log('info', `Kept inbound media ${row.media_id} — it now falls under the ${MEDIA_LIMITS.retentionDays}-day retention window`);
  return { ok: true, media: getInbound(mediaId) };
}

// Deliberately refuses a kept file. Discard is the other half of Preview — it
// undoes a fetch nobody committed to — and an operator who has already said
// "keep this" should not lose it to the same button in a thread they are
// scrolling quickly.
//
// ponytail: no "delete a kept file" path at all. Nobody has asked for one, and
// the 90-day sweep already removes them. Add a route with its own confirmation
// if a real deployment needs it.
function discardInbound(mediaId) {
  const row = getInbound(mediaId);
  if (!row) return { ok: false, error: `No inbound media found for ${mediaId}` };
  if (!row.path) return { ok: true, media: row, already: true };
  if (!row.provisional) {
    return { ok: false, error: 'This file was kept on purpose, so Discard will not remove it. It goes automatically at the end of its retention window.' };
  }

  const r = dropBytes(row);
  if (r.error) {
    log('warn', `Refused to discard media ${row.media_id}: ${r.error}`);
    return { ok: false, error: 'This file could not be removed — the server logged why. Nothing was deleted.' };
  }
  log('info', `Discarded inbound media ${row.media_id}${r.shared ? ' (bytes kept — another message shares them)' : ''}`);
  return { ok: true, media: getInbound(mediaId) };
}

// A file saved before ClamAV was installed is marked `skipped` forever, which
// would make "install the scanner later" useless for everything already on
// disk. One branch on the serve path closes that: scan it the first time
// somebody actually asks for it.
//
// ponytail: no periodic rescan of already-clean rows against updated signature
// databases. That is a cron job, and it earns its place the day this app starts
// accepting files from people it has no relationship with.
async function rescanIfNeeded(row) {
  if (!row || !row.path || row.scan_status !== 'skipped' || !scannerConfigured()) return row;

  const file = inboundPath(row);
  if (!fs.existsSync(file)) return row;

  const scan = await scanBuffer(fs.readFileSync(file));
  // Leave the row `skipped` on both no-op outcomes. Persisting an `error` here
  // would be worse than doing nothing: a daemon that was restarting for one
  // request would mark the file permanently unscannable, and the retry this
  // whole function exists to provide would never fire again.
  if (scan.status === 'skipped' || scan.status === 'error') return row;

  if (scan.status === 'infected') {
    // Condemn first, unlink second. If the process dies between them the rows
    // point at a file that still exists — recoverable. The other order leaves
    // rows vouching for bytes that are already gone.
    const shared = pathIsShared(row);
    condemnPath.run(scan.signature, Date.now(), row.path);
    fs.rmSync(file, { force: true });
    log('warn', `Removed already-saved media ${row.media_id} — a later scan matched ${scan.signature}`
      + (shared ? ' (and every other message carrying the same bytes)' : ''));
    return getInbound(row.media_id);
  }

  setInboundVerdict.run(scan.status, scan.signature, Date.now(), row.media_id);
  return getInbound(row.media_id);
}

module.exports = {
  MEDIA_KINDS, MEDIA_ID_TTL_MS, kindFor, saveUpload, listAssets, getAsset, assetPath, deleteAsset,
  ensureHandle, ensureMediaId, headerComponent,
  INBOUND_TTL_MS, getInbound, inboundPath, inboundExpired, saveInbound, rescanIfNeeded,
  pathIsShared, clearInboundFile, dropBytes, keepInbound, discardInbound, sha256Hex,
};

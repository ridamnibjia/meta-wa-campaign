'use strict';
// What is on this disk, what it costs, and the only safe ways to make it
// smaller. Everything destructive here delegates to the two functions that
// already own an unlink — deleteAsset for our uploads, dropBytes (via
// sweepMedia / discardInbound) for customer bytes — because those two hold the
// containment and sibling guards, and a third copy would be a third thing to
// get wrong.
//
// The asymmetry between the two stores is deliberate and is the whole shape of
// this module:
//
//   uploads (media_assets)  — ours. Deletable when nothing references them,
//                             renameable, never swept on a timer.
//   inbound (media)         — the customer's. A PREVIEWED file can be
//                             discarded because nothing ever committed to it.
//                             A KEPT file cannot be deleted here at all: the
//                             UI promised a retention window, and a promise
//                             that an operator can cancel early on a whim is
//                             not a retention window. It goes when the sweep
//                             says, and the only lever is running that sweep.
const fs   = require('fs');
const path = require('path');
const { FILES, MEDIA_DIR, UPLOAD_DIR, MEDIA_LIMITS } = require('../config');
const { db }  = require('../lib/db');
const { log } = require('../state');
const { getAsset, deleteAsset, assetPath, discardInbound, inboundPath } = require('./media');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── What the disk is made of ───────────────────────────────────────────────────
// statfs, not a walk of the tree: the answer has to include everything on the
// volume, including the things this app did not put there. An operator reading
// "uploads: 44 MB" with no idea the disk is 20 GB cannot tell whether that is a
// problem, which is the actual question this page exists to answer.
function volume(dir) {
  try {
    const st = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir));
    // bsize * blocks is the whole filesystem; bavail is what a non-root process
    // may actually use, which is the honest "free" for this server.
    return { total: st.bsize * st.blocks, free: st.bsize * st.bavail };
  } catch {
    // ponytail: a filesystem that cannot answer gets nulls and the UI says
    // "unavailable". Guessing a size would be worse than admitting it.
    return { total: null, free: null };
  }
}

function fileBytes(...files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f).size; } catch { /* not there yet */ }
  }
  return total;
}

const assetTotals = db.prepare(
  'SELECT count(*) AS files, coalesce(sum(file_size), 0) AS bytes FROM media_assets');
const inboundTotals = db.prepare(`
  SELECT sum(CASE WHEN provisional = 0 THEN 1 ELSE 0 END)           AS keptFiles,
         coalesce(sum(CASE WHEN provisional = 0 THEN file_size ELSE 0 END), 0) AS keptBytes,
         sum(CASE WHEN provisional = 1 THEN 1 ELSE 0 END)           AS previewFiles,
         coalesce(sum(CASE WHEN provisional = 1 THEN file_size ELSE 0 END), 0) AS previewBytes
    FROM media WHERE path IS NOT NULL`);
const dueForSweep = db.prepare(`
  SELECT count(*) AS files, coalesce(sum(file_size), 0) AS bytes
    FROM media
   WHERE path IS NOT NULL AND downloaded_at IS NOT NULL
     AND ((provisional = 0 AND downloaded_at < ?) OR (provisional = 1 AND downloaded_at < ?))`);

function overview({ now = Date.now() } = {}) {
  const vol = volume(MEDIA_DIR);
  const a   = assetTotals.get();
  const i   = inboundTotals.get();
  const due = dueForSweep.get(
    now - MEDIA_LIMITS.retentionDays * DAY_MS,
    now - MEDIA_LIMITS.previewHours * 60 * 60 * 1000);

  // file_size is what Meta declared, which is close but not identical to what
  // the bytes weigh on disk. The breakdown is honest about which is which
  // rather than presenting a sum of two different measurements as one number.
  const dbBytes = fileBytes(FILES.db, `${FILES.db}-wal`, `${FILES.db}-shm`);
  const ours    = dbBytes + i.keptBytes + i.previewBytes + a.bytes;

  return {
    at: now,
    volume: {
      total: vol.total,
      free:  vol.free,
      // Everything on the volume that is not this app. Usually the OS and node
      // itself, and worth showing so "20 GB total, 4 GB ours, 15 GB free" adds
      // up on screen instead of looking like a rounding error.
      used:  vol.total === null ? null : vol.total - vol.free,
      other: vol.total === null ? null : Math.max(0, vol.total - vol.free - ours),
      minFree: MEDIA_LIMITS.minFreeBytes,
      belowFloor: vol.free !== null && vol.free < MEDIA_LIMITS.minFreeBytes,
    },
    ours,
    breakdown: {
      database: { label: 'Database (with WAL)', bytes: dbBytes, files: 1, deletable: false },
      uploads:  { label: 'Files you uploaded',  bytes: a.bytes, files: a.files || 0, deletable: true },
      kept:     { label: 'Customer files you saved', bytes: i.keptBytes, files: i.keptFiles || 0, deletable: false },
      previews: { label: 'Customer files previewed only', bytes: i.previewBytes, files: i.previewFiles || 0, deletable: true },
    },
    retention: {
      days:  MEDIA_LIMITS.retentionDays,
      hours: MEDIA_LIMITS.previewHours,
      due:   { files: due.files || 0, bytes: due.bytes || 0 },
    },
  };
}

// ── Listing ────────────────────────────────────────────────────────────────────
// Both stores answer the same shape, so one table renders them and one delete
// path drives them. `kind` is the discriminator, and it is also what decides
// whether a row may be removed at all.
const assetRows = db.prepare(`
  SELECT id, filename, mime_type, file_size, kind, uploaded_at, last_used_at, path
    FROM media_assets ORDER BY uploaded_at DESC, id DESC`);

// Referenced-by counts come back with the row rather than being asked per file
// from the UI: a library of 200 files would otherwise be 200 round trips, and
// the answer decides whether the checkbox is even offered.
const assetRefCounts = db.prepare(`
  SELECT a.id,
         (SELECT count(*) FROM templates     t WHERE t.header_asset = a.id) AS templates,
         (SELECT count(*) FROM campaign_runs r WHERE r.header_asset = a.id) AS runs,
         (SELECT count(*) FROM messages      m WHERE m.asset_id     = a.id) AS messages
    FROM media_assets a`);

const inboundRows = db.prepare(`
  SELECT md.media_id, md.wamid, md.mime_type, md.filename, md.file_size,
         md.downloaded_at, md.provisional, md.risk, md.path,
         m.wa_id, m.at AS message_at, t.name
    FROM media md
    JOIN messages m ON m.wamid = md.wamid
    LEFT JOIN threads t ON t.wa_id = m.wa_id
   WHERE md.path IS NOT NULL
   ORDER BY md.downloaded_at DESC`);

function listStored({ now = Date.now() } = {}) {
  const refs = new Map(assetRefCounts.all().map(r => [r.id, r]));

  const uploads = assetRows.all().map(r => {
    const ref = refs.get(r.id) || { templates: 0, runs: 0, messages: 0 };
    const used = ref.templates + ref.runs + ref.messages;
    return {
      store: 'upload', id: String(r.id),
      filename: r.filename, mime: r.mime_type, size: r.file_size, kind: r.kind,
      at: r.uploaded_at, lastUsedAt: r.last_used_at,
      onDisk: fs.existsSync(assetPath(r)),
      deletable: used === 0,
      renameable: true,
      // The reason travels with the row so the UI never has to compose one, and
      // so a disabled checkbox can always say why it is disabled.
      why: used === 0 ? null
        : `Used by ${[
            ref.templates && `${ref.templates} template${ref.templates === 1 ? '' : 's'}`,
            ref.runs      && `${ref.runs} campaign${ref.runs === 1 ? '' : 's'}`,
            ref.messages  && `${ref.messages} sent message${ref.messages === 1 ? '' : 's'}`,
          ].filter(Boolean).join(', ')}`,
    };
  });

  const inbound = inboundRows.all().map(r => {
    const kept = !r.provisional;
    // Only meaningful for a kept file; a preview is on the hours clock and its
    // expiry is not something an operator plans around.
    const expiresAt = kept && r.downloaded_at
      ? r.downloaded_at + MEDIA_LIMITS.retentionDays * DAY_MS : null;
    return {
      store: 'inbound', id: r.media_id,
      filename: r.filename || `${(r.mime_type || 'file').split('/')[0]} from +${r.wa_id}`,
      mime: r.mime_type, size: r.file_size, kind: (r.mime_type || '').split('/')[0],
      at: r.downloaded_at, messageAt: r.message_at,
      from: r.name || r.wa_id, waId: r.wa_id,
      kept, risk: r.risk, expiresAt,
      onDisk: fs.existsSync(inboundPath(r)),
      // A kept customer file is not deletable from here on purpose. The UI
      // promised a retention window; letting it be cancelled early on a whim
      // would make that promise meaningless. Previews were never committed to.
      deletable: !kept,
      renameable: false,   // it is the customer's name for their own file
      why: kept
        ? `Saved on purpose — removed automatically ${expiresAt ? `on ${new Date(expiresAt).toLocaleDateString('en-IN')}` : `after ${MEDIA_LIMITS.retentionDays} days`}`
        : null,
    };
  });

  return { uploads, inbound, at: now };
}

// ── Renaming ───────────────────────────────────────────────────────────────────
// Uploads only, and the display name only. sha256, path and bytes are untouched,
// so dedupe still works and every campaign that already reported sending this
// asset still reported the truth. Renaming a customer's file is not offered at
// all: that name is part of what they sent.
const renameRow = db.prepare('UPDATE media_assets SET filename = ? WHERE id = ?');

function renameAsset(id, filename) {
  const asset = getAsset(id);
  if (!asset) return { ok: false, error: 'That file is not in the library.' };

  const name = String(filename || '').trim();
  if (!name) return { ok: false, error: 'Give the file a name.' };
  if (name.length > 200) return { ok: false, error: 'That name is too long — keep it under 200 characters.' };
  // This string is sent to Meta as a document filename and shown to the
  // recipient. Path separators and control characters have no business in it,
  // and stripping them here means the send path never has to think about it.
  if (/[\\/\u0000-\u001f]/.test(name)) {
    return { ok: false, error: 'A file name cannot contain slashes or control characters.' };
  }

  renameRow.run(name, asset.id);
  log('info', `Renamed asset ${asset.id}: "${asset.filename}" → "${name}"`);
  return { ok: true, asset: getAsset(asset.id) };
}

// ── Bulk removal ───────────────────────────────────────────────────────────────
// Every item still goes through its own per-file guards. A selection is a
// convenience for the operator, never a way around a refusal — so this reports
// per-item outcomes rather than failing the whole batch on the first problem.
function removeMany(items) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'Nothing was selected.' };
  }
  if (items.length > 500) {
    return { ok: false, error: 'Select fewer than 500 files at a time.' };
  }

  const results = [];
  let freed = 0, removed = 0;

  for (const item of items) {
    const store = item && item.store;
    const id    = item && item.id;

    if (store === 'upload') {
      const r = deleteAsset(id);
      if (r.ok) { removed++; freed += r.freed || 0; }
      results.push({ store, id, ok: r.ok, error: r.error || null, freed: r.freed || 0 });
    } else if (store === 'inbound') {
      // discardInbound refuses a kept file outright, which is exactly the
      // behaviour wanted here — the check does not need repeating, and
      // repeating it is how the two would drift apart.
      const r = discardInbound(String(id));
      if (r.ok && !r.already) removed++;
      results.push({ store, id, ok: r.ok, error: r.error || null, freed: 0 });
    } else {
      results.push({ store: store || null, id: id ?? null, ok: false, error: 'Unknown store.' });
    }
  }

  const failed = results.filter(r => !r.ok);
  log('info', `Storage: removed ${removed} of ${items.length} selected file(s)${failed.length ? `, ${failed.length} refused` : ''}`);
  return { ok: true, removed, failed: failed.length, freed, results };
}

module.exports = { overview, listStored, renameAsset, removeMany, volume };

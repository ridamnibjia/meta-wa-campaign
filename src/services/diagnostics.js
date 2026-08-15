'use strict';
// State the system already has and currently hides.
//
// Every number here was previously visible only in a log line, in a 500-entry
// ring buffer that /api/start wipes, or not at all. None of it is new
// information — it is the difference between an operator who can answer "is
// this thing working?" and one who has to guess.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FILES, MEDIA_DIR, UPLOAD_DIR, MEDIA_LIMITS, CFG, CLAMAV } = require('../config');
const { db } = require('../lib/db');
const { S, todayKey } = require('../state');
const { W, WARMUP_PLAN, warmupStep, warmupCap, effectiveCap, graduated, dailyCount } = require('./warmup');
const { scannerConfigured } = require('../lib/clamav');

const one = sql => db.prepare(sql);

// ── Can this machine actually run the scanner it was told to use? ──────────────
// clamd mmaps the whole signature database, about 1.2 GB, and freshclam briefly
// holds TWO copies while it swaps a new one in. Add node and one 100 MB media
// buffer and a scanning deployment wants ~2 GB before the OS gets a page of
// cache — so on a 2 GB box the reload is what kills something, at 3am, days
// after the deploy looked fine.
//
// It is a warning and not a refusal on purpose: which process the kernel picks
// is not ours to decide, and an operator who has tuned clamd's own limits down
// may genuinely be fine. But the failure it produces — clamd gone, therefore
// "configured but broken", therefore every media save refused — reads as an app
// bug rather than as an out-of-memory kill, so it is worth saying up front.
// Two numbers, deliberately different: the floor below which this warns, and
// what to actually buy. Recommending the floor would put the machine one
// signature update away from the same warning.
const CLAMD_WANTS_BYTES   = 3 * 1024 * 1024 * 1024;
const CLAMD_COMFORT_BYTES = 4 * 1024 * 1024 * 1024;
const gb = b => `${(b / 1024 ** 3).toFixed(1)} GB`;

function memoryWarning(totalBytes = os.totalmem()) {
  if (!scannerConfigured() || totalBytes >= CLAMD_WANTS_BYTES) return null;
  return `CLAMAV_ADDRESS is set but this machine has ${gb(totalBytes)} of RAM. `
       + `clamd holds its signature database in memory (~1.2 GB) and freshclam briefly `
       + `holds two copies while it swaps a new one in, so the kernel may kill clamd or `
       + `this app during an update — and a clamd that is configured but unreachable `
       + `refuses every media save by design. Either give the VM ${gb(CLAMD_COMFORT_BYTES)}, `
       + `or unset CLAMAV_ADDRESS and rely on the file-risk tiers, which need no daemon.`;
}

const webhookStats = one(`
  SELECT count(*)                                                  AS total,
         sum(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END)     AS unprocessed,
         max(received_at)                                          AS last_received,
         max(CASE WHEN processed_at IS NOT NULL THEN received_at END) AS last_processed
    FROM webhook_events
`);

// A sample rather than the whole list: an operator needs to see WHAT is stuck,
// and the body of one stuck envelope tells them more than a count of 400.
const stuckSample = one(`
  SELECT id, received_at, substr(body, 1, 400) AS preview
    FROM webhook_events WHERE processed_at IS NULL ORDER BY id LIMIT 5
`);

const rowCounts = {
  messages:       one('SELECT count(*) AS n FROM messages'),
  threads:        one('SELECT count(*) AS n FROM threads'),
  contacts:       one('SELECT count(*) AS n FROM contacts'),
  media:          one('SELECT count(*) AS n FROM media'),
  media_assets:   one('SELECT count(*) AS n FROM media_assets'),
  templates:      one('SELECT count(*) AS n FROM templates'),
  campaign_runs:  one('SELECT count(*) AS n FROM campaign_runs'),
  run_recipients: one('SELECT count(*) AS n FROM run_recipients'),
  webhook_events: one('SELECT count(*) AS n FROM webhook_events'),
};

// Saved inbound media that is still on disk, and what the next sweep will take.
const mediaOnDisk = one(
  'SELECT count(*) AS n, sum(file_size) AS bytes FROM media WHERE path IS NOT NULL');
const mediaDueForSweep = one(`
  SELECT count(*) AS n, sum(file_size) AS bytes
    FROM media WHERE path IS NOT NULL AND downloaded_at IS NOT NULL AND downloaded_at < ?
`);

// The WAL and shared-memory files are part of what the database costs on disk,
// and the -wal one in particular can dwarf the .db between checkpoints. Reporting
// only the .db would understate it, sometimes badly.
function fileBytes(...files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f).size; } catch { /* not there is zero, not an error */ }
  }
  return total;
}

function dirBytes(dir) {
  let total = 0, count = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, name)).size; count++; } catch { /* raced */ }
    }
  } catch { /* directory does not exist until something is saved into it */ }
  return { bytes: total, files: count };
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir));
    return st.bavail * st.bsize;
  } catch { return null; }
}

function snapshot({ now = Date.now() } = {}) {
  const w = webhookStats.get();
  const disk  = mediaOnDisk.get();
  const due   = mediaDueForSweep.get(now - MEDIA_LIMITS.retentionDays * 24 * 60 * 60 * 1000);
  const free  = freeBytes(MEDIA_DIR);

  return {
    at: now,
    uptimeSec: Math.round(process.uptime()),
    node: process.versions.node,
    // RSS is the number that matters on a 2 GB VM sharing a box with clamd.
    memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),

    webhooks: {
      total:         w.total || 0,
      unprocessed:   w.unprocessed || 0,
      lastReceived:  w.last_received || null,
      lastProcessed: w.last_processed || null,
      // Nothing has arrived for a long time is a real signal: the tunnel is
      // down, the subscription was dropped, or the token was rotated. It is
      // NOT proof of a fault — a quiet Sunday looks identical — so it is
      // reported as an age and left for a human to read.
      silentForMs:   w.last_received ? now - w.last_received : null,
      stuck: stuckSample.all().map(r => ({
        id: r.id, receivedAt: r.received_at, preview: r.preview,
      })),
    },

    account: {
      // Read from the last /api/account-info call rather than fetched here: this
      // endpoint must not depend on Meta being reachable to render.
      quality:       S.quality || null,
      phoneNumberId: !!CFG.phoneNumberId,
      accessToken:   !!CFG.accessToken,
      appSecret:     !!CFG.appSecret,
      appId:         !!CFG.appId,
      verifyToken:   !!CFG.webhookVerifyToken,
      appPassword:   !!CFG.appPassword,
    },

    warmup: {
      enabled:   W.enabled,
      plan:      WARMUP_PLAN,
      step:      warmupStep(),
      cap:       warmupCap(),
      effective: effectiveCap(),
      daysSent:  W.days.length,
      sentToday: W.days.includes(todayKey()),
      today:     todayKey(),
      graduated: graduated(),
      dailyCount: dailyCount(),
    },

    scanner: {
      configured: scannerConfigured(),
      address:    CLAMAV.address ? 'set' : null,   // never the path itself
      timeoutMs:  CLAMAV.timeoutMs,
      // Total RAM, and the sentence to act on if there is not enough of it for
      // the scanner this deployment asked for. Null when the machine is fine or
      // no scanner is configured.
      totalMemBytes: os.totalmem(),
      memoryWarning: memoryWarning(),
    },

    storage: {
      dbBytes:     fileBytes(FILES.db, `${FILES.db}-wal`, `${FILES.db}-shm`),
      mediaDir:    dirBytes(MEDIA_DIR),
      uploadDir:   dirBytes(UPLOAD_DIR),
      freeBytes:   free,
      // The floor that refuses a save. Surfaced because the failure it causes
      // reads like a bug — "nothing was saved" with plenty of disk left — and
      // an operator who can see both numbers can tell it apart in one glance.
      minFreeBytes: MEDIA_LIMITS.minFreeBytes,
      belowFloor:   free !== null && free < MEDIA_LIMITS.minFreeBytes,
      retentionDays: MEDIA_LIMITS.retentionDays,
      savedMedia:  { files: disk.n || 0, bytes: disk.bytes || 0 },
      dueForSweep: { files: due.n || 0, bytes: due.bytes || 0 },
    },

    rows: Object.fromEntries(Object.entries(rowCounts).map(([k, q]) => [k, q.get().n])),
  };
}

module.exports = { snapshot, memoryWarning, CLAMD_WANTS_BYTES, CLAMD_COMFORT_BYTES };

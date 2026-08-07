'use strict';
// Two clocks run over inbound media and only one of them is ours.
//
//   Meta's:  it deletes the file 30 days after the message. Computed from
//            messages.at in services/media.js, never stored.
//   Ours:    a saved copy is unlinked 90 days after WE downloaded it.
//
// This file is the second one. It exists because the UI promises a retention
// window, and a promise nothing enforces is a lie — which is why it shipped in
// the same change as the notice that makes it.
const fs = require('fs');
const path = require('path');
const { MEDIA_DIR, MEDIA_LIMITS } = require('../config');
const { db }  = require('../lib/db');
const { log } = require('../state');
const { inboundPath } = require('./media');

const DAY_MS = 24 * 60 * 60 * 1000;

const expiredRows = db.prepare(
  'SELECT media_id, path FROM media WHERE path IS NOT NULL AND downloaded_at IS NOT NULL AND downloaded_at < ?');
const clearPath = db.prepare('UPDATE media SET path = NULL WHERE media_id = ?');

// The row stores a bare filename, but this function deletes things, so it does
// not take that on trust: a `path` that resolves outside MEDIA_DIR is a bug or
// a tampered row, and either way the answer is to skip it loudly rather than
// unlink whatever it points at.
const insideMediaDir = file => {
  const dir = path.resolve(MEDIA_DIR);
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// The row survives; only the bytes go. Message history is not media, and a
// thread read a year later should still say "they sent a photo" even though the
// photo is gone. Clearing `path` is also what makes the bubble revert to a Save
// button — which, past Meta's own 30 days, honestly reports that its copy is
// gone too.
function sweepMedia({ now = Date.now() } = {}) {
  const cutoff = now - MEDIA_LIMITS.retentionDays * DAY_MS;
  const rows = expiredRows.all(cutoff);
  let swept = 0, freed = 0, errors = 0;

  for (const row of rows) {
    const file = inboundPath(row);
    if (!insideMediaDir(file)) {
      errors++;
      log('warn', `Refused to sweep media ${row.media_id}: its path resolves outside the media directory`);
      continue;
    }
    try {
      // A file that is already gone is the end state this function is trying to
      // reach, not a failure — so size it first and treat a missing one as zero
      // bytes freed rather than an error.
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* already gone */ }
      fs.rmSync(file, { force: true });
      clearPath.run(row.media_id);
      swept++; freed += size;
    } catch (e) {
      errors++;
      log('warn', `Could not remove expired media ${row.media_id}: ${e.message}`);
    }
  }

  if (swept) {
    log('info', `Retention sweep removed ${swept} file(s), ${(freed / (1024 * 1024)).toFixed(1)} MB — inbound media is kept ${MEDIA_LIMITS.retentionDays} days`);
  }
  return { swept, freed, errors };
}

// Once at boot, so a box that was off for a week catches up, and daily after.
// unref() so the timer never holds the process open — a sweep is housekeeping,
// not work worth delaying a shutdown for.
//
// ponytail: setInterval, not a cron dependency. The requirement is "about once
// a day", and a restart resetting the clock costs nothing.
function startRetention() {
  sweepMedia();
  const t = setInterval(() => sweepMedia(), DAY_MS);
  t.unref();
  return t;
}

module.exports = { sweepMedia, startRetention, DAY_MS };

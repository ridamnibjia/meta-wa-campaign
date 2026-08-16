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
// A third clock joined them: a file fetched for a PREVIEW and never kept goes
// in hours, not days. Same sweep, same deletion rules, different cutoff — the
// alternative was a second timer that could drift out of step with this one.
const { MEDIA_LIMITS } = require('../config');
const { db }  = require('../lib/db');
const { log } = require('../state');
const { dropBytes } = require('./media');

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// provisional = 0: a file an operator committed to. The 90-day clock.
const expiredRows = db.prepare(`
  SELECT media_id, path FROM media
   WHERE path IS NOT NULL AND downloaded_at IS NOT NULL
     AND downloaded_at < ? AND provisional = 0`);

// provisional = 1: fetched to be looked at, never kept. The hours clock.
const stalePreviews = db.prepare(`
  SELECT media_id, path FROM media
   WHERE path IS NOT NULL AND downloaded_at IS NOT NULL
     AND downloaded_at < ? AND provisional = 1`);

// The row survives; only the bytes go. Message history is not media, and a
// thread read a year later should still say "they sent a photo" even though the
// photo is gone. Clearing `path` is also what makes the bubble revert to a Save
// button — which, past Meta's own 30 days, honestly reports that its copy is
// gone too.
function sweepMedia({ now = Date.now() } = {}) {
  const kept     = expiredRows.all(now - MEDIA_LIMITS.retentionDays * DAY_MS);
  const previews = stalePreviews.all(now - MEDIA_LIMITS.previewHours * HOUR_MS);
  let swept = 0, freed = 0, errors = 0;

  for (const row of [...kept, ...previews]) {
    try {
      // dropBytes owns both guards — the sibling check and the directory check
      // — because Discard needs exactly the same two and a second copy of them
      // is a second thing to get wrong.
      const r = dropBytes(row);
      if (r.error) {
        errors++;
        log('warn', `Refused to sweep media ${row.media_id}: ${r.error}`);
        continue;
      }
      swept++; freed += r.freed;
    } catch (e) {
      errors++;
      log('warn', `Could not remove expired media ${row.media_id}: ${e.message}`);
    }
  }

  if (kept.length) {
    log('info', `Retention sweep removed ${kept.length} file(s) — inbound media is kept ${MEDIA_LIMITS.retentionDays} days`);
  }
  // Logged apart, because these were never kept and the number is a measure of
  // browsing rather than of storage policy.
  if (previews.length) {
    log('info', `Retention sweep removed ${previews.length} previewed file(s) nobody kept — previews last ${MEDIA_LIMITS.previewHours}h`);
  }
  if (swept) log('info', `Freed ${(freed / (1024 * 1024)).toFixed(1)} MB`);

  return { swept, freed, errors, previews: previews.length };
}

// ── Raw webhook envelopes ──────────────────────────────────────────────────────
// The one store in this app that had no lifetime at all. Every envelope Meta
// delivers is written before the 200 OK — that is the durability boundary, and
// it is not optional — but once processed the row is an audit trail, not state:
// everything it means is already in `messages`, `threads` and `media`.
//
// `processed_at IS NOT NULL` is the whole guard, and it is load-bearing. An
// UNPROCESSED row is the replay queue (services/ingest.js:replayUnprocessed) —
// an envelope this app stored but could not interpret, kept precisely because it
// is the only copy of something a parser bug ate. Meta's API is push-only, so
// deleting one is deleting it for good. Those are never swept, however old.
//
// 90 days matches the inbound-media window, so there is one number to remember.
const WEBHOOK_RETENTION_DAYS = 90;

const oldEnvelopes = db.prepare(`
  DELETE FROM webhook_events
   WHERE processed_at IS NOT NULL AND received_at < ?`);

function sweepWebhookEvents({ now = Date.now() } = {}) {
  const removed = oldEnvelopes.run(now - WEBHOOK_RETENTION_DAYS * DAY_MS).changes;
  if (removed) {
    log('info', `Retention sweep removed ${removed} processed webhook envelope(s) — raw envelopes are kept ${WEBHOOK_RETENTION_DAYS} days. Unprocessed ones are never removed.`);
  }
  return { removed };
}

// Once at boot, so a box that was off for a week catches up, and daily after.
// unref() so the timer never holds the process open — a sweep is housekeeping,
// not work worth delaying a shutdown for.
//
// ponytail: setInterval, not a cron dependency. The requirement is "about once
// a day", and a restart resetting the clock costs nothing.
function startRetention() {
  const sweep = () => { sweepMedia(); sweepWebhookEvents(); };
  sweep();
  const t = setInterval(sweep, DAY_MS);
  t.unref();
  return t;
}

module.exports = { sweepMedia, sweepWebhookEvents, startRetention, DAY_MS, WEBHOOK_RETENTION_DAYS };

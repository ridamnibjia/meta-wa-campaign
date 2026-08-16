#!/bin/sh
# Nightly application-level backup.
#
# The disk snapshot schedule already covers losing the machine. This covers the
# thing a snapshot cannot: a database that is intact but WRONG — a bad migration,
# a delete nobody meant, a corruption faithfully snapshotted every night for
# fourteen nights. It also makes a restore a file copy rather than a new disk, a
# new VM and a new public IP.
#
# Run by wa-backup.timer. Safe to run by hand at any time, including mid-send.
set -eu

APP=${WA_APP_DIR:-/home/earlyearnly/app}
DEST=${WA_BACKUP_DIR:-/home/earlyearnly/backups}
KEEP=${WA_BACKUP_KEEP:-7}
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
WORK="$DEST/.partial-$$-$STAMP"

mkdir -p "$WORK"

# `mv a b` where b is an existing DIRECTORY moves a INSIDE b rather than over it,
# so a second run in the same second silently produced a backup nested in the
# previous one — both of them then wrong, and neither of them saying so. The
# nightly timer cannot hit this; a human running the script twice while checking
# it works hits it immediately, which is exactly when a backup must not lie.
# `mv -T` would do, but it is GNU-only and this script also gets run on a Mac.
if [ -e "$DEST/$STAMP" ]; then
  rmdir "$WORK" 2>/dev/null || true
  echo "backup for $STAMP already exists — nothing to do" >&2
  exit 0
fi

# ── The database ───────────────────────────────────────────────────────────────
# See scripts/vacuum-into.js for why this is not `cp wa.db`. It verifies the
# copy before returning, so a non-zero exit here means no backup directory is
# published below — a half-written one must never be mistaken for last night's.
node "$(dirname "$0")/vacuum-into.js" "$APP/wa.db" "$WORK/wa.db"

# ── The small files that are not in the database ───────────────────────────────
# warmup.json is the one a restore most often forgets, and losing it puts a
# number that has been sending for months back on rung one at 20 a day. The app
# reconciles it from the message rows at boot, which is the safety net — this is
# the belt.
#
# uploads/ is media_assets on disk: template headers and inbox sends. It is never
# swept, and a row pointing at bytes that are gone is a send that fails at Meta.
# media/ is deliberately NOT here — inbound customer files expire at 90 days by
# design, and restoring them past their own retention would undo that promise.
for f in warmup.json campaign.json; do
  [ -f "$APP/$f" ] && cp -p "$APP/$f" "$WORK/$f"
done
[ -d "$APP/uploads" ] && tar -czf "$WORK/uploads.tar.gz" -C "$APP" uploads

# Renamed into place only once everything above succeeded, so a backup that died
# half way through is never mistaken for a complete one — the leftover is called
# .partial- and the retention below sweeps it.
mv "$WORK" "$DEST/$STAMP"

# ── Retention ──────────────────────────────────────────────────────────────────
# Newest KEEP, by name — the stamp sorts lexicographically because it is ISO.
cd "$DEST"
ls -1d 20*Z 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -rf -- "$old"
done
# Leftovers from a run that died between mkdir and mv. Swept on age rather than
# on count: there is no "keep the newest N" reading of a failed backup.
find "$DEST" -maxdepth 1 -name '.partial-*' -type d -mmin +720 -exec rm -rf {} + 2>/dev/null || true

echo "backup complete: $DEST/$STAMP ($(du -sh "$DEST/$STAMP" | cut -f1)), keeping $KEEP"

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
DAYS=${WA_BACKUP_DAYS:-7}
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
# uploads/ and media/ are deliberately NOT here, for two different reasons.
# uploads/ is media_assets on disk — template headers and inbox sends — and it is
# tens of megabytes that barely change, so tarring it nightly wrote the same
# 48 MB seven times over for a copy the daily DISK SNAPSHOT already holds. This
# backup exists for the failure a snapshot cannot fix: a database that is intact
# but wrong. Restoring uploads means restoring from the snapshot, and README says
# so. media/ is inbound customer files, which expire at 90 days by design —
# restoring them past their own retention would undo that promise.
for f in warmup.json campaign.json; do
  [ -f "$APP/$f" ] && cp -p "$APP/$f" "$WORK/$f"
done

# Renamed into place only once everything above succeeded, so a backup that died
# half way through is never mistaken for a complete one — the leftover is called
# .partial- and the retention below sweeps it.
mv "$WORK" "$DEST/$STAMP"

# ── Retention ──────────────────────────────────────────────────────────────────
# Age, not count. Counting only ever swept the directories THIS script had made,
# so hand-made pre-deploy copies — a 6 MB wa-predeploy-*.db, an .env with live
# tokens in it — sat in here indefinitely, outliving both the deploy they were
# taken for and any reason to keep a credential lying about. Everything in this
# directory is a backup, and a backup older than a week is not the one anybody
# restores from.
#
# Safe to run unguarded only because it runs AFTER the new backup is published:
# `set -e` means a failed VACUUM never reaches this line, so the sweep can never
# be the thing that leaves the directory empty. The 12-hour rule for .partial-*
# stays separate — a half-written backup is not worth a week.
find "$DEST" -mindepth 1 -maxdepth 1 -mtime "+$DAYS" -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -mindepth 1 -maxdepth 1 -name '.partial-*' -type d -mmin +720 -exec rm -rf {} + 2>/dev/null || true

echo "backup complete: $DEST/$STAMP ($(du -sh "$DEST/$STAMP" | cut -f1)), keeping $DAYS days"

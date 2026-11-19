#!/bin/sh
# encrypted, off-box daily backup of one set (Metal, make.design), run as root by dusk-backup@<set>.timer with
# /etc/dusk-backup/<set>.env (mode 0600, see backup.env.example). every destination gets the same archive.
#   DUSK_BACKUP_NAME         set name: the archive prefix and the folder under each destination (default dusk-account)
#   DUSK_BACKUP_PATHS        space-separated folders or files to include; DUSK_DASHBOARD_DATA is added when set
#   DUSK_BACKUP_EXCLUDE      space-separated rsync patterns left out (full paths like /var/lib/x/cache/, or *.tmp)
#   DUSK_BACKUP_MONGO_CONFIG a mongodump --config file (uri only, mode 0600): a fresh dump goes in. mongodump only reads.
#   DUSK_BACKUP_MONGO_DIR    or: the newest finished dump (file or folder) in this folder goes in
#   DUSK_BACKUP_RECIPIENT    age public key (age1...); only its private half, kept off this box, can open a backup
#   DUSK_BACKUP_DEST         space-separated rclone destinations, e.g. "oracle-backup:/data r2-backup:dusk-backups"
#   DUSK_BACKUP_KEEP_DAYS    dailies kept at each destination (default 7)
#   DUSK_BACKUP_KEEP_WEEKS   sunday copies kept (default 4), so nothing is older than about 28 days
#   DUSK_BACKUP_KEEP_RUNS    for a set that runs several times a day (default 0, off): every run lands in runs/ and
#                            the newest this many stay; daily/ and weekly/ then take only the first run of each day
# layout: <dest>/<name>/daily/<name>-<utc time>.tar.gz.age, <dest>/<name>/weekly/... and <dest>/<name>/runs/...
# restore: rclone copy <dest>/<name>/daily/<file> . && age -d -i backup-age.key <file> | tar -xz -C <empty folder>
#          files/ holds the paths as they were; mongo/<name>.archive.gz goes back with
#          mongorestore --gzip --archive=<file> (into a stopped service's database, --drop to replace)
set -eu

NAME="${DUSK_BACKUP_NAME:-dusk-account}"
RECIPIENT="${DUSK_BACKUP_RECIPIENT:?set DUSK_BACKUP_RECIPIENT}"
DEST="${DUSK_BACKUP_DEST:?set DUSK_BACKUP_DEST}"
KEEP_DAYS="${DUSK_BACKUP_KEEP_DAYS:-7}"
KEEP_WEEKS="${DUSK_BACKUP_KEEP_WEEKS:-4}"
KEEP_RUNS="${DUSK_BACKUP_KEEP_RUNS:-0}"
PATHS="${DUSK_BACKUP_PATHS:-} ${DUSK_DASHBOARD_DATA:-}"
case "$NAME" in ''|*[!a-z0-9-]*) echo "DUSK_BACKUP_NAME must be lowercase letters, digits and dashes" >&2; exit 2 ;; esac
case "$RECIPIENT" in age1*) ;; *) echo "DUSK_BACKUP_RECIPIENT must be an age public key" >&2; exit 2 ;; esac
for n in "$KEEP_DAYS" "$KEEP_WEEKS" "$KEEP_RUNS"; do case "$n" in ''|*[!0-9]*) echo "DUSK_BACKUP_KEEP_DAYS, _WEEKS and _RUNS must be numbers" >&2; exit 2 ;; esac; done
[ "$KEEP_DAYS" -ge 1 ] || { echo "DUSK_BACKUP_KEEP_DAYS must be at least 1" >&2; exit 2; }

# one run per set at a time
exec 9>"/run/lock/dusk-backup-$NAME.lock"
flock -n 9 || { echo "another $NAME backup is running" >&2; exit 1; }

started=$(date +%s)
umask 077
work=$(mktemp -d /var/tmp/dusk-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
day="${stamp%%T*}"
file="$NAME-$stamp.tar.gz.age"
parts=""

# the services write each file by rename, so a copy holds whole files and keeps tar from reading a moving tree
set -f
excludes=""
for pattern in ${DUSK_BACKUP_EXCLUDE:-}; do excludes="$excludes --exclude=$pattern"; done
for path in $PATHS; do
  [ -e "$path" ] || { echo "missing $path" >&2; exit 1; }
  mkdir -p "$work/files"
  # 24: a file vanished between listing and copying, which a rename-writing service does; anything else fails the run
  # shellcheck disable=SC2086
  rsync -a --relative $excludes "$path" "$work/files/" || [ $? -eq 24 ]
  parts="files"
done
set +f

if [ -n "${DUSK_BACKUP_MONGO_CONFIG:-}" ]; then
  mkdir "$work/mongo"
  mongodump --quiet --config "$DUSK_BACKUP_MONGO_CONFIG" --gzip --archive="$work/mongo/$NAME.archive.gz"
  parts="$parts mongo"
elif [ -n "${DUSK_BACKUP_MONGO_DIR:-}" ]; then
  [ -d "$DUSK_BACKUP_MONGO_DIR" ] || { echo "no mongodump folder at $DUSK_BACKUP_MONGO_DIR" >&2; exit 1; }
  # a dump younger than 30 minutes may still be being written
  dump=$(find "$DUSK_BACKUP_MONGO_DIR" -mindepth 1 -maxdepth 1 -mmin +30 ! -name '*.tmp' -exec ls -1dt {} + | head -n 1)
  [ -n "$dump" ] || { echo "no finished mongodump in $DUSK_BACKUP_MONGO_DIR" >&2; exit 1; }
  mkdir "$work/mongo"
  cp -a "$dump" "$work/mongo/"
  parts="$parts mongo"
fi
[ -n "$parts" ] || { echo "nothing to back up: set DUSK_BACKUP_PATHS or a mongo source" >&2; exit 2; }

# shellcheck disable=SC2086
tar -C "$work" -czf - $parts | age -r "$RECIPIENT" -o "$work/$file"
[ -s "$work/$file" ] || { echo "empty backup" >&2; exit 1; }
size=$(wc -c < "$work/$file" | tr -d ' ')

# deletes this set's archives older than $2 days in $1; rclone fails on a folder that does not exist yet
prune() {
  old=$(rclone lsf "$1" --files-only --min-age "${2}d" --include "$NAME-*.tar.gz.age" 2>/dev/null) || return 0
  [ -z "$old" ] || rclone delete "$1" --min-age "${2}d" --include "$NAME-*.tar.gz.age"
}

# keeps the newest $2 of this set's archives in $1
prune_count() {
  old=$(rclone lsf "$1" --files-only --include "$NAME-*.tar.gz.age" 2>/dev/null | sort -r | tail -n +"$(($2 + 1))") || return 0
  for f in $old; do rclone deletefile "$1/$f" || return 1; done
}

# with runs/ on, daily/ and weekly/ take one archive per utc day; true when $1 has none from today yet
first_today() {
  [ "$KEEP_RUNS" = 0 ] && return 0
  [ -z "$(rclone lsf "$1" --files-only --include "$NAME-${day}T*.tar.gz.age" 2>/dev/null)" ]
}

failed=0
sunday=$([ "$(date -u +%u)" = 7 ] && [ "$KEEP_WEEKS" -gt 0 ] && echo 1 || echo 0)
for dest in $DEST; do
  base="${dest%/}/$NAME"
  daily=0; weekly=0
  first_today "$base/daily" && daily=1
  [ "$sunday" = 1 ] && first_today "$base/weekly" && weekly=1
  # a failed upload never prunes, so a destination keeps its old backups until a new one lands
  if { [ "$KEEP_RUNS" = 0 ] || rclone copyto "$work/$file" "$base/runs/$file"; } &&
     { [ "$daily" = 0 ] || rclone copyto "$work/$file" "$base/daily/$file"; } &&
     { [ "$weekly" = 0 ] || rclone copyto "$work/$file" "$base/weekly/$file"; }; then
    [ "$KEEP_RUNS" = 0 ] || prune_count "$base/runs" "$KEEP_RUNS" || failed=1
    prune "$base/daily" "$KEEP_DAYS" || failed=1
    prune "$base/weekly" "$((KEEP_WEEKS * 7))" || failed=1
    echo "uploaded $file to $base ($size bytes$([ "$KEEP_RUNS" != 0 ] && echo ', run')$([ "$daily" = 1 ] && echo ', daily')$([ "$weekly" = 1 ] && echo ', weekly'))"
  else
    echo "upload to $base failed" >&2
    failed=1
  fi
done
echo "$NAME backup: $file, $size bytes, $(($(date +%s) - started))s"
exit "$failed"

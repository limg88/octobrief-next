#!/usr/bin/env bash
# The commands of an installation. Instructions: docs/runbook.md.
#   deploy/octobrief.sh up | down | ps | logs [service] | backup [dir] | restore <dir> | compose <args…>
# Environment: OCTOBRIEF_ENV_FILE (default deploy/.env), OCTOBRIEF_PROJECT (default octobrief),
# OCTOBRIEF_EXTRA_COMPOSE (one more compose file, used by the demo).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

env_file="${OCTOBRIEF_ENV_FILE:-$here/.env}"
project="${OCTOBRIEF_PROJECT:-octobrief}"
[ -f "$env_file" ] || { echo "Missing env file $env_file: run deploy/init-env.sh" >&2; exit 1; }

dc() {
  local files=(-f "$here/compose.yml")
  [ -z "${OCTOBRIEF_EXTRA_COMPOSE:-}" ] || files+=(-f "$OCTOBRIEF_EXTRA_COMPOSE")
  docker compose -p "$project" --env-file "$env_file" "${files[@]}" "$@"
}

DB_DUMP=database.dump
BLOBS_ARCHIVE=blobs.tar.gz
CHECKSUMS=SHA256SUMS

checksum() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# backup [dir]: a consistent dump of the database and the archive of the uploaded files.
backup() {
  local target="${1:-$here/backups/$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$target"
  chmod 700 "$target"
  dc exec -T postgres pg_dump -U octobrief_owner -d octobrief --format=custom >"$target/$DB_DUMP"
  dc exec -T worker tar -C /data/blobs -czf - . >"$target/$BLOBS_ARCHIVE"
  (cd "$target" && checksum "$DB_DUMP" "$BLOBS_ARCHIVE" >"$CHECKSUMS")
  echo "Backup in $target"
}

# restore <dir>: replaces database and files with those of a backup. Web and worker stop meanwhile.
restore() {
  local source="${1:?usage: octobrief.sh restore <backup dir>}"
  [ -f "$source/$DB_DUMP" ] && [ -f "$source/$BLOBS_ARCHIVE" ] || { echo "Not a backup: $source" >&2; exit 1; }
  (cd "$source" && checksum -c "$CHECKSUMS" >/dev/null) || { echo "Checksums do not match in $source" >&2; exit 1; }
  dc stop web worker caddy >/dev/null 2>&1
  dc exec -T postgres pg_restore -U octobrief_owner -d postgres --clean --if-exists --create --exit-on-error <"$source/$DB_DUMP"
  dc run --rm --no-deps -T worker sh -c 'find /data/blobs -mindepth 1 -delete && tar -C /data/blobs -xzf -' <"$source/$BLOBS_ARCHIVE" 2>/dev/null
  dc up -d --wait >/dev/null 2>&1
  echo "Restored from $source"
}

command="${1:-}"
[ $# -eq 0 ] || shift
case "$command" in
  up) dc up -d --build --wait "$@" ;;
  down) dc down "$@" ;;
  ps) dc ps "$@" ;;
  logs) dc logs --tail "${TAIL:-200}" "$@" ;;
  backup) backup "$@" ;;
  restore) restore "$@" ;;
  compose) dc "$@" ;;
  *) echo "usage: octobrief.sh up | down | ps | logs [service] | backup [dir] | restore <dir> | compose <args…>" >&2; exit 2 ;;
esac

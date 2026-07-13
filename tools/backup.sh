#!/bin/sh
set -eu
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
case "$BACKUP_RETENTION_DAYS" in *[!0-9]*|'') echo 'BACKUP_RETENTION_DAYS must be an integer' >&2; exit 2;; esac
[ "$BACKUP_RETENTION_DAYS" -ge 1 ] || { echo 'BACKUP_RETENTION_DAYS must be positive' >&2; exit 2; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
output="$BACKUP_DIR/kcevagent-$timestamp.dump.tar.enc"
trap 'rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$work/database.dump"
pg_restore --list "$work/database.dump" >/dev/null
(cd "$work" && sha256sum database.dump > SHA256SUMS)
schema_version="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command="select coalesce(max(version),'none') from public.kcev_schema_migrations" 2>/dev/null || printf unknown)"
printf '{"formatVersion":1,"createdAt":"%s","schemaVersion":"%s","databaseFormat":"postgres-custom","encrypted":true}\n' "$timestamp" "$schema_version" > "$work/manifest.json"
tar -C "$work" -cf "$work/backup.tar" database.dump SHA256SUMS manifest.json
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_PASSWORD -in "$work/backup.tar" -out "$work/encrypted.tmp"
sha256sum "$work/encrypted.tmp" | sed "s#  .*#  $(basename "$output")#" > "$work/output.sha256"
mv "$work/encrypted.tmp" "$output"
mv "$work/output.sha256" "$output.sha256"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kcevagent-*.dump.tar.enc*' -mtime "+$BACKUP_RETENTION_DAYS" -delete
printf 'backup_created path=%s checksum=%s\n' "$output" "$(cut -d ' ' -f 1 "$output.sha256")"


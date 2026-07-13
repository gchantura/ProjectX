#!/bin/sh
set -eu
umask 077

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
[ "${ALLOW_DESTRUCTIVE_RESTORE:-}" = 'verify-isolated-database' ] || { echo 'Refusing restore without ALLOW_DESTRUCTIVE_RESTORE=verify-isolated-database' >&2; exit 2; }
[ -f "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE.sha256" ] || { echo 'Backup and checksum sidecar are required' >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256")
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_PASSWORD -in "$BACKUP_FILE" -out "$work/backup.tar"
tar -C "$work" -xf "$work/backup.tar"
(cd "$work" && sha256sum -c SHA256SUMS)
pg_restore --list "$work/database.dump" >/dev/null

attempt=0
until pg_isready -d "$RESTORE_DATABASE_URL" >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || { echo 'Isolated restore database did not become ready' >&2; exit 1; }; sleep 2
done
pg_restore --dbname="$RESTORE_DATABASE_URL" --exit-on-error --no-owner --no-acl "$work/database.dump"
psql "$RESTORE_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 --command="select count(*) as applied_migrations from public.kcev_schema_migrations; select count(*) as tenants from public.agent_tenants;" >/dev/null
printf 'restore_verified backup=%s manifest=%s\n' "$BACKUP_FILE" "$(tr -d '\n' < "$work/manifest.json")"


#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

plan="$(mktemp)"
trap 'rm -f "$plan"' EXIT

cat > "$plan" <<'SQL'
\set ON_ERROR_STOP on
create table if not exists public.kcev_schema_migrations (
  version text primary key,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
);
SQL

for migration in /migrations/sql/*.sql; do
  version="$(basename "$migration" .sql)"
  checksum="$(sha256sum "$migration" | cut -d ' ' -f 1)"
  cat >> "$plan" <<SQL
begin;
select pg_advisory_xact_lock(hashtext('kcevagent:schema-migrations'));
select count(*) as migration_exists from public.kcev_schema_migrations where version = '$version' \gset
\if :migration_exists
  select case when checksum_sha256 = '$checksum' then true else false end as checksum_matches from public.kcev_schema_migrations where version = '$version' \gset
  \if :checksum_matches
    \echo 'Already applied: $version'
  \else
    \error 'Checksum mismatch for applied migration $version'
  \endif
\else
  \echo 'Applying: $version'
  \i $migration
  insert into public.kcev_schema_migrations(version, checksum_sha256) values ('$version', '$checksum');
\endif
commit;
SQL
done

psql "$DATABASE_URL" --no-psqlrc --file "$plan"

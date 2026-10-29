#!/usr/bin/env bash
# Local backup of the rent database (NFR backup, docs/plans/M1.md section 4.19).
#
#   pnpm db:backup                    writes backups/<UTC timestamp>.dump
#   bash scripts/db-backup.sh FILE    writes FILE instead
#
# A pg_dump custom-format archive, taken through the Compose postgres container as the
# superuser: the tables force row level security, so only a role that bypasses it can read
# every company's rows. Production relies on RDS backups (docs/runbooks/backup-restore.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose --file "$root/docker-compose.yml" "$@"; }

out="${1:-$root/backups/$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$out")"
partial="$out.partial"
trap 'rm -f "$partial"' EXIT

compose exec -T postgres pg_dump --username=postgres --dbname=rent --format=custom >"$partial"
# A dump that pg_restore cannot list is not a backup.
compose exec -T postgres pg_restore --list >/dev/null <"$partial"
mv "$partial" "$out"

echo "Backed up rent to $out ($(wc -c <"$out" | tr -d ' ') bytes)"

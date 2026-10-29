#!/usr/bin/env bash
# Restores a dump from scripts/db-backup.sh into a new database (NFR backup).
#
#   pnpm db:restore backups/20261028T120000Z.dump                 restores into rent_restore
#   bash scripts/db-restore.sh backups/20261028T120000Z.dump NAME  restores into NAME
#
# The target must not exist yet and is never the live rent database. Like rent, it is owned by
# rent_owner with CONNECT granted to rent_app, so the apps can be pointed at it. Roles are
# cluster-wide and not in the dump: on a fresh server, run packages/db/sql/bootstrap.sql first.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <dump-file> [target-database]" >&2
  exit 2
fi
dump="$1"
target="${2:-rent_restore}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose --file "$root/docker-compose.yml" "$@"; }
psql_as_postgres() {
  compose exec -T postgres psql --username=postgres --dbname=postgres --no-psqlrc --quiet \
    --set=ON_ERROR_STOP=1 --set=target="$target" "$@"
}

if [[ ! -f "$dump" ]]; then
  echo "No such dump file: $dump" >&2
  exit 1
fi
if [[ ! "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "Use a plain lower-case database name (letters, digits and underscores): $target" >&2
  exit 1
fi
case "$target" in
  rent | postgres | template0 | template1)
    echo "Refusing to restore into '$target'. Restore into a new database instead." >&2
    exit 1
    ;;
esac

exists="$(psql_as_postgres --tuples-only --no-align <<'SQL'
SELECT count(*) FROM pg_database WHERE datname = :'target';
SQL
)"
if [[ "$exists" != "0" ]]; then
  echo "Database '$target' already exists. If you no longer need it, drop it first:" >&2
  echo "  docker compose exec -T postgres dropdb --username=postgres --force $target" >&2
  exit 1
fi

psql_as_postgres <<'SQL'
CREATE DATABASE :"target" OWNER rent_owner;
REVOKE ALL ON DATABASE :"target" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"target" TO rent_app;
SQL

# One transaction: a failed restore leaves an empty database, never a partial one.
compose exec -T postgres pg_restore --username=postgres --dbname="$target" \
  --single-transaction --exit-on-error <"$dump"

echo "Restored $dump into database $target"

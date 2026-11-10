#!/usr/bin/env bash
# NFR-BACKUP restore drill (M11 decision 10; docs/runbooks/backup-restore.md): dump a database,
# restore the dump into a fresh one, compare every table's row count between the two, then run
# every nightly integrity check against the restored copy (books balance; receivables,
# prepayments and deposits against their sub-ledgers; agent cash; fees; the platform book; every
# audit chain and anchor). Prints each step's time. Always drops the copy and the dump.
#
#   bash scripts/drill-restore.sh SOURCE_DB [--json FILE]
#
# SOURCE_DB is a scratch or CI database on the Compose server, never `rent`. Needs Compose's
# postgres running and the source migrated (and seeded, for a meaningful drill).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose --file "$root/docker-compose.yml" "$@"; }

source_db="${1:-}"
json_out=""
if [[ "${2:-}" == "--json" ]]; then json_out="${3:?--json needs a file}"; fi
if [[ ! "$source_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "usage: $0 SOURCE_DB [--json FILE]   (a plain lower-case database name)" >&2
  exit 2
fi
case "$source_db" in
  rent | postgres | template0 | template1)
    echo "Refusing to drill on '$source_db': use a scratch or CI copy, never rent." >&2
    exit 2
    ;;
esac

target="drill_restore_$$"
workdir="$(mktemp -d)"
dump="$workdir/source.dump"
psql_on() {
  local db="$1"
  shift
  compose exec -T postgres psql --username=postgres --dbname="$db" --no-psqlrc --quiet \
    --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' "$@"
}
cleanup() {
  compose exec -T --env PGOPTIONS='-c client_min_messages=warning' postgres \
    dropdb --username=postgres --if-exists --force "$target" >/dev/null 2>&1 ||
    echo "Could not drop the drill copy $target" >&2
  rm -rf "$workdir"
}
trap cleanup EXIT

exists="$(psql_on postgres -c "select count(*) from pg_database where datname = '$source_db'")"
if [[ "$exists" != "1" ]]; then
  echo "No database '$source_db' on the Compose server." >&2
  exit 1
fi

now_ms() { node -e 'console.log(Date.now())'; }
t0=$(now_ms)

# 1. Dump, as the superuser (forced row level security hides other companies from anyone else),
# and check pg_restore can read it, as scripts/db-backup.sh does.
compose exec -T postgres pg_dump --username=postgres --dbname="$source_db" --format=custom >"$dump"
compose exec -T postgres pg_restore --list >/dev/null <"$dump"
t1=$(now_ms)
dump_bytes=$(wc -c <"$dump" | tr -d ' ')

# 2. Restore into a fresh database, in one transaction (scripts/db-restore.sh refuses rent and
# any database that already exists).
bash "$root/scripts/db-restore.sh" "$dump" "$target" >/dev/null
t2=$(now_ms)

# 3. Row counts, table by table, as the superuser on both sides.
count_sql="select n.nspname || '.' || c.relname,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
order by 1"
psql_on "$source_db" -c "$count_sql" >"$workdir/source.counts"
psql_on "$target" -c "$count_sql" >"$workdir/target.counts"
t3=$(now_ms)
tables=$(wc -l <"$workdir/source.counts" | tr -d ' ')
rows=$(awk -F'|' '{s += $2} END {print s + 0}' "$workdir/source.counts")
if ! diff -u "$workdir/source.counts" "$workdir/target.counts" >"$workdir/counts.diff"; then
  echo "Row counts differ between $source_db and its restored copy:" >&2
  cat "$workdir/counts.diff" >&2
  exit 1
fi
echo "ok      row counts: $tables tables, $rows rows, identical in the copy"

# 4. Every nightly check against the copy, through the services the worker's jobs use, as the
# application role (forced row level security on, company by company).
env_url() { grep "^$1=" "$root/.env" | cut -d= -f2- | sed -E "s#/[a-z0-9_]+\$#/$target#"; }
checks_json="$workdir/checks.json"
set +e
(
  cd "$root/packages/server" &&
    DATABASE_URL="$(env_url DATABASE_URL)" DATABASE_OWNER_URL="$(env_url DATABASE_OWNER_URL)" \
      node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env \
      scripts/drill-checks.ts --json "$checks_json"
)
checks_status=$?
set -e
t4=$(now_ms)

seconds() { node -e "console.log(((${2} - ${1}) / 1000).toFixed(1))"; }
echo
echo "Restore drill on $source_db (copy $target):"
echo "  dump              $(seconds "$t0" "$t1") s  ($dump_bytes bytes)"
echo "  restore           $(seconds "$t1" "$t2") s"
echo "  row counts        $(seconds "$t2" "$t3") s  ($tables tables, $rows rows)"
echo "  nightly checks    $(seconds "$t3" "$t4") s"
echo "  total             $(seconds "$t0" "$t4") s"

if [[ -n "$json_out" ]]; then
  SOURCE_DB="$source_db" DUMP_BYTES="$dump_bytes" TABLES="$tables" ROWS="$rows" \
    CHECKS_STATUS="$checks_status" node -e '
      const fs = require("node:fs");
      const [out, checks, ...t] = process.argv.slice(1).map((v, i) => (i < 2 ? v : Number(v)));
      const e = process.env;
      const summary = fs.existsSync(checks) ? JSON.parse(fs.readFileSync(checks, "utf8")) : null;
      if (summary) delete summary.results;
      const result = {
        drill: "restore", source: e.SOURCE_DB, at: new Date().toISOString(),
        dumpBytes: Number(e.DUMP_BYTES), tables: Number(e.TABLES), rows: Number(e.ROWS),
        ms: { dump: t[1] - t[0], restore: t[2] - t[1], rowCounts: t[3] - t[2], checks: t[4] - t[3], total: t[4] - t[0] },
        checks: summary, passed: e.CHECKS_STATUS === "0",
      };
      fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    ' "$json_out" "$checks_json" "$t0" "$t1" "$t2" "$t3" "$t4"
fi

if [[ "$checks_status" -ne 0 ]]; then
  echo "Restore drill failed: a nightly check failed on the restored copy." >&2
  exit 1
fi
echo "Restore drill passed."

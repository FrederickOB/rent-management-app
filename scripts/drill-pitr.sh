#!/usr/bin/env bash
# NFR-BACKUP point-in-time recovery drill (M11 decision 10; docs/runbooks/backup-restore.md).
# In a throwaway PostgreSQL container (the Compose image, its own port and volume, never the
# Compose database), with WAL archiving on:
#   1. load a copy of SOURCE_DB (a pg_dump from the Compose server) as rent_drill;
#   2. take a base backup (pg_basebackup);
#   3. make changes A (a company created through app.create_company, so audited, with its book,
#      and a marker row), note the time, then make changes B the same way;
#   4. stop the server, and recover the base backup plus the WAL archive to that time in a second
#      container;
#   5. assert A is present and B absent, then run every nightly integrity check on the recovered
#      database (scripts/drill-restore.sh runs the same ones).
# Prints each step's time. Always removes both containers and the volume.
#
#   bash scripts/drill-pitr.sh SOURCE_DB [--json FILE]
#
# SOURCE_DB is a scratch or CI database on the Compose server, never `rent`. PITR_PORT sets the
# throwaway server's port (default 54391).
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

# The same major version as Compose: its postgres image, exactly.
image="$(awk '/^  postgres:/{p=1} p && /image:/{print $2; exit}' "$root/docker-compose.yml")"
[[ "$image" == postgres:* ]] || { echo "Could not read the postgres image from docker-compose.yml" >&2; exit 1; }
port="${PITR_PORT:-54391}"
run_id="pitr$$"
primary="rent-drill-$run_id-primary"
recovered="rent-drill-$run_id-recovered"
volume="rent-drill-$run_id"
drill_db=rent_drill
pg_home=/var/lib/postgresql
archive="$pg_home/wal-archive"
workdir="$(mktemp -d)"

cleanup() {
  docker rm -f "$primary" "$recovered" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

if command -v lsof >/dev/null && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $port is in use; set PITR_PORT to a free one." >&2
  exit 1
fi
exists="$(compose exec -T postgres psql --username=postgres --dbname=postgres --tuples-only --no-align \
  -c "select count(*) from pg_database where datname = '$source_db'")"
[[ "$exists" == "1" ]] || { echo "No database '$source_db' on the Compose server." >&2; exit 1; }

now_ms() { node -e 'console.log(Date.now())'; }
seconds() { node -e "console.log(((${2} - ${1}) / 1000).toFixed(1))"; }
sql() {
  local container="$1" db="$2"
  shift 2
  docker exec -i -u postgres "$container" psql --dbname="$db" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align "$@"
}
wait_ready() {
  # Over TCP: the image's first-start initialisation listens on the socket only.
  for _ in $(seq 1 120); do
    docker exec "$1" pg_isready --host=127.0.0.1 --username=postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$1 did not become ready" >&2
  docker logs --tail 50 "$1" >&2
  return 1
}

t0=$(now_ms)
# 1. The throwaway server, archiving every WAL segment it completes.
compose exec -T postgres pg_dump --username=postgres --dbname="$source_db" --format=custom >"$workdir/source.dump"
docker volume create "$volume" >/dev/null
docker run -d --name "$primary" -e POSTGRES_PASSWORD=drill-only -e TZ=UTC \
  -p "127.0.0.1:$port:5432" -v "$volume:$pg_home" "$image" \
  -c wal_level=replica -c archive_mode=on \
  -c "archive_command=test ! -f $archive/%f && cp %p $archive/%f" >/dev/null
wait_ready "$primary"
docker exec -u postgres "$primary" mkdir -p "$archive"
# The roles from bootstrap.sql, without its database (the drill's database is rent_drill).
sed '/CREATE DATABASE rent/,$d' "$root/packages/db/sql/bootstrap.sql" | sql "$primary" postgres >/dev/null
sql "$primary" postgres -c "CREATE DATABASE $drill_db OWNER rent_owner" \
  -c "REVOKE ALL ON DATABASE $drill_db FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE $drill_db TO rent_app" >/dev/null
docker exec -i -u postgres "$primary" pg_restore --dbname="$drill_db" --single-transaction --exit-on-error \
  <"$workdir/source.dump"
t1=$(now_ms)

# 2. The base backup, WAL included so it is consistent on its own.
docker exec -u postgres "$primary" pg_basebackup --pgdata="$pg_home/pitr-base" --wal-method=stream \
  --checkpoint=fast --no-password
t2=$(now_ms)

# 3. Changes A, the recovery target, then changes B. Each change is a company created the way the
# platform creates one (audited, with its book), plus a marker row.
change() {
  sql "$primary" "$drill_db" <<SQL >/dev/null
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS drill_pitr_marker (label text PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp());
BEGIN;
SELECT set_config('app.actor_kind', 'system', true), set_config('app.company_id', '', true);
SELECT app.create_company(null, 'landlord', 'PITR drill $1', 'PITR drill $1', 'GH', 'Africa/Accra', 'PITR drill $1', '{}'::jsonb);
INSERT INTO drill_pitr_marker (label) VALUES ('$1');
COMMIT;
SQL
}
companies_before="$(sql "$primary" "$drill_db" -c 'select count(*) from company')"
change A
sleep 1
target_time="$(sql "$primary" "$drill_db" -c "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 1
change B
companies_after_b="$(sql "$primary" "$drill_db" -c 'select count(*) from company')"
# Close the WAL segment that holds A, the target and B, and wait until it is archived.
segment="$(sql "$primary" postgres -c 'select pg_walfile_name(pg_switch_wal())')"
for _ in $(seq 1 60); do
  archived="$(sql "$primary" postgres -c "select coalesce(last_archived_wal, '') from pg_stat_archiver")"
  [[ -n "$archived" && ! "$archived" < "$segment" ]] && break
  sleep 1
done
[[ -n "$archived" && ! "$archived" < "$segment" ]] || { echo "WAL segment $segment was not archived" >&2; exit 1; }
t3=$(now_ms)

# 4. The primary is lost; recover the base backup and the archive to the target time.
docker stop "$primary" >/dev/null
docker rm "$primary" >/dev/null
docker run --rm -u postgres -v "$volume:$pg_home" --entrypoint bash "$image" -c "
  set -e
  cp -a $pg_home/pitr-base $pg_home/pitr-recovered
  cat >>$pg_home/pitr-recovered/postgresql.auto.conf <<CONF
restore_command = 'cp $archive/%f %p'
recovery_target_time = '$target_time'
recovery_target_action = 'promote'
CONF
  touch $pg_home/pitr-recovered/recovery.signal"
t4=$(now_ms)
docker run -d --name "$recovered" -e POSTGRES_PASSWORD=drill-only -e TZ=UTC \
  -e PGDATA="$pg_home/pitr-recovered" -p "127.0.0.1:$port:5432" -v "$volume:$pg_home" "$image" \
  -c archive_mode=off >/dev/null
wait_ready "$recovered"
for _ in $(seq 1 120); do
  [[ "$(sql "$recovered" postgres -c 'select pg_is_in_recovery()' 2>/dev/null)" == "f" ]] && break
  sleep 1
done
[[ "$(sql "$recovered" postgres -c 'select pg_is_in_recovery()')" == "f" ]] ||
  { echo "The recovered server did not finish recovery" >&2; docker logs --tail 50 "$recovered" >&2; exit 1; }
t5=$(now_ms)

# 5. A is there, B is not.
markers="$(sql "$recovered" "$drill_db" -c "select string_agg(label, ',' order by label) from drill_pitr_marker")"
company_a="$(sql "$recovered" "$drill_db" -c "select count(*) from company where legal_name = 'PITR drill A'")"
company_b="$(sql "$recovered" "$drill_db" -c "select count(*) from company where legal_name = 'PITR drill B'")"
companies_recovered="$(sql "$recovered" "$drill_db" -c 'select count(*) from company')"
if [[ "$markers" != "A" || "$company_a" != "1" || "$company_b" != "0" ]]; then
  echo "Point-in-time recovery is wrong: markers '$markers', company A $company_a, company B $company_b" >&2
  exit 1
fi
echo "ok      recovered to $target_time: changes A present, changes B absent (companies $companies_before before A, $companies_after_b after B, $companies_recovered recovered)"

# Every nightly check on the recovered database, as the application role.
env_url() { grep "^$1=" "$root/.env" | cut -d= -f2- | sed -E "s#@[^/@]+/[a-z0-9_]+\$#@127.0.0.1:$port/$drill_db#"; }
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
t6=$(now_ms)

echo
echo "Point-in-time drill on $source_db ($image, port $port):"
echo "  load the copy     $(seconds "$t0" "$t1") s"
echo "  base backup       $(seconds "$t1" "$t2") s"
echo "  changes A and B   $(seconds "$t2" "$t3") s  (target $target_time; WAL archived to $segment)"
echo "  prepare recovery  $(seconds "$t3" "$t4") s"
echo "  recover to target $(seconds "$t4" "$t5") s  (start to promoted)"
echo "  nightly checks    $(seconds "$t5" "$t6") s"
echo "  total             $(seconds "$t0" "$t6") s"

if [[ -n "$json_out" ]]; then
  SOURCE_DB="$source_db" IMAGE="$image" TARGET="$target_time" CHECKS_STATUS="$checks_status" node -e '
    const fs = require("node:fs");
    const [out, checks, ...t] = process.argv.slice(1).map((v, i) => (i < 2 ? v : Number(v)));
    const e = process.env;
    const summary = fs.existsSync(checks) ? JSON.parse(fs.readFileSync(checks, "utf8")) : null;
    if (summary) delete summary.results;
    fs.writeFileSync(out, JSON.stringify({
      drill: "pitr", source: e.SOURCE_DB, image: e.IMAGE, at: new Date().toISOString(), targetTime: e.TARGET,
      changesAPresent: true, changesBAbsent: true,
      ms: { load: t[1] - t[0], baseBackup: t[2] - t[1], changes: t[3] - t[2], prepare: t[4] - t[3],
            recover: t[5] - t[4], checks: t[6] - t[5], total: t[6] - t[0] },
      checks: summary, passed: e.CHECKS_STATUS === "0",
    }, null, 2) + "\n");
  ' "$json_out" "$checks_json" "$t0" "$t1" "$t2" "$t3" "$t4" "$t5" "$t6"
fi

if [[ "$checks_status" -ne 0 ]]; then
  echo "Point-in-time drill failed: a nightly check failed on the recovered database." >&2
  exit 1
fi
echo "Point-in-time drill passed."

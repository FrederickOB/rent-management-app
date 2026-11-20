#!/usr/bin/env bash
# `pnpm load:month-end`: the month-end load test (M11 decision 7; load/README.md).
#
# On a scratch database of its own (LOAD_DB, default rent_scratch_load; never rent), it starts its
# own fake provider, api, worker and links on ports clear of pnpm dev (3700-3702), the Compose fake
# (4010) and Expo (8081), builds the fixture (5,000 units, 50 staff, 5,000 tenants with invoices due
# today), runs load/month-end.js in the pinned grafana/k6 image, waits for the queues to drain, then
# measures what the run left in the database, runs every nightly check, and writes
# LOAD_OUT/result.json and LOAD_OUT/summary.md. Exits 1 when a pass criterion fails.
#
# Profile (decision 7 by default; scale down for a smoke run):
#   LOAD_UNITS=5000 LOAD_STAFF=50 LOAD_DURATION_MIN=60 LOAD_PAYMENTS=2500 LOAD_PEAK_PAYMENTS=1000
#   LOAD_PEAK_MIN=10 LOAD_TENANT_PAGES=500
# Smoke: LOAD_UNITS=400 LOAD_STAFF=10 LOAD_DURATION_MIN=3 LOAD_PAYMENTS=150 LOAD_PEAK_PAYMENTS=60 \
#        LOAD_PEAK_MIN=1 LOAD_TENANT_PAGES=40 pnpm load:month-end
# Other settings:
#   LOAD_DB                 the scratch database (rent_scratch_* or rent_load*)
#   LOAD_DATABASE_READY=1   the database is already migrated (made by another tool): do not
#                           drop, create or migrate it
#   LOAD_KEEP_DB=1          keep the database afterwards (it is dropped by default)
#   LOAD_OUT                where results go (default load/results/<UTC time>, gitignored)
#   LOAD_API_PORT=3780 LOAD_LINKS_PORT=3782 LOAD_FAKE_PORT=4180
#   K6_IMAGE=grafana/k6:2.3.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
compose() { docker compose --file "$root/docker-compose.yml" "$@"; }

db="${LOAD_DB:-rent_scratch_load}"
if [[ "$db" == "rent" || ! "$db" =~ ^(rent_scratch_|rent_load)[a-z0-9_]*$ ]]; then
  echo "LOAD_DB must be a scratch database (rent_scratch_* or rent_load*), never rent: $db" >&2
  exit 2
fi
api_port="${LOAD_API_PORT:-3780}"
links_port="${LOAD_LINKS_PORT:-3782}"
fake_port="${LOAD_FAKE_PORT:-4180}"
for port in "$api_port" "$links_port" "$fake_port"; do
  case "$port" in
    3700 | 3701 | 3702 | 4010 | 8081)
      echo "Port $port belongs to the development stack; choose another." >&2
      exit 2
      ;;
  esac
  if command -v lsof >/dev/null && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use; set LOAD_API_PORT, LOAD_LINKS_PORT or LOAD_FAKE_PORT." >&2
    exit 2
  fi
done
k6_image="${K6_IMAGE:-grafana/k6:2.3.0}"
out="${LOAD_OUT:-$root/load/results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
logs="$out/logs"
mkdir -p "$logs"
echo "load test on $db; results in $out"

# The profile, also handed to k6 and the summary.
export LOAD_UNITS="${LOAD_UNITS:-5000}" LOAD_STAFF="${LOAD_STAFF:-50}"
export LOAD_DURATION_MIN="${LOAD_DURATION_MIN:-60}" LOAD_PAYMENTS="${LOAD_PAYMENTS:-2500}"
export LOAD_PEAK_PAYMENTS="${LOAD_PEAK_PAYMENTS:-1000}" LOAD_PEAK_MIN="${LOAD_PEAK_MIN:-10}"
export LOAD_TENANT_PAGES="${LOAD_TENANT_PAGES:-500}"

# Every app on the scratch database, with the load test's own providers and ports. Node's
# --env-file never overrides what is set here, so .env supplies only the rest.
db_url() { grep "^$1=" .env | cut -d= -f2- | sed -E "s#/[a-z0-9_]+\$#/$db#"; }
[[ -f .env ]] || cp .env.example .env
export DATABASE_URL="$(db_url DATABASE_URL)" DATABASE_OWNER_URL="$(db_url DATABASE_OWNER_URL)"
case "$DATABASE_URL|$DATABASE_OWNER_URL" in
  */$db\|*/$db) ;;
  *) echo "refusing: the database URLs do not both name $db" >&2; exit 3 ;;
esac
export API_BASE_URL="http://localhost:$api_port" LINKS_ORIGIN="http://localhost:$links_port"
export FAKE_PROVIDERS_URL="http://127.0.0.1:$fake_port" FAKE_PAYMENTS_SECRET_KEY=sk_test_load_month_end
export AUTH_RATE_LIMITS=off LOG_LEVEL="${LOG_LEVEL:-warn}" NEXT_TELEMETRY_DISABLED=1

pids=()
# Stops a process and everything it started (tsx and next start children of their own).
kill_tree() {
  local pid="$1" signal="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child" "$signal"; done
  kill -"$signal" "$pid" 2>/dev/null || true
}
stop_all() {
  for pid in ${pids[@]+"${pids[@]}"}; do kill_tree "$pid" TERM; done
  sleep 1
  for pid in ${pids[@]+"${pids[@]}"}; do kill_tree "$pid" KILL; done
  pids=()
}
psql_admin() {
  compose exec -T postgres psql --username=postgres --dbname=postgres -v ON_ERROR_STOP=1 "$@"
}
cleanup() {
  stop_all
  # Whatever else this script started (a step still running when it was interrupted).
  for child in $(pgrep -P $$ 2>/dev/null); do kill_tree "$child" TERM; done
  docker rm -f "rent-load-k6-$$" >/dev/null 2>&1 || true
  if [[ "${LOAD_KEEP_DB:-0}" != "1" && "${LOAD_DATABASE_READY:-0}" != "1" ]]; then
    psql_admin -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
start() {
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec "$@") >"$logs/$name.log" 2>&1 &
  pids+=("$!")
}
wait_url() {
  for _ in $(seq 1 180); do curl -fsS -o /dev/null "$1" && return 0; sleep 1; done
  echo "$1 did not answer; see $logs" >&2
  return 1
}
tsx_server() { (cd packages/server && node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env "$@"); }
now_ms() { node -e 'console.log(Date.now())'; }

# 1. The database.
if [[ "${LOAD_DATABASE_READY:-0}" != "1" ]]; then
  psql_admin -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null
  psql_admin -c "CREATE DATABASE $db OWNER rent_owner" >/dev/null
  psql_admin -c "REVOKE ALL ON DATABASE $db FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $db TO rent_app" >/dev/null
  pnpm db:migrate >"$logs/migrate.log" 2>&1
fi
# Function statistics, for audit.append's time under load (the head-lock contention question).
psql_admin -c "ALTER DATABASE $db SET track_functions = 'pl'" >/dev/null

# 2. The load test's own fake provider, sending payment webhooks to this api.
start fake apps/fake-providers env PORT="$fake_port" HOST=0.0.0.0 NODE_ENV=development \
  FAKE_PAYMENTS_WEBHOOK_URL="http://127.0.0.1:$api_port/webhooks/paystack" \
  FAKE_WHATSAPP_WEBHOOK_URL= FAKE_IDENTITY_WEBHOOK_URL= FAKE_SMS_INBOUND_URL= FAKE_SMS_STATUS_URL= \
  FAKE_EMAIL_INBOUND_URL= FAKE_EMAIL_EVENTS_URL= node_modules/.bin/tsx src/main.ts
wait_url "http://127.0.0.1:$fake_port/health"

# 3. The worker, then the fixture (the fake must be up: settlement accounts are set up with it). The
# worker renders the fixture's invoice PDFs and works its events while it is built.
start worker apps/worker node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env src/main.ts
t_fixture=$(now_ms)
tsx_server scripts/load-fixture.ts build --out "$out/fixture.json" | tee "$logs/fixture.log"
fixture_ms=$(($(now_ms) - t_fixture))

# 4. api and links.
if [[ "${LOAD_SKIP_LINKS_BUILD:-0}" != "1" ]]; then
  (cd apps/links && LINKS_DIST_DIR=.next/load node_modules/.bin/next build) >"$logs/links-build.log" 2>&1
fi
start api apps/api node_modules/.bin/tsx --tsconfig tsconfig.runtime.json --env-file-if-exists=../../.env src/main.ts
start links apps/links env LINKS_DIST_DIR=.next/load CLIENT_IP_HEADER=x-load-client-ip \
  node_modules/.bin/next start --hostname 0.0.0.0 --port "$links_port"
wait_url "http://127.0.0.1:$api_port/health/ready"
wait_url "http://127.0.0.1:$links_port/health"
# The fixture's own events (lease events, consent records) are worked off before the run.
tsx_server scripts/load-fixture.ts drain --timeout-ms 1800000 | tee "$logs/drain-before.log"

# 5. The run, with the database sampled throughout.
tsx_server scripts/load-fixture.ts functions --out "$out/functions-before.json"
(cd packages/server && exec node_modules/.bin/tsx --tsconfig tsconfig.runtime.json \
  --env-file-if-exists=../../.env scripts/load-fixture.ts sample --out "$out/samples.jsonl") \
  >"$logs/sampler.log" 2>&1 &
sampler=$!
pids+=("$sampler")
if [[ "$(uname -s)" == "Linux" ]]; then
  network=(--network host)
  host=127.0.0.1
else
  network=()
  host=host.docker.internal
fi
run_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t_run=$(now_ms)
set +e
docker run --rm --name "rent-load-k6-$$" ${network[@]+"${network[@]}"} \
  -v "$root/load:/scripts:ro" -v "$out:/out" \
  -e API_URL="http://$host:$api_port" -e LINKS_URL="http://$host:$links_port" \
  -e FAKE_URL="http://$host:$fake_port" -e OUT=/out -e FIXTURE=/out/fixture.json \
  -e LOAD_DURATION_MIN -e LOAD_PAYMENTS -e LOAD_PEAK_PAYMENTS -e LOAD_PEAK_MIN -e LOAD_TENANT_PAGES \
  "$k6_image" run --quiet /scripts/month-end.js 2>&1 |
  # k6 prints a failed request's URL, and a pay link's URL carries its token: never kept or shown.
  sed -E 's#/(p|r)/[A-Za-z0-9_-]{43}#/\1/[token]#g' | tee "$logs/k6.log"
k6_status=${PIPESTATUS[0]}
set -e
run_ms=$(($(now_ms) - t_run))

# 6. The queues drain.
t_drain=$(now_ms)
set +e
tsx_server scripts/load-fixture.ts drain --timeout-ms 900000 | tee "$logs/drain-after.log"
drain_status=${PIPESTATUS[0]}
set -e
drain_ms=$(($(now_ms) - t_drain))
kill -TERM "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true

# 7. What the run left, and every nightly check.
tsx_server scripts/load-fixture.ts report --since "$run_started" --samples "$out/samples.jsonl" \
  --functions-before "$out/functions-before.json" --out "$out/report.json"
set +e
tsx_server scripts/drill-checks.ts --json "$out/checks.json" | tee "$logs/checks.log"
checks_status=${PIPESTATUS[0]}
set -e
stop_all
# The fixture holds session cookies and pay-link tokens: not kept with the results.
rm -f "$out/fixture.json"

node load/summarise.mjs --out "$out" --k6-status "$k6_status" --drain-status "$drain_status" \
  --drain-ms "$drain_ms" --run-ms "$run_ms" --fixture-ms "$fixture_ms" --checks-status "$checks_status" \
  --run-started "$run_started"

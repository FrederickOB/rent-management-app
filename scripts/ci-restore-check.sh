#!/usr/bin/env bash
# NFR-BACKUP restore check (docs/plans/M1.md section 4.19): dump rent, restore the dump into a
# scratch database and verify every audit chain in the copy. Fails unless at least one chain
# was checked and every chain is intact. Needs Compose running and a migrated, seeded rent.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() { docker compose --file "$root/docker-compose.yml" "$@"; }

scratch=rent_restore_check
workdir="$(mktemp -d)"

drop_scratch() {
  compose exec -T --env PGOPTIONS='-c client_min_messages=warning' postgres \
    dropdb --username=postgres --if-exists --force "$scratch"
}
cleanup() {
  drop_scratch || echo "Could not drop the scratch database $scratch" >&2
  rm -rf "$workdir"
}
trap cleanup EXIT

drop_scratch # in case an interrupted run left it behind
bash "$root/scripts/db-backup.sh" "$workdir/rent.dump"
bash "$root/scripts/db-restore.sh" "$workdir/rent.dump" "$scratch"

# As the superuser, so verify_chain reads every company's events through forced RLS. Chains are
# listed from the heads and the events as well as the companies, so none can be skipped.
results="$(compose exec -T postgres psql --username=postgres --dbname="$scratch" --no-psqlrc \
  --quiet --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' <<'SQL'
SELECT chain.company_id, v.ok, v.events, coalesce(v.first_bad_seq::text, ''), coalesce(v.problem, '')
FROM (
  SELECT id AS company_id FROM company
  UNION SELECT company_id FROM audit_chain_head
  UNION SELECT company_id FROM audit_event
) AS chain
CROSS JOIN LATERAL audit.verify_chain(chain.company_id) AS v
ORDER BY chain.company_id;
SQL
)"

checked=0
broken=0
events=0
while IFS='|' read -r company ok count bad_seq problem; do
  [[ -n "$company" ]] || continue
  checked=$((checked + 1))
  events=$((events + count))
  if [[ "$ok" == "t" ]]; then
    echo "ok      $company  $count events"
  else
    broken=$((broken + 1))
    echo "BROKEN  $company  first bad seq $bad_seq: $problem"
  fi
done <<<"$results"

if ((checked == 0)); then
  echo "Restore check failed: the restored database has no companies. Run pnpm db:seed first." >&2
  exit 1
fi
if ((broken > 0)); then
  echo "Restore check failed: $broken of $checked audit chains are broken in the restored copy." >&2
  exit 1
fi
echo "Restore check passed: $checked audit chains ($events events) verified in the restored copy."

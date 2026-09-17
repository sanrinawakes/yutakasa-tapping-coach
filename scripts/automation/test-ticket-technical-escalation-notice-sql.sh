#!/usr/bin/env bash
set -euo pipefail

container="yutakasa-technical-escalation-test-$$"
cleanup() { docker stop -t 1 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$container" \
  --env POSTGRES_PASSWORD=test --env POSTGRES_DB=yutakasa \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" psql -X -q -U postgres -d yutakasa -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

for file in scripts/support-migration-harness.sql \
  supabase-migration-support.sql \
  supabase-migration-support-automation-claim.sql \
  scripts/automation/support-automation-manual-review.sql \
  scripts/automation/ticket-technical-escalation-notice.sql \
  scripts/automation/ticket-technical-escalation-notice.sqlcheck.sql; do
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa < "$file"
done
echo 'Technical escalation notice SQL: passed'

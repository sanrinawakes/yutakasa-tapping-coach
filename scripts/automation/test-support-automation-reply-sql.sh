#!/usr/bin/env bash
set -euo pipefail

container="yutakasa-atomic-reply-test-$$"
cleanup() { docker stop -t 1 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$container" \
  --env POSTGRES_PASSWORD=test --env POSTGRES_DB=yutakasa \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker logs "$container" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up' &&
     docker exec "$container" psql -X -q -U postgres -d yutakasa -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
for file in scripts/support-migration-harness.sql supabase-migration-support.sql \
  scripts/automation/repair-release-ledger.sql \
  scripts/automation/repair-release-ledger.sqlcheck.sql \
  scripts/automation/support-automation-reply.sql \
  scripts/automation/support-automation-reply-old-schema.sqlcheck.sql \
  scripts/automation/support-automation-reply.sql \
  scripts/automation/support-automation-reply.sqlcheck.sql \
  scripts/automation/ticket-repair-bridge.sql \
  scripts/automation/ticket-repair-bridge.sqlcheck.sql \
  scripts/automation/drive-result-ledger.sql \
  scripts/automation/drive-result-ledger.sqlcheck.sql; do
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa < "$file"
done
YUTAKASA_TEST_PG_CONTAINER="$container" node scripts/automation/drive-result-ledger-concurrency.mjs

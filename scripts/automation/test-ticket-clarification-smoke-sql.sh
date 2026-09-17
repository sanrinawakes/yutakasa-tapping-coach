#!/usr/bin/env bash
set -euo pipefail

container="yutakasa-clarification-smoke-test-$$"
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
  scripts/automation/repair-release-ledger.sql \
  scripts/automation/support-automation-reply.sql \
  scripts/automation/ticket-repair-bridge.sql \
  scripts/automation/ticket-reply-draft.sql \
  scripts/automation/ticket-clarification.sql \
  scripts/automation/ticket-clarification-smoke-cleanup.sql \
  scripts/automation/ticket-clarification-smoke-cleanup.sqlcheck.sql; do
  if [[ "$file" == scripts/automation/repair-release-ledger.sql ]]; then
    docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
      -c "ALTER TABLE public.subscribers ADD COLUMN subscription_status TEXT DEFAULT 'active', ADD COLUMN first_payment_date TIMESTAMPTZ, ADD COLUMN myasp_data JSONB DEFAULT '{}'::jsonb"
  fi
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa < "$file"
done
echo 'Clarification smoke cleanup SQL: passed'

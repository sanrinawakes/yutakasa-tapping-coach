#!/usr/bin/env bash
set -euo pipefail

container="yutakasa-bridge-e2e-smoke-test-$$"
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
  scripts/automation/ticket-clarification-notice.sql \
  scripts/automation/ticket-completion.sql \
  scripts/automation/ticket-completion-notice.sql \
  scripts/automation/ticket-repair-bridge-e2e-smoke-cleanup.sql \
  scripts/automation/ticket-repair-bridge-e2e-smoke-cleanup.sqlcheck.sql; do
  if [[ "$file" == scripts/automation/repair-release-ledger.sql ]]; then
    docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
      -c "ALTER TABLE public.subscribers ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active', ADD COLUMN IF NOT EXISTS first_payment_date TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS myasp_data JSONB DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS subscription_last_event_at TIMESTAMPTZ"
  fi
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa < "$file"
done
echo 'Bridge E2E smoke cleanup SQL: passed'

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

for file in scripts/support-migration-harness.sql supabase-migration-license.sql \
  supabase-migration-support.sql \
  supabase-migration-support-automation-claim.sql \
  scripts/automation/repair-release-ledger.sql \
  scripts/automation/repair-release-ledger.sqlcheck.sql \
  scripts/automation/drive-release-binding.sql \
  scripts/automation/drive-release-binding.sqlcheck.sql \
  scripts/automation/ticket-table-grants.test-defaults.sql \
  scripts/automation/support-automation-reply.sql \
  scripts/automation/support-automation-reply-old-schema.sqlcheck.sql \
  scripts/automation/support-automation-reply.sql \
  scripts/automation/support-automation-reply.sqlcheck.sql \
  scripts/automation/ticket-repair-bridge.sql \
  scripts/automation/ticket-repair-bridge.sqlcheck.sql \
  scripts/automation/ticket-repair-handoff-reconcile.sqlcheck.sql \
  scripts/automation/support-automation-manual-review.sql \
  scripts/automation/support-automation-manual-review.sqlcheck.sql \
  scripts/automation/drive-result-ledger.sql \
  scripts/automation/drive-result-ledger.sqlcheck.sql \
  scripts/automation/drive-intake-ledger.sql \
  scripts/automation/drive-intake-ledger.sqlcheck.sql \
  scripts/automation/ticket-reply-draft.sql \
  scripts/automation/ticket-reply-draft.sqlcheck.sql \
  scripts/automation/ticket-clarification.sql \
  scripts/automation/ticket-clarification.sqlcheck.sql \
  scripts/automation/ticket-completion.sql \
  scripts/automation/ticket-completion.sqlcheck.sql \
  scripts/automation/ticket-repair-handoff-smoke-cleanup.sql \
  scripts/automation/ticket-repair-handoff-smoke-cleanup.sqlcheck.sql \
  scripts/automation/ticket-terra-issue-smoke-cleanup.sql \
  scripts/automation/ticket-terra-issue-smoke-cleanup.sqlcheck.sql \
  scripts/automation/ticket-table-grants-remediation.sql \
  scripts/automation/ticket-table-grants-remediation.sql; do
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa < "$file"
done
YUTAKASA_TEST_PG_CONTAINER="$container" node scripts/automation/drive-result-ledger-concurrency.mjs
YUTAKASA_TEST_PG_CONTAINER="$container" node scripts/automation/drive-intake-ledger-concurrency.mjs
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/automation/ticket-reply-draft.concurrent.setup.sql
first_result=$(mktemp)
second_result=$(mktemp)
trap 'rm -f "$first_result" "$second_result"; cleanup' EXIT
set +e
docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  -c "BEGIN; SELECT 1 FROM public.support_tickets WHERE id='10000000-0000-4000-8000-000000000001' FOR UPDATE; SELECT pg_sleep(2); SELECT * FROM public.append_support_admin_message_checked('10000000-0000-4000-8000-000000000001','画面と時刻を教えてください。','50000000-0000-4000-8000-000000000001',FALSE,'20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001'); COMMIT;" \
  > "$first_result" 2>&1 &
first_pid=$!
docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  -c "SELECT * FROM public.append_support_admin_message_checked('10000000-0000-4000-8000-000000000001','画面と時刻を教えてください。','50000000-0000-4000-8000-000000000002',FALSE,'20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001');" \
  > "$second_result" 2>&1 &
second_pid=$!
wait "$first_pid"
first_status=$?
wait "$second_pid"
second_status=$?
set -e
if [[ "$first_status" -eq "$second_status" ]]; then
  cat "$first_result" "$second_result" >&2
  echo 'Expected exactly one concurrent draft send to succeed' >&2
  exit 1
fi
message_count=$(docker exec "$container" psql -X -q -U postgres -d yutakasa -Atc \
  "SELECT count(*) FROM public.support_messages WHERE ticket_id='10000000-0000-4000-8000-000000000001' AND sender_type='admin'")
consumed_count=$(docker exec "$container" psql -X -q -U postgres -d yutakasa -Atc \
  "SELECT count(*) FROM public.yutakasa_ticket_reply_drafts WHERE work_id='30000000-0000-4000-8000-000000000001' AND used_message_id IS NOT NULL")
if [[ "$message_count" != '1' || "$consumed_count" != '1' ]]; then
  cat "$first_result" "$second_result" >&2
  echo "Concurrent draft result invalid: messages=$message_count consumed=$consumed_count" >&2
  exit 1
fi
echo 'Concurrent draft send: 1 created, 1 rejected, 1 customer message in DB'

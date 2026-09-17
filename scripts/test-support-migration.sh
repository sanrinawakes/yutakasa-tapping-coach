#!/usr/bin/env bash
set -euo pipefail

container="yutakasa-support-db-test-$$"

cleanup() {
  docker stop "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container" \
  --env POSTGRES_PASSWORD=test \
  --env POSTGRES_DB=yutakasa \
  postgres:15-alpine >/dev/null

# The official image briefly starts a temporary server during initdb, then
# stops it before launching the final server. pg_isready can succeed during
# that gap and leave the first psql call without a socket.
ready=false
for _ in $(seq 1 90); do
  if docker logs "$container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up' &&
     docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  docker logs "$container" >&2
  exit 1
fi
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-migration-harness.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support-automation-terminal.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support-automation-terminal.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support-automation-claim.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support-automation-claim.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/automation/support-automation-manual-review.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/automation/support-automation-manual-review.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-migration-assertions.sql
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-terminal-assertions.sql
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-claim-assertions.sql
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/automation/support-automation-manual-review.sqlcheck.sql

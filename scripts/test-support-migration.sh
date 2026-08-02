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

for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres -d yutakasa >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$container" pg_isready -U postgres -d yutakasa >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-migration-harness.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < supabase-migration-support.sql >/dev/null
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d yutakasa \
  < scripts/support-migration-assertions.sql

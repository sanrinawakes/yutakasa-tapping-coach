#!/bin/sh
set -eu

container="yutakasa-ledger-sql-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker run --rm -d --name "$container" -e POSTGRES_PASSWORD=localtest postgres:16 >/dev/null

attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'PostgreSQL did not become ready' >&2
    exit 1
  fi
  sleep 1
done

docker exec "$container" psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;' >/dev/null
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 \
  < scripts/daily-report/ledger.sql >/dev/null
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 \
  < scripts/daily-report/ledger-reliability.sql >/dev/null
docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 \
  < scripts/daily-report/ledger-reliability.sqlcheck.sql

#!/usr/bin/env bash
# Ensure the prod / local / test databases exist in the local docker Postgres, and apply the
# control-plane schema to the target database (default: usdc_ops). Idempotent.
#
#   prod  -> usdc_ops        (served by `make prod-backend` / decimal.finance)
#   local -> usdc_ops_local  (used by `make dev`)
#   test  -> usdc_ops_test   (used by `make test-api`; truncate-based tests live here only)
#
# Usage: scripts/db-setup.sh [target_db]
set -euo pipefail

TARGET_DB="${1:-usdc_ops}"

docker compose up -d --remove-orphans postgres >/dev/null

psql_admin() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d postgres "$@"; }

for db in usdc_ops usdc_ops_local usdc_ops_test; do
  exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'")"
  if [[ "${exists}" != "1" ]]; then
    psql_admin -c "CREATE DATABASE ${db}" >/dev/null
    echo "created database ${db}"
  fi
done

docker compose exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres \
  psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d "${TARGET_DB}" \
  -f /docker-entrypoint-initdb.d/001-control-plane.sql >/dev/null
echo "schema synced: ${TARGET_DB}"

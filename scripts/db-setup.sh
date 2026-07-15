#!/usr/bin/env bash
# Ensure the local / test databases exist in the local docker Postgres, and apply the
# control-plane schema to the target database (default: usdc_ops_local). Idempotent.
#
#   local -> usdc_ops_local  (used by `make dev`)
#   test  -> usdc_ops_test   (used by `make test-api`; truncate-based tests live here only)
#
# Usage: scripts/db-setup.sh [target_db]
set -euo pipefail

TARGET_DB="${1:-usdc_ops_local}"

docker compose up -d --remove-orphans postgres >/dev/null

psql_admin() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d postgres "$@"; }

for db in usdc_ops usdc_ops_local usdc_ops_test; do
  exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'")"
  if [[ "${exists}" != "1" ]]; then
    psql_admin -c "CREATE DATABASE ${db}" >/dev/null
    echo "created database ${db}"
  fi
done

# Apply every schema file in order (000-* is the first-boot database bootstrap; skip on re-apply).
# Files must stay idempotent — that contract is what lets this re-run on every make dev.
for f in postgres/init/[0-9]*.sql; do
  base="$(basename "${f}")"
  [[ "${base}" == 000-* ]] && continue
  docker compose exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres \
    psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d "${TARGET_DB}" \
    -f "/docker-entrypoint-initdb.d/${base}" >/dev/null
done
echo "schema synced: ${TARGET_DB}"

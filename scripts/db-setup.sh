#!/usr/bin/env bash
# Ensure the databases exist in the local docker Postgres, and apply the schema
# to the target database. Idempotent — this re-runs on every `make dev`.
#
#   usdc_ops_local  what you look at in the browser   (make dev)
#   usdc_ops_bench  what the AI drives                (make bench)
#   usdc_ops_test   truncated on every run            (make test)
#
# Usage: scripts/db-setup.sh [target_db]
set -euo pipefail

TARGET_DB="${1:-usdc_ops_local}"

# This checkout — which may be a worktree. Schema files are read from HERE,
# while docker/compose state is pinned to the main checkout (see compose.sh).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/scripts/compose.sh"

"$COMPOSE" up -d --remove-orphans postgres >/dev/null

# `compose up -d` returns as soon as the container is created. On a cold start
# Postgres is still running initdb, and the very next psql fails with
# "the database system is starting up". Wait for the thing we actually need:
# a query that answers.
for _ in $(seq 1 60); do
  if "$COMPOSE" exec -T postgres psql -qtA -U usdc_ops -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! "$COMPOSE" exec -T postgres psql -qtA -U usdc_ops -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  echo "postgres did not become ready within 60s" >&2
  exit 1
fi

psql_admin() { "$COMPOSE" exec -T postgres psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d postgres "$@"; }

for db in usdc_ops_local usdc_ops_bench usdc_ops_test; do
  exists="$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'")"
  if [[ "${exists}" != "1" ]]; then
    psql_admin -c "CREATE DATABASE ${db}" >/dev/null
    echo "created database ${db}"
  fi
done

# Apply every schema file in order (000-* is the first-boot database bootstrap;
# skip it on re-apply). Files must stay idempotent — that contract is what lets
# this re-run on every make dev.
#
# Piped over stdin rather than `psql -f /docker-entrypoint-initdb.d/...`: that
# mount resolves against the MAIN checkout (compose.sh pins the project
# directory), so a schema file added on a branch would be invisible. Reading
# from $ROOT and piping decouples schema application from the mount entirely.
for f in "$ROOT"/postgres/init/[0-9]*.sql; do
  base="$(basename "${f}")"
  [[ "${base}" == 000-* ]] && continue
  "$COMPOSE" exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres \
    psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d "${TARGET_DB}" < "${f}" >/dev/null
done
echo "schema synced: ${TARGET_DB}"

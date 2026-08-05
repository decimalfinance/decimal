#!/usr/bin/env bash
# `make reset` — empty the local databases, keeping the schema.
#
# The old version hardcoded a list of table names and had silently rotted:
# it still truncated collection_requests, collection_runs and
# collection_request_events, three tables that no longer exist, so
# `make reset-data` simply errored. A hardcoded list is guaranteed to drift
# every time the schema changes, so this discovers the tables instead. It
# cannot go stale.
#
# Usage: scripts/db-reset.sh <db> [<db> ...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/scripts/compose.sh"

TRUNCATE_EVERYTHING=$(cat <<'SQL'
DO $$
DECLARE stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE '
       || string_agg(format('%I.%I', schemaname, tablename), ', ')
       || ' RESTART IDENTITY CASCADE'
    INTO stmt
    FROM pg_tables
   WHERE schemaname IN ('public', 'approval');
  IF stmt IS NOT NULL THEN
    EXECUTE stmt;
  END IF;
END $$;
SQL
)

"$COMPOSE" up -d --remove-orphans postgres >/dev/null

for db in "$@"; do
  exists="$("$COMPOSE" exec -T postgres psql -qtA -U usdc_ops -d postgres \
    -c "SELECT 1 FROM pg_database WHERE datname = '${db}'" 2>/dev/null || true)"
  if [[ "${exists}" != "1" ]]; then
    echo "  ${db}: does not exist yet, skipped"
    continue
  fi
  "$COMPOSE" exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres \
    psql -v ON_ERROR_STOP=1 -q -U usdc_ops -d "${db}" <<<"$TRUNCATE_EVERYTHING" >/dev/null
  echo "  ${db}: emptied"
done

echo "Done. Schema is intact — sign in and you start from nothing."

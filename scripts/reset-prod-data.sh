#!/usr/bin/env bash
#
# Truncate every application table in:
#   - the Postgres database from DATABASE_URL in api/.env (Supabase, in practice)
#   - the local ClickHouse usdc_ops database
#
# DESTRUCTIVE. Wipes users, workspaces, payments, collections, proofs, everything.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f api/.env ]]; then
  echo "api/.env is required." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source api/.env
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

CLICKHOUSE_URL=${CLICKHOUSE_URL:-http://127.0.0.1:8123}

# Parse DATABASE_URL into psql-friendly PG* env vars.
eval "$(node -e '
const u = new URL(process.env.DATABASE_URL);
function q(v) { return JSON.stringify(v ?? ""); }
console.log(`export PGHOST=${q(u.hostname)}`);
console.log(`export PGPORT=${q(u.port || "5432")}`);
console.log(`export PGUSER=${q(u.username)}`);
console.log(`export PGDATABASE=${q(u.pathname.slice(1) || "postgres")}`);
console.log(`export PGPASSWORD=${q(decodeURIComponent(u.password))}`);
const ssl = u.searchParams.get("sslmode");
if (ssl) console.log(`export PGSSLMODE=${q(ssl)}`);
')"

# Confirmation gate unless SKIP_CONFIRM=1
if [[ "${SKIP_CONFIRM:-0}" != "1" ]]; then
  echo "About to TRUNCATE every application table in:"
  echo "  Postgres : $PGHOST:$PGPORT/$PGDATABASE (as $PGUSER)"
  echo "  ClickHouse: $CLICKHOUSE_URL (database usdc_ops)"
  printf "Type 'yes' to proceed: "
  read -r confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "=== Resetting Postgres at $PGHOST ==="
TABLES=$(psql -Atc "SELECT string_agg(quote_ident(tablename), ', ') FROM pg_tables WHERE schemaname='public'")
if [[ -n "$TABLES" && "$TABLES" != " " ]]; then
  psql -c "TRUNCATE TABLE $TABLES RESTART IDENTITY CASCADE;" >/dev/null
  count=$(psql -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
  echo "Truncated $count public tables."
else
  echo "No public tables found."
fi

echo "=== Resetting ClickHouse at $CLICKHOUSE_URL ==="
tables=(
  exceptions
  matcher_events
  observed_payments
  observed_transactions
  observed_transfers
  raw_observations
  request_book_snapshots
  settlement_matches
)
for t in "${tables[@]}"; do
  curl -sS --fail --data "TRUNCATE TABLE IF EXISTS usdc_ops.$t" "$CLICKHOUSE_URL/" >/dev/null
done
echo "Truncated ${#tables[@]} ClickHouse tables."

echo "Done."

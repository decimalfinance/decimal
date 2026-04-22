SHELL := /bin/zsh

POSTGRES_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops?schema=public
PSQL_QUIET := PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -q

.PHONY: infra-up infra-down dev test test-api test-worker test-frontend sync-postgres-schema sync-clickhouse-schema reset-data latest-slot latency-report

infra-up:
	set -euo pipefail && docker compose up -d postgres clickhouse && $(MAKE) sync-postgres-schema && $(MAKE) sync-clickhouse-schema

sync-postgres-schema:
	set -euo pipefail && \
	docker compose up -d postgres && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql" >/dev/null

sync-clickhouse-schema:
	set -euo pipefail && \
	docker compose up -d clickhouse && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null'

infra-down:
	set -euo pipefail && docker compose down

reset-data:
	set -euo pipefail && \
	docker compose up -d postgres clickhouse && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -c \"TRUNCATE TABLE auth_sessions, organization_memberships, collection_request_events, collection_requests, collection_runs, collection_sources, transfer_requests, treasury_wallets, workspaces, organizations, users RESTART IDENTITY CASCADE;\"" >/dev/null && \
	docker compose exec -T clickhouse sh -lc "clickhouse-client --multiquery -q \"TRUNCATE TABLE IF EXISTS usdc_ops.exceptions; TRUNCATE TABLE IF EXISTS usdc_ops.settlement_matches; TRUNCATE TABLE IF EXISTS usdc_ops.request_book_snapshots; TRUNCATE TABLE IF EXISTS usdc_ops.matcher_events; TRUNCATE TABLE IF EXISTS usdc_ops.observed_payments; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transfers; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transactions;\"" >/dev/null && \
	echo "Application data cleared from Postgres and ClickHouse."

latest-slot:
	set -euo pipefail && \
	docker compose up -d clickhouse >/dev/null && \
	echo "Latest observed tx slot:" && \
	docker compose exec -T clickhouse clickhouse-client --query "SELECT coalesce(max(slot), 0) FROM usdc_ops.observed_transactions"

latency-report:
	set -euo pipefail && \
	docker compose up -d clickhouse >/dev/null && \
	docker compose exec -T clickhouse clickhouse-client --query "\
WITH recent AS (\
  SELECT \
    signature, \
    slot, \
    event_time, \
    yellowstone_created_at, \
    worker_received_at, \
    created_at AS tx_write_at \
  FROM usdc_ops.observed_transactions \
  ORDER BY tx_write_at DESC \
  LIMIT 20\
), pay AS (\
  SELECT signature, min(created_at) AS payment_write_at \
  FROM usdc_ops.observed_payments \
  WHERE signature IN (SELECT signature FROM recent) \
  GROUP BY signature\
), m AS (\
  SELECT signature, min(matched_at) AS matched_at \
  FROM usdc_ops.settlement_matches \
  WHERE signature IN (SELECT signature FROM recent) \
  GROUP BY signature\
) \
SELECT \
  recent.slot, \
  recent.signature, \
  recent.event_time, \
  recent.yellowstone_created_at, \
  recent.worker_received_at, \
  recent.tx_write_at, \
  pay.payment_write_at, \
  m.matched_at, \
  if(isNull(recent.yellowstone_created_at) OR isNull(recent.worker_received_at), NULL, dateDiff('millisecond', recent.yellowstone_created_at, recent.worker_received_at)) AS yellowstone_to_worker_ms, \
  if(isNull(recent.worker_received_at), NULL, dateDiff('millisecond', recent.worker_received_at, recent.tx_write_at)) AS worker_to_tx_write_ms, \
  if(isNull(recent.worker_received_at) OR isNull(pay.payment_write_at), NULL, dateDiff('millisecond', recent.worker_received_at, pay.payment_write_at)) AS worker_to_payment_write_ms, \
  if(isNull(recent.worker_received_at) OR isNull(m.matched_at), NULL, dateDiff('millisecond', recent.worker_received_at, m.matched_at)) AS worker_to_match_ms, \
  dateDiff('millisecond', recent.event_time, recent.tx_write_at) AS event_to_tx_write_ms \
FROM recent \
LEFT JOIN pay ON pay.signature = recent.signature \
LEFT JOIN m ON m.signature = recent.signature \
ORDER BY recent.tx_write_at DESC \
FORMAT Vertical"

dev:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	export CONTROL_PLANE_API_URL="$${CONTROL_PLANE_API_URL:-http://127.0.0.1:3100}" && \
	export CLICKHOUSE_URL="$${CLICKHOUSE_URL:-http://127.0.0.1:8123}" && \
	if [[ -f yellowstone/.env ]]; then set -a && source yellowstone/.env && set +a; fi && \
	docker compose up -d postgres clickhouse && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql" >/dev/null && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
	for _ in {1..60}; do \
	  if docker compose exec -T postgres pg_isready -U usdc_ops -d usdc_ops >/dev/null 2>&1; then \
	    if curl -fsS "$${CLICKHOUSE_URL}/ping" >/dev/null 2>&1; then \
	      break; \
	    fi; \
	  fi; \
	  sleep 1; \
	done && \
	(cd api && npm run prisma:generate >/dev/null) && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	(cd frontend && exec npm run dev) & \
	pids+=($$!) && \
	if [[ -n "$${YELLOWSTONE_ENDPOINT:-}" ]]; then \
	  for _ in {1..60}; do \
	    if curl -fsS "$${CONTROL_PLANE_API_URL}/health" >/dev/null 2>&1 && curl -fsS "$${CLICKHOUSE_URL}/ping" >/dev/null 2>&1; then \
	      break; \
	    fi; \
	    sleep 1; \
	  done; \
	  (cd yellowstone && exec cargo run) & \
	  pids+=($$!); \
	else \
	  echo "Skipping Yellowstone worker because YELLOWSTONE_ENDPOINT is not set."; \
	fi && \
	trap 'trap - INT TERM EXIT; for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true; exit 130' INT TERM && \
	trap 'for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true' EXIT && \
	wait "$${pids[@]}" || true

test: test-api test-worker test-frontend

test-api:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	docker compose up -d postgres && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql" >/dev/null && \
	cd api && \
	npm run prisma:generate >/dev/null && \
	npm test

test-worker:
	set -euo pipefail && \
	export RUN_CLICKHOUSE_TESTS=1 && \
	export CLICKHOUSE_URL="$${CLICKHOUSE_URL:-http://127.0.0.1:8123}" && \
	docker compose up -d clickhouse && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
	cd yellowstone && \
	cargo test -- --test-threads=1

test-frontend:
	set -euo pipefail && \
	cd frontend && \
	npm run build

SHELL := /bin/zsh

POSTGRES_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops?schema=public
PSQL_QUIET := PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -q

.PHONY: infra-up infra-down dev test test-api test-worker test-web sync-postgres-schema sync-clickhouse-schema reset-data

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
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -c \"TRUNCATE TABLE auth_sessions, organization_memberships, transfer_requests, workspace_addresses, workspaces, organizations, users RESTART IDENTITY CASCADE;\"" >/dev/null && \
	docker compose exec -T clickhouse sh -lc "clickhouse-client --multiquery -q \"TRUNCATE TABLE IF EXISTS usdc_ops.exceptions; TRUNCATE TABLE IF EXISTS usdc_ops.settlement_matches; TRUNCATE TABLE IF EXISTS usdc_ops.request_book_snapshots; TRUNCATE TABLE IF EXISTS usdc_ops.matcher_events; TRUNCATE TABLE IF EXISTS usdc_ops.observed_payments; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transfers; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transactions; TRUNCATE TABLE IF EXISTS usdc_ops.raw_observations;\"" >/dev/null && \
	echo "Application data cleared from Postgres and ClickHouse."

dev:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	export CONTROL_PLANE_API_URL="$${CONTROL_PLANE_API_URL:-http://127.0.0.1:3100}" && \
	if [[ -f yellowstone/.env ]]; then set -a && source yellowstone/.env && set +a; fi && \
	docker compose up -d postgres clickhouse && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql" >/dev/null && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
	(cd api && npm run prisma:generate >/dev/null) && \
	cleaned_up=0 && \
	cleanup() { \
	  (( cleaned_up )) && return 0; \
	  cleaned_up=1; \
	  trap - INT TERM; \
	  local pid; \
	  for pid in "$${pids[@]:-}"; do kill -INT "$$pid" 2>/dev/null || true; done; \
	  sleep 1; \
	  for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; \
	  for pid in "$${pids[@]:-}"; do wait "$$pid" 2>/dev/null || true; done; \
	}; \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	(cd web && exec npm run dev) & \
	pids+=($$!) && \
	if [[ -n "$${YELLOWSTONE_ENDPOINT:-}" ]]; then \
	  for _ in {1..60}; do \
	    if curl -fsS "$${CONTROL_PLANE_API_URL}/health" >/dev/null 2>&1; then \
	      break; \
	    fi; \
	    sleep 1; \
	  done; \
	  (cd yellowstone && exec cargo run) & \
	  pids+=($$!); \
	else \
	  echo "Skipping Yellowstone worker because YELLOWSTONE_ENDPOINT is not set."; \
	fi && \
	trap 'cleanup; exit 130' INT TERM && \
	wait "$${pids[@]}" || true && \
	cleanup

test: test-api test-worker test-web

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

test-web:
	set -euo pipefail && \
	cd web && \
	npm run build

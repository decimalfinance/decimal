SHELL := /bin/zsh

POSTGRES_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops?schema=public
PSQL_QUIET := PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -q

.SILENT:

.PHONY: infra-up infra-down dev devnet mainnet dev-api dev-frontend dev-worker tunnel prod-backend prod-backend-devnet prod-backend-mainnet _prod-backend-shared test test-api test-worker test-frontend sync-postgres-schema sync-clickhouse-schema reset-data reset-prod-data backup-db restore-db list-backups help

NETWORK_SELECTOR := $(strip $(filter devnet mainnet,$(MAKECMDGOALS)))

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
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -c \"TRUNCATE TABLE auth_sessions, wallet_challenges, user_wallets, organization_memberships, collection_request_events, collection_requests, collection_runs, collection_sources, transfer_requests, treasury_wallets, organizations, users RESTART IDENTITY CASCADE;\"" >/dev/null && \
	docker compose exec -T clickhouse sh -lc "clickhouse-client --multiquery -q \"TRUNCATE TABLE IF EXISTS usdc_ops.exceptions; TRUNCATE TABLE IF EXISTS usdc_ops.settlement_matches; TRUNCATE TABLE IF EXISTS usdc_ops.request_book_snapshots; TRUNCATE TABLE IF EXISTS usdc_ops.matcher_events; TRUNCATE TABLE IF EXISTS usdc_ops.observed_payments; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transfers; TRUNCATE TABLE IF EXISTS usdc_ops.observed_transactions;\"" >/dev/null && \
	echo "Application data cleared from Postgres and ClickHouse."

dev:
	set -euo pipefail && \
	if [[ -f api/.env ]]; then set -a && source api/.env && set +a; fi && \
	if [[ -f yellowstone/.env ]]; then set -a && source yellowstone/.env && set +a; fi && \
	NETWORK_SELECTOR="$(NETWORK_SELECTOR)" && \
	if [[ "$${NETWORK_SELECTOR}" == "devnet" ]]; then \
	  export SOLANA_NETWORK=devnet; \
	  export SOLANA_RPC_URL="$${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"; \
	elif [[ "$${NETWORK_SELECTOR}" == "mainnet" ]]; then \
	  export SOLANA_NETWORK=mainnet; \
	fi && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	export CONTROL_PLANE_API_URL="http://127.0.0.1:3100" && \
	export CLICKHOUSE_URL="$${CLICKHOUSE_URL:-http://127.0.0.1:8123}" && \
	$(MAKE) sync-postgres-schema && \
	docker compose up -d clickhouse && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
	for _ in {1..60}; do \
	  if curl -fsS "$${CLICKHOUSE_URL}/ping" >/dev/null 2>&1; then \
	    break; \
	  fi; \
	  sleep 1; \
	done && \
	(cd api && npm run prisma:generate >/dev/null) && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	(cd frontend && exec npm run dev) & \
	pids+=($$!) && \
	if [[ "$${SOLANA_NETWORK:-mainnet}" == "devnet" ]]; then \
	  echo "Skipping Yellowstone worker because SOLANA_NETWORK=devnet."; \
	elif [[ -n "$${YELLOWSTONE_ENDPOINT:-}" ]]; then \
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

devnet mainnet:
	@:

test: test-api test-worker test-frontend

test-api:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	docker compose up -d postgres clickhouse && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql" >/dev/null && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
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

# Run individual pieces ---------------------------------------------------
# Each target runs one process. Meant for separate terminals.

dev-api:
	set -euo pipefail && \
	if [[ -f api/.env ]]; then set -a && source api/.env && set +a; fi && \
	cd api && npm run dev

dev-frontend:
	set -euo pipefail && \
	cd frontend && npm run dev

dev-worker:
	set -euo pipefail && \
	if [[ -f yellowstone/.env ]]; then set -a && source yellowstone/.env && set +a; fi && \
	cd yellowstone && cargo run

tunnel:
	set -euo pipefail && \
	cloudflared tunnel run decimal-api

# Production-backed local runtime ------------------------------------------
# Starts the local services that back the deployed Vercel frontend:
#   Postgres + ClickHouse (local docker) -> API -> Yellowstone worker
#   -> Cloudflare Tunnel exposing api.decimal.finance
# Does NOT run a local frontend. https://decimal.finance is live from Vercel.

prod-backend: prod-backend-mainnet

prod-backend-devnet:
	set -euo pipefail && \
	export FORCE_SOLANA_NETWORK=devnet && \
	export SKIP_WORKER=1 && \
	$(MAKE) _prod-backend-shared

prod-backend-mainnet:
	set -euo pipefail && \
	export FORCE_SOLANA_NETWORK=mainnet && \
	$(MAKE) _prod-backend-shared

_prod-backend-shared:
	set -euo pipefail && \
	if [[ ! -f api/.env ]]; then \
	  echo "api/.env is required for prod-backend."; \
	  exit 1; \
	fi && \
	set -a && source api/.env && set +a && \
	if [[ -f yellowstone/.env ]]; then set -a && source yellowstone/.env && set +a; fi && \
	if [[ -n "$${FORCE_SOLANA_NETWORK:-}" ]]; then export SOLANA_NETWORK="$${FORCE_SOLANA_NETWORK}"; fi && \
	if [[ "$${SOLANA_NETWORK:-}" == "devnet" ]]; then export SOLANA_RPC_URL="$${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"; fi && \
	export CLICKHOUSE_URL="$${CLICKHOUSE_URL:-http://127.0.0.1:8123}" && \
	export CONTROL_PLANE_API_URL="$${CONTROL_PLANE_API_URL:-https://api.decimal.finance}" && \
	$(MAKE) sync-postgres-schema && \
	docker compose up -d clickhouse && \
	docker compose exec -T clickhouse sh -lc 'clickhouse-client --multiquery < /docker-entrypoint-initdb.d/001-bootstrap.sql >/dev/null && clickhouse-client --multiquery < /docker-entrypoint-initdb.d/002-schema.sql >/dev/null' && \
	for _ in {1..60}; do \
	  if curl -fsS "$${CLICKHOUSE_URL}/ping" >/dev/null 2>&1; then \
	    break; \
	  fi; \
	  sleep 1; \
	done && \
	(cd api && npm run prisma:generate >/dev/null) && \
	pkill -f "cloudflared tunnel run decimal-api" >/dev/null 2>&1 || true && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	cloudflared tunnel run decimal-api & \
	pids+=($$!) && \
	if [[ "$${SKIP_WORKER:-0}" == "1" ]]; then \
	  echo "Skipping Yellowstone worker because SKIP_WORKER=1."; \
	elif [[ -n "$${YELLOWSTONE_ENDPOINT:-}" ]]; then \
	  for _ in {1..60}; do \
	    if curl -fsS "http://127.0.0.1:3100/health" >/dev/null 2>&1; then \
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

# Production data reset ---------------------------------------------------
# Wipes every public table in whatever Postgres DATABASE_URL points at
# (local or remote) + every usdc_ops table in local ClickHouse.
# Prompts for confirmation; set SKIP_CONFIRM=1 to skip.

reset-prod-data:
	./scripts/reset-prod-data.sh

# Postgres backup / restore -----------------------------------------------
# Plain-SQL pg_dump of the local docker postgres into ./backups/.
# Use restore-db FILE=backups/<name>.sql to restore.

backup-db:
	set -euo pipefail && \
	mkdir -p backups && \
	docker compose up -d postgres >/dev/null && \
	OUT="backups/usdc_ops-$$(date +%Y%m%d-%H%M%S).sql" && \
	docker compose exec -T postgres pg_dump -U usdc_ops -d usdc_ops --clean --if-exists --no-owner > "$$OUT" && \
	echo "Backup written to $$OUT ($$(du -h "$$OUT" | cut -f1))"

restore-db:
	set -euo pipefail && \
	if [[ -z "$${FILE:-}" ]]; then echo "Usage: make restore-db FILE=backups/<name>.sql"; exit 1; fi && \
	if [[ ! -f "$${FILE}" ]]; then echo "File not found: $${FILE}"; exit 1; fi && \
	docker compose up -d postgres >/dev/null && \
	docker compose exec -T postgres psql -U usdc_ops -d usdc_ops < "$${FILE}" >/dev/null && \
	echo "Restored from $${FILE}"

list-backups:
	@ls -lh backups/ 2>/dev/null || echo "No backups yet. Run: make backup-db"

# Help --------------------------------------------------------------------

help:
	@echo "Decimal Make targets:"
	@echo ""
	@echo "  Local dev (docker postgres + clickhouse, api + frontend + worker)"
	@echo "    dev                Start everything locally in one terminal"
	@echo "    dev devnet         Start local dev on devnet using SOLANA_DEVNET_RPC_URL; skips worker"
	@echo "    dev mainnet        Start local dev on mainnet; starts worker if YELLOWSTONE_ENDPOINT is set"
	@echo "    infra-up           Start local postgres + clickhouse only"
	@echo "    infra-down         Stop local postgres + clickhouse"
	@echo ""
	@echo "  Individual processes (one terminal each)"
	@echo "    dev-api            API only"
	@echo "    dev-frontend       Vite frontend only"
	@echo "    dev-worker         Yellowstone worker only"
	@echo "    tunnel             Cloudflare Tunnel (api.decimal.finance -> localhost:3100)"
	@echo ""
	@echo "  Production-backed runtime (local postgres + clickhouse + tunnel)"
	@echo "    prod-backend       Alias for prod-backend-mainnet"
	@echo "    prod-backend-mainnet API + worker + tunnel on mainnet, serving https://decimal.finance"
	@echo "    prod-backend-devnet  API + tunnel on devnet; skips Yellowstone worker"
	@echo ""
	@echo "  Data"
	@echo "    reset-data         Truncate local docker postgres + clickhouse"
	@echo "    reset-prod-data    Truncate Postgres (DATABASE_URL) + local ClickHouse (PROMPTS)"
	@echo "    backup-db          pg_dump local postgres -> backups/<timestamp>.sql"
	@echo "    restore-db         Restore from backup: make restore-db FILE=backups/<name>.sql"
	@echo "    list-backups       List existing backups"
	@echo ""
	@echo "  Tests"
	@echo "    test               Run api + worker + frontend tests"
	@echo "    test-api"
	@echo "    test-worker"
	@echo "    test-frontend"

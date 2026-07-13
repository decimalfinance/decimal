SHELL := /bin/zsh

# Separate databases per surface, all in the one local docker Postgres.
#   prod  -> usdc_ops        (make prod-backend, serving decimal.finance)
#   local -> usdc_ops_local  (make dev)
#   test  -> usdc_ops_test   (make test-api; truncate-based tests live here only)
POSTGRES_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops?schema=public
POSTGRES_LOCAL_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_local?schema=public
POSTGRES_TEST_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_test?schema=public
# Target database for schema sync / backup. Override per target (e.g. DB=usdc_ops_local).
DB ?= usdc_ops
PSQL_QUIET := PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -q

# API ports — kept distinct so local dev and the prod backend never fight over one
# socket. Override per-process with the PORT env var (config.ts reads it).
#   local dev (make dev)        -> 3100  (frontend localApiBaseUrl + QuickBooks redirect URI)
#   prod backend (prod-backend) -> 3101  (cloudflared tunnel api.decimal.finance -> 127.0.0.1:3101)

.SILENT:

.PHONY: infra-up infra-down dev devnet mainnet dev-api dev-frontend tunnel prod-backend prod-backend-devnet prod-backend-mainnet _prod-backend-shared test test-api test-frontend testbench-up testbench-down testbench-status testbench-restart-api sync-postgres-schema reset-data reset-prod-data backup-db restore-db list-backups help

NETWORK_SELECTOR := $(strip $(filter devnet mainnet,$(MAKECMDGOALS)))

infra-up:
	set -euo pipefail && docker compose up -d --remove-orphans postgres && $(MAKE) sync-postgres-schema

sync-postgres-schema:
	set -euo pipefail && ./scripts/db-setup.sh $(DB)

infra-down:
	set -euo pipefail && docker compose down --remove-orphans

reset-data:
	set -euo pipefail && \
	docker compose up -d --remove-orphans postgres && \
	docker compose exec -T postgres sh -lc "$(PSQL_QUIET) -U usdc_ops -d usdc_ops_local -c \"TRUNCATE TABLE auth_sessions, user_wallets, organization_memberships, collection_request_events, collection_requests, collection_runs, counterparty_wallets, transfer_requests, treasury_wallets, organizations, users RESTART IDENTITY CASCADE;\"" >/dev/null && \
	echo "Local application data cleared (usdc_ops_local)."

dev:
	set -euo pipefail && \
	if [[ -f api/.env ]]; then set -a && source api/.env && set +a; fi && \
	NETWORK_SELECTOR="$(NETWORK_SELECTOR)" && \
	if [[ "$${NETWORK_SELECTOR}" == "devnet" ]]; then \
	  export SOLANA_NETWORK=devnet; \
	  export SOLANA_RPC_URL="$${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"; \
	elif [[ "$${NETWORK_SELECTOR}" == "mainnet" ]]; then \
	  export SOLANA_NETWORK=mainnet; \
	fi && \
	export DATABASE_URL="$(POSTGRES_LOCAL_URL)" && \
	export PORT=3100 && \
	$(MAKE) sync-postgres-schema DB=usdc_ops_local && \
	(cd api && npm run prisma:generate >/dev/null) && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	(cd frontend && exec npm run dev) & \
	pids+=($$!) && \
	echo "Indexer stack is removed from make dev. RPC verification is used for app-originated payments." && \
	trap 'trap - INT TERM EXIT; for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true; exit 130' INT TERM && \
	trap 'for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true' EXIT && \
	wait "$${pids[@]}" || true

devnet mainnet:
	@:

# Agent-operable dev stack (TESTBENCH.md): background api+frontend with logs,
# hot-reloading, on the LOCAL db/ports — never touches prod (:3101/usdc_ops).
testbench-up:
	set -euo pipefail && ./scripts/testbench.sh up
testbench-down:
	set -euo pipefail && ./scripts/testbench.sh down
testbench-status:
	set -euo pipefail && ./scripts/testbench.sh status
testbench-restart-api:
	set -euo pipefail && ./scripts/testbench.sh restart-api

test: test-api test-frontend

test-api:
	set -euo pipefail && \
	export DATABASE_URL="$(POSTGRES_TEST_URL)" && \
	$(MAKE) sync-postgres-schema DB=usdc_ops_test && \
	cd api && \
	npm run prisma:generate >/dev/null && \
	npm test

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

tunnel:
	set -euo pipefail && \
	cloudflared tunnel run decimal-api

# Production-backed local runtime ------------------------------------------
# Starts the local services that back the deployed Vercel frontend:
#   Postgres (local docker) -> API -> Cloudflare Tunnel exposing api.decimal.finance
# Does NOT run a local frontend. https://decimal.finance is live from Vercel.

prod-backend: prod-backend-mainnet

prod-backend-devnet:
	set -euo pipefail && \
	export FORCE_SOLANA_NETWORK=devnet && \
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
	export DATABASE_URL="$(POSTGRES_URL)" && \
	export PORT=3101 && \
	if [[ -n "$${FORCE_SOLANA_NETWORK:-}" ]]; then export SOLANA_NETWORK="$${FORCE_SOLANA_NETWORK}"; fi && \
	if [[ "$${SOLANA_NETWORK:-}" == "devnet" ]]; then export SOLANA_RPC_URL="$${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"; fi && \
	$(MAKE) sync-postgres-schema DB=usdc_ops && \
	(cd api && npm run prisma:generate >/dev/null) && \
	pkill -f "cloudflared tunnel run decimal-api" >/dev/null 2>&1 || true && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	cloudflared tunnel run decimal-api & \
	pids+=($$!) && \
	echo "Using RPC settlement verification; no chain-indexer worker is started." && \
	trap 'trap - INT TERM EXIT; for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true; exit 130' INT TERM && \
	trap 'for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true' EXIT && \
	wait "$${pids[@]}" || true

# Production data reset ---------------------------------------------------
# Wipes every public table in whatever Postgres DATABASE_URL points at.
# Prompts for confirmation; set SKIP_CONFIRM=1 to skip.

reset-prod-data:
	./scripts/reset-prod-data.sh

# Postgres backup / restore -----------------------------------------------
# Plain-SQL pg_dump of the local docker postgres into ./backups/.
# Use restore-db FILE=backups/<name>.sql to restore.

backup-db:
	set -euo pipefail && \
	mkdir -p backups && \
	docker compose up -d --remove-orphans postgres >/dev/null && \
	OUT="backups/$(DB)-$$(date +%Y%m%d-%H%M%S).sql" && \
	docker compose exec -T postgres pg_dump -U usdc_ops -d $(DB) --clean --if-exists --no-owner > "$$OUT" && \
	echo "Backup written to $$OUT ($$(du -h "$$OUT" | cut -f1))"

restore-db:
	set -euo pipefail && \
	if [[ -z "$${FILE:-}" ]]; then echo "Usage: make restore-db FILE=backups/<name>.sql [DB=usdc_ops]"; exit 1; fi && \
	if [[ ! -f "$${FILE}" ]]; then echo "File not found: $${FILE}"; exit 1; fi && \
	docker compose up -d --remove-orphans postgres >/dev/null && \
	docker compose exec -T postgres psql -U usdc_ops -d $(DB) < "$${FILE}" >/dev/null && \
	echo "Restored $(DB) from $${FILE}"

list-backups:
	@ls -lh backups/ 2>/dev/null || echo "No backups yet. Run: make backup-db"

# Help --------------------------------------------------------------------

help:
	@echo "Decimal Make targets:"
	@echo ""
	@echo "  Local dev (docker postgres, api + frontend)"
	@echo "    dev                Start core product locally in one terminal"
	@echo "    dev devnet         Start local dev on devnet using SOLANA_DEVNET_RPC_URL"
	@echo "    dev mainnet        Start local dev on mainnet"
	@echo "    infra-up           Start local postgres only"
	@echo "    infra-down         Stop local docker services"
	@echo ""
	@echo "  Individual processes (one terminal each)"
	@echo "    dev-api            API only"
	@echo "    dev-frontend       Vite frontend only"
	@echo "    tunnel             Cloudflare Tunnel (api.decimal.finance -> localhost:3100)"
	@echo ""
	@echo "  Production-backed runtime (local postgres + tunnel)"
	@echo "    prod-backend       Alias for prod-backend-mainnet"
	@echo "    prod-backend-mainnet API + tunnel on mainnet, serving https://decimal.finance"
	@echo "    prod-backend-devnet  API + tunnel on devnet"
	@echo ""
	@echo "  Data (separate DBs: usdc_ops=prod, usdc_ops_local=dev, usdc_ops_test=tests)"
	@echo "    reset-data         Truncate the local dev DB (usdc_ops_local)"
	@echo "    reset-prod-data    Truncate Postgres (DATABASE_URL, prompts)"
	@echo "    backup-db          pg_dump -> backups/<db>-<timestamp>.sql (DB=usdc_ops default)"
	@echo "    restore-db         Restore: make restore-db FILE=backups/<name>.sql [DB=usdc_ops]"
	@echo "    list-backups       List existing backups"
	@echo ""
	@echo "  Tests"
	@echo "    test               Run api + frontend tests"
	@echo "    test-api"
	@echo "    test-frontend"

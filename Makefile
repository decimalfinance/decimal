SHELL := /bin/zsh

# One local docker Postgres, two databases:
#   dev  -> usdc_ops_local  (make dev)
#   test -> usdc_ops_test   (make test-api; truncate-based tests live here only)
# (usdc_ops is just the Postgres default/admin DB; the app doesn't use it.)
POSTGRES_LOCAL_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_local?schema=public
POSTGRES_TEST_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_test?schema=public
# Target database for schema sync / backup. Override per target (e.g. DB=usdc_ops_test).
DB ?= usdc_ops_local
PSQL_QUIET := PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -q

# API runs on port 3100 (frontend localApiBaseUrl + QuickBooks redirect URI).

.SILENT:

.PHONY: infra-up infra-down dev devnet dev-api dev-frontend test test-api test-frontend testbench-up testbench-down testbench-status testbench-restart-api sync-postgres-schema reset-data backup-db restore-db list-backups help

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

# One command: postgres + api + frontend on devnet, against the local dev DB.
dev:
	set -euo pipefail && \
	if [[ -f api/.env ]]; then set -a && source api/.env && set +a; fi && \
	export SOLANA_NETWORK=devnet && \
	export SOLANA_RPC_URL="$${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}" && \
	export DATABASE_URL="$(POSTGRES_LOCAL_URL)" && \
	export PORT=3100 && \
	$(MAKE) sync-postgres-schema DB=usdc_ops_local && \
	(cd api && npm run prisma:generate >/dev/null) && \
	typeset -a pids && \
	(cd api && exec npm run dev) & \
	pids+=($$!) && \
	(cd frontend && exec npm run dev) & \
	pids+=($$!) && \
	trap 'trap - INT TERM EXIT; for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true; exit 130' INT TERM && \
	trap 'for pid in "$${pids[@]:-}"; do kill -TERM "$$pid" 2>/dev/null || true; done; sleep 0.5; for pid in "$${pids[@]:-}"; do kill -KILL "$$pid" 2>/dev/null || true; done; wait "$${pids[@]}" 2>/dev/null || true' EXIT && \
	wait "$${pids[@]}" || true

# No-op so `make dev devnet` (old habit) still works; dev is devnet-only now.
devnet:
	@:

# Agent-operable dev stack (TESTBENCH.md): background api+frontend with logs,
# hot-reloading, on the local db/ports.
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

# Run individual pieces (separate terminals) ------------------------------
dev-api:
	set -euo pipefail && \
	if [[ -f api/.env ]]; then set -a && source api/.env && set +a; fi && \
	cd api && npm run dev

dev-frontend:
	set -euo pipefail && \
	cd frontend && npm run dev

# Postgres backup / restore -----------------------------------------------
backup-db:
	set -euo pipefail && \
	mkdir -p backups && \
	docker compose up -d --remove-orphans postgres >/dev/null && \
	OUT="backups/$(DB)-$$(date +%Y%m%d-%H%M%S).sql" && \
	docker compose exec -T postgres pg_dump -U usdc_ops -d $(DB) --clean --if-exists --no-owner > "$$OUT" && \
	echo "Backup written to $$OUT ($$(du -h "$$OUT" | cut -f1))"

restore-db:
	set -euo pipefail && \
	if [[ -z "$${FILE:-}" ]]; then echo "Usage: make restore-db FILE=backups/<name>.sql [DB=usdc_ops_local]"; exit 1; fi && \
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
	@echo "  Local dev (docker postgres + api + frontend on devnet)"
	@echo "    dev                Start postgres + api + frontend in one terminal"
	@echo "    infra-up           Start local postgres only"
	@echo "    infra-down         Stop local docker services"
	@echo ""
	@echo "  Individual processes (one terminal each)"
	@echo "    dev-api            API only"
	@echo "    dev-frontend       Vite frontend only"
	@echo ""
	@echo "  Testbench (agent-operable background stack, TESTBENCH.md)"
	@echo "    testbench-up / testbench-down / testbench-status / testbench-restart-api"
	@echo ""
	@echo "  Data (dev DB usdc_ops_local, test DB usdc_ops_test)"
	@echo "    reset-data         Truncate the local dev DB (usdc_ops_local)"
	@echo "    backup-db          pg_dump -> backups/<db>-<timestamp>.sql (DB=usdc_ops_local default)"
	@echo "    restore-db         Restore: make restore-db FILE=backups/<name>.sql [DB=usdc_ops_local]"
	@echo "    list-backups       List existing backups"
	@echo ""
	@echo "  Tests"
	@echo "    test               Run api + frontend tests"
	@echo "    test-api"
	@echo "    test-frontend"

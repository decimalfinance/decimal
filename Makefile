SHELL := /bin/zsh

POSTGRES_URL ?= postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops?schema=public

.PHONY: infra-up infra-down dev test test-api test-worker test-web sync-postgres-schema

infra-up:
	set -euo pipefail && docker compose up -d postgres clickhouse

sync-postgres-schema:
	set -euo pipefail && \
	docker compose up -d postgres && \
	docker compose exec -T postgres psql -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql >/dev/null

infra-down:
	set -euo pipefail && docker compose down

dev:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	export CONTROL_PLANE_API_URL="$${CONTROL_PLANE_API_URL:-http://127.0.0.1:3100}" && \
	docker compose up -d postgres clickhouse && \
	docker compose exec -T postgres psql -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql >/dev/null && \
	(cd api && npm run prisma:generate >/dev/null) && \
	typeset -a pids && \
	(cd api && npm run dev) & \
	pids+=($$!) && \
	(cd web && npm run dev) & \
	pids+=($$!) && \
	if [[ -n "$${YELLOWSTONE_ENDPOINT:-}" ]]; then \
	  (cd yellowstone && cargo run) & \
	  pids+=($$!); \
	else \
	  echo "Skipping Yellowstone worker because YELLOWSTONE_ENDPOINT is not set."; \
	fi && \
	trap 'for pid in "$${pids[@]}"; do kill "$$pid" 2>/dev/null || true; done' INT TERM EXIT && \
	wait

test: test-api test-worker test-web

test-api:
	set -euo pipefail && \
	export DATABASE_URL="$${DATABASE_URL:-$(POSTGRES_URL)}" && \
	docker compose up -d postgres && \
	docker compose exec -T postgres psql -U usdc_ops -d usdc_ops -f /docker-entrypoint-initdb.d/001-control-plane.sql >/dev/null && \
	cd api && \
	npm run prisma:generate >/dev/null && \
	npm test

test-worker:
	set -euo pipefail && \
	export RUN_CLICKHOUSE_TESTS=1 && \
	export CLICKHOUSE_URL="$${CLICKHOUSE_URL:-http://127.0.0.1:8123}" && \
	docker compose up -d clickhouse && \
	cd yellowstone && \
	cargo test -- --test-threads=1

test-web:
	set -euo pipefail && \
	cd web && \
	npm run build

SHELL := /bin/zsh

# ---------------------------------------------------------------------------
# Six commands. That is the whole surface — run `make help`.
#
# One docker Postgres on :54329, three databases that cannot see each other:
#
#   usdc_ops_local   what you look at in the browser    make dev
#   usdc_ops_bench   what an AI agent drives            make bench
#   usdc_ops_test    truncated on every run             make test
#
# dev and bench run at the same time, on different ports, on purpose.
# Devnet only — there is no mainnet path and no network to choose.
# ---------------------------------------------------------------------------

DEV_DB   := usdc_ops_local
BENCH_DB := usdc_ops_bench
TEST_DB  := usdc_ops_test
PG       := postgresql://usdc_ops:usdc_ops@127.0.0.1:54329

# Which database sync-postgres-schema targets. Internal.
DB ?= $(DEV_DB)

.SILENT:
.PHONY: dev stop test reset bench bench-stop help sync-postgres-schema

# Two rules here, both learned the hard way.
#
# 1. Nothing is silenced without a fallback that says what happened. The old
#    recipe sent prisma generate to /dev/null, so when it failed you got no
#    error from it at all.
#
# 2. The failure you DID get was a lie. On any early exit the EXIT trap ran
#    `wait "$${pids[@]}"` on an array that was still empty, and an empty array
#    in that position expands to a single empty string — so zsh reported
#    "pid 0 is not a child of this shell" and make reported a termination.
#    Both described the trap, not the thing that actually broke. Named pids and
#    `;` chaining remove the array and the ambiguity together.
dev: ## start everything (db + api + web) -> localhost:5174
	set -euo pipefail; \
	if [[ -f api/.env ]]; then set -a; source api/.env; set +a; fi; \
	export DATABASE_URL="$(PG)/$(DEV_DB)?schema=public"; \
	export PORT=3100; \
	$(MAKE) sync-postgres-schema DB=$(DEV_DB); \
	(cd api && npm run prisma:generate >/dev/null) || { \
	  echo ""; \
	  echo "prisma generate failed. Its output was hidden; run it directly to see why:"; \
	  echo "    cd api && npm run prisma:generate"; \
	  exit 1; \
	}; \
	(cd api && exec npm run dev) & \
	api_pid=$$!; \
	(cd frontend && exec npm run dev) & \
	web_pid=$$!; \
	trap 'kill -TERM $$api_pid $$web_pid 2>/dev/null || true; sleep 0.5; kill -KILL $$api_pid $$web_pid 2>/dev/null || true' INT TERM EXIT; \
	wait $$api_pid $$web_pid || true

stop: ## stop everything, including docker
	set -euo pipefail && ./scripts/stop.sh

test: ## run all tests
	set -euo pipefail && \
	export DATABASE_URL="$(PG)/$(TEST_DB)?schema=public" && \
	$(MAKE) sync-postgres-schema DB=$(TEST_DB) && \
	(cd api && npm run prisma:generate >/dev/null && npm run typecheck && npm test) && \
	(cd frontend && npm run build)

reset: ## wipe local dev data (schema stays)
	set -euo pipefail && ./scripts/db-reset.sh $(DEV_DB) $(BENCH_DB)

bench: ## background stack for AI testing -> localhost:5274
	set -euo pipefail && ./scripts/bench.sh up

# --- deliberately not in help ---------------------------------------------
# `make stop` is how a human stops things. bench-stop exists so an agent can
# put its own stack down without touching yours. See TESTBENCH.md.
bench-stop:
	set -euo pipefail && ./scripts/bench.sh down

# Applies postgres/init/*.sql to $(DB). Called by dev, test and bench.
sync-postgres-schema:
	set -euo pipefail && ./scripts/db-setup.sh $(DB)

help:
	@echo "Decimal — six commands:"
	@echo ""
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-6s %s\n", $$1, $$2}'
	@echo "  make help   show this list"
	@echo ""
	@echo "dev and bench can run at once — different ports, different databases."
	@echo "Devnet only. Agent bench sub-commands: see TESTBENCH.md."

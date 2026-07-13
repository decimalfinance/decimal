#!/bin/zsh
# Test bench — the agent-operable dev stack (TESTBENCH.md is the contract).
# Runs the API (port 3100, usdc_ops_local) and frontend (port 5174) in the
# BACKGROUND with logs, so Claude Code desktop can start/stop/verify the stack
# itself. Both processes hot-reload (tsx watch / vite), so code changes apply
# without restarts. NEVER touches port 3101 / usdc_ops — that's production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.testbench"
API_PORT=3100
FE_PORT=5174
mkdir -p "$RUN"

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti ":$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

start_api() {
  kill_port $API_PORT
  (
    cd "$ROOT/api"
    if [[ -f .env ]]; then set -a && source .env && set +a; fi
    export DATABASE_URL="postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/usdc_ops_local?schema=public"
    export PORT=$API_PORT
    # The bench is always devnet — matching `make dev devnet` (auto-funding
    # and the shared .env assume it; mainnet has no business on a test bench).
    export SOLANA_NETWORK=devnet
    export SOLANA_RPC_URL="${SOLANA_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
    # Fake Squads chain: treasuries + the release ceremony run in memory with
    # no real RPC and no real USDC, so release-time policy is testable.
    # In-memory: re-create bench treasuries after an API restart.
    export SQUADS_FAKE_CHAIN=true
    nohup npm run dev >"$RUN/api.log" 2>&1 &
    echo $! >"$RUN/api.pid"
  )
}

start_frontend() {
  kill_port $FE_PORT
  (
    cd "$ROOT/frontend"
    nohup npm run dev >"$RUN/frontend.log" 2>&1 &
    echo $! >"$RUN/frontend.pid"
  )
}

wait_for() {
  local name=$1 url=$2 tries=${3:-60}
  for _ in $(seq 1 "$tries"); do
    if curl -sf -m 2 "$url" >/dev/null 2>&1; then
      echo "  ✓ $name up ($url)"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ $name did NOT come up ($url) — check $RUN logs"
  return 1
}

status() {
  local ok=0
  local health
  health=$(curl -sf -m 2 "http://127.0.0.1:$API_PORT/health" 2>/dev/null || true)
  if [[ -n "$health" ]]; then
    echo "api:      up   http://127.0.0.1:$API_PORT"
    if [[ "$health" == *'"fakeChain":true'* ]]; then
      echo "fakechain: on  (treasury/release ceremony is simulated)"
    else
      echo "fakechain: OFF — this API process is hitting the REAL chain; run 'make testbench-restart-api'"; ok=1
    fi
  else
    echo "api:      DOWN (log: .testbench/api.log)"; ok=1
  fi
  if curl -sf -m 2 "http://localhost:$FE_PORT" >/dev/null 2>&1; then
    echo "frontend: up   http://localhost:$FE_PORT"
  else
    echo "frontend: DOWN (log: .testbench/frontend.log)"; ok=1
  fi
  if grep -q '^DEV_AUTH_SECRET=..*' "$ROOT/api/.env" 2>/dev/null; then
    echo "dev auth: enabled (secret in api/.env; panel on /login)"
  else
    echo "dev auth: NOT configured — add DEV_AUTH_SECRET to api/.env"; ok=1
  fi
  return $ok
}

case "${1:-}" in
  up)
    echo "Starting test bench (api :$API_PORT on usdc_ops_local, frontend :$FE_PORT)…"
    (cd "$ROOT" && docker compose up -d --remove-orphans postgres >/dev/null && ./scripts/db-setup.sh usdc_ops_local >/dev/null)
    start_api
    start_frontend
    wait_for api "http://127.0.0.1:$API_PORT/health" 90
    wait_for frontend "http://localhost:$FE_PORT" 90
    status || true
    ;;
  down)
    kill_port $API_PORT
    kill_port $FE_PORT
    rm -f "$RUN/api.pid" "$RUN/frontend.pid"
    echo "Test bench stopped (prod on :3101 untouched)."
    ;;
  restart-api)
    start_api
    wait_for api "http://127.0.0.1:$API_PORT/health" 90
    ;;
  status)
    status
    ;;
  logs)
    tail -n 40 "$RUN/api.log" 2>/dev/null || echo "(no api log)"
    ;;
  *)
    echo "usage: testbench.sh up|down|restart-api|status|logs"
    exit 2
    ;;
esac

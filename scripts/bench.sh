#!/bin/zsh
# The bench — the stack an AI agent drives (TESTBENCH.md is the contract).
#
# It is deliberately a SEPARATE stack from `make dev`: its own ports, its own
# database, its own run directory. That is the whole point. Before, both ran on
# :3100 against usdc_ops_local, so starting one silently stole the other's port
# (dropping the fake-chain flag) and both wrote the same data. Now they can run
# at the same time and cannot see each other.
#
#   make dev    :3100 api  :5174 web   usdc_ops_local   <- your browser
#   make bench  :3200 api  :5274 web   usdc_ops_bench   <- the agent
#
# NEVER touch :3100 / :5174 / usdc_ops_local from here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.bench"
API_PORT=3200
FE_PORT=5274
BENCH_DB=usdc_ops_bench
mkdir -p "$RUN"

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti ":$port" 2>/dev/null || true)
    # Explicit if, not `[[ ... ]] && ... || true` — a false test as the last
    # command of a function returns 1 and trips set -e.
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  fi
}

start_api() {
  kill_port $API_PORT
  (
    cd "$ROOT/api"
    if [[ -f .env ]]; then set -a && source .env && set +a; fi
    export DATABASE_URL="postgresql://usdc_ops:usdc_ops@127.0.0.1:54329/$BENCH_DB?schema=public"
    export PORT=$API_PORT
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
    # Point the bench UI at the BENCH api. Without this it talks to whatever is
    # on :3100 — i.e. your stack.
    export VITE_API_BASE_URL="http://127.0.0.1:$API_PORT"
    # Run vite directly rather than `npm run dev`: that script bakes in
    # --port 5174, and relying on flag precedence to override it is not a bet
    # worth making when the failure mode is "the agent edits your data".
    nohup ./node_modules/.bin/vite --host 127.0.0.1 --port $FE_PORT --strictPort \
      >"$RUN/frontend.log" 2>&1 &
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
    echo "api:       up   http://127.0.0.1:$API_PORT"
  else
    echo "api:       DOWN (log: .bench/api.log)"; ok=1
  fi
  # Printed so a test report can never be ambiguous about which stack it describes.
  echo "database:  $BENCH_DB"
  if [[ -n "$health" && "$health" == *'"fakeChain":true'* ]]; then
    echo "fakechain: on   (treasury/release ceremony is simulated)"
  elif [[ -n "$health" ]]; then
    echo "fakechain: OFF  — run 'make bench' to restart it"; ok=1
  fi
  if curl -sf -m 2 "http://127.0.0.1:$FE_PORT" >/dev/null 2>&1; then
    echo "frontend:  up   http://localhost:$FE_PORT"
  else
    echo "frontend:  DOWN (log: .bench/frontend.log)"; ok=1
  fi
  if grep -q '^DEV_AUTH_SECRET=..*' "$ROOT/api/.env" 2>/dev/null; then
    echo "dev auth:  enabled (sign in at /dev-login)"
  else
    echo "dev auth:  NOT configured — add DEV_AUTH_SECRET to api/.env"; ok=1
  fi
  return $ok
}

case "${1:-}" in
  up)
    echo "Starting bench (api :$API_PORT on $BENCH_DB, web :$FE_PORT)…"
    "$ROOT/scripts/db-setup.sh" "$BENCH_DB" >/dev/null
    start_api
    start_frontend
    wait_for api "http://127.0.0.1:$API_PORT/health" 90
    wait_for frontend "http://127.0.0.1:$FE_PORT" 90
    status || true
    ;;
  down)
    # Only ever the bench's own ports.
    kill_port $API_PORT
    kill_port $FE_PORT
    rm -f "$RUN/api.pid" "$RUN/frontend.pid"
    echo "Bench stopped (:3100 / :5174 untouched)."
    ;;
  status)
    status
    ;;
  logs)
    tail -n 40 "$RUN/api.log" 2>/dev/null || echo "(no api log)"
    ;;
  *)
    echo "usage: bench.sh up|down|status|logs"
    exit 2
    ;;
esac

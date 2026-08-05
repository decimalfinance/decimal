#!/usr/bin/env bash
# `make stop` — put everything down: your dev stack, the bench, and docker.
#
# Exists because "stop" used to mean knowing three things: Ctrl-C the dev
# terminal, `make testbench-down` if the agent left a stack running, and
# `make infra-down` for docker. One word now.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

kill_port() {
  local port=$1 label=$2
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti ":$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
    echo "  stopped $label (:$port)"
  fi
}

kill_port 3100 "api"
kill_port 5174 "web"
kill_port 3200 "bench api"
kill_port 5274 "bench web"
rm -f "$ROOT/.bench/api.pid" "$ROOT/.bench/frontend.pid"

"$ROOT/scripts/compose.sh" down --remove-orphans >/dev/null 2>&1 || true
echo "  stopped postgres"
echo "Everything stopped. Your data is on the docker volume and is untouched."

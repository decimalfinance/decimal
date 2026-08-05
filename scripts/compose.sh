#!/usr/bin/env bash
# Every `docker compose` call in this repo goes through here. Do not call
# `docker compose` directly.
#
# WHY THIS EXISTS
# Compose derives its project name, and the base for relative bind mounts, from
# the directory you invoke it in. Run a make target from a git worktree and you
# get a SECOND compose project ("inbound-email-intake") with its OWN volume —
# a brand-new empty Postgres running initdb — which then collides with the main
# checkout over the fixed `container_name: usdc-ops-postgres`.
#
# The symptoms, both seen in the wild:
#   - every open connection dies with
#     "terminating connection due to administrator command"  (container swapped)
#   - the next psql fails with
#     "the database system is starting up"                   (initdb running)
#
# Pinning the project name, directory and file makes every worktree share one
# Postgres and one volume, so it does not matter where you run make from.
#
# The project name MUST stay `decimal`: that is what the existing
# `decimal_postgres_data` volume is named. Change it and the next `make dev`
# attaches to a fresh empty volume and looks exactly like total data loss.
# (It isn't — the old volume is still there — but you will not enjoy the
# thirty seconds before you work that out.)
set -euo pipefail

# The main checkout, regardless of which worktree we were invoked from.
MAIN_WORKTREE="$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //')"
: "${MAIN_WORKTREE:=$(cd "$(dirname "$0")/.." && pwd)}"

exec docker compose \
  --project-name decimal \
  --project-directory "$MAIN_WORKTREE" \
  --file "$MAIN_WORKTREE/docker-compose.yml" \
  "$@"

# 02 Repository And Runtime Map

This repository contains one product split across several runtime processes.

## Top-Level Layout

```text
.
├── api/                 TypeScript Express control-plane API
├── frontend/            React/Vite SPA
├── yellowstone/         Rust Solana Yellowstone ingestion + matching worker
├── postgres/            Postgres init scripts (used by docker volume init)
├── clickhouse/          ClickHouse init scripts
├── config/              Public/runtime config (worker.config.json, frontend.public.json)
├── scripts/             Operational shell scripts
├── system_explained/    These onboarding docs
├── outputs/             Research / proof artifacts
├── problems/            Incident writeups
├── backups/             Postgres pg_dump snapshots (gitignored)
├── Makefile             Developer + production-backed workflows
├── docker-compose.yml   Local Postgres and ClickHouse
├── vercel.json          Vercel deploy config (frontend-only static SPA)
└── list.md              Implementation checklist
```

## Runtime Processes

The production-backed runtime that serves https://decimal.finance consists of:

```text
Frontend (Vercel CDN)
  Static React/Vite SPA at https://decimal.finance. No Vercel functions, no proxy.
  Served from CDN edge. Build output = frontend/dist.

Cloudflare Tunnel (cloudflared)
  Outbound tunnel from the laptop to Cloudflare. Exposes the laptop API as
  https://api.decimal.finance. The browser hits this URL directly — Vercel is NOT
  in the API call path.

API (laptop)
  Express server at http://127.0.0.1:3100 run via `tsx watch`.
  Reachable from the world via the Cloudflare tunnel above.

Postgres (laptop, docker)
  Control-plane database. Container `usdc-ops-postgres`, port 54329.

ClickHouse (laptop, docker)
  Event/reconciliation/observability database. Container `usdc-ops-clickhouse`,
  port 8123.

Yellowstone worker (laptop)
  Rust process. Subscribes to Solana mainnet via Yellowstone gRPC (currently
  https://solana-rpc.parafi.tech:10443). Writes ClickHouse, fetches matching
  context from API via /internal/matching-index + SSE.
```

For local dev (no tunnel, no Vercel), `make dev` brings up Postgres + ClickHouse + API + Vite frontend + worker on the laptop only.

## Why this topology

The laptop hosts everything except the static frontend bundle. Tradeoffs:

- **Free**, no managed services, no card needed.
- Per-DB-query latency is ~2ms (loopback) instead of ~300ms (was Singapore Supabase). Page loads dropped 4–5×.
- Cloudflare Tunnel solves the "residential ISP doesn't give you a public IP" problem and survives WiFi changes — `cloudflared` reconnects from wherever the laptop is.
- Cost: laptop sleep / lid close / internet drop kills the demo. Use `caffeinate -i make prod-backend` and a hotspot backup.

## Important Commands

```bash
make prod-backend     # production-backed runtime (Postgres + ClickHouse + API + tunnel + worker)
make dev              # full local dev stack (no tunnel)
make infra-up         # Postgres + ClickHouse only
make infra-down

make dev-api          # individual processes
make dev-frontend
make dev-worker
make tunnel

make test             # api + worker + frontend
make backup-db        # pg_dump local Postgres
make restore-db FILE=backups/<name>.sql
make reset-data       # truncate local docker tables
```

See doc 11 for full operational details.

## Docker Services

`docker-compose.yml` defines:

### Postgres

```text
container: usdc-ops-postgres
ports:     54329:5432
database:  usdc_ops
user:      usdc_ops
password:  usdc_ops
volume:    stablecoin_intelligence_postgres_data (named, persistent)
```

### ClickHouse

```text
container: usdc-ops-clickhouse
ports:     8123 HTTP, 9000 native
database:  usdc_ops
user:      default
password:  empty
```

## Data Ownership

Postgres owns the control-plane truth:

- Users, organizations, workspaces.
- Treasury wallets (Solana wallets we own; sources for payouts, receivers for collections).
- Destinations (counterparty wallets we pay).
- Counterparties (optional org-scoped tag).
- Collection sources (saved expected payer wallets with trust state).
- Payment requests, payment runs, payment orders.
- Collection requests, collection runs.
- Transfer requests (the matcher's intent row).
- Approval policy + decisions.
- Execution records.
- Audit events, operator notes, exception metadata.
- Idempotency records.
- Auth sessions.

ClickHouse owns high-volume observed and derived data:

- Observed transactions, USDC transfers, reconstructed payments.
- Matcher events, settlement matches.
- Worker-generated exceptions.

Do not move high-volume chain event data into Postgres casually.

## Control Flow Between Services

```text
Browser (decimal.finance, Vercel CDN)
  -> Cloudflare Tunnel
  -> API (laptop)
  -> Postgres control-plane records
  -> matching-index invalidation event
  -> Yellowstone worker refreshes matching index (via SSE)
  -> Yellowstone gRPC stream produces transaction updates
  -> worker reconstructs and filters relevant USDC movement
  -> worker writes ClickHouse matches/exceptions
  -> API reads Postgres + ClickHouse
  -> frontend sees updated reconciliation/proof state
```

## Why There Is No Redis/Kafka Yet

The current architecture uses Postgres for durable control state, ClickHouse for events, in-process SSE for matching-index refresh, and Yellowstone as the external event stream. This is intentionally simpler than adding Redis or Kafka.

A queue/stream would become useful when:

- The API runs across multiple replicas and SSE refresh is no longer in-process.
- Background jobs need retries, visibility timeouts, durable scheduling.
- Proof generation becomes heavy enough to need a worker queue.
- Worker fleet needs partitioned high-throughput ingestion.

Adding Kafka before any of those exist would add operational weight before the product proves it needs it.

## Code Quality Reality

The backend has grown quickly. It has real tests and architecture, but route modules and service modules are still tightly coupled in places. The risk map (doc 12) tracks specifics.

```text
Do not refactor state transitions, matching invalidation, or proof generation
without tests around the current behavior.
```

# 05 Operating Guide

## Runtime Shape

The live product is a static SPA on Vercel talking to the API on a laptop (`:3100`), exposed
via a Cloudflare Tunnel (`api.decimal.finance -> 127.0.0.1:3100`), backed by a local docker
PostgreSQL. No worker, no ClickHouse.

Three databases live in the one docker Postgres container (port 54329):

- `usdc_ops` — production / the live product (`make prod-backend*`).
- `usdc_ops_local` — local dev (`make dev`).
- `usdc_ops_test` — tests (`make test-api`); truncate-based, safe to wipe.

## Local Development

```bash
make dev            # core product locally (postgres + api + frontend), one terminal
make dev devnet     # local dev on devnet (uses SOLANA_DEVNET_RPC_URL from api/.env)
make dev mainnet    # local dev on mainnet
```

Individual processes: `make dev-api`, `make dev-frontend`, `make tunnel`.

## Production-Backed Local API

```bash
make prod-backend           # alias for prod-backend-mainnet
make prod-backend-mainnet   # API + tunnel on mainnet, serving https://decimal.finance
make prod-backend-devnet    # API + tunnel on devnet (the live product currently runs devnet)
```

This starts the local API and the Cloudflare tunnel. No worker.

## Tests

```bash
make test            # api + frontend
make test-api        # API tests (against usdc_ops_test)
make test-frontend
```

`make test-api` sets `DATABASE_URL` to `usdc_ops_test`, applies the bootstrap SQL, generates
Prisma, and runs the Node tests. **Always run API tests through `make test-api`.** The
truncate-based suites `TRUNCATE` every table in `beforeEach`; run them directly (e.g.
`npx tsx --test`) and they inherit `DATABASE_URL=usdc_ops_local` from `api/.env` and wipe the
dev DB. A guard (`api/tests/helpers/require-test-database.ts`) now refuses to run unless the
connected database name ends in `_test`.

## Data: Backup, Restore, Reset

```bash
make backup-db                              # pg_dump -> backups/<db>-<timestamp>.sql (DB=usdc_ops default)
make restore-db FILE=backups/<name>.sql     # restore a dump [DB=usdc_ops]
make list-backups
make reset-data                             # truncate the local dev DB (usdc_ops_local)
make reset-prod-data                        # truncate Postgres (DATABASE_URL, prompts)
```

There is no ClickHouse reset path. Take a `make backup-db` before any destructive operation.

## Health

- `GET /health` verifies the API process is alive.
- `GET /organizations/:organizationId/ops-health` verifies Postgres and returns product state counts.
- `GET /capabilities` returns the network/config + workflow map (RPC URL exposed is the public one).

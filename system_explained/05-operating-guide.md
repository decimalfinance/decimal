# 05 Operating Guide

## Runtime Shape

The product runs locally in development: a Vite SPA and the API on a laptop (`:3100`), backed
by a local docker PostgreSQL. No worker, no ClickHouse.

(The live decimal.finance deployment — Vercel SPA + Cloudflare Tunnel to the laptop API — is
shelved during the research phase; restore the `prod-backend`/`tunnel` Make targets from git
history to bring it back.)

Two databases live in the one docker Postgres container (port 54329):

- `usdc_ops_local` — local dev (`make dev`).
- `usdc_ops_test` — tests (`make test-api`); truncate-based, safe to wipe.
- (`usdc_ops` is just the Postgres default/admin DB; the app doesn't use it.)

## Local Development

```bash
make dev            # postgres + api + frontend on devnet, one terminal
```

Individual processes: `make dev-api`, `make dev-frontend`.

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
make backup-db                              # pg_dump -> backups/<db>-<timestamp>.sql (DB=usdc_ops_local default)
make restore-db FILE=backups/<name>.sql     # restore a dump [DB=usdc_ops_local]
make list-backups
make reset-data                             # truncate the local dev DB (usdc_ops_local)
```

There is no ClickHouse reset path. Take a `make backup-db` before any destructive operation.

## Health

- `GET /health` verifies the API process is alive.
- `GET /organizations/:organizationId/ops-health` verifies Postgres and returns product state counts.
- `GET /capabilities` returns the network/config + workflow map (RPC URL exposed is the public one).

# 05 Operating Guide

## Runtime Shape

The product runs locally in development: a Vite SPA and the API on a laptop (`:3100`), backed
by a local docker PostgreSQL. No worker, no ClickHouse.

(The live decimal.finance deployment — Vercel SPA + Cloudflare Tunnel to the laptop API — is
shelved during the research phase; restore the `prod-backend`/`tunnel` Make targets from git
history to bring it back.)

Three databases live in the one docker Postgres container (port 54329), and
they cannot see each other:

- `usdc_ops_local` — what you look at in the browser (`make dev`).
- `usdc_ops_bench` — what an AI agent drives (`make bench`).
- `usdc_ops_test` — tests (`make test`); truncate-based, safe to wipe.

## The six commands

```bash
make dev     # start everything (db + api + web) -> localhost:5174
make stop    # stop everything, including docker
make test    # run all tests
make reset   # wipe local dev data (schema stays)
make bench   # background stack for AI testing -> localhost:5274
make help    # show this list
```

That is the whole surface. Devnet only — there is no network to choose.

`make dev` and `make bench` run at the same time on different ports and
different databases, so an agent testing in the background can never touch what
you have open.

## Tests

`make test` points `DATABASE_URL` at `usdc_ops_test`, applies the schema,
generates Prisma, typechecks the API, runs the Node tests, and builds the
frontend. **Always go through `make test`.** The truncate-based suites
`TRUNCATE` every table in `beforeEach`; run them directly (e.g. `npx tsx
--test`) and they inherit `DATABASE_URL=usdc_ops_local` from `api/.env` and wipe
your dev DB. A guard (`api/tests/helpers/require-test-database.ts`) refuses to
run unless the connected database name ends in `_test`.

## Data

`make reset` empties `usdc_ops_local` and `usdc_ops_bench`, keeping the schema —
it discovers tables from `pg_tables`, so it cannot go stale as the schema moves.

For a backup before something risky, see `postgres/README.md`; there are no
backup make targets because they were never once used.

## Health

- `GET /health` verifies the API process is alive.
- `GET /organizations/:organizationId/ops-health` verifies Postgres and returns product state counts.
- `GET /capabilities` returns the network/config + workflow map (RPC URL exposed is the public one).

# Postgres

## Purpose

Postgres is the control-plane database.

It stores:

- workspaces
- watched addresses
- labels
- business objects
- mappings
- onboarding state

## Local Docker Postgres

Use the local Postgres container for tests and fully local development.

```bash
docker compose up -d postgres
```

Apply the local bootstrap schema:

```bash
make sync-postgres-schema
```

## Remote Supabase Postgres

Use Supabase for the real Axoria control plane.

The API reads the remote connection string from:

- `api/.env`

Sync the Prisma schema to the remote database:

```bash
make sync-remote-postgres-schema
```

`make dev` will automatically:

- use local Docker Postgres when `DATABASE_URL` points to `localhost` or `127.0.0.1`
- use remote Postgres when `api/.env` contains a non-local `DATABASE_URL`

## Open SQL shell against local Docker Postgres

```bash
docker exec -it usdc-ops-postgres psql -U usdc_ops -d usdc_ops
```

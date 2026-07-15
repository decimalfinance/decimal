# Postgres

## Purpose

Postgres is the control-plane database.

It stores:

- organizations
- watched treasury wallets
- labels
- business objects
- mappings
- onboarding state

## Local Docker Postgres (dev + tests)

Decimal runs against the local Postgres container for local dev and tests.

```bash
docker compose up -d postgres
```

Apply the bootstrap schema (idempotent):

```bash
make sync-postgres-schema
```

`make dev` calls this automatically.

### Backups

Plain-SQL `pg_dump` into `./backups/`:

```bash
make backup-db
make list-backups
make restore-db FILE=backups/usdc_ops-<timestamp>.sql
```

The `backups/` directory is gitignored. Run a backup before any risky change.

## Open SQL shell

```bash
docker exec -it usdc-ops-postgres psql -U usdc_ops -d usdc_ops
```

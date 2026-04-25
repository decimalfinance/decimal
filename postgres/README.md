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

## Local Docker Postgres (used for both dev and prod-backend)

Axoria runs against the local Postgres container in every environment —
tests, local dev, and the production-backed runtime serving https://axoria.fun
via Cloudflare Tunnel.

```bash
docker compose up -d postgres
```

Apply the bootstrap schema (idempotent):

```bash
make sync-postgres-schema
```

`make dev` and `make prod-backend` both call this automatically.

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

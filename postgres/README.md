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

There are no backup make targets — they existed, were never used once, and
`make help` is more useful short. Before a risky change, take a dump by hand:

```bash
./scripts/compose.sh exec -T postgres \
  pg_dump -U usdc_ops -d usdc_ops_local --clean --if-exists --no-owner \
  > backup.sql

./scripts/compose.sh exec -T postgres psql -U usdc_ops -d usdc_ops_local < backup.sql
```

Always go through `scripts/compose.sh`, never `docker compose` directly — it
pins the project so a worktree can't spin up a second, empty Postgres.

## Open SQL shell

```bash
docker exec -it usdc-ops-postgres psql -U usdc_ops -d usdc_ops
```

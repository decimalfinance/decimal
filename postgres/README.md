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

## Start

```bash
docker compose up -d postgres
```

## Open SQL shell

```bash
docker exec -it usdc-ops-postgres psql -U usdc_ops -d usdc_ops
```


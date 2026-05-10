# 05 Operating Guide

## Local Development

```bash
make dev devnet
make dev mainnet
```

`make dev devnet` uses `SOLANA_DEVNET_RPC_URL` from `api/.env` when present.

`make dev` starts only Postgres, the API, and the frontend. It does not start Yellowstone, ClickHouse, or any worker.

## Tests

```bash
make test-api
make test-frontend
```

`make test-api` starts local Postgres, applies the bootstrap SQL, generates Prisma, and runs Node tests.

Current status: after the `CounterpartyWallet` refactor, the frontend build passes, but API tests need a harness update because older tests still reference deleted `destinations` and `collection_sources` tables/routes.

## Production-Backed Local API

```bash
make prod-backend-mainnet
make prod-backend-devnet
```

This starts the local API and Cloudflare tunnel. It does not start a worker.

## Reset

```bash
make reset-data
make reset-prod-data
```

Both reset PostgreSQL only. There is no ClickHouse reset path anymore.

## Health

- `GET /health` verifies the API process is alive.
- `GET /organizations/:organizationId/ops-health` verifies Postgres and returns product state counts.

# 11 Operating Testing And Debugging

This file explains how to run, test, and debug Decimal locally and on the production-backed runtime that serves https://decimal.finance.

## Run Modes

Decimal has two practical run modes; pick by intent.

### Production-backed runtime (default for demos)

```bash
make prod-backend
```

Alias for `make prod-backend-mainnet`. Brings up local Postgres and ClickHouse via docker compose, applies schemas, starts the API, kills any stale `cloudflared` and starts a fresh tunnel exposing the API as `https://api.decimal.finance`, waits for `/health`, then compiles and starts the Yellowstone worker. The deployed Vercel frontend at https://decimal.finance talks to this API. There is no local frontend in this mode.

Requires `api/.env` with a local `DATABASE_URL` and `yellowstone/.env` with `YELLOWSTONE_ENDPOINT` set (the Makefile gates the worker on the env var even though `config/worker.config.json` also carries it).

### Production-backed devnet runtime

```bash
make prod-backend-devnet
```

Starts the same laptop-hosted API + Cloudflare tunnel, but forces:

- `SOLANA_NETWORK=devnet`
- `SOLANA_RPC_URL=$SOLANA_DEVNET_RPC_URL`, falling back to `https://api.devnet.solana.com`
- `SKIP_WORKER=1`

Use this for Squads treasury creation, Privy signing, and other transaction tests that should not burn mainnet SOL. The API exposes the active network through `GET /capabilities`, and the frontend switches RPC/explorer behavior from that response.

There is no devnet Yellowstone worker in this mode. Payment and collection reconciliation will not progress on devnet until a separate devnet observer exists.

### Production-backed mainnet runtime

```bash
make prod-backend-mainnet
```

Forces `SOLANA_NETWORK=mainnet` and keeps the current Yellowstone-enabled path. Use this for real demos where live mainnet reconciliation matters.

### Full local dev stack

```bash
make dev
```

Brings up Postgres + ClickHouse, then starts API, frontend, and the worker (if `YELLOWSTONE_ENDPOINT` is set) all in one terminal. Use this when iterating on the frontend locally.

Network selectors are supported:

```bash
make dev devnet    # devnet RPC from SOLANA_DEVNET_RPC_URL; skips Yellowstone
make dev mainnet   # mainnet RPC from SOLANA_RPC_URL; starts Yellowstone if configured
```

Use `SOLANA_DEVNET_RPC_URL` in `api/.env` for your private devnet RPC. This keeps local dev commands short and prevents accidentally spending mainnet SOL during Squads treasury tests.

### Individual processes

For separate terminals:

```bash
make dev-api        # API only
make dev-frontend   # Vite frontend only
make dev-worker     # Yellowstone worker only
make tunnel         # Cloudflare tunnel only (api.decimal.finance -> localhost:3100)
```

### Infrastructure only

```bash
make infra-up
make infra-down
```

Starts/stops local Postgres + ClickHouse without any application processes.

## Run Tests

```bash
make test            # api + worker + frontend
make test-api
make test-worker
make test-frontend
```

API tests cover the API contract, ClickHouse integration, control-plane workflows, payment orders, payment-run state, and transfer-request lifecycle. Worker tests run via `cargo test --test-threads=1`. Frontend "tests" today mean the production build runs clean.

## Make output is silent by default

The Makefile has `.SILENT` set, so Make does NOT echo recipe text before running it. What you see in the terminal is the actual runtime output of the underlying commands (cargo, cloudflared, npm, docker). Don't read recipe-source text in the terminal as runtime output — that's a misread (it has happened before, especially the conditional `else echo "Skipping ..."` block inside `prod-backend` which is just a script branch, not a runtime line).

To see what a recipe would do without running it: `make -n <target>`. To trace execution: `make --trace <target>`.

## Health Checks

- `GET /health` — public liveness; runs `SELECT 1` against Postgres.
- `GET /workspaces/:workspaceId/ops-health` — workspace-scoped health: worker freshness, route health, matching latency, exception counts, ClickHouse reachability.

## Backups (local Postgres)

The "production" Postgres now runs as a docker volume on the same machine as the API. Take backups before risky changes.

```bash
make backup-db                                      # writes backups/usdc_ops-<timestamp>.sql
make list-backups
make restore-db FILE=backups/usdc_ops-<timestamp>.sql
```

`backups/` is gitignored. Plain-SQL `pg_dump` with `--clean --if-exists --no-owner` so restore is idempotent.

## Reset Data

```bash
make reset-data         # silent: TRUNCATEs known application tables in local Postgres + ClickHouse
make reset-prod-data    # prompts for "yes": dynamically TRUNCATEs every public table + all ClickHouse usdc_ops tables
```

`reset-data` is fast and used during dev/test iteration. `reset-prod-data` is more thorough (uses `pg_tables` to discover every table) and is meant for "give me a clean slate before a curated demo." Both operate on whatever `DATABASE_URL` points at — by default that's local docker.

Neither command removes the docker volume. To completely wipe and re-init from scratch:

```bash
docker compose down postgres
docker compose rm -f postgres
docker volume rm stablecoin_intelligence_postgres_data
docker compose up -d postgres   # init scripts re-run because volume is fresh
```

NEVER run `docker compose down -v` — that nukes the volume without warning.

## Operational gotchas (laptop-hosted prod)

The "production" runs on the user's laptop. Three things will silently kill the demo:

- **Mac sleep / lid close** kills cloudflared. Use `caffeinate -i make prod-backend` or set Battery preferences to prevent sleep on power.
- **Internet drop** kills the tunnel. Mobile hotspot is the backup.
- **`docker compose down -v`** nukes the Postgres volume. Don't.

The deployed `decimal.finance` frontend on Vercel keeps serving even when the laptop is offline, but every API call from the browser will fail until the tunnel is back.

## Debug A Payment That Did Not Settle

### 1. Check Payment Order

In API/frontend:

- Does the payment order exist?
- Is it approved?
- Does it have a destination?
- Does it have a source wallet if expected?
- Does it have a transfer request?
- Does it have a submitted signature?

### 2. Check Matching Index

The worker reads from `/internal/matching-index` and subscribes to `/internal/matching-index/events` (SSE). To inspect what the worker can see:

```bash
curl -s -H "x-service-token: $CONTROL_PLANE_SERVICE_TOKEN" \
  http://127.0.0.1:3100/internal/matching-index | jq '{
    version,
    workspaces: [.workspaces[] | {
      ws: .workspace.workspaceId,
      wallets: (.treasury_wallets | length),
      requests: (.matches | length)
    }]
  }'
```

If the request is not in the index, the API mutation didn't reach the worker. Check matching-index invalidation in the relevant route.

The Yellowstone worker only sees **live** slots. A request created BEFORE the worker started will never match retroactively. There is no historical backfill (open item in `list.md`).

### 3. Check Solana Transaction

- Did the transaction confirm?
- Is the worker on the same network as the wallet (currently mainnet via `solana-rpc.parafi.tech:10443`)?
- Was it the USDC mint Decimal expects?
- Did it transfer to the intended token account/wallet?
- Was the amount raw value correct?

### 4. Check ClickHouse

```sql
SELECT * FROM observed_transactions WHERE signature = '<signature>';
SELECT * FROM observed_transfers     WHERE signature = '<signature>';
SELECT * FROM observed_payments      WHERE signature = '<signature>';
SELECT * FROM settlement_matches     WHERE has(matched_signatures, '<signature>');
SELECT * FROM exceptions             WHERE signature = '<signature>';
```

`docker exec -it usdc-ops-clickhouse clickhouse-client` opens a shell against the local instance.

## Debug A Collection That Did Not Match

Collections add one extra match constraint relative to payments: the `request_matches_observed_source` guard at `yellowstone/src/yellowstone/mod.rs:1105`. For `request_type == 'collection_request'`, the matcher requires:

- An observed inbound transfer to one of the workspace's TreasuryWallet addresses, AND
- If the collection has an `expected_source_wallet_address` (set when a known `CollectionSource` is referenced or `payerWalletAddress` is supplied), the observed source wallet must equal it. If both are null, any payer matches.

So if a collection isn't matching:

- Confirm the receiver is a registered TreasuryWallet.
- Confirm the sender wallet matches the expected source (or the collection has no source set).
- Confirm amount and timing window.
- Confirm the transaction is on mainnet.

## Debug Repeated Matching Index Refreshes

Logs like `Matching index refreshed to version N` mean the worker received refresh events or refreshed on startup/reconnect.

If it refreshes constantly:

- inspect API mutation traffic
- inspect matching-index invalidation middleware
- inspect frontend polling/mutations
- inspect SSE reconnect behavior

The worker should not need polling to stay fresh.

## Debug CORS

Local frontend may run on a different port than the API. The API allows localhost / 127.0.0.1 dev origins by default. The deployed frontend at https://decimal.finance is also allowed by the API CORS config. If a browser request fails with CORS:

- check method is allowed
- check route exists
- check CORS config includes method
- check API server actually restarted after changes

## Debug Wallet Signing

If sign/submit fails:

- verify a Solana wallet (Phantom, Solflare, Backpack, etc.) is installed
- verify the connected wallet matches the required signer (usually the source TreasuryWallet)
- verify the configured RPC is reachable (`SOLANA_NETWORK=devnet` uses `https://api.devnet.solana.com` by default; `mainnet` uses `SOLANA_RPC_URL` from `api/.env` or the public mainnet fallback)
- verify recent blockhash can be fetched
- verify the source wallet has a USDC token account and balance

A 403 from RPC means a provider access issue, not necessarily an Decimal transaction bug.

## Debug CSV Import

### Payments

```csv
counterparty,destination,amount,reference,due_date
```

`counterparty` is optional human-readable context. `destination` is the external Solana wallet address of the recipient. Re-importing the same CSV returns the existing `PaymentRun` with `importResult.imported: 0` (idempotent by fingerprint); the frontend surfaces this as "This CSV was already imported as …".

### Collections

Same flow but creates a `CollectionRun` with rows targeting registered TreasuryWallets as receivers. CSV preview is at `POST /workspaces/:workspaceId/collection-runs/import-csv/preview`.

If import does nothing:

- open browser console
- check network request
- check API validation error
- verify destination/wallet validation rules

## Development Safety Rules

- Do not change payment lifecycle states without tests.
- Do not change matcher allocation behavior without tests.
- Do not change proof packet shape without checking consumers.
- Do not change API route paths without updating `api-contract.ts`.
- Do not make frontend the only place where business rules exist.
- Do not store all observed world data just because the stream has it.

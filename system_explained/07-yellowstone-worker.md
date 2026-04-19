# 07 Yellowstone Worker

The Yellowstone worker is the real-time Solana observation and matching process.

It lives in:

```text
yellowstone/
```

It is written in Rust.

## Main Entrypoints

```text
yellowstone/src/main.rs
Loads config, creates clients, starts worker.

yellowstone/src/config.rs
Reads environment variables.

yellowstone/src/control_plane.rs
Fetches matching index and receives refresh events from API.

yellowstone/src/storage.rs
Writes materialized rows into ClickHouse.

yellowstone/src/yellowstone/mod.rs
Core worker loop.
```

## Runtime Responsibilities

The worker:

1. Connects to a Yellowstone gRPC endpoint.
2. Subscribes to transaction updates.
3. Maintains a matching index from the API.
4. Reconstructs transaction context.
5. Extracts USDC transfer legs.
6. Reconstructs payment-level movement.
7. Filters for relevance.
8. Runs matching.
9. Writes ClickHouse rows.
10. Reports worker stage metrics back to the API.

## Configuration

Important environment variables:

```text
YELLOWSTONE_ENDPOINT
Required endpoint for Yellowstone gRPC.

YELLOWSTONE_TOKEN
Optional auth token for Yellowstone provider.

CLICKHOUSE_URL
ClickHouse HTTP endpoint.

CLICKHOUSE_DATABASE
Database name, usually usdc_ops.

CLICKHOUSE_USER
ClickHouse user.

CLICKHOUSE_PASSWORD
ClickHouse password.

CONTROL_PLANE_API_URL
API base URL, usually http://127.0.0.1:3100.

CONTROL_PLANE_SERVICE_TOKEN
Service token for internal API endpoints, if configured.
```

## Startup Logs

You may see logs like:

```text
Starting Yellowstone ingestor...
Endpoint: https://...
Token: Not set
ClickHouse: http://127.0.0.1:8123
Control plane: http://127.0.0.1:3100
Control plane token: Not set
Yellowstone Worker started!
Matching index refreshed to version 1.
Subscribed to updates! Waiting for data...
Matching index refreshed to version 2.
```

`Matching index refreshed` means the worker reloaded current workspace matching context from the API.

This is expected when:

- API starts.
- Worker starts.
- A wallet/destination/request/order/signature changes.
- A matching-index SSE event is emitted.

It should not refresh constantly with no relevant mutation. If it does, inspect the matching-index event source.

## Yellowstone Subscription

Subscription setup lives under:

```text
yellowstone/src/yellowstone/subscriptions.rs
```

The worker subscribes to a stream broad enough to observe USDC-related activity. The system intentionally avoids changing subscriptions every time a user adds/removes a wallet.

Some Yellowstone providers do not support `from_slot`. The worker handles errors like:

```text
from_slot is not supported
```

by reconnecting without relying on unsupported behavior.

## Transaction Context Reconstruction

Transaction context logic lives in:

```text
yellowstone/src/yellowstone/transaction_context.rs
```

It extracts:

- signature
- slot
- timestamp/block time
- account keys
- token balance changes
- instruction context
- inner instruction context

This is the raw material for identifying USDC movement.

## Transfer Reconstruction

Transfer reconstruction lives in:

```text
yellowstone/src/yellowstone/transfer_reconstruction.rs
```

It attempts to extract transfer legs from:

- SPL token transfer instructions.
- Inner instructions.
- Token balance deltas as fallback.

Each leg includes:

- source owner/account
- destination owner/account
- mint
- amount
- route/index context
- classification where possible

Important principle:

```text
If the worker cannot classify a transfer, it should not invent a misleading classification.
```

## Payment Reconstruction

Payment reconstruction lives in:

```text
yellowstone/src/yellowstone/payment_reconstruction.rs
```

It groups transfer legs into higher-level observed payments.

This is where the worker tries to understand:

- direct settlement
- routed payment
- net payment
- fee-like legs
- unrelated legs

The exact model should stay conservative. Incorrect labels hurt trust.

## Matching Logic

Matcher logic lives in:

```text
yellowstone/src/yellowstone/matcher.rs
```

It maintains an expected-payment book and allocates observed payments to transfer requests.

The matching engine supports:

- exact matches
- partial matches
- split matches
- overfills
- signature-preferred matches

It writes:

- `matcher_events`
- `settlement_matches`
- `exceptions`

## Workspace Registry Cache

Control-plane matching context is cached in the worker.

The worker should not call the API for every transaction. It should use its current matching index in memory.

Refreshes are triggered by API events.

## ClickHouse Writes

Storage logic lives in:

```text
yellowstone/src/storage.rs
```

It writes JSONEachRow through ClickHouse HTTP.

The storage layer is responsible for:

- chunking large writes
- async insert options
- row serialization
- write errors

High-volume rows belong in ClickHouse, not Postgres.

## Reconnect Behavior

The worker must handle:

- Yellowstone disconnects.
- Provider errors.
- unsupported parameters.
- API refresh failures.
- ClickHouse write failures.

The current code has reconnect/backoff behavior in the worker loop. Production hardening should make the retry policy more explicit and observable.

## Deduplication

The worker keeps recent signature state to avoid repeatedly processing the same transaction update.

ClickHouse table engines and replacement keys also protect against duplicate writes in some places.

## Worker Metrics

The worker reports stage events to the API internal ops endpoint.

These are used by:

- ops health endpoint
- Grafana dashboard
- debugging ingestion bottlenecks

Stages can include:

- stream update received
- transaction context built
- relevance checked
- transfers reconstructed
- matcher applied
- ClickHouse rows written

## Common Debugging Questions

### Why is the worker not matching my payment?

Check:

- Is the `TreasuryWallet` in Postgres? (Only treasury wallets are watched as "ours.")
- Is the expected `Destination` registered? (Matching needs the counterparty side too.)
- Did the API emit matching-index refresh?
- Does `/internal/matching-index` include the request/signature?
- Did the worker refresh its matching index after mutation?
- Is the observed transaction in ClickHouse?
- Was the payment relevant to watched wallet/token account/signature?
- Was the amount/token account correct?
- Did the transaction use USDC mint expected by the system?

### Why are there repeated label logs?

The address label resolver may be repeatedly trying Orb for unresolved addresses. This should be cached/suppressed.

### Why is `from_slot` erroring?

Some Yellowstone providers do not support from-slot replay. The worker must run in live-stream mode or use provider-specific replay/backfill strategy.


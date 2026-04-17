# 08 ClickHouse And Observability

ClickHouse stores observed and derived chain data. Grafana reads operational metrics and reconciliation health.

## Why ClickHouse Exists

Postgres is not the right place for high-volume blockchain observation.

ClickHouse is better for:

- append-heavy observations
- analytics queries
- recent activity views
- matching/event history
- latency metrics
- Grafana dashboards

## ClickHouse Schema

The schema lives at:

```text
clickhouse/init/002-schema.sql
```

## Core Tables

### `raw_observations`

Immutable raw observation stream.

Stores raw-ish Yellowstone updates and account/transaction observation metadata.

Use this for:

- debugging parser bugs
- replay analysis
- proving what the worker saw

Avoid relying on it for product UI. It can be high volume.

### `observed_transactions`

Materialized transaction-level rows.

Typical data:

- workspace id
- signature
- slot
- block time
- relevant accounts
- transaction status
- summary JSON

Use this for transaction-level drilldowns.

### `observed_transfers`

USDC transfer legs reconstructed from transaction context.

Typical data:

- signature
- amount
- mint
- source owner/account
- destination owner/account
- route/index
- classification
- workspace id

Use this for "real USDC movement".

### `observed_payments`

Higher-level reconstructed payments.

Typical data:

- signature
- gross/net amount
- source/destination
- routes
- payment kind

Use this for matching-level observation rather than raw transfer legs.

### `matcher_events`

Allocation-level matcher events.

Use this to debug:

- which observed payment allocated to which transfer request
- exact vs partial vs split behavior
- residual amounts
- allocation order

### `request_book_snapshots`

Snapshots of expected transfer request state.

The worker can hydrate expected-book state from this.

### `settlement_matches`

Current match state for transfer requests.

This is one of the most important ClickHouse tables for product reads.

It answers:

- matched amount
- match status
- matched signatures
- observed event time
- chain-to-match latency
- explanation

### `exceptions`

Worker-generated exceptions.

Examples:

- partial settlement
- overfill
- unmatched observed transfer
- signature mismatch

Postgres overlays operator state on top of these rows.

## Postgres + ClickHouse Overlay

Exceptions are split:

```text
ClickHouse
Generated technical exception facts.

Postgres
Human/operator state, assignment, notes, status.
```

This avoids writing high-volume worker findings into Postgres while still allowing operators to manage workflow state.

## Grafana

Grafana lives in:

```text
grafana/
```

It is started with:

```bash
make grafana-up
```

Local login:

```text
http://127.0.0.1:3001
admin / admin
```

Provisioned datasources:

- ClickHouse
- Postgres

Dashboard:

- Axoria Operations

## Ops Health API

The API exposes workspace ops health endpoints that combine:

- Postgres control-plane counts
- ClickHouse latest observed activity
- matching latency metrics
- route metrics
- worker stage metrics

Use this to answer:

- Is the worker alive?
- Is matching active?
- Are exceptions accumulating?
- Are routes erroring?
- Is ClickHouse reachable?

## What To Monitor

For production, important metrics include:

- Yellowstone connected/disconnected state.
- Time since last stream update.
- Time since last relevant transaction.
- Matching-index version and refresh count.
- Matching-index refresh failure count.
- ClickHouse write failures.
- Observed transaction count by minute.
- Matched settlement count by minute.
- Exception count by reason code.
- Partial settlements unresolved.
- Chain-to-match latency.
- API route p95 latency.
- API 4xx/5xx count.
- Proof generation failures.

## What Not To Build In The Product UI

Do not rebuild full operational monitoring inside the frontend.

Use Grafana for:

- ingestion throughput
- worker performance
- API error rates
- matching latency
- database health

The product UI should focus on operator workflows:

- payments
- approvals
- execution
- exceptions
- proofs

## Debugging ClickHouse

Useful checks:

```sql
SELECT count(*) FROM observed_transactions;
SELECT count(*) FROM observed_transfers;
SELECT count(*) FROM settlement_matches;
SELECT reason_code, count(*) FROM exceptions GROUP BY reason_code;
```

For a specific signature:

```sql
SELECT * FROM observed_transactions WHERE signature = '<signature>';
SELECT * FROM observed_transfers WHERE signature = '<signature>';
SELECT * FROM settlement_matches WHERE has(matched_signatures, '<signature>');
```

For a specific transfer request:

```sql
SELECT * FROM settlement_matches WHERE transfer_request_id = '<id>';
SELECT * FROM matcher_events WHERE transfer_request_id = '<id>';
```

## Retention Strategy

The current schema is MVP-oriented. A production retention strategy should define:

- how long raw observations are retained
- how long materialized observations are retained
- whether proof packets snapshot data permanently
- whether old exceptions are archived
- ClickHouse partitioning and TTLs

The principle:

```text
Keep proof/audit facts durable. Keep raw high-volume observations only as long as useful.
```


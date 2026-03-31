# Architectures

## Purpose

This document defines three realistic system architectures for `USDC Ops Layer` under the fixed constraints:

- implementation language: `Rust`
- primary analytical database: `ClickHouse`
- source chain: `Solana`
- initial asset scope: `USDC`

The goal is to choose an architecture before defining detailed data models.

## Product Context

The product is a real-time USDC monitoring, classification, and reconciliation system. It needs to:

- consume live Solana USDC activity,
- normalize raw chain updates into a canonical internal representation,
- classify events,
- store raw and derived data,
- support replay and backfill,
- and serve operational queries with low latency.

## Architecture Criteria

The architecture should be evaluated against:

1. Simplicity of initial implementation
2. Ability to replay and reprocess data
3. Flexibility when the data model changes
4. Query performance in ClickHouse
5. Operational complexity
6. Failure isolation
7. Time to MVP

## Shared Design Principles

These principles should hold regardless of which architecture we choose.

### 1. Raw data must be immutable

ClickHouse is optimized for fast inserts and append-heavy workloads. Its own deduplication and upsert guidance makes it clear that row replacement and updates are eventual, not immediate. That means raw chain observations should be treated as immutable events, not mutable rows.

### 2. Canonical internal events must be versioned

The first schema will not be the last schema. We need a versioned canonical event envelope between raw ingestion and derived projections.

### 3. Raw storage and serving storage must be separated conceptually

Even if both land in ClickHouse, we should separate:

- raw chain observations,
- normalized canonical events,
- and serving/derived tables.

### 4. Typed projections should be first-class

ClickHouse supports flexible JSON-style storage, but hot operational queries should not depend on ad hoc JSON extraction alone. Keep raw payloads for flexibility, but build typed tables for speed and correctness.

### 5. Reprocessing must exist from day one

If labels improve or classification logic changes, we need to recompute derived events without losing the original input.

## ClickHouse Constraints That Matter

These constraints shape the architecture:

- `MergeTree` is the main storage family for high-ingest analytical workloads.
- Materialized views are triggers on insert and are good for routing, transformation, and pre-aggregation, but every additional view adds insert-side work.
- Asynchronous inserts exist because too many small inserts create too many parts and can degrade the system.
- Row replacement in `ReplacingMergeTree` is eventual, not transactional.
- ClickHouse supports `JSON`, `Dynamic`, and typed columns, which is useful for preserving payloads while gradually hardening schemas.
- The Kafka engine exists and is meant to be paired with materialized views when using Kafka as an external buffer.

These points strongly favor append-only pipelines with explicit projection stages.

## Architecture 1: Single Rust Service + Direct ClickHouse

### Summary

One Rust service does everything:

- Yellowstone ingestion
- decode and normalization
- event classification
- ClickHouse writes
- optional small HTTP API

It writes directly to ClickHouse tables using batched or asynchronous inserts.

### Diagram

```text
Yellowstone gRPC
    ->
Rust service
    -> decode
    -> normalize
    -> classify
    -> batch
    ->
ClickHouse
    -> raw tables
    -> derived tables
```

### How It Works

The service subscribes to Yellowstone, groups account updates by transaction, constructs a canonical event envelope, classifies the event, and writes both raw and derived records to ClickHouse.

All business logic lives in one binary or one deployable service.

### Pros

- Fastest path to MVP
- Lowest operational complexity
- Easiest to debug end to end
- Cheap to run
- Good fit while data volume is still modest
- Easy local development

### Cons

- Weak failure isolation
- Replay and backfill logic tends to get mixed into the live pipeline
- Classification logic and ingestion logic become tightly coupled
- Harder to scale different stages independently
- If the process falls behind, all responsibilities fall behind together
- Future schema evolution can become messy if writes to multiple tables are tightly coupled

### Best When

- team size is 1 to 2
- main goal is MVP speed
- throughput is still manageable in one service
- we want to validate product usefulness before operational sophistication

### Architectural Risk

This architecture is likely to become a “god service.” It is the easiest to start and the easiest to outgrow.

## Architecture 2: Canonical Event Pipeline With ClickHouse As Event Store And Serving Store

### Summary

Use Rust services, but split responsibilities into distinct stages:

- ingest
- normalize
- classify
- serve

The source of truth is a canonical append-only event log in ClickHouse. Raw chain observations are inserted first, then normalized canonical events are written, then derived operational projections are built from those canonical events.

ClickHouse materialized views can be used selectively for routing and low-cost derivations, but business classification stays mostly in Rust.

### Diagram

```text
Yellowstone gRPC
    ->
Ingest service
    ->
ClickHouse raw_observations
    ->
Normalizer / classifier service
    ->
ClickHouse canonical_events
    ->
ClickHouse materialized views / projections
    ->
serving tables
    ->
API / UI
```

### How It Works

Stage 1 stores raw observations exactly as seen from chain ingestion, plus ingestion metadata.

Stage 2 reads raw observations, normalizes them into a stable canonical event envelope, and writes them to a canonical table.

Stage 3 builds serving tables from canonical events, either:

- in Rust, by writing explicit derived tables, or
- in ClickHouse, using materialized views and projections where the logic is stable and cheap.

### Pros

- Best balance between simplicity and long-term flexibility
- Clean replay story: raw -> canonical -> derived
- Data model changes are easier to handle because canonical versioning is explicit
- Business logic is separated from raw ingestion
- ClickHouse is used in a way that matches its strengths: append-heavy, analytical, projection-friendly
- Easier to reason about correctness and lineage
- Derived tables can be rebuilt if labels or classification logic change

### Cons

- More moving parts than Architecture 1
- Requires discipline around table contracts and pipeline stages
- Reprocessing jobs need to be designed intentionally
- Slightly slower to ship than a single-service design

### Best When

- the product is expected to evolve
- event classification logic will change repeatedly
- labels and entity resolution will improve over time
- replayability matters
- we want an architecture that can survive past MVP

### Architectural Risk

The main risk is overcomplicating the internal stages too early. The cure is to keep the number of stages low and the contracts explicit.

## Architecture 3: Message-Bus-Centered Streaming Pipeline

### Summary

Insert an external stream layer between services and storage.

Typical shape:

- Yellowstone ingestion service publishes raw events to Kafka / Redpanda / NATS JetStream
- normalizer consumes from stream and publishes canonical events
- classifier consumes canonical events and publishes derived events
- ClickHouse consumes from the bus using a sink or the Kafka engine

### Diagram

```text
Yellowstone gRPC
    ->
Rust ingest service
    ->
Kafka / Redpanda / JetStream
    ->
normalizer
    ->
canonical topic
    ->
classifier
    ->
derived topic
    ->
ClickHouse sink / Kafka engine
    ->
serving tables
```

### How It Works

The event bus becomes the backbone. Every stage is independently scalable and subscribable. ClickHouse becomes primarily the analytical and serving layer, not the workflow backbone.

### Pros

- Strongest failure isolation
- Best for independent scaling of ingestion, normalization, and classification
- Best for replaying from stream history
- Easiest to add more consumers later
- Cleanest design if the platform becomes multi-product or multi-chain

### Cons

- Highest operational burden by far
- Requires operating and monitoring another critical system
- Larger surface area for failure modes
- Slower time to MVP
- Easy to build a sophisticated system before proving the product
- ClickHouse Kafka integration is useful, but still adds another integration layer to operate

### Best When

- throughput is already very high
- multiple teams or multiple downstream consumers exist
- the product already has proven demand
- the company is building a broader data platform, not just one product

### Architectural Risk

This is the architecture most likely to be correct later and wrong now.

## Comparison

| Dimension | Architecture 1 | Architecture 2 | Architecture 3 |
|---|---|---|---|
| MVP speed | Best | Good | Worst |
| Flexibility under schema change | Moderate | Best | Best |
| Replay / reprocessing | Weak to moderate | Strong | Strong |
| Operational complexity | Lowest | Moderate | Highest |
| Failure isolation | Weak | Good | Best |
| ClickHouse fit | Good | Best | Good |
| Long-term maintainability | Moderate | Best | Good if justified by scale |
| Risk of premature complexity | Low | Moderate | Highest |

## Recommendation

The best choice is **Architecture 2**.

### Why

Architecture 1 is too coupled. It is acceptable for a throwaway prototype, but it is too easy to paint ourselves into a corner once event classification, replay, labels, and serving use cases evolve.

Architecture 3 is too heavy. It makes sense for a broader streaming platform, but not for the first serious version of this product.

Architecture 2 gives the right tradeoff:

- simple enough to build now
- structured enough to survive change
- compatible with ClickHouse’s append-heavy design
- and flexible enough to support future data model revisions

## Recommended Shape Of Architecture 2

If we choose Architecture 2, the high-level system should be:

### Runtime Components

- `ingest-worker`
  - subscribes to Yellowstone
  - writes immutable raw observations

- `event-builder`
  - reads raw observations
  - groups and normalizes them into canonical transaction-scoped events

- `classifier`
  - applies labels and event taxonomy
  - writes derived operational events

- `api`
  - reads from serving tables
  - powers the UI and exports

### ClickHouse Layers

- `raw` layer
  - append-only, high-fidelity ingestion records

- `canonical` layer
  - normalized versioned events

- `serving` layer
  - user-facing and workflow-facing tables

### Why This Helps Future Data Models

This lets us change:

- raw schema slowly,
- canonical schema carefully,
- serving schema aggressively.

That is the right asymmetry. Serving models should be easy to change. Raw models should be hard to lose.

## Architecture Decision Rule

If we optimize for:

- fastest possible prototype, choose Architecture 1.
- best balance for a real MVP, choose Architecture 2.
- future platform scale before product validation, choose Architecture 3.

For this project, we should choose **Architecture 2** unless we consciously decide to trade away replayability and flexibility for maximum short-term speed.

## Sources

- ClickHouse table engines overview: https://docs-content.clickhouse.tech/docs/en/engines/table-engines
- ClickHouse Kafka engine: https://docs-content.clickhouse.tech/docs/en/engines/table-engines/integrations/kafka
- ClickHouse Kafka integration guide: https://docs-content.clickhouse.tech/docs/en/integrations/kafka
- ClickHouse materialized views guide: https://docs-content.clickhouse.tech/docs/en/guides/developer/cascading-materialized-views
- ClickHouse materialized views blog: https://clickhouse.com/blog/using-materialized-views-in-clickhouse
- ClickHouse deduplication / upsert guidance: https://docs-content.clickhouse.tech/docs/en/guides/developer/deduplication
- ClickHouse async inserts blog: https://clickhouse.com/blog/asynchronous-data-inserts-in-clickhouse
- ClickHouse monitoring async inserts: https://clickhouse.com/blog/monitoring-asynchronous-data-inserts-in-clickhouse
- ClickHouse data types: https://docs-content.clickhouse.tech/docs/en/sql-reference/data-types
- ClickHouse JSON / Dynamic design blog: https://clickhouse.com/blog/a-new-powerful-json-data-type-for-clickhouse
- ClickHouse query optimisation guide: https://clickhouse.com/engineering-resources/clickhouse-query-optimisation-definitive-guide

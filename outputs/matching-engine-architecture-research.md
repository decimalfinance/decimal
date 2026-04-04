# Matching Engine Architecture Research

Date: 2026-04-02

## Purpose

This memo proposes realistic architectures for the next-generation matching engine.

The target is narrower than a generic payments system:

- store wallets
- create planned transfers
- observe real USDC settlement on Solana
- deterministically decide whether a planned transfer was filled, partially filled, overfilled, or left open

The engine should take inspiration from trading systems, but it should not copy an exchange blindly.

We do **not** need:

- price discovery
- a public order book
- probabilistic candidate scoring as the primary mechanism
- a UI model built around internal ontology

We **do** need:

- deterministic allocation
- replayability
- split-settlement support
- precise exception states
- auditability

## What We Should Borrow From Trading Systems

The best trading-system idea for this product is not “ranking candidates.”
It is the idea of a **resting book** plus a **deterministic allocator**.

Mapping to our system:

- `planned transfer` = resting intent
- `observed movement` = incoming execution/fill signal
- `matching engine` = allocator that applies observed quantity against open intent in a deterministic order

The useful exchange concepts are:

- single-writer determinism
- FIFO allocation inside a book
- append-only event journals
- snapshots + replay
- explicit partial-fill states

This fits the way CME describes matching as an ordered process where aggressing quantity is distributed according to defined rules, and it fits the way exchange-core describes an in-memory deterministic engine with journaling, replay, snapshots, and sharding on top of a single-writer core. Sources:

- [CME Globex Matching Algorithm Steps](https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457218521/CME+Globex+Matching+Algorithm+Steps)
- [exchange-core README](https://github.com/exchange-core/exchange-core)

## Product-Specific Constraints

Our engine is not matching buy orders to sell orders.
It is matching `observed settlement quantity` against `open planned transfer quantity`.

That changes the architecture:

- the destination address matters more than price
- one request can be filled by more than one transfer
- one transaction can split into multiple legs
- the engine must survive messy chain data and delayed observations
- the operator must see both book state and exception state

So the matching key becomes:

1. workspace
2. asset
3. destination address
4. optional source address constraint
5. FIFO by `requested_at`

## Architecture 1: Sequenced Single-Writer Book Engine

## Summary

This is the closest architecture to an exchange matching core.

One Rust matcher owns the authoritative state for a shard.
Each shard maintains two in-memory books:

- `RequestBook`
- `ObservationBook`

The matcher processes a single ordered stream of events for that shard:

- `PlannedTransferOpened`
- `PlannedTransferCancelled`
- `PlannedTransferExpired`
- `ObservedMovementArrived`
- `ObservedMovementCorrected`
- `ObservationWindowClosed`

For each event, it updates the in-memory books and emits deterministic outcomes:

- `TransferMatched`
- `TransferPartiallyFilled`
- `TransferOverfilled`
- `UnexpectedObservation`
- `AmountMismatch`
- `RequestExpired`

## Shape

```text
Postgres transfer requests
    -> control-plane projector
    -> matcher input event

ClickHouse observed movements
    -> ingest projector
    -> matcher input event

Rust sequencer
    -> shard by workspace_id + destination_address
    -> single-threaded matcher loop per shard
    -> in-memory request book + observation book
    -> append-only match/exceptions output
    -> ClickHouse serving tables
```

## Book Model

`RequestBook`

- key: `(workspace_id, asset, destination_address)`
- queue order: `requested_at ASC`, then `transfer_request_id`
- each request has:
  - `requested_amount_raw`
  - `remaining_amount_raw`
  - `status`

`ObservationBook`

- key: same as request book
- each observation has:
  - `signature`
  - `source_address`
  - `destination_address`
  - `amount_raw`
  - `remaining_amount_raw`
  - `observed_at`

The engine allocates observation quantity across the request queue deterministically.

That means split settlement becomes natural:

- if one request expects `10000`
- and we observe `9193` then `807`
- the request becomes fully filled after the second allocation

No scoring is needed for the primary path.
Only deterministic allocation rules.

## Why It Fits Us

- It matches the real product job.
- It removes fake “candidate ranking” from the core path.
- It supports split settlement naturally.
- It keeps operator reasoning simple:
  - request opened
  - request partially filled
  - request fully matched
  - request still open

## Strengths

- Best conceptual fit for our product.
- Deterministic and easy to explain.
- Fast enough with our current scale.
- Natural support for partial fills and residuals.
- Easy to replay if events are durably stored.

## Weaknesses

- Requires careful shard ownership and replay logic.
- Needs explicit snapshotting if books get large.
- Cross-shard coordination is awkward if we later add more complex multi-destination workflows.

## Best Use

Best near-term architecture.
This is the strongest choice if we want to build a real matching engine soon.

## Architecture 2: Event-Sourced Aggregate Matcher

## Summary

This architecture treats the matcher as an event-sourced domain system rather than a direct in-memory book.

All matcher-relevant facts become immutable events:

- request opened
- request cancelled
- request expired
- observation arrived
- observation linked
- match revised
- exception raised

Current state is reconstructed from replay, usually with snapshots.

This is architecturally aligned with event sourcing and actor/shard patterns.
Good references for this style:

- [Martin Fowler on Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Azure Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Akka Cluster Sharding](https://doc.akka.io/japi/akka-core/current/akka/cluster/sharding/typed/javadsl/ClusterSharding.html)

## Shape

```text
Postgres / ClickHouse facts
    -> append to matcher_event_log
    -> aggregate replayer per shard / entity
    -> in-memory aggregate state
    -> snapshots
    -> serving projections
```

Aggregate boundaries could be:

- one aggregate per request
- one aggregate per destination book
- one aggregate per workspace

For our use case, `destination book aggregate` is the cleanest.

## Why It Fits Us

This is the cleanest architecture if we believe:

- matching rules will evolve
- replay and forensics matter a lot
- we will need to revise previous match states
- auditability is product-critical

It also makes retroactive improvements possible:

- change matching rules
- replay the event log
- compare old and new outcomes

## Strengths

- Best for auditability and historical reconstruction.
- Best for debugging why a request ended up in a given state.
- Strong support for deterministic replay.
- Easy to add new projections later.

## Weaknesses

- More moving parts and more schema complexity.
- Harder to reason about initially than a direct book engine.
- Easy to overbuild if the event taxonomy grows too fast.

## Best Use

Best if we want the matcher to become a durable product core with replay, versioning, and heavy audit requirements.

## Architecture 3: Stream-Processor / CEP Matcher

## Summary

This architecture treats matching as a streaming pattern-detection problem.

Intent events and observed movement events are pushed into a durable stream system such as Kafka/Redpanda/NATS JetStream, and a stateful stream processor matches them using event-time windows and state stores.

Relevant source patterns:

- [Apache Kafka design](https://kafka.apache.org/documentation/#design)
- [NATS JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [Apache Flink CEP](https://nightlies.apache.org/flink/flink-docs-stable/docs/libs/cep/)

Flink CEP is especially relevant because it already models:

- event-time reasoning
- pattern windows
- lateness
- alternative matches

## Shape

```text
intent topic
observed movement topic
    -> stream processor
    -> keyed state store
    -> match / partial / exception outputs
    -> ClickHouse serving projections
```

## Why It Fits Us

This is attractive if we expect:

- lots of late or out-of-order observations
- high sustained throughput
- multiple observation patterns per request
- eventual multi-chain or multi-asset expansion

It is the most scalable architecture for complex temporal logic.

## Strengths

- Strong handling of late/out-of-order events.
- Native fit for time windows and multi-event patterns.
- Good long-term scale story.

## Weaknesses

- Highest infrastructure burden.
- More operational complexity than the rest of our stack needs today.
- Harder for a small team to debug than a direct single-writer engine.

## Best Use

Best if we become a genuinely high-throughput reconciliation platform with many concurrent sources and complex settlement patterns.
Not the best first architecture for our current scope.

## Architecture 4 We Should Explicitly Avoid Right Now

## SQL-Only / ClickHouse-Only Matcher

This would try to do matching primarily in SQL, materialized views, or periodic sweeps.

Why it is weak for us:

- the matcher needs deterministic allocation, not just aggregation
- split settlement requires mutable residual state
- ClickHouse materialized views are triggered on insert and are great for projections, but not ideal as the core deterministic allocator
- ClickHouse merge behavior is asynchronous, and even ClickHouse’s own materialized-view guidance warns that engines like SummingMergeTree may require additional query-time aggregation or `FINAL` to see fully merged results

Source:

- [Using Materialized Views in ClickHouse](https://clickhouse.com/blog/using-materialized-views-in-clickhouse)

ClickHouse should remain:

- raw fact store
- canonical observation store
- serving/projection store

Not the core matching brain.

## Comparison

| Architecture | Core Idea | Pros | Cons | Best Fit |
|---|---|---|---|---|
| `1. Sequenced Single-Writer Book Engine` | Sharded in-memory request/observation books with deterministic allocation | Best product fit, simple mental model, natural partial-fill support | Needs snapshotting and shard ownership discipline | Best current choice |
| `2. Event-Sourced Aggregate Matcher` | Immutable matcher event log + replayed aggregate state | Best auditability, best replay story, easy rule evolution | More complex to build and operate | Good if we want versioned replay from day one |
| `3. Stream-Processor / CEP Matcher` | Event-time windows and stateful stream joins | Strongest for late/out-of-order and high scale | Highest infra/ops burden | Better later, not first |

## Recommendation

The best architecture for the next build phase is:

## `Architecture 1: Sequenced Single-Writer Book Engine`

But it should borrow two design disciplines from Architecture 2:

- append-only matcher event journal
- snapshots for replay and recovery

That gives us the right hybrid:

- order-book-style deterministic allocation
- replayability and auditability
- no unnecessary stream platform yet

## Recommended Concrete Design

## 1. Use destination-scoped FIFO books

Book key:

- `workspace_id`
- `asset`
- `destination_address`

Queue order:

- `requested_at`
- `transfer_request_id`

## 2. Represent observations as allocatable quantity

Each observed movement should have:

- `observed_movement_id`
- `signature`
- `source_address`
- `destination_address`
- `amount_raw`
- `remaining_amount_raw`
- `observed_at`

## 3. Run one single-threaded matcher loop per shard

Shard key:

- start with `workspace_id`
- if needed later, move to `(workspace_id, destination_address hash)`

Do not let multiple workers mutate the same book concurrently.

This is the most important lesson to borrow from exchange architecture.

## 4. Persist outcomes as events, not just current rows

Emit immutable matcher events such as:

- `request_opened`
- `observation_received`
- `request_partially_filled`
- `request_filled`
- `observation_unallocated`
- `request_expired`

Then project current state into:

- `settlement_matches`
- `exceptions`
- `reconciliation_rows`

## 5. Keep the first rule set brutally narrow

v1 matching order:

1. same workspace
2. same asset
3. same destination address
4. FIFO by `requested_at`
5. allocate exact quantity until request is filled or observation is exhausted

That gives us:

- exact fill
- partial fill
- overfill residue
- unexpected credit residue

without scoring.

## 6. Add time windows as eligibility constraints, not ranking heuristics

For v1:

- ignore requests outside the active window
- among eligible requests, allocate FIFO

This is much cleaner than a ranking engine.

## 7. Add source constraints later as tie-break restrictions

Source should not be the first partition key.
Destination book first.
Source can be:

- a stricter filter
- or a secondary validation rule

## What This Means For Our Codebase

We should stop thinking in terms of:

- “find best candidate by score”

and start thinking in terms of:

- “maintain an open request book and allocate observed quantity deterministically”

That is the architectural shift.

## Build Order After This Research

1. Define `matcher_events` and `book_snapshots`
2. Build `RequestBook` and `ObservationBook` in Rust
3. Route events to one shard owner
4. Implement deterministic FIFO allocation for one destination book
5. Add split-settlement handling
6. Project book state into reconciliation rows and exceptions
7. Only later consider richer source constraints and more complex book partitioning

## Bottom Line

The matching engine should look more like a **fill allocator** than a **candidate scorer**.

The best first architecture is:

- single-writer
- shard-owned
- destination-book-based
- append-only
- replayable

That is the cleanest path from our current system to a proper matching engine.

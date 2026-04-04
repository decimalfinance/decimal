# Provenance: Matching Engine Architecture Research

Date: 2026-04-02

## Local Inputs

- [MATCHING_ENGINE_SPEC.md](/Users/fuyofulo/code/stablecoin_intelligence/MATCHING_ENGINE_SPEC.md)
- [IMPLEMENTATION_BLUEPRINT.md](/Users/fuyofulo/code/stablecoin_intelligence/IMPLEMENTATION_BLUEPRINT.md)
- [PRODUCT_SPEC.md](/Users/fuyofulo/code/stablecoin_intelligence/PRODUCT_SPEC.md)

## External Sources Consulted

### Matching / exchange-system references

1. CME Group:
   - [CME Globex Matching Algorithms](https://cmegroupclientsite.atlassian.net/wiki/display/EPICSANDBOX/CME%2BGlobex%2BMatching%2BAlgorithms)
   - [CME Globex Matching Algorithm Steps](https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457218521/CME+Globex+Matching+Algorithm+Steps)
   - Used for the idea of explicit ordered allocation rules such as FIFO and pro-rata.

2. exchange-core:
   - [exchange-core README](https://github.com/exchange-core/exchange-core)
   - Used for the ideas of in-memory working state, disk journaling, replay, snapshots, deterministic matching, and shard-based processing.

### Event-sourcing / aggregate-system references

3. Martin Fowler:
   - [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
   - Used for replay, historical reconstruction, and immutable event-log framing.

4. Microsoft Azure Architecture Center:
   - [Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
   - Used for event-store plus materialized-view guidance and event-sourced system tradeoffs.

5. Akka:
   - [Cluster Sharding](https://doc.akka.io/japi/akka-core/current/akka/cluster/sharding/typed/javadsl/ClusterSharding.html)
   - Used for shard-owned stateful entity architecture.

### Stream-processing references

6. Apache Kafka:
   - [Kafka design documentation](https://kafka.apache.org/documentation/#design)
   - Used for durable-log and stream-processing framing.

7. Apache Flink:
   - [Flink CEP](https://nightlies.apache.org/flink/flink-docs-stable/docs/libs/cep/)
   - Used for event-time windows, alternative matches, and pattern detection.

8. NATS:
   - [JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)
   - Used as an example of a lighter durable-stream substrate.

### Database / serving-layer references

9. ClickHouse:
   - [Using Materialized Views in ClickHouse](https://clickhouse.com/blog/using-materialized-views-in-clickhouse)
   - Used to support the recommendation that ClickHouse should remain a projection/serving layer rather than the core mutable allocator.

10. PostgreSQL:
   - [Explicit Locking / Advisory Locks](https://www.postgresql.org/docs/9.0/explicit-locking.html)
   - Used as background for shard ownership / worker coordination ideas where needed.

## Synthesis Notes

- The recommendation for a `single-writer destination-book matcher` is a synthesis, not a direct copy of any one source.
- The memo intentionally rejects “candidate scoring” as the primary architecture and instead reframes the core as `deterministic quantity allocation`.
- The recommended path is a hybrid:
  - exchange-style deterministic allocation
  - event-sourcing discipline for replay
  - ClickHouse as projection, not as the matching brain

# ClickHouse

## Start

```bash
docker compose up -d clickhouse
```

## Stop

```bash
docker compose down
```

## Open SQL shell

```bash
docker exec -it usdc-ops-clickhouse clickhouse-client
```

## Database

The init scripts create the `usdc_ops` database and the first-pass schema for:

- workspace configuration
- raw ingestion
- canonical normalized events
- workspace interpretation
- serving tables

Runtime state is stored in Docker named volumes, not in this repository.

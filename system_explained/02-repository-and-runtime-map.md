# 02 Repository And Runtime Map

This repository contains one product split across several runtime processes.

## Top-Level Layout

```text
.
├── api/                 TypeScript Express control-plane API
├── frontend/            React/Vite human interface
├── yellowstone/         Rust Solana Yellowstone ingestion and matching worker
├── postgres/            Postgres initialization scripts
├── clickhouse/          ClickHouse initialization scripts
├── grafana/             Grafana provisioning and dashboards
├── outputs/             Research/application/proof artifacts
├── problems/            Problem writeups and logs
├── Makefile             Local development and test commands
├── docker-compose.yml   Local Postgres, ClickHouse, Grafana
└── list.md              Product implementation checklist
```

## Runtime Processes

Local development usually starts these processes:

```text
Postgres
Control-plane relational database.

ClickHouse
Event/reconciliation/observability database.

API
Express server at http://127.0.0.1:3100.

Frontend
Vite app, usually at http://localhost:5174 or whatever Vite chooses.

Yellowstone worker
Rust process that connects to a Solana Yellowstone endpoint and writes ClickHouse.

Grafana
Optional local dashboards at http://127.0.0.1:3001.
```

## Important Commands

### Start Local Infrastructure

```bash
make infra-up
```

Starts Postgres and ClickHouse, waits for them, and applies schema sync.

### Start Full Development Stack

```bash
make dev
```

Starts infrastructure, API, frontend, and the Yellowstone worker if `YELLOWSTONE_ENDPOINT` is set.

### Start Grafana

```bash
make grafana-up
```

Starts Postgres, ClickHouse, and Grafana. Grafana is available at:

```text
http://127.0.0.1:3001
username: admin
password: admin
```

### Run Tests

```bash
make test
```

Runs:

- API tests.
- Worker Rust tests.
- Frontend tests.

Individual commands:

```bash
make test-api
make test-worker
make test-frontend
```

### Reset Local Data

```bash
make reset-data
```

Stops the docker services, deletes local volumes, restarts infra, and syncs Prisma schema.

Use this only when you intentionally want a clean local database.

## Docker Services

`docker-compose.yml` defines:

### Postgres

```text
container: usdc_ops_postgres
port: 54329
database: usdc_ops
user: usdc_ops
password: usdc_ops
```

### ClickHouse

```text
container: usdc_ops_clickhouse
ports: 8123 HTTP, 9000 native
database: usdc_ops
user: default
password: empty
```

### Grafana

```text
container: axoria_grafana
port: 3001
username: admin
password: admin
```

Grafana has provisioned Postgres and ClickHouse datasources.

## Data Ownership

Postgres and ClickHouse have different roles.

Postgres owns the control-plane truth:

- Users.
- Organizations.
- Workspaces.
- Addresses.
- Destinations.
- Payees.
- Payment requests.
- Payment runs.
- Payment orders.
- Transfer requests.
- Approval policy.
- Approval decisions.
- Execution records.
- Operator notes.
- Exception metadata.
- API keys.
- Idempotency records.

ClickHouse owns high-volume observed and derived data:

- Raw Yellowstone observations.
- Observed transactions.
- Observed USDC transfers.
- Reconstructed observed payments.
- Matching events.
- Current settlement matches.
- Worker-generated exceptions.

This split is important. Do not move high-volume chain event data into Postgres casually.

## Control Flow Between Services

The main runtime path is:

```text
Frontend or agent
  -> API
  -> Postgres control-plane records
  -> matching-index invalidation event
  -> Yellowstone worker refreshes matching index
  -> Yellowstone stream produces transaction updates
  -> worker reconstructs and filters relevant USDC movement
  -> worker writes ClickHouse matches/exceptions
  -> API reads Postgres + ClickHouse
  -> frontend/agent sees updated reconciliation/proof state
```

## Why There Is No Redis/Kafka Yet

The current architecture uses:

- Postgres for durable control state.
- ClickHouse for event/reconciliation storage.
- In-process Server-Sent Events for matching-index refresh and agent-task refresh.
- Yellowstone as the external event stream.

This is intentionally simpler than adding Redis or Kafka. A queue/stream would become useful if:

- Matching refresh events become unreliable across multiple API replicas.
- Background jobs need retries, visibility timeouts, and durable scheduling.
- Export/proof generation becomes heavy enough to need a worker queue.
- The worker fleet needs partitioned high-throughput ingestion.

For the current MVP, adding Kafka would add operational weight before the product proves it needs it.

## Code Quality Reality

The backend has grown quickly. It has real tests and real architecture, but it also has areas where route modules and service modules are still tightly coupled. The docs call these out in the risk map.

Important rule for future refactors:

```text
Do not refactor state transitions, matching invalidation, or proof generation without tests around the current behavior.
```


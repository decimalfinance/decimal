# 14 Code Module Index

This file explains what important source files do.

It is a lookup map for new engineers.

## API Modules

### `api/src/app.ts`

Express app factory.

Owns:

- middleware order
- public route mounting
- auth boundary
- protected route mounting
- error handler
- matching-index invalidation middleware

If routes are unreachable or auth behaves strangely, start here.

### `api/src/server.ts`

Starts the HTTP server from the app.

### `api/src/config.ts`

Environment/config parsing for the API.

### `api/src/prisma.ts`

Prisma client singleton.

### `api/src/auth.ts`

Authentication middleware and bearer token parsing.

Owns:

- user-session auth
- API-key auth
- workspace scoping for API keys
- API-key route scope mapping

### `api/src/api-keys.ts`

API key creation/authentication/list/revoke helpers.

Owns:

- token generation
- token hashing
- default agent scopes
- last used timestamp

### `api/src/idempotency.ts`

Idempotency middleware for mutation routes.

Important for API-first/agent clients.

### `api/src/api-contract.ts`

Canonical API contract metadata.

Used by OpenAPI generation and contract tests.

### `api/src/openapi.ts`

Builds OpenAPI JSON from API contract metadata.

### `api/src/api-errors.ts`

Known API/domain error mapping.

Should grow as generic `Error` usage is reduced.

### `api/src/api-format.ts`

Formatting helpers for API responses.

### `api/src/rate-limit.ts`

Rate limiting middleware.

### `api/src/route-helpers.ts`

Common route helpers such as async error wrapping.

### `api/src/workspace-access.ts`

Access control helpers for workspace-scoped routes.

Use this in protected workspace routes.

### `api/src/workspace-addresses.ts`

Workspace address CRUD and serialization.

### `api/src/destinations.ts`

Counterparty and destination management.

Owns:

- destination creation/update
- trust/scope handling
- linked workspace address behavior
- duplicate/name validation

### `api/src/payees.ts`

Payee management.

Payees are lightweight input-layer entities.

### `api/src/payment-requests.ts`

Payment request service.

Owns:

- manual request creation
- CSV import and preview
- promote request to order
- cancel request
- request read models

### `api/src/payment-runs.ts`

Payment run/batch service.

Owns:

- CSV batch import
- run detail read model
- batch execution packet preparation
- run signature attachment
- run state transitions
- run proof inputs

### `api/src/payment-run-state.ts`

Payment run state definitions and validation.

### `api/src/payment-orders.ts`

Payment order service.

Owns:

- order creation
- duplicate checks
- submit/policy evaluation
- transfer request creation
- update/cancel
- create execution record
- prepare execution packet
- attach signature
- read model serialization
- reconciliation detail integration

This is one of the most important modules in the backend.

### `api/src/payment-order-state.ts`

Payment order state definitions and validation.

### `api/src/payment-order-proof.ts`

Payment order proof assembly.

### `api/src/payment-run-proof.ts`

Payment run proof assembly.

### `api/src/payment-proof-markdown.ts`

Human-readable payment proof Markdown rendering.

### `api/src/proof-packet.ts`

Canonical digest/proof helpers.

### `api/src/approval-policy.ts`

Approval policy creation/evaluation.

Owns:

- default policy
- destination trust checks
- internal/external approval toggles
- amount thresholds
- human summary of approval reasons

### `api/src/execution-records.ts`

Execution record creation and serialization.

### `api/src/transfer-request-lifecycle.ts`

Transfer request lifecycle state definitions and transition helpers.

### `api/src/transfer-request-events.ts`

Transfer request timeline event creation.

### `api/src/reconciliation.ts`

Reads ClickHouse reconciliation/matching/exception data and overlays Postgres metadata.

Owns:

- observed transfers reads
- reconciliation queue
- reconciliation detail
- exception list/detail/actions/notes

### `api/src/reconciliation-timeline.ts`

Builds reconciliation timeline views.

### `api/src/observed-transfers.ts`

Observed transfer read helpers.

### `api/src/clickhouse.ts`

ClickHouse HTTP client/query helpers.

### `api/src/address-label-registry.ts`

Address label resolution.

Owns:

- workspace/manual label lookups
- Orb tag resolver integration
- unresolved label behavior

This module has had log-noise issues when Orb returns no labels.

### `api/src/solana.ts`

Solana-specific helpers.

Owns:

- USDC mint/decimals constants
- ATA derivation
- transfer instruction construction

### `api/src/agent-tasks.ts`

Builds agent task list from approvals, payment orders, and exceptions.

### `api/src/agent-task-events.ts`

SSE event helpers for agent task updates.

### `api/src/matching-index-events.ts`

SSE/event helpers for matching-index refresh.

Critical for keeping worker updated without polling.

### `api/src/ops-metrics.ts`

In-memory API/worker stage metrics.

Used by ops health/Grafana.

### `api/src/workspace-audit-log.ts`

Workspace audit log helpers.

### `api/src/actor.ts`

Actor helper utilities for user/API-key context.

### `api/src/axoria-client.ts`

Internal/client helper surface if used by scripts or tests.

## API Route Modules

### `api/src/routes/auth.ts`

Login/session/logout.

### `api/src/routes/organizations.ts`

Organization/workspace routes.

### `api/src/routes/addresses.ts`

Workspace address routes.

### `api/src/routes/destinations.ts`

Counterparty and destination routes.

### `api/src/routes/payees.ts`

Payee routes.

### `api/src/routes/payment-requests.ts`

Payment request routes.

### `api/src/routes/payment-runs.ts`

Payment run routes.

### `api/src/routes/payment-orders.ts`

Payment order routes.

### `api/src/routes/approvals.ts`

Approval policy/inbox/decision routes.

### `api/src/routes/transfer-requests.ts`

Legacy/lower-level expected settlement routes.

### `api/src/routes/events.ts`

Observed transfer, reconciliation, and exception routes.

### `api/src/routes/ops.ts`

Members, export jobs, audit log, CSV exports, ops health.

### `api/src/routes/api-keys.ts`

Workspace API-key routes.

### `api/src/routes/agent.ts`

Agent task routes.

### `api/src/routes/internal.ts`

Worker/internal routes.

### `api/src/routes/openapi.ts`

OpenAPI route.

### `api/src/routes/health.ts`

Health route.

### `api/src/routes/capabilities.ts`

Capabilities route.

### `api/src/routes/address-labels.ts`

Address label routes.

## Yellowstone Modules

### `yellowstone/src/main.rs`

Worker process entrypoint.

### `yellowstone/src/config.rs`

Environment/config parsing.

### `yellowstone/src/control_plane.rs`

API client for matching index, workspace registry, SSE refresh, and worker metrics.

### `yellowstone/src/storage.rs`

ClickHouse writer and row definitions.

### `yellowstone/src/yellowstone/mod.rs`

Core worker loop.

Owns:

- connection loop
- update handling
- relevance filtering
- matcher hydration
- buffer flushing
- write orchestration

### `yellowstone/src/yellowstone/client.rs`

Yellowstone gRPC client setup.

### `yellowstone/src/yellowstone/subscriptions.rs`

Subscription request construction.

### `yellowstone/src/yellowstone/transaction_context.rs`

Transaction/update decoding into internal context.

### `yellowstone/src/yellowstone/transfer_reconstruction.rs`

USDC transfer leg reconstruction.

### `yellowstone/src/yellowstone/payment_reconstruction.rs`

Payment-level reconstruction from transfer legs.

### `yellowstone/src/yellowstone/matcher.rs`

Orderbook/FIFO/signature-aware matching engine.

### `yellowstone/src/yellowstone/formatting.rs`

Formatting helpers.

## Frontend Modules

### `frontend/src/main.tsx`

React entrypoint.

### `frontend/src/App.tsx`

Main app routes/pages/components.

Large file. Candidate for splitting.

### `frontend/src/Sidebar.tsx`

App navigation/sidebar.

### `frontend/src/api.ts`

HTTP client and typed API wrappers.

### `frontend/src/types.ts`

Frontend type definitions for API data.

### `frontend/src/status-labels.ts`

User-facing state labels and action labels.

### `frontend/src/domain.ts`

Frontend domain helpers.

### `frontend/src/csv-parse.ts`

CSV parsing helpers.

### `frontend/src/lib/solana-wallet.ts`

Browser wallet detection, selection, signing/submission helpers.

### `frontend/src/proof-json-view.tsx`

Proof JSON display.

### `frontend/src/ui-primitives.tsx`

Shared UI primitives.

### `frontend/src/styles.css`

Current visual system.

## Infrastructure Files

### `Makefile`

Local development, infra, tests, Grafana, reset, latency report.

### `docker-compose.yml`

Postgres, ClickHouse, Grafana.

### `postgres/init/001-control-plane.sql`

Postgres init script.

### `clickhouse/init/002-schema.sql`

ClickHouse schema.

### `grafana/provisioning/`

Grafana datasource/dashboard provisioning.

## Test Files

### `api/tests/control-plane.test.ts`

End-to-end backend control-plane workflow coverage.

### `api/tests/payment-orders.test.ts`

Payment order behavior.

### `api/tests/payment-run-state.test.ts`

Payment run state derivation.

### `api/tests/transfer-request-lifecycle.test.ts`

Transfer request lifecycle.

### `api/tests/api-contract.test.ts`

API contract/OpenAPI consistency.

### `api/tests/clickhouse.test.ts`

ClickHouse integration behavior.

## How To Add A New Feature Cleanly

1. Define the product object and lifecycle.
2. Add/modify Prisma model if needed.
3. Add service logic outside routes.
4. Add route validation.
5. Add route to `api-contract.ts`.
6. Add tests.
7. Add matching-index invalidation if reconciliation-relevant.
8. Add frontend API wrapper.
9. Add frontend page/component.
10. Add docs if it changes architecture or workflow.


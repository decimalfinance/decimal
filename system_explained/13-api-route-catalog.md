# 13 API Route Catalog

This catalog explains the active API routes by product area.

The source of truth for exact schemas should be:

- route files in `api/src/routes/`
- `api/src/api-contract.ts`
- generated `/openapi.json`

This document is for humans trying to understand what exists and why.

## Public Routes

### Health

```text
GET /health
```

Checks API health and database reachability.

### Capabilities

```text
GET /capabilities
```

Returns product/API capabilities used by clients.

### OpenAPI

```text
GET /openapi.json
```

Returns generated OpenAPI spec.

### Auth

```text
POST /auth/login
GET  /auth/session
POST /auth/logout
```

`POST /auth/login` is email-based. It creates/resumes a user session.

`GET /auth/session` and `POST /auth/logout` require auth.

## Organizations And Workspaces

```text
GET  /organizations
POST /organizations
POST /organizations/:organizationId/join
GET  /organizations/:organizationId/workspaces
POST /organizations/:organizationId/workspaces
POST /organizations/:organizationId/demo-workspace
```

These routes manage top-level tenancy.

Important:

- Most operational objects are workspace-scoped.
- Organization membership controls workspace access for user sessions.
- API keys are already workspace-scoped.

## Address Labels

```text
GET   /address-labels
POST  /address-labels
PATCH /address-labels/:addressLabelId
```

Used to resolve and store human labels for raw addresses.

This is separate from destinations/payees.

## Workspace Addresses

```text
GET   /workspaces/:workspaceId/addresses
POST  /workspaces/:workspaceId/addresses
PATCH /workspaces/:workspaceId/addresses/:workspaceAddressId
```

Manage raw wallet/address records.

Use these for:

- source wallets
- destination-linked wallets
- watched addresses

## Counterparties And Destinations

```text
GET   /workspaces/:workspaceId/counterparties
POST  /workspaces/:workspaceId/counterparties
PATCH /workspaces/:workspaceId/counterparties/:counterpartyId

GET   /workspaces/:workspaceId/destinations
POST  /workspaces/:workspaceId/destinations
PATCH /workspaces/:workspaceId/destinations/:destinationId
```

Counterparties are business entities.

Destinations are payment endpoints with trust/scope metadata.

Destinations are the object payment orders should target.

## Payees

```text
GET   /workspaces/:workspaceId/payees
POST  /workspaces/:workspaceId/payees
GET   /workspaces/:workspaceId/payees/:payeeId
PATCH /workspaces/:workspaceId/payees/:payeeId
```

Payees are lightweight input-layer entities.

A payee can have a default destination.

## Payment Requests

```text
GET  /workspaces/:workspaceId/payment-requests
POST /workspaces/:workspaceId/payment-requests
POST /workspaces/:workspaceId/payment-requests/import-csv
POST /workspaces/:workspaceId/payment-requests/import-csv/preview
GET  /workspaces/:workspaceId/payment-requests/:paymentRequestId
POST /workspaces/:workspaceId/payment-requests/:paymentRequestId/promote
POST /workspaces/:workspaceId/payment-requests/:paymentRequestId/cancel
```

Payment requests are the input layer.

CSV import creates payment requests from tabular data.

Promotion turns a request into a payment order.

## Payment Runs

```text
GET    /workspaces/:workspaceId/payment-runs
POST   /workspaces/:workspaceId/payment-runs/import-csv
POST   /workspaces/:workspaceId/payment-runs/import-csv/preview
GET    /workspaces/:workspaceId/payment-runs/:paymentRunId
DELETE /workspaces/:workspaceId/payment-runs/:paymentRunId
POST   /workspaces/:workspaceId/payment-runs/:paymentRunId/cancel
POST   /workspaces/:workspaceId/payment-runs/:paymentRunId/close
POST   /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution
POST   /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature
GET    /workspaces/:workspaceId/payment-runs/:paymentRunId/proof
```

Payment runs are batch workflows.

Common lifecycle:

```text
import CSV -> review run -> prepare batch execution -> attach signature -> reconcile -> proof
```

## Payment Orders

```text
GET   /workspaces/:workspaceId/payment-orders
POST  /workspaces/:workspaceId/payment-orders
GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId
PATCH /workspaces/:workspaceId/payment-orders/:paymentOrderId
POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit
POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/cancel
POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/create-execution
POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution
POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature
GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof
GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId/audit-export
```

Payment orders are the primary control-plane payment object.

Key actions:

- submit for policy evaluation
- prepare execution
- attach submitted signature
- export proof

## Approval Policy And Inbox

```text
GET   /workspaces/:workspaceId/approval-policy
PATCH /workspaces/:workspaceId/approval-policy
GET   /workspaces/:workspaceId/approval-inbox
POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/approval-decisions
```

Approval policy defines when payment requests/orders require review.

Approval decisions attach to transfer requests.

## Transfer Requests

```text
GET   /workspaces/:workspaceId/transfer-requests
GET   /workspaces/:workspaceId/transfer-requests/:transferRequestId
POST  /workspaces/:workspaceId/transfer-requests
POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/submit
POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/transition
POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/notes
PATCH /workspaces/:workspaceId/transfer-requests/:transferRequestId
```

Transfer requests are the lower-level expected settlement object.

These routes still exist because the matcher and earlier product flows use them.

Long-term, most user-facing flows should start with payment requests/runs/orders, not raw transfer requests.

## Observed Events And Reconciliation

```text
GET  /workspaces/:workspaceId/transfers
GET  /workspaces/:workspaceId/reconciliation
GET  /workspaces/:workspaceId/reconciliation-queue
GET  /workspaces/:workspaceId/reconciliation/:transferRequestId
GET  /workspaces/:workspaceId/reconciliation/:transferRequestId/explain
POST /workspaces/:workspaceId/reconciliation/:transferRequestId/refresh
```

These routes read observed settlement/matching state from ClickHouse through the API.

Use them for:

- real USDC movement
- request/order settlement details
- reconciliation explanations
- manual refresh/debugging

## Exceptions

```text
GET   /workspaces/:workspaceId/exceptions
PATCH /workspaces/:workspaceId/exceptions/:exceptionId
GET   /workspaces/:workspaceId/exceptions/:exceptionId
POST  /workspaces/:workspaceId/exceptions/:exceptionId/actions
POST  /workspaces/:workspaceId/exceptions/:exceptionId/notes
```

Exceptions are generated by the worker and managed by operators through Postgres overlay metadata.

Actions include things like reviewed/dismissed depending on implementation.

## Ops And Exports

```text
GET /workspaces/:workspaceId/members
GET /workspaces/:workspaceId/export-jobs
GET /workspaces/:workspaceId/audit-log
GET /workspaces/:workspaceId/exports/reconciliation
GET /workspaces/:workspaceId/exports/exceptions
GET /workspaces/:workspaceId/exports/audit/:transferRequestId
GET /workspaces/:workspaceId/ops-health
```

These routes support operators and monitoring.

`ops-health` combines API/Postgres/ClickHouse/worker metrics.

## API Keys

```text
GET    /workspaces/:workspaceId/api-keys
POST   /workspaces/:workspaceId/api-keys
POST   /workspaces/:workspaceId/api-keys/:apiKeyId/revoke
DELETE /workspaces/:workspaceId/api-keys/:apiKeyId
```

API keys are used by agents and scripts.

## Agent Tasks

```text
GET /workspaces/:workspaceId/agent/tasks
GET /workspaces/:workspaceId/agent/tasks/events
```

Task list for agents.

Includes:

- approval review tasks
- execution preparation tasks
- settlement watch tasks
- reconciliation review tasks
- exception review tasks

## Internal Worker Routes

```text
GET  /internal/workspaces
GET  /internal/workspaces/:workspaceId/matching-context
GET  /internal/matching-index
GET  /internal/matching-index/events
POST /internal/worker-stage-events
GET  /internal/ops-metrics
```

These routes are for the worker and operational internals.

Do not build product UI directly around internal routes.

## Route Change Checklist

When adding/changing a route:

1. Update route implementation.
2. Update service logic.
3. Update `api-contract.ts`.
4. Update tests.
5. Update frontend client if used by frontend.
6. Update this catalog if route is important.
7. Consider API-key scope requirements.
8. Consider idempotency behavior.
9. Consider matching-index invalidation if the route changes matching-relevant state.


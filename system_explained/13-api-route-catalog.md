# 13 API Route Catalog

This file lists the HTTP routes the Axoria API currently exposes, grouped by responsibility. Routes are defined in `api/src/routes/*.ts` and mounted in `api/src/app.ts`. The machine-readable contract lives in `api/src/api-contract.ts` and is served at `/openapi.json`.

All workspace-scoped routes require authentication — either a user session (`Authorization: Bearer <session-token>`) or an API key (`Authorization: Bearer axoria_live_<id>.<secret>`).

## Public Routes (No Auth)

- `GET /health` — liveness ping.
- `GET /capabilities` — advertised feature set and versions.
- `GET /openapi.json` — OpenAPI 3 spec generated from `api-contract.ts`.
- `POST /auth/login` — email-based session creation.
- `GET /auth/session` — returns the authenticated session (requires auth).
- `POST /auth/logout` — invalidates the current session.

## Organizations And Workspaces

- `GET  /organizations` — orgs the authenticated user belongs to.
- `POST /organizations` — create an organization.
- `POST /organizations/:organizationId/join` — join an existing org (by invite code or similar).
- `GET  /organizations/:organizationId/workspaces` — list workspaces in an org.
- `POST /organizations/:organizationId/workspaces` — create a workspace.

## Treasury Wallets

Replaces the old `/addresses` routes.

- `GET   /workspaces/:workspaceId/treasury-wallets` — list wallets the workspace owns.
- `GET   /workspaces/:workspaceId/treasury-wallets/balances` — live Solana balances for every wallet: lamports, USDC raw, plus the workspace's current SOL/USD price from `pricing.ts` (Binance SOLUSDT, 60s cache, stale fallback). This is what the Overview and Wallets pages render.
- `POST  /workspaces/:workspaceId/treasury-wallets` — register a wallet. Body: `{ address, chain?, source?, assetScope?, displayName?, notes?, usdcAtaAddress?, propertiesJson? }`. The USDC ATA is derived automatically if not supplied.
- `PATCH /workspaces/:workspaceId/treasury-wallets/:treasuryWalletId` — update display name / notes / active flag.

Treasury wallets are the **only** addresses the Yellowstone worker watches as "ours." Do not store counterparty wallets here — use `Destination` for those.

## Counterparties And Destinations

Destinations are what you pay; counterparties are an optional org-scoped entity tag on top.

- `GET   /workspaces/:workspaceId/counterparties` — list counterparties.
- `POST  /workspaces/:workspaceId/counterparties` — create. Body: `{ displayName, category, externalReference?, status?, metadataJson? }` (category is required).
- `PATCH /workspaces/:workspaceId/counterparties/:counterpartyId` — update.
- `GET   /workspaces/:workspaceId/destinations` — list destinations.
- `POST  /workspaces/:workspaceId/destinations` — create. Body: `{ counterpartyId?, chain?, asset?, walletAddress, tokenAccountAddress?, destinationType?, trustState?, label, notes?, isInternal?, isActive?, metadataJson? }`. `trustState` defaults to `unreviewed`; `isInternal` defaults to `false`.
- `PATCH /workspaces/:workspaceId/destinations/:destinationId` — update any editable field (label, trust state, counterparty tag, notes, active flag). Unique `(workspaceId, walletAddress)` is enforced.

There are **no `/payees` routes**. Payees were removed — use a destination + optional counterparty.

## Address Labels

Generic chain-wide label registry (not workspace-scoped).

- `GET   /address-labels` — list.
- `POST  /address-labels` — create.
- `PATCH /address-labels/:addressLabelId` — update.

## Payment Requests

Input-layer objects. These are what a human or agent creates before a payment order exists.

- `GET  /workspaces/:workspaceId/payment-requests` — list.
- `POST /workspaces/:workspaceId/payment-requests` — create a single request. Accepts flags `createOrderNow` and `submitOrderNow` to collapse the request → order → submit steps.
- `POST /workspaces/:workspaceId/payment-requests/import-csv` — bulk import without wrapping into a `PaymentRun`.
- `POST /workspaces/:workspaceId/payment-requests/import-csv/preview` — parse and validate a CSV without writing anything.
- `GET  /workspaces/:workspaceId/payment-requests/:paymentRequestId` — detail.
- `POST /workspaces/:workspaceId/payment-requests/:paymentRequestId/cancel` — mark a request cancelled.
- `POST /workspaces/:workspaceId/payment-requests/:paymentRequestId/create-order` — materialize the request into a `PaymentOrder`.

## Payment Runs

Batches, usually from CSV.

- `GET  /workspaces/:workspaceId/payment-runs` — list.
- `POST /workspaces/:workspaceId/payment-runs/import-csv` — create a run from CSV. Idempotent by CSV fingerprint: re-importing the same file returns the existing run with `importResult.imported: 0` and `idempotentReplay: true`.
- `POST /workspaces/:workspaceId/payment-runs/import-csv/preview` — preview without writing.
- `GET  /workspaces/:workspaceId/payment-runs/:paymentRunId` — detail, including child orders and aggregate totals.
- `DELETE /workspaces/:workspaceId/payment-runs/:paymentRunId` — delete the run (orders keep their history, lose the grouping).
- `POST /workspaces/:workspaceId/payment-runs/:paymentRunId/cancel` — cancel the run and its pending orders.
- `POST /workspaces/:workspaceId/payment-runs/:paymentRunId/close` — close a settled run.
- `POST /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution` — prepare a single Solana transaction for the whole batch.
- `POST /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature` — attach the submitted signature after the wallet signs.
- `GET  /workspaces/:workspaceId/payment-runs/:paymentRunId/proof` — deterministic proof packet for the entire run.

## Payment Orders

The control-plane object for a single intended payment.

- `GET   /workspaces/:workspaceId/payment-orders` — list (supports `state` filter).
- `POST  /workspaces/:workspaceId/payment-orders` — create (usually from a request, but can be created directly).
- `GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId` — detail, with events, approvals, and matching state.
- `PATCH /workspaces/:workspaceId/payment-orders/:paymentOrderId` — limited updates (e.g. `sourceTreasuryWalletId`, `metadata`).
- `POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit` — submit a draft for approval.
- `POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/cancel` — cancel.
- `POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution` — prepare a single-order execution packet.
- `POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature` — attach the submitted signature after signing.
- `POST  /workspaces/:workspaceId/payment-orders/:paymentOrderId/create-execution` — create an `ExecutionRecord` ahead of signing.
- `GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof` — deterministic proof packet for one payment.
- `GET   /workspaces/:workspaceId/payment-orders/:paymentOrderId/audit-export` — CSV audit export.

## Approvals

- `GET   /workspaces/:workspaceId/approval-policy` — fetch the workspace's policy row (always one per workspace).
- `PATCH /workspaces/:workspaceId/approval-policy` — update `policyName`, `isActive`, or keys under `ruleJson` (trust requirement, internal/external thresholds, etc.).
- `GET   /workspaces/:workspaceId/approval-inbox` — pending approvals (used by the Approvals page).
- `POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/approval-decisions` — record an `approve` / `reject` / `escalate` decision.

## Transfer Requests (Lower-Level)

Used mostly by the matcher and the internal API. Humans typically work through `payment-orders`.

- `GET   /workspaces/:workspaceId/transfer-requests` — list.
- `GET   /workspaces/:workspaceId/transfer-requests/:transferRequestId` — detail.
- `POST  /workspaces/:workspaceId/transfer-requests` — create directly (used by test / admin flows).
- `POST  /workspaces/:workspaceId/transfer-requests/:transferRequestId/submit|cancel|prepare-execution|attach-signature` — state-mutation endpoints that mirror `payment-orders` at the transfer-request layer.

## Observed Data And Reconciliation

- `GET  /workspaces/:workspaceId/transfers` — observed USDC transfers touching the workspace.
- `GET  /workspaces/:workspaceId/reconciliation` — reconciliation rows joining transfer requests ↔ observed transfers.
- `GET  /workspaces/:workspaceId/reconciliation-queue` — items needing operator attention.
- `GET  /workspaces/:workspaceId/reconciliation/:transferRequestId` — detail timeline for one request.
- `GET  /workspaces/:workspaceId/reconciliation/:transferRequestId/timeline` — the same, with event-log semantics.
- `POST /workspaces/:workspaceId/reconciliation/:transferRequestId/notes` — add a note.
- `GET  /workspaces/:workspaceId/exceptions` — list open + historical exceptions.
- `GET  /workspaces/:workspaceId/exceptions/:exceptionId` — detail.
- `PATCH /workspaces/:workspaceId/exceptions/:exceptionId` — update status / assignee.
- `POST /workspaces/:workspaceId/exceptions/:exceptionId/actions` — applies an action (`reviewed` | `expected` | `dismissed` | `reopen`).
- `POST /workspaces/:workspaceId/exceptions/:exceptionId/notes` — add an operator note.

## Ops, Members, Exports

- `GET /workspaces/:workspaceId/members` — workspace members.
- `GET /workspaces/:workspaceId/export-jobs` — recent export jobs.
- `GET /workspaces/:workspaceId/audit-log` — workspace-wide audit view across event tables.
- `GET /workspaces/:workspaceId/exports/reconciliation` — CSV export of reconciliation state.
- `GET /workspaces/:workspaceId/exports/exceptions` — CSV export of exceptions.
- `GET /workspaces/:workspaceId/exports/audit/:transferRequestId` — per-request audit CSV.
- `GET /workspaces/:workspaceId/ops-health` — combined Postgres + ClickHouse health signal used by Grafana and ops dashboards.

## API Keys

- `GET  /workspaces/:workspaceId/api-keys` — list keys (never returns the secret).
- `POST /workspaces/:workspaceId/api-keys` — create. Returns the plaintext `axoria_live_<id>.<secret>` **once**.
- `POST /workspaces/:workspaceId/api-keys/:apiKeyId/revoke` — revoke.
- `DELETE /workspaces/:workspaceId/api-keys/:apiKeyId` — hard-delete (revokes first).

## Agent Surface

- `GET /workspaces/:workspaceId/agent/tasks` — agent task queue for the workspace.
- `GET /workspaces/:workspaceId/agent/tasks/events` — SSE stream of task events.

## Internal (Worker ↔ API)

Used by the Yellowstone worker via a service token, not exposed to end users.

- `GET  /internal/workspaces` — list workspaces the worker should watch.
- `GET  /internal/workspaces/:workspaceId/matching-context` — matcher context for one workspace.
- `GET  /internal/matching-index` — global matching index (treasury wallets, destinations, open transfer requests, watched signatures).
- `GET  /internal/matching-index/events` — SSE stream of matching-index invalidations so the worker can refresh without polling.
- `POST /internal/worker-stage-events` — worker reports stage metrics back to the API.
- `GET  /internal/ops-metrics` — ops-facing metrics the worker and API publish.

## Route Change Checklist

When you add, remove, or reshape a route:

1. Update the handler under `api/src/routes/`.
2. Update `api/src/api-contract.ts` so `/openapi.json` reflects the change.
3. If it affects the matching index (treasury wallets, destinations, transfer requests, approvals, signatures) make sure the mutation triggers `matching-index-events` invalidation.
4. Update the frontend `api.ts` client.
5. Update this file.
6. Add or adjust a test in `api/tests/`.

# Implementation Blueprint

## Purpose

This document translates [PRODUCT_SPEC.md](/Users/fuyofulo/code/stablecoin_intelligence/PRODUCT_SPEC.md) into an implementation plan.

It answers:

- what architecture we are actually building
- what data lives in Postgres vs ClickHouse
- what services/modules we need
- what API contract we need
- what frontend information architecture we need
- what order to build in

This is the operational build document.

## 1. Architecture Choice

We keep `Architecture 2` from [architectures.md](/Users/fuyofulo/code/stablecoin_intelligence/architectures.md):

- raw observations
- canonical observed transactions and token movements
- serving projections

But the purpose of the pipeline has changed.

It is no longer “USDC monitoring and event classification.”
It is now:

- observe settlement
- link settlement to business intent
- compute operational state
- serve approvals, reconciliation, and exceptions

### Final shape

```text
Yellowstone / chain source
    ->
Rust ingest + normalize worker
    ->
ClickHouse raw + canonical settlement tables
    ->
Rust matching / projection worker
    ->
ClickHouse serving tables
    ->
TypeScript API
    ->
React frontend

TypeScript API
    ->
Postgres control-plane tables
```

## 2. System Modules

We need five implementation modules.

## A. Control Plane API

Language:

- TypeScript

Database:

- Postgres

Responsibilities:

- organizations
- users
- roles
- workspaces
- counterparties
- destinations
- business objects
- transfer requests
- approval policies
- approval actions

This is the source of truth for business intent and operator configuration.

## B. Settlement Ingest Worker

Language:

- Rust

Database:

- ClickHouse

Responsibilities:

- consume Yellowstone updates
- decode USDC token movement facts
- persist raw observations
- persist canonical observed transactions
- persist canonical observed token movements

This worker should know nothing about approvals or business workflow.
It is a settlement observer.

## C. Matching / Reconciliation Worker

Language:

- Rust

Databases:

- reads Postgres
- reads/writes ClickHouse

Responsibilities:

- load control-plane state
- map destinations to workspaces / counterparties
- match observed settlement to transfer requests
- detect mismatches and exceptions
- produce serving rows

This is the heart of the product.

## D. Serving API

Language:

- TypeScript

Databases:

- Postgres
- ClickHouse

Responsibilities:

- operator query endpoints
- approval actions
- request creation / updates
- reconciliation views
- exception views
- exports

In practice this can live in the same Express service as the control plane, but it should stay modular in code.

## E. Frontend

Language:

- TypeScript / React

Responsibilities:

- operator-facing workflows
- onboarding
- request creation
- approvals
- reconciliation
- exceptions
- audit and exports

## 3. Database Boundary

## Postgres owns business intent and mutable workflow state

Postgres should store:

- `organizations`
- `users`
- `organization_memberships`
- `workspaces`
- `workspace_memberships`
- `counterparties`
- `destinations`
- `destination_labels`
- `business_objects`
- `transfer_requests`
- `approval_policies`
- `approval_policy_rules`
- `approval_actions`
- `export_jobs`

Reason:

- these objects need transactions
- they are operator-owned
- they change frequently
- they need uniqueness and relational constraints

## ClickHouse owns settlement facts and rebuildable serving views

ClickHouse should store:

- `raw_observations`
- `observed_transactions`
- `observed_token_movements`
- `settlement_matches`
- `exceptions`
- `operational_feed`
- `reconciliation_rows`
- `audit_feed` optionally as denormalized serving rows

Reason:

- high-ingest append-heavy workloads
- analytical filters
- timeline views
- rebuildable serving tables

## 4. Data Model By Layer

## Layer 1: Business Intent

Primary DB:

- Postgres

Core tables:

- `organizations`
- `users`
- `workspaces`
- `counterparties`
- `destinations`
- `business_objects`
- `transfer_requests`

### Recommended table intents

`counterparties`
- the human/business actor on the other side

`destinations`
- the on-chain target
- may belong to one counterparty

`business_objects`
- the internal business reason
- payout batch, payout item, invoice, treasury rebalance, vendor payment

`transfer_requests`
- the requested movement of funds
- references destination, counterparty, and optional business object

## Layer 2: Control / Approval

Primary DB:

- Postgres

Core tables:

- `approval_policies`
- `approval_policy_rules`
- `approval_actions`

This layer determines whether a request can move forward.

## Layer 3: Settlement Observation

Primary DB:

- ClickHouse

Core tables:

- `raw_observations`
- `observed_transactions`
- `observed_token_movements`

This layer should be chain-true and append-only.

## Layer 4: Resolution

Primary DBs:

- ClickHouse for computed state
- Postgres for operator-owned exception/action state if needed later

Core tables:

- `settlement_matches`
- `exceptions`
- `operational_feed`
- `reconciliation_rows`

For MVP, we can keep exceptions in ClickHouse if we treat them as append-only operational events plus current-state projections.
If exception ownership and mutability grow, move exception command state to Postgres later.

## 5. Suggested Concrete Tables

This is the first-pass concrete schema list.

## Postgres

### Identity / access

- `organizations`
- `users`
- `organization_memberships`
- `workspace_memberships`

### Operational registry

- `workspaces`
- `counterparties`
- `destinations`
- `destination_labels`
- `destination_label_links`

### Business intent

- `business_objects`
- `transfer_requests`

### Control layer

- `approval_policies`
- `approval_policy_rules`
- `approval_actions`

### Exports

- `export_jobs`

## ClickHouse

### Raw and canonical

- `raw_observations`
- `observed_transactions`
- `observed_token_movements`

### Serving

- `settlement_matches`
- `exceptions`
- `operational_feed`
- `reconciliation_rows`

## 6. Key Enums / State Values

These should be kept as strings in code and DB, not hard DB enums, for easier evolution.

## `transfer_request.type`

- `treasury_transfer`
- `vendor_payment`
- `payout_batch`
- `payout_item`
- `rebalance`
- `sweep`

## `transfer_request.status`

- `draft`
- `pending_approval`
- `approved`
- `rejected`
- `held`
- `submitted`
- `settled`
- `partially_settled`
- `exception`
- `cancelled`
- `exported`

## `destination.trust_state`

- `pending`
- `approved`
- `blocked`
- `archived`

## `approval_action.action`

- `approve`
- `reject`
- `escalate`
- `hold`
- `release`
- `cancel`

## `settlement_match.match_status`

- `matched`
- `partial`
- `unmatched`
- `mismatch`
- `unexpected_observation`

## `exception.exception_type`

- `amount_mismatch`
- `wrong_destination`
- `duplicate_payment`
- `delayed_settlement`
- `failed_or_reverted`
- `unexpected_transaction`
- `policy_violation`
- `insufficient_funds`
- `invalid_destination`
- `manual_review_required`

## 7. API Contract

We should implement the API in three slices.

## Slice A: Control Plane CRUD

### Organizations and membership

- `GET /me`
- `GET /organizations`
- `POST /organizations`
- `POST /organizations/:organizationId/join`
- `GET /organizations/:organizationId/members`

### Workspaces

- `GET /organizations/:organizationId/workspaces`
- `POST /organizations/:organizationId/workspaces`
- `GET /workspaces/:workspaceId`

### Counterparties and destinations

- `GET /workspaces/:workspaceId/counterparties`
- `POST /workspaces/:workspaceId/counterparties`
- `GET /workspaces/:workspaceId/destinations`
- `POST /workspaces/:workspaceId/destinations`
- `POST /workspaces/:workspaceId/destination-labels`

### Business objects

- `GET /workspaces/:workspaceId/business-objects`
- `POST /workspaces/:workspaceId/business-objects`

## Slice B: Request and approval workflow

### Transfer requests

- `GET /workspaces/:workspaceId/transfer-requests`
- `POST /workspaces/:workspaceId/transfer-requests`
- `GET /workspaces/:workspaceId/transfer-requests/:requestId`
- `PATCH /workspaces/:workspaceId/transfer-requests/:requestId`

### Policies

- `GET /workspaces/:workspaceId/approval-policies`
- `POST /workspaces/:workspaceId/approval-policies`
- `PATCH /workspaces/:workspaceId/approval-policies/:policyId`

### Approvals

- `GET /workspaces/:workspaceId/approvals`
- `POST /workspaces/:workspaceId/transfer-requests/:requestId/approve`
- `POST /workspaces/:workspaceId/transfer-requests/:requestId/reject`
- `POST /workspaces/:workspaceId/transfer-requests/:requestId/escalate`
- `POST /workspaces/:workspaceId/transfer-requests/:requestId/hold`
- `POST /workspaces/:workspaceId/transfer-requests/:requestId/release`

## Slice C: Reconciliation and ops views

### Inbox

- `GET /workspaces/:workspaceId/inbox`

### Settlement and reconciliation

- `GET /workspaces/:workspaceId/reconciliation`
- `GET /workspaces/:workspaceId/reconciliation/:matchId`

### Exceptions

- `GET /workspaces/:workspaceId/exceptions`
- `GET /workspaces/:workspaceId/exceptions/:exceptionId`
- `POST /workspaces/:workspaceId/exceptions/:exceptionId/resolve`
- `POST /workspaces/:workspaceId/exceptions/:exceptionId/assign`

### Feed

- `GET /workspaces/:workspaceId/operational-feed`

### Exports

- `POST /workspaces/:workspaceId/exports`
- `GET /workspaces/:workspaceId/exports`

## 8. Frontend Information Architecture

The UI should mirror the workflow, not the schema.

## Global routes

- `/login`
- `/dashboard`
- `/orgs`
- `/profile`

## Workspace routes

- `/workspaces/:id/home`
- `/workspaces/:id/requests`
- `/workspaces/:id/approvals`
- `/workspaces/:id/reconciliation`
- `/workspaces/:id/exceptions`
- `/workspaces/:id/counterparties`
- `/workspaces/:id/policies`
- `/workspaces/:id/audit`
- `/workspaces/:id/settings`

## Page jobs

### Home

- inbox
- pending approvals
- open exceptions
- recently settled items

### Requests

- create and manage transfer requests

### Approvals

- act on approvals

### Reconciliation

- inspect matched / unmatched settlement

### Exceptions

- resolve operational failures

### Counterparties

- manage destinations and trust state

### Policies

- manage rules and thresholds

### Audit

- exports and audit history

## 9. Build Order

We should build in risk order, not in control-plane order.

The product’s highest-risk assumption is:

- can we reliably match business intent to observed on-chain settlement?

So the build must validate matching before we expand approvals, policies, and UI scope.

## Phase 0: Existing foundation

Already largely in place:

- Yellowstone ingestion
- canonical observed settlement facts
- control-plane scaffolding
- local infra and tests

## Phase 1: Minimal intent + matching core

Build only the minimum business-intent layer required to test matching:

- `transfer_requests`
- `destinations`
- `counterparties`
- minimal request creation API
- `settlement_matches`
- matching worker

Deliverable:

- a request can be created
- a real observed USDC movement can be matched back to it
- unmatched requests are visible
- unexpected observed transfers are visible

This phase is the real MVP risk test.

## Phase 2: Reconciliation product slice

Build the first usable operator product on top of matching:

- reconciliation endpoint
- operational feed
- exception projection
- reconciliation-focused UI

Deliverable:

- a user can inspect matched, unmatched, and unexpected settlement without opening an explorer

This is already a usable product, even without approvals.

## Phase 3: Exception workflow

Add:

- exception queue
- exception ownership
- resolution actions
- notes and audit trail around resolution

Deliverable:

- operators can actively work unresolved cases instead of only viewing them

## Phase 4: Control plane expansion

Only after matching is trustworthy, add:

- approval policy model
- approval actions
- role separation for request / approve / release
- trusted destination workflow

Deliverable:

- transfer execution can be governed before settlement, not only reconciled afterward

## Phase 5: Operator workspace

Expand the UI into the full operator shell:

- inbox
- transfer requests
- approvals
- reconciliation
- exceptions
- counterparties / destinations
- policies
- audit / exports

Deliverable:

- one end-to-end operator workflow usable from browser

## Phase 6: Buyer-specific extensions

Add:

- corridor metadata
- payout batches
- rebalance jobs
- buyer-specific extensions without changing the shared core

Deliverable:

- buyer-specific refinement without breaking the workflow engine

## 10. Immediate Coding Recommendation

The next code step should be:

1. finalize minimal Postgres schema for:
- counterparties
- destinations
- transfer_requests

2. finalize ClickHouse schema for:
- observed_transactions
- observed_token_movements
- settlement_matches
- exceptions

3. implement the matching engine described in [MATCHING_ENGINE_SPEC.md](/Users/fuyofulo/code/stablecoin_intelligence/MATCHING_ENGINE_SPEC.md)

The first implementation must keep these constraints:

- one current best `settlement_match` per `transfer_request_id`
- exact destination address matching only
- exact amount matching only
- one time window anchored on `requested_at`
- no owner-only matching
- no split-settlement support

4. expose the first reconciliation endpoints:
- `GET /workspaces/:workspaceId/reconciliation`
- `GET /workspaces/:workspaceId/exceptions`

5. build the reconciliation-first UI:
- request list
- reconciliation view
- exception queue

Do not build the full approval engine before matching is trusted.

That is the shortest path from current code to product truth.

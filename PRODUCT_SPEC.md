# Product Spec

## Working Name

`Stablecoin Ops Control Surface`

This name is internal. The product shape matters more than the brand.

## One-Line Definition

`Stablecoin Ops Control Surface` is a stablecoin operations product for teams using USDC on Solana, combining transfer requests, approvals, trusted destination management, on-chain settlement tracking, reconciliation, and exception handling in one workflow.

## Product Thesis

The market does not primarily need another wallet, another payment rail, or another analytics dashboard.

It needs an operational layer for teams that already move money.

Those teams have one recurring job:

- request a movement of funds
- decide whether it should be allowed
- execute it safely
- verify what actually happened on-chain
- reconcile it back to business intent
- resolve exceptions
- export the final record to finance and ops systems

That is the product.

## What We Are Building

We are building a workflow system for outbound USDC movements on Solana.

The product owns:

- transfer intent
- approval and policy workflow
- destination trust and counterparty registry
- on-chain settlement observation
- reconciliation and matching
- exception handling
- audit and export

The product does not own:

- custody
- key management
- banking
- fiat rails
- issuance
- checkout

It sits above those systems.

## Core User And Buyer

### Shared Buyer Category

The buyer is:

- an operations, finance, or treasury lead at a company already moving USDC on Solana

### Three Supported Buyer Variants

1. `Cross-border fintech finance / ops`
- moving USDC for payouts, partner settlements, or treasury transfers

2. `Marketplace payout ops`
- sending recurring outbound payouts to sellers, creators, or contractors

3. `Crypto-native treasury ops`
- managing treasury transfers, counterparty payments, and rebalancing

We are not choosing one buyer at the architecture level yet.
We are building the shared workflow core that all three require.

## User Problem

Today these teams use some combination of:

- wallet or custody dashboards
- Solana explorers
- spreadsheets
- Slack / Telegram / email approval threads
- CSV exports
- internal scripts
- finance systems that do not understand on-chain settlement

This creates the same failures repeatedly:

- approval context is outside the payment system
- “submitted” and “settled” get confused
- on-chain events do not map cleanly to business intent
- reconciliation is manual
- exceptions are not durable or auditable

The product exists to remove that fragmentation.

## Primary Workflow

The product is designed around one workflow:

`outbound USDC payout or treasury transfer from request to approval to execution to settlement to reconciliation`

### Workflow Steps

1. `Intake`
- create a transfer request or import a payout batch

2. `Control`
- evaluate the request against policies, destination trust, and risk constraints

3. `Approval`
- approve, reject, or escalate

4. `Execution`
- execute through the chosen wallet / custody / provider

5. `Observation`
- observe the on-chain transaction and token movement

6. `Matching`
- match observed settlement back to the request or payout item

7. `Exception Handling`
- surface and resolve unmatched, delayed, incorrect, or suspicious cases

8. `Audit / Export`
- produce finance-ready and ops-ready records

## Shared Product Core

These capabilities are required across all three buyer variants.

### Shared Capabilities

- create transfer requests
- maintain trusted destinations and counterparties
- define approval policies
- route approvals
- track request state
- observe Solana USDC settlement
- reconcile requests to observed settlement
- manage exception queues
- export records
- keep an immutable audit trail

### Shared Screens

- operations inbox
- transfer requests
- approvals
- settlement & reconciliation
- exception queue
- counterparties & destinations
- policies
- audit & exports

## Buyer-Specific Extensions

The product core must stay shared, but these extensions must remain visible in the design.

### Cross-Border Fintech Extensions

- corridor metadata
- beneficiary / partner metadata
- payout provider reference
- local-currency reference
- settlement-confidence or finance-close state

### Marketplace Payout Extensions

- beneficiary registry
- payout batch
- payout item
- earnings period / payout period
- support-facing payout status

### Treasury Ops Extensions

- treasury wallet cluster
- rebalance job
- counterparty trust state
- internal vs external movement type
- anomaly / unexpected movement flag

## MVP Scope

The MVP is intentionally narrow.

### Asset And Chain

- `USDC only`
- `Solana only`

### Flow Type

- outbound transfers only
- payout items and treasury transfers only

### Tenancy

- organizations
- users
- roles
- one or more workspaces per organization

### Integrations

- observe on-chain settlement from our data plane
- no fiat rails
- no on/off-ramp integrations
- no custody implementation

### Must-Have Capabilities

1. Transfer request creation
2. Destination / counterparty registry
3. Approval policy engine
4. Approval actions and audit log
5. On-chain settlement observation
6. Reconciliation and match states
7. Exception queue
8. CSV / API export

## Explicit Non-Goals

For MVP, we are not building:

- a wallet
- a custody product
- a banking partner layer
- merchant checkout
- a stablecoin issuer
- cross-chain support
- multi-asset support
- ML prediction
- protocol analytics
- inbound receivables automation
- accounting for every chain activity

## Product Objects

The product data model follows four layers:

- business intent
- control
- settlement observation
- resolution

### 1. Organization

Represents the customer account.

### 2. Workspace

Represents one operating environment or money-moving system inside an organization.

Examples:

- treasury
- contractor payouts
- seller payouts
- vendor settlements

### 3. User

Represents a human operator.

### 4. Role

Represents authorization level in the workspace.

Examples:

- requester
- approver
- operator
- admin
- auditor

### 5. Counterparty

Represents the business-side recipient or destination actor.

Examples:

- vendor
- seller
- creator
- contractor
- partner
- treasury counterparty
- internal treasury desk

### 6. Destination

Represents an on-chain destination or trusted payout target.

Fields should support:

- address
- token account
- owner
- trust state
- labels
- notes

### 7. Business Object

Represents the business context for the transfer.

Examples:

- payout batch
- payout item
- invoice
- vendor payment
- treasury rebalance
- treasury sweep

### 8. Transfer Request

Represents intended movement before execution.

Required fields:

- `id`
- `workspace_id`
- `type`
- `asset`
- `amount`
- `counterparty_id`
- `destination_id`
- `business_object_id`
- `reason`
- `requested_by`
- `requested_at`
- `due_at`
- `status`
- `external_reference`

### 9. Approval Policy

Represents decision logic for whether and how a request must be approved.

Required fields:

- `id`
- `workspace_id`
- `name`
- `conditions_json`
- `enabled`

### 10. Approval Action

Represents a human decision or workflow transition.

Examples:

- approve
- reject
- escalate
- hold
- release
- cancel

### 11. Observed Transaction

Represents normalized on-chain transaction state.

Required fields:

- `signature`
- `slot`
- `block_time`
- `status`
- `finality_state`

### 12. Observed Token Movement

Represents normalized USDC movement lines.

Required fields:

- `id`
- `signature`
- `mint`
- `amount`
- `source_address`
- `destination_address`
- `source_owner`
- `destination_owner`

### 13. Settlement Match

Represents the relation between intended movement and observed movement.

Required fields:

- `id`
- `transfer_request_id`
- `signature`
- `match_status`
- `matched_amount`
- `variance_amount`
- `match_reason`

### 14. Exception

Represents an unresolved operational problem.

Required fields:

- `id`
- `workspace_id`
- `transfer_request_id`
- `signature`
- `exception_type`
- `severity`
- `status`
- `owner_user_id`
- `opened_at`
- `resolved_at`

### 15. Audit Event

Represents immutable product-side evidence of actions and state changes.

### 16. Export Record

Represents outbound sync/export state for finance or ops systems.

## State Machines

The product must explicitly model state instead of inferring it from raw chain activity.

### Transfer Request States

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

### Settlement Match States

- `unmatched`
- `matched`
- `partial`
- `mismatch`
- `unexpected_observation`

### Exception States

- `open`
- `in_review`
- `waiting_on_external`
- `resolved`
- `dismissed`

## Exception Types

The MVP exception taxonomy should stay small but operationally useful.

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

## UX Definition

The UX should feel like an operator workspace, not a dashboard for passive viewing.

### 1. Operations Inbox

Purpose:

- answer `what needs my attention right now?`

Shows:

- pending approvals
- open exceptions
- unmatched settlements
- recently settled items
- urgent anomalies

### 2. Transfer Requests

Purpose:

- create, review, and track outgoing requests

Shows:

- request list
- request detail
- linked approvals
- linked settlement
- linked business context

### 3. Approvals

Purpose:

- give approvers enough context to make safe decisions

Shows:

- approval queue
- policy reason
- amount
- destination trust state
- counterparty
- business reason

### 4. Settlement & Reconciliation

Purpose:

- show what settled and whether it matched intent

Shows:

- matched items
- unmatched items
- partial matches
- unexpected transactions
- finality / settlement status

### 5. Exception Queue

Purpose:

- handle operational failures cleanly

Shows:

- exception type
- severity
- owner
- linked request
- linked transaction
- suggested next action

### 6. Counterparties & Destinations

Purpose:

- maintain trusted payout and counterparty context

Shows:

- counterparty list
- destination list
- trust state
- labels
- notes

### 7. Policies

Purpose:

- manage approval and control rules

Shows:

- threshold rules
- role-based approvals
- destination restrictions
- manual escalation settings

### 8. Audit & Exports

Purpose:

- provide durable evidence and output

Shows:

- audit events
- export jobs
- export status
- downloadable records

## API Boundaries

The product has three application boundaries.

### Control Plane API

Owns:

- organizations
- users
- roles
- workspaces
- counterparties
- destinations
- policies
- transfer requests
- approvals

### Data Plane

Owns:

- on-chain ingestion
- transaction normalization
- observed token movements
- settlement evidence

### Serving Layer

Owns:

- reconciliation views
- exception views
- operator feed
- exportable records

## Technical Shape

### Postgres

Stores:

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

### ClickHouse

Stores:

- raw observations
- canonical observed transactions
- canonical token movements
- settlement matches
- exceptions
- audit-style operational events
- exportable serving views

### Rust

Owns:

- ingestion
- normalization
- observation
- reconciliation computation
- exception detection

### TypeScript

Owns:

- product API
- control-plane CRUD
- operator-facing application logic

## Success Criteria For MVP

The MVP succeeds if a real operator can:

- create a transfer request
- route it for approval
- execute it externally
- see the resulting on-chain settlement
- know whether it matched the request
- resolve any exception
- export the final record

Operationally, success means:

- fewer spreadsheet steps
- fewer explorer checks
- faster close of outgoing transfers
- clearer ownership of exceptions

## Product Principles

- workflow first, data second
- intent and settlement must both be first-class
- approvals require context, not just signatures
- exceptions are a product surface, not an error state
- the chain is evidence, not the whole product
- do not expand scope with generic analytics
- do not rely on ML to cover weak workflow design

## Build Sequence

1. Shared core entities and state machines
2. Transfer request and approval flows
3. Destination / counterparty registry
4. On-chain observation and settlement matching
5. Exception queue
6. Audit and exports
7. Buyer-specific extensions

## Revision Rule

This document is the source of truth for product scope.

We only change it when we make an explicit product decision.

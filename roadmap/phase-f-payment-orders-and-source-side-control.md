# Phase F: Payment Orders + Source-Side Control

## Goal

Move from abstract expected transfers to a complete payment-control loop.

This phase introduces `Payment Order` as the operator-facing object:

> pay a known destination a specific amount for a stated reason, from a selected source wallet, under policy, with execution evidence, observed settlement, reconciliation, and exportable proof.

The product should become:

`payment order -> approval -> source wallet -> execution handoff -> observed settlement -> reconciliation -> audit proof`

not:

`expected transfer -> maybe someone sends money elsewhere -> match later`

## Why This Phase Exists

The product already has a strong reconciliation/control core.

What it lacks is the object that makes the workflow feel real to an operator:

- who are we paying?
- why are we paying them?
- from which wallet or treasury account?
- is the destination allowed?
- has execution been prepared or recorded?
- did settlement match the intent?
- can we prove the whole story later?

This phase is intentionally not a full AP system and not a custody/signing system.

It is the smallest complete loop that connects business intent and source-side control to the reconciliation engine we already built.

## Product Principle

Build the bridge, not the full platform.

This phase should combine the smallest useful pieces of two directions:

- business intent, so the user starts from a payment reason instead of a raw expected transfer
- execution/source-side context, so the product feels like a control plane instead of a watcher

Do not build a full bill-pay suite before execution context exists.

Do not build a generic transaction console without business intent.

## What Must Exist At The End

At the end of this phase, an operator should be able to:

1. create a payment order with a destination, amount, token, memo/reference, and optional invoice metadata
2. select a source wallet or treasury account
3. see a balance snapshot or insufficient-balance warning for the selected source wallet
4. send the payment order through existing approval policy
5. automatically create or link the underlying expected transfer
6. create or attach an execution record
7. attach a transaction signature or external proposal reference
8. have Yellowstone observe the settlement
9. have the existing matcher reconcile the observed settlement against the payment order
10. see partial/missing/mismatch exceptions linked back to the payment order
11. export an audit packet for the payment order

## Product Capabilities

### 1. Payment Order

Need a first-class object above expected transfers.

Minimum fields:

- payment order id
- workspace id
- destination id
- counterparty id nullable
- source wallet id nullable
- expected transfer id nullable until created
- amount
- token mint / token symbol
- memo / payment reason
- external reference nullable
- invoice number nullable
- attachment URL/path nullable
- due date nullable
- state
- created by user id
- created at
- updated at

Suggested states:

- `draft`
- `pending_approval`
- `approved`
- `ready_for_execution`
- `execution_recorded`
- `partially_settled`
- `settled`
- `exception`
- `closed`
- `cancelled`

State design rule:

- payment order state is user-facing workflow state
- approval state remains approval-specific
- execution state remains execution-specific
- reconciliation state remains settlement-specific

Do not collapse them into one overloaded status field.

### 2. Source Wallet / Treasury Account

Need source-side context without custody.

Minimum behavior:

- mark saved wallets as source-capable, destination-capable, or both
- select source wallet on payment order
- show saved-wallet label, address, status, and latest known USDC balance if available
- warn when selected source wallet has insufficient balance

If balance indexing is not already reliable for source wallets, support a nullable balance snapshot and make the absence explicit:

- `balance unknown`
- `last seen 124.50 USDC at 10 Apr, 18:10`

### 3. Expected Transfer Linkage

Payment order should own or create the expected transfer.

Rules:

- approved payment order creates one expected transfer for the selected destination and amount
- expected transfer should store `payment_order_id`
- request detail should deep-link back to payment order
- payment order detail should show the underlying expected transfer and reconciliation result

The expected transfer remains the matching primitive.

The payment order becomes the operator-facing intent.

### 4. Approval Policy Integration

The existing policy engine should evaluate payment orders using the same controls already used for expected transfers.

Inputs:

- destination trust
- destination scope
- amount
- source wallet status if present
- optional external/internal classification

Minimum behavior:

- trusted destinations below threshold can become approved or ready for execution
- unreviewed/restricted destinations require approval
- insufficient balance does not need to block approval, but must block or warn execution handoff

### 5. Execution Handoff

This phase should not introduce private-key custody.

Minimum behavior:

- create execution record from payment order
- prepare a concrete non-custodial Solana USDC transfer packet from source wallet to destination wallet
- attach signature manually
- attach external execution reference nullable, such as a Squads proposal id or URL
- show execution source:
  - `manual_signature`
  - `external_proposal`
  - `wallet_adapter_prepared`
  - `unknown`

Execution origination packet:

- source wallet and source USDC ATA
- destination wallet and destination USDC ATA
- USDC mint and decimals
- raw amount
- required signer
- serialized Solana instructions
- explicit note that the client must add a recent blockhash and sign externally

This is not custody. It is the exact payment action the operator signs elsewhere.

Optional if implementation time allows later:

- wallet adapter signing in the browser
- Squads proposal creation
- broadcast and retry tracking

Do not build:

- backend private-key custody
- unrestricted auto-signing
- broad batching engine
- retry engine

### 6. Reconciliation Integration

The matching engine should continue matching expected transfers.

Payment order read models should aggregate:

- payment order
- approval result
- source wallet
- destination
- expected transfer
- execution record
- observed settlement
- match state
- exceptions
- timeline

When the expected transfer reconciles:

- exact settlement should move payment order to `settled`
- partial settlement should move payment order to `partially_settled` and create or update an exception
- full later settlement should dismiss the partial exception and move payment order to `settled`
- missing settlement should remain `ready_for_execution` or `execution_recorded` until a timeout/SLA creates an exception

### 7. Audit Packet

Export should include one payment-order packet.

Minimum fields:

- payment order id
- memo / reference
- invoice number if present
- source wallet label and address
- destination label and address
- amount and token
- approval decision and reasons
- execution signature or external proposal reference
- observed settlement signature(s)
- matched amount
- match rule / status
- exceptions and resolutions
- timeline

This is the new "proof" surface.

## Backend Work

### Data model

Add:

- `payment_orders`
- `payment_order_events`
- source-capability fields or equivalent classification on saved wallets
- `payment_order_id` on expected transfer / transfer request model
- optional execution external reference fields if not already present

Constraints:

- prevent duplicate active payment orders for the same workspace + destination + amount + reference/invoice number when reference exists
- validate destination belongs to workspace
- validate source wallet belongs to workspace
- validate source and destination are not accidentally identical unless explicitly allowed

### Services

Need a `PaymentOrderService` or equivalent module.

Responsibilities:

- create draft payment order
- submit payment order for policy evaluation
- approve/reject/cancel/close payment order
- create expected transfer from approved payment order
- create execution record from payment order
- attach execution signature/reference
- build payment order read model
- export payment order audit packet

### APIs

Minimum endpoints:

- `GET /workspaces/:workspaceId/payment-orders`
- `POST /workspaces/:workspaceId/payment-orders`
- `GET /workspaces/:workspaceId/payment-orders/:paymentOrderId`
- `PATCH /workspaces/:workspaceId/payment-orders/:paymentOrderId`
- `POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit`
- `POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/cancel`
- `POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution`
- `POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/create-execution`
- `POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature`
- `GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/audit-export`

API rule:

- existing expected-transfer endpoints should continue to work
- payment-order endpoints should be additive
- no client should need to know internal matching tables to use the payment-order workflow

### Tests

Add backend tests for:

- create payment order with trusted destination
- reject unknown destination
- reject source wallet outside workspace
- duplicate reference/invoice protection
- submit unreviewed destination to approval
- submit trusted destination below threshold to approved/ready state
- create expected transfer from approved payment order
- prepare signer-ready Solana USDC transfer packet
- ensure execution preparation cannot bypass approval
- attach execution signature to payment order execution record
- exact settlement updates payment order to settled
- partial settlement updates payment order to partially settled and links exception
- later full settlement closes partial exception and settles order
- audit export includes approval, execution, settlement, and exception data

## Frontend Work

### Payment Orders Page

Create a first-class page or replace "Expected transfers" with a payment-order centered surface.

Table columns:

- order / reference
- destination
- source wallet
- amount
- approval
- execution
- reconciliation
- requested / due

Primary action:

- `New payment order`

### Payment Order Modal

Should be landscape and fit within the screen.

Fields:

- destination
- source wallet
- amount
- token
- memo / reason
- external reference
- optional invoice number
- optional attachment URL/path
- due date
- initial state / submit now

Show inline policy and balance hints:

- destination trusted/unreviewed/restricted
- source wallet balance known/unknown/insufficient
- approval required because ...

### Payment Order Detail

Use the improved request-inspector pattern:

- top transaction/payment summary
- compact status strip
- collapsible sections for approval, execution, settlement, exceptions, timeline, notes
- full signatures available in detail sections
- export audit packet action

### Existing Expected Transfers

Expected transfers can remain visible, but should be framed as the technical matching layer.

Operator-facing language should prefer:

- "Payment orders"
- "Settlement"
- "Execution"
- "Exceptions"

over:

- "expected transfer" as the primary product noun

## Milestones

### F1. Payment order model and APIs

Product should support:

- creating, listing, reading, updating, and cancelling payment orders

### F2. Policy and expected-transfer linkage

Product should support:

- submitting payment orders to policy
- creating expected transfers from approved orders
- preserving existing reconciliation behavior

### F3. Source wallet context

Product should support:

- selecting a source wallet
- showing balance snapshot or unknown state
- warning on insufficient balance

### F4. Execution handoff

Product should support:

- preparing a non-custodial Solana USDC execution packet from a payment order
- creating execution records from payment orders
- attaching signature or external proposal reference
- showing execution separately from settlement

### F5. Payment order reconciliation and exceptions

Product should support:

- exact settlement
- partial settlement
- later full settlement
- exception linkage

### F6. Audit packet and UI

Product should support:

- exportable payment-order proof
- an operator UI that makes the full loop understandable

## Exit Criteria

This phase is complete when:

- an operator can create a payment order with source wallet, destination, amount, and reason
- the order passes through policy and approval
- the system creates or links the expected transfer underneath
- the system prepares the exact non-custodial Solana USDC transfer packet for external signing
- execution evidence can be recorded without custody
- observed settlement reconciles the payment order
- partial/missing/mismatch cases create linked exceptions
- a full audit packet can be exported
- the UI no longer forces users to think primarily in raw expected-transfer terms

## Non-Goals For This Phase

Do not build here:

- full invoice OCR
- full AP inbox
- ERP sync
- general ledger
- payroll gross-to-net
- employee tax/compliance workflows
- backend private-key custody
- autonomous signing
- full transaction retry engine
- broad multi-chain execution

## Research Inputs

This phase is based on:

- [deep-research-next-product-direction-stablecoin-treasury-control-2026.md](/Users/fuyofulo/code/stablecoin_intelligence/outputs/deep-research-next-product-direction-stablecoin-treasury-control-2026.md)
- [market-research-stablecoin-ops-customer-jobs-2026.md](/Users/fuyofulo/code/stablecoin_intelligence/outputs/market-research-stablecoin-ops-customer-jobs-2026.md)

Key decision:

- build the smallest combined loop, not a pure AP phase and not a pure execution phase

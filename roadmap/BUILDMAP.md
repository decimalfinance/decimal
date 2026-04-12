# Product Build Map

Date: 2026-04-11

## Purpose

This roadmap turns the current product thesis into a concrete build sequence.

It is meant to be:

- an anchor for implementation
- a shared reference for product scope
- editable as the system evolves and real users expose gaps

This is not a marketing document.
It is the operating plan for building the actual product.

## Product Thesis

We are not building another wallet, explorer, or analytics dashboard.

We are building the operational layer for teams that already move stablecoins.

The full job is:

1. create a business payment intent
2. choose the source of funds and destination
3. route approvals
4. hand off or track execution
5. observe settlement
6. reconcile intent to on-chain reality
7. handle exceptions
8. keep an auditable record
9. export records to finance and ops systems

## Current State

The product today is strongest in:

- organizations, users, workspaces
- wallet registry
- expected transfer creation
- Yellowstone ingestion
- transaction reconstruction
- observed transfer legs
- observed payments
- deterministic matching
- reconciliation UI
- destination trust
- approval policy and inbox
- execution records
- exception operations
- audit/export surfaces

The product is weak or incomplete in:

- business-facing payment intent
- source wallet / source-of-funds selection
- balance context
- execution handoff into a wallet or multisig workflow
- invoice / bill / payout reference metadata
- accounting-grade export packets

## Honest Position

Today we have built:

- settlement visibility
- request matching
- approval/control workflow
- execution evidence tracking
- exception/audit/export foundation

We have not yet built:

- the complete stablecoin payment control surface

This means the current product is a strong control and reconciliation core, not the finished company.

## Build Principle

The correct sequence is:

1. make the current matching and reconciliation layer usable by operators
2. attach richer business objects to transfer intent
3. add approval workflow and control logic
4. add execution tracking
5. deepen exception operations
6. produce audit and export outputs
7. add payment orders that combine business intent, source-of-funds, execution handoff, and reconciliation
8. harden the system operationally throughout

## Phase Order

Status:

- Phase A through Phase E define the current shipped core.
- Phase F is the next implementation phase.
- Phase F replaces the earlier fork between "AP first" and "execution first" with a smaller combined loop.

### Phase A

`Reconciliation Product + Request Lifecycle`

Goal:

- turn the current technical prototype into real workflow software for operators

Doc:

- [phase-a-reconciliation-and-request-lifecycle.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-a-reconciliation-and-request-lifecycle.md)

### Phase B

`Counterparties + Trusted Destinations`

Goal:

- move from raw wallet rows to real destination objects with business meaning

Doc:

- [phase-b-counterparties-and-destinations.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-b-counterparties-and-destinations.md)

### Phase C

`Approvals + Policy Engine`

Goal:

- make requests controllable before execution

Doc:

- [phase-c-approvals-and-policy.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-c-approvals-and-policy.md)

### Phase D

`Execution Tracking`

Goal:

- separate approved intent from actual submission and observed settlement

Doc:

- [phase-d-execution-tracking.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-d-execution-tracking.md)

### Phase E

`Exception Operations + Audit + Export + Hardening`

Goal:

- complete the control surface and make it operationally trustworthy

Doc:

- [phase-e-exception-ops-audit-export-hardening.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-e-exception-ops-audit-export-hardening.md)

### Phase F

`Payment Orders + Source-Side Control`

Goal:

- move from abstract expected transfers to business payment orders that choose a source wallet, pass policy, hand off execution, reconcile settlement, and export proof

Doc:

- [phase-f-payment-orders-and-source-side-control.md](/Users/fuyofulo/code/stablecoin_intelligence/roadmap/phase-f-payment-orders-and-source-side-control.md)

## Why This Order

This order reflects the current reality of the system.

We already proved:

- we can observe settlement
- we can reconstruct transaction truth
- we can match expected movement to observed payment reality

That means the next product risk is not core chain reconstruction.
It is product workflow design.

The next serious product value comes from:

- making requests durable
- making reconciliation operable
- attaching business context to destinations
- adding approvals before execution
- making source wallet and payment intent first-class

## Product Completion Standard

The product is not complete when matching works.

The product is complete when an operator can do the full loop in one system:

1. create the payment order
2. choose the source wallet and destination
3. send it through policy and approval
4. hand off or track its execution
5. observe settlement
6. reconcile what happened
7. resolve exceptions
8. export the final record

## Phase Exit Rule

Each phase should be considered complete only when it satisfies three conditions:

1. product behavior exists end to end
2. operator UI exists for the behavior
3. durable backend state and auditability exist for the behavior

## Current Recommendation

Build the product in this exact order:

1. Phase A
2. Phase B
3. Phase C
4. Phase D
5. Phase E
6. Phase F

Current next step:

- finish Phase F by making payment orders originate a non-custodial Solana USDC execution packet before moving up into bills or AP workflows

If user feedback forces reordering, update these docs rather than relying on memory.

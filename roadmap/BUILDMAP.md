# Product Build Map

Date: 2026-04-07

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

1. create transfer requests
2. route approvals
3. track execution
4. observe settlement
5. reconcile intent to on-chain reality
6. handle exceptions
7. keep an auditable record
8. export records to finance and ops systems

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
- basic reconciliation UI

The product is weak or incomplete in:

- request lifecycle
- trusted counterparties and destinations
- approvals
- execution tracking
- exception operations
- audit timeline
- export

## Honest Position

Today we have built:

- settlement visibility
- request matching

We have not yet built:

- the complete stablecoin operations control surface

This means the current product is a strong bottom layer, not the finished company.

## Build Principle

The correct sequence is:

1. make the current matching and reconciliation layer usable by operators
2. attach richer business objects to transfer intent
3. add approval workflow and control logic
4. add execution tracking
5. deepen exception operations
6. produce audit and export outputs
7. harden the system operationally throughout

## Phase Order

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

## Product Completion Standard

The product is not complete when matching works.

The product is complete when an operator can do the full loop in one system:

1. create the request
2. send it through policy and approval
3. track its execution
4. observe settlement
5. reconcile what happened
6. resolve exceptions
7. export the final record

## Phase Exit Rule

Each phase should be considered complete only when it satisfies three conditions:

1. product behavior exists end to end
2. operator UI exists for the behavior
3. durable backend state and auditability exist for the behavior

## Current Recommendation

Build next in this exact order:

1. Phase A
2. Phase B
3. Phase C
4. Phase D
5. Phase E

If user feedback forces reordering, update these docs rather than relying on memory.

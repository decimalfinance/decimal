# Phase A: Reconciliation Product + Request Lifecycle

## Goal

Turn the current settlement visibility prototype into usable operator workflow software.

This phase is about making the existing matching engine, observed payment model, and transfer requests operable and durable.

## Why This Phase Comes First

We already have the technical foundation for:

- observed transfer reconstruction
- observed payment reconstruction
- request-to-payment matching

What is missing is the product layer that lets an operator manage and understand that workflow over time.

## What Must Exist At The End

At the end of this phase, the product should be able to do the following:

1. create a transfer request
2. move the request through explicit lifecycle states
3. show a durable request timeline
4. show a usable reconciliation queue
5. show a useful exception detail view
6. let operators add notes/comments
7. preserve all of this in durable backend state

## Product Capabilities

### 1. Explicit Request Lifecycle

Request states must become first-class and durable.

Initial state machine:

- `draft`
- `submitted`
- `pending_approval`
- `approved`
- `ready_for_execution`
- `submitted_onchain`
- `observed`
- `matched`
- `partially_matched`
- `exception`
- `closed`
- `rejected`

This phase does not need to fully use every state yet, but the state machine must exist now.

Allowed transitions must be explicit and enforced in backend code.

Initial allowed transitions:

- `draft -> submitted`
- `submitted -> pending_approval`
- `pending_approval -> approved`
- `pending_approval -> rejected`
- `approved -> ready_for_execution`
- `ready_for_execution -> submitted_onchain`
- `submitted_onchain -> observed`
- `observed -> matched`
- `observed -> partially_matched`
- `observed -> exception`
- `partially_matched -> matched`
- `partially_matched -> exception`
- `matched -> closed`
- `exception -> matched`
- `exception -> closed`

Any transition outside this graph should be rejected.

### 2. Reconciliation Queue

Operators need a queue that answers:

- what matched
- what is pending
- what is partial
- what is in exception

The queue must not be built from ad hoc frontend guesses.

It should be based on:

- `transfer_request.status`
- `match_state`
- `exception presence`

The system should expose a derived display state for the UI.

### 3. Request Timeline

Each request needs a timeline showing:

- created
- state transitions
- observed tx linkage
- match result
- operator notes

This is not just a convenience feature.
It is the foundation of the later audit product.

### 4. Lightweight Exception Workflow

This phase only needs basic exception workflow.

Supported actions:

- add note
- mark reviewed
- mark expected
- dismiss
- reopen

Do not build full assignment/SLA systems here yet.

Exceptions must still carry a machine-readable reason code.

Minimum reason codes:

- `unexpected_destination`
- `partial_settlement`
- `unknown_counterparty`
- `residual_amount`
- `duplicate_observation`

## Backend Work

### Add durable request lifecycle state

Need:

- canonical request status enum
- transition validation
- transition timestamps
- actor attribution
- derived display state generation

The backend must own the transition rules.
The frontend should not be allowed to invent valid transitions.

### Add request event log

Create a durable event stream for request changes.

Minimum fields:

- event id
- request id
- event type
- actor type
- actor id
- event source
- before state
- after state
- linked signature
- linked payment id
- linked transfer ids
- payload json
- created at

Definitions:

- `event source`
  - `system`
  - `user`
  - `worker`

The event log must be rich enough to serve later audit requirements.

### Add notes

Need notes/comments on:

- transfer requests
- exceptions

### Add request detail read model

Need an API view that joins:

- request
- destination metadata available at the time
- reconciliation result
- linked observed payment
- linked observed transfers
- linked signature
- timeline events
- notes
- match explanation
- exception explanation

Every request should expose standardized linkage fields:

- `linked_payment_id` nullable
- `linked_transfer_ids` array
- `linked_signature` nullable

This avoids repeated join logic and makes the detail page stable.

### Add derived API fields

The API should return UI-facing derived fields so the frontend stays simple.

At minimum:

- `request_display_state`
  - `pending`
  - `matched`
  - `partial`
  - `exception`
- `match_explanation`
- `exception_explanation`

`request_display_state` should be derived from:

- request status
- match result
- exception presence

## Frontend Work

### Request list

Need:

- status filter
- amount
- destination label
- requested at
- request state
- request display state

### Request detail

Need:

- request summary
- receiving destination
- current state
- linked signature if present
- match state
- match explanation
- exception explanation
- timeline
- notes

### Reconciliation queue

Need:

- clearer queue than the current mixed operator surface
- row actions
- filters driven by `request_display_state`

### Exception detail

Need:

- what happened
- why it is an exception
- linked request if present
- linked signature if present
- notes
- basic resolution actions

## Data Model Additions

Need to add or formalize:

- `transfer_request.status`
- `request_events`
- `request_notes`
- `exception_notes`
- `exception.reason_code`

Need to expose or persist linkage fields:

- `linked_payment_id`
- `linked_transfer_ids`
- `linked_signature`

Existing match/exception tables remain in place for now.

## Milestones

### A1. Request state machine

Product should support:

- durable request status
- valid status transitions
- timeline event generation
- explicit transition rules enforced in backend

### A2. Reconciliation queue

Product should support:

- queue filtering by derived display state
- request detail navigation

### A3. Notes and event history

Product should support:

- request notes
- exception notes
- timeline rendering
- before/after state visibility
- actor/source visibility

### A4. Basic exception operations

Product should support:

- reviewed
- expected
- dismissed
- reopened

## Exit Criteria

This phase is complete when:

- every request has an explicit state
- every request has a timeline
- operators can open one queue, click one request, and understand:
  - what was intended
  - what happened on-chain
  - what matched
  - what did not
  - why
- basic exception handling happens inside the product
- notes and explanations are visible without external tools

## Non-Goals For This Phase

Do not build here:

- approval policy engine
- approver inbox
- custody/provider integrations
- full exception assignment model
- export framework

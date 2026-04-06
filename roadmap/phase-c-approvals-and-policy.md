# Phase C: Approvals + Policy Engine

## Goal

Add real pre-execution control to transfer requests.

This phase is where the product begins to satisfy the promise:

- create transfer requests
- run approvals

## Why This Phase Comes After Destinations

Approvals need meaningful context.

Policies based only on:

- amount
- address

are too shallow.

Policies should reason about:

- destination trust state
- internal vs external movement
- counterparty type
- request size
- workspace rules

## What Must Exist At The End

At the end of this phase, the product should be able to do the following:

1. evaluate a request against approval policy
2. move a request into approval-required states
3. show an approval inbox
4. allow approve / reject / escalate actions
5. record every approval decision in the audit trail

## Product Capabilities

### 1. Approval Policies

Initial policy support should include:

- amount thresholds
- destination trust requirement
- internal vs external transfer rules
- workspace-scoped default policy

### 2. Approval Routing

Requests should enter:

- `pending_approval`

when they meet approval conditions.

### 3. Approval Actions

Need:

- approve
- reject
- escalate

### 4. Approval History

Every request needs:

- approval decisions
- who made them
- when
- why

## Backend Work

### Add approval policy model

Minimum fields:

- policy id
- workspace id
- policy name
- is active
- rule json
- created at
- updated at

### Add approval decision model

Minimum fields:

- decision id
- request id
- actor user id
- action
- comment
- created at

### Add policy evaluation service

Need deterministic evaluation logic:

- no ML
- no opaque scoring

### Update request state machine

Need transitions:

- submitted -> pending_approval
- pending_approval -> approved
- pending_approval -> rejected
- pending_approval -> escalated
- approved -> ready_for_execution

## Frontend Work

### Approval inbox

Need:

- pending approvals list
- request summary
- destination trust context
- amount
- request reason

### Approval decision panel

Need:

- approve
- reject
- escalate
- comment

### Approval history on request detail

Need:

- list of approval decisions
- actor
- time
- action
- comment

## Milestones

### C1. Basic policy engine

Product should support:

- threshold and trust-state rules

### C2. Approval queue

Product should support:

- visible pending approvals
- approval actions

### C3. Audit integration

Product should support:

- approval decisions on request timeline

## Exit Criteria

This phase is complete when:

- a request can require approval before execution
- approval actions are durable and visible
- approval context is rich enough to be meaningful

## Non-Goals For This Phase

Do not build here:

- automatic execution after approval
- custody/vendor integration
- advanced multi-step quorum system beyond what is needed for MVP

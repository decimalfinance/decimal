# Phase D: Execution Tracking

## Goal

Track what happened between approval and observed settlement.

This phase distinguishes:

- approved intent
- submission
- observed chain activity
- matched settlement

## Why This Phase Matters

Without execution tracking, the product still conflates:

- approved
- actually sent
- seen on-chain
- matched

Those are different states and operators need all four.

## What Must Exist At The End

At the end of this phase, the product should be able to do the following:

1. create an execution record for an approved request
2. attach a submitted signature manually
3. show submission state separately from observed settlement state
4. link request, execution, and observed transaction together

## Product Capabilities

### 1. Execution Record

Need a durable execution object.

This is not custody.
It is execution tracking.

### 2. Manual Signature Attachment

For MVP, this is enough:

- operator can attach tx signature to a request/execution attempt

### 3. Execution State Machine

Need:

- `ready_for_execution`
- `submitted_onchain`
- `broadcast_failed`
- `observed`
- `settled`
- `execution_exception`

### 4. Request Linkage

Operators should be able to see:

- request
- submitted signature
- observed transaction
- matched result

on one detail surface

## Backend Work

### Add execution job model

Minimum fields:

- execution id
- request id
- submitted signature nullable
- execution source
- executor user id nullable
- state
- submitted at nullable
- metadata json
- created at
- updated at

### Add execution events

Need event log entries for:

- execution created
- signature attached
- execution state changed

### Link execution to reconciliation

Need API read model that joins:

- request
- execution
- observed transaction
- settlement match

## Frontend Work

### Execution panel on request detail

Need:

- execution state
- submitted signature
- attach signature action
- observed signature
- match state

### Timeline enrichment

Need:

- request approved
- sent
- observed
- matched

shown clearly as separate events

## Milestones

### D1. Execution model

Product should support:

- execution records
- execution states

### D2. Manual signature linkage

Product should support:

- attaching signature
- showing submission separately from match

### D3. Unified request/execution/settlement view

Product should support:

- single-page understanding of the whole post-approval flow

## Exit Criteria

This phase is complete when:

- approved does not imply sent
- sent does not imply observed
- observed does not imply matched
- operators can see those distinctions clearly

## Non-Goals For This Phase

Do not build here:

- direct wallet/custody execution integrations
- automated signing
- full payout batching engine

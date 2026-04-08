# Phase E: Exception Operations + Audit + Export + Hardening

## Goal

Complete the control surface and make it trustworthy enough for real operational use.

This phase deepens exception handling, formalizes the audit record, adds export, and hardens the system.

## Why This Phase Is Last

These capabilities are critical, but they become much more useful after:

- request lifecycle exists
- destinations exist
- approvals exist
- execution tracking exists
 
That richer context makes exceptions, audits, and exports much more meaningful.

## What Must Exist At The End

At the end of this phase, the product should be able to do the following:

1. operate a real exception queue
2. keep a complete audit trail for the transfer lifecycle
3. export records for finance and ops use
4. expose operational health and latency
5. recover from lag and stream disruption reliably

## Product Capabilities

### 1. Full Exception Operations

Need:

- assignment
- status
- severity
- resolution codes
- notes
- reopen
- filtered queue

### 2. Unified Audit Record

Each transfer should have a unified audit timeline containing:

- request creation
- request state changes
- approval decisions
- execution events
- observed chain activity
- match result
- exception actions

### 3. Export

Need:

- CSV export
- API export
- exportable request/reconciliation/audit records

### 4. Operational Visibility

Need:

- worker health
- ingest lag
- chain-to-ingest latency
- ingest-to-match latency
- replay/backfill support

## Backend Work

### Deep exception model

Need:

- assignee user id
- resolution code
- status transitions
- exception notes

### Unified audit read model

Need a durable timeline view built from:

- request events
- approval decisions
- execution events
- observed transaction facts
- settlement matches
- exception events

### Export framework

Need:

- export jobs
- stable CSV schemas
- API endpoints for filtered export

### Operational hardening

Need:

- stream liveness monitoring
- replay/backfill tooling
- lag visibility
- better ClickHouse operational metrics
- idempotency review
- query audit and storage tuning

## Frontend Work

### Exception inbox

Need:

- assignment
- filters
- severity
- resolution actions
- linked request detail

### Audit timeline

Need:

- one timeline per request
- grouped events by stage
- downloadable evidence

### Export UI

Need:

- export actions
- export filters
- export history

### Ops health UI

Need:

- worker status
- lag indicator
- latency split indicators

## Milestones

### E1. Exception queue

Product should support:

- real exception work, not just exception visibility

### E2. Audit timeline

Product should support:

- complete lifecycle playback for one request

### E3. Export

Product should support:

- finance/ops friendly output

### E4. Hardening

Product should support:

- operational recovery and visibility

## Exit Criteria

This phase is complete when:

- operators can resolve exceptions inside the product
- auditors can understand what happened from one timeline
- finance and ops can export records without manual reconstruction
- the system is operationally transparent and recoverable

## Non-Goals For This Phase

Do not build here:

- broad multi-chain support
- multi-asset support
- generalized treasury analytics

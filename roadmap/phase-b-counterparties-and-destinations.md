# Phase B: Counterparties + Trusted Destinations

## Goal

Replace raw wallet-only request semantics with business-facing destination objects.

This phase gives transfer requests real context:

- who is being paid
- whether they are trusted
- what kind of destination they are

## Why This Phase Matters

Approvals are weak without destination semantics.

A raw wallet row is not enough to support:

- destination trust
- external vs internal transfer rules
- meaningful approval context
- operator review

## What Must Exist At The End

At the end of this phase, the product should be able to do the following:

1. create counterparties
2. create trusted destinations for counterparties
3. link wallets/token accounts to destinations
4. create transfer requests against destination objects
5. show trust state and business identity throughout the request and reconciliation flow

## Product Capabilities

### 1. Counterparty Registry

Need business-facing objects for:

- vendor
- customer
- partner
- internal treasury account
- exchange / trading venue

### 2. Destination Registry

Need destination objects with:

- label
- type
- chain
- wallet address
- token account if relevant
- internal/external flag
- active/inactive flag
- trust status
- notes

### 3. Trust State

Each destination should carry a trust state, at minimum:

- `unreviewed`
- `trusted`
- `restricted`
- `blocked`

### 4. Request Creation Against Destination Objects

A request should target:

- a counterparty/destination object

not just:

- a bare workspace address row

## Backend Work

### Add counterparties

Need a new model for counterparties.

Minimum fields:

- counterparty id
- organization id
- display name
- category
- external reference
- status
- metadata json
- created at
- updated at

### Add destinations

Minimum fields:

- destination id
- counterparty id nullable
- workspace id
- chain
- asset
- wallet address
- token account address nullable
- destination type
- trust state
- label
- notes
- is active
- metadata json
- created at
- updated at

### Link requests to destinations

Transfer requests should reference destination objects directly.

### Keep compatibility with current wallet registry

Do not rip out `workspace_addresses` immediately.
Instead:

- treat it as the lower-level address registry
- build destination objects above it

## Frontend Work

### Counterparties page

Need:

- list
- create
- edit
- status

### Destinations page

Need:

- list
- create
- trust state
- destination type
- linked wallet/token account

### Request form redesign

Need:

- choose counterparty
- choose destination
- see trust state inline
- show internal vs external clearly

### Request detail enrichment

Need:

- counterparty label
- destination trust state
- destination type
- internal/external status

## Milestones

### B1. Counterparty model

Product should support:

- create and list counterparties

### B2. Destination model

Product should support:

- create and list destinations
- trust state

### B3. Request integration

Product should support:

- creating requests against destinations
- showing destination context in request detail and reconciliation

## Exit Criteria

This phase is complete when:

- new requests are destination-aware
- operators see business context instead of only raw addresses
- trust state is visible and usable

## Non-Goals For This Phase

Do not build here:

- approval rules themselves
- execution integrations
- full counterparty risk engine

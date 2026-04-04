# Indexer Reconstruction Spec

Date: 2026-04-04

## Scope

This spec is only about the indexer layer.

Current priority:

- ingest Yellowstone transaction updates reliably
- reconstruct every observed USDC transaction into human-readable transfer facts
- reconstruct logical payments from those transfer facts

Out of scope for this phase:

- planned transfer matching redesign
- org-specific UI changes
- approval logic
- policy engine

The output of this phase should be a trustworthy base that later matching can consume.

## Product statement for the indexer

For every observed USDC transaction, the system should be able to answer:

- which wallets were involved
- which token accounts were involved
- which USDC legs occurred
- how much moved on each leg
- how many route legs existed
- whether a leg was direct settlement, fee-like, route hop, or unknown
- what logical payment or payments the transaction represents

This is universal transaction truth, not request-specific logic.

## Core principle

The indexer must not start from planned transfers.

It must start from raw chain data and produce:

1. `raw_observations`
2. `observed_transactions`
3. `observed_transfers`
4. `observed_payments`

Only after these exist should any matching or workspace logic run.

## Keep vs replace

### Keep

- `raw_observations`
- `observed_transactions`
- `observed_transfers`
- Yellowstone streaming setup
- ClickHouse writer pattern
- Postgres control plane for workspace addresses and transfer requests

### Add

- `observed_payments`
- transaction reconstruction stage
- leg classification stage
- payment bundling stage

### Stop treating as core for this phase

- `matcher_events`
- `request_book_snapshots`
- `settlement_matches`
- `exceptions`

These can remain in schema/code temporarily, but they are no longer the center of the architecture for indexer work.

## Target data model

### 1. raw_observations

Purpose:

- immutable ingest/debug source

Keep current role.

No redesign needed right now beyond reliability and completeness.

### 2. observed_transactions

One row per relevant USDC transaction signature.

Required meaning:

- “we observed a transaction containing USDC movement”

Current columns are close enough. Keep and add only if needed later.

Minimum fields:

- `signature`
- `slot`
- `event_time`
- `asset`
- `status`
- `raw_mutation_count`
- `participant_count`
- `properties_json`
- `created_at`

Suggested `properties_json` content:

- signer list
- top-level instruction count
- inner instruction count
- whether ALT addresses were loaded
- whether reconstruction used instruction parsing, balance deltas, or both

### 3. observed_transfers

This becomes the core source-of-truth transfer-leg table.

Each row means:

- “one USDC leg moved from source token account to destination token account”

Required columns:

- `transfer_id`
- `signature`
- `slot`
- `event_time`
- `asset`
- `source_token_account`
- `source_wallet`
- `destination_token_account`
- `destination_wallet`
- `amount_raw`
- `amount_decimal`
- `transfer_kind`
- `instruction_index`
- `inner_instruction_index`
- `route_group`
- `leg_role`
- `properties_json`
- `created_at`

Definitions:

- `transfer_kind`
  - keep simple for now: `credit`
- `instruction_index`
  - top-level instruction index
- `inner_instruction_index`
  - position inside the inner instruction set for that top-level instruction
- `route_group`
  - stable grouping key for multiple legs inside one transaction
- `leg_role`
  - one of:
    - `direct_settlement`
    - `route_hop`
    - `fee`
    - `rebate`
    - `self_change`
    - `ata_bootstrap`
    - `unknown`

`properties_json` should store reconstruction detail, for example:

- parsed program id
- parsed instruction type
- whether source/destination came from parsed instruction or delta fallback
- token balance before/after

### 4. observed_payments

This is the new required table.

Each row means:

- “one logical user-facing payment reconstructed from one transaction”

Required columns:

- `payment_id`
- `signature`
- `slot`
- `event_time`
- `asset`
- `source_wallet`
- `destination_wallet`
- `gross_amount_raw`
- `gross_amount_decimal`
- `net_destination_amount_raw`
- `net_destination_amount_decimal`
- `fee_amount_raw`
- `fee_amount_decimal`
- `route_count`
- `payment_kind`
- `reconstruction_rule`
- `confidence_band`
- `properties_json`
- `created_at`

Definitions:

- `gross_amount_raw`
  - total USDC value debited from the initiating source side for this payment
- `net_destination_amount_raw`
  - total USDC received by the intended destination side
- `fee_amount_raw`
  - amount routed to non-destination side legs when classified as fee/service leakage
- `route_count`
  - number of transfer legs in the payment bundle
- `payment_kind`
  - one of:
    - `direct`
    - `routed_with_fee`
    - `multi_leg_settlement`
    - `multi_payment_transaction`
    - `unknown`
- `reconstruction_rule`
  - how the payment was reconstructed, for example:
    - `single_direct_leg`
    - `same_signature_multi_leg_bundle`
    - `instruction_guided_bundle`
- `confidence_band`
  - one of:
    - `high`
    - `medium`
    - `low`

## Worker pipeline

The current worker should be reorganized into explicit stages.

### Stage 1: ingest

Input:

- Yellowstone transaction updates

Output:

- `raw_observations`
- in-memory transaction update object

Rules:

- record transaction updates durably
- keep liveness and reconnect behavior as first-class operational concerns

### Stage 2: transaction context build

Module target:

- new code in `yellowstone/src/yellowstone/mod.rs`
- may later be split into `transaction_context.rs`

Build a normalized transaction context:

- resolved account keys including ALT-loaded addresses
- top-level instructions
- inner instructions
- log messages
- pre/post token balances for USDC
- signer set

Output:

- in-memory `TransactionContext`

Suggested Rust struct:

```rust
struct TransactionContext {
    signature: String,
    slot: u64,
    event_time: DateTime<Utc>,
    account_keys: Vec<String>,
    signers: Vec<String>,
    top_level_instructions: Vec<InstructionContext>,
    inner_instruction_sets: Vec<InnerInstructionSet>,
    usdc_balance_snapshots: Vec<TokenBalanceContext>,
    log_messages: Vec<String>,
}
```

### Stage 3: transfer leg extraction

This stage produces `observed_transfers`.

Primary source:

- parsed token transfer instructions from top-level and inner instructions

Fallback source:

- balance delta reconciliation from pre/post token balances

Rules:

1. extract explicit SPL token transfer legs when instruction parsing is available
2. use pre/post token balances to validate legs and fill missing amount/balance detail
3. only fall back to pure delta inference when parsed transfer instructions are unavailable

Output:

- `Vec<ObservedTransfer>`

Suggested Rust struct:

```rust
struct ObservedTransfer {
    transfer_id: Uuid,
    signature: String,
    slot: u64,
    event_time: DateTime<Utc>,
    asset: String,
    source_token_account: Option<String>,
    source_wallet: Option<String>,
    destination_token_account: String,
    destination_wallet: Option<String>,
    amount_raw: i128,
    instruction_index: Option<u32>,
    inner_instruction_index: Option<u32>,
    route_group: String,
    leg_role: LegRole,
    properties_json: Option<String>,
}
```

### Stage 4: leg classification

Classify each transfer leg.

Inputs:

- parsed instruction type
- token-account owners
- signers
- whether source/destination are program-owned or user-owned
- route grouping

Initial classification rules:

- `direct_settlement`
  - source side to recipient side without intermediate program-owned vault hop
- `route_hop`
  - leg touches an intermediate program-owned account or is clearly part of a routed chain
- `fee`
  - side leg that does not settle to the intended destination and appears residual/service-like
- `rebate`
  - side leg back toward initiating side
- `self_change`
  - source wallet and destination wallet are same logical owner
- `ata_bootstrap`
  - ATA lifecycle step without actual payment value
- `unknown`
  - anything not safely classifiable

Important rule:

- prefer `unknown` over false certainty

### Stage 5: payment bundling

This is the new core stage.

Input:

- all `ObservedTransfer` legs for one signature

Output:

- one or more `ObservedPayment` rows

Bundling rule v1:

- one signature may produce one or more payment bundles
- group by:
  - source-side origin
  - instruction/inner-instruction route grouping
  - coherent asset flow

V1 heuristic:

- if one signature has one clear initiating source and one clear intended destination path, emit one payment
- if one signature contains clearly separate transfer clusters, emit multiple payments

Suggested Rust struct:

```rust
struct ObservedPayment {
    payment_id: Uuid,
    signature: String,
    slot: u64,
    event_time: DateTime<Utc>,
    asset: String,
    source_wallet: Option<String>,
    destination_wallet: Option<String>,
    gross_amount_raw: i128,
    net_destination_amount_raw: i128,
    fee_amount_raw: i128,
    route_count: u32,
    payment_kind: PaymentKind,
    reconstruction_rule: String,
    confidence_band: ConfidenceBand,
    properties_json: Option<String>,
}
```

### Stage 6: persistence

Persist in this order:

1. `observed_transactions`
2. `observed_transfers`
3. `observed_payments`

No matching logic should run before these rows exist.

## Parsing rules

### Rule 1: instruction parsing is primary

If the transaction metadata exposes token transfer instructions:

- use them first to define transfer legs

Why:

- balance deltas alone are not enough to understand routing semantics

### Rule 2: pre/post token balances validate and enrich

Use `preTokenBalances` and `postTokenBalances` to:

- validate leg amounts
- recover before/after values
- catch deltas even when instruction parsing is incomplete

### Rule 3: inner instructions are mandatory

Do not reconstruct only from top-level instructions.

Many routed transfers happen in CPI.

The parser must examine:

- top-level instructions
- inner instructions

### Rule 4: ALT resolution is mandatory

All account resolution must include:

- message account keys
- loaded writable addresses
- loaded readonly addresses

Without this, instruction account references will be wrong for versioned transactions.

### Rule 5: no request-aware parsing

The indexer must not use workspace requests to decide what a transaction means.

Transaction meaning must be reconstructed independent of application state.

## Schema changes

### ClickHouse: observed_transfers

Add:

- `instruction_index Nullable(UInt32)`
- `inner_instruction_index Nullable(UInt32)`
- `route_group String DEFAULT ''`
- `leg_role LowCardinality(String) DEFAULT 'unknown'`

Keep existing columns.

### ClickHouse: observed_payments

Create this table.

Recommended DDL shape:

```sql
CREATE TABLE IF NOT EXISTS observed_payments
(
    payment_id UUID,
    signature String,
    slot UInt64,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    source_wallet Nullable(String),
    destination_wallet Nullable(String),
    gross_amount_raw Int128,
    gross_amount_decimal Decimal(38, 6),
    net_destination_amount_raw Int128,
    net_destination_amount_decimal Decimal(38, 6),
    fee_amount_raw Int128,
    fee_amount_decimal Decimal(38, 6),
    route_count UInt32,
    payment_kind LowCardinality(String),
    reconstruction_rule LowCardinality(String),
    confidence_band LowCardinality(String),
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, signature, payment_id);
```

## Code organization changes

### Current files

- `yellowstone/src/yellowstone/mod.rs`
- `yellowstone/src/storage.rs`

### Recommended new modules

- `yellowstone/src/yellowstone/transaction_context.rs`
- `yellowstone/src/yellowstone/transfer_reconstruction.rs`
- `yellowstone/src/yellowstone/payment_reconstruction.rs`

Responsibilities:

- `transaction_context.rs`
  - build normalized transaction context from Yellowstone update
- `transfer_reconstruction.rs`
  - extract and classify `ObservedTransfer` legs
- `payment_reconstruction.rs`
  - bundle transfer legs into `ObservedPayment`s

This keeps `mod.rs` as orchestration instead of business logic soup.

## API changes for this phase

Expose new read-side endpoints:

- `GET /workspaces/:workspaceId/observed-transfers`
- `GET /workspaces/:workspaceId/observed-payments`

The workspace filter should be:

- any observed transfer/payment where at least one involved wallet or ATA belongs to a workspace wallet

Important:

- the universal tables remain global
- workspace filtering happens at query time

## Test plan

This phase is only acceptable if tests cover realistic transaction shapes.

### Unit tests

For `transfer_reconstruction.rs`:

- direct one-leg transfer
- ATA create + transfer in same signature
- inner-instruction transfer
- versioned tx with loaded ALT addresses
- multiple transfer legs in one signature

For `payment_reconstruction.rs`:

- single direct payment
- routed payment with one fee side leg
- split recipient settlement across multiple legs in one signature
- two unrelated payments in one signature
- ambiguous/unknown route case

### Integration tests

Worker integration should verify:

- transaction update -> `observed_transactions`
- same tx -> correct `observed_transfers`
- same tx -> correct `observed_payments`

### Real-world regression fixtures

Add fixtures for the transaction shapes already seen in development:

- direct exact transfer
- partial due to routed side leg
- split total amount across multiple legs
- ATA bootstrap + transfer

## Milestones

### Milestone 1: transfer-leg correctness

Deliver:

- enriched `observed_transfers`
- instruction-aware extraction
- inner-instruction handling
- route-group metadata

Success criterion:

- for a real tx, we can explain every USDC leg accurately

### Milestone 2: logical payment reconstruction

Deliver:

- `observed_payments`
- payment bundling
- fee/route count explanation

Success criterion:

- for a real tx, we can explain the logical payment in plain English

### Milestone 3: matching migration

Deliver later:

- planned transfers matched against `observed_payments`

Success criterion:

- routed txs no longer appear “partial” just because one signature contained multiple legs that belong to one payment

## Immediate next coding step

Do not touch matching first.

First implement:

1. `observed_transfers` enrichment
2. transaction context extraction
3. `observed_payments` creation

That is the correct indexer-first path.

# Routed Transfer Matching Architecture

Date: 2026-04-04

## Why the current engine is insufficient

The current matcher allocates each observed USDC credit leg independently against open requests for the exact destination ATA.

That works for:
- one direct source ATA -> destination ATA transfer
- exact amount
- one credit leg

It breaks down when a single user-visible payment is represented on-chain as:
- multiple USDC credit legs in the same signature
- fee or service side legs
- ATA creation plus transfer
- program-owned intermediate vault hops
- top-level instruction plus inner CPI token transfers

So the current primitive is too low-level:

- current primitive: `credit leg`
- needed primitive: `logical payment reconstructed from the whole transaction`

The next engine should be:

1. transaction reconstruction
2. transfer-leg extraction
3. payment bundle reconstruction
4. planned-transfer matching

## Relevant chain facts

The main sources we should treat as ground truth are:

- Solana `getTransaction` / Yellowstone transaction update metadata:
  - `preTokenBalances`
  - `postTokenBalances`
  - `innerInstructions`
  - loaded ALT addresses
- SPL Token parsed instructions such as `transfer` / `transferChecked`

The docs support this shape directly:

- Solana `getTransaction` returns transaction structure plus `meta`, including token balances and inner instructions:
  - https://solana.com/docs/rpc/http/gettransaction
- Helius `getTransaction` guide highlights `preTokenBalances`, `postTokenBalances`, `innerInstructions`, `loadedAddresses`, and `logMessages` as the metadata used for analysis:
  - https://www.helius.dev/docs/rpc/guides/gettransaction

Implication:

- token balance deltas tell us what changed
- parsed instructions tell us why it changed
- inner instructions matter because routed payments often happen in CPI, not just top-level instructions

## Design goal

For one signature, the system should be able to answer:

- what wallets and token accounts were touched?
- what USDC transfer legs happened?
- which legs were direct recipient settlement?
- which legs were fees, rebates, or route hops?
- what is the user-facing logical payment represented by this transaction?
- does that logical payment satisfy a planned transfer?

## Recommended architecture

Use a 4-layer model.

### Layer 1: Raw transaction intake

Keep:

- `raw_observations`

Purpose:

- immutable ingestion/debug source
- prove whether Yellowstone saw the tx

No matching logic lives here.

### Layer 2: Transaction context

Build one transaction context per signature from Yellowstone transaction updates.

This context should include:

- signature
- slot
- event time
- signers
- resolved account keys
- loaded writable/readonly ALT addresses
- top-level instructions
- inner instructions
- log messages
- USDC token balance snapshots before/after

This should exist in memory during processing, and optionally be persisted as JSON if needed later for debugging. It does not need to be the first user-facing table.

### Layer 3: Transfer legs

Produce a canonical `observed_transfers` row per USDC leg.

This is already the right table conceptually. It should become richer.

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
- `leg_role`
- `route_group`
- `properties_json`

New conceptual fields:

- `instruction_index`
  - top-level instruction index in the transaction
- `inner_instruction_index`
  - CPI position if the leg came from inner instructions
- `leg_role`
  - one of:
    - `direct_settlement`
    - `route_hop`
    - `fee`
    - `rebate`
    - `self_change`
    - `ata_bootstrap`
    - `unknown`
- `route_group`
  - lets multiple legs in one transaction be grouped into one flow

This table remains the source of truth for individual on-chain movements.

### Layer 4: Logical payments

Add a new table:

- `observed_payments`

This is the missing layer.

One row here means:

- "this signature represented one user-facing USDC payment"

Suggested columns:

- `payment_id`
- `workspace_id`
- `signature`
- `slot`
- `event_time`
- `asset`
- `source_wallet`
- `destination_wallet`
- `gross_amount_raw`
- `net_destination_amount_raw`
- `fee_amount_raw`
- `route_count`
- `payment_kind`
- `reconstruction_rule`
- `confidence_band`
- `explanation`
- `properties_json`
- `created_at`

Definitions:

- `gross_amount_raw`
  - total USDC debited from the initiating/source side for this payment
- `net_destination_amount_raw`
  - total USDC credited to the intended destination side
- `fee_amount_raw`
  - gross minus net recipient value if side-fee legs were identified
- `route_count`
  - number of transfer legs contributing to this payment

This becomes the table the UI should use for:

- "what happened in this transaction?"
- "how many routes did it take?"
- "what fee side legs existed?"

## Matching model

The matcher should stop matching `planned transfer -> observed transfer leg`.

It should instead match:

- `planned transfer -> observed payment`

That is the right abstraction.

## Planned transfer semantics

We need to make one product choice explicit.

There are two different interpretations of a planned transfer:

1. `gross send intent`
   - wallet A spent X USDC in a transaction intended for wallet B
2. `net recipient settlement intent`
   - wallet B actually received X USDC

These are not the same when routing/fees exist.

For this product, the safer design is:

- store one intent record
- compute both gross and net match views

So a planned transfer can show:

- requested amount
- gross matched amount
- net recipient matched amount
- fee / route leakage

That avoids hiding complexity from the operator.

## Payment reconstruction rules

For each transaction signature:

1. build all USDC legs
2. classify legs
3. group related legs into payment bundles
4. emit one or more `observed_payments`

### Step 1: build all USDC legs

Use:

- token balance deltas from `preTokenBalances` and `postTokenBalances`
- parsed token transfer instructions from top-level and inner instructions

Important rule:

- instruction-level parsing should be primary when available
- balance deltas are the fallback and validation layer

Reason:

- deltas tell us *what* changed
- instructions tell us *why* and *which leg belongs to which route path*

### Step 2: classify legs

Classify each leg using instruction type, token-account owners, and workspace wallet membership.

Initial rules:

- `ata_bootstrap`
  - ATA creation or initialize instruction without economic transfer
- `direct_settlement`
  - token transfer from source side to destination side
- `route_hop`
  - transfer into or out of a program/vault intermediary
- `fee`
  - side transfer not reaching intended destination, often small residual amount
- `self_change`
  - transfer where source and destination wallet owners are the same logical wallet
- `unknown`
  - anything we cannot safely explain

### Step 3: group related legs into payment bundles

Within one signature, group legs by:

- asset
- source-side initiating wallet
- shared instruction subtree / route group
- temporal equality (same signature/event)

The engine should support multiple logical payments inside one signature, but default to one bundle if the transaction clearly represents one payment flow.

### Step 4: compute payment summaries

For each payment bundle compute:

- source wallet
- likely destination wallet
- gross amount
- net destination amount
- total side fees
- route count
- settlement path summary

Example:

- leg 1: source ATA -> recipient ATA `9179`
- leg 2: source ATA -> fee ATA `821`

Payment summary:

- gross amount = `10000`
- net destination amount = `9179`
- fee amount = `821`
- route count = `2`
- payment kind = `routed_with_fee`

This is the level at which operators can understand the tx.

## Match outcomes

After reconstructing `observed_payments`, matching against `transfer_requests` becomes simpler and more honest.

Suggested outcomes:

- `matched_direct_exact`
  - one payment, one destination, gross == net == requested
- `matched_routed_exact_gross`
  - gross matches requested, destination is correct, but net destination is lower because of fee/routing
- `matched_net_exact`
  - destination actually received requested amount, even if route count > 1
- `matched_partial`
  - only part of the planned amount is explained
- `matched_split`
  - planned amount satisfied across multiple signatures/payments
- `needs_review_unknown_route`
  - tx involved destination/source but reconstruction confidence is low
- `unmatched`

For the UI, the important distinction is:

- did the planned transfer happen exactly?
- did it happen but with routing/fees?
- did it only partially happen?
- do we not understand the tx well enough?

## Minimal schema evolution

Keep:

- `raw_observations`
- `observed_transactions`
- `observed_transfers`
- `settlement_matches`

Add:

- `observed_payments`

Optional later:

- `transaction_contexts`
  - only if we decide full transaction reconstruction needs persisted JSON context

Do not add more tables than this in the next pass.

## Recommended implementation order

### Phase 1: leg enrichment

Upgrade transaction parsing so `observed_transfers` includes:

- instruction index
- inner instruction index
- route group
- leg role

This requires:

- parsing top-level parsed instructions
- parsing inner instructions
- resolving ALT-loaded account keys reliably

### Phase 2: payment reconstruction

Build an in-memory payment reconstructor:

- input: all legs for one signature
- output: one or more `observed_payments`

Write tests for:

- direct transfer
- ATA create + transfer
- transfer with side fee
- two-leg routed payment
- one signature containing multiple unrelated transfers

### Phase 3: payment-based matching

Change matching input from:

- `observed_transfers`

to:

- `observed_payments`

And record both:

- gross match result
- net destination result

### Phase 4: operator-facing transaction explanation

In the UI, for one transaction show:

- source wallet
- destination wallet
- gross amount
- net destination amount
- fee amount
- route count
- legs list
- why this was considered exact / routed / partial

## Concrete recommendation for this repo

The right next build is:

1. enrich `observed_transfers`
2. add `observed_payments`
3. match planned transfers to `observed_payments`
4. expose route breakdown in the frontend

Do not try to patch the current FIFO allocator into doing this implicitly.

The allocator can still exist, but one level up:

- current allocator input: credit legs
- future allocator input: logical payments

That is the critical correction.

## What this solves

This design will let us answer all of the following cleanly:

- why was a tx marked partial if the total was `0.01`?
- how many legs did the tx take?
- how much reached the intended destination?
- how much was taken by side routes/fees?
- should the planned transfer count as complete gross or incomplete net?

That is the right foundation for the next matching engine.

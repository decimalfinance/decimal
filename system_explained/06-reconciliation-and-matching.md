# 06 Reconciliation And Matching

Reconciliation is the core technical differentiator.

The matcher must answer:

```text
Given observed USDC movement on Solana, which expected payment did it satisfy?
```

This is harder than comparing amount and destination because:

- One intended payment can settle in multiple transactions.
- One transaction can contain multiple token transfers.
- Swaps and unrelated USDC movements can appear near watched wallets.
- Token accounts differ from wallet addresses.
- Users may submit transactions outside Axoria.
- Multiple pending requests may target the same destination.
- Partial and overfilled payments need exceptions, not silent success.

## Data Inputs

The matcher has two broad inputs.

### Expected Side

Expected payments come from Postgres:

- Transfer requests.
- Payment orders.
- Destination wallet/token account.
- Source wallet/token account.
- Expected amount.
- Submitted signatures.
- Workspace ownership.

The worker fetches this through the API matching index.

### Observed Side

Observed payments come from Yellowstone:

- Transaction signatures.
- Account keys.
- Token balance changes.
- Inner instructions.
- SPL token transfers.
- Native fee and route context.

The worker reconstructs transfers and payments before matching.

## Matching Index

The matching index is the bridge from API to worker.

It contains the currently relevant matching context:

- workspace IDs
- watched wallet addresses
- watched token accounts
- destinations
- pending transfer requests
- expected amounts
- submitted signatures
- request metadata

The worker fetches it from:

```text
/internal/matching-index
```

The worker listens for refresh events through:

```text
/internal/matching-index/events
```

This is event-driven, not polling.

## Why We Do Not Dynamically Resubscribe Per Wallet

The system currently avoids constantly changing the Yellowstone subscription for each user-added wallet.

Reason:

- If many users add/delete wallets frequently, changing gRPC subscriptions constantly is operationally fragile.
- A stable stream plus internal relevance filtering is simpler and more robust.

The architecture is:

```text
Stream broad enough USDC activity
  -> reconstruct candidate transactions
  -> filter by matching index
  -> store only relevant materialized rows
```

The important principle:

```text
Do not store the whole world. Store relevant observed data for watched workspaces/signatures.
```

## Signature-First Matching

If Axoria prepared execution and recorded a submitted signature, matching should prefer that signature.

Algorithm concept:

```text
if observed transaction signature equals submitted signature:
    match this observed payment to that request/order first
else:
    use fallback destination/FIFO matching
```

This matters because app-originated payments should not rely only on amount/destination coincidence.

Signature-first matching is stronger because:

- the user signed the packet Axoria prepared
- the transaction signature is unique
- the worker can directly link on-chain reality to control-plane intent

## FIFO Matching

When no submitted signature exists, fallback matching uses a payment-book/FIFO style approach.

Concept:

```text
For each destination:
  keep pending expected requests ordered by time.

For each observed payment to that destination:
  allocate amount to oldest compatible request first.
```

FIFO matching supports:

- exact match
- partial match
- split match
- overfill

## Exact Match

Expected amount equals observed/allocated amount.

Example:

```text
Expected: 0.010000 USDC
Observed: 0.010000 USDC
Result: matched exact
```

## Split Match

Expected amount is satisfied by multiple observed payments.

Example:

```text
Expected: 0.100000 USDC
Observed #1: 0.050000 USDC
Observed #2: 0.050000 USDC
Result after #1: partial settlement
Result after #2: matched split / settled
```

The system must update prior partial exceptions when the gap is later satisfied.

## Partial Match

Observed amount is less than expected and no later payment has closed the gap yet.

Example:

```text
Expected: 0.100000 USDC
Observed: 0.050000 USDC
Result: partially settled + exception
```

Partial settlement is not a silent failure. It is useful operational information.

## Overfill

Observed amount exceeds expected amount.

Example:

```text
Expected: 0.100000 USDC
Observed: 0.150000 USDC
Result: matched/overfilled + exception for extra 0.050000
```

Overfills should be reviewed because they may indicate duplicate payment, typo, or unrelated movement.

## Unrelated Transactions

The system should not label unknown transactions as fees just because it cannot classify them.

If a transaction is a SOL -> USDC swap and not relevant to an expected payment, the correct behavior is:

- do not match it to an expected payment
- do not call it a fee unless it is truly fee-like
- either ignore it if irrelevant, or surface it as unclassified observed activity only if it touches a watched wallet

Bad classification is worse than no classification.

## Exceptions

Worker-generated exceptions live in ClickHouse. Operator metadata lives in Postgres.

Exception examples:

- partial settlement
- overfilled settlement
- unknown settlement
- unmatched observed transfer
- execution signature did not produce expected settlement
- stale pending request

Exception handling should answer:

- what happened?
- why does it matter?
- what payment/order does it affect?
- what evidence exists?
- what action can an operator take?

## API Reconciliation Reads

The API reads ClickHouse and overlays Postgres.

Typical API responsibilities:

- List observed transfers.
- Show real USDC movement.
- List reconciliation items.
- Fetch request/order reconciliation detail.
- List exceptions.
- Attach notes and resolution metadata.
- Build proof packets.

## Matching Invalidation

When relevant control-plane state changes, the API emits a matching-index refresh event.

Examples:

- New treasury wallet (ours — source side of payments, watched as "ours" on-chain).
- New destination (theirs — counterparty side of expected matches).
- New transfer request.
- Payment order submitted.
- Signature attached.
- Approval state changed.
- Payment run created.

The worker sees the event and refreshes the matching index.

## Important Failure Modes

### Duplicate Pending Requests To Same Destination

If two pending requests have same destination and same amount, FIFO can match the wrong business object unless there is a submitted signature or unique reference.

Mitigation:

- enforce duplicate detection
- prefer signature-first matching
- use source wallet where available
- keep proof/audit visible

### Missing Source Wallet

If source wallet is not specified, matching can still happen on destination/amount, but confidence is lower.

UI and API should communicate this.

### External Execution Without Signature

If a user sends outside Axoria and does not attach signature, FIFO matching may still settle the request if amount/destination match.

This is useful, but not as strong as signature-first matching.

### Label Resolver Noise

Repeated unresolved Orb label fetches create log noise and unnecessary external calls.

Negative label results should be cached or suppressed.

### Reorgs / Finality

The current docs do not prove a mature finality/reorg strategy. Production hardening should define commitment levels, replay behavior, and idempotent ClickHouse writes.


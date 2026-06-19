# 03 Payment Lifecycle

A payment order is captured, routed (auto-pay or proposal), executed on Squads, verified by
RPC, and proven. There are two execution paths; both end in the same verification + proof.

```text
input captured -> payment order ready -> review gate
  -> [auto-pay]  agent spends within a Squads spending limit
  -> [proposal]  Squads members approve/reject -> execute
  -> RPC settlement verified (token-account deltas) -> proof exported
```

## Capture

A `PaymentOrder` is created from manual entry, a CSV row, or invoice extraction — all converge
into the one table. It targets a `CounterpartyWallet` (the payout address) and a source
`TreasuryWallet`. Batch imports are grouped by `input_batch_id` / `input_batch_label` on the
orders, not a separate run table.

## Review Gate

Before routing, the order is checked. It is held in `needs_review` if the payout address is
unreviewed, or is a new/changed address for a known vendor, or is a near-duplicate look-alike
of an existing address. A human reviews and either rejects (the order is cancelled) or approves
(the address becomes trusted and routing proceeds). See
[07 Payment Routing Algorithm](./07-payment-routing-algorithm.md).

## Path A — Auto-Pay (Spending Limit)

If the order matches an active spending limit — amount ≤ cap, destination on the limit's
allowlist, active agent wallet, period budget remaining — the agent pays directly:

1. Build the transaction (create destination ATA if needed + `spendingLimitUse`).
2. The Privy-managed agent wallet signs and submits it.
3. The spend is recorded as a `spending_limit_execution`.
4. RPC settlement verification confirms the USDC token-account deltas.

The on-chain spending limit is the authority: the agent can only move funds to allowlisted
destinations, up to the cap, within the period. The SVM enforces this regardless of the backend.

## Path B — Squads Voting Proposal

If the order doesn't qualify for auto-pay, it enters Squads voting:

1. Create a Squads vault proposal for the payment.
2. Confirm the proposal submission signature through RPC.
3. Squads members approve or reject on-chain.
4. Once approved, execute it; confirm the execution signature through RPC.
5. RPC settlement verification checks the expected USDC token-account deltas.

The payment order becomes `settled` only when the deltas match. One proposal can carry multiple
USDC transfers (a batch); verification aggregates expected destination deltas by token account.

## Local State Layers

- `payment_orders.state`: product-facing payment state.
- `transfer_requests.status`: approval/settlement intent state (consumed by proof builders; not
  a second competing approval journey to surface).
- `decimal_proposals.localStatus`: local mirror of the Squads proposal lifecycle —
  `prepared -> submitted -> approved | rejected -> executed`. The on-chain proposal is the
  execution authority; Decimal mirrors enough to render the product and retry confirmation.

## Why RPC Verification Is Enough

Decimal creates the transaction that moves money from a known Squads vault (or via a known
spending limit) to known destination token accounts, so the execution signature is known.
Verification fetches the parsed transaction by signature and checks:

- it exists and is confirmed/finalized to the configured commitment
- the expected destination USDC token accounts changed by the expected amounts
- the deltas aggregate correctly for batch payments

This is narrower than a global reconciliation engine, but it's the correct primitive for
app-originated payments.

## Failure Modes

- RPC can't find the parsed transaction yet: the proposal stays executed with verification
  pending; the client can retry confirmation.
- RPC deltas don't match: the payment becomes review-worthy via
  `metadata_json.rpcSettlementVerification.status = "mismatch"`.
- A different execution signature is submitted later: the API returns a conflict.

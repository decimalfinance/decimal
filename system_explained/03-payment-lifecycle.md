# 03 Payment Lifecycle

The current payment lifecycle is intentionally shorter than the old expected-transfer lifecycle.

```text
input captured
  -> payment order ready
  -> Squads proposal created
  -> proposal submitted
  -> approved or rejected by Squads members
  -> executed on Squads
  -> RPC settlement verified
  -> proof exported
```

## Single Payment

1. Create a `PaymentRequest` or direct `PaymentOrder`.
2. The payment targets a reviewed `CounterpartyWallet` and a source `TreasuryWallet`.
3. Create a Squads vault proposal for the payment.
4. Confirm the proposal submission signature through RPC.
5. Squads members approve or reject on-chain.
6. Once the on-chain proposal is approved, execute it.
7. Confirm the execution signature through RPC.
8. RPC settlement verification checks expected USDC token-account deltas.
9. The payment order becomes `settled` only when the deltas match.

## Payment Run

A payment run is a batch wrapper around multiple payment orders.

One Squads vault proposal can contain multiple USDC transfers. Execution verification aggregates expected destination token-account deltas by token account.

Payment runs can be created from:

- manually entered rows
- CSV import
- document import, where `payments/document-extract.ts` extracts rows and feeds the same run-import path

## Local State Names

There are three state layers:

- `payment_orders.state`: product-facing payment state.
- `transfer_requests.status`: approval and settlement intent state.
- `decimal_proposals.localStatus`: local mirror of the Squads proposal lifecycle.

The product should present the Squads proposal lifecycle as the main payment execution story. The transfer-request state exists because older approval/proof code still relies on it; it should not be exposed as a second competing approval journey.

## Squads Proposal States

The on-chain Squads proposal is the execution authority. Decimal mirrors enough state in `decimal_proposals` to render the product and retry confirmation safely:

- `prepared`: Decimal created a signable proposal transaction.
- `submitted`: the proposal creation transaction was confirmed by RPC.
- `approved`: enough Squads voters approved on-chain.
- `rejected`: enough Squads voters rejected on-chain.
- `executed`: the Squads execution transaction was confirmed by RPC.

Payment orders and runs derive their execution story from the linked proposal.

## Why RPC Verification Is Enough For The Current Product

Decimal creates the transaction that moves money from a known Squads vault to known destination token accounts. Because the execution signature is known, verification does not need a global stream.

The API fetches the parsed transaction by signature and checks:

- the transaction exists and is confirmed/finalized enough for the configured commitment
- expected destination USDC token accounts changed by the expected amounts
- the deltas aggregate correctly for batch payments

This is narrower than a full reconciliation engine, but it is the correct primitive for app-originated payments.

## Failure Modes

- RPC cannot find parsed transaction yet: proposal remains executed with verification pending, and the client can retry confirmation.
- RPC deltas do not match: payment state becomes review-worthy through `rpcSettlementVerification.status = "mismatch"`.
- Different execution signature submitted later: API returns conflict.

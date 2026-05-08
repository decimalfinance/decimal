# RPC Confirmation And Squads Lifecycle Handoff

This handoff documents the latest backend/product shift:

- Yellowstone is no longer part of the core product runtime.
- Squads payment state is now represented with a simplified lifecycle.
- Proposal submission/execution confirmation now uses Solana RPC directly.

## Product Direction

Decimal is currently moving toward a Squads-backed treasury product, not a pure reconciliation/indexing product.

That means the primary product path is:

```text
create payment intent
  -> create Squads proposal
  -> approve proposal
  -> execute proposal
  -> confirm via RPC
  -> optionally verify/export proof
```

Yellowstone still exists in the repo, but it is now optional infrastructure. It should not be assumed by the main payment workflow.

## Runtime Split

### Core Product Runtime

Used for normal development and product testing:

```bash
make dev
make dev devnet
make dev mainnet
```

This starts:

- Postgres
- API
- Frontend

It does **not** start:

- Yellowstone worker
- ClickHouse indexing path

### Optional Indexer Runtime

Used only when we explicitly want to test indexing/reconciliation:

```bash
make dev-indexer
```

This starts/syncs:

- ClickHouse schema
- Yellowstone worker

`make dev-worker` still exists for running only the worker.

## Simplified Squads Payment Lifecycle

The product-facing Squads payment lifecycle is now:

```text
draft -> ready -> proposed -> approved -> executed -> settled
```

Additional terminal/problem states:

```text
exception
cancelled
closed
```

### State Meaning

`draft`

Payment intent exists, but it is not ready to become a treasury action yet.

`ready`

Payment has enough information to become a Squads proposal.

For a Squads treasury, this means the next action is **Create proposal**.

`proposed`

The Squads proposal exists on-chain.

The next action is usually voting/approval.

`approved`

The Squads proposal has enough approvals on-chain.

The next action is execution.

`executed`

The Squads proposal execution transaction has been submitted and confirmed through RPC.

This means the treasury action has happened from Decimal's perspective.

`settled`

The expected settlement has been verified/matched.

This can still be backed by future reconciliation work, but it should not block the Squads proposal lifecycle itself.

`exception`

Something does not match expected settlement or operational review is needed.

`cancelled`

Payment/proposal was rejected or cancelled.

`closed`

Final archived state.

## Why This Changed

The old lifecycle had duplicated approval/execution concepts:

```text
Decimal approval -> ready for execution -> Squads proposal -> Squads approval -> Squads execution
```

That is too much.

For Squads treasuries, Squads itself is the approval/execution system. Decimal should not show a separate full approval workflow before the actual proposal.

The UI should present the lifecycle as:

```text
Requested -> Propose -> Approve -> Execute -> Verify
```

## Backend Read Model

Payment orders now expose a product-facing lifecycle field:

```ts
order.productLifecycle
```

Shape:

```ts
{
  productState: PaymentOrderState;
  source: "squads_v4" | "legacy" | string;
  steps: string[];
}
```

For Squads payments, frontend should prefer:

```ts
order.productLifecycle.productState
```

over raw/internal fields.

The backend still keeps compatibility with old/internal states because older payment and reconciliation code still exists.

## Frontend Guidance

For Squads-sourced payments:

```ts
const state = order.productLifecycle?.productState ?? order.derivedState;
```

Do not build primary UI behavior around these old states:

```text
pending_approval
ready_for_execution
proposal_prepared
proposal_submitted
proposal_approved
proposal_executed
execution_recorded
```

Some of these still exist for compatibility, tests, older code paths, or legacy reconciliation flows. They should not drive the new Squads UX.

Use this mapping:

```text
ready    -> show "Create proposal"
proposed -> show "Proposal active / voting"
approved -> show "Execute proposal"
executed -> show "Executed / verifying"
settled  -> show "Completed"
```

## Existing Proposal Fields

Payments may include:

```ts
order.squadsLifecycle
order.squadsPaymentProposal
order.canCreateSquadsPaymentProposal
```

Important behavior:

- If `canCreateSquadsPaymentProposal === false`, do not show a create-proposal CTA.
- If `squadsPaymentProposal` exists, link the user to the proposal surface.
- If `squadsLifecycle.executedSignature` exists, show it as execution evidence.

## RPC Confirmation

The backend now verifies proposal submission/execution signatures through RPC before mutating local state.

Endpoints affected:

```text
POST /organizations/:organizationId/proposals/:decimalProposalId/confirm-submission
POST /organizations/:organizationId/proposals/:decimalProposalId/confirm-execution
```

Both endpoints now:

1. Validate the signature shape.
2. Poll Solana RPC via `getSignatureStatuses`.
3. Reject if the transaction failed.
4. Reject if the signature is not confirmed yet.
5. Only then update Decimal proposal/payment state.

Implementation location:

```text
api/src/squads-treasury.ts
```

Helper:

```ts
verifyRpcSignatureConfirmed(signature, purpose)
```

Uses:

```ts
waitForSignatureVisible(getSolanaConnection(), signature)
```

from:

```text
api/src/solana.ts
```

## Frontend Confirmation Flow

Frontend flow should remain:

1. Ask backend to prepare intent.
2. Ask backend/Privy to sign transaction.
3. Submit transaction from frontend.
4. Poll signature visibility client-side.
5. Call backend confirm endpoint with the signature.

The backend now repeats the important confirmation check. This is intentional.

Client-side polling is UX.

Backend-side polling is correctness.

## Error Handling Expectations

If backend confirmation returns:

```text
400 Transaction signature is not confirmed yet
```

the frontend should show a retry confirmation action, not ask the user to recreate the proposal.

Important: the proposal may already exist on-chain even if confirmation timed out.

The safe UI behavior is:

```text
"Transaction submitted. Confirmation is still pending. Retry confirmation."
```

Do not show:

```text
"Create proposal"
```

after a signature has been submitted.

## Squads Rejection

Squads v4 supports rejection.

The SDK exposes:

```ts
multisig.instructions.proposalReject(...)
```

Backend now exposes:

```text
POST /organizations/:organizationId/proposals/:decimalProposalId/reject-intent
```

Frontend API client now has:

```ts
api.createProposalRejectIntent(...)
```

Permissions:

- The signer must be an on-chain Squads member.
- The signer must have `vote` permission.

Frontend still needs to wire the actual reject button/action if not already done.

## What Not To Remove Yet

Do not delete these yet:

- `yellowstone/`
- ClickHouse schema
- reconciliation routes
- internal matching index routes

They are detached from core runtime but preserved for future use.

The current safe stance:

```text
Core product uses RPC.
Indexer remains optional.
```

## Suggested Next Cleanup

Recommended follow-up order:

1. Update UI copy to use the simplified lifecycle only.
2. Wire proposal rejection in proposal detail/list UI.
3. Add a retry-confirmation button for submitted signatures.
4. Hide old approval/reconciliation surfaces from the primary nav if they confuse the Squads treasury flow.
5. Later, decide whether reconciliation becomes:
   - lightweight RPC/token-account verification, or
   - optional Yellowstone-powered advanced reconciliation.

## Validation Already Run

These passed after the change:

```bash
npm run build # api
npm run build # frontend
make test-api
```

`make test-api` result:

```text
40/40 passing
```


# Agent Payment Proposal Backend Handoff

## What changed

The backend now supports the intended AP automation path:

1. Invoice intake creates `PaymentOrder` records.
2. If a row is clean, the Decimal org agent creates and submits a Squads payment proposal immediately.
3. If a row needs review, no proposal is created.
4. When a human clears review, the backend can automatically ask the agent to create and submit the Squads proposal.
5. Re-running agent advance is idempotent. If a payment already has an active proposal, the endpoint returns `already_has_proposal`.

This does not execute the payment. It only creates/submits the Squads proposal using the org agent's initiate-only wallet. Voting and execution still happen through the normal Squads proposal flow unless the payment uses a separate active spending-limit policy.

## Backend endpoints

### Upload invoice

`POST /organizations/:organizationId/invoices/upload`

New request field:

```ts
{
  filename: string;
  mimeType: string;
  dataBase64: string;
  sourceTreasuryWalletId?: string | null;
  autoAdvance?: boolean; // default true
}
```

New response field:

```ts
{
  automation: Array<
    | {
        status: 'proposal_submitted';
        paymentOrderId: string;
        treasuryWalletId: string;
        decimalProposalId: string;
        submittedSignature: string;
        reason: null;
        decimalProposal: object;
      }
    | {
        status:
          | 'already_has_proposal'
          | 'needs_review'
          | 'needs_source_treasury'
          | 'unsupported_source_treasury'
          | 'not_applicable'
          | 'blocked'
          | 'failed';
        paymentOrderId: string;
        treasuryWalletId: string | null;
        decimalProposalId?: string | null;
        submittedSignature?: string | null;
        reason: string;
        details?: unknown;
      }
  >;
}
```

Frontend behavior:

- If `automation[i].status === 'proposal_submitted'`, route the row into the proposal/voting UI.
- If `automation[i].status === 'needs_review'`, show the review card and do not show proposal actions yet.
- If `automation[i].status === 'needs_source_treasury'`, ask the user to create/select a programmable treasury.
- If `automation[i].status === 'failed'` or `blocked`, show the reason and allow retry through the endpoint below.

### Clear review

`POST /organizations/:organizationId/payment-orders/:paymentOrderId/clear-review`

New request field:

```ts
{
  reviewNote?: string | null;
  trustCounterpartyWallet?: boolean; // default true
  submitAfterClear?: boolean; // default true
  autoAdvance?: boolean; // default true
}
```

Response is still the payment order detail shape, now with:

```ts
{
  automation: PaymentOrderAgentAdvanceResult | null;
}
```

Frontend behavior:

- The "Approve & continue" button should call this endpoint with `autoAdvance: true`.
- If `automation.status === 'proposal_submitted'`, refresh the payment detail and show the Squads proposal/voting state.
- If the endpoint returns `needs_source_treasury`, prompt for treasury selection and then call the manual advance endpoint.

### Manual/idempotent retry

`POST /organizations/:organizationId/payment-orders/:paymentOrderId/agent/advance`

Request:

```ts
{
  sourceTreasuryWalletId?: string | null;
}
```

Response:

```ts
PaymentOrderAgentAdvanceResult
```

Frontend behavior:

- Use this for retry buttons and for cases where the user selects a source treasury after intake.
- This endpoint is safe to call repeatedly. It will not create duplicate proposals if one already exists.

## Lifecycle semantics

Clean invoice row:

```text
invoice upload
  -> payment order created as draft
  -> payment order submitted/approved internally
  -> agent creates Squads proposal transaction
  -> agent signs/submits proposal creation tx
  -> DecimalProposal.status = submitted
  -> PaymentOrder.derivedState = proposed
```

Risky invoice row:

```text
invoice upload
  -> payment order created as needs_review
  -> no Squads proposal
  -> human clears review
  -> backend trusts wallet if requested
  -> payment order submitted/approved internally
  -> agent creates/signs/submits Squads proposal
  -> PaymentOrder.derivedState = proposed
```

Unsupported row:

```text
invoice upload
  -> payment order may be created, but automation returns needs_review / blocked / failed
  -> frontend should show reason and keep user in review/remediation flow
```

## Important implementation notes

- The agent wallet must already be an on-chain Squads member with `Initiate` permission. Newly created programmable treasuries include the default Decimal operations agent as an initiate-only member.
- The backend signs only the proposal creation transaction with the agent wallet. It does not vote or execute through this path.
- Agent-authored proposal events are stored with `actorType: 'agent'`.
- `DecimalProposal.creatorPersonalWalletId` is `null` for agent-created proposals.
- `DecimalProposal.creatorWalletAddress` is the agent wallet address.
- The manual human proposal creation endpoint still exists:
  `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-intent`

## Files changed

- `api/src/agents/payment-automation.ts`
- `api/src/squads/treasury.ts`
- `api/src/squads/payment-markers.ts`
- `api/src/payments/orders.ts`
- `api/src/transfer-requests/events.ts`
- `api/src/routes/invoices.ts`
- `api/src/routes/payment-orders.ts`
- `api/src/api-contract.ts`
- `api/src/routes/capabilities.ts`
- `api/tests/control-plane.test.ts`

## Validation

Backend validation passed:

```sh
npm --prefix api run build
make test-api
```

`make test-api` result: `45/45` tests passing.

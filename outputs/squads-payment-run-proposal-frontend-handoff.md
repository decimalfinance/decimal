# Squads Payment Run Proposal Frontend Handoff

## Goal

Wire payment runs to the new backend path where one payment run creates one Squads vault proposal containing multiple USDC transfers.

This is option 2:

```text
Payment run
  -> many payment orders
  -> one Decimal proposal
  -> one Squads vault transaction
  -> many USDC transfer instructions
```

Do not create one proposal per payment row.

## New Backend Endpoint

```http
POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-run-intent
```

Auth: normal session auth.

Body:

```json
{
  "paymentRunId": "uuid",
  "creatorPersonalWalletId": "uuid",
  "memo": "optional string"
}
```

Response shape matches the existing single-payment proposal intent response:

```ts
{
  intent: {
    provider: "squads_v4";
    kind: "vault_payment_run_proposal_create";
    programId: string;
    treasuryWalletId: string;
    organizationId: string;
    multisigPda: string;
    transactionIndex: string;
    proposalType: "vault_transaction";
    proposalCategory: "execution";
    semanticType: "send_payment_run";
    squadsTransactionPda: string;
    vaultTransactionPda: string;
    proposalPda: string;
    actions: Array<{
      type: "send_payment";
      paymentRunId: string;
      paymentOrderId: string;
      asset: string;
      amountRaw: string;
      destinationWalletAddress: string;
      destinationTokenAccountAddress: string;
    }>;
  };
  transaction: {
    encoding: "base64";
    serializedTransaction: string;
    requiredSigner: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  };
  decimalProposal: {
    decimalProposalId: string;
    paymentRunId: string;
    paymentOrderId: null;
    semanticType: "send_payment_run";
    semanticPayloadJson: {
      paymentRunId: string;
      runName: string;
      sourceTreasuryWalletId: string;
      sourceWalletAddress: string;
      sourceTokenAccountAddress: string;
      totalAmountRaw: string;
      orderCount: number;
      asset: "usdc";
      orders: Array<{
        index: number;
        paymentOrderId: string;
        transferRequestId: string;
        destinationId: string;
        destinationWalletAddress: string;
        destinationTokenAccountAddress: string;
        amountRaw: string;
        asset: string;
        reference: string | null;
        memo: string | null;
      }>;
    };
  };
}
```

## Backend Rules

- Max rows per Squads batch proposal: `8`.
- Every row must be approved or ready for execution.
- Every row must be USDC.
- Every row must use the selected Squads treasury as source.
- If a run row is still draft, the backend submits it first.
- If any row needs approval, the endpoint returns `400`.
- If the run already has an active Squads proposal, the endpoint returns `409` with the existing `decimalProposalId`.

## Frontend API Client

Add a client method similar to the existing single payment proposal method:

```ts
createSquadsPaymentRunProposalIntent(
  organizationId: string,
  treasuryWalletId: string,
  body: {
    paymentRunId: string;
    creatorPersonalWalletId: string;
    memo?: string | null;
  },
)
```

Use the same sign/submit flow as single-payment proposal creation:

1. Call `payment-run-intent`.
2. Ask Privy to sign `transaction.serializedTransaction`.
3. Submit signed tx to Solana RPC.
4. Call:

```http
POST /organizations/:organizationId/proposals/:decimalProposalId/confirm-submission
```

with:

```json
{ "signature": "proposal create tx signature" }
```

5. Navigate to the Decimal proposal detail page.

## Payment Run Page UX

Add a primary CTA on the payment run detail page:

```text
Create Squads proposal
```

Show it when:

- run has at least one payment order
- run is not `cancelled`, `closed`, `settled`, or `executed`
- user has a personal wallet that is an initiate member of the selected Squads treasury
- no active proposal already exists for the run

If the backend returns `409`, do not show an error as failure. Route to the existing proposal:

```text
/organizations/:organizationId/proposals/:decimalProposalId
```

## Suggested Dialog

Dialog title:

```text
Create batch proposal
```

Sections:

- Source treasury: selected Squads treasury
- Batch summary: number of rows, total USDC
- Signer: current user's personal wallet
- Rows preview: payee/destination, amount, reference

Primary action:

```text
Prepare proposal
```

After prepare, show review screen:

- multisig PDA
- vault PDA/source wallet
- transaction index
- total amount
- row count
- required signer

Primary action:

```text
Sign and submit
```

## Lifecycle Display

After `confirm-submission`, the backend marks:

```text
payment run: proposed
each child order: proposed
```

After proposal execution and `confirm-execution`, the backend marks:

```text
payment run: executed
each child order: executed
each child transfer request: submitted_onchain
each child order gets an execution record with the same Squads execution signature
```

Payment run states should be displayed as:

```ts
draft -> ready -> proposed -> executed -> settled
```

Problem/terminal states:

```ts
pending_approval
exception
cancelled
closed
```

For Squads batch proposals, do not show the old direct batch execution actions as the primary path. The old direct execution packet flow can be hidden behind an advanced/debug section or removed from the main UX.

## Proposal Detail Page

No special page is required if the existing proposal detail page already handles:

- `approve-intent`
- `reject-intent`
- `execute-intent`
- `confirm-execution`

For `semanticType === "send_payment_run"`, display:

- run name
- total amount
- order count
- list of rows from `semanticPayloadJson.orders`
- one execution signature for the whole batch after execution

## Error Copy

Map common backend errors:

- `Payment run has no payment orders.` -> "This run has no payable rows yet."
- `need approval before a Squads proposal can be created` -> "Some rows still need approval before this batch can be proposed."
- `Split it into chunks of 8 or fewer` -> "This batch is too large for one proposal. Split it into smaller runs."
- `already has a Squads payment proposal` -> route to existing proposal.

## Backend Files Changed

- `api/src/squads-treasury.ts`
- `api/src/routes/treasury-wallets.ts`
- `api/src/api-contract.ts`
- `api/src/payment-run-state.ts`
- `api/prisma/schema.prisma`
- `postgres/init/001-control-plane.sql`
- `api/tests/control-plane.test.ts`

## Validation

Backend validation passed:

```bash
npm run build
make test-api
```


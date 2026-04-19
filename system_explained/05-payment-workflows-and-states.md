# 05 Payment Workflows And States

This file explains how a payment moves through Axoria.

## The Main Workflow

The intended product workflow is:

```text
Payment request
  -> Payment order
  -> Approval evaluation
  -> Execution preparation
  -> Wallet/multisig submission
  -> Yellowstone observation
  -> Reconciliation match or exception
  -> Proof export
```

For batch workflows:

```text
CSV import
  -> Payment run
  -> Payment requests
  -> Payment orders
  -> Batch execution packet
  -> Submitted signature
  -> Reconciliation
  -> Run proof
```

## Payment Request Flow

A payment request is the input-layer object.

Created from:

- Manual form.
- CSV import.
- API client.

Important fields:

- destination (required)
- counterparty tag (optional)
- amount
- reason
- reference
- due date
- metadata

Typical flow:

1. Create payment request.
2. Validate destination and amount.
3. Optionally assign it to a payment run.
4. Promote it into a payment order.
5. Continue through payment order flow.

Payment requests should not carry all execution complexity. They are the front door.

## Payment Run Flow

A payment run is a batch container.

Typical CSV:

```csv
counterparty,destination,amount,reference,due_date
Acme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,0.01,INV-1001,2026-04-15
Beta Supplies,33yL624hoHqChSDR2y8L2cBjYRGEgQ9QSqcuKFfm1BnP,0.01,INV-1002,2026-04-18
```

The `counterparty` column is optional human-readable context used to tag or auto-create a `Counterparty`. The `destination` column is the external Solana wallet address of the recipient. CSV imports are idempotent by SHA-256 fingerprint: re-submitting the same file returns the existing run with `importResult.imported: 0`.

Import creates:

- one `PaymentRun`
- one `Destination` per unique wallet (or reuses the existing one by `(workspaceId, walletAddress)`)
- one `PaymentRequest` per row
- corresponding `PaymentOrder` rows
- optional `Counterparty` tags when the counterparty column matches or when one is auto-created

The run is useful for payroll-like or vendor batch workflows.

## Payment Order Flow

Payment order is the central control object.

### 1. Draft

The order exists but has not entered the active workflow.

Operators can still edit safe fields.

### 2. Submitted

The order has been submitted for policy evaluation.

At this point, the system evaluates approval policy.

### 3. Pending Approval

The policy says a human/operator must review.

Reasons can include:

- untrusted destination
- external destination requiring approval
- amount threshold exceeded
- restricted destination

### 4. Approved

The order is allowed to proceed.

Important distinction:

```text
Approved does not mean sent.
```

It only means the control plane allows execution to be prepared.

### 5. Ready For Execution

The order has a lower-level transfer request and can have an execution packet prepared.

### 6. Execution Recorded

An execution reference or submitted signature was attached.

Important distinction:

```text
Execution recorded does not mean settled.
```

It means the system has evidence that execution was attempted or handed off.

### 7. Settlement Pending

The system is waiting for Solana observation and matching.

### 8. Settled

Observed settlement matched the intended payment.

### 9. Partially Settled

Observed settlement partially satisfied the intended payment.

If later observations fully satisfy the request, the system should transition to settled and downgrade/dismiss partial exceptions where appropriate.

### 10. Exception

The matcher or control plane found an issue requiring review.

Examples:

- partial settlement
- overfill
- unknown route
- signature mismatch
- no matching observed settlement

### 11. Cancelled

The order was cancelled before completion.

### 12. Closed

The order is operationally closed. Usually this happens after settlement/proof/review.

## Transfer Request Flow

Transfer requests are lower-level expected settlement rows.

They use a more detailed lifecycle:

```text
draft
submitted
pending_approval
approved
ready_for_execution
submitted_onchain
observed
matched
partially_matched
exception
closed
rejected
```

This older lifecycle is still important because:

- Approval decisions are attached to transfer requests.
- Execution records attach to transfer requests.
- The matcher indexes transfer requests.
- Reconciliation detail often uses transfer request IDs.

## Why There Are Multiple State Systems

There are three state dimensions that must not be collapsed:

```text
Approval state
Can this payment proceed under policy?

Execution state
Has something been prepared/submitted/observed?

Reconciliation state
Did observed settlement match intent?
```

Earlier versions mixed these together, which created confusion like "matched while ready for execution".

The current direction is:

- Payment order state is the high-level product state.
- Approval is a derived state and audit trail.
- Execution is explicit evidence.
- Reconciliation is system-owned observed truth.

## Approval Policy Flow

When a payment order is submitted:

1. The API loads or creates the workspace approval policy.
2. It evaluates destination trust/scope and thresholds.
3. If no approval reasons are triggered, it auto-approves.
4. If approval is required, it enters pending approval.
5. An approval decision records approve/reject/escalate.
6. Approved requests can proceed to execution.

Auto-approval is still recorded as an event.

## Execution Preparation Flow

Preparing execution does not send funds.

For a payment order, `preparePaymentOrderExecution`:

- Validates the order can be executed.
- Validates source and destination.
- Derives or uses USDC token accounts.
- Builds Solana transfer instruction data.
- Stores a prepared execution packet.
- Records events.

The execution packet tells a client:

- source wallet
- source token account
- destination wallet
- destination token account
- amount
- instructions
- required signer

## Signing And Signature Attachment

The frontend can ask a browser wallet to sign and submit.

After submission, the frontend calls attach signature endpoints.

The signature is important because:

- It makes app-originated execution deterministic.
- The worker can prefer signature-based matching.
- Proof packets can link intent to actual transaction.

## Matching Flow

Once the worker sees relevant Solana movement:

1. It reconstructs USDC transfers.
2. It reconstructs observed payments.
3. It checks submitted signatures first.
4. If no signature match exists, it uses destination/FIFO matching.
5. It writes settlement matches and exceptions.
6. API read models surface the updated state.

## Proof Flow

Proof endpoints gather:

- Intent details.
- Approval policy and decisions.
- Execution packet/evidence.
- Submitted signature.
- Observed settlement.
- Match details.
- Timeline/audit events.

The current proof packet has been optimized from a very large JSON dump toward more human-readable and compact output, but more product-level proof formatting remains valuable.

## Common Misreadings

### "Approved" means "paid"

False. Approved only means policy allowed the payment.

### "Execution recorded" means "settled"

False. It means an execution attempt/reference/signature exists.

### "Observed" means "matched"

False. Observed means Solana showed relevant movement. Matched means the movement satisfied an expected payment.

### "Destination" means "wallet"

Not exactly. A destination can be linked to a wallet, but it is an operator-facing payment endpoint with trust and scope metadata.

### "Payment request" and "payment order" are the same

No. Request is the input. Order is the controlled workflow object.


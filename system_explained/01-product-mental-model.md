# 01 Product Mental Model

Axoria exists because stablecoin operations have a gap between business intent and on-chain reality.

A team may say:

```text
Pay Fuyo LLC 100 USDC for INV-102 from the operations wallet.
```

On-chain, the observable reality is only:

```text
Some USDC token account sent tokens to another USDC token account in transaction X.
```

Axoria sits between those two worlds.

It records the intended payment, applies policy, helps prepare execution, watches Solana, matches what happened against what was intended, and creates proof.

## The Four Product Layers

### 1. Inputs

Inputs are how payment intent enters Axoria.

Current input types:

- Manual payment request.
- CSV imported payment requests.
- Payment runs created from CSV batches.
- Direct payment order creation.

Planned or natural future inputs:

- API-created requests from external systems.
- Payroll exports.
- Invoice exports.
- DAO payout lists.
- Webhook imports.
- Agent-created requests.

The input layer is intentionally business-facing. It should use words like payee, destination, source wallet, invoice/reference, amount, and due date. It should not force users to think about token accounts, inner instructions, or matcher allocations.

### 2. Control Plane

The control plane decides whether a payment is allowed to proceed and records every important state transition.

Control-plane responsibilities:

- Organization and workspace ownership.
- Workspace addresses.
- Destinations and trust state.
- Payees and counterparties.
- Payment order creation.
- Approval policy evaluation.
- Approval inbox and decisions.
- Execution packet preparation.
- Execution evidence attachment.
- Audit timeline.
- API keys and agent scopes.

The control plane is implemented in the TypeScript API and stored mostly in Postgres.

### 3. Execution Handoff

Axoria does not custody private keys.

The current execution model is:

- Axoria builds a payment packet.
- The frontend or another client asks the source wallet to sign/submit.
- The submitted Solana signature is attached back to Axoria.
- Axoria treats that signature as strong evidence for matching.

This is why the product says "execution handoff" rather than "custodial execution".

The important security boundary is:

- Axoria may prepare instructions.
- Axoria may record signatures.
- Axoria must not silently move funds.
- A wallet, multisig, or external signer must authorize the transaction.

### 4. Verification And Proof

Verification is Axoria's strongest layer.

The Yellowstone worker observes Solana in real time, reconstructs USDC movements, filters for relevant workspace addresses/signatures, and runs matching logic.

Verification answers:

- Did a submitted signature appear on-chain?
- Did USDC move to the intended destination?
- Was the amount exact, partial, split, or overfilled?
- Was the movement unrelated?
- Was there an exception that needs review?

Proof generation turns that internal verification into something a finance/operator team can export.

## The Product Promise

The best one-line promise is:

```text
Axoria starts from a payment request, controls the workflow, observes Solana, reconciles settlement, and produces proof.
```

It is not just a wallet watcher.

A wallet watcher says:

```text
This wallet had activity.
```

Axoria says:

```text
This payment was requested, approved, prepared, submitted, observed, matched, and proven.
```

## What The System Currently Does Well

- Tracks destinations and trust state.
- Creates payment requests manually and from CSV.
- Groups payment requests into payment runs.
- Creates payment orders as control-plane objects.
- Applies approval policy before a payment becomes executable.
- Prepares Solana USDC execution packets.
- Supports browser-wallet signing through the frontend.
- Records submitted transaction signatures.
- Observes Solana through Yellowstone.
- Reconstructs USDC transfers and payments.
- Matches observed settlement against expected payments.
- Handles exact, split, partial, and overfill outcomes.
- Creates and updates exceptions.
- Exports proof packets.
- Exposes API keys and an agent task queue.
- Provides Grafana-facing operational metrics.

## What The System Does Not Fully Do Yet

- It is not a complete AP system.
- It is not a complete payroll system.
- It is not a custody system.
- It does not manage private keys.
- It does not yet deeply integrate with Squads or another multisig proposal system.
- It does not yet have institutional-grade UX across all surfaces.
- It does not yet have mature production auth, roles, org administration, billing, or deployment posture.
- It does not yet have a full agent runtime that performs useful work autonomously; it has an API surface that agents can use.

## Why The Current Product Can Feel Abstract

The backend has strong control and verification, but the entry point is still mostly manual. The user must still decide to enter a payment request or import a CSV.

In a mature product, users should arrive from their real workflow:

- "I have a payroll CSV."
- "I have a vendor payout list."
- "I have a DAO contributor batch."
- "I have a payment order from another system."
- "An agent detected an obligation and created a request."

Axoria now has the primitives to support those workflows, but more product work is needed to make the entry layer feel natural.

## Mental Model For Future Work

Every feature should strengthen one of these paths:

```text
Input -> Control -> Execution -> Verification -> Proof
```

Avoid features that only add another table without making that path clearer.

Useful questions before adding a feature:

- Does this make it easier to create real payment intent?
- Does this make payment approval/control safer?
- Does this make execution more trustworthy?
- Does this make reconciliation more deterministic?
- Does this make proof more useful to a human or agent?
- Does this reduce operational ambiguity?


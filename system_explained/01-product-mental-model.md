# 01 Product Mental Model

Axoria is the **deterministic financial workflow engine for crypto payments**.

The product exists because stablecoin operations have a gap between business intent and on-chain reality.

A team may say:

```text
Pay Fuyo LLC 100 USDC for INV-102 from the operations wallet.
```

On-chain, the observable reality is only:

```text
Some USDC token account sent tokens to another USDC token account in transaction X.
```

Axoria sits between those two worlds — but it is not a reconciler pitched at the end of the pipeline. It is a workflow engine that owns the path from intent to proof, end to end. The reconciliation and proof pieces are where Axoria is strongest, but the point is that the same system also routes policy, prepares execution, and matches settlement to intent. **Same inputs → same proof digest, every time.**

The current wedge is Solana USDC payouts. Everything else (inbound matching, DAO treasury views, agent runtime) is downstream of getting this one lane right.

## The Four Product Layers

### 1. Inputs

Inputs are how payment intent enters Axoria.

Current input types:

- Manual payment request.
- CSV-imported payment requests (idempotent by CSV fingerprint).
- Payment runs created from CSV batches.
- Direct payment order creation.

Planned or natural future inputs:

- API-created requests from external systems.
- Payroll / invoice exports.
- DAO payout lists.
- Webhook imports.
- Agent-created requests.

The input layer is intentionally business-facing. It should use words like **counterparty**, **destination**, **treasury wallet**, **reason / reference**, **amount**, and **due date**. It should not force users to think about token accounts, inner instructions, or matcher allocations.

### 2. Control Plane

The control plane decides whether a payment is allowed to proceed and records every important state transition.

Control-plane responsibilities:

- Organization and workspace ownership.
- Treasury wallets (the Solana wallets we own and sign with).
- Destinations and trust state (the counterparty wallets we pay).
- Counterparties as optional grouping tags.
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

- Axoria builds a prepared transaction (execution packet).
- The frontend (or another client) asks the source wallet to sign and submit.
- The submitted Solana signature is attached back to Axoria.
- Axoria treats that signature as strong evidence for matching.

This is why the product says "execution handoff" rather than "custodial execution."

The important security boundary is:

- Axoria may prepare instructions.
- Axoria may record signatures.
- **Axoria must not silently move funds.**
- A wallet, multisig, or external signer must authorize the transaction.

### 4. Verification And Proof

Verification is Axoria's strongest layer.

The Yellowstone worker observes Solana in real time, reconstructs USDC movements, filters for the workspace's `TreasuryWallet` addresses and tracked signatures, and runs matching logic. Destination wallets are *not* watched as "ours"; they are the expected counterparty side of a match.

Verification answers:

- Did a submitted signature appear on-chain?
- Did USDC move to the intended destination?
- Was the amount exact, partial, split, or overfilled?
- Was the movement unrelated?
- Was there an exception that needs review?

Proof generation turns that internal verification into something a finance or operator team can export — a deterministic JSON packet whose digest is a SHA-256 of the canonical representation.

## The Product Promise

The one-line promise:

```text
Axoria starts from a payout intent, controls the workflow, observes Solana,
reconciles settlement, and produces proof — deterministically.
```

It is not just a wallet watcher.

A wallet watcher says:

```text
This wallet had activity.
```

Axoria says:

```text
This payment was intended, approved under policy, signed once as a batch,
observed on-chain, matched to intent, and packaged as a verifiable receipt.
```

For full customer-facing positioning, copy, and the narrative the landing page is built from, see `landing-page-content.md` at the repo root. For brand direction (color, typography, voice, dual-theme tokens), see `brand.md`.

## What The System Currently Does Well

- Registers treasury wallets with live Solana balances (USDC + SOL + USD via Binance SOLUSDT).
- Creates destinations with trust states (`unreviewed`, `trusted`, `restricted`, `blocked`) and optional counterparty tags.
- Creates payment requests manually and from CSV (idempotent by fingerprint).
- Groups payment requests into payment runs (batches).
- Creates payment orders as control-plane objects.
- Applies approval policy before a payment becomes executable.
- Prepares Solana USDC execution packets.
- Supports browser-wallet signing through the frontend (Phantom, Solflare, etc.).
- Records submitted transaction signatures.
- Observes Solana through Yellowstone.
- Reconstructs USDC transfers and payments.
- Matches observed settlement against expected payments (exact / split / partial / overfill).
- Creates and updates exceptions.
- Exports deterministic proof packets.
- Exposes API keys and an agent task queue.
- Provides Grafana-facing operational metrics.
- Ships an institutional-grade frontend with dual light/dark themes, batch-expandable tables, and a unified `--ax-*` token system.

## What The System Does Not Fully Do Yet

- It is not a complete AP system.
- It is not a complete payroll system.
- It is not a custody system. It does not manage private keys.
- It does not yet deeply integrate with Squads or another multisig proposal system.
- It does not yet have mature production auth, roles, org administration, billing, or deployment posture.
- It does not yet have a full agent runtime that performs useful work autonomously — it exposes an API surface that agents can use.
- It does not yet have public landing / marketing assets shipped (the brief lives in `landing-page-content.md`).

## Why The Current Product Can Feel Abstract

The backend has strong control and verification, but the entry point is still mostly manual: a human has to decide to enter a payment request or import a CSV.

In a mature product, users should arrive from their real workflow:

- "I have a payroll CSV."
- "I have a vendor payout list."
- "I have a DAO contributor batch."
- "I have a payment order from another system."
- "An agent detected an obligation and created a request."

Axoria now has the primitives to support those workflows; more product work is needed to make the entry layer feel natural.

## Mental Model For Future Work

Every feature should strengthen one of these paths:

```text
Input → Control → Execution → Verification → Proof
```

Avoid features that only add another table without making that path clearer or more deterministic.

Useful questions before adding a feature:

- Does this make it easier to create real payment intent?
- Does this make payment approval / control safer?
- Does this make execution more trustworthy?
- Does this make reconciliation more deterministic?
- Does this make proof more useful to a human or agent?
- Does this reduce operational ambiguity?

If the answer to all six is "no," build something else.

# Three-Buyer Workflow Comparison

As of 2026-03-31.

This document compares the three buyer workflows for the `Stablecoin Ops Control Surface`:

1. Cross-border fintech finance / ops team
2. Marketplace payout ops team
3. Crypto-native treasury ops team

The goal is not to pick one buyer yet. The goal is to understand:

- what all three buyers have in common
- where the workflows diverge
- what core product we can safely build now
- what buyer-specific edge cases must remain visible in the architecture

## Executive Summary

All three buyers share the same core operational loop:

- request
- policy check
- approval
- execution
- on-chain observation
- reconciliation / matching
- exception handling
- export / audit

That means there is a real shared product core.

Where they diverge:

- `cross-border fintech ops` cares more about corridor context, beneficiary settlement confidence, and finance close
- `marketplace payout ops` cares more about beneficiary lifecycle, payout batches, support burden, and proof of payout
- `crypto-native treasury ops` cares more about counterparty trust, wallet controls, rebalancing, and anomaly detection

The coding implication is clear:

- build the shared workflow engine first
- keep buyer-specific data and UI as extensions, not as separate products

## Buyer 1: Cross-Border Fintech Finance / Ops

### Best short description

- the operator who sits between payment intent and finance close for stablecoin-powered cross-border payouts or treasury transfers

### Strongest signal

- repeated operational need
- clear budget
- high pain around matching and proof

### Distinctive workflow traits

- requests arrive from multiple internal systems
- corridor, counterparty, and timing context matter
- payment completion is not enough; the team needs finance-ready closure
- the operator cares about “did this settle correctly in business terms?”

### Unique objects

- corridor
- beneficiary or partner
- payout batch
- settlement confidence
- export state to finance system

### Product implication

- this buyer pulls the product toward reconciliation and settlement assurance first

## Buyer 2: Marketplace Payout Ops

### Best short description

- the operator who sends many repeated outbound payouts to sellers, creators, or contractors and needs high-volume payout control with post-payment clarity

### Strongest signal

- repetitive workflow
- batch operations
- direct support and finance pain

### Distinctive workflow traits

- payout batch is the operational center
- beneficiary registry is core infrastructure
- support burden is part of the workflow
- proof-of-payment matters more than treasury strategy

### Unique objects

- beneficiary
- payout batch
- payout item
- earnings period
- payout support case

### Product implication

- this buyer pulls the product toward batch tooling, beneficiary management, and payout status clarity

## Buyer 3: Crypto-Native Treasury Ops

### Best short description

- the operator responsible for moving USDC safely across treasury wallets, counterparties, and rebalancing flows while maintaining policy control and auditability

### Strongest signal

- control depth
- policy depth
- clean overlap between approval and reconciliation

### Distinctive workflow traits

- more single transfers and rebalances than payout batches
- destination trust and counterparty trust matter heavily
- anomaly detection and intentional vs unintentional movement matter
- this buyer is comfortable with denser operational UI

### Unique objects

- treasury wallet
- wallet cluster
- rebalance job
- counterparty trust state
- treasury movement category

### Product implication

- this buyer pulls the product toward controls, approvals, and risk-aware movement workflows

## Shared Core We Can Build Safely

These objects and flows are required for all three buyers.

### Shared objects

- organization
- workspace
- user
- role
- counterparty or beneficiary abstraction
- destination address
- transfer request
- approval policy
- approval action
- observed transaction
- observed token movement
- settlement match
- exception
- audit event
- export record

### Shared states

- draft
- pending approval
- approved
- rejected
- submitted
- observed
- finalized
- matched
- partially matched
- unmatched
- exception
- resolved
- exported

### Shared screens

- operations inbox
- transfer request list/detail
- approvals queue
- settlement & reconciliation
- exception queue
- counterparties / destinations
- policies
- audit / exports

These screens are safe to build because all three buyers need them.

## Buyer-Specific Extensions We Should Not Forget

### Cross-border fintech extensions

- corridor field
- local currency reference
- payout provider reference
- settlement confidence status
- beneficiary and partner reference
- finance-close export state

### Marketplace payout extensions

- payout batch
- payout item
- beneficiary lifecycle state
- support-facing status
- payout proof surface
- batch-level approvals

### Treasury ops extensions

- wallet cluster
- rebalance job
- internal vs external movement type
- counterparty trust state
- anomaly flag
- threshold-based treasury approval pack

## Architecture Implication

The product architecture should be:

### Core engine

- request lifecycle engine
- approval/policy engine
- on-chain observation engine
- reconciliation engine
- exception engine
- audit/export engine

### Configurable buyer modules

- corridor and payout context module
- beneficiary batch module
- treasury wallet and rebalance module

That lets us keep the codebase shared while leaving room for buyer-specific workflows.

## What This Means For Coding

When we start coding, we should not hardcode one buyer into the foundation.

We should hardcode only:

- the shared request lifecycle
- the shared approval lifecycle
- the shared settlement lifecycle
- the shared exception lifecycle

We should keep buyer-specific concepts behind optional fields, typed sub-objects, or modular tables.

Examples:

- `transfer_request.type`
  - payout_item
  - treasury_transfer
  - rebalance
  - vendor_payment

- `business_context`
  - corridor info for fintech
  - beneficiary / earnings metadata for marketplace
  - treasury movement reason for crypto treasury

- `destination_actor`
  - counterparty
  - beneficiary
  - internal wallet

## Product Positioning Implication

Even if we do not choose one buyer today, the product story is already clear:

- not a wallet
- not a custody vendor
- not a generic analytics dashboard
- not a merchant checkout product

It is:

- an operations control and settlement assurance product for teams moving stablecoins on Solana

That positioning works across all three buyers.

## Most Important Differences To Keep In Mind

If we later choose:

### Cross-border fintech first

- optimize for settlement assurance and finance exports

### Marketplace payouts first

- optimize for beneficiary registry, batch operations, and support status

### Treasury ops first

- optimize for control depth, counterparty trust, and anomaly review

## Recommendation

Do not pick the buyer yet at the architecture level.

Instead:

1. Build the shared workflow core.
2. Model business context generically enough to hold corridor, payout-batch, or treasury-rebalance semantics.
3. Keep the first UI centered on the shared operator jobs:
   - approvals
   - settlement
   - exceptions
4. Delay buyer-specific polish until after the first real implementation pass.

This gives us the broader context you wanted without forcing the codebase to fragment early.

# Provenance: Stablecoin Ops Product Definition

Generated on 2026-03-31.

## Research goal

Answer these product-definition questions for the combined reconciliation + treasury-control idea:

- exact first buyer
- exact daily workflow
- current workaround
- smallest lovable product
- required data model
- required UI surfaces

## Internal research inputs

- [Deep research on top 3 ideas](/Users/fuyofulo/code/stablecoin_intelligence/outputs/top-3-stablecoin-infra-ideas-deep-research.md)
- [Top 3 ideas provenance](/Users/fuyofulo/code/stablecoin_intelligence/outputs/top-3-stablecoin-infra-ideas-deep-research.provenance.md)
- [Idea scorecard](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/IDEA_SCORECARD.md)
- [Idea battle test](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/IDEA_BATTLE_TEST.md)

## External primary / product sources used

### Reconciliation and payment workflow references

- Modern Treasury Reconciliation Overview
  - https://docs.moderntreasury.com/reconciliation/docs/overview
- Modern Treasury Expected Payments Overview
  - https://docs.moderntreasury.com/reconciliation/docs/expected-payments
- Modern Treasury Reconciliation Rules Overview
  - https://docs.moderntreasury.com/reconciliation/docs/defining-your-reconciliation-rules
- Modern Treasury Automatic Reconciliation
  - https://docs.moderntreasury.com/reconciliation/docs/automatic-reconciliation
- Modern Treasury Transaction Categorization
  - https://docs.moderntreasury.com/reconciliation/docs/manage-categorization-rules
- Modern Treasury Entity Linking Overview
  - https://docs.moderntreasury.com/reconciliation/docs/entity-links
- Modern Treasury Payments Overview
  - https://docs.moderntreasury.com/payments/docs/overview

### Treasury control references

- Fireblocks Treasury Management
  - https://www.fireblocks.com/products/treasury-management
- Fireblocks Governance and Policy Engine
  - https://www.fireblocks.com/platforms/governance-and-policy-engine/
- Fireblocks destination whitelist / address management docs
  - https://developers.fireblocks.com/docs/whitelist-addresses
- Fireblocks approval quorum docs
  - https://developers.fireblocks.com/docs/define-approval-quorums
- Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed
  - https://solana.com/news/solana-fireblocks-institutional-treasury-infrastructure

### Stablecoin flow and orchestration references

- Circle Payments
  - https://www.circle.com/use-case/payments
- Bridge Orchestration
  - https://www.bridge.xyz/product/orchestration
- Bridge guide: payment orchestration and stablecoin networks
  - https://www.bridge.xyz/learn/payment-orchestration-and-stablecoin-networks-how-modern-platforms-move-money-across-markets
- Helius: Solana’s Stablecoin Landscape
  - https://www.helius.dev/blog/solanas-stablecoin-landscape
- Worldpay stablecoin payouts press release
  - https://corporate.worldpay.com/news-releases/news-release-details/worldpay-enable-stablecoin-payouts-global-businesses

## Why these sources were used

- Modern Treasury was used as the best available primary reference for finance-grade reconciliation and payment workflow design.
- Fireblocks was used as the best available primary reference for treasury control, approval, policy, and whitelisting workflows.
- Circle, Bridge, Worldpay, Solana, and Helius were used to ground how stablecoin payment and treasury products are actually framed in the market today.

## Main synthesis decisions

### First buyer

Chosen:

- finance / payment operations lead at a stablecoin-native fintech, marketplace, or payout platform using USDC on Solana for outbound payouts and treasury transfers

Why:

- this buyer experiences both halves of the product at once:
  - approvals and control before payment
  - reconciliation and assurance after payment

### First workflow

Chosen:

- outbound USDC payout / treasury transfer from request to approval to on-chain settlement to reconciliation

Why:

- it is the smallest workflow containing both the control and assurance problems

### MVP boundary

Chosen:

- USDC only
- Solana only
- outbound flows only
- one organization, multi-user

Why:

- preserves software focus
- avoids becoming a payout network or custody product too early

## Notes

- The product-definition memo intentionally avoids broad “dashboard” language and instead organizes the UI around operator jobs.
- The proposed data model separates:
  - business intent
  - control / approval
  - on-chain settlement observation
  - exceptions

This separation came directly from the workflow synthesis rather than from prior schema work.

## Output

- Brief: [stablecoin-ops-product-definition.md](/Users/fuyofulo/code/stablecoin_intelligence/outputs/stablecoin-ops-product-definition.md)

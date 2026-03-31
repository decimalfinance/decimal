# Stablecoin Infra Opportunity Map

As of 2026-03-31.

This document turns the company corpus into a market map for idea generation. The goal is not to defend one existing thesis. The goal is to identify:

- recurring customer pain
- where builders keep showing up
- where incumbents are already strong
- which segments are crowded, underbuilt, or structurally hard
- what product wedges still look interesting

This uses:

- the local company corpus in this folder
- Colosseum Copilot builder-project searches
- Colosseum Copilot archive search for stablecoin infrastructure framing

Key archive references used for framing:

- `Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed` (Solana Foundation, 2026-01-20)
- `Solana’s Stablecoin Landscape` (Helius, 2025-05-29)
- `How stablecoins become money: Liquidity, sovereignty, and credit` (a16z crypto, 2025-06-04)

Key builder-project reference checks:

- accelerator-side stablecoin infra searches surfaced projects like `borderless-wallets`, `cargobill`, `localpay`, `credible-finance-1`, `hylo`, and `decal-payments-and-loyalty`
- winner-side stablecoin infra searches surfaced projects like `sp3nd`, `decal-payments-and-loyalty`, `gaian-2`, `blindpay`, `hylo`, and `mercantill`

## Market-level takeaways

- Stablecoin infra is not one market. It breaks into at least seven distinct product lanes with different buyers, compliance burdens, and moats.
- Payments and cross-border settlement are the most visibly crowded builder lanes in the Solana corpus.
- Issuance, reserve, and custody infrastructure are real businesses, but they are structurally harder because regulation, banking relationships, and trust dominate product quality.
- Liquidity is not just a DeFi problem. Archive evidence suggests liquidity depth and distribution are what make stablecoins behave like money in practice, not just tokens.
- Institutional treasury and control layers look more durable than consumer-facing stablecoin apps, because budgets and retention are better there.
- The best new wedges are likely not “another stablecoin wallet” or “another merchant checkout.” They are operational layers around controls, orchestration, visibility, settlement assurance, and vertical workflows.

## Cluster-by-cluster view

## 1. Platform orchestration

Primary files:

- [bridge.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/bridge.md)
- [m0.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/m0.md)

What customers want:

- one integration layer instead of separate wallet, payout, card, compliance, and settlement systems
- abstraction over stablecoin movement primitives
- a programmable money stack that developers can embed

Recurring pain:

- fragmented money movement stack
- too many counterparties to integrate
- unstable operational flows between custody, wallets, payouts, and ledgering

Crowdedness:

- medium by visible company count
- high by product ambition

Why it is hard:

- orchestration products expand into many regulated and ops-heavy surfaces
- the product becomes a pseudo-bank operating system very quickly
- incumbents like Bridge already occupy the “simple stablecoin plumbing” narrative

What looks underbuilt:

- orchestration focused on internal controls and post-settlement operations, not just movement APIs
- orchestration for agentic / autonomous payment systems with hard policy controls
- orchestration for verticals that need predictable approval, evidence, and reconciliation, not just transfer APIs

Assessment:

- promising, but too broad for an early team unless the wedge is sharply verticalized

## 2. Payments and merchant rails

Primary files:

- [worldpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/worldpay.md)
- [arch.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/arch.md)
- [borderless-wallets.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/borderless-wallets.md)
- [cargobill.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/cargobill.md)
- [misk-fi.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/misk-fi.md)
- [stablepay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/stablepay.md)
- [stableyard.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/stableyard.md)

What customers want:

- let me accept stablecoins with minimal integration work
- settle faster and cheaper than cards or wire rails
- fit into existing merchant or B2B business flows

Recurring pain:

- merchant acceptance is still fragmented
- off-ramp and local settlement remain messy
- merchants do not want crypto UX, volatility risk, or accounting pain

Crowdedness:

- high

Evidence:

- accelerator search surfaced `borderless-wallets`, `cargobill`, `decal-payments-and-loyalty`, and `localpay`
- winner search surfaced `sp3nd`, `decal-payments-and-loyalty`, `gaian-2`, and `blindpay`
- many of these cluster directly into `Stablecoin Payment Rails and Infrastructure`

Why it is hard:

- merchant distribution is brutally expensive
- local payment integrations matter more than chain design
- checkout products are easy to demo and hard to scale

What looks underbuilt:

- vertical-specific payment OS rather than generic merchant checkout
- settlement controls and exception handling for merchants
- stablecoin receivables, refunds, disputes, and accounting workflow tools

Assessment:

- very crowded at the generic “pay with stablecoins” level
- still interesting in vertical B2B workflows where payment is one part of a larger operating system

## 3. Remittance, FX, and settlement

Primary files:

- [credible-finance.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/credible-finance.md)
- [link-business.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/link-business.md)
- [stablpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/stablpay.md)
- [stablecoins-fx.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/stablecoins-fx.md)
- [verisettle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/verisettle.md)

What customers want:

- cheaper cross-border movement
- better FX
- predictable settlement
- less treasury friction for global operations

Recurring pain:

- local currency conversion is still the real bottleneck
- businesses need guaranteed settlement behavior, not just fast transfers
- compliance and payout partner complexity dominate cross-border rails

Crowdedness:

- medium-high

Evidence:

- accelerator search surfaced `credible-finance-1`
- winner search surfaced `blindpay`
- archive sources keep tying stablecoins to remittance and borderless financial services, especially `Solana’s Stablecoin Landscape`

Why it is hard:

- FX and payout partner quality determines the product
- country corridors behave like separate businesses
- regulation and banking ops matter more than chain throughput

What looks underbuilt:

- corridor-specific operational tooling
- settlement assurance and failure handling
- treasury decision support around FX timing, liquidity routing, and payout risk

Assessment:

- better than generic merchant rails if narrowed to one corridor or vertical
- good market, but not a great first startup unless there is a strong distribution edge

## 4. Treasury, custody, and controls

Primary files:

- [fireblocks.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fireblocks.md)
- [fystack.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fystack.md)

What customers want:

- safe money movement with approvals, permissions, and auditable workflows
- business-grade custody and team controls
- treasury automation without losing governance

Recurring pain:

- crypto treasury operations still feel too manual
- approval systems are either too weak or too heavyweight
- finance teams need policy, evidence, and clear responsibility boundaries

Crowdedness:

- low-medium in the builder corpus
- high in incumbent strength

Evidence:

- `Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed` directly points at institutional treasury demand
- winner search surfaced `mercantill`, which points to a newer control category: agent banking infrastructure with audit trails and spending controls

Why it is hard:

- trust is a moat here
- enterprise buyers care about controls, certifications, incident response, and workflow reliability
- incumbents like Fireblocks are strong at the top end

What looks underbuilt:

- lightweight treasury controls for smaller Solana-native operators
- policy engines for stablecoin operations
- finance-friendly ops layers that sit above custody rather than replacing it
- AI-agent-safe payment controls and audit layers

Assessment:

- one of the better segments for a new wedge if the product is an ops/control layer rather than a full custody platform

## 5. Issuance and reserve infrastructure

Primary files:

- [brale.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/brale.md)
- [circle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/circle.md)
- [equator.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/equator.md)
- [hylo.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/hylo.md)
- [paxos.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/paxos.md)

What customers want:

- compliant issuance
- reserve transparency
- programmable stablecoin backends
- differentiated reserve mechanics or yield structures

Recurring pain:

- regulation and licensing complexity
- banking and reserve management overhead
- need for trust and transparency

Crowdedness:

- medium in visible players
- very high in entry barrier

Evidence:

- accelerator and winner searches both surfaced `hylo`
- archive framing from `How stablecoins become money: Liquidity, sovereignty, and credit` suggests issuance alone is not enough; stablecoins need liquidity and acceptance to become money-like
- `Solana’s Stablecoin Landscape` highlights reserve credibility and integrations as part of distribution

Why it is hard:

- legal, banking, and reserve operations dominate
- incumbents have deep trust advantages
- even technically good issuance systems can fail if distribution is weak

What looks underbuilt:

- tooling around reserve visibility and operational assurance
- back-office software for issuers
- infrastructure for distribution, compliance evidence, and partner operations

Assessment:

- bad wedge for a small startup if the goal is to become the issuer
- better wedge is “software for issuers” rather than “be the issuer”

## 6. Liquidity and yield infrastructure

Primary files:

- [perena.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/perena.md)
- [reflect.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/reflect.md)
- [stay-liquid.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/stay-liquid.md)

What customers want:

- better utilization of idle stablecoins
- deeper and more concentrated liquidity
- productive dollars rather than passive balances

Recurring pain:

- stablecoin liquidity fragments across venues and products
- users want yield but also liquidity and trust
- protocols need ways to attract and retain stablecoin balances

Crowdedness:

- medium-high

Evidence:

- accelerator and winner checks surfaced `hylo` as a closely adjacent yield-bearing stablecoin design
- archive framing from `How stablecoins become money: Liquidity, sovereignty, and credit` strongly supports the view that liquidity distribution is central, not secondary

Why it is hard:

- yield products create trust and risk-management demands
- liquidity aggregation can become a race to incentives
- this lane often blurs into DeFi strategy and market making

What looks underbuilt:

- institutional / operator tools for routing and managing stablecoin liquidity
- intelligence and controls around concentration, counterparty exposure, and deployment decisions
- middleware that makes yield and liquidity strategies consumable by fintechs

Assessment:

- important lane, but often easier to describe than to build sustainably
- stronger as a B2B infra layer than as another end-user yield product

## 7. Money apps and wallets

Primary files:

- [kast.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/kast.md)
- [dollar.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/dollar.md)
- [localpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/localpay.md)

What customers want:

- make stablecoins feel like normal money
- simple UX
- local spending and savings behavior

Recurring pain:

- crypto UX still leaks into the product
- distribution and trust are brutal at the consumer layer
- wallets alone are not enough without acceptance and local integrations

Crowdedness:

- high

Evidence:

- accelerator search surfaced `localpay`
- winner search surfaced several adjacent consumer payment apps like `sp3nd`, `gaian-2`, and `amp-pay`

Why it is hard:

- consumer distribution is expensive
- retention depends on a broader ecosystem of acceptance and utility
- local compliance and off-ramp realities matter

What looks underbuilt:

- niche money apps tied to one workflow or one community
- wallet experiences that bundle controls, proof, and business ops

Assessment:

- weak starting point for infra-minded builders unless the wallet is a delivery vehicle for another moat

## Cross-cluster conclusions

## Most crowded

- payments and merchant rails
- money apps and wallets
- general cross-border payment pitch decks

## Highest barriers

- issuance and reserve infrastructure
- full-stack orchestration platforms
- enterprise custody

## Most promising for a new technical team

- treasury, controls, and policy layers
- ops and reconciliation infrastructure
- issuer / fintech back-office software
- vertical settlement tools
- liquidity management tooling for operators rather than consumers

## Most dangerous traps

- generic “accept stablecoins” products
- generic stablecoin wallet apps
- trying to become a new regulated issuer too early
- products whose real moat depends on banking partnerships rather than software

## Opportunity wedges worth exploring

These are not validated companies. These are candidate wedges that look more interesting than the crowded obvious ideas.

1. Stablecoin treasury control plane
- approvals, policy rules, exception handling, evidence, and auditability for Solana-native teams

2. Stablecoin reconciliation and settlement assurance
- post-payment evidence, mismatch detection, settlement status, ledger exports, and failure recovery

3. Vertical B2B payment operating systems
- stablecoins bundled into logistics, trade, creator payouts, contractor payroll, or marketplace settlement

4. Issuer operations software
- reserve reporting, partner ops, compliance evidence, and distribution tooling for stablecoin issuers

5. Agent-safe money infrastructure
- programmable spending controls, audit trails, and delegation rules for autonomous systems using stablecoins

6. Stablecoin liquidity operating tools
- venue concentration tracking, routing recommendations, and liquidity deployment controls for treasuries and protocols

7. Corridor-specific settlement stack
- one country-pair or region-specific stablecoin settlement layer with FX ops, local payout handling, and compliance workflow

8. Merchant finance layer on top of stablecoin payments
- refunds, treasury sweep, receivables, and working capital tools rather than only checkout

9. Stablecoin evidence and proof layer
- cryptographic or operational proof of settlement, provenance, and counterparty state for business workflows

10. Embedded stablecoin ops for fintechs
- APIs for controls, reconciliation, and operational observability rather than just wallet creation and transfers

## Best current direction for deeper brainstorming

The next ideation pass should focus on these three meta-questions:

- Which wedge sells to an operator with budget, not to a speculative end user?
- Which wedge is mostly a software problem rather than a banking-permission problem?
- Which wedge benefits from Solana’s speed and low fees without depending on those as the only moat?

If a new idea does not clear those three tests, it is probably a weaker opportunity than it first appears.

# Stablecoin Infra Idea Battle Test

As of 2026-03-31.

This document takes the opportunity map and pressure-tests concrete product wedges against three filters:

1. Does it sell to an operator with budget?
2. Is it mostly a software problem instead of a banking-permission problem?
3. Does Solana help materially without being the only moat?

The goal is not to find a perfect answer in one pass. The goal is to remove weak ideas quickly and keep only the wedges that still look strong after contact with real builder history and archive framing.

Research inputs used here:

- [OPPORTUNITY_MAP.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/OPPORTUNITY_MAP.md)
- builder project corpus in this folder
- Colosseum Copilot project searches
- Colosseum Copilot archive searches

Important reference points:

- treasury and control demand: `Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed`
- stablecoin market structure and distribution: `Solana’s Stablecoin Landscape`
- liquidity as a core stablecoin property: `How stablecoins become money: Liquidity, sovereignty, and credit`
- agent payment framing: `Tourists in the bazaar: Why agents will need B2B payments — and why stablecoins will get there first`

## Shortlist outcome

Highest-conviction wedges after this pass:

- stablecoin treasury control plane
- stablecoin reconciliation and settlement assurance
- agent-safe payment policy engine
- vertical AP / payout operations for one business workflow

Interesting but less immediate:

- issuer operations software
- stablecoin liquidity operations console

Weak first bets:

- generic merchant checkout
- generic stablecoin wallet
- launching a new issuer
- broad “stablecoin orchestration platform”

## Idea 1: Stablecoin treasury control plane

What it is:

- approvals, policy rules, spend limits, counterparty controls, exception handling, and audit evidence for stablecoin-moving teams

Who pays:

- treasury teams
- fintech ops
- DAO / protocol operators
- finance teams at crypto-native businesses

Why it survives the three tests:

- yes, the buyer is an operator with budget
- yes, much of the problem is software workflow and control design
- yes, Solana helps because operations can be real-time and low-cost, but the moat is workflow and policy

Existing evidence:

- incumbent side: [fireblocks.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fireblocks.md)
- builder side: `firebird`, `stablecoins-fx`
- adjacent new signal: `mercantill` from the winners check
- archive support: `Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed`

What is still open:

- Fireblocks is strong at the high end, but lighter-weight policy and ops layers for smaller operators still look underbuilt
- agent-era controls look newer than classic custody UI

Verdict:

- `keep`

## Idea 2: Stablecoin reconciliation and settlement assurance

What it is:

- a post-transaction system that explains what happened, whether settlement completed correctly, how to export it to finance, and where mismatches or failures exist

Who pays:

- finance / ops teams
- stablecoin payment operators
- marketplaces
- payout-heavy fintechs

Why it survives the three tests:

- yes, clear B2B operator buyer
- yes, strongly software-shaped
- yes, Solana’s speed and always-on nature make real-time reconciliation more compelling, but the moat is the ops layer

Existing evidence:

- builder side: `ledgerx-or-crypto-accounting-for-solana-businesses.`, `stablecoins-fx`
- archive support: `Indexing on Solana` explicitly surfaced reconciliation and reserve calculation concepts
- market framing: businesses care about accounting pain, evidence, and operational sanity more than raw transfer rails

What is still open:

- many teams build internal scripts, but that is not the same as a productized settlement assurance layer
- this area feels underbuilt relative to its operational importance

Verdict:

- `keep`

## Idea 3: Agent-safe payment policy engine

What it is:

- a control layer for autonomous or semi-autonomous systems that can request, approve, budget, and execute stablecoin payments with guardrails

Who pays:

- AI-agent platform operators
- enterprises experimenting with agent commerce
- teams building agent-facing financial workflows

Why it survives the three tests:

- yes, the buyer is an operator or platform, not the agent itself
- yes, mostly software and control logic
- yes, Solana’s cost and speed help agent payments, but the wedge is the policy layer above the rails

Existing evidence:

- builder side: `mcpay`, `solaibot`, `obverse`
- archive support: `Tourists in the bazaar: Why agents will need B2B payments — and why stablecoins will get there first`, `Agentic Payments and Crypto’s Emerging Role in the AI Economy`
- opportunity framing from prior pass: plumbing is getting built; budget, approval, and compliance layers still look earlier

What is still open:

- payment rails for agents are getting attention
- policy, spend controls, and auditability still look more open than pure payment acceptance

Verdict:

- `keep`

## Idea 4: Vertical AP / payout operating system

What it is:

- stablecoin-backed accounts payable, receivables, and payout ops for one vertical like logistics, marketplaces, creator payouts, or contractor payroll

Who pays:

- operations teams in one specific vertical

Why it survives the three tests:

- yes, clear operator budget if the workflow is painful enough
- partly software, partly local payment / banking integration
- Solana helps on settlement and cost, but the real moat is vertical workflow ownership

Existing evidence:

- builder side: `cargobill`, `credible-finance-1`, `misk.fi-stablecoin-payments-for-your-business`, `verisettle`
- archive support: `Solana’s Stablecoin Landscape`
- product lesson: generic payment rails are crowded, but workflow-specific systems remain more defensible

What is still open:

- vertical scope can make GTM stronger
- the risk is drifting into a full payments company too early

Verdict:

- `keep`, but only if the vertical is specific and the workflow is painful

## Idea 5: Issuer operations software

What it is:

- software for issuers and stablecoin program operators: reserve evidence, partner ops, attestation workflows, mint/burn controls, compliance evidence, and distribution tooling

Who pays:

- issuers
- fintechs launching stablecoin products
- infra teams supporting stablecoin operations

Why it survives the three tests:

- yes, clear operator buyer
- yes, much more software-shaped than becoming the issuer
- only partly Solana-specific, but Solana can be the initial chain where distribution and ops happen

Existing evidence:

- incumbent side: [brale.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/brale.md), [circle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/circle.md), [paxos.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/paxos.md)
- builder side: `equator`, `remi-the-stablecoin-layer-for-solana`, `gluon-stablecoin-platform`
- archive support: `How stablecoins become money: Liquidity, sovereignty, and credit`, `Solana’s Stablecoin Landscape`

What is still open:

- there are issuance platforms, but “issuer back-office software” is a narrower and less regulatory wedge

Verdict:

- `keep`, but second-tier unless there is direct founder edge with issuers

## Idea 6: Stablecoin liquidity operations console

What it is:

- software for operators managing stablecoin liquidity: venue concentration, routing, exposure, and deployment decisions

Who pays:

- treasuries
- protocols
- fintechs deploying stablecoin balances
- maybe market makers later

Why it survives the three tests:

- maybe, buyer exists but may be smaller and more sophisticated
- yes, mostly software and data
- yes, Solana’s fragmented on-chain liquidity makes this more relevant

Existing evidence:

- builder side: `stablecoins-fx`, `stay-liquid`, `solroute`
- archive support: `How stablecoins become money: Liquidity, sovereignty, and credit`
- market lesson: liquidity matters, but many liquidity products drift into finance strategy rather than clean software

What is still open:

- a data/control layer for operators may be stronger than a user-facing liquidity product

Verdict:

- `keep`, but only as a B2B ops product, not a consumer-facing yield app

## Idea 7: Generic merchant checkout

What it is:

- “accept stablecoins online or at POS”

Existing evidence:

- `borderless-wallets`, `decal-payments-and-loyalty`, `localpay`, `sp3nd`, `gaian-2`, `blindpay`
- plus established payment-side incumbents like [worldpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/worldpay.md)

Problem:

- crowded
- distribution-heavy
- often not a pure software moat

Verdict:

- `kill` as a default starting point

## Idea 8: Generic stablecoin wallet / neobank app

What it is:

- a better wallet for spending and holding stablecoins

Existing evidence:

- [kast.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/kast.md)
- [localpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/localpay.md)
- plus many adjacent consumer payment apps in the builder corpus

Problem:

- user acquisition is hard
- differentiation is weak
- local integrations matter more than product polish

Verdict:

- `kill`

## Idea 9: Launch a new stablecoin issuer

What it is:

- become the issuer or reserve platform yourself

Existing evidence:

- [circle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/circle.md)
- [paxos.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/paxos.md)
- [brale.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/brale.md)
- builder side: `equator`, `remi-the-stablecoin-layer-for-solana`, `gluon-stablecoin-platform`, `hylo`

Problem:

- too much of the moat lives in regulation, banking, trust, and distribution

Verdict:

- `kill` unless there is an exceptional regulatory edge

## Idea 10: Broad stablecoin orchestration platform

What it is:

- one API for wallets, cards, payouts, treasury, and settlement

Existing evidence:

- [bridge.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/bridge.md)
- [m0.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/m0.md)

Problem:

- too broad
- too ops-heavy
- strong incumbents already exist

Verdict:

- `kill` as a first product

## New idea variants worth brainstorming next

These are narrower versions of the good categories, not completely separate markets.

1. Stablecoin close engine
- daily close, exception detection, and ledger export for stablecoin-moving companies

2. Treasury rules engine for Solana-native teams
- approval policies, role-based permissions, counterparty rules, and spend thresholds

3. Agent spend authorization layer
- request, approve, limit, and audit agent-initiated payments

4. Corridor operations console
- one-country-pair stablecoin settlement with FX handling and payout ops

5. Issuer evidence layer
- reserve proof workflows, mint/burn evidence, and partner reporting

6. Merchant settlement back-office
- refunds, disputes, receivables, and treasury sweep after payment acceptance

## Current ranking

## Tier 1

- stablecoin treasury control plane
- stablecoin reconciliation and settlement assurance
- agent-safe payment policy engine

## Tier 2

- vertical AP / payout operating system
- issuer operations software
- stablecoin liquidity operations console

## Tier 3

- generic merchant rails
- generic wallet
- new issuer
- broad orchestration platform

## Best immediate next step

The strongest next move is not to pick one idea instantly. It is to run a second pass on the Tier 1 and Tier 2 ideas with this question:

- who is the first buyer
- what painful daily workflow are they doing now
- what is the minimum useful product that replaces one spreadsheet or one internal script

That second pass should shrink this list from six ideas down to two or three real candidates.

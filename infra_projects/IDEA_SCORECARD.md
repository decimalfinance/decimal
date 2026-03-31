# Stablecoin Infra Idea Scorecard

As of 2026-03-31.

This is the second-pass scoring sheet for the surviving ideas from [IDEA_BATTLE_TEST.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/IDEA_BATTLE_TEST.md).

The goal is not to declare a final winner. The goal is to rate each idea with the same rubric so the discussion becomes sharper.

## Scoring rubric

Total score: `100`

Weights:

- `25` Buyer urgency and budget
- `20` Software-shaped problem
- `15` Solana advantage
- `15` Competitive whitespace
- `15` GTM clarity
- `10` Buildability for a small technical team

Interpretation:

- `85-100`: very strong candidate
- `75-84`: strong, worth serious exploration
- `65-74`: interesting, but needs a sharper wedge
- `<65`: weak first company unless there is unusual founder edge

## 1. Stablecoin reconciliation and settlement assurance

Score: `87 / 100`

Breakdown:

- Buyer urgency and budget: `22 / 25`
- Software-shaped problem: `20 / 20`
- Solana advantage: `12 / 15`
- Competitive whitespace: `14 / 15`
- GTM clarity: `10 / 15`
- Buildability: `9 / 10`

Why it scores high:

- This is one of the cleanest software problems in the set.
- Operators already feel the pain in accounting, mismatch resolution, and post-settlement visibility.
- It does not require becoming a bank, custodian, or issuer.
- Real-time chain access on Solana is genuinely useful here, but not the only moat.

Evidence:

- builder-side signals: `ledgerx-or-crypto-accounting-for-solana-businesses.`, `stablecoins-fx`
- archive signal: `Indexing on Solana` explicitly surfaces reconciliation and reserve calculation ideas
- market framing: a lot of the market pain sits after payment acceptance, not before it

Main risk:

- It can become “good internal tooling” rather than a must-buy product if the workflow is not sharply defined

What would improve the score:

- pick one buyer first: treasury ops, fintech finance, or payout operators
- replace one painful daily reconciliation flow, not “all accounting”

## 2. Stablecoin treasury control plane

Score: `84 / 100`

Breakdown:

- Buyer urgency and budget: `23 / 25`
- Software-shaped problem: `18 / 20`
- Solana advantage: `11 / 15`
- Competitive whitespace: `11 / 15`
- GTM clarity: `12 / 15`
- Buildability: `9 / 10`

Why it scores high:

- The buyer is real and the budget exists.
- The problem is clear: approvals, limits, controls, evidence, and safe movement workflows.
- The best version is a control layer above custody rather than a replacement for custody.

Evidence:

- incumbent reference: [fireblocks.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fireblocks.md)
- builder signals: [fystack.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fystack.md), `firebird`, `stablecoins-fx`
- winner-side adjacent signal: `mercantill`
- archive framing: `Solana x Fireblocks: Institutional-Grade Treasury Infrastructure That Moves at Internet Speed`

Why it is not number one:

- incumbents are strong at the high end
- if the product is framed too broadly, it drifts toward custody and enterprise security

What would improve the score:

- aim at a lighter-weight control plane for smaller operators
- focus on approvals, policies, and evidence rather than custody primitives

## 3. Vertical AP / payout operating system

Score: `80 / 100`

Breakdown:

- Buyer urgency and budget: `23 / 25`
- Software-shaped problem: `13 / 20`
- Solana advantage: `11 / 15`
- Competitive whitespace: `10 / 15`
- GTM clarity: `14 / 15`
- Buildability: `9 / 10`

Why it scores well:

- Vertical workflow products usually have much better GTM than generic infra.
- A painful AP or payout loop can justify budget quickly.
- The wedge can be narrow and still valuable.

Evidence:

- builder signals: [cargobill.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/cargobill.md), `credible-finance-1`, `misk.fi-stablecoin-payments-for-your-business`, `verisettle`
- archive framing: `Solana’s Stablecoin Landscape`

Why it is not higher:

- this stops being a pure software problem once local payout rails and corridor operations dominate
- some verticals are secretly payments companies in disguise

What would improve the score:

- pick one narrow workflow with obvious operational pain
- stay on the ops and software side before taking on payout infrastructure directly

## 4. Agent-safe payment policy engine

Score: `78 / 100`

Breakdown:

- Buyer urgency and budget: `17 / 25`
- Software-shaped problem: `20 / 20`
- Solana advantage: `12 / 15`
- Competitive whitespace: `12 / 15`
- GTM clarity: `8 / 15`
- Buildability: `9 / 10`

Why it scores well:

- The problem is very software-shaped.
- The wedge sits above payment rails, where more whitespace likely remains.
- This feels more differentiated than generic agent payments.

Evidence:

- builder signals: `mcpay`, `solaibot`, `obverse`
- adjacent winner-side signal: `mercantill`
- archive framing: `Tourists in the bazaar: Why agents will need B2B payments — and why stablecoins will get there first`, `Agentic Payments and Crypto’s Emerging Role in the AI Economy`

Why it is not higher:

- buyer urgency is still emerging, not mature
- GTM is less proven than classic treasury or finance software

What would improve the score:

- define one concrete first buyer, such as enterprise agent operators or AI-tool platforms
- make the problem “budget approvals and audit for agents” rather than “agent payments” broadly

## 5. Issuer operations software

Score: `72 / 100`

Breakdown:

- Buyer urgency and budget: `18 / 25`
- Software-shaped problem: `16 / 20`
- Solana advantage: `8 / 15`
- Competitive whitespace: `10 / 15`
- GTM clarity: `10 / 15`
- Buildability: `10 / 10`

Why it still survives:

- it is better to sell software to issuers than try to become the issuer
- reserve evidence, partner ops, and issuance back-office all look real

Evidence:

- incumbent references: [brale.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/brale.md), [circle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/circle.md), [paxos.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/paxos.md)
- builder signals: [equator.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/equator.md), `remi-the-stablecoin-layer-for-solana`, `gluon-stablecoin-platform`
- archive framing: `How stablecoins become money: Liquidity, sovereignty, and credit`

Why it scores lower:

- buyer set is smaller and more specialized
- Solana is less of a direct moat here than in operational data or payment flow products
- some needs may get absorbed by larger issuance platforms

What would improve the score:

- focus on one painful back-office workflow: proof, reporting, mint/burn operations, or partner coordination

## 6. Stablecoin liquidity operations console

Score: `70 / 100`

Breakdown:

- Buyer urgency and budget: `15 / 25`
- Software-shaped problem: `17 / 20`
- Solana advantage: `13 / 15`
- Competitive whitespace: `9 / 15`
- GTM clarity: `7 / 15`
- Buildability: `9 / 10`

Why it is interesting:

- liquidity matters deeply to whether stablecoins feel usable
- this is a genuine on-chain operations problem

Evidence:

- builder signals: [stablecoins-fx.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/stablecoins-fx.md), [stay-liquid.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/stay-liquid.md), `solroute`
- archive framing: `How stablecoins become money: Liquidity, sovereignty, and credit`

Why it scores lower:

- buyer is narrower and more sophisticated
- GTM is less obvious than treasury or reconciliation software
- it can drift toward trading tooling or strategy rather than clean product software

What would improve the score:

- define the user as a treasury or fintech ops team, not a trader
- position it as a control and deployment console, not a market data dashboard

## Ranking

1. Stablecoin reconciliation and settlement assurance: `87`
2. Stablecoin treasury control plane: `84`
3. Vertical AP / payout operating system: `80`
4. Agent-safe payment policy engine: `78`
5. Issuer operations software: `72`
6. Stablecoin liquidity operations console: `70`

## What the numbers are saying

- The best immediate wedges are operational systems for teams already moving money.
- The strongest ideas are the ones where the software replaces spreadsheets, manual controls, and reconciliation pain.
- The weakest of the surviving set are not bad ideas; they just have fuzzier buyers or more indirect GTM.

## Recommendation

The next pass should not be broad research again. It should be workflow design.

For the top four ideas, answer:

- who is the exact first buyer
- what exact task they do every day
- what they use now
- what event triggers them to pay for software
- what the smallest lovable product looks like

That is the pass that will tell us whether the top-ranked idea should actually stay on top.

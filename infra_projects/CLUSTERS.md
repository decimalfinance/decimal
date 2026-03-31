# Stablecoin Infra Clusters

This file groups the research corpus by primary market bucket. Some companies could fit more than one bucket, but each file is assigned a primary home so idea generation stays clean.

## 1. Platform orchestration

Definition:
- infrastructure that abstracts over multiple money movement primitives
- wallet orchestration
- issuance plumbing
- cards / payouts / routing
- “money movement operating system” products

Files:
- [bridge.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/bridge.md)
- [m0.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/platform-orchestration/m0.md)

Recurring customer need:
- “Give me one layer to move and manage money, not six separate stablecoin components.”

## 2. Payments and merchant rails

Definition:
- checkout
- merchant acceptance
- B2B payment automation
- vertical-specific payment operating systems

Files:
- [worldpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/worldpay.md)
- [arch.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/arch.md)
- [borderless-wallets.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/borderless-wallets.md)
- [cargobill.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/cargobill.md)
- [misk-fi.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/misk-fi.md)
- [stablepay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/stablepay.md)
- [stableyard.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/payments-and-merchant/stableyard.md)

Recurring customer need:
- “Let me accept and settle stablecoins in a business workflow without rebuilding payments from scratch.”

## 3. Remittance, FX, and settlement

Definition:
- cross-border flows
- treasury FX
- stablecoin-backed settlement
- local-currency conversion

Files:
- [credible-finance.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/credible-finance.md)
- [link-business.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/link-business.md)
- [stablpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/stablpay.md)
- [stablecoins-fx.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/stablecoins-fx.md)
- [verisettle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/remittance-fx-and-settlement/verisettle.md)

Recurring customer need:
- “Move money internationally faster and cheaper, and make FX / settlement operationally sane.”

## 4. Treasury, custody, and controls

Definition:
- custody
- approval and policy layers
- treasury operating controls
- secure wallet infrastructure for business operators

Files:
- [fireblocks.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fireblocks.md)
- [fystack.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/treasury-custody-and-controls/fystack.md)

Recurring customer need:
- “Let my team control funds safely with business-grade policy, custody, and workflow.”

## 5. Issuance and reserve infrastructure

Definition:
- stablecoin launch tooling
- proof-of-reserves
- reserve architecture
- compliant issuance backends

Files:
- [brale.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/brale.md)
- [circle.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/circle.md)
- [equator.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/equator.md)
- [hylo.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/hylo.md)
- [paxos.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/issuance-and-reserve/paxos.md)

Recurring customer need:
- “Help me issue or operate a stablecoin with better reserve, compliance, and transparency mechanics.”

## 6. Liquidity and yield infrastructure

Definition:
- stablecoin liquidity concentration
- yield-bearing dollars
- white-label yield
- productive idle capital

Files:
- [perena.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/perena.md)
- [reflect.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/reflect.md)
- [stay-liquid.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/liquidity-and-yield/stay-liquid.md)

Recurring customer need:
- “Idle stablecoin balances should earn, route, or concentrate more efficiently.”

## 7. Money apps and wallets

Definition:
- consumer or SMB-facing money apps
- non-custodial payment wallets
- stablecoin neobank UX

Files:
- [kast.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/kast.md)
- [dollar.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/dollar.md)
- [localpay.md](/Users/fuyofulo/code/stablecoin_intelligence/infra_projects/money-apps-and-wallets/localpay.md)

Recurring customer need:
- “Make stablecoin rails feel like a usable money product, not crypto plumbing.”

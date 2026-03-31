# Solana Stablecoin Market Context

## Executive Summary

Solana has become a major stablecoin execution layer rather than just a general-purpose L1. The strongest current signals from primary sources are:

- Solana’s own ecosystem pages say the network handled `>$1T` in stablecoin volume in 2025, and the February 2026 ecosystem report says February stablecoin transactions alone reached `$650B`, with total stablecoin supply holding near `$15B`.
- The same ecosystem pages market Solana as a stablecoin issuance and payments stack with `~$0.0013` median fees and `~400ms` settlement, which is the core economic reason issuers and payment companies are choosing it.
- Circle, PayPal/Paxos, Visa, Worldpay, Western Union, Fiserv, and Solana Pay all point to the same demand curve: faster settlement, lower fees, 24/7 treasury movement, merchant acceptance, remittances, and cross-border payouts.
- The market is splitting into three clear layers: stablecoin issuance/settlement, payments/merchant rails, and treasury/liquidity tooling. A fourth layer, data/intelligence, is what makes the market legible.

## Market Size And Usage Signals

- Solana says it processed over `$1T` in stablecoin volume in 2025. Source: Solana Payments docs.
- Solana’s February 2026 ecosystem report says stablecoin transactions surpassed `$650B` in February and supply held near `$15B`.
- Solana’s stablecoin issuance pages currently market `~$10B` stablecoin supply and `~$200B` monthly stablecoin transfers. Those rounded figures are useful for positioning, but the February 2026 ecosystem report is the more recent operating signal.
- Solana’s treasury/institutional page says the network is now used by the world’s largest payment networks to create stablecoins and settle transactions on Solana, and explicitly lists:
  - Western Union `USDPT` for 100M customers
  - Worldpay merchant settlement in `USDG`
  - Visa USDC settlement with `millions` of USDC moved over Solana
  - Fiserv `FIUSD`

## Stablecoin Issuers And Settlement Networks

| Company | What they are building on/for Solana | Customer segment | Funding / status |
|---|---|---|---|
| Circle | Native `USDC` on Solana, plus `EURC`, CCTP, pre-mint/Gateway integration, and USYC on Solana | Developers, institutions, exchanges, wallets, businesses | Public company |
| PayPal / Paxos | `PYUSD` on Solana for commerce and payments | Consumers, merchants, Venmo/PayPal users, external wallets, developers | PayPal public; Paxos private, `>$540M` raised per Paxos |
| Paxos / Global Dollar Network | `USDG` on Solana for payments, settlements, treasury | Regulated institutions, wallets, exchanges, merchants | Paxos private, `>$540M` raised |
| Visa | Stablecoin settlement with `USDC` over Solana | Issuers, acquirers, card rails, banks | Public company |
| Worldpay | Merchant settlement and payouts in `USDG` on Solana | Merchants, marketplaces, travel, gaming, global businesses | Public company |
| Western Union + Anchorage | `USDPT` on Solana for remittances and digital asset network | 100M Western Union customers, agents, partners | Public enterprise + regulated bank partner |
| Fiserv | `FIUSD` on Solana for institutional clients and treasury | Financial institutions, enterprise treasury | Public company |
| Solana Pay | Open merchant payment rail built on Solana, Shopify integration | Ecommerce merchants, point-of-sale, developers | Ecosystem protocol |

## Solana-Native Stablecoin Infra And Yield Layers

| Company | What they are building | Customer segment | Funding / status |
|---|---|---|---|
| Perena | Stablecoin infrastructure and unified liquidity layer on Solana; `USD*` and stableswap infrastructure | Issuers, DeFi apps, stablecoin projects | Officially says pre-seed validated by Borderless; also says strategic investors from Citadel, IMC, SIG, Jane Street |
| Reflect | Yield-bearing dollars and stablecoin-as-a-service on Solana, including `USDC+` | Users, institutions, fintech apps, developers | Funding not publicly disclosed on official site |
| Solana ecosystem stablecoin initiatives | Reflect Whitelabel, SGB App, JupUSD, tokenized money market products | Issuers, treasury teams, DeFi users | Ecosystem announcements |

## Merchant And Payment Adoption

- Solana Pay says it is available to millions of businesses as an approved Shopify app integration.
- Solana Pay says merchants can accept stablecoin payments with near-zero fees and direct merchant-to-consumer settlement.
- Solana Foundation’s Autonomous case study says Autonomous has sold to `600,000+` customers in `100+` countries and integrated Solana Pay into its checkout flow.
- PayPal’s Solana launch says `Crypto.com, Phantom and Paxos` were first to provide onramps for PYUSD on Solana.
- Visa says U.S. issuer and acquirer partners can settle in USDC over Solana, and reports `>$3.5B` annualized stablecoin settlement volume across its pilot program by late 2025.
- Worldpay says its merchants can settle with USDG on Solana and that payouts can be sent in stablecoins to customers, contractors, creators, sellers, and other beneficiaries across `180+` markets.
- Western Union says USDPT will support remittance flows across `100M` customers and a network of `550,000+` agent locations in `150+` countries.

## Major Use Cases

The primary use cases that recur across the official sources are:

- Cross-border payments and remittances
- Merchant acceptance and point-of-sale commerce
- Card settlement and acquirer/issuer settlement
- Treasury optimization and prefunding reduction
- Global payouts to contractors, sellers, creators, and gig workers
- Stablecoin issuance and reserve management
- DeFi trading, lending, borrowing, and yield
- Tokenized money market / yield-bearing dollar products
- Onchain FX and liquidity routing

## Customer Segments

The market is not one customer type. It is several:

- Consumers: PayPal, Venmo, Western Union, Solana Pay checkout users
- Merchants: ecommerce, POS, marketplaces, travel, gaming
- Financial institutions: banks, issuers, acquirers, payment processors
- Fintechs and wallets: onramps, transfers, commerce tooling
- Treasury teams: corporations and fintechs optimizing idle cash and settlement
- DeFi users: traders, LPs, lenders, borrowers, yield seekers
- Issuers: companies launching their own branded or consortium stablecoins

## What This Means For A Stablecoin Infra Company

If you want to build a meaningful business here, the wedge is not “stablecoins exist.” The wedge is:

1. Make stablecoin flow on Solana legible at the entity level.
2. Turn raw account writes into labeled events: issuance, redemption, pool deposit, swap, treasury move, payout, remittance, settlement.
3. Build a data product that helps customers understand liquidity, counterparty behavior, and operational impact.
4. Keep the first product narrow: USDC-first, then expand.

The most credible commercial buyers are likely to be:

- Trading firms and market makers
- Treasury teams and payment companies
- Stablecoin issuers
- DeFi protocols
- Risk/compliance and operations teams

## Notes On Evidence Quality

- The strongest numbers in this brief come from Solana, Circle, PayPal/Paxos, Visa, Worldpay, and Western Union primary pages.
- Solana marketing pages sometimes show rounded figures (`$10B`, `$200B`) that lag behind the most recent ecosystem report (`~$15B`, `$650B monthly`). Use the latest report for operational context and the rounded pages for positioning.
- A few funding details are public on company-owned pages; for others, funding is not disclosed and should not be guessed.


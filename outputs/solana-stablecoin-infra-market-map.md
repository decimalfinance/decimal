# Solana Stablecoin Infra Market Map

## Executive Takeaway

Solana is already a serious stablecoin settlement layer, not a speculative side market. The chain’s own docs say it processed over `$1T` in stablecoin volume in 2025, and its February 2026 ecosystem report says stablecoin transactions reached `$650B` in a single month with total supply near `$15B`. At the same time, the market is being pulled by real enterprises and regulated platforms: Circle, PayPal/Paxos, Visa, Worldpay, Western Union, and Fiserv are all using or launching stablecoin products on Solana.

The market is crowded in issuance and payments, and there are also early signs of demand in liquidity, treasury, and data layers. The hard part is not seeing raw transactions. The hard part is turning Solana activity into products that a specific buyer will pay for.

## Market Structure

There are four practical layers:

1. Issuance and reserve management.
2. Payments, settlement, cards, payouts, and treasury rails.
3. Yield, liquidity, and stablecoin product design.
4. Data, labels, and intelligence.

The first three layers already have credible players. The fourth layer is still early, but there is no consensus yet on which specific data or analytics product should win.

## Key Numbers

- Solana says 2025 stablecoin volume exceeded `$1T`: [Solana Payments](https://solana.com/docs/payments).
- Solana says stablecoin supply is about `$10B` on its stablecoin page, while the February 2026 ecosystem report says supply held near `$15B`: [Solana stablecoins](https://solana.com/solutions/stablecoins), [Solana February 2026 report](https://solana.com/news/state-of-solana-february-2026).
- Solana’s docs say median fee is about `$0.0013` and settlement is about `400ms`: [Solana Payments](https://solana.com/docs/payments).
- DefiLlama currently shows Solana stablecoin market cap at about `$15.244B`, with USDC at about `53%` dominance: [DefiLlama Solana stablecoins](https://defillama.com/stablecoins/Solana).
- Visa says retail-sized transactions are less than `1%` of adjusted stablecoin volume, which implies the important commercial market is treasury, settlement, payments, liquidity, and cross-border flows: [Visa stablecoin strategy](https://corporate.visa.com/en/sites/visa-perspectives/trends-insights/making-sense-of-stablecoins.html).

## Company Map

### Issuers, Settlement, And Payment Rails

| Company | What they are building on Solana | Main customers | Status / funding |
|---|---|---|---|
| Circle | Native USDC on Solana, EURC, CCTP, tokenized cash products, enterprise stablecoin infrastructure | Enterprises, developers, wallets, exchanges, financial institutions | Public company; NYSE listed [Circle IR](https://investor.circle.com/overview/) |
| PayPal / Paxos | PYUSD on Solana for payments and commerce | Consumers, merchants, wallets, developers | PayPal public; Paxos private and says it has raised over `$540M` [Paxos USDG](https://www.paxos.com/newsroom/paxos-introduces-global-dollar-usdg) |
| Paxos / Global Dollar Network | USDG on Solana for payments, settlements, and treasury | Regulated institutions, wallets, merchants, exchanges | Private, over `$540M` raised [Paxos USDG](https://www.paxos.com/newsroom/paxos-introduces-global-dollar-usdg) |
| Visa | USDC settlement in the US and stablecoin settlement across several chains | Issuers, acquirers, banks, fintechs | Public company [Visa USDC settlement](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21951.html) |
| Worldpay | USDG merchant settlement on Solana and stablecoin payouts | Merchants, marketplaces, travel, gaming, payout platforms | Public company [Worldpay USDG](https://www.worldpay.com/en-AE/insights/articles/worldpay-solana-stablecoin-partnership) |
| Western Union + Anchorage | USDPT on Solana for remittances and cash offramps | Western Union customers, agents, partners | Public enterprise + regulated issuer partner [Western Union USDPT](https://ir.westernunion.com/news/archived-press-releases/press-release-details/2025/Western-Union-Announces-USDPT-Stablecoin-on-Solana-and-Digital-Asset-Network/default.aspx) |
| Fiserv | FIUSD for banks, treasury, and payment systems | Financial institutions, merchants, embedded finance platforms | Public company [FIUSD](https://www.fiserv.com/en/solutions/embedded-finance/fiusd-stablecoin.html) |
| Bridge / Stripe | Stablecoin orchestration, issuance, wallets, cards, cross-border payments | Fintechs, businesses, developers, treasury teams | Acquired by Stripe in 2025 [Stripe acquisition](https://stripe.com/ae/newsroom/news/stripe-completes-bridge-acquisition) |

### Solana-Native Stablecoin Infra And Yield

| Company | What they are building | Main customers | Status / funding |
|---|---|---|---|
| M0 | Shared stablecoin infrastructure, issuance stack, interoperability layer, now on Solana | Issuers, wallets, fintech apps, protocols | Series B, total funding `$100M`; powers MetaMask, KAST, Noble, Usual, Playtron, etc. [M0 Series B](https://www.m0.org/press-releases/m0-raises-series-b-with-investment-from-polychain-and-ribbit-capital-bringing-total-funding-to-100m), [M0 on Solana](https://www.m0.org/press-releases/m-0-launches-on-solana-bringing-the-first-programmable-stablecoin-infrastructure-to-one-of-cryptos-fastest-growing-ecosystem) |
| Perena | Stablecoin infra, unified liquidity layer, USD* yield-integrated LP token, Numéraire stableswap | DeFi apps, issuers, stablecoin projects | Pre-seed / strategic backers from Borderless, Citadel, IMC, SIG, Jane Street; own site says Numéraire is the largest stableswap on Solana [Perena](https://perena.org/), [Accelerating Perena](https://perena.org/articles/accelerating-perena) |
| Reflect | Yield-bearing stablecoins, stablecoin-as-a-service, insurance-backed dollar products | Users, institutions, apps, developers | Seed round `$3.75M` led by a16z crypto CSX [Reflect jobs](https://jobs.reflect.money/details/3), [Reflect docs](https://docs.reflect.money/) |
| Brale | Stablecoin issuance API, reserve management, cross-chain swaps, stablecoin treasury economics | Businesses, fintechs, app chains, protocols | Raised `$30M` in Sep 2025 [Brale new capital](https://brale.xyz/blog/new-capital) |
| Solstice | USX, a Solana-native stablecoin with native yield via YieldVault | Yield seekers, institutions, Solana DeFi users | Backed by Deus X Capital; launch press said `$160M` deposited TVL at launch [Solstice launch](https://www.thestreet.com/crypto/press-releases/solstice-labs-announces-upcoming-usx-launch-a-solana-native-stablecoin-built-for-transparent-yield) |
| KAST | Stablecoin-powered neobank and payments platform | Consumers and businesses moving USD cross-border | Seed `$10M`, then Series A `$80M` in Mar 2026; over 1M users, nearly `$5B` annualized volume [KAST seed](https://www.kast.xyz/blog/kast-secures-us-10-million-seed-round), [KAST Series A](https://www.kast.xyz/blog/kast-announces-80m-series-a) |
| Streamflow | Token distribution, vesting, staking, locks, dashboards | Token teams, DAOs, project ops | Says `25.2K+` projects and about `$8M` total funding raised [Streamflow about](https://streamflow.finance/about/) |

### Intelligence, Labels, And Infrastructure

| Company | What they are building | Main customers | Status / funding |
|---|---|---|---|
| Helius | Solana RPC, data streaming, wallet attribution and indexing tools | Builders, traders, prop firms, wallets, institutions | Private; funding not verified from primary sources reviewed. Product is clearly enterprise-grade [Helius](https://www.helius.dev/) |
| Nansen | Wallet labels, smart money, alerts, API, agentic onchain research | Investors, trading teams, institutions, analysts | Seed `$1.2M`, Series A `$12M`, Series B `$75M` [Nansen funding](https://www.nansen.ai/post/nansen-raises-75-million-in-series-b-funding), [Nansen about](https://www.nansen.ai/about) |
| Dune | Stablecoin balance and activity datasets, including Solana activity-enriched classification | Analysts, funds, data teams | Public details not needed for this wedge; product shows there is demand for stablecoin classification [Dune Solana stablecoin activity](https://docs.dune.com/data-catalog/curated/stablecoins/activity-enriched/stablecoins-solana-activity-enriched) |
| DefiLlama | Stablecoin market cap and chain-level dashboards | Analysts, funds, ecosystem teams | Open data product; not a company wedge by itself, but useful market context [DefiLlama Solana stablecoins](https://defillama.com/stablecoins/Solana) |
| Zerion | Wallet data API, subscriptions, decoded transactions, PnL | Apps, wallets, data consumers | Venture-backed; public funding not verified here. Useful as wallet-data competitor [Zerion API](https://www.zerion.io/api/somnia) |

## What The Buyers Actually Want

The strongest customer segments are not retail users. They are:

- Issuers and reserve managers.
- Banks, acquirers, and payment networks.
- Fintechs and wallet apps.
- Treasury teams managing idle cash and settlement.
- DeFi protocols, LPs, and market makers.
- Risk, compliance, and operations teams.
- Data/analytics teams that need a clean view of wallet and entity behavior.

That is consistent with the public messaging from Visa, Worldpay, Fiserv, Western Union, Bridge, M0, Perena, and Reflect.

## What Is Underbuilt

The market already has:

- Stablecoin issuance.
- Payment orchestration.
- Cards and payouts.
- Treasury and yield products.

What it still lacks is a clean, explainable, Solana-native intelligence layer that can answer:

- Which entity moved the stablecoin?
- Was this a pool deposit, swap, treasury rebalance, payout, mint, or burn?
- Is the balance change meaningful for liquidity or market structure?
- Which addresses are whales, vaults, treasuries, routing accounts, or program-owned accounts?

That is the wedge that looks both technically credible and commercially defensible.

## Open Questions

The market is not yet settled on which infra wedge is most valuable. The main open questions are:

- whether the biggest budget sits in issuance and settlement,
- whether wallets and treasury operations are the real pain point,
- whether shared liquidity and routing matters more than new issuance,
- whether merchants and payouts will be the dominant use case,
- or whether data, labels, and accounting are the fastest path to revenue.

The answer likely depends on the customer type and how much regulatory complexity they are willing to absorb.

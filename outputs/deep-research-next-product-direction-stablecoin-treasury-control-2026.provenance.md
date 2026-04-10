# Provenance: Next Product Direction After Stablecoin Reconciliation

Date: 2026-04-11

## Research Method

This brief extends `outputs/market-research-stablecoin-ops-customer-jobs-2026.md`.

The named `$deep-research` skill was selected, but its referenced prompt file was not present on disk. I followed the skill's stated output contract manually: a cited research brief plus a provenance sidecar in `outputs/`.

## Sources Used

### Prior Internal Research

- `outputs/market-research-stablecoin-ops-customer-jobs-2026.md`
- Role: baseline market map and existing thesis.
- Confidence: high for our own product analysis; medium for market conclusions because it relies on public product positioning.

### Remlo

- Remlo docs introduction: https://docs.remlo.xyz/docs
- Remlo docs architecture: https://docs.remlo.xyz/docs/architecture
- Remlo docs `llms-full.txt`: https://docs.remlo.xyz/llms-full.txt
- Remlo homepage: https://remlo.xyz
- Role: understand Remlo's product/protocol positioning.
- Confidence: medium. These are first-party docs/marketing pages. They are useful for product architecture and claimed scope, but they do not independently verify production traction, compliance readiness, or audited smart-contract maturity.
- Important extracted claims:
  - employer funding through Bridge virtual account
  - PayrollTreasury and PayrollBatcher contracts on Tempo L1
  - employee wallets, Bridge cards, and off-ramp
  - TIP-20 memo and TIP-403 compliance model
  - API/agent endpoints for payroll execution, compliance checks, treasury optimization, off-ramp, and history

### Colosseum

- Colosseum Breakout winners / honorable mentions: https://blog.colosseum.com/announcing-the-winners-of-the-solana-breakout-hackathon/
- Role: verify Remlo's competition status.
- Confidence: high for the narrow claim that Colosseum listed Remlo as a Stablecoins Track honorable mention in this post.
- Important correction:
  - I found Remlo listed as an honorable mention, not a prize winner, in the Solana Breakout Hackathon post.

### Toku

- Toku stablecoin payroll guide: https://www.toku.com/resources/what-is-stablecoin-payroll-cfo-guide
- Role: understand finance-grade stablecoin payroll requirements.
- Confidence: medium-high for workflow requirements because it is a provider-authored guide but aligns with general payroll control logic.
- Important extracted claims:
  - stablecoin payroll is a settlement layer inside payroll operations
  - gross-to-net calculation, approvals, destination governance, reporting, proof of execution, and reconciliation remain necessary
  - payroll register -> payout reconciliation is central

### Altitude / Squads

- Agentic finance article: https://squads.xyz/blog/intelligence-in-motion-agentic-finance-at-altitude
- Altitude Bill Pay: https://squads.xyz/blog/introducing-altitude-bill-pay
- Altitude CFO Stack: https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude
- Altitude business treasury article found in search: https://squads.xyz/blog/altitude-brings-bitcoin-to-business-treasury
- Role: understand stablecoin finance ops and autonomous treasury positioning.
- Confidence: medium. These are first-party product/strategy posts, useful for product direction but not independent market proof.
- Important extracted claims:
  - agentic finance requires deterministic execution, not probabilistic AI-only workflows
  - named future workflows include agentic bill pay, scheduled payments, treasury allocation, automated swaps/FX, and policy-bounded recurring behavior
  - Bill Pay/CFO Stack emphasizes invoice/bill intake, approval, execution, ledger/evidence, and accounting exports

### Coinshift

- Coinshift/Biconomy treasury case study: https://blog.coinshift.xyz/how-biconomy-manages-their-treasury-with-coinshift
- Role: crypto-native treasury management pattern.
- Confidence: medium. First-party case study, useful for product pattern.
- Important extracted claims:
  - shared contacts/labels across treasury accounts
  - propose/approve transaction workflow
  - real-time treasury visibility
  - CSV exports filtered by labels, token, date, account, and network

### Request Finance

- Search result for payroll help center: https://help.request.finance/en/articles/8624295-how-to-run-payroll
- Role: quick market corroboration that crypto payroll often uses employee lists, manual entry, and CSV upload.
- Confidence: low-to-medium because only the search result snippet was used in this pass.

## Claims To Treat Carefully

- Remlo's public docs include strong architecture/protocol claims, but I did not independently verify smart-contract code, audits, live transaction volume, Bridge integration production status, or legal/compliance posture.
- I did not verify the X post at `https://x.com/altitude/status/2036810195691565305` directly because the accessible source path was a Squads/Altitude article covering the same "agentic finance" theme.
- Market positioning from Altitude, Remlo, Toku, and Coinshift is provider-authored. It is useful as a product signal, not as neutral validation of demand.
- The recommended roadmap is an inference from public product patterns plus our current backend capabilities, not direct customer discovery.

## Open Research Questions

- Which buyer has the sharpest pain for our current assets: Solana-native startups, DAOs, SMB import/export businesses, AI teams with global contractors, or treasury teams at stablecoin-native companies?
- Is the right wedge AP/bill pay, contractor payouts, or treasury execution control?
- Which execution integration should be first: wallet-adapter direct signing, Squads proposal creation, Grid Smart Transactions, or manual signature attachment?
- What accounting export target matters first: CSV, QuickBooks, Xero, NetSuite, or customer-specific exports?
- Do users trust an AI extraction/review layer before source-side execution exists, or does it only become useful once the product can actually send/propose payments?

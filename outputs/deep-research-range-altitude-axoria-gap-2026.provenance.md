# Provenance: Range, Altitude, and Axoria Gap Research

Date: 2026-04-21

## Research Method

Used web search and primary source review for Range, Altitude/Squads, Bridge, and Modern Treasury. Used local Axoria system docs to compare against current implementation.

## Primary Sources Used

### Range

- `https://www.range.org/`
  - Used for Range’s public positioning: stablecoin risk/intelligence platform, risk/compliance, transaction risk engine, treasury monitoring, stablecoin explorer, Faraday.

- `https://docs.range.org/introduction/about-range`
  - Used for Range platform pillars: Faraday, Risk API, Data API, integrations/tools.
  - Used for claims around wallet screening, sanctions compliance, treasury flow monitoring, cross-chain execution, enterprise readiness, audit trails.

- `https://docs.range.org/risk-api/risk-introduction`
  - Used for Risk API feature set: addresses, transactions, smart contracts, sanctions, tokens, payment risk.

- `https://docs.range.org/risk-api/product-info/understanding-risk-scores`
  - Used for risk methodology: network proximity, ML, threat intelligence, known non-malicious attribution override, payment risk factors.

- `https://docs.range.org/risk-api/risk/get-payment-risk-assessment`
  - Used for payment risk details: new wallet detection, dormant wallet, address poisoning, interaction history, malicious connection analysis, token risk.

- `https://docs.range.org/faraday-api/introduction`
  - Used for Faraday API claims: cross-chain stablecoin routing, best execution, compliance, Travel Rule, OFAC/sanctions monitoring, auditability.

- `https://www.range.org/blog/faraday-the-transaction-engine-for-safe-scalable-and-compliant-stablecoin-payments`
  - Used as supporting source for Faraday positioning as a stablecoin transaction engine.

### Altitude / Squads

- `https://squads.xyz/blog/introducing-altitude-and-a-strategic-investment-from-haun-ventures`
  - Used for Altitude positioning: USD business account, save/earn/move dollars, ACH/Wire/SEPA/stablecoin transfers, yield/rewards, approval workflows, team permissions, invoice tracking.
  - Used for Squads foundation: Squads Protocol, secured/processed value claims, Haun Ventures strategic investment.
  - Used for legal disclaimer that Squads Labs is not a bank or digital asset custodian.

- `https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude`
  - Used for CFO Stack details: invoicing, bill pay, accounting, bill inbox, email forwarding, payment detail extraction, batch bills, vendor whitelist, approval policies, risk checks, duplicate/discrepancy flags, QuickBooks CSV exports.
  - Used for partner/legal note: Altitude partners with Bridge Building Inc for certain stablecoin transactions; Altitude is not a bank/financial institution and does not hold balances on behalf of customers.

- `https://jobs.solana.com/companies/squads-2-f6fb25b1-e381-4b5c-ae8c-7d8b128601ff/jobs/68031576-account-executive`
  - Used cautiously as a secondary source for current traction and product breadth claims: global accounts, cross-border payments, cards, invoicing, yield, 500+ businesses, backers.

### Bridge

- `https://www.bridge.xyz/`
  - Used for Bridge’s product scope: receive, store, convert, issue, spend stablecoins; orchestration, issuance, cards, wallets, cross-border payments.

- `https://www.withbridge.com/product/orchestration`
  - Used for Bridge Orchestration description: stablecoin payments, global movement, accept/send to consumers/businesses.

- `https://apidocs.bridge.xyz/platform`
  - Used for API-level capabilities: transfers across fiat/stablecoins, reusable transfer templates, stablecoin/fiat orchestration.

### Modern Treasury

- `https://docs.moderntreasury.com/reconciliation/docs/overview`
  - Used for reconciliation product framing: ingestion, automatic reconciliation, exception management, export, expected payments.

- `https://www.moderntreasury.com/products/ledgers`
  - Used for ledger framing: immutable system of record, double-entry accounting, real-time visibility, audit logs.

## Local Axoria Sources Used

- `system_explained/01-product-mental-model.md`
  - Used for current Axoria product layers, strengths, and explicit non-goals.

- `system_explained/10-api-first-and-agent-surface.md`
  - Used for current API-first state, session auth, OpenAPI, and removed machine-agent surfaces.

- `list.md`
  - Used for remaining backlog items and current implementation status.

## Confidence Notes

- High confidence: Range product pillars and Altitude CFO Stack features, because they came from official docs/blog pages.
- Medium confidence: Altitude traction details from the Solana job board, because job postings can be marketing-forward and may change.
- High confidence: Axoria comparison, because it uses local repo docs and implementation checklist.
- Low confidence: exact commercial/compliance arrangements beyond explicit partner disclaimers. The report avoids assuming unlisted bank/provider relationships.


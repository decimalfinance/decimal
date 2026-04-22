# Deep Research: Range, Altitude, and the Gap to Axoria

Date: 2026-04-21  
Project: Axoria  
Research question: What do stronger products like Range and Altitude actually offer, how far is Axoria from them, and is the gap mostly code or non-code assets like partners, compliance, legal, banking rails, and distribution?

## Executive Summary

Axoria is not competing with Range and Altitude on equal footing yet because they are not just “treasury dashboards.” They sit at different points of the stablecoin finance stack.

Range is primarily **stablecoin risk, compliance, intelligence, and compliant transaction infrastructure**. Its advantage is not UI depth. Its advantage is data coverage, risk models, sanctions/compliance integrations, cross-chain visibility, routing integrations, and institutional trust.

Altitude is primarily **a stablecoin-native business account / CFO stack**. Its advantage is not just payment tracking. Its advantage is that it starts where finance teams live: accounts, invoices, bills, approvals, fiat/stablecoin rails, yield, cards, accounting exports, and team controls. It is built on Squads’ self-custody/multisig foundation and appears to rely on partners such as Bridge for regulated stablecoin transaction services.

Axoria today is strongest in the middle of the stack:

```text
Input        ⚠️ improving, but still mostly manual / CSV
Control      ✅ strong for policy, approval, execution handoff, audit state
Execution    ⚠️ browser-wallet transaction preparation and signature recording, not full treasury execution
Verification ✅ strong for Solana USDC observation, matching, exceptions, proof packets
Fiat/Rails   ❌ not present
Compliance   ❌ not present
Accounting   ⚠️ proof packets exist, but accounting workflow is not mature
Distribution ❌ no design partners / customers yet
```

The harsh answer: **the gap is not just more development**. Some of it is code, but the bigger product gap is workflow ownership, integrations, compliance posture, trust, and distribution.

Axoria can still win a narrower wedge: **Solana-native stablecoin payment control and reconciliation proof**. Trying to copy Altitude or Range directly would be a mistake. The more realistic path is to become the proof/control layer that can plug into payment workflows, multisigs, and eventually finance inputs.

## The Stablecoin Operations Stack

A useful model:

```text
1. Business input
   Bills, invoices, payroll files, vendor requests, grant payout lists, API-created payment intents.

2. Control plane
   Policies, approvals, roles, destination trust, source wallet selection, execution readiness.

3. Execution
   Wallet signing, multisig proposals, batch payments, cross-chain routing, fiat/stablecoin rails.

4. Verification
   On-chain observation, matching, exceptions, settlement proof, audit trail.

5. Finance output
   Accounting exports, reconciliation reports, receipts, compliance logs, audit packets.
```

Range is strongest in layers 3-4 plus compliance/risk intelligence.  
Altitude is strongest in layers 1-3 plus business account distribution.  
Axoria is strongest in layers 2 and 4.

That is why Axoria can feel abstract even when the backend works. The strongest parts are downstream of the user’s natural starting point.

## Range: What They Actually Offer

Range describes itself as a blockchain risk and intelligence platform for stablecoins, wallets, protocols, custodians, issuers, fintechs, and enterprise treasury teams. Its docs say it provides real-time security, sanctions compliance, cross-chain monitoring, forensic capabilities, wallet screening, treasury flow monitoring, and cross-chain transfers with integrated compliance workflows.

Range’s current product pillars appear to be:

- **Risk API**
- **Faraday API**
- **Data API**
- **Stablecoin explorer / intelligence**
- **Treasury monitoring and threat detection**

### Risk API

Range’s Risk API scores addresses, transactions, tokens, smart contracts, and payments. It includes sanctions and blacklist checks, wallet and address risk scoring, payment risk assessment, token risk assessment, and smart contract risk evaluation.

The docs describe risk scoring based on:

- sanctions and blacklist data
- known threat intelligence
- network proximity analysis
- machine learning models
- behavioral analysis
- known non-malicious attribution overrides

This is a serious product moat. Axoria does not have this. Building a credible equivalent would require years of data, threat intelligence, compliance integrations, and model validation.

### Payment Risk Assessment

Range’s payment risk assessment evaluates payment flows before execution. It checks things like:

- recipient wallet age
- dormant wallet behavior
- address poisoning patterns
- sender-recipient interaction history
- malicious connection analysis
- token risk
- cross-chain support

This directly overlaps with a future Axoria need: before paying a destination, Axoria should know whether that payment is operationally risky.

Today Axoria has destination trust states, but those are user-maintained. Range has a data-backed risk engine.

### Faraday API

Range’s Faraday API is positioned as enterprise stablecoin infrastructure with routing, compliance, and risk management for cross-chain transfers. It claims:

- sending and receiving stablecoin transactions in one API
- best execution across DEX aggregators and bridges
- compliance checks such as Travel Rule support, OFAC screening, and sanctions monitoring
- address poisoning and human-error prevention
- auditability and compliance logs
- cross-chain stablecoin transfers like USDT on Solana to USDC on Ethereum

This is not just “a treasury management UI.” It is closer to programmable money movement infrastructure.

### Range’s Real Moat

Range’s moat is not only code. It is:

- coverage across many chains
- blockchain intelligence datasets
- sanctions/compliance data
- transaction risk heuristics
- ML threat detection
- institutional customer trust
- integrations with routing aggregators/bridges
- audit/compliance posture
- enterprise sales motion

Axoria should not try to rebuild Range. The realistic move is to integrate with products like Range later for destination/payment risk scoring.

## Altitude: What They Actually Offer

Altitude is built by Squads. Squads positions Altitude as a stablecoin-native USD business account for companies to save, earn, and move dollars. Their announcement says Altitude offers global USD access, ACH/Wire/SEPA/stablecoin transfers in 100+ countries, yield/rewards, approval workflows, team permissions, multiple business lines, tokenized asset trading, spend management, invoice tracking, and more.

Their CFO Stack announcement is even more relevant. It says Altitude is combining:

- invoicing
- bill pay
- accounting workflows
- payments
- yield
- approval workflows
- team controls

### Invoicing

Altitude’s invoicing workflow includes:

- invoice creation
- pre-filled recipient details
- PDF export
- sending invoices from Altitude
- recipient payment interface
- stablecoin or bank-transfer payment collection
- invoice status and due-date tracking

This is upstream of Axoria. Axoria currently starts at “create/import payment request.” Altitude starts from the finance artifact.

### Bill Pay

Altitude’s bill pay workflow includes:

- manual bill entry
- file upload
- email forwarding
- automatic extraction of payment details
- payment-date tracking and notifications
- batching bills for grouped payments
- vendor whitelist
- payment through wire, ACH, SEPA, or stablecoins
- approval routing by vendor, amount, and payment details
- risk checks
- discrepancy and duplicate flags

This is the product shape Axoria has been circling around. Axoria has CSV import, payment runs, policies, signatures, reconciliation, exceptions, and proof. But Axoria does not yet have bill intake, vendor workflows, bill documents, email forwarding, accounting-ready metadata, or fiat rails.

### Accounting

Altitude says accounting is available today and includes:

- attaching receipts or invoices to entries
- internal notes and memos
- CSV exports formatted for QuickBooks and similar tools

Axoria has proof packets, audit timelines, and Markdown/JSON proof exports. That is valuable, but it is not yet a finance/accounting workflow. Finance users usually need export-ready line items, categories, vendors, references, attachments, tax/accounting fields, and month-end close workflows.

### Rails and Partners

Altitude’s own disclaimer is important. It says Altitude is not a bank or financial institution and enables eligible businesses to establish a self-custodied digital asset account. It also says Altitude partners with Bridge Building Inc. to enable certain stablecoin transactions, and those services are provided directly by Bridge under Bridge’s terms.

This is the answer to “is it just code?”

No. Altitude is using:

- Squads Protocol / Squads Multisig as the security and account foundation
- Bridge for some regulated stablecoin transaction services
- likely other provider relationships for fiat rails, cards, compliance, and yield access
- legal disclaimers and terms to make clear what it is and is not
- sales/distribution into stablecoin-native businesses

That is not something Axoria can clone just by writing more TypeScript.

### Altitude’s Real Moat

Altitude’s moat is:

- stablecoin-native business account positioning
- Squads’ existing customer base and trust
- custody/security foundation through Squads Protocol
- fiat/stablecoin partner rails
- CFO workflows around bills, invoices, accounting, team controls, yield
- regulatory/legal structuring
- investor backing and distribution
- active sales motion into crypto-native businesses

Altitude is closer to a future stablecoin business bank replacement. Axoria is currently a payment workflow and proof engine.

## Axoria Today

Based on the current repository docs, Axoria does:

- manual payment requests
- CSV payment request import
- payment runs for batches
- payment orders as control-plane objects
- treasury wallets and balances
- destinations and trust states
- counterparties as grouping context
- approval policy evaluation
- approval decisions
- execution packet preparation
- browser-wallet signing
- submitted signature recording
- Yellowstone observation of Solana
- USDC movement reconstruction
- relevant transfer filtering
- signature-first matching
- FIFO-style matching fallback
- partial/split/exact/overfill matching behavior
- exceptions
- proof packets with deterministic digests
- human-readable proof export
- API and OpenAPI surface
- institutional-grade frontend in progress

This is meaningful. It is not fluff. But it is not yet a full treasury product.

### Axoria’s Strongest Differentiator

Axoria’s best wedge is:

```text
Stablecoin payment proof and reconciliation for Solana USDC workflows.
```

More specifically:

```text
Start from a payment request or batch, control approval and execution handoff,
observe settlement on Solana, reconcile it deterministically, and export proof.
```

This is much narrower than Altitude and Range, but it is defensible for an MVP.

### What Axoria Does Not Yet Have

Axoria does not yet have:

- real vendor / payable / bill object with attachments
- invoice ingestion
- email forwarding
- OCR or payment-detail extraction
- bank-transfer collection or payouts
- ACH/Wire/SEPA rails
- cards
- yield
- compliance screening
- sanctions checks
- address risk scoring
- production-grade roles and permissions
- enterprise auth
- org invites
- accounting exports that map cleanly into QuickBooks/Xero
- deep Squads/multisig proposal generation
- customer onboarding and support workflow
- legal terms / compliance posture
- design partners proving daily usage

## Is the Gap Just Development?

No. The gap has four parts.

### 1. Code/Product Gap

This is the part Axoria can directly build.

Needed:

- Payees/vendors as first-class objects.
- Bill/payable object with reference, amount, due date, destination, source wallet, attachment, approval status, settlement status.
- Better batch workflow for payroll/vendor/grant payout lists.
- Proof packets that read like finance receipts, not developer JSON.
- Accounting exports with vendor/reference/category/memo/tx/signature/status columns.
- Squads proposal generation.
- Better execution lifecycle and retry handling.
- Better reconciliation state machine.
- Clear exception resolution flows.
- Role-based permissions.
- Production auth.

This is hard but tractable.

### 2. Data/Compliance Gap

This is where Range is strong.

Needed:

- sanctions screening
- blacklist checks
- destination risk scoring
- address poisoning detection
- counterparty history checks
- payment risk classification
- compliance logs

Axoria should probably not build this from scratch. It should integrate a provider such as Range, TRM, Chainalysis, Elliptic, or similar when the product reaches compliance-sensitive customers.

### 3. Rails/Partner Gap

This is where Altitude is strong.

Needed for a business-account-level product:

- ACH/Wire/SEPA transfers
- stablecoin on/off ramps
- virtual accounts
- bank-transfer collection
- cards
- fiat payouts
- regulated stablecoin orchestration
- custody or self-custody provider integration
- compliance provider integration

Axoria should not become a bank. It should choose one of these:

- stay Solana-native and self-custodial
- integrate Squads for multisig execution
- integrate Bridge/Crossmint/other providers later for fiat and stablecoin orchestration
- integrate Range for risk/compliance

### 4. Trust/GTM Gap

This is the hardest part.

Altitude and Range have market trust because they have:

- known teams
- institutional backers
- customer logos
- provider partnerships
- legal terms
- product documentation
- sales motion
- customer support
- reliability posture

Axoria currently has code. It needs real users to discover whether the workflow matters.

## Competitive Positioning

### Against Range

Axoria should not position directly against Range.

Range is:

```text
Risk/compliance/intelligence infrastructure for stablecoin systems.
```

Axoria is:

```text
Payment workflow and reconciliation proof for Solana USDC operations.
```

Range could become a provider inside Axoria. For example:

```text
Before approving payment:
  call Range Payment Risk Assessment
  store risk result
  show reason in approval policy
  include risk result in proof packet
```

That would make Axoria more credible without requiring years of risk-data infrastructure.

### Against Altitude

Altitude is closer to a future competitor if Axoria becomes a full stablecoin CFO stack.

Altitude is:

```text
Stablecoin-native business account: account, payments, bills, invoices, accounting, yield, cards.
```

Axoria is currently:

```text
Stablecoin payment control + reconciliation + proof engine.
```

To compete with Altitude, Axoria would need much more than reconciliation:

- business account abstraction
- spend / pay / receive / earn loops
- invoice and bill workflows
- fiat rails
- cards
- partner network
- polished onboarding
- compliance and legal posture

Axoria should not try to match all of that now. The better wedge is to become deeper and more reliable in a narrow workflow:

```text
Batch payouts on Solana with deterministic proof.
```

Examples:

- DAO contributor payouts.
- Solana startup contractor payouts.
- Grant distributions.
- Vendor payouts from a Squads treasury.
- Payroll-like payout lists where legal payroll compliance is outside Axoria.

## What It Takes To Get Where They Are

### What More Code Can Solve

Code can solve:

- better data model
- stronger frontend workflow
- Squads proposal generation
- better proof artifacts
- better reconciliation edge cases
- production-ready API
- role-based access
- vendor/payable/payee workflows
- accounting export formats
- operational dashboards
- exception resolution workflows

This is the next engineering path.

### What Code Alone Cannot Solve

Code alone cannot solve:

- compliance credibility
- sanctions/risk datasets
- ACH/Wire/SEPA access
- card programs
- fiat custody / virtual accounts
- legal terms
- customer trust
- sales pipeline
- regulated partner agreements
- institutional procurement
- ongoing support

This is why Range and Altitude feel far ahead. They combine software with infrastructure relationships.

## What Axoria Should Build Next

### Phase 1: Become Excellent At Solana Batch Payout Proof

Goal:

```text
Given a payout CSV, Axoria can create, approve, sign, observe, reconcile, and export proof for every row.
```

Build:

- payment run UX polish
- one-click Squads proposal generation
- stronger browser-wallet batch signing UX
- retry / replaced transaction handling
- clear batch partial failure handling
- final run proof packet that finance users can read
- export with payment rows, signatures, matched amounts, and exceptions

Why:

This is the closest path to a product that feels real without needing fiat rails.

### Phase 2: Add Vendor/Payable Layer

Goal:

```text
Users start with "pay this vendor for this reason," not "create a payment order."
```

Build:

- Payee / Vendor object.
- Payable object with amount, due date, reference, source wallet, destination, attachment.
- Attach invoice/receipt files.
- Duplicate payable detection.
- Approval policy by vendor, amount, trust state, due date.
- Payable-to-payment-run conversion.

Do not overbuild OCR yet. Manual upload + structured fields is enough.

### Phase 3: Accounting-Ready Outputs

Goal:

```text
Axoria proofs can help close books, not just prove a transaction happened.
```

Build:

- QuickBooks-style CSV export.
- GL category fields.
- vendor/reference/memo fields.
- payment proof summary PDF/Markdown.
- attachment bundle.
- month-end export by workspace/date range.

This converts verification into something finance teams understand.

### Phase 4: Provider Integrations

Goal:

```text
Axoria becomes more credible by plugging into mature infra instead of rebuilding everything.
```

Likely integrations:

- Squads for multisig proposal generation.
- Range for destination/payment risk.
- Bridge/Crossmint/other stablecoin orchestration provider for fiat rails later.
- QuickBooks/Xero export or API sync.

### Phase 5: Production Trust

Goal:

```text
A real team can safely use Axoria.
```

Build:

- production auth
- org invites
- roles and permissions
- audit log hardening
- encrypted secrets
- deployment and backups
- user onboarding
- support/error reporting
- legal/terms positioning

## What Not To Build Yet

Do not build:

- full payroll compliance
- tax withholding
- global contractor compliance
- card issuing
- ACH/Wire/SEPA rails directly
- your own sanctions database
- your own risk ML system
- fiat custody
- AI autopay without strong controls

These are company-scale bets. Build the Solana-native proof/control wedge first.

## Brutal Scorecard

| Category | Axoria Today | Range | Altitude | Notes |
|---|---:|---:|---:|---|
| Stablecoin reconciliation | 7/10 | 8/10 | 6/10 | Axoria is genuinely strong on Solana-specific matching/proof. |
| Business workflow inputs | 4/10 | 5/10 | 9/10 | Altitude starts from bills/invoices/accounts. Axoria starts from manual/CSV payment requests. |
| Execution ownership | 4/10 | 8/10 | 8/10 | Axoria prepares/signs with browser wallet, but lacks mature multisig/rails orchestration. |
| Fiat rails | 0/10 | 5/10 | 9/10 | Altitude has ACH/Wire/SEPA claims through partners. Axoria has none. |
| Risk/compliance | 1/10 | 10/10 | 6/10 | Range dominates this category. |
| Accounting workflow | 3/10 | 5/10 | 8/10 | Axoria proofs are not yet accounting-grade workflows. |
| Proof/audit artifact | 7/10 | 8/10 | 6/10 | Axoria can be strong here if proofs become user-facing and compact. |
| UX maturity | 4/10 | 7/10 | 9/10 | Axoria frontend has improved, but workflow maturity is still early. |
| Trust/distribution | 1/10 | 9/10 | 8/10 | Axoria needs design partners and real usage. |

Overall: Axoria is not a 3/10 technically. It is more like:

```text
Technical reconciliation core: 7/10
Full treasury/business-account product: 3/10
Market trust/readiness: 1-2/10
```

That distinction matters. The engine is real; the company/product layer is early.

## Recommended Thesis

Do not pitch Axoria as “Altitude but smaller.”

Pitch it as:

```text
Axoria is the Solana-native payment control and proof layer for stablecoin payouts.
Teams import payout intent, route approvals, execute through wallet/multisig workflows,
observe settlement in real time, reconcile every row, and export verifiable proof.
```

That is credible, narrow, and aligned with what the current system actually does.

## Recommended Next Build Decision

The next high-leverage build is not fiat integration. It is:

```text
Squads proposal generation + vendor/payable object + accounting-grade proof export.
```

Why:

- Squads proposal generation makes execution feel real for crypto-native teams.
- Vendor/payable object makes the input layer less abstract.
- Accounting-grade proof export makes Axoria valuable after payment, not just during payment.

After that, evaluate whether to integrate Range for risk scoring or Bridge/Crossmint for fiat rails.

## Source Links

- Range homepage: https://www.range.org/
- Range docs: https://docs.range.org/introduction/about-range
- Range Risk API overview: https://docs.range.org/risk-api/risk-introduction
- Range risk score methodology: https://docs.range.org/risk-api/product-info/understanding-risk-scores
- Range Payment Risk Assessment: https://docs.range.org/risk-api/risk/get-payment-risk-assessment
- Range Faraday API: https://docs.range.org/faraday-api/introduction
- Range Faraday announcement: https://www.range.org/blog/faraday-the-transaction-engine-for-safe-scalable-and-compliant-stablecoin-payments
- Squads Altitude announcement: https://squads.xyz/blog/introducing-altitude-and-a-strategic-investment-from-haun-ventures
- Squads CFO Stack / Altitude: https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude
- Squads jobs page describing Altitude traction: https://jobs.solana.com/companies/squads-2-f6fb25b1-e381-4b5c-ae8c-7d8b128601ff/jobs/68031576-account-executive
- Bridge overview: https://www.bridge.xyz/
- Bridge Orchestration: https://www.withbridge.com/product/orchestration
- Bridge API docs: https://apidocs.bridge.xyz/platform
- Modern Treasury reconciliation docs: https://docs.moderntreasury.com/reconciliation/docs/overview
- Modern Treasury ledgers: https://www.moderntreasury.com/products/ledgers


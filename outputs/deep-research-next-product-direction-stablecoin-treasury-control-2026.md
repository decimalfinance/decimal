# Deep Research: Next Product Direction After Stablecoin Reconciliation

Date: 2026-04-11

## Executive Summary

The product we have built is not fluff, but it is incomplete as a standalone company wedge.

It is strongest at the middle of the finance workflow:

- expected transfer creation
- destination trust and counterparty context
- approval policy
- execution records
- onchain observation
- matching / reconciliation
- exception ops
- audit / export evidence

That is a real control layer. The market gap is that finance teams do not wake up wanting to create an "expected transfer." They wake up with a business obligation:

- pay this invoice
- run this payroll batch
- settle this contractor payout
- move treasury funds before a due date
- prove later who approved it and what happened

The market research now points to one clear conclusion:

The next product layer should be a business-intent and treasury-control layer on top of our reconciliation engine, not more generic blockchain monitoring.

The strongest next wedge is:

> Stablecoin AP and treasury control for Solana-native teams: ingest bills/payroll/vendor payouts, approve them, execute from owned wallets or Squads/Grid-style accounts, reconcile automatically, and export audit/accounting evidence.

The product should move from:

> "Expect 50k USDC to arrive at wallet X."

to:

> "Pay Vendor X $50k for Invoice #1234 from Treasury Wallet A, under policy P, through transaction T, with evidence E, and close it in accounting."

## The Three-Layer Stack

The user's framing is correct:

1. Business intent: "Pay Vendor X $50k for Invoice #1234."
2. Control / reconciliation: "Expect 50k USDC to a known destination, approve, track, reconcile."
3. Execution: "Sign, broadcast, retry, batch, and record what happened."

We have built layer 2 well.

The reason the product still feels unfinished is that layer 2 is not usually the buyer-facing object. It is the internal control fabric underneath the object the operator actually cares about.

The product becomes meaningful when layer 2 is attached to layer 1 or layer 3:

- Attached to layer 1, it becomes stablecoin AP, payroll, vendor payouts, or receivables reconciliation.
- Attached to layer 3, it becomes treasury execution control and transaction assurance.
- Attached to both, it becomes a full stablecoin finance ops product.

## What Remlo Is Actually Building

Remlo's public docs describe "borderless enterprise payroll on Tempo L1," not just a money-transfer UI.

Their documented architecture has these layers:

- employer deposits funds into a Bridge virtual account
- Bridge mints stablecoin into an employer PayrollTreasury contract
- PayrollTreasury holds employer funds and gas budget
- PayrollBatcher executes a payroll run to employee wallets
- employee wallets can spend through Bridge Visa cards or off-ramp to local banks
- TIP-20 memos and TIP-403 compliance checks provide payroll metadata and screening
- APIs and agent endpoints expose payroll execution, compliance checks, off-ramp, memo decode, salary stream, treasury optimization, and payment history

Sources:

- Remlo docs introduction: https://docs.remlo.xyz/docs
- Remlo docs architecture: https://docs.remlo.xyz/docs/architecture
- Remlo docs full index: https://docs.remlo.xyz/llms-full.txt
- Remlo homepage: https://remlo.xyz

This explains why the product is more than "send USDC." The hard parts are:

- employer KYB and bank funding
- employee onboarding
- payout destination governance
- payroll run object
- batch execution
- employee off-ramp/card experience
- compliance screening
- payroll evidence and history
- agent/API-controlled execution

That does not mean every Remlo claim should be taken at face value. The public site is very marketing-heavy, and some docs mention Tempo, Bridge, TIP-20, TIP-403, AgentCash, Lit PKP signing, and MPP/X402-style paid API flows that may be hackathon/prototype surfaces rather than fully production-proven rails. Treat Remlo as a useful product map, not as proof that all pieces are commercially mature.

One correction: I found Colosseum's Solana Breakout Hackathon post listing Remlo as a Stablecoins Track honorable mention, not as a prize winner. That is still a positive signal, but it is weaker than "they won Colosseum."

Source:

- Colosseum Breakout winners / honorable mentions: https://blog.colosseum.com/announcing-the-winners-of-the-solana-breakout-hackathon/

## Why Remlo Is Not Actually Trivial

The act of sending payroll stablecoins is easy.

The product is not easy because payroll is not just sending money. A finance-grade payroll flow needs:

- worker eligibility and jurisdiction scope
- gross-to-net calculation outside the stablecoin rail
- approval boundaries
- payout destination change control
- proof of execution
- reconciliation from payroll register to payout
- reporting artifacts
- audit-ready evidence

Toku's stablecoin payroll guide makes this explicit: stablecoin payroll is a settlement method inside payroll operations, not a replacement for payroll controls. It argues that if a stablecoin payout cannot be tied back to the payroll register and audit evidence, it is not finance-grade payroll.

Source:

- Toku stablecoin payroll guide: https://www.toku.com/resources/what-is-stablecoin-payroll-cfo-guide

This is very relevant to our product. We already built a lot of the "evidence layer" Remlo/Toku-style payroll needs:

- destination governance
- approvals
- execution records
- chain observation
- matching
- exceptions
- audit/export

What we do not have is the payroll object:

- employee / contractor roster
- pay period
- gross/net payload
- payroll batch
- payroll register import
- jurisdiction/compliance fields
- employee payout preference and destination change workflow

So payroll is possible, but it is a narrower and more compliance-heavy product than AP/vendor payments.

## What Altitude Is Signaling

Altitude's strongest signal is not "AI can decide who to pay."

The stronger signal is:

> AI can help with finance only when policy, accounts, and settlement live close enough together for deterministic execution.

In "Intelligence in Motion: Agentic Finance at Altitude," Squads/Altitude argues that finance agents are currently co-pilots because they can analyze but cannot safely execute payments and treasury workflows. Their solution is deterministic execution over Solana, stablecoins, and Grid.

The concrete workflows they name are:

- agentic bill pay that checks vendor identity, amount, and policy criteria
- scheduled payments approved and executed on a date
- treasury actions that allocate idle cash and withdraw before obligations are due
- automated swaps and FX transfers based on thresholds and obligations
- behavior-aware workflows that execute within policy limits

Source:

- Squads / Altitude agentic finance article: https://squads.xyz/blog/intelligence-in-motion-agentic-finance-at-altitude

This is close to what we should build next, but with a sharper MVP:

Do not start with "AI decides everything." Start with deterministic policy and evidence, then add AI as an assistive intake/review layer.

The safe version is:

- AI extracts invoice data
- AI flags duplicate/vendor/amount anomalies
- policy decides whether approval is required
- humans approve when needed
- execution is deterministic and bounded
- reconciliation proves what happened

## What Market Leaders Are Actually Selling

The earlier report already covered Altitude, Ramp, Brex, Rho, and Modern Treasury. The important repeated pattern is:

They do not sell "transaction tracking."

They sell end-to-end money operations:

- intake
- approval
- payment
- reconciliation
- evidence
- export / accounting sync

Altitude Bill Pay is the closest stablecoin-native reference. It focuses on:

- upload or forward bills
- auto-populate details
- approve and send over stablecoins or fiat rails
- batch payouts
- keep one ledger from bill to paid

Source:

- Altitude Bill Pay: https://squads.xyz/blog/introducing-altitude-bill-pay

Altitude CFO Stack goes further:

- invoicing
- bill pay inbox
- automatic extraction
- approval policies by vendor/amount/payment details
- duplicate/discrepancy flagging
- accounting exports

Source:

- Altitude CFO Stack: https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude

Coinshift's older treasury management positioning is also useful because it shows a crypto-native treasury pattern:

- shared contacts and labels across safes
- propose and approve transactions
- real-time treasury visibility across accounts/chains
- CSV export with filters by labels, token, date, Safe, network

Source:

- Coinshift treasury workflow case study: https://blog.coinshift.xyz/how-biconomy-manages-their-treasury-with-coinshift

The lesson is simple:

The backend core we built should be wrapped around the finance object: invoice, payroll run, vendor payout, treasury transfer, or account movement.

## Solana-Native Treasury Control: What It Should Look Like

A Solana-native treasury control product should not look like a bank dashboard with a blockchain explorer embedded inside it.

It should make these first-class:

- owned source wallets / smart accounts
- treasury balances
- destination registry
- counterparty registry
- approval policies
- payment intents
- transaction proposals
- batch execution
- signature collection or delegated policy signing
- observed settlement
- reconciliation
- exceptions
- audit/export packages

If built against Squads/Grid-style smart accounts, the execution layer could support:

- proposal creation
- scheduled payments
- policy-bound auto-execution for trusted destinations below thresholds
- batch transfers
- source-of-funds selection
- swap/FX/rebalance actions
- evidence export that links business intent -> proposal -> signature -> onchain tx -> reconciliation result

This is where our current product becomes more valuable. We already know how to watch and reconcile settlement. The missing layer is controlled source-side execution.

## Strategic Options

### Option 1: Stablecoin AP / Bill Pay

This is the best next wedge.

Build:

- vendors
- bills / invoices
- file attachment or email-forwarding inbox later
- invoice number, due date, memo, category, amount, token, destination
- duplicate checks
- approval policy
- expected transfer generation from bill approval
- execution record
- reconciliation
- audit/export bundle

Why it is attractive:

- It connects directly to a business obligation.
- It avoids payroll's harder employment/tax jurisdiction complexity.
- It uses almost everything we already built.
- It makes reconciliation feel necessary rather than abstract.
- It matches Altitude/Ramp/Brex market behavior.

Main risk:

- If we do not add source-side execution soon after, it can still feel like "bill planning plus reconciliation" rather than actual bill pay.

Recommended MVP:

- Manual bill creation with optional PDF attachment.
- Vendor/destination selection.
- Duplicate invoice check by vendor + invoice number + amount.
- Policy decision.
- Create expected transfer.
- Attach execution signature manually or through a basic wallet/Squads proposal integration.
- Auto-reconcile.
- Export bill packet as JSON/CSV/PDF-like evidence.

### Option 2: Stablecoin Payroll / Mass Payouts

Build:

- worker roster
- payout destination governance
- payroll run object
- CSV import
- approval policy for payroll run and destination changes
- batch expected transfers
- execution record per batch
- reconciliation per worker payout
- exception report for missing/partial payouts

Why it is attractive:

- Clear use case.
- Easy demo.
- Strong connection to Remlo, Request Finance, Toku-style workflows.
- Batch matching and exception ops become useful immediately.

Why it is risky:

- Payroll compliance is much heavier than vendor AP.
- Gross-to-net payroll calculation is not our edge.
- If we ignore jurisdiction/tax, it becomes "bulk payouts" rather than payroll.

Recommended version if we choose this:

- Do not call it full payroll at first.
- Call it "contractor and team stablecoin payouts."
- Let external payroll/HR tools remain the system of record.
- Import a payroll register CSV.
- Reconcile payout execution against the imported register.

This fits Toku's advice that stablecoin payroll should preserve existing payroll systems of record.

### Option 3: Treasury Execution Control

Build:

- owned wallet registry
- balance watcher
- funding/insufficient balance warnings
- source-of-funds selection
- execution proposal records
- transaction builder
- batch transfer builder
- Squads/Grid integration later
- automatic retry/error classification
- execution-to-reconciliation closure

Why it is attractive:

- It directly fixes the "we are not controlling our own money" feeling.
- It makes the product treasury-centric rather than destination-centric.
- It is differentiated on Solana if integrated with smart accounts and Yellowstone observation.

Why it is risky:

- Execution touches private keys / signing / smart account policies, which raises security burden.
- If built without AP/payroll objects, it can become a generic transaction console.

Recommended version:

- Start with Squads proposal or wallet-adapter transaction creation rather than custody.
- Keep private-key custody out of scope.
- Use our backend as the system of record for policy, intent, execution records, and reconciliation.

### Option 4: Accounting / Ledger Layer

Build:

- ledger accounts
- journal-like entries generated from approved/executed/reconciled payments
- GL codes
- export templates
- monthly close reports
- QuickBooks/Xero-style export later

Why it is attractive:

- Finance teams care about books and exports.
- It makes audit/export much stronger.
- It creates defensibility around system-of-record behavior.

Why it is risky:

- It is less demo-friendly.
- It is easy to overbuild accounting primitives before product-market clarity.

Recommended version:

- Start with export schemas and required accounting metadata on bills/payments.
- Do not build a full ledger yet unless customer discovery proves that need.

## Recommended Product Roadmap

### Phase F: Business Intent Layer

Goal:

Turn expected transfers into business obligations.

Implement:

- `vendors` as a clearer business-facing wrapper around counterparties
- `bills` with invoice number, vendor, amount, due date, memo, attachment URL/path, destination, status
- `payment_intents` generated from approved bills
- duplicate checks by vendor + invoice number + amount + destination
- bill approval policy hooks
- bill timeline
- bill-to-request-to-execution-to-reconciliation linkage
- bill audit export

Do not build:

- AI auto-pay yet
- full ERP sync yet
- full document OCR yet

Why:

This gives the product a reason to exist beyond blockchain tracking.

### Phase G: Treasury Execution Layer

Goal:

Make the product control outgoing money, not just observe settlement.

Implement:

- owned treasury accounts and balances
- source wallet selection
- insufficient balance warnings
- execution proposal records
- wallet-adapter transfer generation or Squads proposal integration
- batch execution records
- execution error categories
- execution-to-reconciliation closure

Do not build:

- raw private-key custody
- automatic unrestricted signing
- broad DeFi/yield routing

Why:

This makes the product a treasury control plane.

### Phase H: Accounting Evidence Layer

Goal:

Make outputs useful at month-end and during audit.

Implement:

- GL/category fields
- export templates
- bill/payment/reconciliation packet export
- exception export
- accounting review states
- evidence completeness checks

Do not build:

- full double-entry ledger unless customer validation demands it

Why:

This is what turns "we paid it" into "finance can close the books."

### Phase I: Assistive AI Layer

Goal:

Add AI where it reduces operator work without compromising deterministic money movement.

Implement:

- invoice field extraction
- duplicate/anomaly detection
- vendor/destination trust warnings
- suggested approval reason summaries
- "why is this blocked?" explanations
- policy simulation

Do not build:

- AI autonomous payment execution before deterministic guardrails and source-side execution are mature

Why:

Altitude's AI thesis is compelling, but the safe implementation is AI for interpretation and review, deterministic systems for money movement.

## Product Thesis Going Forward

The cleanest thesis is:

> A stablecoin-native treasury control layer that turns business obligations into controlled, executed, reconciled, and export-ready payments.

Short version:

> AP + treasury execution + reconciliation for stablecoin teams.

This is meaningfully different from the current product:

- Current: "We know whether expected settlement happened."
- Next: "We know why money should move, whether it is allowed, how it moved, whether it settled, and how to prove/export it."

## What To Build Next

Build Phase F first: business intent through bills/vendor payables.

The first MVP should support this workflow:

1. Create vendor.
2. Attach or manually enter invoice.
3. Select destination.
4. Run policy.
5. Approve if needed.
6. Generate expected transfer.
7. Create/attach execution.
8. Observe settlement.
9. Auto-reconcile.
10. Export audit packet.

This is the smallest next layer that makes the product feel less like a monitoring tool and more like a finance ops product.

If Phase F feels good, Phase G should follow immediately:

1. owned treasury account
2. balance
3. source wallet
4. transaction/proposal creation
5. execution status
6. reconciliation

That gives us the full loop:

> invoice -> approval -> source wallet -> execution -> settlement -> reconciliation -> export

## Final Recommendation

Do not pivot away from what we built.

Use it as the core.

The product should not become a generic payroll clone or a generic bill-pay clone. The differentiation is:

- Solana-native observation
- strong reconciliation
- exception ops
- deterministic policy
- destination/counterparty trust
- eventual smart-account execution
- audit/export evidence

The next build should be:

- first, bill/vendor payable intent
- second, treasury/source-side execution
- third, accounting/export depth
- fourth, AI review/automation

That is how the current reconciliation core becomes a product finance teams can understand and buy.

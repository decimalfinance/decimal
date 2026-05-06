# Solana AI CFO MVP Plan

Date: 2026-05-05

## One-Line Thesis

Build the AI-native finance operations layer for Solana-native teams: turn invoices, vendor requests, and treasury context into reviewed USDC payment batches from a Squads-controlled treasury.

Do **not** build Bridge. Use Bridge later for fiat on/off-ramp.
Do **not** clone Altitude. Learn from Altitude, but build the workflow intelligence layer above stablecoin accounts.
Do **not** start with cards, payroll compliance, or a full neobank.

## Product Positioning

Best short pitch:

> Monk for stablecoin-native businesses, starting with Solana treasuries.

More precise:

> An AI finance ops copilot for Solana teams that reads invoices, builds payment queues, flags risks, creates Squads payment proposals, and generates weekly cash reports.

## Target Customer

Start with teams that already have:

- USDC treasury on Solana
- Squads multisig or willingness to use Squads
- global contractors/vendors
- invoices in Gmail, Slack, Google Drive, Notion, or PDFs
- manual payment operations
- no mature finance team

Best early users:

- Solana hackathon teams
- small protocols
- Solana agencies
- stablecoin/payment startups
- infra/tooling teams
- DAOs with recurring contributors

Avoid first:

- non-crypto businesses that need banking education
- companies needing full payroll compliance
- companies needing ACH/wire/SEPA on day one
- enterprises requiring SOC2, ERP depth, procurement portals, or legal review

## Core MVP

One painful workflow end-to-end:

> Turn invoices/payment requests into approved USDC payouts from a Squads treasury.

Happy path:

```text
1. User connects a Squads treasury.
2. User uploads invoices or forwards invoice emails.
3. AI extracts vendor, amount, due date, wallet address, memo, and category.
4. App creates a reviewable payment queue.
5. User reviews and approves a suggested batch.
6. App creates a Squads transaction proposal for USDC transfers.
7. Squads signers approve.
8. Payment executes on Solana.
9. App marks invoices as paid.
10. App generates weekly cash report.
```

## MVP Demo

The grant/demo flow should be:

```text
Upload 5 invoices
→ AI extracts payment details
→ app flags one duplicate invoice
→ app flags one changed vendor wallet address
→ app suggests a 3-4 payment USDC batch
→ user creates Squads proposal
→ approvals happen
→ payments execute
→ dashboard updates paid/pending status
→ weekly CFO report generated
```

This is enough for a Solana Foundation / Superteam grant demo.

## V1 Feature Set

### 1. Treasury Dashboard

Required:

- connected Squads treasury address
- USDC balance
- pending payment total
- due-this-week total
- overdue total
- recent payments
- simple runway estimate

Nice later:

- multi-wallet support
- multi-token support
- projected runway by category
- yield allocation recommendations

### 2. Invoice Inbox

Required:

- upload PDF/image invoice
- manually paste invoice text
- mark invoice status: draft, needs review, ready, proposed, paid, rejected
- store original document

Next:

- Gmail forwarding inbox
- Slack request intake
- Google Drive sync
- Notion/Airtable import

### 3. AI Extraction

Required extracted fields:

- vendor name
- amount
- currency
- due date
- invoice number
- wallet address, if present
- bank details, if present
- memo / description
- expense category
- confidence score
- missing fields

AI should never auto-pay in V1. It should create a review draft.

### 4. Vendor Directory

Required:

- vendor name
- primary wallet address
- previous wallet addresses
- payment history
- category
- notes

Risk flags:

- first-time vendor
- changed wallet address
- duplicate invoice number
- same amount/vendor/date as another invoice
- suspiciously large payment vs historical average

### 5. Payment Queue

Required:

- due this week
- overdue
- ready for proposal
- blocked / missing info
- selected for batch

Actions:

- approve invoice for payment
- reject invoice
- ask AI to summarize invoice
- create payment batch

### 6. Squads Proposal Creation

Required:

- create USDC transfer transaction(s)
- support single payment first
- support simple batch if Squads integration makes it practical
- deep link to Squads proposal if easier than in-app approvals
- store proposal id / transaction signature

Implementation options:

1. Fastest: generate transaction instructions and open Squads proposal/deep link.
2. Better: integrate Squads SDK directly and create proposal from app.
3. Alternative: use Grid if self-serve access supports required proposal creation.

### 7. Weekly CFO Report

Required:

- starting USDC balance
- payments made this week
- invoices pending
- invoices overdue
- largest upcoming payments
- runway impact
- risk/anomaly summary

Output:

- in-app markdown report
- copy to Slack/email manually

## What AI Does In V1

Use AI for practical workflow help:

- parse invoice PDFs/emails
- extract structured fields
- detect duplicates
- detect changed vendor wallet address
- categorize expenses
- summarize payment obligations
- recommend payment batch
- explain cash impact
- generate weekly CFO report

Do **not** start with vague "AI insights."
Do **not** allow fully autonomous payments in V1.

## Technical Architecture

Suggested MVP stack:

```text
Frontend: Next.js / React
Backend: Node.js / TypeScript
DB: Postgres
Auth: Clerk, Privy, or simple email auth
Storage: S3/R2/Supabase Storage for invoices
AI: OpenAI or Anthropic for extraction + report generation
Solana: @solana/web3.js + Squads SDK / Grid
Payments: SPL USDC transfers from Squads treasury
```

Core data model:

```text
Organization
User
TreasuryAccount
Vendor
Invoice
InvoiceExtraction
Payment
PaymentBatch
SquadsProposal
RiskFlag
WeeklyReport
AuditLog
```

## Bridge / Fiat Rails

Do not include Bridge in V1 unless there is already access.

Bridge later handles:

- virtual USD accounts
- ACH/wire deposits
- fiat-to-USDC conversion
- USDC-to-fiat payouts
- KYB/compliance for fiat rails

Initial MVP can be stablecoin-only:

```text
USDC already in Squads treasury
→ AI payment workflow
→ USDC payouts on Solana
```

This avoids regulated complexity and gets to a useful product faster.

## Squads / Grid Decision

### Option A — Squads Direct

Pros:

- more control
- less vendor lock-in
- open-source protocol
- better long-term understanding

Cons:

- more engineering
- proposal creation/signing UX is harder
- need indexing/status tracking

### Option B — Grid

Pros:

- faster account/signer UX
- passkeys and embedded account management
- spending limits / smart accounts exposed as API
- eventually useful for fiat rails

Cons:

- vendor dependency
- serious fiat/KYB features are Enterprise-only
- public webhook/rate-limit gaps
- may be overkill for a first stablecoin-only treasury MVP

Recommended MVP choice:

Start with Squads direct or minimal Squads proposal/deep-link integration. Evaluate Grid in parallel. Use Grid only if it clearly reduces implementation time for proposal creation/signing.

## MVP Build Phases

### Phase 0 — Prototype

Goal: prove invoice-to-payment queue.

- create app shell
- connect wallet / org
- manually enter treasury address
- upload invoice
- AI extracts fields
- save invoice/payment draft
- show payment queue

### Phase 1 — Solana Payment Drafts

Goal: turn reviewed invoices into Solana transfer instructions.

- vendor wallet directory
- validate Solana addresses
- create USDC transfer instruction
- show transaction preview
- simulate transaction

### Phase 2 — Squads Integration

Goal: create real payment proposal from app.

- connect Squads treasury
- fetch members/threshold if available
- create proposal or deep link
- track proposal status manually or via polling
- update invoice status after execution

### Phase 3 — AI Risk + Reporting

Goal: make AI useful beyond extraction.

- duplicate invoice detection
- changed wallet detection
- unusual amount detection
- weekly CFO report
- payment recommendation summary

### Phase 4 — Early Users

Goal: get 3-5 Solana teams using it.

- onboard teams manually
- watch payment ops
- collect every manual workaround
- prioritize based on real repeated pain

## Grant Pitch

Why this deserves Solana / Superteam funding:

- increases real USDC usage on Solana
- improves operational UX for Solana startups
- builds on Squads, a core Solana primitive
- keeps custody non-custodial/programmatic
- applies AI to real financial workflows, not generic chat
- gives hackathon/protocol teams a usable finance ops tool

Suggested grant title:

> AI Finance Ops for Solana Stablecoin Treasuries

Suggested grant ask:

> Build an MVP that turns invoices into Squads-approved USDC payment batches, with AI extraction, risk flags, and weekly treasury reports.

## Key Research Questions Before Building Too Much

Ask early users:

- How do you currently pay contractors/vendors?
- Do you use Squads today?
- Who prepares payments?
- Who approves payments?
- Where do invoices arrive?
- What spreadsheet do you maintain?
- How often do you pay vendors?
- What mistakes have happened before?
- Would you trust AI to draft payments?
- Would you trust AI to recommend payment timing?
- What would block you from using this?
- What accounting tool do you use?
- Do you need fiat payouts or is USDC enough?
- Do you need payroll compliance or just contractor/vendor payments?

## What To Avoid

Avoid:

- building a bank
- building an on/off-ramp
- building cards
- building payroll compliance
- building a full accounting system
- trying to serve non-crypto companies first
- claiming autonomous CFO
- autonomous payments without human review
- multi-chain support before Solana PMF

## Success Criteria For MVP

MVP is successful if:

- 3 Solana teams connect a treasury
- each uploads at least 5 real invoices/payment requests
- app creates real reviewed payment drafts
- at least one team executes a Squads payment proposal generated from the app
- users say it replaces a real spreadsheet/manual workflow
- weekly CFO report is useful enough to send to founder/ops chat

## Core Bet

Stablecoin account infrastructure is becoming commoditized through Bridge, Squads/Grid, Privy/Turnkey, and similar primitives.

The differentiated product is not "a stablecoin account."

The differentiated product is:

> AI-native finance operations for teams already using stablecoin accounts.



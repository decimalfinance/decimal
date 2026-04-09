# Market Research: What Stablecoin Ops Customers Actually Need

Date: 2026-04-09

## Executive Summary

The main gap in our current product is real, not imagined.

We have built a strong `request -> approval -> execution tracking -> observed settlement -> reconciliation` layer.
That is useful, but it is not yet the whole job finance and operations teams buy.

The market signal from Altitude, Ramp, Brex, Rho, and Modern Treasury is consistent:

1. customers buy systems that reduce finance workflow fragmentation, not just systems that explain blockchain events
2. the primary user job is not “track a destination wallet”
3. the primary user job is “run money operations end to end with controls, evidence, and exports”

That means our product is currently strongest as:

- settlement assurance
- reconciliation
- execution/approval workflow for expected transfers

But the market leaders are packaging a broader control surface:

- bills / invoices as first-class objects
- payable workflow from intake to payment
- receipts / attachments / supporting evidence
- accounting categorization and ERP export
- treasury balances and source-of-funds view
- often a ledger or accounting-system-of-record layer

So the product is not fluff, but it is narrow relative to the wider “stablecoin finance ops” market.

## The Core Customer Job

The actual job is not:

- “watch a destination wallet and match transfers”

It is closer to:

- “take a business obligation, route it through approvals, execute it on the right rail, preserve evidence, keep books accurate, and export the result”

That job has several sub-jobs:

1. intake the thing that must be paid or collected
2. decide if it is allowed
3. choose the source of funds and rail
4. execute and track the payment
5. confirm what happened
6. preserve the evidence
7. sync/export the result into accounting and ops systems

Our product currently covers steps 2, 4, 5, and part of 6.
It is much weaker on steps 1, 3, and 7.

## What Altitude Is Actually Selling

Altitude’s homepage does not position itself as “blockchain tracking.” It positions itself as a business account + payments + CFO stack:

- business accounts in USD and EUR
- local rails + SWIFT + stablecoin transfers
- bill pay
- accounting exports
- treasury holdings
- FX conversion
- approvals and controls

Source:
- <https://altitude.xyz/>

Their `About` page is even clearer. They are building a “financial operating system” where:

- businesses own assets through self-custody
- settlement is instant through stablecoins
- software can operate the account with deterministic policies
- payments are triggered by ERP events
- integrations with accounting/reporting systems are explicitly part of the strategy

Source:
- <https://altitude.xyz/about-us>

The most important insight from Altitude is this:

They do not stop at payment visibility.
They move upstream into the business workflow that causes the payment, and downstream into accounting/reporting.

### Altitude Bill Pay

Altitude’s bill pay launch is highly informative.
They frame the problem as fragmented workflow:

- invoice arrives in email
- team manually re-enters it
- people ask if it has been paid
- month-end requires rebuilding the story from threads, spreadsheets, and screenshots

Their answer is:

- upload bills or use a forwarding inbox
- auto-populate details
- approve and send over stablecoins or fiat rails
- keep one end-to-end record from bill to paid
- batch payouts
- keep a “global ledger” for bill pay

Source:
- <https://squads.xyz/blog/introducing-altitude-bill-pay>

This is a direct signal that the buyer’s pain is workflow fragmentation, not just settlement uncertainty.

### Altitude CFO Stack

Altitude’s CFO Stack post makes the same point explicitly:

- stablecoins made settlement fast
- finance workflows stayed slow and fragmented
- teams still rely on separate tools for invoicing, bill pay approvals, and accounting documentation

Their stated product direction is:

- invoicing
- bill pay inbox
- automatic detail extraction
- approval policies by vendor/amount/payment details
- duplicate/discrepancy flagging
- accounting exports to QuickBooks and other tools

Source:
- <https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude>

This is the strongest evidence that our current destination-centric reconciliation layer is only part of the customer job.

## What The Broader Finance-Ops Market Is Selling

### Ramp

Ramp’s AP product is not sold as “payment tracking.”
It is sold as:

- OCR invoice capture
- approval orchestration
- PO matching
- vendor management
- payment execution across methods
- ERP sync
- exports
- AP aging reports
- bill/payment lifecycle views

Sources:
- <https://ramp.com/accounts-payable>
- <https://support.ramp.com/hc/en-us/articles/27579228841875-Managing-and-exporting-bills-on-Bill-Pay>
- <https://support.ramp.com/hc/en-us/articles/4418336469011-Bill-Pay-accounting>

Two especially important insights from Ramp:

1. they separate `bill` from `payment`
   - once a bill is approved, a payment object is created with its own lifecycle
2. they treat export and accounting sync as first-class product surfaces
   - not an afterthought

That maps closely to our own evolution:

- request != execution != observed settlement

But Ramp goes further by making the pre-payment business object (`bill`) first-class.

### Ramp Receipt Automation

Ramp also treats receipts/documentation capture as a major product area:

- capture from text/email/browser/integrations
- match receipt to transaction
- reduce finance review burden
- keep books audit-ready

Source:
- <https://ramp.com/receipt-automation>

That is another signal that evidence capture is part of the product, not just raw transaction visibility.

### Brex

Brex’s support docs show a similar pattern:

- bill pay turns invoices into payments
- ERP export is central
- required accounting fields must be filled before export
- accounting has prepare/review/export workflows
- exported history and templates matter

Sources:
- <https://www.brex.com/support/bill-pay>
- <https://www.brex.com/support/integration-exporting>
- <https://www.brex.com/support/brex-dashboard-accounting-page>

Brex is especially useful as a signal that “export-ready accounting workflow” is itself a product category.

### Modern Treasury

Modern Treasury is the clearest signal for what is still missing architecturally.

Their ledger product is framed as:

- one immutable system of record
- track balances and transactions
- real-time visibility
- account reconciliation
- auditability
- linking payment activity to the ledger

Sources:
- <https://www.moderntreasury.com/ledgers>
- <https://docs.moderntreasury.com/ledgers/docs>

This matters because our system today is mostly an operational workflow + reconciliation product.
It is not yet a canonical financial system of record.

That is the deeper reason the current product can feel “weird” or “soft”: it observes and organizes money movement, but it does not yet anchor around owned balances / obligations / ledger truth.

## What Our Product Currently Does Well

We should be honest about the real strengths:

- expected transfer creation
- destination-aware transfer intent
- policy and approvals
- execution tracking
- observation from Yellowstone / Solana
- deterministic matching
- request-level reconciliation
- increasingly usable operator surfaces

That means we have built a strong `assurance and reconciliation layer`.

This is not trivial.
It is a real product slice.

## Why It Still Feels Incomplete

The product still feels incomplete because it is mostly centered on “did this expected payment arrive?” rather than “run the business payment workflow end to end.”

The missing pieces fall into four buckets.

### 1. Intake Objects Are Missing

We do not yet have first-class:

- bills
- invoices
- receipts
- payable/receivable artifacts
- vendor documents / attachments

Requests exist, but they are much thinner than the real business objects used by finance teams.

### 2. Source-Side Treasury Is Missing

We do not yet make `our money` first-class enough.

What is missing:

- owned treasury/balance views
- source-of-funds selection
- clear “which wallet/account is paying?”
- liquidity / balance context
- treasury position

This is why the product can feel destination-centric instead of treasury-centric.

### 3. Accounting / Export Workflow Is Thin

We have a buildmap phase for export, but today the product is still much weaker than market leaders on:

- categorization / GL mapping
- required accounting fields
- export templates
- ERP sync logic
- accounting review workflow
- month-end close support

### 4. Canonical System-of-Record Layer Is Missing

We do not yet have a true ledger or equivalent accounting-grade system of record.

Without that, the product is strongest as:

- workflow
- evidence
- reconciliation

but weaker as:

- book-of-record
- treasury source of truth

## What This Means For The Buildmap

### Phase E Still Makes Sense

Phase E is still useful and still needed.
It is the phase that makes the current product trustworthy:

- exception queue
- unified audit timeline
- export
- ops health

Without it, the current product remains operationally incomplete.

### But Phase E Does Not Eliminate The Strategic Gap

Even if we complete Phase E perfectly, there will still be a gap between:

- a very strong stablecoin reconciliation / assurance / ops workflow product

and

- a full finance operating system / treasury operating system

So the correct interpretation is:

- Phase E completes the current thesis
- it does not automatically expand the thesis into a full Altitude/Ramp/Brex-like finance stack

## Strategic Options

There are two coherent paths.

### Option 1: Narrow And Win

Define the company as:

- stablecoin settlement assurance
- execution/reconciliation control layer
- audit + export layer for stablecoin ops

Then the current product is directionally correct.

To win here, we would need:

- deep exception ops
- strong audit/export
- excellent latency / reliability
- better source/destination linkage
- probably integrations into existing AP/ERP systems rather than replacing them

### Option 2: Expand Into Full Stablecoin Finance Ops

Define the company as:

- the operational finance stack for stablecoin-native businesses

Then after Phase E, a new roadmap phase is needed for:

- bills / invoice intake
- attachments and documentation
- payables / receivables workflow
- source-side treasury and balances
- accounting categorization / ERP workflow
- likely ledger / canonical record layer

This is meaningfully larger than the current roadmap.

## My Recommendation

Short term:

1. finish the current buildmap through Phase E
2. do not put “hardening” first inside Phase E
3. do exception queue, audit, and export before the deepest infra hardening pass

Medium term:

Run a thesis decision immediately after that:

- are we building a stablecoin reconciliation + assurance company?
- or a stablecoin-native CFO / treasury stack?

Right now the market research points to this:

- our current product has a sharper wedge as assurance/reconciliation than as a full CFO stack
- Altitude, Ramp, and Brex all win by sitting closer to the business object (`bill`, `invoice`, `expense`, `ledger`, `ERP export`) than we do today

So if we want to go broader, the next roadmap after Phase E should not be “more blockchain features.”
It should be:

- bills
- invoices
- attachments
- accounting/export workflows
- source-of-funds / treasury balance view
- ledger/system-of-record

## Bottom Line

The weirdness is not just subjective.

The product really is strong at one slice of the job:

- expected movement
- approvals
- execution tracking
- observed settlement
- reconciliation

But real finance-ops buyers are buying a broader workflow:

- intake
- control
- execution
- evidence
- accounting
- export
- system-of-record

That is the gap.

Our current roadmap can still produce a meaningful product.
But it will produce a `stablecoin operations reconciliation/control layer`, not automatically a full `stablecoin CFO stack`.

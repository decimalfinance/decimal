# Default chart-of-accounts taxonomies and GL-coding accuracy benchmarks

Research for Decimal's coding-inbox / auto-coding feature: what a sensible default category set looks like before a QBO connection exists, and how the AP-automation industry actually measures and talks about coding accuracy.

## A. Default chart-of-accounts / category taxonomies for SMBs

There is no single official "standard" chart of accounts — QuickBooks, IRS Schedule C, and various bookkeeping firms each publish their own variant — but they converge heavily on the same 20-30 line items for a services/software business. A few structural facts are consistent across sources:

**Five top-level buckets.** Every taxonomy (Ramp, Bill.com, Strategic CFO, Pacifica, SDO CPA) organizes accounts into Assets, Liabilities, Equity, Revenue, and Expenses, usually with a numbering convention like Assets 1000s, Liabilities 2000s, Equity 3000s, Revenue 4000s, COGS 5000s, Operating Expenses 6000-7999 (ramp.com/blog/chart-of-accounts, dualentry.com/blog/saas-chart-of-accounts). Expense account count for a lean seed-stage company is consistently cited at 30-40 accounts, growing to 50-70 at Series A and 80-100+ at Series B+ (dualentry.com/blog/saas-chart-of-accounts, ramp.com/blog/chart-of-accounts-template).

**QuickBooks Online.** QBO doesn't ship one universal default COA — the starting set depends on the entity type and industry selected at setup, and QBO distinguishes "account type" (e.g. Expenses) from a more granular "detail type" (e.g. Advertising/Promotional, Travel, Utilities, Office/General Administrative Expenses) that acts as the de facto category list (quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/understanding-chart-accounts). A generic "Uncategorized Expense" account exists as the catch-all bucket transactions fall into before anyone codes them — worth noting since that's structurally the same problem Decimal is solving pre-integration.

**IRS Schedule C** (business.irs.gov / sba.thehartford.com/finance/taxes/business-expenses-list) is the closest thing to a government-sanctioned standard taxonomy, since every US business ultimately has to bucket its spend into these lines for tax filing. Lines 8-27 give: Advertising, Car and Truck Expenses, Commissions and Fees, Contract Labor, Depletion, Depreciation, Employee Benefit Programs, Insurance (other than health), Interest (mortgage/other), Legal and Professional Services, Office Expense, Pension and Profit-Sharing Plans, Rent or Lease (vehicles/equipment, other business property), Repairs and Maintenance, Supplies, Taxes and Licenses, Travel, Meals (50% deductible), Utilities, Wages, plus a Part V "Other Expenses" catch-all. Several bookkeeping-franchise and CPA-firm sources (SDO CPA, ReceiptSync, ClaryBook) explicitly recommend aligning your COA category names to these Schedule C lines so tax prep doesn't require a re-mapping pass at year end.

**Services/SaaS-specific consolidated list.** Cross-referencing Ramp's template, Kruze Consulting's startup COA (kruzeconsulting.com/startup-chart-accounts), Bench/DualEntry's SaaS guide, and the generic small-business templates (Strategic CFO, Pacifica, Vencru), the recurring 20-30 categories that cover the large majority of AP spend for a 5-50 person services/software company are:

- Software & Web Services / SaaS Subscriptions
- Hosting & Infrastructure (AWS/GCP) — COGS for SaaS, opex for services
- Contractors & Consultants (1099 contract labor)
- Professional Fees — Legal
- Professional Fees — Accounting/Bookkeeping
- Recruiting / Staffing Fees
- Advertising & Marketing (often split: Paid Ads, Promotional Items, Conferences/Events)
- Sales Commissions
- Payroll — Wages/Salaries
- Payroll — Bonuses
- Payroll Taxes
- Employee Benefits (health insurance, 401k match)
- Workers' Compensation
- Payroll Processing Fees
- Rent / Office Lease
- Utilities
- Telephone / Internet
- Office Supplies
- Office Furniture & Equipment (small $ / non-capitalized)
- Travel
- Meals & Entertainment
- Team Events / Employee Engagement
- Insurance (general liability, E&O, D&O)
- Bank Charges & Merchant/Payment Processing Fees
- Interest Expense
- Depreciation Expense
- Amortization Expense
- Bad Debt Expense
- Dues & Subscriptions (non-software memberships)
- Taxes & Licenses

This list is deliberately closer to 25-30 than 15, because the sources agree that going too coarse hides tax-deduction detail (SDO CPA explicitly recommends categories that mirror tax-filing line items) while going much finer than this before any real transaction volume exists just creates empty accounts.

Sources: [Chart of accounts template — Bill.com](https://www.bill.com/business-templates/chart-of-accounts), [Ramp: chart of accounts template](https://ramp.com/blog/chart-of-accounts-template), [Kruze Consulting: sample chart of accounts for SaaS](https://kruzeconsulting.com/startup-chart-accounts/), [DualEntry: SaaS chart of accounts guide](https://www.dualentry.com/blog/saas-chart-of-accounts), [Strategic CFO: standard chart of accounts](https://strategiccfo.com/articles/accounting/standard-chart-of-accounts/), [Pacifica: chart of accounts every owner should know](https://www.pacificabs.com/knowledge-center/blog/small-business-accounting-essential-chart-of-accounts-every-owner-should-know/), [SDO CPA: chart of accounts setup for small business](https://www.sdocpa.com/chart-of-accounts-setup-small-business/), [QuickBooks: understanding the chart of accounts](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/understanding-chart-accounts/L5MraHgGZ_US_en_US), [FitSmallBusiness: QuickBooks expense categories](https://fitsmallbusiness.com/quickbooks-expense-categories/), [SDO CPA: Schedule C deductions](https://www.sdocpa.com/schedule-c-deductions/), [The Hartford / SBA: deductible business expenses list](https://sba.thehartford.com/finance/taxes/business-expenses-list/), [IRS: Instructions for Schedule C](https://www.irs.gov/instructions/i1040sc).

## B. Measuring GL-coding suggestion quality

**Vendors report widely different numbers because they define "accuracy" differently, and almost nobody publishes a rigorous methodology.** The clearest finding from this research is that the industry lacks a standardized eval; each vendor's number reflects a different measurement (field extraction vs. GL coding vs. whole-invoice correctness), a different population (day-one/out-of-box vs. after months of learning on a stable vendor base), and often a different action counted as "correct" (system-suggested-and-accepted vs. system-suggested-and-never-touched again downstream).

**Exact-match vs. category-level match.** None of the vendor-facing sources researched publish a clean distinction between "exact GL account match" and "correct category, wrong sub-account" as separate metrics — most collapse everything into one "accuracy" or "error rate" number. Stampli's own accuracy-measurement post defines invoice accuracy simply as `(error-free invoices / total invoices) × 100`, treating any single error anywhere on the invoice (extraction, coding, matching, or payment) as making the whole invoice count as an error — i.e., the industry mostly measures at the invoice level, not the field/account level. This is a gap: a coding-quality eval that separately tracks "right top-level category" (e.g. Software vs. Travel) from "right specific account" (e.g. Software → Hosting vs. Software → Dev Tools) would be more actionable than anything published today, and is worth Decimal building internally rather than expecting to find externally.

**Published auto-coding / touchless rates, with vendor-specific numbers:**
- Ramp: auto-coding agent claims 95%+ accuracy assigning GL category/location/department "before it hits the bookkeeper's queue," while a separate figure says its AP agent "gets it right the first time" 85% of the time, with a ~90% approver-acceptance rate on its recommendations (ramp.com/blog/ap-agent-processes-invoices, ramp.com/accounts-payable).
- Bill.com: claims 99% accuracy on multi-line invoice coding and "95% day-one accuracy" auto-capturing key invoice fields, from 5M+ daily predictions. A third-party technical teardown (invoicedataextraction.com) found real-world extraction accuracy averaged 85% on standard invoices but dropped to ~70% on non-standard formats (international, handwritten, unusual layouts) over a 6-month sample, and that GL-coding-specifically only reached ~60% pre-coded-correctly by month three for a given vendor relationship — i.e., the 99% headline number describes a narrow best-case (recurring vendor, stable template, established coding history), not the average case.
- Vic.ai: claims 97-99% accuracy on invoice data extraction and coding "from day one," with out-of-box accuracy at 97% climbing to 99% as the system learns from corrections; a customer case study cites 78% of invoices processed fully autonomously (vic.ai/resources/case-studies/countsy-case-study).
- Medius: customers average a 97.5% "First Time Right" rate (2.5% error rate), with top performers at 99.1%; touchless processing rate for Medius customers cited at 70%+.
- Industry-wide touchless-rate framing (ChatFin, PayStream, Metaviewer): legacy AP automation typically achieves 30-50% touchless processing; "top-quartile" 2026 benchmark is above 80%; a "good" enterprise STP target is 70-85%+.

**The caveat that recurs across every credible source: touchless/accuracy numbers describe the easy subset of volume, not the hard part.** Stampli's own "Touchless AP is a myth" post (a vendor arguing against its competitors' marketing) makes this explicit: high automation percentages apply to trivial, recurring, well-templated invoices, which are "a minority of invoice volume" — the majority involve multiple approvers, multi-entity GL allocations, exceptions, or vendor verification, and that's exactly where headline accuracy claims break down. It also flags that reaching a high automation rate usually requires weeks-to-months of manual rule-building up front (if/then statements per vendor/GL combination) that erodes every time an approver, entity, or vendor changes — the "automation" is partly a static rules engine wearing an AI label. This is corroborated by the Bill.com teardown showing accuracy is conditional on vendor-relationship maturity, not something achieved instantly.

**Correction rate as a metric.** No source gives a formal named "correction rate" metric with a benchmark number; it's implicit in the "First Time Right" (Medius) and "gets it right the first time" (Ramp) framings, which are really the same idea — percentage of AI-suggested codings a human accepts without editing. Medius separately tracks error rate over time (monthly/quarterly/annual) as a KPI, which is closer to a correction-rate trend than a single benchmark.

**Evaluation datasets/benchmarks.** No published, vendor-neutral benchmark or eval dataset for GL-coding accuracy was found (nothing analogous to a public leaderboard). Every number above is self-reported by the vendor's own marketing or case studies, none disclose methodology (sample size, invoice mix, time window) in enough detail to be independently verified. The one general invoice-processing accuracy survey found (Stampli's 2023 customer survey) reports 68% of respondents at ≤5% error rate and 25% at <1%, which is closer to an industry self-report poll than a benchmark dataset.

**What accuracy level counts as "trust the automation" in practice.** The clearest converging number across the error-rate-framed sources (Stampli, Medius) is: 5% error rate (95% accuracy) is the broadly cited "acceptable" bar, ≤1% is "best-in-class," and top performers report 0.8-0.9% error rates. Nobody states a specific threshold above which a vendor recommends removing human review entirely — every source (including the vendors' own docs) keeps some human-in-the-loop approval step regardless of stated accuracy, treating "trust" as a spectrum (auto-apply-and-flag-for-spot-check vs. auto-apply-and-silently-post) rather than a single accuracy cutoff that unlocks full autonomy.

Sources: [Stampli: invoice processing accuracy](https://www.stampli.com/blog/invoice-processing/invoice-processing-accuracy/), [Stampli: touchless AP is a myth](https://www.stampli.com/blog/accounts-payable/touchless-ap-myth/), [Medius: benchmarking AP accuracy](https://www.medius.com/blog/benchmarking-ap-accuracy-and-understanding-acceptable-invoice-error-rates/), [Ramp: AP agent that remembers how you process invoices](https://ramp.com/blog/ap-agent-processes-invoices), [Ramp: accounts payable](https://ramp.com/accounts-payable), [invoicedataextraction.com: how Bill.com extracts invoice line items (and where it misses)](https://invoicedataextraction.com/blog/bill-com-invoice-coding-agent-line-item-extraction), [Vic.ai: accounts payable automation best practices guide](https://www.vic.ai/blog/accounts-payable-automation-best-practices-the-modern-ap-professionals-guide), [Vic.ai: Countsy case study](https://www.vic.ai/resources/case-studies/countsy-case-study), [ChatFin: touchless AP / straight-through processing 2026](https://chatfin.ai/blog/touchless-ap-straight-through-processing-finance-2026/), [PayStream: touchless invoice processing](https://paystreamadvisors.com/blog/touchless-invoice-processing/).

## What Decimal should steal / avoid

Steal: ship a lean ~25-account default taxonomy (the services/SaaS list in section A) mapped 1:1 to Schedule C lines, so a company with no accounting integration yet still gets sane, tax-aligned buckets on day one, and coded history migrates cleanly into QBO's detail types once they connect. Steal the "First Time Right" framing (Medius) over a vague "accuracy" number — it maps directly to Decimal's coding-inbox accept/edit action and is honest about what's actually being measured. Track exact-account-match and category-level-match as two separate numbers internally; nobody else in the market bothers to and it would be a genuine differentiator plus a more honest thing to show founders.

Avoid: don't publish a single headline accuracy/touchless percentage without the caveat that it's conditional on vendor-relationship maturity (Bill.com's 99%-claim/60%-real-world gap is the cautionary example) — Decimal has no transaction history moat yet, so an early claimed number will regress publicly. Avoid treating a high acceptance rate as license to remove the human approval step; every credible source keeps a human in the loop regardless of stated accuracy, and Stampli's "touchless is a myth" critique is a useful internal gut-check before Decimal's own marketing reaches for a "% touchless" number.

# Enterprise GL coding at scale — Coupa, Tipalti, Airbase, SAP Concur

Research date 2026-07-13. Sources are web docs/blogs (vendor help centers, integration playbooks, community forums, and third-party AP explainer sites), not primary product screenshots I could log into — treat specifics as directionally right, verify anything load-bearing against a live trial before building on it.

## 1. Dimensions: GL account + department/cost center/location/project/class

The pattern across Coupa, Tipalti, and the broader AP-automation category is the same shape: a base GL account plus a set of orthogonal "reporting dimensions" layered on top. Coupa's own docs describe the chart of accounts as "unique for each customer and derived from a combination of company code, account category, general ledger, project, asset, WBS, internal order or cost center" (Coupa SAP integration playbook, compass.coupa.com). That is five to seven segments in a single code string for a large SAP shop — company code, GL account, cost center, project/WBS element, internal order, asset, account category.

The generic multi-dimensional description (repeated near-verbatim across Coupa and Tipalti secondary sources, e.g. Intuit's dimension-accounting explainer) is: GL account is the one truly universal dimension; department, cost center, location, project, and "class" (a QBO/NetSuite-style catch-all tag) are the common optional layer. None of the sources I found publish a canonical "these N dimensions, full stop" list — enterprises configure however many segments their chart of accounts needs, and the tooling (Coupa, SAP, NetSuite) just enforces whatever segment structure the ERP defines.

**Dimension-dependent validation** is explicit in the docs: "the dimensional coding process must respect field dependencies and validation rules defined in the ERP system... certain department and location combinations may be invalid, or specific projects may only be available for certain GL accounts" (recurring line across Coupa/Tipalti coverage, sourced from Stampli's invoice-coding-and-fields piece and Coupa's own accounting-data docs). Concretely this means: pick GL account 6100 (Travel) and the UI narrows the valid department list to ones that have a travel budget; pick a project-only GL account and department becomes irrelevant/hidden. This is cascading dropdown validation keyed off account, not a flat form.

Coupa also ties dimensions to **budget**: "budget lines can be configured and defined by period, amount, cost center, location, or any other accounting code... project codes can be loaded into the account structure, so you can drive budgets for those projects within Coupa" (Coupa budget integration scenarios doc). So dimensions aren't just reporting tags — they're the join key into a budget-check step at coding time (does this cost center have room left this quarter).

Sources:
- [Company Codes, Cost Centers, and GL Account Code Combinations from SAP to Coupa](https://compass.coupa.com/en-us/products/total-spend-management-platform/integration-playbooks-and-resources/erp-integration-playbooks/sap-integration-playbook/company-codes-cost-centers-and-gl-account-code-combinations-from-sap-to-coupa)
- [Coupa Accounting Data docs](https://compass.coupa.com/en-us/products/core-platform/integration-playbooks-and-resources/erp-integration-playbooks/sap-integration-playbook/coupa-sap-integration-playbook/accounting-data)
- [10. Budget Integration Scenarios | Coupa](https://compass.coupa.com/en-us/products/total-spend-management-platform/integration-playbooks-and-resources/other-integration-playbooks/erp-integration-adapters/integration-scenarios/10.-budget-integration-scenarios)
- [Invoice Coding and Fields in Accounts Payable - Stampli](https://www.stampli.com/resources/invoice-coding-and-fields-in-accounts-payable/)
- [Tipalti GL Accounts template](https://help.tipalti.com/hc/en-us/articles/30710266235031-GL-Accounts)
- [Multidimensional accounting | Intuit](https://www.intuit.com/enterprise/blog/financials/multi-dimensional-accounting/)

## 2. PO-driven coding: inheritance and how much manual coding it removes

The mechanism is consistent everywhere it's documented: when an invoice is matched to a purchase order, the invoice line coding is pulled from the PO line, not re-entered. "In PO-based coding, invoices linked to purchase orders automatically inherit coding data from the PO line items. This minimizes manual entry, improves accuracy, and accelerates invoice approvals by aligning with pre-approved spend categories... PO-backed invoices typically have their coding predetermined when the purchase order is created... the purchase order contains the GL codes or table items and other information needed to code the invoice. In contrast, if the invoice is not associated with a purchase order, the AP team must code the invoice manually." (synthesized across HighRadius, Rillion, and Stampli invoice-coding explainers, all describing the same category-standard flow.)

SAP Concur's matching logic is the most concretely documented version of the workflow gate this creates: matching runs "one-to-one comparison between the current invoice and the PO... at header, line item, and/or vendor level" plus "life-to-date matching... a one-to-many comparison between all associated invoices and the PO based on cumulative totals, especially useful in partial shipment scenarios." Routing follows the match result: "if the invoice matches the PO, it can be configured to skip approval steps... if the invoice does not match the PO, or if it is a non-PO invoice, it must go through all required managerial or additional approval steps" (Concur PO-matching learning docs + Concur community).

No source gave a hard percentage figure for "what share of coding a PO removes" specifically — the closest proxy is Ramp's stat that its AI/rules engine "auto-codes over 90% of transactions" (ramp.com/blog/brex-vs-bill), but that's coding automation broadly (rules + AI), not PO-specific, and it's a card/expense context more than bill-pay. Treat the 90%+ figure as evidence that at scale coding automation (PO-driven or rule-driven) is expected to cover the vast majority of volume, with humans only touching the exception tail — not as a PO-specific number.

Sources:
- [What Is Invoice Coding In Accounts Payable & How To Automate - HighRadius](https://www.highradius.com/resources/Blog/invoice-coding/)
- [What is invoice coding? - Rillion](https://www.rillion.com/learn-ap/invoice-coding/)
- [What is GL coding on an invoice - Stampli](https://www.stampli.com/resources/invoice-gl-coding-fundamentals/)
- [Configuring Purchase Order Matching - SAP Concur learning](https://learning.sap.com/learning-journeys/getting-started-with-concur-invoice-standard-edition-for-administrators/configuring-purchase-order-matching)
- [Concur Invoice Approval Workflow Design - Concur Community](https://community.concur.com/t5/Concur-Invoice-Forum/Concur-Invoice-Approval-Workflow-Design-Purchase-order-requester/m-p/113858)
- [Brex vs. BILL comparison - Ramp](https://ramp.com/blog/brex-vs-bill)

## 3. Coding approval: is coding itself approved, separately from bill approval?

The clearest framing came from a general AP-controls piece (invoicedataextraction.com), which draws the line Decimal should care about: "invoice approval says 'this liability is valid and correctly recorded,' while payment approval says 'release these funds, from this account, by this method, now.' Well-controlled processes keep them as two separate gates with different (or at least separable) approvers." That's approval-of-the-liability vs. approval-of-the-payment, which is a different split than "coding vs. everything else" — but it's the closest documented concept to a standalone "coding is correct" gate.

Practically, none of Coupa/Tipalti/Airbase/Concur appear to ship a dedicated "coding approval" step as a first-class workflow stage distinct from bill/invoice approval — coding review is folded into whoever approves the invoice (a cost-center manager or controller sees the coded invoice and either accepts or kicks it back). The controls-framework source describes it as a *standard plus spot-check* model rather than a per-invoice second approval: "the control is a coding standard — a chart-of-accounts mapping by vendor category or expense type — backed by an enforcement mechanism (default codes by vendor where the categorisation is stable, validation against expected tax rates by vendor and jurisdiction) and a sample review of coding accuracy at month end." In other words: prevent bad coding at entry time (defaults + validation), and audit a sample after the fact — not gate every invoice through a human coding-approver.

Where a "coding inbox" concept does show up as UI, it's the intake queue framing, not an approval queue: "invoices should be routed through a shared inbox, portal or structured e-invoice channel... standardizing invoice intake gives accounts payable tasks a single entry point, which saves time and reduces the chance that invoices skip coding rules or approval logic." That's the same shape Decimal already shipped in the coding-inbox feature (one filterable table + split coding modal, per the recent commits) — a work queue for uncoded items, not a controller sign-off gate on top of already-coded ones.

Sources:
- [Accounts Payable Controls Framework - invoicedataextraction.com](https://invoicedataextraction.com/blog/accounts-payable-controls-framework)
- [Invoice Coding in Accounts Payable Explained - Ramp](https://ramp.com/blog/accounts-payable/invoice-coding)
- [What is an invoice approval workflow - Stampli](https://www.stampli.com/resources/invoice-approval-workflow/)
- [Invoice approval workflow - ApprovalMax](https://blog.approvalmax.com/invoice-approval-workflow)

## 4. Amortization / prepaid handling — coding a bill across future periods

Airbase is the best-documented of the four here. The mechanic: a bill is coded to a prepaid asset account at time of coding, with a start date and end date; Airbase generates a straight-line amortization schedule, splitting the amount evenly across the number of months between those dates, and then posts a journal entry each period end that debits the expense account and credits the prepaid asset account. "Users can simply enter a start and end date, and Airbase will generate the full amortization schedule... Airbase initially records the amount paid against the pre-payment account, and at the end of each month, entries are automatically created to record the monthly expense amortization." (airbase.com/modules/ap-automation/amortization). One real limitation called out directly in Airbase's own help center: "amounts can only be split equally over the number of months between the start date and the end date" — no uneven/custom-weighted splits (help.airbase.com amortization FAQ). Users can also import an amortization schedule from the ERP directly rather than have Airbase generate one, for cases (e.g. usage-based recognition) that don't fit straight-line.

Sage Intacct's Prepaid Expense Amortization (PEA) module — cited alongside Coupa/Tipalti in the wider category — uses a similar "class" concept: a transaction is tagged with a prepaid-expense class that defines the amortization method and period count, which generates a schedule of individual GL-posting entries, and those entries can be edited/moved without breaking the schedule ("schedule entries can be customized to allow manipulation of GL posting date and amount for each schedule entry"). I could not get a working fetch on Coupa's own prepaid-automation documentation (the GitLab handbook page that referenced it didn't actually contain the content); Coupa's prepaid flow is real but I don't have a primary source confirming its exact mechanics beyond the general category pattern above.

The universal shape, confirmed across every source touching this: (1) code the bill to a prepaid/deferred asset account instead of a P&L expense account at intake, (2) attach a start/end date or period count, (3) system auto-generates N schedule lines, (4) a recurring job posts one schedule line per period, moving the amount from the asset account to the expense account.

Sources:
- [Bill Pay Amortization | Airbase](https://www.airbase.com/modules/ap-automation/amortization)
- [How does Airbase handle amortization? - Airbase help center](https://paylocity.egain.cloud/kb/airbase) (redirected from help.airbase.com)
- [Prepaid Expense Amortization workflow - Sage Intacct](https://www.intacct.com/ia/docs/en_ZA/help_action/More/Prepaid_Expense_Amortization/Use_PEA/PEA-workflow-overview.htm)
- [About Prepaid Expense Amortization - Sage Intacct](https://www.intacct.com/ia/docs/en_US/help_action/More/Prepaid_Expense_Amortization/about-prepaid-expense-amortization.htm)
- [How the Prepaid Expense Schedule Works - Truewind](https://www.truewind.ai/blog/prepaid-expenses-schedule-and-journal-entries)

## 5. What matters at 5-50 people vs. what's enterprise-shaped

**Matters even at 5-50 people:**
- GL account + one or two extra dimensions (department and/or class). A 20-person company still has departments (eng/sales/ops) and often wants class-level P&L (e.g. per-project or per-client profitability). This is the Coupa/Tipalti multi-dimension idea, just miniaturized to 2 dimensions instead of 5-7.
- Dimension-dependent validation, in a light form: if GL account X is picked, narrow or default the department field. Doesn't need a full rules engine — a static lookup table (account -> allowed departments, or account -> default department) covers the 5-50 case.
- Vendor-based coding defaults / rules ("this vendor always codes to 6100-Marketing"). This is the single highest-leverage miniaturization of PO-driven coding: a 5-50 person org rarely runs formal POs, but it has recurring vendors with stable categorization. A vendor-level or vendor+category-level default rule captures most of what PO inheritance captures for a company that doesn't do procurement.
- The "coding is a queue, not a second approval gate" model. Fold coding review into the same approver who checks the bill; don't build a standalone coding-approval stage. This matches what Decimal already shipped (coding inbox + split coding modal) — validated as the right shape by the fact enterprise tools don't split it out either.

**Enterprise-shaped, worth skipping/deferring:**
- Full PO-to-invoice 3-way/4-way matching with life-to-date cumulative matching across partial shipments (Concur's model). This exists because enterprises run formal procurement with staged deliveries; a 5-50 org buying SaaS and services doesn't have partial-shipment PO reconciliation problems.
- 5-7 segment chart-of-accounts strings (company code + GL + cost center + project + WBS + internal order + asset). That's SAP-shop complexity. QBO/Xero-native small orgs use 1-3 dimensions max.
- Budget-integrated coding (dimension as a live budget-check join key). Real and valuable at scale, but it requires a budgeting system to exist first — most 5-50 orgs don't have formal per-cost-center budgets yet.
- Amortization/prepaid automation as a v1 feature. Real need (annual SaaS contracts, insurance, prepaid rent) but low volume at this size — a handful of prepaid bills a year doesn't justify a schedule-generation engine yet. Worth designing the data model so a "prepaid account + start/end date" field can be bolted on later without a schema rework, but the auto-posting-per-period engine can wait.
- Sample-based month-end coding audits as a formal control — that's a controller function that shows up when there's a controller; at 5-50 people the founder or a fractional bookkeeper is eyeballing everything anyway.

## What Decimal should steal / avoid

**Steal:**
1. Vendor-level coding defaults (the miniaturized version of PO inheritance) — biggest ROI-to-effort ratio here. If a vendor has coded consistently before, default new bills from that vendor to the same GL account/department and let the user confirm-or-override rather than start blank. This is the OCR-coding-suggestion work already underway; extend it with a vendor-remembered-default layer, not just line-item OCR guesses.
2. Account-dependent dimension narrowing (cascading validation) — cheap to build (a lookup table), meaningfully cuts miscoding, and it's the one piece of "enterprise rigor" that's genuinely dimension-count-independent.
3. Keep coding review inside the existing approval/bill flow — don't add a distinct "coding approver" role or stage. Enterprise tools don't split this out either; it would be over-building relative to both the enterprise pattern and Decimal's own pipeline model (Review/Approve/Release).

**Avoid (for now):**
1. Full PO 3-way matching with life-to-date/partial-shipment logic — no evidence this problem exists yet at 5-50 person orgs without formal procurement.
2. Multi-segment (5+) chart-of-account strings — 2 dimensions (GL account + department/class) covers the segment this size of company needs.
3. A full amortization/prepaid engine — note the "prepaid account + start/end date" fields as a future-proofing item in the data model, but don't build the auto-posting schedule generator until a real customer has enough prepaid bills to justify it.

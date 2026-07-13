# Tipalti: organization-wide policies and controls

Scope: payee/vendor compliance, payment controls, fraud/risk, where things are configured, enforcement and overrides. Approval-chain routing is covered elsewhere and intentionally skipped here.

## 1. Vendor/payee policies

**Onboarding and tax forms.** Payees fill in their own record through a self-service portal (the "Supplier Hub" / payee registration iFrame), or the payer creates them via API, CSV upload, or manual entry. Tipalti determines which tax form a payee owes based on country of residence and tax classification: US payees submit a W-9, non-US payees submit a W-8 variant (W-8BEN, W-8BEN-E, W-8ECI, etc.), and Tipalti has a W-8 solution integrated with its global payments flow. Data is validated in real time as the payee fills the form — completeness/correctness checks, and a rule that the name in contact info, payment method, and tax section must all match. (https://help.tipalti.com/hc/en-us/articles/30607345010327-US-tax-forms, https://tipalti.com/press/tipalti-launches-first-w-8-solution-fully-integrated-with-global-payments/, https://tipalti.com/blog/form-w-9-automation/)

**TIN matching.** Tipalti integrates with the IRS TIN Matching service. If TIN validation is turned on for the payer, a failed match sets the payee to "Submitted (failed TIN validation)," emails the payer that the payee is not payable, and requires the payer to either get it corrected or manually mark the tax form as accepted. This is an opt-in payer-level setting, not always-on. (https://tipalti.com/blog/tin-matching/)

**Bank/payment-method verification.** Payees choose a payment method and currency; for EU payees Tipalti runs Verification of Payee (VoP), an EU regulatory requirement matching the payee name to the bank account before payment, to catch fraud/misdirection. (https://help.tipalti.com/hc/en-us/articles/35027756852247-Verification-of-payee-VoP)

**Payable / Not Payable status.** Every payee has a binary gate — "Payable" or "Not Payable" — and only Payable payees can be paid. Missing/incorrect info, failed tax validation, or an unverified payment method holds a payee in Not Payable until fixed. This status is the enforcement point: it's a hard block on payment execution, not a soft flag. (https://help.tipalti.com/hc/en-us/articles/10732957311895-Payee-Onboarding-via-API)

**Payment methods per payee/country.** Tipalti maintains explicit payment-method coverage tables per region — US & ROW, Canada, UK & EU — driven by payee country and payer funding currency. Which payment providers get used is resolved automatically from payee currency + payer funding currency + provider min/max thresholds; the payee only sees the methods valid for their country on the Payment Method step. (https://help.tipalti.com/hc/en-us/articles/31314361313815-Payment-methods-coverage-US-ROW, .../30718169032343-Payment-methods-coverage-Canada, .../31316176094359-Payment-methods-coverage-UK-EU)

**Sanctions / OFAC screening.** Every payee is screened against OFAC's SDN list and equivalent UK/EU/UN consolidated sanctions lists (UK and EU lists are largely folded into the US SDN and UK Consolidated lists respectively for practical screening). Tipalti's own compliance guidance frames this as continuous, not one-time: screening happens at onboarding *and* again before every payment run, because SDN lists update frequently. Where there's a possible match, Tipalti's stated posture is conservative — hold the payment until the identity issue is resolved rather than risk a false negative. Public docs don't spell out a granular override/audit-trail mechanism for sanctions hits specifically (likely handled case-by-case with Tipalti compliance/support), but the platform's general audit trail (below) covers it. (https://tipalti.com/en-eu/legal/ofac-aml-compliance/, https://tipalti.com/blog/ofac-compliance-1099-1042-payments/)

## 2. Payment controls

**Duplicate invoice detection.** Tipalti flags potential duplicate bills automatically so approvers see the flag before acting; AI is also pitched as proactively catching duplicate invoices and unusual vendor activity as part of an "invoice AI" layer. This is a flag-and-surface control, not a hard block — approvers still make the call. (https://tipalti.com/ap-automation/po-matching/, https://tipalti.com/accounts-payable-software/finance-ai/)

**Invoice tolerances / PO matching.** For 2-way and 3-way PO matching, admins configure tolerance thresholds by amount, percentage, at either the bill level or the line level. Discrepancies inside the tolerance auto-approve and the invoice proceeds; discrepancies outside tolerance get flagged for manual review. Tipalti markets "26,000+ automated rules" for invoice verification/discrepancy detection generally (exact rule catalog isn't public). (https://tipalti.com/ap-automation/po-matching/)

**Payment thresholds (currency/provider routing).** Separate from approval-amount thresholds (routing territory), Tipalti uses payment-provider min/max thresholds keyed to payee currency to decide which underlying payment rail/provider to route a given payment through — this is an operational/technical control, invisible to the payer, not a policy lever they set. (https://help.tipalti.com/hc/en-us/articles/30607336767127-Payment-statuses-defined)

**Batching / timing rules.** Payment instructions delivered to Tipalti by 10:30am PST (11:30am PDT) on a banking business day execute same-day; anything after that cutoff executes the next banking business day. This is a fixed platform-level cutoff, not a per-org configurable batching policy in the docs found.

**Currency / FX rules.** FX fee liability is rule-based off three inputs: bill currency, payee's chosen payout currency, and whether the payer holds a virtual account in the needed currency. If all three currencies match, no FX fee. If payer lacks a virtual account in the needed currency, the payer eats the fee. If payer and bill currency match but the payee wants a different payout currency, the payee eats the fee (deducted from payment before conversion). Tipalti applies its own margin on top of a wholesale FX rate; exact fee % isn't published and is volume/contract-dependent. (https://help.tipalti.com/hc/en-us/articles/29398227020311-How-do-FX-Fees-work)

## 3. Fraud / risk controls (Tipalti Detect)

Tipalti Detect (formerly branded as the Risk Management Module / RMM) is the dedicated fraud layer, separate from sanctions screening:

- **Always-on / automatic:** proprietary risk-scoring algorithms run continuously across current and historical payee data (payment method details, SSN/EIN, email, address, company name, phone number) to find relationships between a payee and previously blocked/suspended payees, or multiple accounts sharing identity fields — i.e., detecting fraud rings and repeat offenders trying to re-enter under a new identity. Suspicious payees get auto-flagged into a "risk review" status that alerts the admin.
- **Configurable by the payer/admin:** the admin decides, on a flagged payee, whether to Suspend (payee is held — not paid until manually reviewed and cleared) or Block (payee is never paid and is now flagged network-wide). This block/suspend decision is the human-in-the-loop control point.
- **Network effect layer (opt-in):** payers can opt to contribute blocked payees to a shared cross-customer network ("Network Blocked Payees") and subscribe to alerts when a payee blocked elsewhere on the network tries to onboard with them — a crowdsourced blocklist across all Tipalti customers, described by Tipalti as "Interpol-like." This is opt-in, not default.
- **Additional signals mentioned in marketing:** behavioral analytics (keystroke/mouse patterns during onboarding) and tokenization of sensitive fields (so intercepted data is useless). These read as always-on platform capabilities rather than admin-configurable toggles, though granular docs on toggling them weren't found.
- **Reported impact:** Tipalti cites 7,400+ payees blocked and ~$4M in savings from Detect across its customer base — evidence this is treated as a major differentiator, not a checkbox feature.

(https://tipalti.com/en-ca/product/detect-risk-module/, https://tipalti.com/press/payment-fraud-protection-rmm/, https://tipalti.com/press/tipalti-detect-payment-fraud-mitigation-pr/, https://www.prnewswire.com/news-releases/tipalti-customers-help-each-other-stop-fraud-261080921.html)

## 4. Where configured; enforcement (block vs flag); overrides and audit trail

- **Where:** payee-level policy (tax forms, TIN validation toggle, payment methods, Detect status) lives on the payee record and in payer-level compliance settings inside the Tipalti Hub (admin console). PO-matching tolerances are configured wherever PO matching rules live (bill/line level, amount or percent). Approval routing/thresholds are a separate configurable workflow layer (out of scope here per the brief).
- **Block vs flag, summarized:**
  - Hard block (payment literally cannot go out): payee not "Payable" status (missing docs, failed tax validation, unverified bank info); payee marked "Blocked" by Detect.
  - Soft hold pending review: payee "Suspended" by Detect (risk review); a sanctions/OFAC possible-match (held for manual resolution).
  - Flag only, doesn't stop the transaction unless a human acts: duplicate invoice detection surfaces a flag to the approver; PO-matching discrepancies within tolerance auto-approve, only out-of-tolerance items get flagged for review.
- **Overrides:** payers can manually override a failed TIN validation by asserting "tax form submitted manually." Suspended payees can be manually cleared by an admin after review. Public docs don't detail a formal override/exception workflow with its own audit record for sanctions hits — general audit trail coverage is asserted (see below) but the specific UI for logging a sanctions override wasn't found in available docs.
- **Audit trail:** Tipalti asserts an "immutable, time-stamped audit trail for every single transaction" system-wide (OFAC compliance page), and separately touts audit logs as part of its internal-control framework alongside role-based permissions and approval workflows (financial-controls / segregation-of-duties framing). Docs found don't break out a control-by-control changelog (e.g., "who changed this PO tolerance and when") — the audit trail claim is at the transaction level, not necessarily at the policy-configuration level.

(https://tipalti.com/en-eu/legal/ofac-aml-compliance/, https://tipalti.com/blog/tin-matching/, https://tipalti.com/en-ca/product/detect-risk-module/)

## 5. Interaction with approvals and roles

Tipalti markets 20+ role-based permissions that gate who can initiate disbursements, fund accounts, create approval flows, and run reports — this is the segregation-of-duties layer that sits on top of (and is distinct from) the payee/payment policy controls above. The stated design: role-based access controls who can act, approval workflows control who must sign off on what (by amount/vendor-type criteria), and the payee/payment controls (tax validity, sanctions, Detect status, PO tolerance) act as gates that must independently pass regardless of who approved the transaction — i.e., a fully-approved invoice still can't pay out to a Not-Payable or Blocked payee. This reads as two orthogonal layers: "who is allowed to authorize this" (roles/approvals) and "is this payee/invoice allowed to be paid at all" (policy/compliance controls) — with policy controls acting as a final gate that approval authority cannot override. (https://tipalti.com/product/platform/financial-controls/ — via search snippet, page itself 404'd for direct fetch; https://tipalti.com/accounts-payable-software/financial-compliance/)

## Sources

- https://help.tipalti.com/hc/en-us/articles/30607345010327-US-tax-forms
- https://tipalti.com/press/tipalti-launches-first-w-8-solution-fully-integrated-with-global-payments/
- https://tipalti.com/blog/form-w-9-automation/
- https://tipalti.com/blog/tin-matching/
- https://help.tipalti.com/hc/en-us/articles/35027756852247-Verification-of-payee-VoP
- https://help.tipalti.com/hc/en-us/articles/10732957311895-Payee-Onboarding-via-API
- https://help.tipalti.com/hc/en-us/articles/31314361313815-Payment-methods-coverage-US-ROW
- https://help.tipalti.com/hc/en-us/articles/30718169032343-Payment-methods-coverage-Canada
- https://help.tipalti.com/hc/en-us/articles/31316176094359-Payment-methods-coverage-UK-EU
- https://tipalti.com/en-eu/legal/ofac-aml-compliance/
- https://tipalti.com/blog/ofac-compliance-1099-1042-payments/
- https://tipalti.com/ap-automation/po-matching/
- https://tipalti.com/accounts-payable-software/finance-ai/
- https://help.tipalti.com/hc/en-us/articles/30607336767127-Payment-statuses-defined
- https://help.tipalti.com/hc/en-us/articles/29398227020311-How-do-FX-Fees-work
- https://tipalti.com/en-ca/product/detect-risk-module/
- https://tipalti.com/press/payment-fraud-protection-rmm/
- https://tipalti.com/press/tipalti-detect-payment-fraud-mitigation-pr/
- https://www.prnewswire.com/news-releases/tipalti-customers-help-each-other-stop-fraud-261080921.html
- https://tipalti.com/product/platform/financial-controls/
- https://tipalti.com/accounts-payable-software/financial-compliance/

## What Decimal should steal / avoid

**Steal:**
- The **Payable/Not Payable gate** as a hard, independent block that sits underneath approvals — a fully-approved payment still can't execute if the payee record itself isn't compliant (bad tax form, unverified rail, blocked status). This is the cleanest mental model for "policy vs approval": approval decides *who signs off*, policy decides *whether this can legally/safely be paid at all*, and policy always wins.
- **Continuous re-screening, not just onboarding-time.** Running sanctions/compliance checks again right before each payment (not just once at vendor creation) is the right instinct for a product that holds funds and moves them autonomously via agents — Decimal's auto-pay agent should re-validate policy state at execution time, not trust a stale check from onboarding.
- **Tolerance-based auto-approval with an explicit escape valve.** Amount/percent tolerance thresholds that let small discrepancies auto-clear while anything above threshold gets a human, at bill or line-item granularity, maps well onto Decimal's OCR-coding/GL-coding flow.
- **Suspend vs Block as two distinct severities** rather than one binary "flagged" state — suspend (hold, needs review) vs block (permanent, network-visible) gives more nuance than a single "risky" flag.

**Avoid / be careful:**
- Tipalti's docs are thin on **audit trail at the policy-configuration level** — they assert immutable transaction logs but don't clearly show who changed a tolerance rule or overrode a sanctions hit and when. For Decimal, given the code-enforced-gate moat, the audit trail should cover policy *changes* (who set what threshold, when) with the same rigor as payment transactions, not just transaction history.
- The **cross-customer "Network Blocked Payees"** crowdsourced blocklist is clever but is really a scale/data-moat play that only works with thousands of customers sharing a payee pool — not reproducible at Decimal's current stage, and it introduces a shared-liability/privacy question (blocking someone based on another customer's judgment) that's not worth chasing early.
- Sanctions-screening messaging leans on "hold and manually resolve" without a documented override workflow — for a product that markets itself as agent-automated, Decimal should be more explicit than Tipalti about exactly who can override a sanctions hold and what gets logged, rather than leaving it as an implied support-ticket process.

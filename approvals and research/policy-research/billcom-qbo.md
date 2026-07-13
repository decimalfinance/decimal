# Org-wide policies and payment controls: Bill.com and QuickBooks Online

Scope note: this covers organization-wide policies and payment controls (limits, duplicate detection, vendor verification, timing rules, closing controls, security). Approval-chain routing itself was researched separately and is deliberately excluded here except where a control is inseparable from it (e.g. dual control, which is a policy toggle, not a routing rule).

## 1. Bill.com (BILL)

### Payment limits and thresholds

- BILL sets an org-level AP payment processing limit, not a per-invoice cap the org configures itself. New firms/orgs typically start around $10,000, and existing accounts with a payment history can have this raised. Increases go through a formal request ("Payables (AP) Limit Increase Request") and are "subject to review and approval by BILL" — i.e., the platform, not the customer, is the approver of the ceiling itself. Source: https://assets.ctfassets.net/4xstiwmv0r7j/2Z1VBon560CQOKuyog68Qw/ce78348dd5937563fd4a7b456dde83a8/Bill.com_AP_payment_timing_and_limits__6-18_.pdf and https://www.bill.com/accountant-resource-center/articles/payment-timing-and-limits
- QuickBooks Bill Pay (Intuit's own bill-pay, not BILL the company, but structurally identical) works the same way: "Every account with QuickBooks Bill Pay sets a processing limit based on payment history, risk profiles, and other factors," and payments count against the rolling limit for 30 days after being scheduled. Source: https://quickbooks.intuit.com/learn-support/en-us/help-article/increase-limit/learn-payment-processing-limits-quickbooks-bill/L3jVcLvTb_US_en_US
- Within BILL Spend & Expense (the card/expense product, separate from Payables), admins *can* configure org policy directly: a maximum transaction amount limit per budget, merchant category controls, and notifications on unapproved purchases. This is genuinely org-configurable policy, unlike the AP payment ceiling. Source: https://help.bill.com/direct/s/article/000002852 and https://help.bill.com/direct/s/article/6811872
- Per-user dollar approval thresholds exist only for the Approver role — an admin sets a dollar limit per person, above which that approver's sign-off isn't sufficient (routes further). This is the one place individual "policy" is user-configurable inside Payables. Source: https://www.stitchflow.com/user-management/bill.com/manual

### Duplicate invoice/bill detection

- BILL automatically checks incoming invoices for duplicate invoice numbers and flags potential duplicate payments during processing. Source: https://www.bill.com/learning/duplicate-payments
- Enforcement is warn/flag-and-route, not hard block: flagged items go to the normal approval workflow for human review rather than being auto-rejected. The specific override mechanics (who can dismiss a duplicate flag) aren't documented publicly — it's absorbed into the same approval routing rather than a separate control. Source: https://www.bill.com/learning/duplicate-payments
- BILL also markets "three-way matching" (invoice vs. PO vs. receipt/goods-receipt) as fraud/error prevention before a payment can be made, on top of the duplicate-number check. Source: https://www.bill.com/blog/identifying-and-preventing-vendor-fraud

### Vendor verification / bank-change policy

- When a vendor's bank info is changed manually inside BILL, the vendor is automatically emailed to confirm the change: they see old vs. new bank details and must click "Confirm now" or "I didn't request this change." If they flag it as unrequested, BILL directs them to contact the payer directly.
- Critically, this confirmation is **not a hard gate** — "confirmation isn't required to schedule payments." It's a fraud-detection signal layered on top of the payment flow, not a blocking control. Source: https://help.bill.com/direct/s/article/360040327752
- New vendor bank accounts also go through a test-deposit verification (a $0.01 deposit within 1-2 business days); if it fails, BILL invalidates the account and notifies the org. Source: found via https://www.bill.com/blog/identifying-and-preventing-vendor-fraud (test-deposit detail from search synthesis of BILL help content).
- "Dual Control" is BILL's blocking, org-configurable answer to bank-change and other sensitive-action fraud: enabling it means one user initiates a sensitive action (e.g. edit vendor bank info) and a second admin/approver must sign off before it takes effect. Only users with Dual Control permission (all Administrators, or others an admin designates) can approve; only one approval is needed even if multiple approvers are notified. It must be turned on by contacting BILL support — it isn't on by default. Source: https://help.bill.com/direct/s/article/7332404391437 and https://www.bill.com/product/accounts-payable-controls

### Payment timing rules

- BILL enforces payment-timing/cutoff rules (e.g., cutoff times for same-day vs. next available payment date, ACH vs. check lead times) that determine when a scheduled payment actually executes; these aren't org-configurable, they're platform constraints. Source: https://help.bill.com/direct/s/article/115005322726 and https://www.bill.com/accountant-resource-center/articles/payment-timing-and-limits

### Security / separation of duties

- Six predefined roles — Administrator, Accountant, Clerk, Approver, Payer, Auditor — each with fixed permission bundles; custom roles are available on higher-tier plans. This is the primary separation-of-duties lever: an org can ensure the person who enters a bill cannot also be the one who pays it. Source: https://www.bill.com/product/accounts-payable-controls
- Time-stamped audit trails log all user actions, for after-the-fact review/detection of unauthorized or suspicious activity — not a preventive control, a detective one. Source: https://www.bill.com/product/accounts-payable-controls
- SSO integration (Google, Okta, Azure AD, Auth0, Centrify) is offered as an access-control policy lever, configured by admins. Source: https://www.bill.com/product/accounts-payable-controls
- Check payments get Positive Pay protection (bank matches issued check to presented check) — again a platform-level control, not something the org toggles. Source: found via BILL fraud-prevention content.
- Enhanced/custom approval policies can route by vendor, location, department, or GL account. Important behavior: edits or deletions to a policy are **not retroactive** — they only apply to bills/credits created after the change; whatever policy existed at creation time governs that bill permanently. This is a meaningful audit/consistency property. Source: https://www.bill.com/product/accounts-payable-controls

### What SMBs get by default (zero config)

- A payment processing limit is assigned automatically (~$10k for new accounts) — no admin action needed, but also not raisable without going through BILL.
- Duplicate invoice-number flagging appears to be on by default as part of normal invoice processing (not something admins toggle on).
- Six built-in roles exist out of the box, so *some* separation of duties is available immediately, but nothing enforces an org actually assigns different people to different roles — a single owner can still be Administrator, Clerk, and Payer simultaneously.
- Dual Control, custom approval policies, and SSO are all opt-in / require explicit setup (Dual Control specifically requires contacting support to enable) — none of BILL's stronger fraud controls are on by default.
- Vendor bank-change email confirmation appears automatic on manual bank edits, but as noted it's advisory only, not a block.

### Notable gaps / complaints

- BILL's own docs and product page do not publicly specify vendor "verification policies" beyond the bank-change confirmation email and test deposit — there's no documented KYB-style vendor screening org admins can configure.
- Duplicate detection is described qualitatively ("flags potential duplicates") with no documented detail on match logic (invoice number only? amount + vendor? date window?), and no documented user-facing override/dismiss flow.
- Community sentiment (BBB, Trustpilot, PissedConsumer) skews negative specifically around **held/disputed funds and unresponsive support when a payment is contested** — several complainants say BILL "refused to return disputed funds" and would not share full audit logs backing their internal fraud determination, i.e. the audit trail is not visible/exportable to the org in a dispute. Sources: https://www.bbb.org/us/ca/alviso/profile/payment-processing-services/billcom-llc-1216-1000005293/complaints and https://bill.pissedconsumer.com/review.html
- The AP payment limit being platform-controlled (not self-service) is a recurring friction point for growing orgs — you must request increases and wait on BILL's approval, which is unusual as a "policy" since the org doesn't own the lever.

## 2. QuickBooks Online (incl. QuickBooks Bill Pay)

### Company-wide policy settings

- **Close the books**: Settings → Account and Settings → Advanced → Accounting → "Close the books." Admin sets a closing date; then chooses enforcement level from a dropdown — either a soft warning or "Allow changes after viewing a warning and entering a password" (hard password gate). Only primary admins or company admins can set/reset the closing date or its password. An "Exceptions to Closing Date" report shows any changes made to closed-period transactions after the fact, functioning as an audit trail for override use. Sources: https://quickbooks.intuit.com/learn-support/en-us/help-article/close-books/close-books-quickbooks-online/L59LelyPM_US_en_US and https://quickbooks.intuit.com/learn-support/en-us/help-article/customer-company-settings/edit-closed-books/L76xHuaZ5_US_en_US
- **Duplicate check-number warning**: Settings → Account and Settings → Advanced → Other preferences → "Warn if duplicate check number is used" checkbox. Purely a warn, not a block, and it's a toggle the org can turn off entirely. Source: community/help synthesis, e.g. https://quickbooks.intuit.com/learn-support/en-us/other-questions/repeat-check-numbers/00/623448
- **Duplicate bill-number warning**: same Advanced → Other preferences area — "Warn me when I enter a bill number that's already been used for that vendor." Important limitation confirmed by multiple sources: the check is scoped to *same vendor + same bill number only*. It does NOT compare amounts, dates, line items, or attached documents, so it misses near-duplicates from formatting differences, re-imports, or inconsistent vendor naming. Source: https://invoicedataextraction.com/blog/prevent-duplicate-bills-in-quickbooks-online and https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/is-there-an-alert-in-qbo-to-warn-of-duplicate-invoice-numbers/00/833418
- There is no invoice-level duplicate-number block by default either — multiple long-running community threads (some going back years, still active) ask for a true duplicate-prevention system check and report that plain QBO/QBO Simple/Essentials/Plus has none beyond the same-vendor bill-number warning. Source: https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/entering-bills-in-a-p-system-and-there-is-no-system-check/00/979239

### Bill approval / payment-release workflows (QBO Advanced / QuickBooks Bill Pay Elite only)

- Not available on standard QBO tiers (Simple Start/Essentials/Plus) — this is an Advanced/Bill Pay Elite-only feature, which is itself a notable segmentation decision relevant to Decimal's target segment.
- Where present: conditional rules trigger approval based on amount and/or vendor (e.g., "bills under $500 → one approver, bills over $500 → two approvers"), configured via a "when this happens" condition block. Multi-level chains are supported (e.g., bill → manager → director).
- Role-based enforcement: predefined roles like "Bill clerk" (can add/mark-paid bills, add/edit vendors, cannot approve or pay) and "Bill payer" (can view/pay bills and edit vendor details, cannot add bills) enforce separation of duties structurally.
- Payment-release approval has a timeout policy: if a scheduled bill-payment release isn't reviewed within 30 days, it's automatically denied (fails safe/closed, not open).
- Sources: https://quickbooks.intuit.com/learn-support/en-us/help-article/manage-workflows/set-use-bill-approval-payment-release-workflows/L1IOLL9hv_US_en_US, https://quickbooks.intuit.com/learn-support/en-us/help-article/manage-workflows/set-roles-permissions-paying-bills-quickbooks-bill/L0Z0K2aXV_US_en_US, https://peopleops.solutions/2025/10/24/multi-level-bill-approvals-in-quickbooks-online-advanced-with-exceptions/

### Payment limits (QuickBooks Bill Pay)

- Same structural model as BILL: Intuit assigns and manages a rolling processing limit per account based on payment history/risk profile; the org does not set this itself. A payment counts against the limit for 30 days after being scheduled, freeing back up on day 31. Source: https://quickbooks.intuit.com/learn-support/en-us/help-article/increase-limit/learn-payment-processing-limits-quickbooks-bill/L3jVcLvTb_US_en_US

### Vendor verification / expense claims policy

- No documented org-configurable vendor verification/KYB policy inside QBO itself — vendor bank-change confirmation flows of the kind BILL has were not found in QBO documentation; QuickBooks Bill Pay is functionally a thin bill-pay layer, so equivalent fraud controls (if any) likely live at the payment-processing-partner level rather than as an admin-facing policy.
- No dedicated "expense claims policy" module comparable to a T&E product exists in core QBO; that space (per-diem limits, receipt requirements, spend categories) belongs to QuickBooks' separate products or third-party integrations, not standard QBO.

### What SMBs get by default (zero config)

- Nothing preventive is on by default. Close-the-books is off until an admin turns it on. Duplicate check-number and duplicate bill-number warnings are on by default in most QBO installs per community reports, but they are warn-only and easily disabled, and the bill-number check is narrow (same vendor + same number).
- No approval workflow of any kind exists on Simple Start/Essentials/Plus — the majority of SMB QBO installs — since that requires paying up to QBO Advanced or Bill Pay Elite.
- Role/permission separation exists in a basic form (QBO has user roles), but the granular bill-clerk/bill-payer separation described above is also an Advanced-tier feature, not available to base-tier SMBs.
- Net effect: a typical small QBO org, unconfigured, has essentially no payment control beyond a same-vendor/same-number bill warning and whatever check-number warning is on. Everything else is manual discipline.

### Notable gaps / complaints

- Long-standing, still-active community threads (spanning at minimum several years given repeated re-asks) complain that QBO's duplicate-bill check is too narrow and misses real duplicates — different vendor-name spellings, re-imported bills, or a bill later reappearing as a separate expense/bank transaction all slip through. Source: https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/entering-bills-in-a-p-system-and-there-is-no-system-check/00/979239 and https://invoicedataextraction.com/blog/prevent-duplicate-bills-in-quickbooks-online
- Approval workflows being Advanced-only is repeatedly flagged as a paywall for SMBs who most need the control but are priced out of it. Source: https://leetcode.com/discuss/post/7945796/advanced-faq-how-to-enable-an-approval-w-m6i2/ (aggregation of QBO community/blog complaints), https://www.dancingnumbers.com/enable-an-approval-workflow-in-quickbooks-online/
- Where workflow rules do exist (Advanced), users report the conditional-rule setup is fiddly and rigid for anything beyond simple amount thresholds, and workflows only cover invoicing/bill approval — not purchase orders or estimates, so orgs needing broader policy coverage have to bolt on third-party tools.
- Community reports of QBO silently changing default settings (e.g. invoice messaging, AI features) without notifying admins — a trust issue distinct from payment controls but relevant to "policy predictability." Source: https://quickbooks.intuit.com/learn-support/en-us/other-questions/why-did-qbo-change-my-default-settings-when-sending-an-invoice/00/1555054

## What Decimal should steal / avoid

Steal:
- BILL's Dual Control pattern (opt-in, single second-approver sign-off, restricted to a defined approver set) is a clean, low-friction fraud control for sensitive actions like vendor bank-account edits — worth replicating as an explicit, named toggle rather than folding it into general approval routing.
- QBO's close-the-books with warn-vs-password enforcement levels, plus an exceptions report, is a good model for a lightweight "lock the period" control that's cheap to build and gives real audit value.
- BILL's non-retroactive policy semantics (a policy edit only binds bills created after the change) is the right default — it avoids silently rewriting the compliance basis of already-approved payments, and Decimal's engine should adopt this rule explicitly.
- The "fail closed on timeout" behavior on QBO's 30-day approval-release timeout is a good pattern for any pending-approval state in Decimal — stale approvals should default to denied, not silently expire into paid.

Avoid:
- Neither product gives the org real control over the payment ceiling — it's imposed and adjusted by the platform based on internal risk scoring, with no visibility into the model. This is a recurring source of user frustration (support tickets, delays) and directly contradicts Decimal's transparent-pricing/no-black-box positioning; Decimal should let orgs see and reason about their own limits.
- BILL's vendor bank-change confirmation is non-blocking by design ("confirmation isn't required to schedule payments") — this is a real gap since the exact scenario it's meant to catch (BEC bank-swap fraud) is also the scenario where speed matters most; Decimal should default this to blocking unless explicitly relaxed.
- QBO's duplicate-bill check is too narrow (same vendor + same number only) and is frequently cited as inadequate; Decimal should do real duplicate detection (amount + vendor + date proximity + line-item similarity), not just an exact key match.
- Gating any approval/workflow control behind a premium tier (QBO Advanced) leaves the SMB segment — Decimal's target — with effectively zero policy enforcement by default; Decimal's differentiation should include shipping meaningful default controls (duplicate detection, a basic approval gate) at the base tier, not behind an upsell.
- BILL's audit-trail opacity during disputes (users report BILL withholding full logs backing its own fraud determinations) is a trust failure Decimal should explicitly avoid — org admins should always have full access to the audit trail behind any block/flag/approval decision made on their own account.

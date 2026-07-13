# QuickBooks Online — Bill Approval & Payment Release Workflow Mechanics

## 0. Product surface
- Bill approval + payment release workflows require **QBO Advanced or Bill Pay Elite**. Two **separate chained workflow types**: (1) Bill approval (accrual side) and (2) Payment release approval (cash side) — distinct control points, separate config. ([Intuit: bill approval & payment release workflows](https://quickbooks.intuit.com/learn-support/en-us/help-article/manage-workflows/set-use-bill-approval-payment-release-workflows/L1IOLL9hv_US_en_US), [Insightful Accountant launch](https://blog.insightfulaccountant.com/intuit-launches-payment-release-approvals-for-quickbooks-bill-pay))
- The general Workflows engine has 60+ templates (reminders/notifications); bill/invoice approval is one category.

## 1. Creation UX
- ⚡ icon → Templates → e.g. "Set up bill payments release approval" → Create.
- Templates: "Bill Approval", "Bill Multi-condition Approval", "Set up bill payments release approval", invoice-side "Invoice approval". ([Ramp](https://ramp.com/blog/quickbooks-approval-workflow), [Method.me](https://www.method.me/blog/how-to-enable-an-approval-workflow-in-quickbooks-online-invoice/))
- **"When this happens → Do this" block pairs**: conditions on amount, vendor (+customer/location on invoice side); "Add Condition" stacks conditions (AND-like); repeated When/Do pairs = crude else/OR branches. Comparator set only ("greater than", "equal to") — not an expression language.
- **Single active workflow per transaction type** — creating a second errors ("there is already another workflow active"). Everything crams into one workflow's branches. ([Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/can-you-set-up-multiple-bill-approval-workflows/00/1097660), [PeopleOps](https://peopleops.solutions/2025/10/24/multi-level-bill-approvals-in-quickbooks-online-advanced-with-exceptions/))

## 2. Routing semantics (Bill Pay Elite = the current capable layer)
- **Approval groups**: up to **7 people** per stage.
- **Per-group quorum threshold**: any one / specific number (N-of-M) / everyone.
- **Sequential layers**: up to **5 groups**; Group B only starts (and is only notified) after Group A's threshold clears — notify-when-active, not broadcast.
- **Amount-tiered branching** via condition branches ($1,000–$5,000 → A then B; other tier → one approver).
- Older base-Advanced tier had single-approver/single-condition limits (conflicting third-party reporting = versioning inconsistency, not contradiction).
- **Reported bug**: in sequential setups, the first "Approve" sometimes registers as BOTH approvals — the sequential gate doesn't always hold. (community)

## 3. Lifecycle
- **Trigger**: saving a matching bill prompts "Send for approval" vs "Close" (send later → sits in "Needs approval"). UX friction: a missed second click leaves the bill silently unsent.
- **Approver surfaces**: Dashboard Task widget, Tasks menu (Actions → View/edit → Approve/Deny), email on their turn, mobile approve/reject.
- **On reject**: returns to the bill clerk — but **a rejected bill cannot be resubmitted through the workflow**; a brand-new bill must be created. (community synthesis; flagged limitation)
- **On approve**: ready-for-payment; approval alone never pays — Bill Payer role and, if configured, the release workflow must clear.

## 4. Edge cases & defaults
- **Creator-is-approver (or creator-is-admin) → AUTO-APPROVED**, bypassing the workflow. Explicit SoD hole. ([Ramp], [Method.me])
- **30-day auto-deny** on both stages, treated as a hard terminal state (community asks how to un-deny). ([Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/can-i-approve-an-invoice-that-has-been-auto-denied-approval/00/1376335))
- **No trusted-vendor fast path** — every matching bill routes every time.
- **Edit-bill-mid-approval**: behavior undocumented (open question).
- **Workflow edits are prospective only** — in-flight bills continue under the old conditions; but NO versioning UI/audit of which version a bill ran under.
- **No delegation/vacation coverage** — absent approver = bill stalls until manual reassignment or the 30-day kill. Most-repeated complaint. ([Stampli](https://www.stampli.com/blog/accounts-payable/accounts-payable-workflow-quickbooks/))
- **Admin bypass**: admins can pay directly, skipping the workflow.
- **Bulk-imported bills (CSV/Transaction Pro) may not trigger the workflow at all.** ([PeopleOps])
- Generic "we couldn't approve this task" errors in support threads.

## 5. Payment release specifics
- Second independent stage; typical pattern = CEO/CFO authorizes fund release distinct from bill-level approval.
- Release approvers: **admins only**. Same engine: When/Do conditions on payment amount/vendor, 7-person groups, any/N/all, 5 layers, its own 30-day clock.
- Three-role separation: Bill Clerk → Bill Approver → Bill Payer; one person may hold several, called out as weakening the control.

## 6. Consolidated complaints
1. Single active workflow per type. 2. No delegation/OOO. 3. Creator auto-approval SoD hole. 4. No reject→resubmit. 5. Admin bypass. 6. Weak reporting/audit (approver + date only). 7. No capture/PO matching upstream. 8. Bulk-import bypass. 9. Sequential-gate bug. 10. Basic comparator conditions. 11. Unexplained errors. 12. ApprovalMax exists specifically to patch these gaps. ([ApprovalMax](https://approvalmax.com/features/approval-workflows))

## 7. Design abstractions worth stealing
- **When-this-happens / Do-this** as the authoring metaphor — legible to non-engineers.
- **Approval group + per-group quorum** (any/N-of-M/all) — decouples "who's in the pool" from "how many must say yes." We already have this.
- **Notify-only-when-active** sequential layers — approvers see it only on their turn (QBO chose reduced noise over full-pipeline transparency; decide deliberately).
- **Prospective-only edits + snapshot the workflow onto the transaction at submit** — QBO does the former but not the latter (audit gap). Decimal should stamp the policy version onto each bill (our engine already versions policies — expose it).
- **Anti-patterns to design out**: single-workflow ceiling (our 3-stage structural pipeline already avoids it), reject-with-no-resubmit, delegation vacuum + blunt 30-day kill, creator-auto-approval (our R-rules make this a hard invariant, not a warning).

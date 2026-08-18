# Who can withdraw a submitted invoice, and until when?

Date: 2026-08-18
Scope: Bill.com, Ramp, Tipalti, Stampli, Melio, Coupa, SAP Concur, NetSuite, QuickBooks Online, Xero — plus
general workflow-engine comparators Salesforce, ServiceNow, Jira/Atlassian, Workday. Prior research in this
project already covers role archetypes, record-level scoping, the pre-approval bill lifecycle, out-of-chain
intervention (delegation/reassignment/admin override), and payment release — none of that is repeated here.
This file fills the one gap a previous pass explicitly set aside: **recall / withdraw / unsubmit** — a
submitter (or someone else) pulling an already-submitted item back out of an in-flight approval workflow.

**The rule under test:** only the person who submitted a bill may recall it (not an admin, not an approver,
not another clerk with the same role); recall is allowed only while no money has moved; resubmitting compiles a
fresh approval plan, so prior approvals do not carry over.

## Method note

Direct documentation fetches (official help centers, developer/API references, and — where a vendor's own help
portal was JS-gated — the `r.jina.ai` text-extraction proxy against the same URL, or the vendor's own public
GitHub docs source) were the primary method, per this project's prior experience that WebSearch alone degrades
badly. Where a primary doc could not be reached despite genuine effort, that is stated plainly as "could not
verify" rather than papered over. WebSearch was used only as a discovery/route-finding step to locate the right
doc URL, never as the sole evidence for a claim, except where explicitly flagged as lower-confidence.

Coverage note: **Coupa's AP Invoice object is normally submitted by the external supplier**, not an internal AP
clerk — structurally different from the other nine products, where the "submitter" is an internal employee. This
is flagged inline wherever it matters, because it changes what "the submitter" even means for that one case.

---

## 1. Who can withdraw

**The dominant pattern across the whole set: the closest analogous action is gated by role/permission, not by
submitter identity.** Only a minority of products/platforms make the action itself contingent on "you are the
original submitter"; most instead ask "do you hold a role/permission that includes this action," which any
holder of that role can then exercise on *any* record, not just their own.

- **Bill.com** — no submitter-specific feature. "Unapprove" (remove all assigned approvers) and "Delete" are
  both gated on the **"Manage Bills/Vendor Credits"** permission, held org-wide by **Accountant, Administrator,
  Clerk**, and explicitly *not* by Approver, Payer, or Auditor (SOURCED: help.bill.com role matrix,
  360000024183). Any qualifying role can act on any bill, not just one they created. Approver push-back is a
  separate, distinctly-named action, **"Deny"** (SOURCED: 360000018023).
- **Ramp** — **nobody** can withdraw a submitted bill; Ramp states this as a deliberate product gap: **"Ramp
  does not provide a way to revert a bill to draft, recall a bill, or unapprove a bill once it has been
  submitted for approval"** (SOURCED: support.ramp.com, Bill-lifecycle article). Pre-submission Delete is
  **admin-only**; post-approval payment Cancel is also **admin-only** ("Accounting roles and Accounts Payable
  roles do not have this option" — SOURCED, same article). Approver push-back = **"Reject,"** a separate act.
- **Melio** — no submitter-withdraw feature exists for the *bill*-approval gate at all (SOURCED: Melio's own
  Roles & Permissions matrix lists no such row). Melio is a **partial hybrid** on the adjoining *payment*-approval
  gate: "Cancel payment" is open to Owner/Admin/Accountant for anyone's payment, but restricted to **"Only if
  they created"** for the lowest role (Contributor) — the one place in this whole research set where a lower
  role is explicitly submitter-gated while higher roles are not (SOURCED: help.melio.com Roles & Permissions).
  Approver push-back = **"Decline,"** separate at both the bill-approval and payment-approval gates.
- **Tipalti** — six distinct, role-gated mechanisms (Send back to AP, Dispute, Retract, Delete-from-Pending-
  payment, Hold/Release hold, Cancel payment), every one keyed to a role (Bill approver, AP Processor, Finance
  Approver/Manager) rather than to "you submitted this" (SOURCED: help.tipalti.com, multiple articles cited in
  the per-product detail below). Any qualifying role can act org-wide.
- **Stampli** — **"AP staff can recall invoices for corrections and re-dispatch them"** (SOURCED:
  stampli.com/resources/approval-workflows-in-accounts-payable/) — role-based ("AP staff"), not restricted to
  the original submitter. Distinct from approver **"Reject"** and approver **"Not Mine"** (misrouting redirect)
  — three separate, separately-named mechanisms.
- **Coupa** — split by document type. **Requisitions**: the status enum includes a literal `withdrawn` value
  (SOURCED: docs.coupa.com Requisitions API field reference) — behavior described by search-derived, lower-
  confidence evidence as requester-initiated. **Service Sheets**: withdrawal is a named action available "in
  Pending Approval status" (SOURCED: compass.coupa.com); the parallel **Void** action (for already-approved
  documents) is role-gated (**"Service Sheets - All"** permission) *except* one carve-out where creator identity
  does matter: **"if a buyer created a service sheet, only the buyer can void it"** (SOURCED, same page).
  **Invoices** (buyer-received, normally supplier-submitted): no withdrawal mechanism for the submitter at all —
  **"Once an invoice is submitted, it can't be changed in any way"** (SOURCED: compass.coupa.com Invoices FAQ);
  the only reversal lever belongs to the **buyer**, via Dispute or Void, not the document's submitter.
- **SAP Concur** — three sub-products, three different answers, all SOURCED directly:
  - *Concur Expense* (report): **"Recall"** — submitter **or their delegate** — SOURCED, community.concur.com
    (SAP Concur Team-authored FAQ): "you (or your delegate) can recall an Expense Report." **Admins can also
    recall or delete a report**, via a separate admin-only path (Administration > Payment Manager > Monitor
    Payees), gated on the report being in an open, on-hold batch — a second, distinct mechanism, not the same
    button. Approver push-back is a third, distinct, named action: **"Send Back to Employee"** (SOURCED: SAP's
    public GitHub docs source, `post-report-workflow-action.markdown`).
  - *Concur Invoice* (the actual AP vendor-invoice/payment-request object): **"Recall an Invoice"** — described
    as an **invoice-owner** action (SOURCED: help.sap.com end-user doc, via jina proxy) — but this is a
    company-configurable feature ("Your company may or may not use this feature") and no admin-recall or
    approver-push-back equivalent was found documented for this specific object.
  - *Concur Request* (Purchase Request, a pre-purchase approval object distinct from the vendor invoice):
    submitter-only, no admin path found — **"You can recall a purchase request that you have submitted but
    that your approver has not yet approved"** (SOURCED: help.sap.com/docs/CONCUR_INVOICE, "Recall a Purchase
    Request").
- **NetSuite** — **Cancel** is a general record-permission action (the "Bills" transaction permission), not
  submitter-gated: **any** user whose role has bill-edit access can cancel someone else's pending bill (SOURCED:
  docs.oracle.com). Approver **Reject** is a separate, approver-only action ("Only the current approver can
  approve or reject the record" — SOURCED). **Resubmission is explicitly open to more than the original
  submitter**: **"The transaction creator and users with access, except the current approver, can update and
  resubmit the record"** (SOURCED) — a sharp, direct contrast with Decimal's submitter-only rule.
- **QuickBooks Online (Advanced)** — **no submitter-withdraw feature exists at all.** Three mutually exclusive
  roles (Bill Clerk, Bill Approver, Bill Payer) exist, but none of them includes a "recall my own submission"
  action (SOURCED: quickbooks.intuit.com Roles & Permissions article, via proxy). The only lever once a bill is
  routed is the approver's **"Deny."** Notably, **QBO does not enforce submitter≠approver separation** — "If the
  approver is also the person creating the bill, QuickBooks auto-approves it" (SOURCED via proxy + independent
  corroboration) — the opposite of NetSuite's explicit rule.
- **Xero** — **no native UI withdraw/unapprove feature exists, confirmed directly by Xero itself, repeatedly,
  over multiple years**, in two long-running public product-idea threads with staff replies: "Bills - Option to
  unapprove" (670 votes; Xero Community Manager: *"it's not in our roadmap atm"*) and "Invoices - Unapprove
  option" (519 votes; *"it's not something we have plans to develop"*) (both SOURCED, productideas.xero.com).
  The only undo action is **Void**, a generic terminal action gated by role, not by submitter identity, and not
  differentiated by *why* someone wants to undo the bill. Xero also treats self-approval as normal, intended
  behavior for Standard/Adviser users (SOURCED/corroborated), unlike NetSuite's explicit prohibition.

**Comparator platforms (general approval engines):**

- **Salesforce** — the sharpest, most explicit "submitter recall" feature found in the entire research set, and
  now confirmed at the API-schema level, not just the admin-UI PDF. The Metadata API field description for the
  approval-process's recall setting reads, verbatim: **"Whether to allow submitters to recall approval requests.
  If set to false, only administrators can recall approval requests"** (SOURCED, Salesforce Metadata API
  Developer Guide, `meta_approvalprocess.htm`, field `allowRecall`). This directly confirms, in Salesforce's own
  schema documentation rather than inferred from search results, that the platform's *default* fallback when
  submitter-recall is switched off is **admin recall — not "nobody," and not "only the submitter, ever."** Even
  Salesforce's own recall setting is a two-position switch between "submitter can" and "only admin can," never
  a hard "submitter-only, full stop." Approver push-back (**Reject**) and approver **Reassign** are two further,
  separate, distinctly-enumerated actions (`ProcessInstanceStep.StepStatus` includes `Rejected` and `Reassigned`
  as separate values from `Removed`, the status a step takes on recall) — SOURCED, Salesforce Object Reference,
  `sforce_api_objects_processinstancestep.htm`.
- **Jira Service Management** — genuinely confirmed absent, not merely undocumented. The public Approvals REST
  API (SOURCED, developer.atlassian.com, `api-group-request/#api-request-issueidorkey-approval-*`) exposes
  exactly one participant action on an approval object: **answer** it, with a decision of **approve** or
  **decline** (`finalDecision` enum: `approved`, `declined`), gated on `canAnswerApproval` /
  "User is assigned to the approval request." There is no cancel, withdraw, or recall endpoint anywhere on that
  API surface — the word "recall" does not appear. This is the cleanest negative finding of the whole
  comparator set: a modern, actively maintained approval API that was simply never built with a pull-back
  action at all, only approve/decline by the assigned approver.
- **Workday** — the one platform in this entire research pass (AP products included) that documents an undo
  path operating *after* the terminal action, and it does so by naming two deliberately different verbs for two
  different windows. **Cancel**: *"Canceling a business process stops the workflow in progress and reverses
  changes made to data. **You can't cancel a completed business process; you must rescind it.** A securable
  action in a business process security policy"* — SOURCED, Workday Administrator Guide, full glossary
  (`doc.workday.com/admin-guide/en-us/glossary/full-glossary-of-terms.html`). Read closely: Cancel is scoped to
  **in-progress, not-yet-completed** processes — matching every other product's "before the terminal action"
  shape — but Workday then names a second, separate action, **Rescind**, whose entire documented purpose is
  undoing a process **after** it has completed. Workday does not describe Rescind as time-boxed or restricted in
  the glossary entry, and it is explicitly framed as the *required* mechanism once Cancel is no longer available
  ("you must rescind it"), not as an exceptional emergency override. Both Cancel and Rescind are gated by
  **security policy** (role/permission), not submitter identity — consistent with every AP product above.
  Separately, **Deny** (the approver's rejection) carries the clearest resubmit-carryover statement found in
  this entire research pass, general engines included: *"When you deny a business process, the business process
  is terminated and all Workday data is restored to its state before the business process started. To restart
  the business process, you need to submit the process again, and redo all previously completed steps"* —
  SOURCED, same glossary. That is an explicit, vendor-stated "no carryover, full restart," in plainer language
  than any AP product in this file manages. A fifth action, **Correct** ("changes a specification or data in the
  workflow while in progress"), is also documented as distinct from all four of the above.
- **ServiceNow** — **could not verify.** A genuine, repeated effort was made (direct fetches against
  `docs.servicenow.com`/`www.servicenow.com/docs` under multiple release names for the `sysapproval_approver`
  table reference and the Approvals landing page, ~15 URL variants tried) but every guess either 404'd or
  silently soft-redirected to the generic docs homepage — ServiceNow's public doc site could not be reliably
  navigated without a working search index, which was unavailable for this pass. This is a tooling limitation,
  not evidence that ServiceNow lacks the feature; it should be treated as fully open, the one product in the
  fourteen-product comparison set with zero sourced findings on any of the six questions.

---

## 2. Until when — the cutoff

This is the single most varied answer across the set — there is no consensus "stage" at which withdrawal closes.

| Product | Documented cutoff | Basis |
|---|---|---|
| Bill.com | Any time before the bill is paid/partially paid or has a *scheduled* payment (cancel the scheduled payment first, then delete/unapprove) | SOURCED |
| Ramp | **Never**, once submitted — the only pull-back points are Delete (pre-submission only) and payment-Cancel (pre-initiation only) | SOURCED |
| Melio | No cutoff to state for bill-approval (feature doesn't exist there); for the *payment* stage: "up until it's processed... status 'Scheduled'... once 'In process,' you can no longer cancel it" | SOURCED |
| Tipalti | Unusually late: bill-level unwind (Retract, Delete-from-Pending-payment, Hold) works even **after full approval and after ERP sync**; the hard stop is money movement — "if you cancel the payment before it has been processed" | SOURCED |
| Stampli | Not explicitly stated as a status gate for **Recall** itself; the adjacent Cancel/Void split is explicit — Cancel pre-GL-posting, Void post-posting (even post-payment-execution, as "recovery territory") | SOURCED (Cancel/Void split); Recall's own cutoff = INFERENCE from context only |
| Coupa (Requisition) | Enum includes `withdrawn` as a state reachable from `pending_approval` | SOURCED (enum); precise trigger point not independently re-verified this pass |
| Coupa (Service Sheet) | Exactly stated: **"You can withdraw service sheets in Pending Approval status"** — i.e. any time before *final* approval completes, not just before the first approver acts | SOURCED |
| Coupa (Invoice) | No cutoff to state — withdrawal doesn't exist for the submitter at any point | SOURCED |
| SAP Concur (Expense) | Exact and generous: **"at any time prior to a report status of Pending Payment"** — i.e. through the entire approval chain, even after full approval, right up to the payment step | SOURCED |
| SAP Concur (Invoice) | Stated as usable "after you have submitted it," no explicit terminal status named | SOURCED (existence); cutoff = could not verify precisely |
| SAP Concur (Request) | Tightest cutoff found anywhere in this research: only **before the (single) approver has acted** — not through a whole chain | SOURCED |
| NetSuite | Sharp and strict: **"After a bill is approved, the status can't later be changed to Pending Approval or Canceled"** — cutoff is purely approval-status-based (locks the instant the *last* approval lands), with no reference to whether money has moved | SOURCED |
| QuickBooks Online | No cutoff to state (feature doesn't exist for the submitter); payment-side Cancel is time-boxed — "before 5pm on the day it's set to be credited," even if already "Processed" | SOURCED |
| Xero | No cutoff to state in the live UI (feature doesn't exist); the underlying API schema is more permissive than the UI exposes — SUBMITTED↔DRAFT is a legal API transition, but AUTHORISED has only one exit, VOIDED | SOURCED |
| Salesforce | Governed by the record's `ProcessInstance` remaining open (not yet fully approved) — the PDF guide frames recall as pulling back "a submitted... request," implying availability while a decision is still pending, consistent with the `Removed` status value coexisting with Approved/Rejected/Pending in the same enum | SOURCED (status enum) + INFERENCE (exact boundary) |
| Workday | A genuine fourth shape: **Cancel** works only pre-completion ("stops the workflow in progress"); **Rescind** is the named, undocumented-as-time-boxed mechanism for **after** completion ("You can't cancel a completed business process; you must rescind it") | SOURCED |
| Jira Service Management | No cutoff to state — no recall/withdraw mechanism exists in the documented Approvals API at any stage; only the assigned approver's approve/decline | SOURCED (absence, from the API reference) |
| ServiceNow | Could not verify — no ServiceNow documentation was reachable this pass | GAP |

**Reading across the table:** the cutoffs cluster into four shapes, and they do not track "money moved" as a
group:
1. **Approval-status gated, closes at full approval** (NetSuite; Coupa Service Sheets; Concur Request) — the
   moment the record is fully approved, reversal-as-recall is over; only a *different*, heavier mechanism
   (Void, or nothing at all) remains.
2. **Payment/money-movement gated, stays open through and even after full approval** (Tipalti; SAP Concur
   Expense; and Bill.com's/Melio's cancel-the-scheduled-payment-first pattern) — this is the shape closest to
   Decimal's own "no money moved" rule, and it's well represented, not an outlier.
3. **No cutoff because there is no mechanism** (Ramp, QuickBooks Online, Xero for bills; Jira Service Management
   in the general-engine set) — the question of "how late" doesn't arise because the feature was never built
   for the submitter in the first place.
4. **Two verbs, two windows, no wall at all** (Workday) — rather than closing the door at approval or at
   payment, Workday just renames the door: Cancel before completion, Rescind after. This is worth flagging
   directly against Decimal's own framing, because it's evidence that "the cutoff must be a hard stop" is a
   choice, not an inevitability — a platform can instead choose to keep an undo path open indefinitely and
   simply change its name and its cost (an offsetting reversal instead of a state rollback) once the terminal
   action has fired. Tipalti's Retract (a credit-memo-based post-sync correction, see the per-product detail
   above) is this same shape showing up in an AP-specific product, not just a generic workflow engine.

---

## 3. What happens to approvals already collected on resubmit

**Where documented, the answer is consistently full restart — no product in this research set claims explicit
partial carryover of prior approval decisions.**

- **Bill.com** — SOURCED, explicit: on the deny→edit→reassign path, **"The bill will be reassigned to all
  approvers, re-starting with the first approver."**
- **Ramp** — SOURCED, explicit: after reject+edit+resubmit, **"it will re-enter the approval workflow from the
  beginning."** (This is the reject-triggered restart; consistent with, but a separate finding from, the
  already-known material-edit-triggered restart rule.)
- **Melio** — could not verify definitively for the bill-approval chain; SOURCED only for the payment-decline
  path, where there is no in-place resubmit at all — **"you need to cancel it, and create the bill again"** —
  which trivially means zero carryover because it's a new object.
- **Tipalti** — SOURCED for the Retract path on PO-backed bills: **"The original bill will be deleted and a new
  bill will be created"** — zero carryover by construction. For the ordinary send-back-to-AP path, restart is
  INFERENCE (strongly implied, not stated in so many words).
- **Stampli** — SOURCED, explicit and clean: **"AP staff can recall invoices for corrections and re-dispatch
  them, triggering fresh workflow evaluation"**; separately, **"Changes require recall and re-dispatch to apply
  updated workflow logic."** This is the most direct match in the whole set to Decimal's own "fresh plan on
  resubmit" language.
- **Coupa** — could not verify a specific "prior approvals wiped" statement for Requisitions or Service Sheets
  beyond the state-machine implication that returning to `pending_approval` implies a new pass; not directly
  sourced.
- **SAP Concur (Expense)** — SOURCED, explicit and unambiguous: **"The Workflow on the report is reset."**
- **SAP Concur (Invoice/Request)** — could not verify a resubmit-specific statement beyond the recall action
  itself existing.
- **NetSuite** — INFERENCE from two adjacent facts, both SOURCED: resubmission re-enters the **Entry** state and
  rules are re-evaluated against current record data ("If there is no active rule found... exits. If an active
  rule is found, the SuiteApprovals workflow initiates"); separately, the Approval History subtab is cumulative
  and **old approval events are not erased**, they simply stop counting toward completing the (recompiled) plan.
  Net: a fresh plan, but with the old history still visible — not literally described as "prior approvals
  discarded" in the docs.
- **QuickBooks Online** — could not verify; no documentation found describing partial-approver-state behavior on
  resubmission at all.
- **Xero** — not applicable; Xero has no multi-step/partial-approval concept to carry over or discard in the
  first place (one click = fully Authorised).
- **Salesforce** — could not independently verify this pass beyond the status-enum evidence; Salesforce's
  object model (a fresh `ProcessInstance` per submission, with prior instances retained in `ProcessInstance`
  history) is consistent with a fresh plan on resubmit, but this is INFERENCE, not a directly sourced statement.
- **Workday** — SOURCED, the single clearest, most explicit statement of this exact rule found anywhere in the
  entire research pass, general engines and AP products both: **"When you deny a business process, the business
  process is terminated and all Workday data is restored to its state before the business process started. To
  restart the business process, you need to submit the process again, and redo all previously completed
  steps."** This is Decimal's own "fresh plan, no carryover" rule, stated by a different vendor in almost the
  same words — worth quoting directly if this document is ever summarized externally. One caveat: the quote is
  documented under **Deny** (the approver's rejection), not explicitly under **Cancel** or **Rescind** — it is a
  reasonable INFERENCE, not a direct statement, that the same restart applies after those two as well, since all
  three terminate the process instance before a fresh submission.
- **Jira Service Management** — not applicable; there is no recall/withdraw mechanism to have a resubmit
  behavior in the first place (see Q1/Q4).
- **ServiceNow** — could not verify.

---

## 4. One mechanism or several?

**Every product that documents this at all treats submitter-recall, approver-reject, and any admin-level unwind
as separate, distinctly-named actions with separate permissions — none folds them into a single button.** The
degree of granularity varies widely:

- **Most granular: Tipalti** — six distinctly named, separately documented mechanisms (Send back to AP, Dispute/
  Cancel dispute, Retract, Delete-from-Pending-payment, Hold/Release hold, Cancel payment).
- **Three-way split, the most common shape**: Bill.com (Deny / Unapprove / Delete), NetSuite (Reject / Cancel /
  Resubmit-by-non-approver), Stampli (Reject / Not Mine / Recall), SAP Concur Expense (Send Back to Employee /
  Recall / admin Payment-Manager recall).
- **Two-way split**: Ramp (Reject / Cancel-payment, with Delete only pre-submission), Melio (Decline at each of
  two gates / Cancel payment), Coupa (approve-reject via the generic Approvals API / a document-type-specific
  Withdraw action that isn't part of that same API).
- **One mechanism for everything, the outlier**: **Xero** — a single generic **Void** covers "wrong data,"
  "shouldn't have approved," and "duplicate" alike, with no distinction by cause or actor intent. This is the
  clearest point of contrast in the whole set.
- **No mechanism at all for the submitter side**: Ramp (post-submission) and QuickBooks Online — in both cases
  the only lever is the approver's reject/deny; there's nothing to "split" because the submitter side of the
  split was never built.
- **Salesforce**: cleanly three-way — submitter/admin **Recall**, approver **Reject**, and approver
  **Reassign** — each independently named and independently enumerated as a distinct `StepStatus` value
  (`Removed`, `Rejected`, `Reassigned`), not merely described in prose. The admin-fallback confirmed by the
  `allowRecall` field description means Recall itself is really "submitter, or admin if submitter-recall is
  switched off" — a single named action with two possible actors, not two separate actions.
- **Workday: the most granular split found in this entire research pass, AP products included** — five
  distinct, independently glossary-defined actions: **Cancel** (stop pre-completion), **Rescind** (undo
  post-completion), **Deny** (approver's rejection, full restart on resubmit), **Approve** (progress to next
  step), and **Correct** (edit data/spec while still in progress, a fourth kind of touch that is neither an
  approval decision nor a withdrawal). All five are independently permission-gated via Workday's "securable
  action in a business process security policy" model. This is a genuinely useful reference point for Decimal:
  a mature workflow engine converged on *more* granularity than our three-way split (submitter-withdraws /
  approver-sends-back / admin-unwinds), not less.
- **Jira Service Management: the outlier at the other extreme** — exactly **one** mechanism exists at all
  (approve/decline by the assigned approver). No submitter action, no admin override, no distinct reject-with-
  reason. Confirmed by the absence of any other action on the documented Approvals REST resource, not merely by
  the absence of a search hit.
- **ServiceNow** — could not verify.

---

## 5. Terminology and status model

**Word choice is scattered — no single verb dominates — but where a literal status enum exists, "Withdrawn" or
"Recalled" (or "Removed," Salesforce's equivalent) shows up more often than not, contrary to what the absence of
a consistent verb might suggest.**

| Product | Literal action name(s) | Status-enum evidence |
|---|---|---|
| Bill.com | Deny, Unapprove, Delete | `approvalStatus`: UNASSIGNED/ASSIGNED/APPROVED/APPROVING/DENIED/UNDEFINED. **No Withdrawn/Recalled/Voided value anywhere** — "BILL doesn't have a void bill option" (SOURCED, explicit) |
| Ramp | Reject, Cancel, Archive, Delete | `status_summary` enum has 16 values, none of them CANCELED/WITHDRAWN/RECALLED/VOIDED (SOURCED, live OpenAPI spec) |
| Melio | Decline, Cancel, Resubmit | No public status-enum doc found; UI terms only: "Ready to pay," "Declined," "Scheduled," "In process," "Paid" |
| Tipalti | Send back to AP, Dispute, **Retract**, Delete, Hold, Cancel | UI statuses: Pending review/approval/AP action/matching/payment, On hold, Requested to cancel. Tipalti is the only product whose docs use "**Retract**" literally — but it names a post-approval AP/admin correction tool, not a submitter self-recall, a materially different sense of the word than Decimal's use of "recall" |
| Stampli | **Recall**, Reject, Not Mine, Cancel, Void, Delete | No public API status enum found; "Recall" and "Reject" are named as distinct "Exception Handling" mechanisms |
| Coupa | **Withdraw** (Requisition, Service Sheet), Void, Delete, Dispute | Requisition `status`: draft/cart/pending_buyer_action/pending_approval/approved/ordered/partially_received/received/abandoned/backgrounded/**withdrawn** (SOURCED, live API field reference). Service Sheet status: Approved/Rejected/Draft/**Withdrawn**/Pending Approval/Voided/Pending Void (SOURCED). Invoice status: Abandoned/Approved/Disputed/Draft/Invalid/Pending Approval/Processing/Voided — **no Withdrawn value** in this one enum, consistent with Q1's negative finding |
| SAP Concur | **Recall** (Expense, Invoice), **Recall Request** (Request/PO) | Expense workflow-action values: Approve / Send Back to Employee / **Recall to Employee** (SOURCED, API docs). No literal Invoice-object status enum with a Recalled value found (the v3 Invoice API has no workflow/status-action surface at all) |
| NetSuite | Cancel, Reject, Resubmit | `approvalstatus` field: only **Approved** / **Pending Approval** — no Rejected/Canceled/Resubmitted value in the base record's own enum (those live as workflow-history labels layered on top, not in the field itself) |
| QuickBooks Online | Deny (no submitter term exists) | The public Bill API entity has **no status field of any kind** — confirmed by attribute-list grep, zero matches for status/approv/review. UI-only labels: "needs approval" |
| Xero | Void (no submitter term exists) | `Invoice.Status` enum: DRAFT/SUBMITTED/AUTHORISED/PAID/VOIDED/DELETED — legal API transitions include SUBMITTED→DRAFT, but **no Rejected/Withdrawn/Cancelled value**, and that reverse transition isn't exposed in the UI at all |
| Salesforce | **Recall** (button/checkbox: "Allow submitters to recall approval requests") | `ProcessInstance.Status` and `ProcessInstanceStep.StepStatus` both enumerate: Approved / Fault / Held / NoResponse / Pending / Reassigned / Rejected / **Removed** / Started (SOURCED, live object-reference API docs). "Removed" is the literal status a record lands in when recalled — the clearest first-class "recall status" of any product in this entire research set. `ProcessInstance.LastActorId` is documented as "The last actor that approved, rejected, **or recalled** the process" — recalled is named as a peer verb to approved/rejected at the field-description level, not just in UI copy |
| Jira Service Management | **Answer** (approve/decline) — no recall/withdraw term exists anywhere in the documented API | `ApprovalDTO.finalDecision` enum: **approved**, **declined** (SOURCED, developer.atlassian.com REST reference). No Withdrawn/Recalled/Cancelled value; the object simply has no concept of being pulled back |
| Workday | **Cancel**, **Rescind**, **Deny**, **Approve**, **Correct** — five distinct verbs, all glossary-defined | No closed status enum found (Workday's public glossary documents these as actions, not as a finite Business-Process-Instance status list, unlike Salesforce's picklists) — **could not verify** whether a formal status enum exists elsewhere in Workday's product/API docs; not reached this pass |

**Pattern:** every product that names the action explicitly as "Withdraw"/"Recall" also gives it a
matching status value (Coupa's `withdrawn`, Salesforce's `Removed`, and — at the workflow-action-name level,
though not confirmed at the object's own status-field level — Concur's "Recall to Employee"). Every product
whose closest analogue is instead named "Cancel," "Delete," "Deny," or "Void" tends to **not** carry a distinct
recall-flavored status value — those products model the reversal as erasing/terminating the record rather than
returning it to the submitter, which is a real, sourced product-design distinction, not just a naming quirk.

---

## 6. Audit and notification

**Every product that discusses this at all confirms an audit-trail entry is written; explicit confirmation that
*other pending approvers are actively notified* (versus the item just disappearing from their queue) is rarer
and was only clearly sourced for two products.**

- **Bill.com** — SOURCED: deny → email to the bill creator; deleted bills remain visible with their audit trail
  intact ("You can still view the deleted bill and the audit trail documenting the denied details"). Whether
  *other* mid-review approvers are notified on Unapprove/Delete: could not verify.
- **Ramp** — could not verify either audit-log or mid-review-approver-notification specifics; only the reject-
  triggered restart was sourced, which implies the record isn't silently erased, but no explicit notification
  statement was found.
- **Melio** — SOURCED, three separate confirmed notification triggers: decline → email to both parties; approval
  → email to submitter; payment cancel → email confirmation. A dedicated, Owner/Admin-only "Audit trail reports"
  permission exists (confirms the feature; exact event coverage not independently confirmed). Notification of
  *other* mid-chain approvers specifically: could not verify.
- **Tipalti** — SOURCED: payment cancel → email to both payer and payee; a "Requested to cancel" state is itself
  a timestamped, visible audit artifact; post-approval edits are explicitly logged ("Tipalti records edits after
  approval in the bill's audit history"). Notification of other mid-review approvers on Retract: could not
  verify.
- **Stampli** — SOURCED at a general level ("Workflow audit trail captures every approval action, decision, and
  status change... how exceptions were resolved" — recall falls under "exceptions"), but no explicit statement
  that a specific mid-review approver receives a notification when an item is pulled: could not verify.
- **Coupa** — SOURCED for Service Sheets specifically: on a Void completing, **"The person who requested the void
  receives a notification, as does the supplier (if you weren't the requester)"** — a clear, explicit
  notification finding, though for the Void path, not the Withdraw path. Withdraw-specific notification: could
  not verify.
- **SAP Concur (Expense)** — the strongest, most explicit finding in the whole research set for this question,
  SOURCED verbatim: **"An entry is written on the Audit Trail of the report. An email notification (if
  configured to do so) is sent to the report's pending approver and to any approver delegate."** This is a
  direct, positive confirmation that a specific mid-review actor is told, not just that the item vanishes.
- **NetSuite** — SOURCED: a permanent Approval History subtab and general System Notes log every status change.
  **Explicitly confirmed gap**: the official SuiteApprovals notification matrix documents approve/reject/
  resubmit/delegation-change notifications but has **no entry for "record cancelled while pending"** — a
  documented absence, not an unconfirmed one.
- **QuickBooks Online** — SOURCED, but thin: "QuickBooks logs who approved or denied each bill and when," a
  third-party audit (Ramp's own blog) independently characterizes the depth as **"Basic (approver + date)."**
  Since no withdrawal action exists in QBO's model (Q1), the "notify a mid-review approver of a pull" scenario
  doesn't arise at all.
- **Xero** — SOURCED: every transaction carries a "History & Notes" panel, and Voided documents are **permanently
  retained**, specifically "to ensure a complete and transparent audit trail." No sourced evidence of any
  notification on Void, and — as with QBO — the underlying scenario (pulling an item from a multi-step chain)
  doesn't exist in Xero's single-gate model.
- **Salesforce** — could not independently verify this pass beyond the status-enum evidence; Salesforce's
  Approval History related list is a standard, documented feature that would be expected to capture a Removed
  event, but this wasn't directly confirmed with a quoted source this pass.
- **Workday, Jira Service Management, ServiceNow** — could not verify for all three. No fetched page (Workday's
  public glossary, Jira's REST API reference) addresses audit logging or approver notification specifically;
  ServiceNow was unreachable entirely this pass. This mirrors the pattern already visible across the ten AP
  products in Q6 above: notification *into* an approver's queue is commonly documented, notification *out of* it
  (i.e., telling a mid-review approver the item they're looking at was just pulled) is rare across the whole
  fourteen-product set, general engines included — only SAP Concur Expense documents it explicitly anywhere in
  this file.

---

## Strong / thin / gap assessment

**Strong** (direct, primary-source documentation or live API/schema fetches, high confidence):
- Bill.com, Ramp — live OpenAPI/API schema fetches plus explicit help-center prose for Q1, Q2, Q3, Q5.
- NetSuite — docs.oracle.com direct fetches covering all six questions with quoted language.
- Xero — the two Xero product-idea threads are unusually strong evidence precisely *because* they're Xero staff
  stating a negative ("not in our roadmap") rather than silence being interpreted as absence.
- SAP Concur (Expense) — the community.concur.com FAQ plus the GitHub-sourced API workflow-action doc together
  answer all six questions with quoted, unambiguous language; the single best-documented product in the set.
- Coupa — three separate, directly-fetched primary sources (Requisition API field table, Service Sheets help
  page, Invoices FAQ) that agree with and reinforce each other.
- Salesforce — the "Allow submitters to recall approval requests" PDF quote and the live `ProcessInstance`/
  `ProcessInstanceStep` status-enum fetch (`Removed`) are both primary-source and specific, and now corroborated
  by a second, independent primary source: the Metadata API's own `allowRecall` field description.
- Workday — the public Administrator Guide glossary is unrestricted and gave clean, directly quotable, on-point
  definitions for Cancel/Rescind/Deny/Approve/Correct that speak precisely to Q2 and Q3; unusually strong given
  Workday's docs were expected to be paywalled.
- Jira Service Management — the Approvals REST API reference (developer.atlassian.com) is a live, rendered,
  primary source; the absence of any recall/withdraw endpoint is a directly observed negative, not an inference
  from missing search results.

**Thin** (real sourced content, but partial, proxy-derived, or missing one side of the picture):
- Melio, Tipalti, Stampli — solid help-center-level sourcing for Q1/Q4/Q5, but Q3 (resubmit carryover) and Q6
  (mid-review notification) rely partly on inference from adjacent facts rather than a direct statement.
- QuickBooks Online — every fetch had to go through a text-extraction proxy (developer.intuit.com and
  quickbooks.intuit.com both blocked direct/bot fetches); content is credible but not independently re-verified
  by a second method.
- SAP Concur (Invoice, Request) — solid on Q1/Q4/Q5, thin on Q2/Q3/Q6; the Invoice object's own cutoff was never
  pinned to a specific status the way Expense's was.
- Salesforce — strong on Q1/Q5, but Q2 (exact cutoff) and Q6 (notification) still rest on inference rather
  than a directly quoted Help article (the Salesforce Help portal itself is JS-gated against every automated-
  fetch method tried this pass, including a text-extraction proxy); Q3 is now better supported by the
  `ProcessInstance`-per-submission model but remains INFERENCE, not a direct quote.
- Workday — strong on Q1/Q2/Q3/Q4, but Q5 (no closed status enum located, only named actions) and Q6 (no audit/
  notification page reachable) are unconfirmed; and the glossary is one document — Workday's actual product/API
  behavior (e.g., whether Rescind is time-boxed in practice, whether out-of-the-box security policy defaults
  restrict Cancel to the initiator) was not independently verified beyond the glossary's own wording.
- Jira Service Management — strong, specific negative finding on Q1/Q4/Q5 (no recall mechanism exists in the
  documented API, full stop); Q2/Q3/Q6 are consequently moot rather than unresolved, since there is no
  mechanism for a cutoff, a resubmit-carryover question, or a recall-specific audit event to apply to. The one
  live gap is whether Jira's help-center prose (unreachable, true client-side-rendered pages) describes any
  ticket-level cancel/withdraw action at the *request* level, outside the Approval object itself.

**Gap** (not obtained, or only partially obtained, this pass — do not assume an answer either way):
- **ServiceNow** — not obtained this pass, despite genuine repeated effort (~15 direct URL guesses against
  docs.servicenow.com under multiple release names, all 404 or soft-redirect). This is now the single largest
  open gap in this file — the only one of the fourteen products/platforms in scope with zero sourced findings
  on any of the six questions. Treat ServiceNow's behavior as a fully open question, not an assumed match to any
  pattern above.
- Whether other mid-review approvers are specifically notified (vs. just losing the item from their queue) —
  confirmed positively for only two products in the whole fourteen-product set (SAP Concur Expense, and Coupa
  for its Void-not-Withdraw path); genuinely unconfirmed either way for the rest, not "no."
- Tipalti's exact carryover behavior on the ordinary (non-PO, non-Retract) send-back-to-AP path.
- Coupa's Requisition-withdraw *trigger* mechanics (who, exactly, and under what precise UI action) — the status
  enum's existence is solid; the behavioral description is search-derived and not independently re-verified
  against a fetched page this pass.
- Salesforce's precise cutoff boundary and whether "Removed" is used *only* for submitter/admin recall or also
  for other terminal-removal scenarios — the enum value is confirmed, its exact scope is not.
- Whether Workday's Rescind is subject to any documented time limit, approval, or downstream-reversal
  requirement (e.g., does rescinding a completed process that already triggered payment actually reverse the
  payment, or only the workflow record?) — the glossary defines the verb but not its full mechanics.

---

## Verdict — does Decimal's rule match the market?

**Decimal's rule: only the submitter may recall; only before money moves; resubmit always compiles a fresh
plan.**

- **On "only the submitter, and nobody else" — Decimal's rule is stricter than nearly everything found.** Every
  product in the ten-product AP set that documents a withdrawal-like mechanism at all gates it by *role*, not
  by *submitter identity*: Bill.com (Accountant/Admin/Clerk, any of them, on any bill), Tipalti (six mechanisms,
  all role-gated), Stampli ("AP staff," not "the submitter"), NetSuite (any Bills-permission holder — and
  explicitly opens resubmission to *any* user with access except the current approver), SAP Concur Expense
  (submitter *or delegate*, **plus** a separate admin path). Only Concur's own Purchase Request sub-feature and
  parts of Melio's lowest role are genuinely submitter-exclusive the way Decimal's rule is. Salesforce is the
  interesting middle case: the primary mechanism is submitter-scoped ("Initial Submitters"), but admin override
  sits alongside it as a second lever, confirmed now not just by search-derived UI evidence but by the Metadata
  API's own field description — *"If set to false, only administrators can recall approval requests"* — so even
  the strongest "submitter recall" precedent in the whole research set still isn't submitter-*exclusive*; it's a
  switch between two non-exclusive actors, never a hard wall against admins. Jira Service Management goes
  further in the opposite direction and simply has no recall concept for anyone, submitter or admin — the
  market's other extreme is "nobody gets this," not "only the submitter gets this." Across all fourteen
  products and platforms researched, **not one implements "the submitter, and explicitly nobody else, including
  admins."** **Decimal's submitter-only restriction, with admins explicitly excluded, is a genuine outlier on
  the restrictive side — the single least-validated clause in the whole rule.**
- **On "only before money moves" — this is generous relative to several incumbents, and squarely mainstream
  relative to others.** It's more generous than NetSuite (locks the instant approval status flips, regardless of
  payment timing) and than Coupa Service Sheets/Concur Request (lock at final approval). It's a close match to
  Tipalti and SAP Concur Expense, both of which explicitly extend the window through full approval and stop only
  at the payment/money-movement boundary — the same shape Decimal uses. Workday complicates the picture usefully
  rather than undermining it: by naming a second verb (Rescind) for the window *after* the terminal action, it
  shows that "the cutoff is a hard wall" is one design choice among others, not the only coherent one — a
  platform can instead keep an undo path open past the wall and simply change its name and mechanism (offsetting
  reversal, not state rollback) once execution has happened. Decimal doesn't need Workday's answer here, but it's
  worth registering as a precedent for the day Decimal needs a post-settlement correction tool, distinct from
  recall, on purpose. **This half of the rule sits comfortably inside the existing spread, not outside it.**
- **On "resubmit always compiles a fresh plan, no carryover" — this is the part of Decimal's rule with the
  strongest, most consistent market backing, and it just got stronger.** Every product with a direct statement
  on this question says the same thing: Bill.com ("re-starting with the first approver"), Ramp ("from the
  beginning"), Stampli ("fresh workflow evaluation" — the closest linguistic match to Decimal's own framing),
  SAP Concur Expense ("Workflow on the report is reset"), NetSuite by strong inference (re-enters Entry, rules
  re-evaluated), and now Workday, whose Deny definition states it as plainly as any vendor in this file has
  stated anything: *"you need to submit the process again, and redo all previously completed steps."* No
  product or platform in this research set — ten AP products and four general workflow engines — claims to
  preserve partial approval progress across a recall-then-resubmit cycle. **This is not an outlier position;
  it's the closest thing to a documented industry norm found anywhere in this file.**

**Overall:** Decimal's rule is directionally aligned with the market on *when* (generous, money-movement-gated,
matching the more permissive incumbents, and not even the most generous option on the table once Workday's
Rescind is in view) and on *what happens on resubmit* (fresh plan is universal everywhere the question is
answered, general engines included), but it is **more restrictive than the market on *who*** — nearly every
comparable product and platform gives this power to a role or permission bundle, not to a single "must be the
exact person who clicked submit" identity check, and several explicitly extend it to admins or delegates as a
deliberate second path rather than a loophole; the one platform (Salesforce) whose primary mechanism is
genuinely submitter-scoped still keeps an admin fallback wired in by design. That's not necessarily wrong for
Decimal's context (small teams, sharper separation-of-duties intent behind the whole approval-engine redesign)
— but it should be treated as a considered design choice against the grain of the market, not something the
market already validates. If an admin-fallback is ever added, Salesforce's and Concur's shape is the one worth
copying: a second, distinctly-named, distinctly-audited action, never a silent extension of the same "recall"
button to a broader set of actors.

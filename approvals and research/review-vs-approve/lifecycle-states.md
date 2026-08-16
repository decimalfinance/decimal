# Bill lifecycle / status model research — is "review" a distinct pre-approval state?

Date: 2026-08-16
Scope: Bill.com, Ramp, Tipalti, Stampli, Coupa, SAP Concur, NetSuite, QuickBooks Online, Xero, Melio.

**Method note (read this first):** WebSearch was unavailable for this entire research pass — the session's
search budget was exhausted (200/200) before any query ran (confirmed by the tool itself: "this session has
used its web search budget"). Every finding below was obtained instead by (a) fetching official API docs and
OpenAPI specs directly via `curl`, (b) using `r.jina.ai` (a text-extraction proxy) to get past client-rendered
JS shells and Cloudflare bot walls that blocked raw `curl`, and (c) `html.duckduckgo.com` for discovery — which
itself got rate-limited ("anomaly" block) partway through and never recovered in this session. Where a product
below is thin, it's because both the official docs and the discovery path were blocked, not because the product
lacks a model. This is flagged per-product and in the final assessment.

---

## 1. The actual status lists (literal vocabulary, quoted)

**Ramp** (bill object, from `docs.ramp.com` guide text, fetched via `/llms-full.txt`):
> "Bills move through the following statuses: Draft → Invoice uploaded, OCR extracts details. Pending approval →
> Awaiting approver sign-off in Ramp. Approved → Ready for payment. ... Paid → Payment processed."

Ramp additionally exposes a more granular `status_summary` field on the Bill API object (separate from the
4-value top-level `status`). Current enum (from the live OpenAPI spec / `llms-api.txt`, Feb 2026):
`APPROVAL_PENDING | APPROVAL_REJECTED | ARCHIVED | AWAITING_RELEASE | BLOCKED | HELD_BY_PROVIDER | ON_HOLD |
PAYMENT_COMPLETED | PAYMENT_DETAILS_MISSING | PAYMENT_ERROR | PAYMENT_NOT_INSTRUCTED | PAYMENT_PROCESSING |
PAYMENT_READY | PENDING_VENDOR_APPROVAL | WAITING_FOR_TRANSACTION_MATCH | WAITING_FOR_VENDOR`.
Notably, the Feb 13 2026 changelog entry says Ramp **removed** four draft-substates from this same enum:
`DRAFT_MISSING_INFO, DRAFT_PARSING, DRAFT_QUEUED, DRAFT_READY` — see Q2, this is the crux finding for Ramp.
Source: [Ramp Bill Pay guide](https://docs.ramp.com/developer-api/v1/bill-pay), [Ramp API changelog](https://docs.ramp.com/developer-api/v1/changelog) (both fetched via llms-full.txt/llms-api.txt, Aug 2026).

**Bill.com** (v3 Bill object, from `developer.bill.com/docs/ap-bill-approvals`):
Two separate status fields on the same bill object:
- `paymentStatus`: e.g. `"UNPAID"`
- `approvalStatus`: e.g. `"ASSIGNED"` (set once the bill matches an approval policy)
- Per-approver sub-status inside the `approvers[]` array: `"status": "WAITING"` (per approver, per approval step)
Source: [Bill approvals — Bill.com Developer docs](https://developer.bill.com/docs/ap-bill-approvals).

**Xero** (`Invoice.Status`, which also represents Bills — Xero has no separate "Bill" API object, a Bill is an
`Invoice` with `Type: ACCPAY`), from the official OpenAPI spec:
> `enum: - DRAFT - SUBMITTED - DELETED - AUTHORISED - PAID - VOIDED`
Source: [Xero-OpenAPI accounting spec](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml) (`Invoice` schema), cross-referenced against `externalDocs` pointing to developer.xero.com/documentation/api/invoices/.

**NetSuite** (Vendor Bill record, `approvalStatus` field, from the public SuiteScript/SOAP Record Browser):
> "The approval status of this bill shows in this field. Accept the default status or choose one of the
> following: **Approved** – No further review or processing is required before a payment is processed.
> **Pending Approval** – Someone with permission must approve the bill before a payment can be processed for it."
A separate general `status` (string) field also exists on the record but its description is blank in the
browser (it maps to the well-known UI labels Open / Paid In Full / Rejected, not independently documented here —
**INFERENCE**, not directly sourced this pass). NetSuite also documents a `nextApprover` field: "displays the
next person set to approve this bill via approval routing."
Source: [NetSuite Records Browser — vendorbill](https://www.netsuite.com/help/helpcenter/en_US/srbrowser/Browser2024_1/schema/record/vendorbill.html) (fetched via jina reader, direct curl was Akamai-blocked).

**SAP Concur** (Invoice / "Payment Request" object, v3 API): two independent status axes rather than one list:
> `ApprovalStatusCode` — "A code indicating the invoice's approval status." (codes are retrieved dynamically via
> `GET /invoice/localizeddata`, not a fixed enum in the docs — Concur treats approval-status labels as
> configurable/localizable, not hardcoded.)
> `PaymentStatusCode` — "A code indicating the invoice's payment status."
The digest schema also exposes discrete lifecycle timestamps: `CreateDate`, `submitDateBefore/After` (i.e. a
tracked **Submit** event), `LastModifiedDate`, `ExtractedDate`, `PaidDate`.
Separately, the v4 Invoice Pay API (payment-provider-facing) uses a payment-side status enum including
`PENDING_RETRIEVAL` and `PAID`, and states explicitly: "After an invoice is approved and extracted it will be
converted into a payment with status PENDING_RETRIEVAL" — i.e. the payment object doesn't exist at all until
after approval + extraction.
Source: [SAP Concur Invoice API docs source (v3.payment-request-digest.markdown, v4.invoice-pay.markdown)](https://github.com/SAP-docs/preview.developer.concur.com/tree/main/src/api-reference/invoice) — the rendered developer.concur.com site 404'd on every guessed URL, so this was retrieved from the public GitHub source the site is built from (link found via the site's own "Edit this page on GitHub" footer).

**QuickBooks Online**: the public Accounting API `Bill` entity has **no status field of any kind** — no
`Status`, no `ApprovalStatus`, no `ReviewStatus`. Confirmed by fetching the full entity reference and grep'ing
for "status" / "approv" / "review" across the entire attribute list: zero matches.
Source: [QBO Bill entity — All Entities API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill) (fetched via jina reader). This is a genuinely useful negative finding — see Q2/Q3.

**QuickBooks Online Advanced** ships an in-app "Custom Approval Workflows" feature for Bills, but it is a
UI-layer feature layered on top of the object above; several attempts to fetch Intuit's own help article for
it (`quickbooks.intuit.com/learn-support/...set-approval-workflow-quickbooks-online-advanced...`) returned
Intuit's generic client-side error shell ("Oops! Something went wrong") through both direct curl and jina —
**GAP**, not sourced this pass.

**Melio** (from Melio's own product page, not an API doc — no public API/status-enum docs were found for Melio):
Melio documents its process as five named, ordered steps: **Capture → Review → Approve → Pay → Sync**.
> "1 Capture — Auto-fill vendor details, amounts, line items, and due dates with OCR scanning on imported
> bills. 2 Review — AI helps but you stay in control. Review bills for accuracy and adjust in the moment as
> needed. 3 Approve — Set roles, permissions, and multi-level approval workflows to keep money moving
> responsibly. 4 Pay ... 5 Sync ..."
Source: [Melio — Accounts payable automation](https://melio.com/accounts-payable/) (fetched via jina reader; direct curl to melio.com/help.melio.com is Cloudflare-gated).

**Coupa** (Coupa Supplier Portal invoice statuses — supplier-facing, i.e. what the vendor sees, not the buyer's
internal AP queue labels):
> "Invoices can have the following statuses: **Abandoned**, **Approved**, **Disputed**, **Draft** (created but
> not submitted to your customer yet), **Invalid**, **Pending Approval** (currently under review by your
> customer), **Processing** (being processed by the AP department and should be paid soon), **Voided**."
Source: [Coupa Compass — View and Manage Invoices](https://compass.coupa.com/en-us/products/product-documentation/supplier-resources/for-suppliers/coupa-supplier-portal/set-up-the-csp/invoices/view-and-manage-invoices).
Caveat: this is the *supplier's* view of status, which folds the buyer's internal data-verification/GL-coding
substeps into "Pending Approval." I could not reach Coupa's buyer-side/Invoicing product docs (which would show
internal AP states like matching exceptions) before the DDG discovery channel got rate-limited — **GAP**.

**Tipalti**: no literal in-product status enum was retrievable this pass (help.tipalti.com and apidocs.tipalti.com
are both Cloudflare/DNS-blocked to automated fetches, including jina reader — see method note). What I did get
is Tipalti's own description of its process **model** (marketing/education page, not product-UI docs — flagged
as such):
> "The invoice management process consists of steps for receiving, verifying, and matching invoices, followed
> by approval and payment." ... "Before recording invoices, the accounts payable staff or AP automation software
> verifies the accuracy of invoices, including totals, and identifies potential duplicate invoices and
> fraudulent vendors. ... AP automation software is more effective at detecting fraud and errors through
> supplier validation and rules-based error-checking, which can result in flagged exceptions that require
> investigation."
Source: [Tipalti — Invoice Management](https://tipalti.com/products/invoice-management/) (fetched via jina reader). Treat as directionally reliable (it's Tipalti describing its own product category) but **not** a literal status-field citation — **THIN**.

**Stampli**: same caveat as Tipalti — no literal status enum found, but a clear, explicit statement of Stampli's
own conceptual model, from Stampli's own published FAQ content:
> "Coding assigns the accounting treatment (GL account, dimensions, entity); approval is the business
> authorization that the spend is legitimate and correct; posting records the validated liability in the ERP.
> They are separate control points..." and "An approval carries authority and accountability; a review is
> advisory verification (a coder check, a quality look). Reviews that influence the decision should still be
> captured in the audit trail..." and describing the flow as: "invoice received and captured -> data extracted
> -> GL coding applied -> matched against PO/receipt where applicable -> routed to the approver(s) the rules
> select..."
Source: [Stampli — What is an invoice approval workflow in accounts payable?](https://www.stampli.com/blog/accounts-payable/invoice-approval-workflow/). **THIN** on literal status vocabulary, strong on conceptual model.

---

## 2. Is there a pre-approval verification state? (THE CRUX QUESTION)

**Short answer: every product that documents this at all draws the same line — yes, there is (or was) a
distinct data-verification stage before approval routing, but most products fold it into a generic "Draft"
status rather than giving it its own name. Two products (Ramp, historically; Bill.com, structurally) show the
clearest evidence, and both put verification in front of, not concurrent with, approval.**

**Ramp — the strongest and most direct evidence (SOURCED).** Ramp's `status_summary` field used to carry four
explicit draft-substates that map almost exactly onto an OCR-verification pipeline: `DRAFT_QUEUED` (queued for
extraction) → `DRAFT_PARSING` (OCR running) → `DRAFT_MISSING_INFO` (extraction incomplete — the "needs a human"
state) → `DRAFT_READY` (data confirmed, ready to move forward). Ramp's Feb 13 2026 changelog says these four
were *removed* from the enum ("removing draft-related statuses like DRAFT_MISSING_INFO, DRAFT_PARSING,
DRAFT_QUEUED, and DRAFT_READY"), which folds them back under the single top-level `Draft` status rather than
eliminating the concept — the granularity was API surface, not product behavior. Either way: **Ramp modeled,
and still models, a multi-step data-readiness pipeline that completes before `Pending Approval` begins.**
Approval is a distinct status that only starts after Draft.

**Bill.com — equally direct, but the verification state is *before the Bill record exists at all* (SOURCED).**
Bill.com's Inbox + "Intelligent Virtual Assistant" (IVA) flow: incoming documents land in an Inbox as raw
attachments, IVA pre-populates candidate field values, and the human action is literally called **"Review and
save"** — "review the bill details we found, edit as needed, and save." Only the **Save** action creates the
actual `Bill` object. The approval-policy engine (which evaluates rules like `BILL_AMOUNT >= 1000`) only ever
sees bills that already exist as `Bill` records — so by construction, in Bill.com's model, the verification step
happens **pre-record**, and approval routing is computed the instant the record is created, on whatever data
was confirmed during that review. There is no "the bill exists, is in the approval queue, and is also
unverified" state in the Bill.com model — that combination cannot occur by construction (the object doesn't
exist until it's been through the Inbox review).

**Melio — states it as an explicit, separately-named step (SOURCED).** Melio's own 5-step model names "Review"
as step 2, distinct from "Approve" (step 3): "Review — AI helps but you stay in control. Review bills for
accuracy and adjust in the moment as needed" precedes "Approve — Set roles, permissions, and multi-level
approval workflows." Melio's marketing copy doesn't specify whether these are enforced as separate *system
states* (vs. just separate *UI steps* a user walks through) — I could not reach Melio's help center or API docs
to check for an enforced gate. **Sourced as a named, ordered step; not sourced as a hard state-machine gate.**

**Stampli — states it conceptually, and explicitly distinguishes "review" from "approval" as different kinds of
action (SOURCED, but from FAQ copy not product docs).** "A review is advisory verification (a coder check, a
quality look)" vs. "an approval carries authority and accountability." Stampli's documented flow puts "data
extracted -> GL coding applied -> matched... -> routed to the approver(s)" before approval, i.e. coding/matching
finishes before routing starts, matching the same pattern as Ramp and Bill.com.

**Tipalti — states it conceptually as an industry/product process (SOURCED, marketing-page level).** "Receive →
Verify (errors/duplicates flagged as exceptions requiring investigation) → Approve → Pay" — same ordering,
verification named as its own step before approval.

**Xero, NetSuite, QuickBooks Online, SAP Concur, Coupa — do NOT document a separate named "review/verification"
status distinct from Draft (SOURCED, as a negative finding for these five).** In all five, the only pre-approval
non-draft state either doesn't exist (QBO has no status field at all) or is simply "Draft" (Xero: `DRAFT` →
`SUBMITTED` → `AUTHORISED`; Coupa: `Draft` → `Pending Approval` → `Approved`; NetSuite: default/unset →
`Pending Approval` → `Approved`). None of these products' documentation names a distinct machine-readable state
for "AI extracted this, a human hasn't confirmed it yet." **This does not mean the capability doesn't exist in
the product UI** (QBO, Xero, and NetSuite all have OCR/bill-capture features in-app) — it means the object model
exposed in their public docs treats "not yet reviewed" and "drafted" as the same bucket, with no distinct status
value for "flagged for human confirmation." This is itself informative: it suggests the more common pattern
across mature AP products is **one wide "Draft" state that covers everything before Submit**, not a dedicated
`needs_review` status sitting parallel to or ahead of an approval status — see Q3 below for why that matters to
your specific question.

**SAP Concur is the partial exception**: it documents two *independent axes* (`ApprovalStatusCode`,
`PaymentStatusCode`) rather than one linear list, plus explicit `SubmitDate`/`ExtractedDate` fields — which
implies Concur tracks "when was this extracted" and "when was this submitted" as separate, ordered events, even
though the exact pre-submit status codes are configurable/undocumented in the public API reference.

---

## 3. When does the bill enter the approval workflow, relative to data entry/coding finishing?

**Across every sourced product, approval routing is computed from already-confirmed data — it does not start
until Draft/capture-and-review is done, and the trigger is an explicit or implicit "the data is now real"
event, not the arrival of the document.**

- **Ramp**: bills created via API "are automatically approved and enter the workflow at the Approved status" —
  i.e. API-created bills *skip* Draft and Pending Approval entirely because there's no OCR-extraction step to
  wait on (the caller supplied confirmed data directly). Conversely, dashboard-created (OCR-captured) bills sit
  in Draft — where the removed `DRAFT_MISSING_INFO`/`DRAFT_READY` substates lived — until a human moves them
  forward; "Draft bills can be created and updated through the API, but they can only be approved in the Ramp
  dashboard." This is a clean natural experiment: the *same* approval-routing logic is deferred for
  OCR-captured bills specifically until data is confirmed, and skipped entirely when data arrives pre-confirmed.
- **Bill.com**: approval-policy matching (e.g., `BILL_AMOUNT >= 1000`) runs against the `Bill` record the
  instant it's created via the API/Save action — which, per Q2, only happens after the Inbox review. So routing
  is "computed from the coded data," but that's trivially true because the record doesn't exist pre-coding.
- **SAP Concur**: the payment object literally does not exist until "an invoice is approved and extracted" —
  approval is a precondition for the payment-side object to be created at all, and `ExtractedDate` is tracked
  as a distinct field from `SubmitDate`, implying extraction (data readiness) and submission are two different,
  ordered events on the same invoice.
- **Coupa**: `Draft` is explicitly "created, but not submitted to your customer yet" — submission is the
  trigger, and it's a distinct, human-initiated event.
- **Xero**: `DRAFT` → `SUBMITTED` — the `SentToContact` field notes it "can be set only on invoices that have
  been approved," implying `AUTHORISED` (approved) gates a downstream action, consistent with approval being
  computed post-submission, not on capture.

I found **no product**, sourced or otherwise, that routes a bill into approval **before** its core payable
fields (amount, vendor, GL coding) are populated, and I found no product that computes approval routing purely
"on capture" the way your product currently does. Ramp's re-routing-on-edit behavior (already known to you) is
the *mid-flight* correction mechanism; the *initial-entry* mechanism, wherever documented, is gated on a human
or API caller having already confirmed the data. **This is the single clearest, most consistent signal across
the whole research set, and it directly supports separating your `needs_review` gate from the approval engine's
entry point rather than running them concurrently.**

---

## 4. Who fixes bad OCR / bad AI extraction, and when?

- **Bill.com**: the AP clerk/whoever processes the Inbox, via "Review and save" on IVA-detected documents — this
  is a manual, undifferentiated review (no mention of per-field confidence scores or a distinct "low confidence"
  flag in the docs I reached).
- **Ramp**: the (former, possibly still internal) `DRAFT_MISSING_INFO` status name strongly implies Ramp's OCR
  pipeline can programmatically detect "extraction incomplete" and hold the bill there — this is the closest
  thing to a documented per-bill (not necessarily per-field) confidence/completeness gate in this research set,
  though I could not find text describing who acts on it or whether it's surfaced as a queue. **INFERENCE**
  beyond the bare status name.
- **Tipalti**: "AI flags errors and validates suppliers" per its own comparison table (manual vs. automated AP),
  and separately: "rules-based error-checking, which can result in flagged exceptions that require
  investigation" — Tipalti names "exceptions" as a distinct category requiring human investigation, but I did
  not find documentation of who (which role) resolves them or whether it's a separate queue from approval.
- **Xero, NetSuite, QuickBooks Online, SAP Concur, Coupa, Stampli, Melio**: no sourced detail this pass on the
  specific human/role who corrects bad extraction, or on a dedicated "exceptions"/"needs attention" queue
  distinct from the approval queue. Melio's "Review" step ("AI helps but you stay in control... adjust in the
  moment as needed") implies the same person who captures the bill also corrects it, in the same UI step, but
  this is inference from marketing copy, not a documented role/queue.
- **Per-field confidence surfaced to a human**: **no product in this research set had a documented, sourced
  claim of per-field confidence scores gating human confirmation.** This is a real gap — either none of these
  products expose it in public docs, or (more likely) it exists in-product but wasn't reachable through the
  blocked/degraded search channels this pass. Do not treat this as "no AP product does per-field confidence" —
  treat it as **unconfirmed either way**.

---

## 5. The "Submit" moment

**Every product with a documented Draft-like status treats Submit as an explicit, named, human-triggered
action — not something that happens automatically once required fields are present.**

- **Coupa**: `Draft` = "created, but not submitted to your customer yet" — submission is named and distinct.
- **Xero**: `DRAFT` → `SUBMITTED` is a discrete status transition in the enum itself.
- **SAP Concur**: tracks `submitDateBefore`/`submitDateAfter` as filter parameters and (by extension) a
  `SubmitDate` field on the invoice digest — meaning Submit is a recorded, queryable event with its own
  timestamp, separate from `CreateDate`, `ExtractedDate`, and `PaidDate`.
- **Bill.com**: the closest equivalent is the Inbox "Save" action, which both confirms the reviewed data *and*
  creates the record that immediately gets evaluated against approval policies — so in Bill.com's model, "Save"
  is simultaneously "confirm my review" and "submit into approval," collapsed into one action.
- **Ramp**: ambiguous from what I could source — the docs describe the four statuses but don't spell out
  whether "Draft → Pending approval" requires an explicit user action distinct from the OCR pipeline reaching
  `DRAFT_READY`, or whether reaching `DRAFT_READY` was itself sufficient to auto-advance. **GAP** — I could not
  find the specific UI action name (Ramp's help center, where this would likely be documented, was not reached).

**Is the Submit action itself recorded as a control?** SAP Concur is the only product with clear sourced
evidence of this (`SubmitDate` as a first-class, filterable field, separate from creation/extraction/payment
dates) — consistent with Concur's audit/expense-report heritage. No other product in this set had a sourced,
explicit claim that "who pressed Submit" is captured as an audit-trail fact (as distinct from "who approved" or
"who created," which are more commonly documented). Stampli's FAQ content argues this *should* be true as a
matter of AP control design ("every dispatch, approval, rejection, question, and reassignment is captured in an
immutable activity record") but that's Stampli's stated design position, not a report of what competitors do.

**Who is allowed to press Submit?** Not sourced for any product this pass — role-gating of the Submit action
specifically (as opposed to the Approve action, which is well-covered by your prior role research) did not turn
up in any doc reached.

---

## 6. What happens to a bill with incomplete data?

- **Ramp**: the removed `DRAFT_MISSING_INFO` status is the single clearest sourced data point — a bill with
  incomplete/unparseable OCR data got a dedicated status name, implying it's held there (not advanced to
  approval) until resolved. This reads as **a real state, not just a UI warning** — it was a machine-readable
  enum value other API consumers could filter/react to.
- **Ramp (post-approval side)**: even after approval, Ramp has `PAYMENT_DETAILS_MISSING` and `BLOCKED` in the
  current `status_summary` enum — confirming Ramp treats "missing required data" as a first-class blocking
  state on the *payment* side too, not just pre-approval. This is a strong signal that "readiness" is
  consistently modeled as a state (not a soft warning) across Ramp's whole bill lifecycle.
- **Coupa**: `Draft` bills can be edited/deleted by the supplier; nothing in the sourced docs suggests a bill
  can be submitted into `Pending Approval` while genuinely incomplete — but I did not find an explicit
  "submission blocked if field X is empty" statement (**GAP**, likely exists in Coupa's buyer-side/admin docs
  which weren't reached).
- **Bill.com**: by construction (see Q2), a `Bill` record can't exist without going through the Inbox
  review/save step, so there's no sourced case of an "incomplete" Bill record entering the approval-policy
  matcher — incompleteness is structurally excluded rather than checked-and-blocked.
- **NetSuite, Xero, QuickBooks Online, SAP Concur, Stampli, Tipalti, Melio**: no sourced detail this pass on
  what specifically happens when required fields (amount, GL coding) are missing at intake — whether it's a
  hard block on advancing, a soft warning, or simply not addressed in the public docs I could reach. **GAP**
  across the majority of the product set on this specific sub-question.

---

## Strong / thin / gap assessment

**Strong (multiple independent, literal, sourced quotes; confident in the finding):**
- Ramp — full status list + granular `status_summary` history + the deprecated draft-substates is direct,
  primary-source evidence for the crux question (Q2/Q3).
- Bill.com — Inbox/IVA "Review and save" mechanic + `approvalStatus`/`paymentStatus` API fields, both from
  official developer docs.
- Melio — explicit named 5-step model (Capture/Review/Approve/Pay/Sync) from Melio's own product page.
- Xero — literal `Invoice.Status` enum from the official OpenAPI spec.
- QuickBooks Online — confirmed, verifiable negative finding (no status field in the public Bill API at all).

**Thin (real sourced content, but conceptual/marketing-page level rather than product-UI/API-level, or missing
one side of the picture):**
- Coupa — solid literal status list, but supplier-facing only; buyer-side internal AP states not reached.
- SAP Concur — solid on the dual-status-axis + timestamp-tracking pattern, but the actual approval status code
  values are configurable/undocumented, and the modern REST docs I could reach skew toward the payment-provider
  side of the API rather than the AP-clerk-facing Invoice object.
- NetSuite — good literal quote for `approvalStatus`, but only a 2-value enum surfaced (Approved/Pending
  Approval); the richer in-app SuiteApprovals workflow states (e.g. Rejected) weren't reached.
- Stampli, Tipalti — real, on-point, product-authored content, but from blog/FAQ/marketing pages, not product
  docs or API references. Treat the *pattern* (verify-before-approve) as reliable; treat the specifics as
  unconfirmed.

**Gap (not obtained this pass; do not assume an answer either way):**
- Per-field confidence scoring surfaced to a human, for any product — genuinely unconfirmed, not "no."
- Who is authorized to press Submit, and whether that action is itself audit-logged, for any product except the
  Concur `SubmitDate`-is-tracked data point.
- QuickBooks Online Advanced's in-app Custom Approval Workflow feature — blocked by Intuit's help-center JS
  shell on every fetch attempt.
- Tipalti and Melio's actual in-product status vocabulary (as opposed to process description) — help.tipalti.com
  and help.melio.com are both Cloudflare-gated against automated fetches, including the jina reader proxy.
- Coupa's buyer-side/internal AP processing states (matching exceptions, "needs attention" queues) — the
  supplier-portal docs don't cover this, and the buyer-side doc tree wasn't reached before DDG discovery got
  rate-limited.
- SAP Concur's classic/v10 SOAP-based Invoice object statuses (as opposed to the v3/v4 REST docs actually
  reached) — Concur is a long-lived product with multiple API generations; only the modern REST subset was
  checked.

**Overall read for your specific question:** the strongest, most directly comparable evidence (Ramp, Bill.com,
Melio, and to a lesser extent Stampli/Tipalti) converges on the same shape: **verification of AI-extracted data
is real and distinct, but it's modeled as happening either (a) before the payable record formally exists
(Bill.com), or (b) inside a single wide "Draft" status that approval routing simply doesn't start from
(Ramp, Xero, Coupa, NetSuite) — never as a status that runs in parallel with "pending approval."** None of the
ten products, sourced or inferred, appear to model "awaiting review" and "pending approval" as two
simultaneously-true states on the same object the way your current implementation does. That combination looks
like an outlier against the pattern, for whatever that's worth to the incoherence you flagged.

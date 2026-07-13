Airbase (now part of Paylocity) — organization-wide policies and spend controls
=================================================================================

Scope note: this covers policy/spend-control mechanics only (thresholds, category rules,
receipt/documentation requirements, vendor rules, budget checks, pre-approval, enforcement,
guided procurement/intake). Approval-chain routing mechanics were researched separately and
are only mentioned here where they intersect with policy definition.

Note on sources: Airbase's product marketing site and help center have been folded into
Paylocity's domain (airbase.com and help.airbase.com paths now 301-redirect to generic
Paylocity marketing/help pages), so the older Airbase-branded PDFs and cached feature pages —
still hosted on info.airbase.com and reachable via search — are the most detailed primary
sources currently available. The core source below ("Modern Expense Policies: Shifting from
Traditional to Rule-based Policies," an Airbase whitepaper) is effectively Airbase's own
articulation of what a "policy system" should be, written for a buyer audience, and is the
backbone of this write-up.

---

1. The core framing: "rule-based" policy replaces the written policy document
-------------------------------------------------------------------------------

Airbase's own pitch is explicitly that a spend-management platform should let a company
retire its written (language-based) expense policy document and replace it with a
"rule-based system": software that "operates without direct human oversight, and applies
human-crafted rules to mandate data and drive processes... A rule-based system makes its
configured rules mandatory for participation with the system."

The stated deficiencies of traditional written policies that this is meant to fix:
- reliance on employees reading, remembering, and correctly interpreting prose
- need to redistribute the document (and re-communicate) every time it's updated
- no oversight mechanism — compliance is asserted, not verified
- risk of miscommunication compounds as headcount grows

The system's job, per Airbase: handle compliance, routing, reminding, and documenting,
providing "visibility into whether an expense is allowable, shows where an expense is in
the process, identifies who must approve and when, and indicates whether payment has been
made" — and to generate an automated audit trail as a byproduct of enforcement, rather than
requiring reconstruction after the fact.
(Source: info.airbase.com/hubfs/44368323/LP_Download_Assets/ModernExpensePolicies.pdf)

Airbase's own comparison table of "Best Practice Elements" is useful as a checklist of what
each model requires:
- Traditional written policy needs: spend philosophy, expense reports, multiple
  policies per circumstance, usage explanations, dissemination (initial + updates),
  outlined compliance/ramifications, expense-reporting process, approver schedule,
  reimbursement process, scope, approval-workflow detail, exception guidance, card-use
  guidelines.
- Rule-based system needs only: spend philosophy (still recommended, as a short statement
  of intent/objectives — not eliminated, just shortened), policy guidelines per payment
  type, and role/permission provisioning (increasingly via HRIS sync).

---

2. Policy TYPES (the actual rule vocabulary)
-----------------------------------------------

Airbase's rule model is built from a small set of composable primitives. Every "rule" is
essentially an IF (conditions) / THEN (outputs) statement, and the whitepaper gives the
literal building blocks:

a) Roles, responsibilities, and permissions
   Every user is assigned a role (example roles: Administrator, Accounts Payable, Manager,
   Employee) that carries permissions (user provisioning — admin-only; editing rights;
   reviewing rights; approver status). Rules are then built on top of these roles. Roles can
   sync from an HRIS but still need an admin to reconcile promotions/hires manually.

b) Approver rules
   Define who must approve card-creation requests, virtual-card spend requests, PO requests,
   and reimbursement requests. Constructed as condition -> approver pairs, e.g.:
   Conditions: Requester Role = Any, Requester Department = Marketing, Payment Method =
   Virtual Card, Spend Request > $5,000
   Approvers: Approver Role = Manager (dept default) AND Approver Role = VP (added because
   of the threshold)
   Example condition fields: Department, Category (GL category on the transaction),
   Requester/Approver (specific person or role/department), Service/Vendor, Spend Requested
   (amount), Payment Type. Multiple approvers can be chained (sequential escalation) or
   backed up (auto-reroute if the primary approver is unavailable).

c) Spend limits (amount thresholds)
   Can be: built into physical/virtual cards directly; assigned to an individual for PO or
   reimbursement requests; scoped to a specific purpose (event budget, per diem, lodging
   sub-limit); scoped to a department or initiative; time-boxed (daily/weekly/monthly/
   quarterly/annual); and edited on the fly by admins/accounting to "course-correct" budgets
   up or down without a policy rewrite.

d) Receipt / documentation compliance
   Modeled as rules with two enforcement modes — warning or blocking (see Section 3).
   Concrete example rules given: email reminders to attach a missing receipt; auto-lock a
   company card if no receipt is attached within N days of a transaction; require a receipt
   upload for reimbursement requests over a set dollar amount; require a receipt for every
   reimbursement request with no threshold ("Period").

e) Vendor-level rules (soft, not hard-blocking)
   Airbase explicitly buckets vendor rules on the "soft rules" side of its own comparison
   table — vendor relationships are guidance/suggestion, not an obligatory gate, in contrast
   to traditional policy where vendor relationships could be a hard rule. In practice this
   shows up as "auto-display" recommended vendors for a category (e.g., Category = Flights ->
   suggest Delta; Category = Marketing -> suggest HubSpot; Category = Home Office -> suggest
   Amazon) rather than restricting purchases to an approved vendor list.

f) W-9 / vendor compliance gating
   One explicit hard rule: "only release payment to a vendor after a W-9 has been received."
   Framed as a payment-blocking rule tied to vendor documentation status, used both to force
   vendor cooperation and to have 1099 data ready ahead of tax season.

g) Budget checks
   Distinct from per-transaction spend limits: budgets are checked as a running total against
   a "budget category" (department/initiative/time period). Once cumulative spend in a
   category hits the limit, "no further spending can be incurred until the limit is
   increased" — i.e., budget-level rules are described as hard-blocking by default, separate
   from the transaction-level warn/block choice described for receipts.
   (Source: search-result synthesis citing airbase.com/glossary/budget-controls and
   airbase.com/blog/gain-control-over-budgets-with-spend-control-software — original pages
   now redirect through Paylocity; content reconstructed from indexed excerpts.)

h) Pre-approval requirements
   Airbase frames this as inherent to the payment-method choice, not a separate policy type:
   virtual cards and purchase orders are "pre-approved" by construction (a spend request must
   clear approval before the card/PO exists or is usable), whereas employee reimbursements are
   necessarily post-hoc (the employee already spent personal funds, so approval happens after
   the fact with less real-time control). The whitepaper explicitly recommends steering
   employees toward virtual cards specifically because it converts approval from "after the
   fact" to "up front."
   Guided Procurement (Section 6 below) generalizes pre-approval into a full multi-stakeholder
   milestone chain (department/budget -> procurement -> IT/InfoSec/legal in parallel ->
   finance) that must complete before a PO is created — this is where "pre-approval
   requirement" as a distinct policy concept (rather than just "approve this card") lives.

i) Documented example rule chains (fully worked, illustrative of how granular rules compose)
   - T&E meals reimbursement: Requester Role=Employee, Dept=Sales, Category=Meals &
     Entertainment -> Approver = Sales Manager; Single Reimbursement Limit = $50; Must submit
     within 30 days; Must attach documentation; Non-compliance result = warning notification
     to employee + approvers.
   - Travel booking (virtual card): Category=Flights -> Approver = Manager, AND
     AP/Admin-if->$500; auto-display Delta as vendor; must submit Expiration Date (<=30 days),
     Spend Limit, Note (if >$500), one-time-expense checkbox.
   - Marketing SaaS purchase (virtual card): Category=Marketing -> Approver = Marketing
     Manager, AND IT-if->$1,000; auto-display HubSpot; must submit Note (if >$1,000), Spend
     Limit.
   - Home office (reimbursement): Approver = requester's own department Manager; limit $100;
     must declare purpose, submit within 30 days, attach documentation.
   - Home office (virtual card): Approver = Manager; auto-display Amazon; expiration <=90
     days; spend limit $500; non-compliance result = card locked if no documentation attached
     to card transactions within 30 days.
   These worked examples show the pattern consistently: Conditions (requester role/dept +
   request category/payment type) -> Outputs (approver chain, spend limit, required fields,
   named non-compliance consequence).
   (Source: same ModernExpensePolicies.pdf)

---

3. WHERE policies are configured / configuration UX
------------------------------------------------------

- Policies are configured centrally by admins/accounting, not per-manager or per-employee —
  the whitepaper stresses "one more benefit of a consolidated, comprehensive spend management
  platform is that rules can be determined once and applied consistently across all areas of
  spending," rather than needing separate rule sets per tool (cards vs. reimbursements vs.
  POs) as would be the case with fragmented point tools.
- The condition/output structure (see 2b, 2i above) is visually presented as an IF/THEN
  rule builder — conditions on the left (role, department, category, vendor, amount, payment
  type), outputs on the right (approver(s), limits, required fields, auto-displayed vendors,
  non-compliance action). This is a no-code rule builder, not a form of scripting.
- For Guided Procurement specifically, admins configure: milestones in the approval process
  and their order; an "approval matrix" mapping spend categories to which milestones/
  stakeholder groups apply; approval rules that auto-pull in the correct business group
  (procurement/IT/legal/finance) per request; custom form fields (attachments, URLs, text,
  multiple choice, date) to capture what each stakeholder group needs; and integrations with
  the stakeholder's own system of record (Jira for IT, Ironclad for legal CLM, etc.), so that
  approvals recorded in those external systems sync status back into Airbase automatically.
  (Source: info.airbase.com/hubfs/LP_Download_Assets/guided-procurement.pdf)
- There is also a separate, more general "custom workflow builder" (no-code) that can
  orchestrate internal approval/documentation processes unrelated to spend at all — NDAs,
  budget approvals, contract renewals, headcount approvals — using the same
  milestone/approval-matrix mechanics, selectable from pre-built templates or built custom.
  This implies Airbase treats "policy/workflow configuration" as one general engine reused
  across spend and non-spend approval processes, not a spend-specific subsystem.

---

4. ENFORCEMENT: block vs. flag vs. warn; overrides; audit trail
--------------------------------------------------------------------

- Airbase explicitly supports two enforcement modes for a given rule: "Rules can be enforced
  by the system with either a warning or by blocking further action." This choice is made
  per rule, not globally — e.g. a missing receipt might just trigger "a warning that prompts
  the employee to proactively fix or add information," while a different rule (card lock
  after N days without a receipt, or blocked payment without a W-9 on file) is a hard block.
- Documented hard-block examples: auto-lock a corporate card if a receipt isn't attached
  within a set number of days of a transaction; block vendor payment release until a W-9 is
  received; budget-category limit reached blocks further spend in that category until an
  admin raises the limit; virtual card / PO requests require approval before the
  card/PO becomes usable at all (approval-gating is itself a blocking mechanism, not a
  post-hoc flag).
- Documented warning-only example: missing receipt on a reimbursement triggers a warning
  notification to both the employee and their approver(s), but doesn't stop the request
  (per the worked T&E-meals example, non-compliance result = "Warning Notification, given to
  employee and approvers" rather than a block).
- Overrides: the model doesn't describe a distinct "override with justification" flow so
  much as it treats limit/threshold escalation itself as the override mechanism — spend
  limits are explicitly "edited by system admins and accounting team" as a "convenient valve
  for encouraging different spending behavior," i.e., an admin raises the limit or budget
  cap rather than an individual approver clicking "override" on a specific blocked
  transaction. Escalation via additional approvers above a threshold (e.g., VP approval
  required above $5,000) functions as a built-in override path baked into the rule itself,
  rather than an ad hoc exception.
- Audit trail: framed as an automatic byproduct of the rule-based approach, not a bolt-on —
  "A system built from a rule-based approach ensures that employees cannot act outside the
  bounds of those rules. Moreover, it documents every step of the process for employee
  expenses: requests, approvals, and transaction details. There's no need to reconstruct
  events and search for evidence of compliance." For Guided Procurement specifically:
  "form a complete audit trail of all activity" across procurement/IT/legal/finance
  stakeholder reviews, and "Get a complete audit trail across all non-payroll spend" is
  listed as a top-line reason to use the platform. The general custom-workflow builder also
  claims "a clear audit trail for continuous oversight for all stakeholders" for non-spend
  approval processes (NDAs, contract review, etc.).
- No explicit description was found (in the accessible sources) of a UI-visible "override
  log" separate from the approval/rule audit trail itself — i.e., an escalation-approval
  event and an "override" event appear to be the same underlying object in Airbase's model:
  a person with sufficient role clears the rule's approver requirement, and that approval
  action is what's logged.

---

5. Defaults for a new org; interaction with roles and approval flows
--------------------------------------------------------------------------

- No public source enumerates Airbase's specific out-of-the-box default policy set for a
  brand-new org (e.g., a default spend-limit number or default receipt threshold) — this
  level of detail lives behind product onboarding/login, not in indexed marketing or help
  content, and the redirect of help.airbase.com to a generic Paylocity KB portal
  (paylocity.egain.cloud/kb/airbase) means the original step-by-step setup articles are no
  longer independently reachable.
- What is clear structurally: policy rules are inseparable from the role system — every rule
  is defined in terms of Requester Role/Department as the condition and Approver Role/
  Department as the output, so "roles" (Administrator, AP, Manager, Employee, and
  department-scoped variants) are the primary key policies are built on, not a separate
  layer bolted on top of roles.
- Payment-method choice is itself a policy lever, not just an outcome: Airbase's own guidance
  is to steer as much spend as possible onto virtual cards specifically because that converts
  approval into a hard pre-approval gate (card doesn't exist/isn't usable until approved),
  versus reimbursement, which is inherently a post-hoc, lower-control flow. This means the
  three payment rails (physical card, virtual card, PO, reimbursement) each carry a different
  default enforcement posture even under an identical-looking rule, and policy design in
  Airbase includes choosing which rail a category of spend should default to.
- Interaction with approval routing (researched separately, only noted for completeness
  here): thresholds inside a policy rule are what trigger additional/escalated approvers
  (e.g., a rule's normal approver is the department Manager, but crossing a dollar threshold
  adds a second required approver such as VP, IT, or AP/Admin) — so policy thresholds are the
  mechanism that drives dynamic approval-chain composition, rather than approval chains and
  spend policies being fully separate systems.

---

6. Guided Procurement / intake policies (notable specifics)
-----------------------------------------------------------------

Guided Procurement is Airbase's name for policy-driven intake on purchase requests that
involve non-financial stakeholders (IT, InfoSec, legal, procurement) in addition to
budget/finance approval. Key mechanics:

- A purchase request is a multi-milestone object, not a single approval: e.g. Department &
  Budget Review -> Procurement Review -> (IT Review, InfoSec Review, Legal Review run in
  PARALLEL) -> Finance & Accounting Review. A PO is only created once every required
  milestone is approved.
- Which milestones apply to a given request is itself policy-driven: admins configure an
  "approval matrix" that maps spend category and transaction size/type to which stakeholder
  milestones are required — e.g., a $60,000 annual software purchase request triggers
  Department, Procurement, Legal, and IT approval; a small purchase might skip IT/Legal
  entirely. This is the clearest embodiment of "pre-approval requirements" as a distinct,
  size/category-conditioned policy type.
- Intake is a guided multi-step form, not a single free-text request: the employee fills a
  structured "Purchase Request Checklist" (Primary Information -> Vendor & Budget Details ->
  additional stakeholder-specific info), and the system tells them in real time what's been
  completed and what's still required for approval (mirrors the receipt/documentation
  pattern in section 2d, but for procurement documentation like SOC attestations, tax info,
  contracts).
- Stakeholder-specific requirement capture is externalized via forms + integrations:
  Airbase can pull in category-specific requirements (SOC 2 attestation for IT/security,
  pricing/vendor-negotiation details for procurement, contract terms for legal) as custom
  form fields attached to the relevant milestone, and sync status bidirectionally with the
  stakeholder's own tool (Jira ticket status <-> Airbase milestone status; Ironclad/CLM
  contract status <-> Airbase legal milestone).
- Procurement-specific "soft" policy value: procurement's own review milestone is framed
  less as a compliance gate and more as a chance to negotiate — "ensure visibility into all
  spend to influence vendor selection and pricing before commitments are made... help
  eliminate rogue, duplicate, and inefficient spend." Guided Procurement explicitly captures
  vendor pricing-negotiation fields (payment cadence, annual-payment discount, seat count,
  pricing tier) as part of the intake form specifically to arm the procurement team, which is
  a policy-adjacent but distinct "gather negotiation leverage" function not found in the
  simpler card/reimbursement rule examples.
(Source: info.airbase.com/hubfs/LP_Download_Assets/guided-procurement.pdf)

---

Sources
-------
- Modern Expense Policies: Shifting from Traditional to Rule-based Policies (Airbase
  whitepaper) — https://info.airbase.com/hubfs/44368323/LP_Download_Assets/ModernExpensePolicies.pdf
- Guided Procurement Module Overview (Airbase) —
  https://info.airbase.com/hubfs/LP_Download_Assets/guided-procurement.pdf
- Airbase spend management: Policy considerations and best practices —
  https://info.airbase.com/hubfs/44368323/LP_Download_Assets/best-practices-for-payment-method-selection.pdf
  (referenced via search index; payment-method policy guidance)
- Expense Policy Guidelines with Examples / Employee Expense Policy Template —
  https://info.airbase.com/hubfs/44368323/LP_Download_Assets/Expense-Policy-Guidelines.pdf
  (referenced via search index)
- Airbase glossary: Budget Controls — https://www.airbase.com/glossary/budget-controls
  (now redirects through Paylocity; content reconstructed from search index excerpts)
- Airbase blog: Gain Control Over Budgets With Spend Control Software —
  https://www.airbase.com/blog/gain-control-over-budgets-with-spend-control-software
  (now redirects through Paylocity; content reconstructed from search index excerpts)
- Airbase blog: Let The System Be The Enforcer — How Rule-Based Policies Eliminate Errors
  And Reduce Stress — https://www.airbase.com/blog/let-the-system-be-the-enforcer-expense-policies
  (title/summary only — page now redirects through Paylocity and full text was not
  independently retrievable)
- Airbase glossary: Internal Controls — https://www.airbase.com/glossary/internal-controls
  (now redirects through Paylocity; not independently retrievable at time of research)
- Airbase help center basics for spend owners (now folded into Paylocity KB portal,
  original article no longer independently reachable) —
  https://help.airbase.com/hc/en-us/articles/360042510411-Airbase-Basics-for-Spend-Owners
  -> redirects to https://paylocity.egain.cloud/kb/airbase
- Airbase help center: Physical Card Rules (same redirect situation) —
  https://help.airbase.com/hc/en-us/articles/360042520211-Physical-Card-Rules-
  -> redirects to https://paylocity.egain.cloud/kb/airbase

Caveat: because Airbase's marketing site and help center have both been absorbed into
Paylocity's domain, several older feature/help pages (spend-controls, receipt-management,
compliance-for-all-company-spend, approval-workflows) now 301-redirect to generic Paylocity
pages that do not contain Airbase-specific detail. Everything above was sourced either from
still-live Airbase-hosted PDFs (the most reliable) or from Google's indexed excerpts of pages
that have since redirected (marked accordingly above). Exact current-product screenshots
of the policy configuration UI were not accessible without a live account.

---

What Decimal should steal / avoid
----------------------------------

Steal:
- The condition -> output rule shape (requester role/dept + category/vendor/amount/payment-
  type -> approver(s) + limit + required fields + named non-compliance action) is a clean,
  legible mental model. It reads like a spec, not a settings page. Decimal's policy engine
  should adopt exactly this shape rather than inventing bespoke policy "types" per feature.
- Per-rule enforcement mode (warn vs. block) is the right primitive — don't force every rule
  to be a hard gate. Missing documentation should default to warn-then-remind; missing legal
  requirements (W-9-equivalent, KYC on a payee) should default to block. Let the org pick per
  rule, with sane defaults.
- Treating escalation-by-threshold as the override mechanism, rather than a separate "click
  to override" button, is worth stealing for bill approval: crossing a dollar threshold
  should compose the approval chain dynamically (add a second approver) rather than requiring
  someone to manually bypass a block. This also gets you the audit trail for free — the
  escalated approval and the "override" are the same logged event, no separate log needed.
- Payment-rail-as-policy-lever: recommending/defaulting invoices toward the payment method
  that enables pre-approval (vs. one that only allows post-hoc review) is a good idea to
  carry into Decimal's own rail choice (e.g., steer toward payment methods where the pipeline
  can hold funds pending approval, vs. rails where money is already gone once submitted).
- Reusing one generic workflow/rule engine for both spend policy and non-spend internal
  approvals (NDAs, budget sign-off) is a good architectural instinct — don't build two
  systems.

Avoid:
- Airbase's own material is honest that vendor-level rules are "soft" (suggestions, not
  blocking) — this is a real gap. If Decimal wants vendor-level control (e.g., block payments
  to un-vetted vendors, enforce banking-detail-change re-verification) that should be a first-
  class hard rule type, not treated as guidance the way Airbase treats "preferred vendor."
  This is directly relevant to Decimal's fraud-surface (vendor bank-detail changes) and is an
  area to differentiate rather than copy.
- No visible support in Airbase's model for a distinct, queryable "override event" separate
  from a normal approval — everything overloads onto "someone with the right role approved
  it." For Decimal's audit/compliance story (this is a moat point — code-enforced gate), it's
  worth being more explicit than Airbase: log "policy violated + why + who overrode" as its
  own structured event, not just inferred from who happened to approve.
- Budget-category hard-blocking ("no further spending until the limit is increased") is
  simple but can be operationally painful without a fast, in-flow way to request a limit bump
  from inside the blocked transaction. Airbase's sources don't describe such an inline
  "request a limit increase" affordance — Decimal should design that in explicitly rather
  than forcing someone to go find an admin screen.
- Guided Procurement's multi-stakeholder milestone model is powerful but is overkill for
  Decimal's current AP-focused scope (no IT/InfoSec/legal personas yet). Worth remembering as
  a future direction (once Decimal has more org roles), not something to build now.

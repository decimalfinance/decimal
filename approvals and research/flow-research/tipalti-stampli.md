# Tipalti Approval Workflow Mechanics

## 1. Workflow Creation/Config
- Rules defined by: amount/threshold, cost center, department, vendor, vendor type, entity/location, GL code, budget lines, org chart. "Designate the authorized stakeholders, and define the rules (such as thresholds, required documents, and other criteria)." [Invoice Approval Workflow](https://tipalti.com/resources/learn/invoice-approval-workflow/)
- Two largely separate approval surfaces: **Bills module** (non-PO invoices, "Bill routing" config) and **Procurement module** (PO-backed spend, "Advanced PO Approval Workflows" with predefined workflows per budget level/department/location, unlimited budget owners). [Approval Matrix](https://tipalti.com/resources/learn/approval-matrix/), [stackrate.ai comparison](https://stackrate.ai/compare/ap-automation-tipalti-vs-brex-vs-mineral-tree-approval-workflows-80071f)
- Approval Matrix guide frames hierarchy as tiers: e.g. "$15K–$25K requires VP of Finance approval, bypassing single manager"; typical ladder is manager → department supervisor → VP Finance/CFO; subsidiaries can have distinct approver sets/rules. [Approval Matrix]
- Self-service configurable per marketing copy, though a third-party comparison flags that **compound AND/OR logic** across multiple attributes in one rule is *not confirmed* as self-service — may need implementation-team help for complex cross-cutting rules. [stackrate.ai]

## 2. Routing Semantics
- Both sequential (tiered, rank-based) and **parallel approval** — "unlimited budget owners and parallel approval" on PO side, auto-routes to cross-functional teams (IT, security, legal) simultaneously. [Invoice Approval Workflow], [stackrate.ai]
- **PO matching / auto-approve**: 2-way and 3-way match. Even when auto-matched, org can still require additional approvals before payment. Tolerance thresholds configurable by amount/percentage at bill or line level. [PO Matching](https://tipalti.com/ap-automation/po-matching/), [3-Way Match](https://tipalti.com/resources/learn/3-way-match/)
- **Exception Handling AI**: tolerance thresholds by amount, percentage, bill, or line level; color-coded exception surfacing. [Invoice Approval Workflow]
- No confirmed public documentation on explicit any/all/N-of-M quorum semantics, per-approver dollar limits beyond the tier model, or multi-rule conflict resolution (which rule wins).

## 3. Lifecycle Mechanics
- Trigger sequencing: **Capture (AI Scan/OCR) → GL coding (Auto-Coding AI, ~95% GL accuracy; also predicts cost center, expense account, location, project, department) → Approval routing ("Tipalti Pi", routes from historical patterns) → Payment.** [AI Invoice Processing](https://tipalti.com/resources/learn/ai-invoice-processing/), [Sage Marketplace listing](https://us-marketplace.sage.com/en-US/apps/90806/tipalti-invoice-accounts-payable-automation/features)
- **Approver experience**: email from bill.approvals@tipalti.com with five action buttons incl. Approve, Send Back to AP, Dispute — works from any email client incl. mobile, no portal login; footer link to "Approver Dashboard" for batch review. Tipalti Comments = communication hub attached to the bill. [How to approve bills via email](https://help.tipalti.com/hc/en-us/articles/29308594793879)
- **Send Back to AP** (INTERNAL loop): dialog requires a reason; status → "Pending AP action" subtab; AP notified by email. Distinct from…
- **Dispute** (EXTERNAL loop): approver gives payee-facing reason; payee emailed; bill sits "Disputed" until resolved.
- **Second gate — payment batch approval**: separate from bill approval. Approved bills batched for payment require the payer to approve the batch (Payments > Payment History > Approve / "Pending my approval"), unless a "No Approval" workflow is configured. Payments process after batch approval once funds exist. [Payments Workflow / Payment FAQs snippets]
- Edit-mid-approval and rule-edit-mid-flight: not documented publicly.

## 4. AI Routing
- **Approval Routing AI**: picks approver by amount, department, vendor type, from historical company-specific patterns. [Invoice Approval Workflow]
- Official philosophy: "AI must still enable finance professionals with the ability to review and override AI-powered decisions, such as critical approvals and payments" — override exists, but no docs on confidence scores or exact UI. [tipalti.com/blog/redefining-productivity-with-ai/]
- Approvers "can loop in finance, IT, or legal mid-process" — AI route is a starting point, manually extendable. [stackrate.ai]
- Confidence-vs-static-rules interplay: not documented; low confidence.

## 5. Edge Cases
- Escalation: loop in cross-functional reviewers mid-process. [stackrate.ai]
- Fallback/delegation/OOO, approver departure, rule-edit-mid-flight: **not found** in accessible docs — gap/low confidence.
- Corporate-card approvals bypass frontline managers, straight to finance (workflow gap per reviews).

## 6. Limitations / Complaints (G2 via a Stampli-published summary — competitor source, directionally credible)
- Want approvers configurable **at the vendor level** — missing.
- Expense module allows only ONE designated approver per person (rigidity).
- Card spend bypasses manager approval.
- Slow performance at times; confusing bill reporting/payment schedule; "payment flow isn't as dependable."
- Positive: AP workflow "very straightforward... even for non-finance users." [https://www.stampli.com/blog/accounts-payable/tipalti-reviews/]

---

# Stampli Approval Workflow Mechanics

## 1. Workflow Creation/Config
- **Visual workflow builder**: configure approval sequences visually; routing rules by department, cost center, spending threshold. [Approval Workflows in AP](https://www.stampli.com/resources/approval-workflows-in-accounts-payable/)
- **Org-chart-driven first approver**: "Initial approver default" auto-sets requester's direct manager (via uploaded org hierarchy) as first approver, override allowed. [Pre-defined Approval Workflows](https://www.stampli.com/pre-defined-approval-workflows/)
- **Two operating modes**: **Fully Locked** (predefined chain, no modification once a document enters — compliance/tamper-proof) vs **Partially Flexible** (authorized staff add/remove approvers at specific stages — urgent bypasses with justification, substitutes when primary unavailable). [Approval Workflows in Procurement](https://www.stampli.com/resources/approval-workflows-in-procurement/), [Dynamic Approval Workflows](https://www.stampli.com/dynamic-approval-workflows/)
- Out of the box: "multi-level workflows and cost center routing out of the box, no custom setup." [Ramp comparison](https://ramp.com/blog/accounts-payable/invoice-approval-workflows-platforms-compared)
- Rule structure = **three-variable matrix**: Amount (how high it escalates) × Department (whose budget owner) × Category (additive conditional specialists — "software" → IT review, contract → legal). Typical tiers: $1K–$5K manager, $10K–$25K director, above VP/finance, $50K+ CFO. [Requisition Approval Routing](https://www.stampli.com/resources/requisition-approval-routing/)
- ERP-aligned: mirrors chart of accounts, dimensions, approval logic.

## 2. Routing Semantics
- **Sequential and parallel**: sequential when later reviewers should see earlier decisions; parallel for independent time-sensitive reviews (IT security + budget owner simultaneously). [Requisition Approval Routing]
- Multi-criteria assignment: request attributes (vendor, location, department) + user properties (level, title); conditional logic by request type/amount/department. [Pre-defined Approval Workflows]
- **Line-item level approval**: approve/reject individual line items within one request. [Dynamic Approval Workflows]
- **PO matching auto-approve**: 2-way/3-way match incl. blanket POs; "automatically skips invoice approvals if POs and invoices match, based on customer-defined tolerances" — matched invoices bypass approval entirely. [Invoice Matching Types](https://www.stampli.com/resources/invoice-matching-types/), [PO Matching](https://www.stampli.com/po-matching/)
- Multi-rule conflict resolution: not explicit; category-triggered conditional approvers are ADDITIVE (inserted into the chain), not competing rules.

## 3. Lifecycle Mechanics
- Single-record model: approvers, coding suggestions, comments, full approval history attached to the invoice itself. [Ramp comparison]
- **Approver experience**: single-screen (invoice + docs + history); one-click approve/reject/reassign; mobile; in-app inbox queue; automated reminders; built for non-finance approvers. [The Approver Experience](https://www.stampli.com/the-approver-experience/)
- **Actions**: approve, reject, "Not Mine" (redirect misrouted invoices), ask questions, comment — all logged on the invoice. [Dynamic Approval Workflows]
- **In-app messaging**: approvers message vendors directly inside Stampli; Q&A stays attached to the invoice. [In-App Messaging](https://www.stampli.com/stampli-in-app-messaging/)
- Batch approval supported. [Approval Bottlenecks](https://www.stampli.com/resources/approval-bottlenecks-cycle-time/)
- Edit-invoice-mid-approval: **cannot modify an incorrect invoice after dispatch to approver** (G2 complaint) — forces reject/resend loop.
- No documented second payment-batch gate analogous to Tipalti's payer approval (gap/lower confidence).

## 4. AI Routing (Billy)
- Billy analyzes historical patterns — requestor, department, location, vendor, purchase type, amount — to predict the right approver; learns from every decision. [Dynamic Approval Workflows]
- **Override-friendly**: "users can bypass departmental or organizational hierarchies and select any approver"; AI suggestions overridable; final routing human-adjustable. [Same]
- Billy also drives **fallback**: auto-identifies alternate approvers when primary unavailable, from patterns + hierarchy. [Same]
- G2 counterpoint: "new merchants automatically recommend an unwanted GL account with no option to override"; "Billy Bot often produces incorrect or inconsistent data" — override not always clean in practice.

## 5. Edge Cases
- **Fallback approvers**: automatic reassignment to alternates. [Dynamic Approval Workflows]
- **Delegation/OOO**: explicit feature — "delegation for out-of-office approvers so absence doesn't stall payment." [Approval Bottlenecks]
- **Escalation/reminders/SLA**: aging alerts past threshold; auto-escalation to the approver's MANAGER after a defined wait; reminders before critical. SLA benchmarks: 48h routine, 24h urgent. [Approval Bottlenecks], [AP Internal SLAs](https://www.stampli.com/resources/ap-service-levels-internal-slas/)
- Permanent approver departure and rule-edit-mid-flight: not distinctly documented (treated as covered by fallback).

## 6. Limitations / Complaints (G2, moderate confidence)
- No GL account restriction per user.
- Billy inconsistency; new-merchant GL suggestion without override.
- PDF text extraction limited to page 1 (hurts multi-page invoices).
- UI lag between processes; mobile app flaky on poor connectivity.
- **Cannot edit invoice once dispatched to approver.**
- Support response time; pricing "relatively high"; payment execution slower than expected.

---

# Cross-Cutting Notes

## PO-matching auto-approve (both)
Both support 2-way/3-way matching with tolerance thresholds; both let matched invoices skip approval. Tipalti explicitly allows "matched but still route" (matching is a rule outcome), Stampli reads as a harder bypass by default.

## Design abstractions worth stealing for a flow builder
1. **Rule-as-matrix, not hierarchy-replica** (Stampli): amount × department × category as independent axes; category acts as an ADDITIVE conditional-reviewer injector (IT for software, legal for contracts) — clean builder mental model.
2. **Two lock modes** (Stampli): "tamper-proof audit chain" vs "runtime-editable with guardrails," toggled per workflow, not globally.
3. **Org-chart-seeded default approver with override** (Stampli).
4. **Everything-attached-to-the-record** (Stampli): approvals, comments, questions, coding, history all on the invoice object — directly analogous to Decimal's payment-order-centric design.
5. **Two-gate separation** (Tipalti): invoice approval decoupled from a distinct payment-batch approval right before money moves — content approval vs money-movement approval.
6. **Internal vs external rejection paths** (Tipalti): "Send Back to AP" (internal correction, reason required, AP queue) vs "Dispute" (vendor-facing, vendor notified, Disputed status) — two structurally different reject flows by who's at fault.
7. **AI route as override-friendly default, not a hard gate** (both): AI proposes; humans reassign freely; the same pattern engine drives fallback/OOO substitution.
8. **Tolerance-based auto-approve on PO match** (both): configurable numeric/percentage tolerance lets "close enough" skip approval — a generalizable escape hatch for threshold rule engines.

## Confidence flags
- help.tipalti.com / help.stampli.com 403-blocked; help-center claims come from search snippets.
- Low/no confidence (Tipalti): multi-rule conflict resolution, per-approver limits, rule-edit-mid-flight, approver departure, AI confidence display.
- Low/no confidence (Stampli): existence of a distinct payment-batch gate; exact quorum semantics beyond sequential/parallel.
- The Tipalti-complaints source is Stampli-published (competitor) — directionally credible, not neutral.

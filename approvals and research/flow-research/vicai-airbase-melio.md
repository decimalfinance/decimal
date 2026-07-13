# Vic.ai — Autonomous Approval Flows

## 1. Workflow Creation / Configuration
- Rules/conditions on **amount, vendor, GL account, cost center, department, PO mismatch**. [Product page](https://www.vic.ai/products/autonomous-approval-flows)
- **"Contains" operator for PO Number** (Q1 2026) — partial/prefix matching. [Q1 2026 release](https://www.vic.ai/blog/q1-2026-product-release-expanding-autonomy-across-the-ap-lifecycle)
- Assignment **by individual or by role**. [Q3 2024 release](https://www.vic.ai/news/vic-ai-launches-dynamic-role-based-approval-flows-for-enhanced-ap-efficiency)
- **HRIS-driven routing**: 50+ HRIS integrations pull role/department/team/project in real time; flows self-update as the org changes; multi-location/multi-entity/matrixed orgs supported. [Q3 2024 launch, GlobeNewswire]
- **Three flow modes**: (1) Autonomous Approval Flows — admin-generated, users can't modify; (2) Edits Allowed — accountants may modify before starting; (3) None — falls back to vendor-based approval memory from prior posts. [Intercom: Approval Methods](https://intercom.help/vicai/en/articles/4785120-vic-ai-approval-methods)

## 2. Routing Semantics
- Step-by-step flows; each step has one or more approvers with **"All" or "Any"** per step (sequential steps, per-step parallel). [Intercom: Approval Methods]
- Amount thresholds can let low-value invoices **bypass approval entirely**. [How Vic.ai Works](https://www.vic.ai/how-it-works)
- Multi-rule precedence: not documented (gap).
- Batch start of approvals supported.

## 3. Lifecycle Mechanics
- **Trigger**: ingestion/classification completes → confidence + rules evaluated → Autopilot or human flow. [How AP Autonomy Works](https://www.vic.ai/blog/how-does-vic-ai-ap-autonomy-work)
- **Mobile approver UX**: right-swipe approve, left-swipe reject; long-press to reassign responsibility on the fly. [Mobile App Overview](https://intercom.help/vicai/en/articles/5072060-mobile-app-overview)
- **Reject loop**: rejection with comment; initiator reviews the note before the flow is **reset** (reject → back to start). [Intercom: Approval Methods]
- **Live re-routing on edit (Q1 2026)**: if an invoice is re-coded mid-flow in a way that affects routing triggers, Vic.ai **recalculates and updates the approval flow in place — no rejection or manual reset**. The flow is a live projection of current invoice state + rules, not a frozen instance. [Q1 2026 release]
- **Payment gate**: approved invoices → VicPay payment batches → separate **Payment Initiator / Payment Approver** pairing (invoice approval ≠ payment approval); consolidated daily digest across both gates; early-pay discount visibility in batch approval. [VicPay launch](https://www.vic.ai/news/vic-ai-launches-vicpay-vendor-portal-and-vicagents-accelerating-the-shift-to-autonomous-finance)
- Each payment batch limited to ONE currency (complaint, below).

## 4. Autonomy (Autopilot)
- Completes approval steps once AI confidence clears a configured threshold (e.g., auto-post above 95%); below-threshold → human review; corrections feed back (active learning). [FAQ](https://www.vic.ai/frequently-asked-questions)
- 97–99% cited accuracy; autonomy is **progressive** — expands as the model's per-customer track record builds.
- Fully autonomous path: ingestion → straight to ERP ready-for-payment, skipping approval, when confidence is high across extraction + coding + matching.
- Per-step vs global confidence thresholds: not documented (unclear).
- **Escalation (Q1 2026)**: timed reminders → escalation to managers on stalls; PO-mismatch alerts + daily digests; "Pending Receipt" PO status.

## 5. Edge Cases
- **Out-of-Office mode**: schedule OOO → designate a **Substitute Approver** → substitute appears in the flow with the original **"shadowed" above them**; EITHER may approve; substitute gets all notifications for in-flight and new flows. [Approver OOO Mode](https://intercom.help/vicai/en/articles/9278758-approver-out-of-office-mode)
- **HRIS self-updating routing** handles departures/restructures without admin work.
- Admin edits to the flow DEFINITION mid-flight: not documented (gap) — only invoice-dimension edits are covered by live recalculation.

## 6. Limitations
- No bulk multi-currency batches (2–3x processing time for global small-ticket).
- Payments US-only; English-only UI.
- Setup/onboarding friction; AI learning curve per customer. [G2 synthesis]

## 7. Design abstractions worth stealing
- **Live re-routing on edit, no reset** — the standout pattern.
- **Confidence-gated autonomy as a spectrum**: high → skip approval; medium → route normally; low → flag; autonomy widens over time.
- **Shadow substitution** during OOO — audit-preserving (who was supposed to vs who did).
- **Two-gate invoice-approval vs payment-approval** with one unified daily digest.
- **Escalation as a first-class stall-prevention primitive.**

---

# Airbase — Advanced Approvals

*(Confidence: MEDIUM-LOW throughout — post-Paylocity acquisition, primary docs 301-redirect; reconstructed from cached snippets + third-party writeups.)*

## 1. Creation/Config
- **Policy > Rule > Condition** hierarchy: a policy is a set of Rules; each Rule is one or more **"When… then…" Conditions**. [Airbase glossary via search]
- Conditions: amount thresholds, department, vendor (incl. "new vendor"), GL/category, subsidiary/entity, org structure — combinable ("VP Finance if over $25,000 AND vendor is new"). [Advanced Approvals via search]
- **One policy engine spans spend types**: virtual cards, bill payments, reimbursements, POs.
- Customizable workflows gated to higher pricing tiers. [Stampli writeup](https://www.stampli.com/blog/accounts-payable/airbase-reviews/)

## 2. Routing Semantics
- Sequential AND parallel, mixable within one policy; route to "one or more approvers, in any sequence."
- **Unavailability fallback**: automatic re-routing to next in line when a designated approver is unavailable (trigger mechanics unspecified).
- Multi-policy collision resolution: not documented (gap).

## 3. Lifecycle Mechanics
- **Slack as first-class approval surface**: approve/deny directly from Slack; notifications for outcomes and failures. [Slack Marketplace listing](https://slack.com/apps/A010B8XA0GH-airbase)
- **Denied-request dead end**: no duplicate/resubmit path after a PO/card request is denied — rebuild from scratch. [Stampli writeup]

## 4–5. Autonomy / Edge Cases
- No AI/confidence autonomy — deterministic rules only.
- Only documented edge handling = unavailability fallback. No SLA/delegation UX/mid-flight-edit docs.

## 6. Limitations
- "Approval workflows" flagged as oversold in sales process (reviewer).
- Tier-gating (PO management, multi-subsidiary, custom workflows).
- Long initial setup (CoA mapping + workflow build-out).
- Post-acquisition doc rot — G2 pulled the dedicated listing; vendor-durability signal.

## 7. Worth stealing
- **Policy > Rule > Condition** three-layer data model.
- One policy engine across spend types.
- Slack inline approve/deny.

---

# Melio — Payment Approval Workflows

## 1. Creation/Config
- Premium feature (Core/Boost/Unlimited; not Go). Owners/Admins create/edit/delete. [help.melio.com](https://help.melio.com/hc/en-us/articles/12097954053788-Create-and-manage-approval-workflows-for-your-team)
- **Three trigger dimensions** via "+ Add condition": **Amount** (≥/≤ threshold) · **Scheduler** (specific users or role; DEFAULT applies only to Accountants+Contributors — Owners/Admins exempt unless explicitly added) · **Vendor** (specific vendors always require approval; Boost/Unlimited only).
- Approvers per rule: **"Any"** from the eligible pool or **"Specific"** named (multiple named = Boost/Unlimited).

## 2. Routing Semantics
- **Up to 3 sequential levels** ("+ Add step"), each level 1–3 approvers, ANY-of-N within a level. Linear ladder, not a branching graph.
- Multi-workflow precedence: not documented; appears to be a single workflow model.

## 3. Lifecycle Mechanics
- Trigger: when a payment is **scheduled** (by whom + amount + vendor).
- Approver UX: one consolidated pending tab (batch approve), mobile app, email approval. Complaint: final approve button hidden below the fold on some windows.
- Reject flow: unverified (article 403'd) — gap.
- **Mid-flight edit ANTI-PATTERN**: editing a workflow applies going forward AND **can silently auto-approve payments that were pending** if the edited rule no longer captures them — a rule change can clear an in-flight approval requirement. Contrast Vic.ai's live recalc. [help.melio.com via search]

## 4–5. Autonomy / Edge Cases
- No AI layer; deterministic.
- Dedicated **Approver role** distinct from Admin/Owner (approval authority without admin rights).
- **Owner/Admin default exemption** from amount/vendor rules unless explicitly added to Scheduler criterion — easy-to-miss compliance gap.
- No OOO/delegation feature documented. No SLA/escalation/reminders documented.

## 6. Limitations
- Limited for complex/high-volume; SMB positioning.
- Support responsiveness complaints; ACH failure anecdotes.
- Multi-step confirm UX friction; tier-gating within tier-gating.

## 7. Worth stealing
- **Minimal 3-condition trigger set** (amount/scheduler/vendor) — good MVP trigger vocabulary.
- **Default-scope exemption pattern** (bosses exempt by default) — deliberate, but must be surfaced clearly.
- **Any vs Specific approver** toggle as the base step primitive.

---

## Cross-platform table

| Dimension | Vic.ai | Airbase | Melio |
|---|---|---|---|
| Trigger fields | amount, vendor, GL, cost center, dept, PO match, PO "Contains" | amount, dept, vendor, GL, subsidiary | amount, scheduler (user/role), vendor |
| Assignment | individual or role, HRIS-synced | individual/role (implied) | individual, role, or "Any" pool |
| Structure | steps, each All/Any | Rules of Conditions, seq/parallel mixed | ≤3 levels, each Any-of-N |
| Mid-flight edit | live re-route recalc (no reset) | not documented | can silently clear pending approvals (ANTI-PATTERN) |
| Autonomy | confidence-gated Autopilot, adaptive | none | none |
| Absence handling | OOO + shadowed substitute | fallback to next in line | none documented |
| Escalation | timed reminders → manager escalation | not documented | not documented |
| Channels | mobile swipe, email digest | Slack inline, email | mobile, email, web batch tab |
| Payment gate | separate Initiator/Approver batch gate (VicPay) | same policy engine | none beyond the workflow |

Standout: **Vic.ai's live re-routing on mid-flight edits** + **confidence-gated autonomy spectrum**. Melio's silent clearing of pending approvals on rule edit = the anti-pattern to avoid.

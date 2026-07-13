# Bill.com (BILL) — Approval Workflow Mechanics

## 1. Workflow Creation UX
- Two setup entry points: a **basic default approvers list** (blanket approvers) or **enhanced/custom approval policies** — advanced rules by vendor, location, department, GL account, amount. [Manage approval workflow and policies](https://help.bill.com/direct/s/article/360000017963), [Manage custom approval policies](https://help.bill.com/direct/s/article/4404943190157)
- A **bill approval policy** = rule criteria + an approver sequence. [Bill approval workflows](https://developer.bill.com/v2/docs/bill-approval-workflows)
- **Approver groups**: any one member approving satisfies the step. [Manage approval workflow and policies]
- Only Administrators (or custom roles with the permission) manage policies. No pre-built templates — "flexibility rather than pre-built templates."

## 2. Routing Semantics
- **Sequential vs Non-sequential** rendered as plain connectives: "Then" (strict order) vs "And" (any order/parallel). [Manage approval workflow and policies]
- **Order-as-array**: API `SetApprovers` order literally defines the sequence. [SetApprovers](https://developer.bill.com/v2/reference/ap-approvals-setapprovers)
- **Per-approver dollar thresholds** on the Approver role, independent of policy thresholds. [Approver role guide](https://www.bill.com/accountant-resource-center/articles/ap-setup-reference-guide-the-approver-role)
- **Amount-tiered policies**: layered by range (>$1,000 → 1 approver, >$4,000 → 2).
- **Threshold gating**: policy applies only above its `amountThreshold`; below → no approval needed. [Bill approval workflows]
- **Multiple matching policies → UNION with de-dup**: approvers from Policy 1 first (in its order), then Policy 2's appended (excluding already-added), etc. No precedence picking. [ApprovalPolicy](https://developersupport.bill.com/hc/en-us/articles/209685063-ApprovalPolicy)
- **Never retroactive**: the policy in effect at bill creation is permanently bound to that bill; edits affect only future bills. [Manage approval workflow and policies]

## 3. Lifecycle Mechanics
- **Trigger**: evaluated at bill creation (snapshot sticks).
- **Statuses (v3 API)**: `approvalStatus` — `ASSIGNED`, `WAITING`; per-approver status array. [v3 endpoints changelog](https://developer.bill.com/changelog/2025-11-05-new-endpoints-bill-approvals)
- **Payment hard-blocked** until fully approved — EXCEPT Administrators (and Payer per some docs) can pay regardless of approval status, bypassing the gate entirely. [Bill approvals overview](https://developer.bill.com/v2/docs/bill-approvals-overview)
- Deny requires a reason.
- **Edit-mid-approval**: re-evaluation on amount change inferred but NOT confirmed with a canonical source (flagged).
- **Delegation**: delegate approvers exist; constraints on which approver types are delegable; if a delegate is also OOO, reroute retries up to 3 times then falls back. CAUTION: this detail came from a blended search summary that also surfaced a Sage Intacct doc — re-verify against help.bill.com before treating as ground truth.
- **Departed approver**: sole approver in a multi-step policy → bill **stalls silently**, no alert, until an admin reassigns. In a group → auto-routes to next in line + a "Fix Record" admin task. (search synthesis)

## 4. Edge Cases
- **Admin override** always available (deliberate escape hatch, also a control gap).
- No bulk accept/deny for some request types (gap flagged in reviews).
- **No native escalation/SLA engine** beyond delegate rerouting.

## 5. Limitations (reviews/community)
- **Approve-to-pay bundling**: approval and payment blur into one motion — "is this bill correct" vs "should money move now" not separated. [MakersHub critique](https://makershub.com/blog/why-bill-com-isnt-working-for-modern-ap-teams)
- Routing is amount/threshold-centric; weak for vendor+GL+location+project compound conditions.
- Header-only data capture limits GL-level rule granularity.
- ~3 weeks real setup effort despite "simple" marketing.
- Silent stalls on deactivated approvers.
- Teams pre-negotiate approvals in email/Slack then replicate in BILL — duplicate work, weak audit trail. [MakersHub]
- G2: positive overall, "occasional usability, syncing, and workflow limitations… for more complex approval structures." [G2](https://www.g2.com/products/bill-ap-ar/reviews)

## 6. Design abstractions worth stealing
- **Two-tier onboarding**: dead-simple default approvers list + escape hatch into policies.
- **"Then" vs "And"** plain-English connectives for sequential/parallel.
- **Policy-snapshot-at-creation + non-retroactivity** — auditable invariant; live edits never reshape in-flight bills.
- **Union-of-matching-policies with de-dup** — handles overlap without a precedence UI.

---

# Ramp — Approval Workflow Mechanics

## 1. Workflow Creation UX
- **Visual workflow builder** (Bill Pay settings > Approvals): layering/nesting conditions and approvers. [Bill Pay approvals](https://support.ramp.com/hc/en-us/articles/4417843897747-Bill-Pay-approvals)
- Building blocks: **Condition** (amount for everyone; Ramp Plus unlocks Entity, Department, Location, Vendor Name, Vendor Owner, GL Fields, Payment Type, PO-match status, Direct Manager) · **Approval** (approvers for the branch) · **Notify** (ping without requiring approval) · **Approve bill** (TERMINAL node = auto-approve fast path).
- **Approver selection**: relationship/role targets (Any Admin, Department Owner, Location Owner, PO Owner, Vendor Owner, Vendor Owner's Manager, Manager, Manager's Manager, custom groups) or named individuals. [Spend request approvals](https://support.ramp.com/hc/en-us/articles/20843280013459-Setting-up-spend-request-approvals)
- **Two separate policy layers**: **submission policies** (data completeness before submit — "require PO if amount > $5,000 AND entity = Operations") vs **approval policies** (who signs off) — same AND/OR condition engine. [Bill Pay submission policies](https://support.ramp.com/hc/en-us/articles/51621189131667-Bill-Pay-submission-policies)
- **Test before publish + view/revert past workflow VERSIONS.** [Bill Pay approvals]
- Default preset: "Auto-approve imported bills" ON by default (sync-imported bills skip the chain; toggleable).

## 2. Routing Semantics
- **Require All vs Require Any** per step/group. [Spend request approvals]
- Amount conditions branch the tree; sequential chains built compositionally by nesting.
- **Terminal "Approve bill" node** anywhere = early end / auto-approval rule.
- **Single unified workflow tree per entity** — no multi-policy collision problem at all.

## 3. Lifecycle Mechanics
- Lifecycle: Creation/Upload (email-in, OCR) → **Draft** (verify, pick payment method) → **Approval** (approvers reject/approve; Admin/Owner can skip-and-pay) → Payment Scheduling → Release/Processing → History. [Bill lifecycle](https://support.ramp.com/hc/en-us/articles/4417814078611-Bill-lifecycle)
- **Approver UX**: bulk checkboxes, mobile, email, Slack DMs with auto-reminders Mon–Fri (day 1 / day 3 / day 5 escalating to approver + vendor owner).
- **Edits mid-approval — allowlist/denylist**: descriptions, dates, line items, GL codes editable WITHOUT restarting. ALWAYS restart on: vendor change, amount change, payment details change, payment schedule change, pre-matched transaction changes. Configurable restarts: department, GL, other accounting fields. [Bill Pay approvals]
- **Reject**: requires a reason → bill status Rejected → admin fixes and resubmits; or archive (forces re-upload). **No recall/unapprove.** Workflow changes never retroactive.
- **Payment Release** (Ramp Plus, optional second gate): after full approval → "Ready for release" → a payer explicitly releases from Payments tab/inbox. Multiple releasers allowed but **no N-of-M/layered release** (single gate). Directly answers Bill.com's approve-pay blur. [Bill Pay payment release](https://support.ramp.com/hc/en-us/articles/34648566601235-Bill-Pay-payment-release)
- **Auto-approval routes**: terminal node, auto-approve imported bills, recurring-series skip — Payment Release still applies even when approval skipped.
- **AP Approval Agent (Plus, AI)**: per-bill "Approval recommended"/"Review recommended" advisory based on vendor history, PO alignment, billing pattern — advisory only, never auto-acts. [Bill Pay approvals]

## 4. Edge Cases
- **Delegation**: self-service (Profile > My settings > Delegation); original AND delegate both live concurrently (not exclusive handoff). [Delegate approvers](https://support.ramp.com/hc/en-us/articles/16777041497363-Delegate-approvers)
- Wishlist gap: no dollar cap on what a delegate may approve. [Community](https://community.ramp.com/t/ability-to-limit-dollar-amount-a-delegate-may-approve/1636)
- **Separation of duties setting**: creators barred from approving own bills; conflicted approver removed or step falls back to "Any Admin." [Bill Pay approvals]
- Real-world incident: an approval-only AP Clerk had $92k released purely from approving in normal workflow; Ramp gave contradictory explanations — the approve/release boundary not airtight in practice. (Stampli-published review roundup — competitor source) [https://www.stampli.com/blog/ap-automation/ramp-review/]

## 5. Limitations
- "Less flexible for complex approval chains, multi-entity setups" (G2).
- Steep initial configuration.
- Advanced routing + payment release behind Ramp Plus.
- No N-of-M release.
- Delegate over-permissioning.

## 6. Design abstractions worth stealing
- **Single unified tree** (conditions/approvals/notify/terminal as nodes of one DAG) — no precedence problem, clean data model.
- **Submission policy ≠ approval policy** — "does the bill have what it needs" and "who signs off" as two composable gates on one condition engine.
- **Terminal Approve node** as the auto-approval mechanism — just another leaf.
- **Payment Release as separate optional gate** — the single most important abstraction: "bill is correct" and "money moves now" independently toggleable with different permissions.
- **Non-blocking edits with a risk-profile-based restart list**: lock what changes payment risk (amount/vendor/rails/schedule); leave bookkeeping metadata free.
- **Delegation as additive, not exclusive** — avoids the delegate-also-OOO dead end.

---

## Summary comparison

| Dimension | Bill.com | Ramp |
|---|---|---|
| Builder paradigm | Multiple named policies, union-with-dedup on multi-match | Single visual tree (condition/approval/notify/terminal nodes) |
| Step logic | "Then" vs "And" | Require All vs Require Any |
| Amount handling | Policy threshold gate + per-approver caps + tiered policies | Amount = one condition type; only free-tier condition |
| Approve/pay boundary | Blended; Admin/Payer can bypass | Two-gate: Approval then optional Payment Release (Plus) |
| Retroactivity | Never — snapshot at creation | Never — in-flight untouched |
| Delegation | Constrained, 3-retry reroute | Self-service, concurrent, uncapped |
| Departed approver | Silent stall (solo) / auto-advance + Fix Record (group) | Mitigated by role/relationship targets (Any Admin etc.) |
| Escalation | None documented | Slack reminders day 1/3/5 |
| Versioning | No | Test before publish + version history/revert |

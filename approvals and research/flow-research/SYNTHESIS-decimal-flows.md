# Approval Flows for Decimal — Synthesis

**Date:** 2026-07-12. **Inputs:** deep research on QuickBooks Online, Bill.com, Ramp, Tipalti, Stampli, Vic.ai, Airbase, Melio (four sourced platform files in this folder). Companion to `roles-research/SYNTHESIS-decimal-roles.md` — roles decide WHO can act; the flow decides IN WHAT ORDER. This doc is about the order.

---

## 1. Where the industry agrees (the table stakes)

**A. The trigger vocabulary is small and converged.** Amount is universal (and the only condition several products give away free). Then vendor, department/entity, GL/category, and who-entered-it. Nobody ships a general expression language; everyone ships comparators + AND-stacking. Melio proves the minimum viable set is THREE conditions (amount / scheduler / vendor). → Our amount-split gateway already covers the universal case; vendor and category splits are the natural next two. Nothing exotic needed.

**B. Step semantics = pool + quorum.** Every mature engine landed on "a step has a pool of people and a threshold: any one / N-of-M / all" (QBO groups up to 7 with any/N/all; Ramp Require All/Any; Vic.ai per-step All/Any; Melio any-of-N per level). Sequential layers of such steps (QBO caps at 5; Melio at 3). → **We already have exactly this** (steps with any/all/N quorum). Validated; no change.

**C. Approval ≠ payment, as two independently configured gates.** Ramp's optional Payment Release, Tipalti's payment-batch approval, Vic.ai's Payment Initiator/Approver pair, QBO's payment-release workflow. Bill.com — which blends them — takes the most credible public criticism for exactly that. → **Our three-stage pipeline is ahead of the pack here**, and our Release gate does N-of-M, which Ramp explicitly cannot ("cannot layer/require-N-of-M among releasers") and QBO restricts to admins. This is a marketable edge, not just parity.

**D. Edits to the flow are never retroactive.** Bill.com binds the policy at bill creation permanently; Ramp keeps in-flight bills on the old flow AND has version history with revert; QBO is prospective-only but with zero versioning audit. Melio is the cautionary tale: editing a rule can silently auto-approve payments that were pending. → Invariant to adopt: **snapshot the policy version onto each bill at submit** (our engine already versions policies — the plumbing exists, we just need to guarantee in-flight bills keep their version) + never silently clear a pending requirement.

**E. Bill edits during approval follow a risk-based restart rule.** Ramp's model is the cleanest: metadata (descriptions, dates, GL coding) freely editable mid-approval; **amount, vendor, payment details, schedule → always restart the chain**. Stampli's inability to edit at all mid-flight is a top user complaint; QBO leaves it undocumented. → Adopt Ramp's split verbatim: restart on anything that changes the payment's risk profile, allow the rest. (Our engine's `applyMaterialChange` already recompiles on material change — this is our native behavior; we need to define the material-field list as amount/vendor/rails/schedule.)

## 2. Where the industry is weak (our openings)

**A. Rejection is underdesigned everywhere.** QBO: rejected bills are DEAD (recreate from scratch). Airbase: denied requests can't be duplicated/resubmitted. Ramp at least does reject-with-reason → fix → resubmit. Tipalti is the only one with a real model: **"Send Back to AP" (internal correction loop, reason required, lands in an AP queue) vs "Dispute" (external, vendor notified, bill parked as Disputed)** — two structurally different rejections depending on who's at fault. → Steal Tipalti's split. In our pipeline: reject-to-Review (internal fix loop, first-class, history preserved) and dispute-to-vendor (later, when the vendor portal exists).

**B. Stalls are the #1 operational failure.** QBO: no delegation, absent approver = stall until a blunt 30-day auto-KILL. Bill.com: sole-approver departure = silent stall, no alert. The good versions: Ramp's day-1/3/5 reminder cadence; Stampli's aging alerts → auto-escalate to the approver's manager; Vic.ai's timed reminders → manager escalation; Vic.ai's OOO **shadow substitute** (substitute added alongside the original, both can act, original stays visible for audit). → Our owner-fallback already beats everyone's deadlock story at COMPILE time; what we lack is the RUNTIME story: reminders on aging tasks, escalation, and OOO substitution. The engine already has `slaHours` and timers — this is wiring, not architecture.

**C. Auto-approval fast paths — deliberate, visible ones.** Ramp's terminal "Approve bill" node ("under $50 → auto-approve") and auto-approve-imported-bills preset; Stampli auto-skips approval on PO-match within tolerance; Vic.ai skips at high AI confidence. The trap: silent bypasses (QBO's creator-is-admin auto-approval; Bill.com's admin-pays-regardless). → An explicit "approved automatically" branch terminator we already have (`auto` node). The rule: fast paths must be VISIBLE IN THE FLOW and stamped on the bill ("approved automatically: under $500"), never implicit role-based bypasses. We must never build an admin bypass; our engine not having one is a feature to preserve, not a gap.

**D. One tree, not competing policies.** Bill.com's multiple-policies model needs a union-with-dedup algorithm to resolve collisions; QBO dodges by allowing literally ONE workflow (its worst limitation); Ramp's single nested tree makes collisions impossible by construction. → We already made Ramp's choice (one flow tree per stage). Validated — never add "multiple named policies."

**E. The AI-native pattern nobody else has shipped together** (Decimal's roadmap edge):
- **Vic.ai's live re-routing**: when a mid-flight bill's routing-relevant field changes, recompute the path in place — no reject/restart. Our engine's recompile-on-material-change IS this mechanism; the product decision is which changes restart consent (amount up = re-approve) vs merely re-route (department fix = recompute, keep consents where targets unchanged).
- **Confidence-gated autonomy as a spectrum** (Vic.ai): high confidence → skip human steps; low → route to humans. Maps directly onto our auto-pay agent + code-enforced gate: the agent becomes a flow actor whose authority is bounded by the same policy engine.
- **Advisory AI first** (Ramp's AP Approval Agent: "Approval recommended" chips, never auto-acts; Stampli's Billy suggests approvers, humans dispose). The safe on-ramp before autonomy.

## 3. What this means for Decimal — gap list vs. what we have

Already have (validated by research, don't touch): 3-stage structure · step pool+quorum (any/all/N) · amount splits · one-tree-per-stage · owner stand-in · SoD switches · engine-enforced per-task actors · N-of-M release · policy versioning · draft/publish separation · simulator ("test the pipeline" — nobody else has a live simulator; QBO/Ramp users test in production or Ramp's pre-publish test).

**Build agenda, ordered:**
1. **Reject → fix → resubmit loop (P0).** Approver rejects with a required reason → bill returns to Review stage ("Sent back — needs changes" state) → reviewer fixes → confirm re-enters approval fresh. History preserved on the bill. This is the biggest UX hole in our lifecycle today and the industry's most-complained gap.
2. **Material-change policy (P0).** Define the restart list (amount, vendor, payment rails, schedule) vs free-edit list (descriptions, coding, dates). Engine recompiles either way; consents reset only on the restart list.
3. **Policy snapshot on the bill (P0, small).** Stamp policy id+version on each approvable at submit (mostly exists); surface "approved under flow v3" in the bill's history. In-flight bills never adopt a new version.
4. **Aging + reminders + escalation (P1).** SLA timers exist in the engine; add: reminder notifications on aging tasks (day 1/3/5 pattern), escalate-to-owner after a configurable wait. NO auto-deny ever (QBO's 30-day kill is an anti-pattern; an aged bill escalates, it doesn't die).
5. **OOO substitute (P1).** Vic.ai's shadow model: substitute added alongside the original for a scheduled window, either may act, audit shows both. Engine's acting/delegate seat-assignment kinds already model this.
6. **Auto-approve fast path in the builder (P2).** "Bills under $X are approved automatically" as an explicit terminal node in the Approval stage + stamped provenance on the bill. (Trusted-vendor fast path later.)
7. **Vendor/category conditions (P2).** Second and third split types in the builder (vendor-is / category-is), same gateway UI as amount.
8. **Advisory AI chip (P3, roadmap).** "Approval recommended — matches vendor history" on approval tasks; the on-ramp to confidence-gated autonomy with the agent as a policy-bounded actor.

**Anti-pattern checklist (never build):** admin pay-bypass · silent auto-approval on creator=approver (our R-rules already hard-block) · auto-deny on age · rule edits clearing pending approvals (Melio) · multiple competing policies · reject-as-terminal-state · bulk-import paths that skip the pipeline (all intake routes must enter Review).

## 4. Terminology guardrails
Product copy stays jargon-free per the no-crypto-jargon rule and QBO's plain-words lead: "any one approves / both must approve / 2 of 3", "sent back for changes", "approved automatically", "reminder", "fill-in approver". Never: quorum, policy, SoD, veto, escalation matrix.

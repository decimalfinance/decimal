# Roles & Access for Decimal — Synthesis

**Date:** 2026-07-12. **Inputs:** deep research on QuickBooks Online, Bill.com, Ramp, Tipalti, Stampli, Vic.ai, Airbase, Melio (see the four platform files in this folder, every claim sourced there).
**Trigger:** realization that mature AP products don't ask users to invent role structure — they map the product's entire visibility/action surface once, then ship prebuilt roles as opinionated bundles over that map.

---

## 1. What EVERY platform converges on (the pattern is unanimous)

Eight products, three market segments (SMB → mid-market → enterprise), and they all landed on the same shape:

**A. Roles are named after jobs in the bill's journey, not access tiers.**
Bill.com: Clerk → Approver → Payer. QBO: Bill Clerk → Bill Approver → Bill Payer. Tipalti: AP Clerk → Bill Approver → Payer/Controller. Stampli: Requester → Approver → AP Processor. Vic.ai: Accountant → Invoice Approver → Payment Initiator/Approver. Nobody ships "Level 2 User." The role name IS the explanation.

**B. The same 4-6 archetypes appear everywhere:**
| Archetype | What they do | What they NEVER see |
|---|---|---|
| **Admin/Owner** | everything; users, settings, policies | — |
| **Clerk/Processor** (enter) | create/edit bills, vendors, coding | can't approve, can't pay, no bank data |
| **Approver** (attest) | see assigned bills + line items + history; approve/deny | bank details, payment execution, often payment history |
| **Payer** (release) | execute payment on ALREADY-approved amounts | can't create or alter bills |
| **Accountant/Bookkeeper** | coding, sync, reconciliation | can't pay (Bill.com), can't manage users |
| **Viewer/Auditor** | read everything (or a scoped subset) | can't touch anything |

**C. "Approve" and "pay" are always separate capabilities, and pay always has the harder ceiling.**
QBO: any Approve-checkbox role can approve, but payment release is admins-only. Bill.com: Payer is capped at the approved amount. Ramp: Payer flag only grantable to Admin/AP roles. Tipalti: payment-batch approval is a second gate after invoice approval. Vic.ai: Payment Approver is a distinct role from Invoice Approver. This IS our "approved ≠ paid" — the industry-standard version of it.

**D. The mechanism of visibility control is feature-surface removal, not data masking.**
QBO's "a manager can't see payments": bank fields and pay-bills screens live under different permission nodes than Bills>Approve, so the screens simply don't render for that role. (Tipalti is the exception with field-level masking behind "View Secure Details" — enterprise-grade, not needed at our stage.)

**E. Approvers deliberately see LESS — and that's the selling point.**
Bill.com markets it explicitly: approvers "participate in Payables without you having to provide access to your bank account." Ramp locks amount/payment-details/vendor from the approver's edit view by default. Melio's Approver sees ONLY the bills assigned to them. The user's insight ("the reviewer's role ends after review — it doesn't need to know what happens after") is exactly this pattern.

**F. Approval workflows are built ON TOP of roles, and become trivial because of them.**
Roles answer "what can this person see and do"; the workflow only answers "in what order." Approvers are pickable by person OR role (QBO, Ramp, Vic.ai all support both). Role gates eligibility (Bill.com: only Approver-capable roles can even be placed in a chain). Once roles carry the access semantics, the flow builder collapses to "pick who, per condition" — which is why theirs feel simple and ours felt overloaded.

**G. Prebuilt first, custom later (or never).**
Melio and Airbase: fixed roles only, they add new fixed roles over time. Bill.com/Tipalti: custom roles exist but plan-gated/support-gated. QBO Advanced/Ramp/Vic.ai: templates you clone-and-edit. Nobody makes users start from a blank permission matrix. For Decimal v1: **prebuilt only.**

**H. Known traps documented in the wild (avoid):**
- QBO auto-approves when the bill's creator is also the assigned approver — an SoD hole users must configure around. (Our engine's R-rules already handle this better — keep that.)
- QBO auto-denies approvals unactioned for 30 days — a dead-man's-switch worth copying eventually.
- Stampli can't restrict which GL accounts a user codes to — a field-level gap reviewers complain about; differentiation opportunity later.
- "At least one Admin always active" invariant (Bill.com) — copy this.
- Ramp bundles permissions honestly (vendor create+delete together) instead of pretending everything is independently toggleable — copy this attitude.

---

## 2. Decimal's visibility/action surface (the map we were missing)

Everything the product can show or do, by area — this is the substrate roles are defined over:

| Area | Objects/actions |
|---|---|
| **Bills** | view queue, view a bill's details/document, create (upload/forward), edit details, confirm review (send to approval), dismiss |
| **Coding** | view/edit GL coding, coding inbox, sync-to-QBO status |
| **Approvals** | view own approval inbox, approve/deny assigned bills, view approval history |
| **Payments** | view payment queue/status, view payment history/proof, sign release, view amounts+destinations |
| **Treasury** | view balances, view accounts, manage accounts/signing keys |
| **Vendors** | view list, create/edit, manage payment rails (bank/wallet details = the sensitive part), invite to portal |
| **Accounting** | QBO connection, account mapping, failed syncs |
| **Members & roles** | view team, invite/remove, assign roles |
| **Governance** | view pipeline config, EDIT pipeline config (owner), protections |
| **Auto-pay/Agents** | view agent activity, configure limits |

Key sensitivity boundaries the research says matter most:
1. **Vendor payment rails** (bank/wallet details) — the fraud vector every platform walls off hardest.
2. **Payment execution + treasury balances** — the money surface.
3. **Everything else** (bills, coding, approvals) — the work surface; safe to be generous with.

## 3. Proposed prebuilt roles for Decimal (v1: five, fixed)

Named for the pipeline stage, mirroring the industry archetypes. Roles now CARRY permissions (this supersedes "roles are permission-free labels"):

| Role | Sees | Does | Walled off from |
|---|---|---|---|
| **Owner** (exists) | everything | everything incl. pipeline config, roles, treasury | — |
| **Reviewer** | bill queue, bill details/documents, coding | upload, fill/edit details, code, confirm review | payment queue/history, treasury, vendor payment rails, members admin |
| **Approver** | own approval inbox: assigned bills' details + line items + history; pipeline config (read-only) | approve/deny | treasury balances, payment execution, vendor rails; (bill amount: visible — needed to judge; unlike Ramp we don't hide it) |
| **Payer** | approved-payments queue, payment history, treasury balances | sign/release payments | creating/editing bills, coding, approving |
| **Viewer** | everything, read-only | nothing | (nothing hidden, everything untouchable) |

Notes:
- One person can hold multiple roles (Ramp's additive-union model — simplest possible semantics: union of grants, nothing subtracts).
- Small-team reality: a 2-person org just gives everyone Owner/multiple roles; the roles matter as the org grows.
- The engine's existing SoD rules (R1/R2/R5 + the org-configurable switches we just built) sit ON TOP: role says what you CAN do; SoD says you can't do two conflicting things to the SAME bill. These compose — don't merge them.
- **Deferred**: custom roles, amount-scoped roles, per-entity scoping, field-level masking (Tipalti-style), GL-account scoping per role (Stampli's gap — future differentiator), non-billable seat pricing.

## 4. What this does to the pipeline page (the simplification payoff)

- The pipeline page keeps its three stages, but each stage's picker now offers **people, filtered/grouped by the capable role** ("Approvers: Klaus, Priya · others need the Approver role first"). Role gates eligibility, exactly like Bill.com.
- Assign-by-role becomes possible ("any Approver") — flows survive turnover.
- The complexity the user used to carry (who should see what, what happens after my stage) moves into role definitions — written once by us, understood by everyone, exactly the QBO abstraction.
- Each role's card in Members shows a **plain-English summary** ("Can review and code bills. Cannot approve them or see payments.") — QBO's audit-documentation pattern, and it doubles as the UI explanation.

## 5. The AI angle (Vic.ai's lesson, for Decimal's roadmap)

Vic.ai defines human roles relative to what the AI already did: their Accountant reviews AI coding rather than coding; Autopilot acts as a non-human "role" gated by confidence thresholds + permission guardrails. Decimal's OCR-coding + auto-pay agent architecture maps 1:1: as the agent improves, Reviewer shifts from doing data entry to confirming AI extraction, and the agent itself becomes a permission-bounded actor in the pipeline (which our code-enforced gate already anticipates). This is the moat story: roles that natively include the AI as a governed actor.

## 6. Build order (proposal)

1. **Make the 5 roles real**: role definitions carry permission bundles; enforcement middleware per route-area (backend), nav/page gating (frontend).
2. **Members page**: assign prebuilt roles (replaces free-form labels), plain-English role cards.
3. **Pipeline page**: pickers filter by capable role; optional "any [role]" targets.
4. Later: custom roles, scoping, masking.

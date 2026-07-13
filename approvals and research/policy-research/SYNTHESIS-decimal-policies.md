# Decimal policy system — synthesis and build agenda

Sources: ramp-brex.md · airbase.md · tipalti.md · billcom-qbo.md · coupa-enterprise.md · stampli-vicai.md (researched 2026-07-13). Companion to `flow-research/SYNTHESIS-decimal-flows.md` (approval routing) and `roles-research/SYNTHESIS-decimal-roles.md` (access). This file is about the third layer: POLICY. Reviewed 2026-07-13 by the design side; their three additions are folded in below (§0, P0 item 3, D1 note).

## 0. The organizing principle: irreversibility

Everything the industry ships assumes ACH: a wrong payment is embarrassing and recoverable in a week. Decimal's settlement is irreversible — once funds move, they're gone. That single fact propagates through every rule's default: **where the industry ships a warn, we ship a block, unless we can articulate why not.** It's not a burden; it's what makes the policy layer coherent, and it's why the P0 gates are P0 — we are the platform where a duplicate payment or a swapped payout address is unrecoverable.

## 1. The one sentence that organizes everything

Across all eight platforms the same split shows up, and Tipalti states it cleanest:

> **Approvals decide who must sign off. Policy decides whether this can be paid at all. Policy always wins.**

A fully-approved Tipalti payment still cannot pay a "Not Payable" payee. That's the model: policy is a set of gates that sit UNDER the approval pipeline, that no amount of sign-off authority can override. Decimal already lives this philosophy (the code-enforced gate IS the moat) — the policy system makes it visible and configurable.

## 2. The converged enforcement vocabulary (adopt verbatim)

Concur's red/yellow model plus Coupa's third pattern is the whole grammar. Every policy rule Decimal ships gets exactly one of three enforcement modes:

| Mode | Behavior | Example |
|---|---|---|
| **Block** (red) | Cannot proceed until resolved. Override = a structured, logged escalation, never a silent bypass. | Duplicate bill; vendor with no verified payment rail; bill over the org ceiling |
| **Warn** (yellow) | Proceeds, but requires a justification and is flagged to the approver. | Memo missing on a bill over $500 |
| **Route differently** | Neither blocks nor just warns — it changes the approval path. | First bill from a vendor takes an extra step (we already ship this as the firstBill split) |

**Warn is the narrowest mode and must feel that way** (design-review addition): a rule earns "warn" only if a reasonable person genuinely might proceed anyway. If nobody should ever proceed past it, it's a block. If it's just information, it's not a rule — it belongs in the decision packet. Warn rules should be rare and expensive to add.

Design constraints learned the hard way by others:
- **A soft warning that fires unreliably is worse than nothing** (QBO's duplicate-check-number warning is a community-forum punchline). If we can't enforce a rule reliably, don't ship it.
- **Alert fatigue is real** (Concur says so explicitly): default most rules to block-or-nothing; yellow is for genuine judgment calls only.
- **The violation must explain itself at the point of failure** — name the clause ("Blocked: this looks like a duplicate of INV-208 from Helios, paid May 12"), never "declined, ask an admin" (both Ramp and Brex fail this today).

## 3. What Decimal ALREADY has (don't rebuild it — rename and surface it)

We're further along than the research brief assumed. Existing pieces that ARE policy:

- **The Protections page** (R1 no self-approval, R2 entry≠approval, R5 approve≠release, R7 verified payout changes; R7 non-relaxable in code) — this is a policy rule pack with per-rule relaxation and audit already. R7 is precisely the control Stampli/BILL treat as the #1 fraud gate (bank-detail change verification), and ours is a hard gate, not BILL's advisory email.
- **Spending-limit policies + agent bounds** — Vic.ai's whole differentiator ("autonomy is earned, policy-bounded") is our auto-pay architecture already: the agent acts only inside code-enforced limits.
- **Counterparty wallet trust / vendor rails on the vendor record** — the embryo of Tipalti's Payable/Not-Payable gate.
- **firstBill / vendor / category / amount splits** — the route-differently mode, shipped.
- **Policy versioning + non-retroactivity + sent-back loop** — BILL's "edits bind future bills only" semantics, already in the engine.
- **Advisory signal chip** ("Looks routine / Worth a look") — the yellow-flag primitive.

The gap is NOT machinery. It's: (a) a few missing gates (duplicates, ceilings, payable-status), (b) one legible home where an owner sees and sets all of it, and (c) always-on defaults.

## 4. Decisions

**D1 — One policy home (Brex, not Ramp).** Ramp scattered policy across three surfaces and it reads as chaos; Brex's single "Manage policies" page is the right IA. Decimal: evolve the Protections page into **Policies** — one page of rule cards. Each card: plain-English rule, enforcement mode, scope, who last changed it. The approval-flow canvas stays its own page (routing ≠ policy). Naming note: this reverses the earlier "Protections, not Policies" ruling — the name collision with the engine's internal policy trees is gone (the builder says "flow" everywhere now), and "policies" is what finance people call this page. **Carry forward the relaxation-with-safeguards ceremony to every relaxable rule** (owner acknowledgment, badge on affected bills, monthly exceptions digest) — a page of plain toggles would invite silent off-switches.

**D2 — One rule shape (Airbase).** Every rule is `conditions → outcome`: conditions from the SAME vocabulary the flow builder already uses (amount, vendor, category, first-bill; later department), outcome = block / warn / route + required-fields. No bespoke policy types per feature. This means the policy engine reuses `evalPredicate` — the compile-time predicates we already have.

**D3 — Always-on background controls, with published defaults (Bill.com's posture + Stampli's gap).** Duplicate detection and payout-change verification are not settings an SMB configures — they're on from day zero. And unlike Stampli/Vic.ai (who publish no defaults and make you "call us to configure"), every Decimal default is stated on the card: "start safe, show your defaults."

**D4 — Override = escalation, and it's a first-class event (Airbase + everyone's audit lesson).** No "bypass" button. Overriding a block means a higher authority approves an explicit exception, which writes a structured `policy_overridden` event (rule, bill, who, why). Config changes are themselves audited (who changed which threshold when) — the one thing even Tipalti is thin on, and cheap for us since the engine already has an event stream.

**D5 — The agent's autonomy IS a policy card (Vic.ai + Stampli).** Auto-pay bounds move conceptually under Policies: the org sees "The agent may pay on its own when…" as rules, including Stampli's **hard-precondition disqualifier list** — conditions that force human review no matter what else passes: first bill from a vendor, payment rail changed recently, open duplicate flag, amount above the agent's bound. Cheap, auditable, and honest — and on irreversible rails, these preconditions are BLOCKS, not flags (Stampli's soft-guardrail stance doesn't transfer to crypto settlement; there is no ACH recall). Plus one precondition from our own architecture (design-review addition): **the agent may never be the only party to have seen a bill** — autonomy is earned per VENDOR, not just per amount: auto-pay requires the vendor to have N prior human-approved bills, so the ceiling is "under $X AND the vendor has a human track record".

**D6 — Skip list (for our segment, 5–50 people).** No 3-way match / receiving subsystem (no POs, no warehouses), no commodity-code category trees, no SpendGuard-style behavioral fraud scoring (the human pipeline IS the fraud control at this volume), no crowdsourced blocklist (scale play), no AI-policy-document ingestion (a small org's policy is a dozen toggles, not a 40-page PDF — Ramp's Policy Agent solves a problem our customers don't have yet). Revisit tolerances/PO-match only when PO objects exist.

## 5. Build agenda

**P0 — the two missing hard gates:**
1. **Duplicate-bill detection** — vendor + invoice number + amount + date, exact and fuzzy (Stampli's layering: check at intake AND again at release), block-by-default with logged override. We currently have nothing here; it's the most-cited AP control in every source and the QBO complaint threads show what half-doing it costs.
2. **Vendor payable gate** — a bill cannot enter Payment unless the vendor is payable: verified/trusted rail present, not suspended. Two severities like Tipalti Detect: **held** (needs review, clearable) vs **blocked** (terminal, primary-admin only). Re-check at release time, not just at intake (Tipalti's continuous re-screening — matters double when an agent pays autonomously).
3. **Pinned payout destination** (design-review addition — our gap, invisible to industry research): approvers authorize "pay Acme at address X", but the release ceremony resolves the address at release time. Any change to the vendor's rail between approval and release — even a legitimate, approved change — invalidates the release and forces re-approval. The engine already has this cascade (scenario H5: payment-method change between approved and quorum-met → release plan invalidated, on-chain proposal cancelled); the P0 work is surfacing it as a visible, named policy rule rather than an engine implementation detail.

**P1 — the Policies page:** Protections evolves into the single home: the R-pack cards + duplicate card + payable-gate card + org bill ceiling ("bills over $X are blocked / need the primary admin") + agent-autonomy card with the hard-precondition list. Per-card enforcement mode where relaxable, stated defaults, config-change audit line on each card.

**P2 — documentation rules (yellow):** memo/attachment/coding required over $X, enforced at Review with recurring reminders that stop when someone with authority marks it reviewed (Brex's mechanic — the review action is the audit record).

**P3 — budgets:** live "remaining this month for Software: $3,200" on the review screen (Coupa's single most-loved miniaturizable feature), warn-only at first. Needs a budget object; do it when a customer asks, not before.

## 6. Anti-patterns (never do)

- Controls that are opt-in via a support ticket (BILL's Dual Control) — safety defaults ON or visibly OFF, never hidden.
- Unreliable soft warnings (QBO duplicate checks) — enforce reliably or don't ship.
- Gating basic controls behind a premium tier (QBO Advanced) — SMBs get real controls by default; that IS the pitch.
- "Last matching rule wins" silent ordering (Brex's foot-gun) — if rules can conflict, most-specific wins and the UI says which rule fired.
- Vendor rules as "soft suggestions" (Airbase) — vendor gates are hard or they're nothing.
- Withholding audit history from the customer (BILL during disputes) — the org owns its full trail, always.
- Retroactive or silently-pending-clearing policy edits (Melio, from flow research) — same non-retroactive discipline as flows.

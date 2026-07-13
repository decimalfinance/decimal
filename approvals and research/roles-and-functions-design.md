# Roles & Functions — Design Ask (model + screens)

Date: 2026-07-06 · Status: model LOCKED (settled between claude.ai + Claude Code, market-verified against Bill.com's role/approval-group split). Screens section → Claude Design. Model section → Claude Code builds.
Depends on: hierarchy-data-model.md (seats), routing-policy-model.md (ApproverTarget), approval-flow-builder-design.md (who-picker), agent-layer-design.md (assist/selector seam). Vocabulary: SESSION-NOTES §2.

## The core split (non-negotiable, this is the whole point)

Two layers that must never merge:

1. **Access roles** — `owner` / `admin` / `member`. *Permissions*: who can invite people, change settings, publish a flow, relax a protection. Small fixed set. Already exists in the member model. This is authorization, not approvals.
2. **Approval functions** — CFO, Controller, Finance, Budget owner, Department head, Legal, Manager, … *What a person does in routing.* This is the missing layer. It maps **directly onto the engine's existing seats** — a function IS a named seat. Surfacing work, not new architecture.

**The guardrail that keeps them from re-merging: a function carries ZERO permissions.** Holding "CFO" grants no access. If someone needs both, they get the admin *access role* and the CFO *function* independently. The moment a function grants permissions, the two layers have silently fused and the model has failed. (This is the discipline Bill.com doesn't enforce — their roles bundle both — and it's why their approval routing is brittle.)

Why this split matters, concretely: Bill.com documents that "if a deactivated user was the sole approver in a multi-step policy, that policy must be updated manually." That fragility exists because they route partly to *people*. Routing to *functions* (seats) means a person leaving → reassign the seat → every flow keeps working untouched. We structurally don't have their bug.

## Model decisions (LOCKED — for Claude Code)

1. **Functions = permission-free seats** on the org's hierarchy. Reuse the seat table; no new primitive.
2. **Curated starter set, seeded per org, ungated:** Owner, Finance, CFO, Controller, Budget owner, Department head, Legal, Manager. Plus **custom functions** any org can add (seats are arbitrary already). Do NOT gate custom behind pricing (Bill.com does; wrong for our SMB wedge).
3. **A person may hold multiple functions; a function may be held by multiple people** (the latter = a group seat, already supported → "any Finance approver").
4. **Routing targets functions FIRST, people as the escape hatch.** The builder's who-picker defaults to "the CFO signs off" (resolves via seat → whoever holds it); "Priya specifically" is the exception. This reverses the v1 shortcut and kills the sole-approver-leaves fragility. Engine `ApproverTarget` already has `seat` and `person`; this is a picker-default change, not an engine change.
5. **Unresolvable-function handling (settled): hard-lint, presented as a fixable problem, owner-fallback offered as an explicit one-click fix — NEVER silent.** A "CFO approves" step with no CFO assigned = a red problem at publish: *"No one holds 'CFO' yet — assign someone, or route this step to the owner instead."* One click either way. Reuses the deadlock fix-menu pattern already shipped. Silent auto-fallback is forbidden on a governance surface (it could under-approve a large bill invisibly). The engine's `onUnresolvable` field backs the fallback choice once the user picks it.
6. **Assistant gets the real roster + functions** (already live in weaker form): `assist` proposes flows against actual people/functions, never invents a title nobody holds — "you don't have a CFO; want the owner to sign the biggest bills?" Starter chips generated from the org, structure-based not title-based. This is the agent-layer selector seam's first concrete surface; zero blast radius (suggests, humans decide).

## Screens (→ Claude Design)

Same design system as the other screens. Plain language, no crypto terms, no "seat"/"hierarchy"/"function-as-jargon" — say **"role"** in the UI for approval functions (the access layer is invisible plumbing to most users; only owners/admins see it in settings).

**Screen A — Members & roles page (redesign of the existing Members page).**
- Roster: person, email, access level (Owner/Admin/Member — quiet, small), and **their approval roles as pills** (CFO, Budget owner…). The approval roles are the prominent thing; access level is secondary.
- Assigning a role = a picker on the person: existing roles + "create a new role" inline (creates a seat). Vacant roles (created, unassigned) show in a small "needs someone" tray — same scaffold-as-you-draw pattern as the flow builder.
- A person with no approval role is fine (they participate, request bills) — don't force one.
- Show, per role, how many people hold it and whether any flow depends on it ("used in your approval flow") — so removing a role warns if it'll break routing.

**Screen B — Invite flow.**
- Invite by email → set access level (default Member) → optionally assign approval role(s) now or later. Keep it 2 fields + optional roles; don't front-load.

**Screen C — Flow builder who-picker (update the shipped builder).**
- The "Who can approve" picker in the step inspector now shows **roles first** (CFO, Finance, Budget owner…), people below, with the info-nudge already present ("use a role, not a person — it keeps working when someone leaves") — now the *default*, not a tip.
- When a step targets a role no one holds: the red problem + inline fix from decision 5.
- The simulator resolves roles → real people (already does for people; extend to roles) with the why-chip showing the role ("Priya · as Finance").

## v1 line + open items

v1: the two-layer model, curated+custom roles as seats, Members page role assignment, invite flow, who-picker routing-to-roles with the hard-lint fix. Deferred: role hierarchies/seniority ordering beyond what amount-tiers already give, per-role default authority amounts (a later convenience), cross-entity roles (waits on multi-hierarchy).

No open questions for Fuyo — decisions 1–6 are settled. Anything further surfaces from the build.

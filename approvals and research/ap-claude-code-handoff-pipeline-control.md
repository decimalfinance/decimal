# AP Pipeline Control (Approval flow page, reconceived) — Claude Code Build Handoff

**From:** Claude Design · **Date:** 2026-07-10 · **Status:** design accepted, build-ready. **Replaces** the AI-first flow builder page (`Flow Builder.dc.html` stays as record; AI returns later as global chat, not here).
**Design source (pixels are truth):** `Pipeline Control.dc.html` in the project. This doc explains it; where they differ, the file wins.
**Read first:** `CLAUDE.md`, `uploads/DESIGN-CONTEXT-app-shell.md` (sidebar), `uploads/DESIGN-ASK-ap-pipeline-control.md` (the locked model + backend this implements), `uploads/roles-and-functions-design.md` (roles = permission-free labels).

---

## 1. The reframe

The sidebar page "Approval flow" is not "build an approval flow" — it is **the owner configuring how the org controls its whole AP pipeline**. The page is a **top-to-bottom pipeline narrative with two editable zones** embedded in it. It teaches the pipeline; it does not hand out templates. **No presets. No AI rail.** Manual-first.

## 2. The pipeline (three stages, plain labels)

Centered vertical narrative on a grey dot-grid canvas, stages joined by connectors, labeled with plain tags — **Review → Approve → Release** (we cut "queued for payment" as a stage and cut all "Automatic / You decide" wording):

1. **Review** (explain card, not configurable here) — "A bill arrives and gets reviewed": details filled in and confirmed by a person on the Bills page before approval. The card shows the reviewer as a person (avatar + "Jordan Reyes · reviews the bills") — stages are people-run, never faceless.
2. **Approve** (editable zone #1) — "Who approves a bill". The flow canvas (see §4).
3. **Release** (editable zone #2) — "Who releases the money" (see §5). Zone header carries the load-bearing line: *"The final gate. Approved is not paid — once a bill clears approval, these people sign to actually send the money."*

Terminal below release: solid green pill **"Money leaves the account."**

**Zones** are white bordered containers (`--r-md` — NOT `--r-lg`, which is undefined and renders square) with a header (title + one-line sub + "View only" lock for non-owners) and an inset canvas body.

## 3. Permissions — owner-only editing

`viewer` states: **Owner** (full edit: Publish/Undo in the topbar, "+" inserters, clickable cards, signer add/remove, quorum segment) vs **Member/Admin (read-only)**: every edit control absent, topbar shows a lock + "Only the owner can change this", zone headers show "View only", release quorum renders as static text. Backend already rejects non-owner publishes; the UI must not show dead controls.

## 4. Editable zone #1 — the approval cycle

Reuses the shipped canvas language (slim white cards, elbow branches, gateway capsule):

- **Step card** = title (separator line below) + the people who approve (avatar + name + their role as a faint right-aligned label, e.g. "Omar Reyes — Budget owner"). Quorum in plain words ("any one approves" / "all must approve" / "at least N") — **hidden entirely when the step has one person**.
- **People-first**: a step points at specific people; roles are an optional convenience in the picker ("Klaus · CFO" labels from `people[].roles`), never required setup.
- **Gateway** (dashed info capsule, "Is it over $10,000?") = amount split. A connector runs gateway → branch bar → labeled lanes ("Over $10,000" / "$10,000 or less"; the no-extra-step lane is a plain text note, not a card). Boxes mean a person decides; capsules mean routing.
- **"+" inserters** between cards (owner only): add a step or a split.
- **Click a card** (owner only) → editor dialog: step name · who approves (+ Add person; helper "Pick people. A role works too, if you'd rather it survive turnover.") · quorum.
- **The rule, rendered as a quiet footnote**: *"The person who reviewed a bill can't approve it — if that empties a step, it falls to you as owner."* (Exact model: reviewer excluded from every step; empty step → owner stand-in, never a deadlock; stuck only if even the owner can't cover.)
- **Empty state teaches** (pageState "First run"): "Add your first step — choose who signs off on a bill" + one CTA. No template menu, no chat pointer.

## 5. Editable zone #2 — payment release (NEW)

A single signer set + quorum, no amount tiers in v1:
- Signer chips (avatar + name + role, removable ×) + "+ Add a signer" (owner only).
- "How many must sign:" segmented **Any one / Both** (generalize: any one / all / N when >2 signers). Read-only renders the choice as text ("Any one signs").
- Visually distinct from the approval zone (darker border) — it's the money-out gate.

## 6. Test rail (right, 440px) — proves the WHOLE pipeline

- Inputs: **amount slider** ($0–30k) + **"Reviewed by {person}"** toggle. Nothing else (engine branches on amount only — no fake controls).
- "The bill's journey": resolved chain of people with neutral why-chips ("every bill", "over $10,000", "owner stand-in"). Reviewer-conflict shows live: reviewer=Omar → Zaid replaces him with the note "Omar reviewed this bill, so he can't also approve it… falls to you, Zaid, as owner."
- Ends with the **release line** in the green summary: "Then Priya or Zaid signs the release — and the money goes out" (flips with quorum). The owner proves approval AND release in one panel.
- First-run: empty-state ("Nothing to test yet").

## 7. Backend contract (built, owner-gated)

- `GET /approvals/flow` → `{ flow, draft, people }`; `PUT /approvals/flow/draft` (autosave); `POST /approvals/flow/publish` (owner-only); `POST /approvals/flow/simulate` → chain + stand-in/stuck for the Test rail.
- `GET /approvals/release` → `{ approvers, quorum, configured, people }`; `POST /approvals/release/publish` (owner-only) `{ approvers: personId[], quorum }`.
- Flow node: `{ id, type:'step', title, approvers: personId[], quorum: 'all'|'any'|number }` | `{ id, type:'if', amountGteUsd, then:[], otherwise:[] }`.
- `people[]` carries `roles: string[]` for picker labels.

## 8. Rulings (do not regress)

- Say **"role"**, never seat/function; never surface "quorum"/"policy"/"multisig" — plain words ("any one signs", "both must sign").
- Reviewer-can't-approve (not "requester") is the exclusion rule's UI language.
- No tinted-translucent components; color only as signal. People-only avatars. Solid opaque chips.
- Publish is the only commit; "Unpublished changes" pill while dirty; Undo available.
- Full page includes the real sidebar (Approval flow active); compose 1600×1000, sidebar x 0–240, content 1360.
- Demo data (Omar/Klaus/Priya/Zaid/Jordan, Decimal Labs) shows shape only — everything is data-driven from `people` + `flow` + `release`.

## 9. Tweak states in the design (demo only)

`viewer` (Owner / Member read-only), `pageState` (Configured / First run), `darkMode`. In product these are just live conditions.

## 10. Deferred (don't build)

Amount-tiered release; per-person release limits; role hierarchies; the AI assistant on this page (global chat later).

## 11. Gotchas (hit during design)

- Radius tokens: only `--r-xs/-sm/-md/-pill` exist — `--r-lg` is undefined and silently renders square corners.
- DC/CSS: no `{{ }}` holes mid-`style` value; no SVG through holes (use `sc-if` between literal SVGs); compute whole style strings in logic.

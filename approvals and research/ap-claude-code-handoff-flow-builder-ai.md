# Approval Flow Builder (AI-first redesign) — Claude Code Build Handoff

**From:** Claude Design · **Date:** 2026-07-08 · **Status:** design accepted, build-ready. **Replaces** the earlier card-dragging builder.
**Design source (pixels are truth):** `Flow Builder.dc.html` in the project. This doc explains it; where they differ, the file wins.
**Read first:** `CLAUDE.md`, `uploads/DESIGN-CONTEXT-app-shell.md` (sidebar), `uploads/DESIGN-ASK-flow-builder-ai.md` (the ask this implements). The backend (flow model, `simulate`, `publish`, and the new `flow/assist` endpoint) is described there and is the data source.

---

## 1. Model: Chat builds it · Canvas shows it · Test proves it

One page, three regions, one loop. The operator **describes** how bills should be approved; the AI produces the whole flow; the **canvas redraws** to show it; the **Test simulator** proves who a real bill would go to. Refine by chat or by clicking a card. **Publish** is the only thing that goes live — an explicit human click.

## 2. Layout (inside the app shell)

- **240px sidebar** (Approval flow active under Governance). Content = viewport − 240.
- **Header**: eyebrow "Governance" / "Company approval flow" / an **"Unpublished changes"** pill when dirty; right side = problems indicator · **Undo** · **Publish**.
- **Left = canvas** (scrolls). Background is **grey (`--bg-surface-2`) with a dot grid** so the white cards read against it — do not leave it white.
- **Right = a 468px rail with two tabs: Assistant (default) · Test.** Card editing is a small inline popover on the canvas, NOT a rail tab.

## 3. The canvas — reads as a self-explaining policy

Vertical tree: **"A bill arrives"** → approval steps → a **gateway** → labeled branches. Rules to preserve:

- **A box = a person decides.** Approval-step cards are the ONLY boxes (white, bordered, soft shadow). Each carries: a type icon + step title, a **separator line**, the approver (avatar + name) with a quiet **"needs any 1"** quorum caption, and a plain-language **rule note** — plus an **exception note** where one exists (Finance card: "If finance requested the bill, it routes to Omar instead — no one approves their own." = R1, in words). The canvas should let a user read the entire policy — every rule and exception — without opening anything.
- **A condition is NOT a box.** The amount split is a **dashed, info-tinted gateway capsule** ("Split by amount → Is it over $10,000?"), visually distinct from decision boxes so routing ≠ deciding.
- **Branches** use a proper elbow connector: vertical from the gateway → horizontal bar → drop into each lane. Lanes are labeled by outcome ("Over $10,000" / "$10,000 or less") and each ends in a solid green **"Sent to pay"** terminal pill. (Auto-approve card was cut — the ≤threshold path goes straight to pay.)
- **AI edits highlight on redraw**: newly added cards get a green outline + "Just added" badge; changed = accent. This is a transient state after an assist response.
- **Card layout tweak**: a `peopleRight` prop toggles person-on-the-right vs the default stacked (title → separator → person → note). Default stacked.

## 4. Assistant tab (the hero — the new thing)

- A **chat**: scrollable message thread + input ("Describe how bills should be approved…").
- **Empty state = onboarding** (no separate picker page): a friendly AI prompt + **starter chips** that seed the chat ("Two approvers for everything", "Small bills auto-clear, big ones climb to the CFO", "Route by who owns the budget", "Start from scratch"). Picking one builds the flow + populates the thread.
- **AI applies to the canvas immediately** — the canvas IS the shared draft, no "shall I apply?" gate. The AI's message explains the change in one sentence + the resolved outcome ("Done… A $12,000 bill now goes to Omar → Priya → Klaus. Smaller bills clear after Priya."). **Undo** reverts the last change. **Publish is the only commit.**
- **AI is proactive about traps, in-thread** — the deadlock/validation surface is delivered as conversation, not a banner: "Heads up: with only 2 people, requiring 2 approvers means no one can approve their own bills — Zaid's bills would get stuck. Want me to require 1 instead?" with inline fix buttons (**Require 1 instead** / Keep 2 anyway). Applying the fix resolves it in-thread and clears the amber on the canvas. In this state the offending step also wears a "Could get stuck" amber badge + amber "needs any 2" quorum.
- The AI can answer test questions in chat with the real resolved chain (same `simulate` data as the Test tab).

## 5. Test tab (the trust-builder — expose only what routes)

Sample bill = **amount slider ($0–30k)** + **"requested by {person}"**. Nothing else — the engine only branches on amount today, so **no department/vendor controls** (no fake UI). Then **"Who this bill would go to"**: the resolved chain of real people with why-chips (`always`, `added · over $10k`, `stand-in`), the **R1 substitution note** in plain words when the requester is an approver, a green summary, and the **"would get stuck"** state. Recomputes live on every edit (chat, card, or slider). Keep **pinned tests** (chips) that re-run on each edit.

Verified behaviors in the design: $12k → Omar/Priya/Klaus (3, then paid); $4k → Omar/Priya (2, then cleared); requester = Priya → her Finance step becomes **Dev Kapoor** with the stand-in note.

## 6. Direct manipulation still works

Clicking a canvas card selects it (accent border) and opens a **compact inline popover** (step name · who can approve · how many — Everyone / Any one / Any 2). Typing and clicking edit the same flow.

## 7. Rulings to preserve (do not regress)

- **AI proposes, human publishes.** Never auto-publish; every AI change is a visible, undoable diff accepted by continuing; Publish is deliberate. Governance surface — AI convenience must never become AI authority.
- Four card types only (Approval step · If… · Auto-approve · Notify); plain finance language (never policy/node/quorum/hierarchy or crypto terms). "quorum" is internal only — UI says "needs any 1".
- Box = person decides; capsule/gateway = routing condition. People-only avatars.
- amber = would-get-stuck / needs-a-look, red = blocks publish, green = resolves / added / paid, accent = active/selected.
- One flow per org (branches express by-amount / by-department); no multi-flow gallery yet.
- Full page includes the real sidebar; compose 1600×1000, sidebar x 0–240, content 1360.

## 8. Backend contract (per the ask)

`flow` = tree of `{ step | if(amount) | auto | notify }` over real people. `simulate(flow, sampleBill) → resolved chain + protections (R1 stand-ins, deadlocks)` powers both the Test tab and the AI's answers. `publish(flow)` writes an engine policy version. **New:** `flow/assist(message, currentFlow, people) → { flow, explanation }` via constrained AI generation with `simulate` available as a tool — the AI returns only a flow tree + words, never touches the engine directly.

## 9. Deferred (don't build)

Multi-flow gallery; department/vendor routing + any dept/vendor cards or test controls (engine branches on amount only — leave them out, don't stub); notify delivery; pinned-test management beyond simple chips.

## 10. Implementation notes / gotchas

- **DC/CSS trap**: never put a `{{ }}` hole inside a `style="…"` attribute mid-value, and never inject SVG markup through a hole (holes are text only) — use `sc-if` between literal SVGs. Compute whole style strings in logic. Use defined radius tokens (`--r-md/-sm/-pill`); an undefined token renders square.
- The three scenarios in the design's `view` tweak (Built flow / First run / Deadlock caught) are demo states — in the product they're just the live flow's condition, all driven by `flow` + `assist` + `simulate`.

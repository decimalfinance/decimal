# The Flow Canvas — possibilities first, then the editor

**Date:** 2026-07-12. Written after the user's critique: the editor was built vertical-first and basic-first; this doc inverts it — enumerate what real orgs build, then design the canvas that can hold all of it.

---

## 1. The complexity spectrum (what real orgs actually build)

**F0 — Nothing (solo founder).** No reviewers, no approvers, one payment signer. The bill flows: received → confirmed by whoever → paid. *Smallest legal flow: one payment signer.*

**F1 — One gate (5-person startup).** Any teammate confirms details; the founder approves everything; the founder pays. One step per stage.

**F2 — Amount ladder (classic SMB, the QBO default).** Bookkeeper reviews. Approval: under $1k auto-approved; $1k–$10k → office manager; over $10k → founder AND office manager. One payment signer.

**F3 — Vendor carve-outs (agency).** Everything as F2, plus: bills from the 3 media vendors also need the media director's sign-off (they bill big and often); bills from the landlord skip approval entirely (fixed rent, auto-approve under the known amount).

**F4 — Category routing (50-person company).** Software/cloud bills also route to IT lead. Legal invoices also route to GC. Marketing spend routes to CMO over $5k. All ON TOP of the amount ladder — meaning multiple independent conditions can each ADD steps.

**F5 — Department matrix (mid-market).** The requester's department decides the first approver (engineering bills → eng director; ops bills → ops director), then the amount ladder applies, then category specialists join conditionally. This is Stampli's amount × department × category matrix.

**F6 — Multi-entity + parallel + escalating (the ceiling).** Per-entity flows; a $100k bill from a NEW vendor coded to capex: reviewed by AP clerk, THEN in parallel {IT lead + procurement + budget owner}, THEN CFO, THEN CEO; payment released 2-of-3 keyholders; every step has an SLA with escalation; PO-matched invoices under tolerance skip everything.

**Conclusion:** the tree is wide, not deep. Real flows are 2–4 levels deep but branch 2–5 ways sideways. A vertical-spine layout fails at F3; a proper tree holds F6.

## 2. The full condition vocabulary (split types)

Ranked by how often the research saw them, with what each needs from our data:

| Condition | Example | Data source | Status |
|---|---|---|---|
| **Amount over X** | over $10,000 | bill total | ✅ shipped |
| **Vendor is one of…** | Helios Grid, WPP | counterparty on the bill | ✅ shipped |
| **Category / GL is one of…** | Cloud hosting, Legal | line coding | ✅ shipped |
| **First bill from this vendor** | new-vendor scrutiny | prior-bill count | engine op exists — wire it |
| **Amount between X–Y** | $1k–$5k tier | bill total | composable today by nesting; native "between" later |
| **Department / cost center** | eng vs ops | needs a department dimension on bills — NOT captured yet | needs data model first |
| **Location / entity** | US vs EU entity | needs entity on bills/org | needs multi-entity (deferred with it) |
| **PO matched within tolerance** | auto-approve matched | needs PO ingestion | engine op exists; PO module doesn't |
| **Requester's manager** | HRIS-style routing | needs org chart | deliberately rejected (flat model, roles pivot) |
| **Payment method / rails** | wires need extra sign-off | vendor rails | later, cheap once D1/D2 rails ship |
| **Recurring / subscription** | skip re-approval on repeat | series detection | later |

**Decision:** ship *first bill from vendor* now (engine predicate `vendor_is_first_invoice` already exists; just set the attribute at submit + expose in builder). *Between*, *department*, *entity*, *PO-matched* enter as their data sources land. The split editor is built so a new condition type is one more tab — the vocabulary grows without redesign.

## 3. Layout: a real tree, not a spine

- **Recursive tree layout**: an `if` node renders its two branches side-by-side as independent subtrees; each subtree takes the width it needs; connectors are the classic org-chart elbows (pure CSS, no overlap possible by construction — this structurally fixes the Yes/No collision bug).
- **Both branches are buildable.** The No branch is a real lane you can put steps in (data model always supported `otherwise[]`; the UI now does too). Empty No = "continues on."
- **Merge is drawn**: after a branch row, mirrored elbows rejoin the spine, because in our pipeline both branches continue to the next stage (unlike QBO's Stop-terminals).
- **Whiteboard canvas**: transform-based pan (click-drag anywhere, wheel to pan, buttons/fit for zoom) instead of scroll — Excalidraw-feel. Fit-to-view centers BOTH axes from the true bounding box (fixes the 80%-of-screen reset bug).

## 4. Stage separation (the repetition problem)

Rejected: repeating the stage word on every card (what the user called ugly — "REVIEW REVIEW APPROVAL PAYMENT"), and container boxes (rejected earlier — boxes-in-boxes).

**Chosen: stage dividers + colored card spines.**
- Between stage segments, a slim solid-ink **divider pill** on the connector: ● Review · ● Approval · ● Payment — said ONCE per stage, in the stage color, like section labels on a whiteboard.
- Every card carries a **3px left border in its stage color** — so even deep inside a branch you know which stage you're in, without a single repeated word.
- Split cards keep the one functional eyebrow that earns its place: "WHEN THIS HAPPENS."
- The test rail's colored dots already match; now the canvas, dividers, and rail share one color system.

## 5. What this canvas must never lose

Editing stays sentence-simple (bold-keyword cards, click to edit, + on the lines), the live Test rail stays, publish/draft/undo stay, and complexity is opt-in: F0 fits on half a screen, F6 spreads wide and you pan around it — same editor.

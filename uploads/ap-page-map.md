# AP Product — Page Map (the complete surface inventory)

Date: 2026-07-06 · Status: reference. Derived from: target-architecture.md (subsystems), the four engine layer docs, agent-layer-design.md, approval-flow-builder-design.md, protections-surface-design.md, governance-model-design.md, ap-workbench-screen1-invoice-review.md, HANDOFF state.
Purpose: the definitive answer to "which pages exist, what is each one's job, and in what order do we design them." Design happens one screen at a time in Claude Design; this map is the queue, not a license to design everything at once.

Legend: 🟢 spec exists (design it now) · 🟡 spec needed from claude.ai before designing · ⚪ later (don't design yet)
Screenshot targets = what to capture from YouTube walkthroughs of competitors for that screen's critique round.

---

## A. The core loop (operator: whoever processes bills)

**A1 · Bills workbench — the home page** 🟡 *(spec next — Ask 5 #2)*
Job: one list that answers "what needs my attention, and where is everything?"
Key content: lifecycle states as first-class filters — Needs review · Awaiting approval · Awaiting release · Scheduled · Paid · Exceptions/Held. Row anatomy: vendor (avatar), amount, due date (with discount deadline when terms exist), state pill, who it's waiting on (avatars).
Screenshot targets: Bill.com inbox/bills list, Ramp Bill Pay list, Melio dashboard (SMB simplicity benchmark).

**A2 · Invoice review screen** 🟢 *(spec: ap-workbench-screen1-invoice-review.md — IN CLAUDE DESIGN NOW)*
Job: verify the machine read the document; confirm sends to approval.
States to design: default (3 ambers) · everything-checks-out · payee-mismatch banner · duplicate banner · new-vendor.
Screenshots: Bill.com bill entry, Stampli invoice canvas, Ramp bill review.

**A3 · Bill detail — the document of record** 🟡 *(Ask 5 #3)*
Job: everything about one bill, forever: document + verified data + approval trail (who approved, protections applied, self-approved badges) + release story + payment receipt (rail, settlement) + QBO sync status. The review screen's read-only afterlife formalized; where the decision packet's panes live.
Screenshots: Bill.com bill details, Ramp transaction detail, Stampli's conversation-on-invoice (their differentiator — study it).

**A4 · Intake setup** ⚪ *(small; likely the workbench's empty state + a settings card: your AP email address, forward instructions, upload button)*

## B. Approving & releasing (participants: approvers, keyholders)

**B1 · Approvals inbox — "waiting on you"** 🟡 *(Ask 5 #4)*
Job: every task routed to me: bill approvals, org-change consents (badged), payment-method verifications. Row: what, from whom, amount, why me. Actions inline where safe (approve/reject w/ reason), detail view for judgment.
Screenshots: Ramp's approvals queue (best-in-class), Bill.com approvals.

**B2 · Approver task view (the decision packet, rendered)** 🟡 *(likely = A3 with an action bar + the four panes; design decision to confirm when specced)*
Job: decide in seconds — what is this / is it expected / what's unusual / what happened so far, then approve · reject+reason · request info · push back.

**B3 · Release ceremony** 🟡 *(the payment-approval-by-keyholders screen; vocabulary: never quorum/multisig/sign)*
Job: keyholders confirm exactly what money leaves: batch of approved bills → destinations (verified payment-method names, not addresses), amounts, rails in plain words; each keyholder confirms; progress "1 of 2 confirmed."
Screenshots: none good — competitors don't have this surface (it's ours); Mercury's payment-confirmation flows are the closest taste reference.

## C. Rules & governance (owners/admins)

**C1 · Approval flow builder** 🟢 *(spec: approval-flow-builder-design.md — the biggest single surface; design AFTER the core loop ships)*
Sub-surfaces: canvas + four cards, who-picker with scaffold-as-you-draw, test/simulate panel with pinned cases, lint badges + problems drawer, publish diff view, template picker.
Screenshots: Ramp approval-policy builder, Bill.com approval workflow settings, any BPMN-ish tool for what NOT to feel like.

**C2 · Protections page** 🟢 *(spec: protections-surface-design.md + shipped person-scoped state)*
Cards, relax sheet (person-scope variant included), exceptions digest preview, pending-change pills (governance).
Screenshots: none direct (differentiator); Mercury security settings for tone.

**C3 · Org-change consent (governance)** 🟢 *(spec: governance-model-design.md §7 — mostly B1 rows + one consent sheet: the diff packet)*

**C4 · Members & roles** 🟢-ish *(exists in app; needs: owner/admin/member ladder, keyholder badges, role changes routing as governed acts — small delta on the existing Members pattern, spec on request)*

## D. Vendors & money

**D1 · Vendors list + vendor detail** 🟡
Job: the counterparty record: payment methods with verification states (pending verification / active / rejected), bill history, baseline ("usually $4–5k monthly"). Detail is where "payee looks different" resolves.
Screenshots: Bill.com vendor detail, Ramp vendors, Tipalti onboarding flow (the vendor-self-serve benchmark).

**D2 · Payment-method add/change flow** 🟡 *(the R7 ceremony as UX: entry → verification → active; second-person consent where governance requires)*
Screenshots: Tipalti/Bill.com vendor bank entry; Wise recipient-add flow (consumer-grade clarity benchmark).

**D3 · Treasury & funding** ⚪ *(exists in primitive form: balance, top-up via virtual account details, direct deposit; redesign later with rails receipts)*

**D4 · Payments queue / scheduling** ⚪ *(approved → scheduled → sent; becomes the discount-capture surface when the timing engine is designed — do not design before that engine exists)*

## E. Reporting & system

**E1 · Exceptions digest** 🟢 *(email + page section; specced inside protections doc)*
**E2 · AP aging & reports** ⚪ *(the CFO artifact; later)*
**E3 · Audit export** ⚪ *(bundle; later — trail already lives on A3)*
**E4 · Onboarding wizard** 🟡 *(thin 3-step: people → template → key roles; specced thin in builder doc §3; full spec when C1 is scheduled)*

---

## The design queue (one at a time, in this order)

| # | Screen | Spec | Why this order |
|---|---|---|---|
| 1 | A2 Invoice review | 🟢 done | in Claude Design now — the anchor of the core loop |
| 2 | A1 Bills workbench | 🟡 next from claude.ai | the home the review screen returns to; Claude Code needs it to wire navigation |
| 3 | A3 Bill detail | 🟡 | the review screen's afterlife + the trail; unlocks B2 cheaply |
| 4 | B1 Approvals inbox (+C3 consent rows) | 🟡 | second persona enters; engine tasks become visible product |
| 5 | B3 Release ceremony | 🟡 | completes the money story; our differentiator screen |
| 6 | C2 Protections (+ relax sheet) | 🟢 done | small, spec-complete, high trust value |
| 7 | C1 Flow builder | 🟢 done | biggest surface; deserves its own design sprint after the loop ships |
| then | D1/D2 vendors & payment methods | 🟡 | as the R7/Bridge work lands |

Everything ⚪ is deliberately not designed yet — D4 waits on the timing engine, E2/E3 wait on real usage.

## Screenshot shopping list (one pass, covers screens 1–5)

From YouTube walkthroughs, capture: **Bill.com** — bills list, bill entry, bill detail, approvals; **Ramp** — Bill Pay list, bill review, approvals queue, approval-policy builder; **Stampli** — invoice canvas, the conversation-on-invoice; **Melio** — dashboard (simplicity benchmark); **Mercury** — any payment-confirmation and settings screens (taste benchmark, not feature reference); **Tipalti** — vendor onboarding (for D1/D2 later). File them per screen; each critique round uses only its own screen's pile.

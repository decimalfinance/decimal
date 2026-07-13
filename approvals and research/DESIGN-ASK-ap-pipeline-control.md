# Design Ask — AP Pipeline Control (the "Approval flow" page, reconceived)

**From:** Claude Code · **For:** Claude Design · **Status:** model locked, backend ready, needs the page design.
**Read first:** `CLAUDE.md`, `DESIGN-CONTEXT-app-shell.md` (sidebar/shell), `roles-and-functions-design.md` (roles = permission-free labels), and the current `Flow Builder.dc.html` + the shipped `FlowBuilder.tsx` (the existing canvas/cards/connectors/step-editor/test panel — reuse this visual language, don't restart it).

---

## 1. The big reframe (this is the whole point)

The page in the sidebar called **Approval flow** is being reconceived. It is **not** "build an approval flow." It is **"the owner configures how their organization controls its entire accounts-payable pipeline."** The page must *teach the pipeline* and expose the two points the owner actually controls.

The AP pipeline, end to end:

1. **A bill arrives** → its **details are filled in** (vendor, amount, line coding) on the review screen before it can enter approval. *(Explain this stage — it is NOT configurable here.)*
2. **Approval cycle** → the bill goes through the approvers the owner defined. **← EDITABLE control point #1**
3. **Sent for payment** → automatically, once approval passes. *(Explain — not configurable.)*
4. **Payment release** → the owner decides **who must sign to actually release the money.** **← EDITABLE control point #2, and it is separate from approval — "approved" is not "paid."**

So the page is a **top-to-bottom pipeline narrative** with **two editable zones** embedded in it. Teach the flow; don't hand them a template. **No presets.**

## 2. Who can touch it

This is authority-level configuration. **Owner-only editing.** Everyone else (admins, members) gets a **read-only view** — they can *see* how the pipeline is governed, but every edit control is absent/disabled for them, with a quiet "Only the owner can change this" note. (Backend already enforces this: publishing approval and release both reject non-owners.)

## 3. The locked model (design against exactly this)

- **People-first, roles optional.** A step points at **specific people** ("who approves?"). **Roles are an optional convenience** — a saved group label you *may* point a step at — never a required setup step and never a concept the user must understand to build. Most orgs will just pick people.
- **No manager hierarchy / org chart.** Flat: people + amount tiers only.
- **No one approves their own bill.** The requester is excluded from every step; if that would empty a step, it **falls to the owner as a stand-in** rather than deadlocking (the Test panel already shows "goes to Zaid (owner) because the CFO submitted it"). Only if even the owner can't cover it does it show "would get stuck."

## 4. Control point #1 — the Approval cycle (mostly exists)

This is the current flow builder, but **manual-first** (the AI assistant rail is being removed from this page; AI returns later as a global chat, not here). Reuse the shipped canvas: "A bill arrives" → step cards → "Sent to pay" terminal, with amount-split gateways.

What each **step** is: a card with a **title**, the **people who can approve**, and **how many must approve** (plain language: "any one approves" / "all must approve" / "at least N of them" — already built; hide it entirely when only one person is picked). Between cards: an always-visible **"+"** to add a step or a **"split by amount."** Click a card → inline editor (name · who approves · how many).

The guided empty state must **teach**, not point at a chat: *"Add your first step — choose who signs off on a bill."* One clear CTA.

## 5. Control point #2 — Payment release (NEW — needs design)

Simpler than approval: **a single signer set + quorum.** "Once a bill is approved and ready to pay, who must sign to release the money?" — pick one or more people + how many must sign. **No amount tiers in v1** (can come later). It sits at the bottom of the pipeline as its own editable zone, visually distinct from approval (it's the money-out gate, not the approve gate). Backend is ready: `GET /approvals/release` returns `{ approvers, quorum, configured, people }`; `POST /approvals/release/publish` (owner-only) takes `{ approvers: personId[], quorum }`.

## 6. Test / prove it

Keep the **Test panel** (amount slider + "requested by") — it resolves a sample bill through the approval flow and shows the exact chain, the owner-stand-in note, and stuck states. Ideally the Test also shows the **release** step at the end ("then Priya signs the release"), so the owner can prove the *whole* pipeline, not just approval.

## 7. Backend contract (all built, owner-gated where noted)

- Approval: `GET /approvals/flow` → `{ flow, draft, people }`; `POST /approvals/flow/publish` (owner-only); draft autosaves via `PUT /approvals/flow/draft`; `POST /approvals/flow/simulate` for the Test panel.
- Release: `GET /approvals/release`; `POST /approvals/release/publish` (owner-only).
- `people[]` carries each person's `roles: string[]` so a picker can show "Klaus · CFO".
- A flow node: `{ id, type:'step', title, approvers: personId[], quorum: 'all'|'any'|number }` or `{ id, type:'if', amountGteUsd, then:[], otherwise:[] }`.

## 8. Deliver

The full page (sidebar + shell, 1600×1000, content 1360) as a `.dc.html` design source: the pipeline narrative with the two editable zones, the owner vs read-only states, the manual-first approval builder (reusing the shipped canvas), the new release zone, and the test panel. Decimal design system + vocabulary. Say **"role"** never "seat"; never surface "quorum"/"policy"/"multisig" to the user.

## 9. Deferred (don't design)

Amount-tiered release; role hierarchies; the AI assistant on this page (returns as global chat later); per-person release limits.

# AP Workbench — Screen 1: Invoice Review (verify, code, send)

Date: 2026-07-06 · Status: design, round 1 — built to be critiqued against competitor screenshots (the loop: this doc → Fuyo's screenshot critique → revision → feasibility → build).
Depends on: extraction-contract-design.md (§1 is the field inventory, §2 confidence, §5 payment-details rule), agent-layer-design.md (§4 correction memory), protections/HANDOFF state, document storage (in flight — viewer assumes original + rendered pages server-side).
Vocabulary: SESSION-NOTES §2. Never in UI: extraction, OCR, confidence score, model. Say: "read from the document," "double-check these."

## 0. The job of this screen

**Verification, not approval.** One question: *did the machine read this document correctly?* — answered by a human, field by field where it matters, in seconds where it doesn't. "Should we pay this?" is the approver's job, later, elsewhere. The screen ends with one commit: **Confirm & send for approval** — which is the moment the bill enters routing.

Who lives here: whoever processes bills (admin/clerk persona; in a 2-person org, the founder). Home state: bills in **Needs review** (the τ_auto straight-through slice never lands here — this screen exists for the bills the router wasn't sure about, plus any bill an operator opens by choice).

## 1. Layout — document left, fields right

Split view, resizable, document-dominant by default (~55/45).

**Left — the document.** Rendered pages (storage provides), continuous scroll with page pips, zoom/fit controls, rotate for bad scans. Multi-invoice uploads: a top strip of invoice tabs ("2 invoices in this file"), each tab = its own review. The document is the ground truth and must always be fully readable — no modal viewers, no thumbnails-only.

**Right — the read panel**, in verification order:

1. **Vendor strip** (top, always): matched vendor as avatar/name pill + match state — `Matched · Acme Cloud` / `New vendor` (opens inline create; payment details still route through onboarding) / `⚠ Payee looks different` (see §5). Vendor is first because every judgment below depends on who this is from.
2. **"Double-check these"** — the amber section: every field below the confidence bar, count-chipped ("3 fields to double-check"), each rendered as an editable value with the document snippet beside it. This section is the screen's organizing principle: the operator's work is *here*, not everywhere.
3. **The rest, calm:** high-confidence header fields (invoice #, dates, terms, currency, totals) rendered as quiet confirmed values — visible, editable on click, but styled as settled. If nothing is amber: the panel collapses to a summary card + one green bar: "Everything checks out — review the lines and confirm."
4. **Lines table:** description (verbatim) · qty · unit price · amount · **category** (see §3). Row add/remove/split for machine misses.
5. **Arithmetic strip** under the table, always visible: `lines + tax = total` as a live check — green tick, or amber `Document says $4,820 · lines add to $4,280` with two explicit choices: *keep the document's total* / *use the computed total*. Never silently recompute; the choice is logged.
6. **From-the-document payment details** — the sealed card (§5).
7. **Commit bar** (§6).

## 2. The core interaction: field ↔ document linking

Click any field → the viewer scrolls/highlights **where it was read from**; click a highlighted region → focus its field. This is the trust-building interaction every serious competitor has, and it's what makes "double-check" take two seconds instead of ten (the eye doesn't hunt).

**Contract delta required (v1.1, flagged for Claude Code):** the extraction contract carries no per-field provenance. Add optional `source: { page, bbox }` per field (vision models return this; the dual text-layer channel can refine it). Graceful degradation: fields without a source simply don't highlight — the screen works day one, gets better when the delta lands.

Keyboard-first for the amber flow: **Tab** walks the double-check fields in order, **Enter** accepts, typing corrects, viewer follows focus. An experienced operator clears a 3-amber bill without touching the mouse.

## 3. Coding lives here (decision, with the reasoning)

Per-line **category** is a column in the lines table — suggested values pre-filled by the coding station, amber-styled when the suggestion is low-confidence, plain when precedent is strong ("Software — used for Acme's last 9 bills"). Rationale: coding-before-approval is adopted product-wide, and for the org sizes we serve first, a *separate* coding inbox between review and routing is pure ceremony — the same human does both jobs in one sitting. The "coding inbox" therefore becomes a **workbench filter** (bills needing categories), not a surface. Larger-org split-of-duties later = the same screen opened by a different person from that filter; nothing is foreclosed. (R2 is untouched — enterer/coder ≠ approver is already the protection that matters.)

## 4. Corrections are the product learning (invisible to the operator)

Every action emits, silently: field edited → `{field, read_value, corrected_value}`; amber accepted unchanged → confirmation signal; category changed → coding correction; total-choice → arithmetic resolution. All stamped with model id + version into the event log — this screen *is* the correction-memory faucet from agent-layer §4, and the calibration data for §2 of the contract. No UI acknowledges it; the operator just fixes fields.

## 5. Payment details: the sealed card (R7, rendered)

Extracted bank/wallet coordinates appear in a visually distinct **"From the document"** card — read-only by construction, with exactly two actions:
- **Compare:** match pill against the vendor's verified payment method. Mismatch = the screen's loudest state — red banner above everything: *"The payment details on this document don't match what's verified for Acme. This is how payment fraud usually starts."* Actions: proceed with the **verified** method (default), or open a payment-method update.
- **Start a payment-method update:** prefills the vendor_change draft → R7 routing. The operator can never edit payee details into trust from this screen; the card has no edit affordance at all.

## 6. What Confirm commits (one transaction, one event)

**Confirm & send for approval** does four things: writes the verified bill; emits the correction batch; calls the existing `submitInvoiceForApproval` hook (this screen is the call site that hook has been waiting for); logs `verified_by` + a hash of the full panel state as seen (the packet-hash idiom — "what did the verifier confirm" is provable forever).
Secondary actions: **Save for later** (partial state kept, stays in Needs review) · **This isn't a bill** (reason picker: duplicate / statement / not ours / unreadable — terminal, and each reason is a classification-eval datapoint).
Security flags (§7) present → the primary button demands the banner be resolved first.

## 7. Flags outrank ambers

Security states are banners, never amber fields — different in kind, not degree: payee mismatch (above), **duplicate suspicion** (side-by-side mini-card: "Looks like INV-1042, paid May 12 · $4,820" with open-both + *mark as duplicate* / *this is different*), text-visual divergence ("parts of this document don't match how it displays — needs a careful look"). Copy explains the *why* in one plain sentence each; judgment states get words, correction states get pills.

## 8. After confirm (read-only afterlife)

The same screen becomes the bill's document-of-record view: corrections visibly marked ("changed from 4,280"), verifier + timestamp, and the approval trail accumulating below as routing proceeds. Screen 3 (bill detail) will formalize this; the review screen degrading gracefully into it keeps one mental model: *a bill is always this screen, at different points in its life.*

## 9. For the critique round (Fuyo)

React with screenshots against these five choices specifically: (1) document-left dominance vs competitor field-first layouts; (2) the amber "double-check" section as the organizing principle vs uniform field lists; (3) coding merged into review vs a separate coding step; (4) the sealed payment-details card's severity (too alarming? not enough?); (5) the commit bar language. Screenshot the competitors' *bill entry/review* screens (Bill.com bill entry, Stampli's invoice canvas, Ramp bill pay review) — those are this screen's true rivals.

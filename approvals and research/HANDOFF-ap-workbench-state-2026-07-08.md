# AP Workbench — Build-State Handoff to Design

**From:** Claude Code (build) · **To:** Claude Design · **Date:** 2026-07-08
**Purpose:** Both screens from your 2026-07-07 handoff are SHIPPED and then iterated hard with Fuyo over two days of hands-on testing. This doc is the delta between your spec and what's actually live, so future designs start from reality, not from the old spec. Where we diverged, the change came from Fuyo's direct feedback against the running product — treat these as accepted rulings unless he reopens them.

---

## 1. Product-scope changes (affect every future screen)

- **The Payments page is deleted.** Bills IS the payments surface — one page, five lifecycle tabs. Old `/payments` links redirect to `/bills`. The payment *detail* page survives as the interim bill-detail (Screen 3 is still unbuilt and is the next design priority).
- **Collections (AR) is removed from the app entirely.** Not planned anytime soon. Sidebar Operations group is now just: Overview, Bills.
- **Review is mandatory for every uploaded bill** — known vendor or not. There is no straight-through τ_auto slice anymore. Upload → Needs review → operator confirms → approval routing. "Confirm & send for approval" is the ONLY door into the engine.
- **The review queue splits Ramp-style** (accepted from a Ramp walkthrough): every needs-review bill is either **"Ready for approval"** (green dot — amount, invoice number, due date present; nothing security-shaped open) or **"Missing information"** (amber dot — row says exactly what's missing, e.g. "Missing due date"). Security flags show separately in red ("Payment details need a look"). The Waiting-on-you tile shows the breakdown ("2 ready for approval · 1 missing info").

## 2. Live-intake UX (new since your spec)

Upload opens the review screen **immediately**. The document's rendered pages appear within ~1–2s (stored before extraction runs); the left panel shows field skeletons with "Reading the document…" and fills in when the read completes (status polling, ~1.2s). Failed reads show a plain-language error. Re-uploading an identical file dedupes to the existing bill.

## 3. Invoice Review — every delta from your spec

**Layout / order** (top to bottom): heading → flag banners → **Vendor** → **Bill details** → **Line items** → note for approvers → sticky commit bar. (Your spec had vendor strip → double-check → fields → lines → sealed payment card. Vendor now precedes Bill details.)

- **Heading replaces the vendor strip box**: h1 = invoice number (falls back to vendor name), vendor name in muted text beneath, bare amount right-aligned in mono. NO "Total due" caption, NO due date, NO new-vendor pill in the header (the info banner already says it). The heading's separator line runs full-bleed across the panel.
- **Read markers changed**: "Read by AI" is REMOVED entirely (tried it twice — green + sparkle, then gray italic — Fuyo cut it; a cleanly-read field is just filled). Markers exist only where they carry information: **amber** "needs a look · Confirm" (NOT blue — this overrides your blue=please-verify semantic; amber = unsure now) and **green check** "Confirmed by you". Empty fields carry only a "Not on document" placeholder, no tag.
- **Vendor section** (renamed from "Remit-to address"): vendor name + email (both **editable** — they're document reads; edits correct this bill's record, never the address book) + street/city/state/ZIP. Caption carries new-vendor status.
- **Line items** (renamed from "Lines"): columns Description · Qty · Unit · Category · Amount. **No delete button** (removed entirely — was hover-X, then confirm-dialog, then cut). Money renders as one unit ("$2,650.00") in Unit/Amount/Tax, formatted on blur. **Totals live in the table footer directly under the Amount column** (Line items / editable Tax / bold Total), with the arithmetic check ("Adds up to the document's total") sitting to their LEFT in the footer band — not on its own row.
- **Category = the org's full numbered QuickBooks chart**, via a custom **AccountPicker** (the Ramp pattern): select-look trigger → fixed popover with search box → scrollable list grouped by account type, each row = account name with its number in small mono beneath ("Accounting" / "6000"). Search matches name or number. Native `<select>` is banned for long lists. Suggestions come from the GL matcher against the live chart (re-run when stale); with no QBO connected, a builtin standard chart fills the picker.
- **The sealed payment card is DELETED.** No payment section on the review screen at all. Ruling: where the vendor gets paid is a vendor-record fact (portal-invite trust model — vendor self-entry via emailed link > operator entry with second-person consent > invoice-read details as pending-only). That's the D1/D2 design work, deliberately deferred. The payee-mismatch red banner remains the screen's fraud surface.
- **Document pane**: rendered page **images** (never a PDF viewer). **Field ↔ document highlighting is live and exact** — focusing any field or line item scrolls the page and draws an accent box over the exact words, powered by the PDF text layer (pdftotext -bbox), not model guesses. Works for vendor name/email, address parts, every header field, line rows (full-row band), and the totals block.
- **Document pane header** (matches your original mock, adopted verbatim at Fuyo's request): a bar across the top of the pane — doc icon + filename in small mono + a "1 page" chip on the left; **− · 100% · + · ⤢** on the right. Zoom is relative to the pane: **100% = page fits the pane width**, steps are **±10 points** per click (50–300%), every step visibly resizes, and ⤢ (fit-to-view) returns to 100% and scrolls to the top. Documents open at 100%. There is NO floating bottom-left tool cluster.
- **Split default is 62% details / 38% document** (details get the room; the divider is still user-draggable).
- **Topbar is minimal**: just "← Bills" (14px). No breadcrumb trail, no ⌘↵ hint, no "2 of 7", no prev/next arrows. (⌘↵ still works, silently.)
- **No vendor avatars anywhere** — initials circles are for PEOPLE (members, approvers) only. Vendors are plain names. Bills table has a dedicated mono Invoice column instead.

## 4. Bills workbench — deltas

- Columns: Vendor · Invoice · Description · Amount · Due · **Status** — **no Age column** (age still feeds the urgency sort silently). Due is single-line: "31 May 2026 · 37 days overdue" in red, or the amber discount chip inline.
- Row status = **colored dot + text** (dot-status), pills only for loud states. Person-blocked rows show a small initials avatar ("Waiting on Priya").
- Page is full-width (`page-wide`); the PageHead separator runs edge to edge (sidebar to screen edge) — this is now global to all pages.
- Metric tiles: Waiting on you (accent, clickable, shows ready/missing breakdown) · In approval · To pay · Needs attention.

## 5. New design-system vocabulary since your last sync

`picker-trigger/picker-pop/picker-search/picker-list/picker-group/picker-item` (the combobox) · `dot-status` (+tones, `ds-avatar`) · `due-chip`/`due-overdue` · `rev-shell/rev-split/rev-panel/rev-divider/rev-doc-wrap/rev-doc/rev-head/rev-grid/rev-field` · `ftag` (is-look amber / is-confirmed green) · `doc-page`/`doc-hl` (highlight box) · `doc-head` (`dh-file`/`dh-name`/`dh-zoom`/`dh-pct` — the pane header) · `commit-bar` · table-footer totals (`lt-label`, `arith-note`, `arith-cell`) · `tbl-input`/`select-cell` · `callout-warning`/`callout-info` · full-bleed `pagehead`. Icons added: `minus`, `expand` (maximize-2), `reset` (rotate-cw), `zoomIn`/`zoomOut` (magnifiers, currently unused), `circle`. The repo remains source of truth; the Decimal Design System package will be re-synced so these land in your sandbox.

## 6. What's next (design queue, updated)

1. **Bill detail (Screen 3)** — now more urgent: workbench rows for in-approval/paid bills currently open the legacy payment detail page. The review screen already degrades into a read-only record post-confirm; Screen 3 formalizes it (trail, release story, receipt).
2. **Approvals inbox (Screen 4 / B1)** — unchanged.
3. **Release ceremony (B3)** — unchanged.
4. **NEW: Vendor payment-method flow (D1/D2)** — the portal-invite model above needs a proper design round: invite email, vendor-facing entry page (bank details + W-9/W-8), method lifecycle (pending → verified → active), and how a bank account becomes a Bridge liquidation address without the vendor ever touching crypto.
5. **Deferred, do not design**: Documents tab on the review screen (waits for email intake — today a bill has exactly one file), payment scheduling (waits for the timing engine), bulk actions.

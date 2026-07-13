# AP Platform — Developer Handoff (Screens 1 & 2)

**For:** Claude Code · **From:** design · **Date:** 2026-07-07
**Deliverables:** `Invoice Review.dc.html`, `Bills Workbench.dc.html` (in project root)
**Specs:** `uploads/ap-workbench-screen1-invoice-review.md`, `uploads/ap-workbench-screen2-bills-workbench.md`

---

## 0. Read this first — how to use the prototypes

The two `.dc.html` files are the **visual + interaction spec**, not code to port. They were built against a *stripped copy* of our real `decimal-frontend` design system (its compiled bundle + tokens live under `_ds/decimal-design-system-.../`).

**Your job:** rebuild these screens in the real React app using the **actual `decimal-frontend` components and CSS tokens** — do not copy the prototype's inline styles. Every inline-styled block in the prototype maps to a real DS class or component; use the mapping table below. Match layout, states, spacing intent, and copy exactly.

**Ground rules the design follows (keep them):**
- Colors/type come only from tokens: `--accent` (pink), `--info` (blue), `--warning` (amber), `--danger` (red), `--success` (green), `--text-primary/muted/faint`, `--font-display` (Bricolage), `--font-mono`. No new hex.
- **Voice:** plain finance language. Never say "extraction / OCR / confidence score / model" in UI — say "read from the document," "needs a look." Never crypto terms (wallet, multisig, on-chain, USDC) on any operator surface. Amounts are always base currency (`$4,820.00`), never a stablecoin figure.
- Semantic color system: **blue = please-verify / low-confidence**, **amber = genuine anomaly** (arithmetic mismatch, possible duplicate), **red = blocking** (payee mismatch, wrong recipient, returned payment), **green = confirmed/matched**.

---

## 1. Component & token mapping (prototype → real DS)

| In the prototype | Use in code |
|---|---|
| Sidebar (`.sidebar`, `.sb-item`, `.sb-badge`, `.sb-org`, `.sb-user`) | The real app-shell sidebar component |
| Header block | `PageHead` (`eyebrow`/`title`/`desc`/`actions`) |
| 4 stat tiles (`.metrics` > `.metric` > `.m-label`/`.m-value`/`.m-sub`) | `metric` tiles; the accent CTA tile is a clickable variant |
| State tabs (`.tabs` > `.tab` + `.tab-count`) | `tabs`/`tab` |
| Toolbar (`.filterbar`, `.input-search`, filter chips) | `filterbar` + search input + your filter/sort menus |
| Tables (`.tbl-card` > `table.tbl`, `.td-num`, `.cell-vendor`) | `tbl` table chrome |
| Status pills / dot-status | `Pill` component for loud states; dot+text for quiet row status |
| Icons | `Ico.*` set (`check`, `doc`, `inbox`, `shield`, `search`, `plus`, …) |
| Dropzone (first-run) | `dropzone` |
| Dialog ("This isn't a bill") | `overlay` > `dialog` > `dialog-head/body/foot` |
| Callouts / banners | `callout callout-danger` etc. |

The prototypes hand-rolled a few things the DS doesn't ship (the resizable split divider, the document-hotspot highlighting, the editable line table, the colored-dot row status). Those are noted per-screen below as **build-new**.

---

## 2. Screen — Bills Workbench (`Bills Workbench.dc.html`)

The operator's home. A **triage surface**: "what needs me, and where is everything else?" Full rationale in `ap-workbench-screen2-bills-workbench.md`.

### Layout
App shell (sidebar + main). Main = header → 4 metric tiles → **one toolbar row** (5 state tabs on the left; search + sort dropdown + Filter button on the right) → bills table. Give the page a desktop min-width so the toolbar stays one row.

### State tabs (the spine)
Five lifecycle buckets, each a filter over the same bills query. Counts are live. `Needs review` is default (accent dot); `Needs attention` is the only warning-colored tab. A zero-count tab stays visible (quiet), not hidden.

| Tab | Engine states behind it |
|---|---|
| Needs review | captured, needs_verification |
| In approval | pending_approval, returned_for_info, on_hold |
| To pay | approved/awaiting_release, scheduled |
| Done | paid, reconciled |
| Needs attention | held_duplicate, match_exception, returned_payout, rejected |

### Row = one bill
Columns: **Vendor** (avatar + name) · **Description** (top line item) · **Amount** (right-aligned base currency; foreign shows original beneath, e.g. `$18,400.00` / `€17,000.00`) · **Due date** (with an amber "2% off — 4 days left" chip when a discount is expiring; overdue date in red + "5 days overdue") · **Status** (colored-dot + text; **build-new** — not a pill; a person-blocker shows a small avatar + "Waiting on Priya") · **Age** (quiet mono; turns amber past a staleness threshold).

Row click routes by state: **Needs-review → the review screen (Screen 1) at that bill**; every other state → read-only bill detail (Screen 3, not yet built). The workbench never opens an editor for a bill that has left verification.

### Behavior
- **Default sort = computed urgency** (expiring-discount + overdue climb, then due date, then age). Surfaced honestly as a "Most urgent" sort control the operator can override.
- **Filter** button opens vendor / amount / date / "discount expiring" filters. Search matches vendor name + invoice #.
- **Bulk actions (later):** assign, label, export, "mark not a bill" only. **No bulk approve, no bulk pay** — those are single-item authority acts.
- **First-run / empty org** = the intake view (in the prototype behind the `firstRun` prop): dropzone + "forward bills to ap@yourco" with copy. The workbench and intake onboarding are the same screen when empty.
- The accent **"Waiting on you"** metric tile is clickable — it's the entry point into the review queue.

### Data contract (per bill)
```
{
  id, vendorName, vendorInitials, vendorColor,
  description,
  amountBase: "$4,820.00", amountOriginal?: "€17,000.00",
  dueDate, isOverdue, overdueLabel?,
  discount?: { label: "2% off — 4 days left" },
  lifecycleState,                 // → which tab
  subStatus: { kind: 'plain'|'person'|'loud', text, tone, blockedBy?: {name, avatar} },
  ageLabel, ageUrgent
}
```
The `scenario`/`firstRun`/`darkMode` props in the prototype are demo toggles — in production, tab + data drive everything; `firstRun` becomes "org has zero bills."

---

## 3. Screen — Invoice Review (`Invoice Review.dc.html`)

Single-bill verify screen. The operator confirms what was read from the document, then sends it for approval. Full rationale in `ap-workbench-screen1-invoice-review.md`.

### Layout
Topbar (breadcrumb + prev/next) → **user-resizable split**: document image on one side, read panel on the other (**build-new**: a drag divider — never fixed percentages) → sticky **commit bar**.

### Document pane
Renders the bill's page image with **clickable hotspots** (**build-new**): clicking a field in the panel highlights its region on the document and vice-versa; zoom controls.

### Read panel — one flat field list (no sections-by-confidence)
Every required field appears in **one list**, each carrying its own state marker:
- **"Read by AI"** — quiet blue tag (value read cleanly).
- **"Needs a look"** — blue field treatment + a reason + inline **Confirm** button; becomes **"Confirmed by you"** (green) when accepted.
- **"Not on document"** — for empty fields (e.g. PO, discount on a bill that has none).

Required fields: vendor, invoice number, invoice date, due date, terms, **discount** (blank when absent), PO, currency, total, and **remit-to address as its own section with real sub-fields** (street, city, state, ZIP). Then an **editable line-items table** (**build-new**): columns Description · Qty · Unit · Category · Amount, with the **totals (Line items / Tax / Total) stacked under the Amount column**, an **editable Tax** field, and a **live arithmetic check** that flips to an amber warning when lines + tax ≠ document total. A low-confidence category shows a blue chip + a confirm row beneath the line. Finally a **read-only, sealed payment block** ("from the document" — never editable from this screen).

### Scenarios (all real states — the prototype's `scenario` prop)
1. **Default** — some fields need confirmation.
2. **Everything checks out** — all clean.
3. **Payee/bank mismatch** — red banner, **blocks send** until resolved (pay verified method / start method update).
4. **Duplicate suspicion** — amber banner with the matching prior bill; mark duplicate / this-is-different.
5. **New vendor** — info banner; payment details still go through verification.
6. **Addressed to someone else** — red banner (bill-to ≠ your org), **blocks send**; remove / override.

### Commit bar
"This isn't a bill" (reason dialog) · "Save for later" · **"Confirm & send for approval"** (⌘↵). Confirm is **disabled while any blocking flag is unresolved**. On confirm → "Sent for approval" state routing to the first approver, recorded exactly as shown. An optional one-line **"Note for approvers"** rides along.

### Design rulings to preserve (do not "improve" away)
- No boxed two-column "value | from the document" field cards — one clean field list.
- No confident-vs-unconfident section split — confidence is a **per-field marker**.
- Split view is **user-resizable**, never fixed %.
- Payment/remit details are **read-only** from this screen.

---

## 4. Confirm before building (2 product decisions, not blockers)

1. **Payments/Treasury page in v1?** Design's lean: **no** — operators live in Bills; money-out is the workbench's *To pay*/*Done* tabs, and raw payment/rail detail belongs inside bill detail (Screen 3). Add a treasury/reconciliation page later. Build a standalone Payments page only if you're demoing on-chain settlement to external parties.
2. **Final wording for the "read by AI" marker.** Prototypes use **"Read by AI"** and **"Reading the document…"**. Confirm the exact phrasing so both screens match — then it's a one-string constant.

Neither blocks starting; they only prevent renaming/rework later.

---

## 5. Not in scope yet (deferred, don't build)
Cash/timing view, saved views, cross-entity switching, bill detail (Screen 3), approvals inbox (Screen 4), the release ceremony. The workbench row already links to Screen 3 — stub that route.

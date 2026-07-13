# Page Playbook — read BEFORE creating or editing any page

The recurring failure this doc kills: a new page written from memory, with invented
class names and inline spacing, that looks nothing like the rest of the app. The fix
is a process, not taste:

1. **Read this file.**
2. **Open `Members.tsx`** — the canonical page — and copy its skeleton.
3. **Use only classes that exist** in `styles/decimal/{components,pages,tokens}.css`.
   If you're about to type a class name you haven't seen in those files, stop and grep.
4. Inline `style={{}}` is allowed ONLY for one-offs the system can't express:
   grid column counts (`gridTemplateColumns`), fixed column widths (`style={{ width: 160 }}`),
   skeleton heights. Never for colors, fonts, spacing rhythm, or alignment that a class covers.

## Page skeleton (copy this shape)

```tsx
<div className="page">                        {/* 28px 32px 40px padding, max-width 1180 centered */}
  <div className="stack stack-24">            {/* vertical rhythm between page sections — 24px */}
    <PageHead title="…" desc="…" actions={<button className="btn btn-primary">…</button>} />

    <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div className="metric">
        <div className="m-label">LABEL</div>       {/* uppercase 11px handled by class */}
        <div className="m-value">7</div>            {/* mono 26px */}
        <div className="m-sub">context line</div>
      </div>
    </div>

    <section>
      <div className="sec-head">
        <div className="sh-titles">
          <h2>Section title</h2>
          <p className="sh-desc">One-line description.</p>
        </div>
        {/* optional right-side actions */}
      </div>
      <div className="tbl-card">
        <table className="tbl"> … </table>
      </div>
    </section>
  </div>
</div>
```

## Class vocabulary (the whole approved set for pages)

| Need | Classes |
|---|---|
| Page shell | `page`, `page-wide`, `stack stack-16/20/24/32` |
| Page header | `<PageHead>` from `dec/primitives` (props: `eyebrow, title, desc, actions, greet`) — NOT `subtitle` |
| Section header | `sec-head` > `sh-titles` > `h2` + `p.sh-desc` |
| Metric tiles | `metrics` > `metric` > `m-label` / `m-value` / `m-sub`; alert variant `metric is-alert` |
| Card around a table | `tbl-card` (border+radius, no padding); footer `tbl-foot` > `tf-count` + `pager` |
| Table | `tbl`; right-aligned header `th.num`; mono numeric cell `td.td-num`; slim rows `tbl-slim` |
| Table cells | `cell-vendor` (`v-name`/`v-sub`), `cell-mono`, `cell-source`, `status-cell`, hover arrow `row-arrow` |
| Buttons | `btn` + one of `btn-primary / btn-secondary / btn-ghost / btn-danger / btn-danger-ghost / btn-dark / btn-icon`; size `btn-sm`. Pill-shaped by default — never restyle |
| Status pills | `pill` + `pill-success / pill-warning / pill-danger / pill-info / pill-neutral`; minimal variant add `pill-min` (+ auto dot) or `<Pill>` primitive |
| Forms | `field` > `field-label` + `input`; helpers `input-help` / `input-error`; `select` wrapper; search `input-search` |
| Empty state | `empty` > `empty-icon` (svg 22px) + `h4` + `p` — never a bare "no data" div |
| Loading | `skeleton` divs (inline height ok), one per expected row |
| Filters/tabs | `filterbar`, `tabs` > `tab` (+`on`), `filter-right` |
| Detail pages | `detail-layout` (main + 320px rail), `surface` for generic bordered boxes |

## Rules that keep pages consistent

- **Spacing rhythm comes from `stack stack-24` + `sec-head`'s built-in margin.** Never add
  `marginTop` to space sections; wrap the page body in one stack.
- **Colors/fonts only via tokens** (`var(--text-muted)`, `var(--font-mono)`, …). Zero hex codes
  in pages — dark mode depends on it.
- **Amounts** render in `td-num` (mono, tabular, right-aligned). Dates/muted metadata in
  `cell-mono` or `var(--text-muted)`.
- **Icons** from `dec/icons` (`<Ico.name w={16} />`) — never emoji, never new svg inline.
- **Copy voice**: plain human sentences (SESSION-NOTES §2 / plain-voice memory). No jargon:
  "approval", "signing key", "payment method" — never policy/quorum/multisig.
- **Full-width**: never cap text content with your own max-width — `page` handles width.
- Rows that navigate get the `row-arrow` affordance; rows that don't shouldn't have hover-pointer
  (override `cursor` only via existing patterns).
- Data fetching: `useQuery` from @tanstack/react-query keyed `[thing, organizationId]`;
  mutations invalidate their query keys; toasts via `useToast()` (`success` / `error`).

When a page needs something this vocabulary can't express, extend
`styles/decimal/components.css` with a properly-tokened class — do not inline it.

## Additions from the multi-page survey (2026-07-06 — Accounting, CodingInbox, Collections, Members, Sidebar)

- **Every page carries its subsystem as the PageHead `eyebrow`** — the same group label the
  sidebar shows: `Operations` (Overview, Payments…), `Registry` (Treasury accounts, Members,
  Address book), `Governance` (Approvals, Proposals, Auto-pay), `Accounting`, `Integrations`.
  A page without an eyebrow reads as unanchored — check `Sidebar.tsx`'s `sb-group-label`s for
  the current list before choosing.
- **People are shown as avatars, not names-in-prose.** Pattern from Members.tsx: `member-cell`
  > `m-avatar` (30px circle; img with `onError` fallback to initials; `referrerPolicy="no-referrer"`)
  + `col` > `m-name` / `m-sub`. Overlap avatar stacks with `marginLeft: -8` on subsequent items.
  Placeholder/unknown person: `m-avatar invited` (dashed) with an icon.
- **Detail pages** reuse `eyebrow` for state labels (CollectionDetail: "Awaiting payment", …) and
  `detail-layout` for main+rail.
- **Show, don't write:** if a section is a wall of sentences, re-express it as pills, avatars,
  metric tiles, or step rows — text stays as the caption/help line (`input-help`, `m-sub`),
  never the primary rendering.
- **Playbook maintenance rule:** this doc was first written from ONE page and it showed. When
  adding a new pattern, survey at least three existing pages first; when a page needs something
  unlisted, add the pattern here in the same commit.

## Additions 2026-07-06 (second recurrence — patterns that already existed and were missed)

- **Toggle switch**: `.switch` (+`.on`) > `.knob` — pages.css:338. Locked variant `.switch.is-locked`.
  Use for any on/off setting. Never a text button for a binary state.
- **Confirm modal**: `.overlay` (add `style={{position:'fixed',inset:0,zIndex:60}}`, click-outside closes)
  > `.dialog` > `.dialog-head` (h2+p) / `.dialog-body` / `.dialog-foot`. Used by Members/Payments/
  Counterparties/CodingInbox. Confirmation NEVER reflows the page — it overlays it.
- **Settings surface**: `.setting-row` > `.sr-text` (`.sr-name`/`.sr-desc`) + `.sr-controls` — for
  rows of switches/preferences (added for Protections; reuse, don't reinvent).
- **Lesson, again**: grep components.css AND pages.css for the interaction pattern (switch, dialog,
  drawer, tabs) before concluding it doesn't exist. Both misses so far were patterns already shipped.

## 2026-07-06, third collision — the rule is now absolute

`.check-list` already existed (pages.css:361: bordered person-picker with `.check-item` [+`.on`],
`.check-box`, `.ci-av` avatar, `.ci-name`/`.ci-sub`) and a duplicate class was appended blind,
causing a cascade fight. ALSO: `--danger` in dark mode was terracotta (#D9785F) and `.btn-danger`
used `--solid` (white in dark) — both now fixed (danger = true red #E5484D everywhere; btn-danger
uses --danger). Additions this round: `.tick-list`/`.tick-item` (borderless green-check bullet list).

**Absolute pre-flight, no exceptions: before writing ANY class name, run
`grep -rn "classname" src/styles/` — and before building any dialog, open the closest real one
(Payments.tsx New-payment dialog is canonical: dialog-head h2+p+drawer-x, dialog-body of .field
blocks, dialog-foot) and copy its skeleton line by line.**

## Additions 2026-07-07 (AP workbench redesign — Bills.tsx, InvoiceReview.tsx)

- **Quiet row status**: `.dot-status` (+`tone-info/success/warning/danger`) > `.ds-dot` [+optional
  `.ds-avatar` initials for "Waiting on Priya"]. For table-row lifecycle status. Pills stay for
  LOUD states only; dot+text is the default row status treatment.
- **Amber deadline chip**: `.due-chip` ("2% off — 4 days left"); overdue text uses `.due-overdue`.
- **Full-height split screens** (review): `.rev-shell` > `.topbar` + `.rev-split` (`.rev-panel` |
  `.rev-divider` drag handle | `.rev-doc`) + `.commit-bar` (sticky footer with primary action).
  Split is user-resizable via mouse events on `.rev-divider` — never fixed %.
- **Flat field list with read markers**: `.rev-grid` > `.rev-field` (`.field-label` + `.input`
  [+`.is-look` for double-check styling] + `.ftag` marker: `is-read` "Read by AI" / `is-confirmed`
  green / `is-look` blue with inline `.ftag-btn` Confirm / bare = "Not on document").
- **Editable table cells**: `.tbl-input` (bare input inside `.tbl` td; `.td-num` variant for
  amounts); totals stack under the amount column via `.line-totals` > `.line-total-row` (+`.grand`);
  live arithmetic check line: `.arith-note` (+`.bad`).
- **Sealed read-only block**: `.seal-card` (payment details "from the document" — no edit affordance).
- **Callout variants**: `.callout-warning`, `.callout-info` now exist alongside `.callout-danger`.
- **Voice rulings from the design handoff**: never "extraction/OCR/confidence/model" in UI — say
  "Read by AI", "needs a look", "read from the document". Amounts always base currency ($4,820.00).

## Additions 2026-07-07, round 2 (user feedback pass)

- **`.pagehead` separator is full-bleed**: it carries `margin: 0 -32px` to escape the page's
  horizontal padding — the line meets the sidebar and the screen edge. Don't wrap PageHead in
  anything with its own horizontal padding.
- **Field marker semantics (updated)**: `is-read` = GREEN + `Ico.sparkle` "Read by AI" (we flex the
  AI's work); `is-look` = AMBER (not blue) with inline Confirm; `is-confirmed` = green check. Empty
  fields carry only the "Not on document" placeholder, no tag.
- **No vendor avatars**: vendors are plain names (`.v-name`), never initial circles — those are for
  PEOPLE (members/approvers) only. Bills table carries a dedicated mono `Invoice` column.
- **Destructive row edits confirm first**: removing a line item (or anything not re-creatable)
  goes through the standard `.overlay > .dialog` confirm with `.btn-danger`.
- **Document provenance**: `.doc-page` (relative wrapper per page image) + `.doc-hl` (accent
  highlight box, % positioned from a normalized `{page, box:[x,y,w,h]}` source). Focusing a field
  scrolls to and highlights where it was read.
- **Long-list dropdowns use the design-system picker, never a native `<select>`**:
  `.picker-trigger` (select-look button) opening a fixed-positioned `.picker-pop` with
  `.picker-search` + scrollable `.picker-list` of `.picker-group` headers and `.picker-item`
  rows (`.pi-name` + small mono `.pi-num` beneath — the Ramp account-picker pattern).
  Canonical implementation: AccountPicker in InvoiceReview.tsx. Native `<select>` stays fine
  for short static lists (sort orders, roles).

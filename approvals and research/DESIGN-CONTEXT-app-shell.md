# App Shell — Standing Design Context (the sidebar is always there)

**From:** Claude Code (build) · **To:** Claude Design · **Date:** 2026-07-08 · **Status:** standing reference — applies to EVERY operator-facing screen, current and future.

## The rule

**Every screen you design lives inside the app shell: a fixed 240px sidebar on the left, content to its right.** Recent mocks have been composed as if the content owns the full viewport — they don't survive contact with the real app, because ~240px vanishes and every proportion shifts. From now on:

1. **Include the sidebar in every full-page mock.** Not a suggestion of it — the actual sidebar (spec below), so spacing, table widths, and split proportions are judged against the space that really exists.
2. **Design content for `viewport − 240px`.** At the reference frame of 1600px wide, the content area is **1360px**. At a 13" laptop (1440px), it's **1200px**. If a layout only works at 1600px of *content*, it's too wide.
3. The sidebar is **not collapsible** — a deliberate v1 ruling (space pressure is handled per-screen, e.g. the review screen's draggable split; collapse-to-icon-rail is a possible later addition, do not design collapsed states now).

## Sidebar spec (as built — mirror this exactly)

- **Width 240px, full height, fixed.** `background: var(--bg-surface)`, 1px `var(--border)` right edge. The content pane scrolls; the sidebar does not scroll with it.
- **Top → bottom structure:**
  1. **Wordmark** — pink "D" glyph tile + "Decimal".
  2. **Org switcher chip** — org initials tile + org name + chevron; opens a menu (org list + "create organization").
  3. **Nav groups**, each with a small uppercase group label (`sb-group-label`) and items (`sb-item`: 16px icon + label, active state = accent left bar + tinted background; optional count badge `sb-badge`):
     - **OPERATIONS** — Overview, Bills *(badge: incomplete bills)*
     - **REGISTRY** — Treasury accounts, Members, Address book *(badge: unreviewed wallets)*
     - **GOVERNANCE** — Approvals, Protections, Auto-pay
     - **INTEGRATIONS** — Accounting, Coding inbox *(badge: uncoded payments)*
  4. **Footer** — Light/Dark theme segment, then the user chip (avatar/initials + name + email + chevron menu).
- **The group labels are canon**: a page's PageHead `eyebrow` must equal its sidebar group (a page in Operations says "Operations"). If you design a new page, say which group it belongs to.
- Note the CURRENT nav: Payments and Collections are gone (see the 2026-07-08 build-state handoff). Don't resurrect them in mocks.

## Layout consequences to respect

- Pages are **full-width** (`page-wide`) with 32px horizontal padding inside the content area; the PageHead separator runs edge to edge — from the sidebar's border to the right edge of the screen.
- The review screen's split (62% fields / 38% document by default) is a split of the **content area**, not the viewport.
- Dialogs/popovers center over the content area, overlays dim the whole viewport including the sidebar.
- Dark theme applies to the sidebar too (`[data-theme="dark"]`) — when you design dark variants, the shell is part of them.

## Practical instruction for your mockups

Compose at **1600×1000 with the sidebar occupying x = 0–240** (or reuse the sidebar component from the synced Decimal Design System package). If a mock is deliberately a component close-up rather than a full page, say so explicitly — otherwise full page = shell included.

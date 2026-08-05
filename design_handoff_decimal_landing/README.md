# Handoff: Decimal Landing Page

## Overview
Marketing landing page for **Decimal** — AI-powered, self-custodial accounts payable ("Self-driving Accounts Payable"). Decimal reads vendor bills, codes them to the books, routes them through configurable approval flows, and pays vendors domestically and cross-border. The page sells that story with live, looping product-UI animations rather than static screenshots.

## About the Design Files
The files in this bundle are **design references created in HTML** — a working prototype showing intended look and behavior, not production code to copy directly. Your task is to **recreate this design in the target codebase's environment** (Next.js/React or whatever the team uses) with its established patterns. If no frontend exists yet, pick an appropriate modern framework and implement there.

The main reference is `Decimal Landing Options.dc.html`. Open it in a browser (all files in this folder must stay siblings — it loads `support.js`, `pay-globe.js`, `_ds/…/_ds_bundle.css`, `assets/`, `uploads/`). It renders as a design **canvas of numbered artboards**, top to bottom:

- **20b — Hero** (1440px artboard) ← the hero to implement
- **19a — Final CTA** ("inked" band)
- **18b — FAQ** (two-column dossier)
- **16a — Features** ("More than payments", 3 cards)
- **6a — Anatomy of a bill** (section header + Plate 01 AI extraction, Plate 02 approvals, Plate 03 cross-border)

**Intended page order for the real site:**
1. Hero (20b)
2. Anatomy of a bill (6a) — the "how it works" spine
3. Features (16a)
4. FAQ (18b)
5. Final CTA (19a)
6. Footer — **not designed yet**; keep minimal (logo, the three nav links, waitlist CTA, legal line)

## Fidelity
**High-fidelity.** Colors, type, spacing, copy, and animation choreography are final. Recreate pixel-perfectly. All measurements below are at the 1440px design width.

## Design Tokens
Token CSS lives in `_ds/decimal-design-system-175be9bd-80a0-4e4a-986e-851d3556e8b3/_ds_bundle.css` (the `.dec` scope). The prototype overrides some per-artboard via CSS vars. Effective values:

- `--ink`: `#0A0A0A` — primary ink (headlines, dark UI chrome, filled icons)
- `--accent`: `#E6005C` — Decimal pink (logo period, accent UI, APP badge)
- Highlight marker fill: `#F9C6D0` (light pink; hero headline marker + PDF extraction highlights)
- `--band`: warm sand band/panel background (see bundle; used behind product screens and plate visuals)
- Page canvas: `#EDEBE7`; surfaces: `var(--bg-surface)` white
- Text: `--text-primary`, `--text-muted`, `--text-faint`; borders: `--border`, `--border-strong`
- Fonts (Google Fonts): **Bricolage Grotesque** (`--font-display`, headings, weight 600), **Geist** (body/UI), **Geist Mono** (amounts, invoice numbers, kickers — ALL monetary values render in mono)
- Radius: **0** almost everywhere — square corners are a deliberate brand trait (buttons are the DS pill exception; avatars/dots round)
- Buttons: DS classes `btn btn-primary` — ink pill, uppercase label, Geist

## Screens / Sections

### 1. Hero (artboard 20b)
- **Nav**: logo "Decimal." (Bricolage 22px/600, pink square period) shifted 12px right of the 36px content edge; links "How it works · Features · FAQ" (14px, muted, right-aligned before CTA); "JOIN THE WAITLIST" `btn btn-primary` uppercase.
- **Grid**: `35fr / 65fr`, 44px gap, left padding 36px, top padding 64px. The whole left column is translated 12px right (`heroLeftShift` tweak, baked default 12).
- **Left column**: H1 60px/1.05 Bricolage 600, "Self-driving" wrapped in a pink marker-highlight SVG (`mark` + rough-marker path, fill `#F9C6D0`), then "Accounts Payable." Sub (15.5px/1.55, muted, max 400px): "Decimal reads, codes, and pays every vendor bill, at home or overseas. You just approve" (user-edited copy — keep verbatim). CTA button. Below, two side-by-side boxes (18px gap): **payments bar chart** card (Cross-border $961,000 +17% / Domestic $1,355,000 legend card floating top-left) and **Slack chat card** (Lena asks what's open → Decimal APP reply → 4 vendor bills in a bordered list with amounts/summaries → full-width "APPROVE ALL · $59,460" ink button). Entrance: `fadeUp` staggers .0/.15/.3/.4s.
- **Right visual**: product screen in a browser-less frame with an ink art-mask backdrop (`assets/art2-hatch.png` default; tweak offers ascii/brush/dots/plus variants). 50px icon sidebar (solid silhouette icons grouped: D · dashboard,bills · bank,card,members · approvals,transfers,shield · ledger,settings · avatar photo at bottom).
- **The 18.5s product-screen loop** (all timings are % of 18.5s; full choreography is documented in a comment block in the file's `<style>`):
  - 0–45.4%: **Bills list** overlay — header "Bills", stat tiles (Waiting on you 3 / In approval 5 / To pay 2), table of bills; cursor moves down rows (rows highlight), clicks INV-2481.
  - 45.4%: overlay lifts → **Review screen** (breadcrumb Bills / Review / INV-2481). Left 56%: Vendor / Bill details / Line items forms — **all fields empty**. Right: the vendor's invoice PDF (Anvil-Works_INV-2481.pdf, rendered as a white A4 page).
  - 48.3–55%: **AI extraction beat** (~0.3s after open): every field simultaneously gets a shimmer sweep + ink glow pulse (`heroShimmer`, `heroFieldPulse`) while values fade in (`heroFieldVal`), and the matching text in the PDF flashes pink `#F9C6D0` (`heroPdfFlash`). Then "✓ Adds up to the document's total" + totals row appear (`heroCheckIn`).
  - 60.5–70%: cursor checks **Email** — field border turns accent + PDF email flashes pink (`heroEmailPulse/Flash`).
  - 78–88%: same for **Vendor name** (`heroVendorPulse/Flash`).
  - 95.5%+: breadcrumb "Bills" flashes accent; loop restarts. "CONFIRM & SEND FOR APPROVAL" button pulses continuously.

### 2. Anatomy of a bill (artboard 6a)
- **Bridge header**: H2 40px "**Anatomy** of a bill." (marker highlight on "Anatomy") + intro paragraph; right side is an ink skull mask graphic (`assets/skull-mask.png`) — decorative.
- Three **plates** follow, each `30fr/70fr` (Plate 01: `30/70`, Plate 02 check in file) with copy left / visual right on `--band`. Copy anatomy per plate: **plate title** (30px Bricolage 600) top; highlight blocks bottom-anchored — **highlight** (19–21px, marker-highlighted 2–3 word claim) + description (12px/1.6 muted).
  - **Plate 01 — "AI extraction and coding" / "Zero manual entry"**: 12s loop visual — invoice PDF dragged into a dashed drop zone → processing bar → "Review bill" → review form where all fields shimmer+fill at once (identical mechanics to the hero beat; keyframes `loopPulse`, `loopShimmer`, `fVal1`, `reviewIn`).
  - **Plate 02 — "Approval workflows, built and enforced" / "Any complexity" + "Routed and recorded"**: two bottom-anchored highlight blocks. Visual alternates **flow builder** (10s: typed plain-English prompt → node graph draws itself: amount/vendor branches, 2-of-3 signatures, checks) and **approval trail timeline** (12s: reviewed → comments/questions → approved entries appearing in order). Cut is instant, no blank gap (React state swap, `flow`→`timeline` loop).
  - **Plate 03 — "Cross-border payments" / "In their currency"**: left "Payment run" panel (ink header + white "RELEASE PAYMENTS" button that clicks → "Releasing…" spinner → "Released ✓", all states white bg) over 7 vendor rows (US/UK/BR/MX/CA/IS flags, local-currency amounts in mono) each getting a green check; right: d3 orthographic **globe** (`pay-globe.js`) with geodesic arcs firing from NYC to each vendor country, flag+amount chips appearing at destinations. Both sides run a **16s loop phase-locked to the document timeline** (`animation-delay: -(now % 16000)ms` on both the globe internals and the panel via `--gbd`) — replicate this sync mechanism or drive both from one JS clock. Footer swaps "Pay 7 bills across 6 countries in one batch" → "Cleared in one batch payment · $110,405".
- Needs d3@7 + topojson-client + world-atlas countries-110m.json (see `pay-globe.js` header for CDN pins).

### 3. Features (artboard 16a)
- H2 40px: "More than **payments.**" (marker highlight on "payments.", which carries the period).
- 3 cards (grid, 25px gap, max-width 1040px, 1px `#0A0A0A` borders, square): photo header (405px, image with an inset white mini-UI card) + text block below (title 25px, body 14px/1.6 muted).
  - **Self-custodial funds** — photo `uploads/purplecheck.jpg`; mini-card: operating account $482,190.34, "Money moves only when 2 of 4 sign", signer rows. Copy: "Your funds stay in an account only you control. Decimal prepares every payment, but it can't move a dollar on its own, and no one can override that."
  - **Verified vendor onboarding** — photo `uploads/sky1.jpg`; mini-card: vendor detail form + verified state. Copy (user-edited, keep verbatim): "Vendors submit their payment details through a secure link, verified before a cent goes out. Set up once, they stay on file for every bill after."
  - **Two-way ledger sync** — photo `uploads/water2.png`; mini-card: GL-coded line items → BILL TOTAL → QuickBooks "SYNCED" row, "Nothing to re-key" button. Copy: "Every line is coded to your chart of accounts, and posted bills land in QuickBooks Online on their own. Nothing left to re-key at close." (QuickBooks Online only — do NOT mention NetSuite; the mini-card's "and NetSuite" line inside the visual is stale, drop it.)

### 4. FAQ (artboard 18b)
Two-column dossier: sticky-feeling left title block + right accordion (first item open by default, plus-icon rotates 135° when open, 1px row separators). Six Q&As — exact copy in `faqVals()` in the file's logic script (What is Decimal? / Can Decimal move money without my approval? / Can I pay vendors in other countries? / How do roles and permissions work? / Does Decimal work with my accounting software? / How do I get access?).

### 5. Final CTA (artboard 19a)
Monk-simple centered band: ink background art treatment, centered H2 + "JOIN THE WAITLIST" button. Copy: "Put your accounts payable on autopilot." (user-edited).

## Interactions & Behavior
- All product-screen "demos" are non-interactive, infinitely looping CSS keyframe animations (pointer-events: none on fake buttons). Loop lengths: hero 18.5s, plate 01 12s, plate 02 10s+12s state-alternated, plate 03 16s.
- FAQ accordion is the only real interaction (open/close state).
- Waitlist buttons: wire to the real waitlist form/route.
- No responsive breakpoints were designed — desktop 1440 only. Mobile needs a separate pass; degrade gracefully (stack hero columns, hide the product-screen animation or replace with a static frame).
- Respect `prefers-reduced-motion`: pause/disable the loops.

## State Management
- FAQ: single `openIndex` (number | null).
- Plate 02: `phase: 'flow' | 'timeline'` on a 10s/12s setTimeout cycle.
- Everything else is pure CSS animation — no state.

## Assets (bundled)
- `uploads/demo girl.jpg` — Lena avatar (chat card + sidebar) — placeholder headshot, replace with licensed photo before ship
- `uploads/purplecheck.jpg`, `uploads/sky1.jpg`, `uploads/water2.png` — feature card photos
- `assets/skull-mask.png` — anatomy section mask graphic
- `assets/art2-*.png` — hero backdrop mask variants (hatch is the shipped default)
- Vendor flags: `https://flagcdn.com/w80/{cc}.png` (serve locally in production)
- QuickBooks "qb" chip is drawn in CSS (`#2CA01C`) — use official brand asset in production

## Files
- `Decimal Landing Options.dc.html` — the full design (template markup + `<style>` keyframes + logic script at the bottom). The hero animation timeline is documented in a comment block above the `hero*` keyframes.
- `pay-globe.js` — the d3 globe web component (light-DOM so page keyframes apply); reuse its projection/arc math directly.
- `support.js` — prototype runtime only; ignore for implementation.
- `_ds/…/_ds_bundle.css` — design-system tokens + component classes (`.dec` scope): source of truth for colors, `btn`, pills, inputs, tables.

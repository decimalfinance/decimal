# Axoria — Landing page content

This file is the source of truth for landing page copy. Hand this to a design
pass (Claude Design, Framer, v0, etc.) as the written brief.

---

## Positioning

**Axoria is the deterministic financial workflow engine for crypto payments.**

Not a reconciliation tool. Not a block explorer. Not another analytics dashboard.
Axoria is the layer that turns crypto payments into operations — the boring,
auditable, policy-governed kind your finance and ops teams actually need.

### One-line elevator

> Stablecoin payouts with policy, signatures, matching, and proof — without the
> spreadsheet.

---

## Hero section

**H1:** Run USDC payouts like a finance team, not a crypto team.

**Subhead:** Axoria takes a CSV, walks it through approval, one-signature batch
execution, and on-chain match — then hands back a signed proof packet your
auditor can verify. No exports. No reconciliation tickets. No guessing what hit.

**Primary CTA:** Start a run → (links to app signup / waitlist)
**Secondary CTA:** See how it works ↓ (anchor to "How it works")

**Trust row under hero (small, muted):**
- Built on Solana · USDC native
- Deterministic proofs (SHA-256 digest)
- Open API · audit export in one click

---

## The problem (three-panel "before Axoria")

Headline: **The way crypto payouts get run today is broken.**

**Panel 1 — Finance:**
- A spreadsheet becomes the source of truth.
- "Did this one go through?" becomes a Slack thread.
- Month-end reconciliation means eyeballing Solscan.

**Panel 2 — Ops:**
- One wrong address and money is gone.
- No policy gate between "I typed it" and "it signed."
- Every payout is a high-stakes one-off.

**Panel 3 — Auditors / Compliance:**
- No chain of custody from intent → signature → settlement.
- No way to verify a payout matches the approved request.
- No deterministic proof a month later.

---

## The solution (the wedge)

Headline: **One flow. Intent to proof.**

Subhead: Axoria is built around a single workflow — payouts — because that's
where crypto breaks down for finance teams. Everything else (inbound matching,
analytics, treasury dashboards) is downstream of getting this one right.

**The workflow, step by step:**

1. **Import intent** — CSV or API. `counterparty, destination, amount,
   reference, due_date`. Axoria validates every row before it's yours.
2. **Policy routes it** — trusted destinations auto-approve. Unknown ones wait
   for human approval. Amount thresholds, destination trust, and counterparty
   tags drive the decision. Nothing silent.
3. **Approve individually or in bulk** — approvers see reason, reference,
   destination trust state, and the policy rule that routed it. Approve some,
   reject others.
4. **One signature, whole batch** — Axoria prepares a single Solana transaction
   for every approved payment in the run. Sign once; on-chain is one atomic
   submission.
5. **Observe and match** — Yellowstone worker watches USDC transfers. Each
   intent matches to its on-chain transfer. Partial settlement and
   mismatches surface as exceptions — never silent.
6. **Proof packet on demand** — SHA-256-digested JSON bundling intent,
   approval, signature, transaction, settlement, and matching evidence. Export,
   hand to an auditor, verify forever.

---

## Why Axoria (feature strip)

**Deterministic.** Same inputs → same proof digest. Every time. Forever.

**Policy before signature.** Trust state, thresholds, counterparty tags. No
payment moves without a rule being satisfied.

**One signature, batched.** Fifty payments, one transaction. One hardware wallet
confirmation. One atomic on-chain event.

**Matched on-chain.** We don't just send — we observe the chain and match back
to intent. Every payment has a receipt.

**Audit-ready.** Downloadable JSON proof packet. Cryptographically tied to the
approval path. Verifiable without Axoria running.

**Open.** Own your data, own your proofs. API-first.

---

## How it fits

**Today:** Spreadsheet → wallet → Solscan → another spreadsheet → reconcile
next month → trust us it went through.

**With Axoria:** Spreadsheet → Axoria → signed batch → live match → proof
packet. Same afternoon. Done.

---

## Who it's for

- **Crypto-native startups** paying contributors, bounties, and vendors in USDC.
- **Treasury teams** at DAOs and protocols where "a multisig transaction" is
  the whole process today.
- **Finance ops** at crypto-adjacent businesses that need audit-grade trails.
- **Payment providers** who want a reconciliation primitive under their own UX
  (via the Axoria API).

Not for: consumer wallets. Retail users. Speculative trading.

---

## Social proof / credibility (placeholders)

- "We process our weekly contributor payouts through Axoria — one signature,
  forty payments, matched in the same tab." — [Design Partner 1]
- "Our auditor took the proof packet, ran the verification script, and signed
  off in ten minutes. That used to be a week of screenshots." — [Design Partner 2]
- Built on Solana. USDC native. Integrates with Phantom, Solflare, Ledger.

---

## Pricing (placeholder tier)

Axoria is free during the Solana Frontier build window. Pricing will ship with
GA.

**Starter — Free**
For teams proving it out. Up to X payments / month. Full proof exports.

**Growth — $X / month**
For active ops teams. Higher volume, multi-approver policy, API access.

**Enterprise — Talk to us**
SSO, custom policy, bring-your-own-RPC, audit trail retention.

---

## Final CTA

Headline: **Every payout, every approval, every match — in one proof packet.**

Subhead: Stop reconciling crypto. Start running it.

Primary CTA: Start a run →
Secondary: Read the API docs

---

## Footer notes (small print)

- Built for the Solana Frontier hackathon.
- Supported by Superteam India grant track.
- Open about the scope: Axoria is deliberately narrow. It does one thing —
  payouts with proof — and does it all the way through.
- Questions: [founder@axoria.xyz placeholder]

---

## Style and voice rules for the designer

1. **Institutional first.** Looks like Stripe / Bridge / Mercury — not like
   crypto Twitter. No gradients-on-gradients, no meme copy.
2. **Dark default is fine, but light must work.** Finance teams open tabs
   side-by-side with QuickBooks. Both themes must render.
3. **Active voice only.** "Axoria routes it" — not "it gets routed by Axoria."
4. **Numbers are monospaced.** Addresses, amounts, signatures.
5. **The wedge is payouts.** If a section talks about reconciliation or
   analytics, cut or demote it. We expand after we win this one lane.
6. **The proof packet is the soul.** Whenever possible, show the JSON, show the
   digest, show that this is *verifiable*. Most crypto products are vibes;
   Axoria is a receipt.

---

## Tech stack (recommended)

The landing page should ship as its own Next.js app (separate from the product
app in `/frontend`), but it must visually match the product so users don't feel
a jump when they click "Start a run →".

- **Framework:** Next.js 15 (App Router) + TypeScript
- **Styling:** Tailwind CSS with the brand tokens below as CSS variables
- **Components:** shadcn/ui (install per-component: `npx shadcn@latest add <name>`)
- **Icons:** `lucide-react`
- **Animation:** CSS transitions for micro-interactions; `framer-motion` only
  for scroll-linked reveals or orchestrated sequences
- **Fonts:** Geist (UI) + system mono stack (addresses, digests, numbers)
- **Hosting:** Vercel
- **Analytics:** Vercel Analytics + a light event tracker (Plausible or
  PostHog) for CTA clicks
- **Forms:** A single "waitlist / early access" form → Resend or Postmark
  (collect email + optional workspace size)

**Do not** install a component kit that forces Radix-ish pill buttons or soft
drop shadows — it will fight the institutional aesthetic.

---

## Brand tokens (copy these into Tailwind config)

Source of truth: `/brand.md` in this repo. Summary for the designer:

**Light (default, `:root`)**

```
--ax-surface-0   #FFFFFF
--ax-surface-1   #FAFAFA
--ax-surface-2   #F3F3F1
--ax-surface-3   #EBEBE8

--ax-text            #0A0A0B
--ax-text-secondary  rgba(0,0,0,0.68)
--ax-text-muted      rgba(0,0,0,0.52)
--ax-text-faint      rgba(0,0,0,0.32)

--ax-border          rgba(0,0,0,0.08)
--ax-border-strong   rgba(0,0,0,0.16)

--ax-accent          #059669    (verified-green; AA on white)
--ax-accent-hover    #047857
--ax-on-accent       #FFFFFF

--ax-warning         #B45309
--ax-danger          #B91C1C
--ax-info            #1D4ED8
```

**Dark (`:root[data-theme='dark']`)**

```
--ax-surface-0   #0A0A0B
--ax-surface-1   #111114
--ax-surface-2   #17171B
--ax-surface-3   #1E1E22

--ax-text            #EDEDED
--ax-text-secondary  rgba(255,255,255,0.64)
--ax-text-muted      rgba(255,255,255,0.46)
--ax-text-faint      rgba(255,255,255,0.28)

--ax-accent          #2EE6A8
--ax-accent-hover    #3BF0B2
--ax-on-accent       #0A0A0B

--ax-warning         #F5B041
--ax-danger          #F76464
--ax-info            #6BA6FF
```

**Typography scale**

- Display (hero H1): 48–64px desktop / 36px mobile, weight 500, letter-spacing -0.02em
- Title (section headers): 28–36px, weight 600
- Body: 16px default, 17px for hero subhead
- Eyebrow: 11–12px, uppercase, letter-spacing 0.08em, `--ax-text-muted`
- All numbers / addresses / digests: system mono stack + `font-variant-numeric: tabular-nums`

**Radii / borders / shadows**

- Radii: 6px (buttons, inputs), 10px (cards), 14px (page containers)
- Borders: 1px flat, never 2px
- Shadows: none on most surfaces. Reserve drop shadows for modals and the hero
  "product preview" frame if used.

---

## Page layout (section-by-section spec)

Target width: `max-w-6xl` content column, centered, with full-bleed backgrounds
for the hero and final CTA. Vertical rhythm: 96px between sections desktop,
64px mobile.

1. **Nav bar** — sticky, transparent over hero, solid on scroll.
   Left: Axoria wordmark + small "A" logo.
   Right: Docs · Pricing · Sign in · **Start a run** (primary button).

2. **Hero** — full viewport height minus nav. Left 60% copy, right 40% visual.
   Visual is a stylised product screenshot: the Overview page or a payment
   run detail with the lifecycle rail showing all 6 stages green. Use the
   actual app UI, cropped and framed in `rounded-14px` with a 1px
   `--ax-border-strong` frame. Dark by default; optional light/dark toggle
   lives in the nav.

3. **Trust row** — thin horizontal strip under hero. Three items, divided by
   vertical lines. Small type, muted color.

4. **The problem** — three equal-width panels on desktop, stacked on mobile.
   Card background `--ax-surface-1`, 1px border, 32px padding, icon at top
   (lucide: `FileSpreadsheet`, `ShieldAlert`, `FileCheck`).

5. **The solution (workflow)** — numbered vertical stepper. On desktop render
   as a 2-col layout: left side is the number + label + description, right side
   is a small visual for that step (import dialog, approval card, sign dialog,
   proof JSON pane). Connect steps with a 1px vertical line in
   `--ax-border`. The whole section background is `--ax-surface-0`.

6. **Why Axoria** — 2×3 grid of feature cards on desktop, 1 column on mobile.
   Each card: small icon, 18px title, 14px body. No background; divider
   lines between them.

7. **How it fits** — two-column "before / after" flow diagram. Use text only
   (monospace arrows `→`), no illustrations. Muted left column, accent-green
   arrows on the right.

8. **Who it's for** — 4 small cards in a single row (desktop). Each has a
   tag label in the accent green and a short body.

9. **Social proof** — two wide testimonial cards side by side. Pull quote in
   20px serif-substitute (actually stay sans, but 500 weight). Below: a
   light "Built on" row with Solana / USDC / Phantom / Solflare / Ledger
   wordmarks in muted gray.

10. **Pricing** — 3 cards in a row, middle one highlighted with a thin
    accent-green border. Tier name, price, 4 feature bullets, CTA button
    (accent-green filled for the middle, outlined for the others).

11. **Final CTA** — full-bleed section. Centered display headline, subhead,
    primary button, secondary link. Dark background even in light theme for
    visual punch.

12. **Footer** — 4-column on desktop: Product / Developers / Company / Legal.
    Bottom row: copyright, small "Built for the Solana Frontier hackathon".

---

## Responsive breakpoints

- Mobile: `< 640px` — single column, hero visual moves below copy
- Tablet: `640–1024px` — 2-column where content allows
- Desktop: `≥ 1024px` — full layout as specified above
- Max content width: `1152px` (Tailwind `max-w-6xl`)

Keep line length to 60–75 characters on body text. Use `text-balance` on
headings.

---

## Motion rules

- Durations: 150ms (micro), 220ms (dialogs/reveals), 320ms (page-level)
- Easing: `ease-out` on entrance, `ease-in` on exit. Never `linear`.
- Do not animate `all`. Specify transform, opacity, colors explicitly.
- Respect `prefers-reduced-motion: reduce` — disable scroll-linked animations
  and fade-ins for users who request it.

---

## Copy length targets

- Hero H1: ≤ 12 words
- Hero subhead: ≤ 30 words
- Feature card title: ≤ 5 words
- Feature card body: ≤ 25 words
- Section headline: ≤ 8 words
- Testimonial: ≤ 35 words

If copy exceeds these, tighten it — institutional readers skim.

---

## Required assets

Before handoff the user must provide or Claude Design must generate:

- [ ] Axoria wordmark (SVG, light + dark variants)
- [ ] Favicon (32×32, 192×192, 512×512)
- [ ] Social card / OG image (1200×630, dark theme)
- [ ] Hero product screenshot (or mockup) of the Overview page — use the
      dark theme variant of the running product
- [ ] Optional step visuals: CSV import dialog, approval card, sign dialog,
      proof JSON preview
- [ ] Wordmarks / logos: Solana, USDC, Phantom, Solflare, Ledger (all under
      fair-use attribution in a "Built on" row)

---

## SEO and metadata

- Title: `Axoria — Deterministic USDC payouts with proof`
- Description: `Run stablecoin payouts with policy, signatures, on-chain matching,
  and cryptographic proof. For crypto-native teams that need audit-grade trails.`
- OG title: `Run USDC payouts like a finance team, not a crypto team.`
- Canonical URL: `https://axoria.xyz/` (or the actual domain)
- robots: `index, follow`
- Structured data: SoftwareApplication + FAQ schema later

---

## How to hand this off to Claude Design

"Claude Design" isn't a separate product — it's Claude (claude.ai) applied to
design work, best used via **Projects** with **Artifacts** rendering live
previews. The flow:

1. Go to [claude.ai](https://claude.ai) and sign in with your Anthropic
   account (the same one you use for Claude Code).
2. Click **Projects → Create Project**. Name it `Axoria landing page`.
3. In the project's **Project knowledge** panel, upload:
   - This file (`landing-page-content.md`)
   - `/brand.md` from the repo root
   - 1–2 screenshots of the current product (Overview page, payment run
     detail with the lifecycle rail) so Claude sees the visual tone
4. Set the project's **Custom instructions** to:
   > You are designing the marketing landing page for Axoria. All copy, voice,
   > color, and structure decisions must come from the project knowledge. Default
   > to dark theme. Output each section as a React + Tailwind component inside
   > an Artifact so I can preview it live. Use shadcn/ui primitives and
   > lucide-react icons. Never invent pricing or testimonials — use the
   > placeholders in `landing-page-content.md`.
5. Start the first chat with something like:
   > Build the hero section. Follow the spec for Hero in
   > `landing-page-content.md`. Render it as a preview-able Artifact. Use
   > dark theme tokens from `brand.md`.
6. Iterate section-by-section. When satisfied, ask Claude to consolidate all
   sections into one Next.js 15 App Router page at `app/page.tsx`, with a
   `tailwind.config.ts` that exposes the `--ax-*` tokens as a theme extension.
7. Export via "Copy code" on each Artifact, drop into a new Next.js repo, push
   to Vercel. Point `axoria.xyz` at the Vercel deployment.

Alternative tools (if you want to shortcut Artifacts):

- **v0.dev** — takes the same brief, generates shadcn+Tailwind components.
  Paste this markdown as context.
- **Framer AI** — gives you a design-tool canvas instead of code. Good for
  exploration, worse for handing off to the product stack.
- **lovable.dev** — generates full Next.js projects. Works, but you get less
  control over tokens than the Claude + Artifacts flow.

**Stick with Claude + Artifacts** unless a specific tool saves real time. The
Artifact output is closest to what the product app uses and keeps the design
honest to the brand file.

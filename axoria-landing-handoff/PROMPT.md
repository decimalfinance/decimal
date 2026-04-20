# Paste this as your first message in Claude Design

Go to **claude.ai/design** → start a new design. Attach the following files from this folder before sending:

- Every file in `screenshots/`
- `brand.md`
- `landing-page-content.md`
- `source/Landing.tsx`
- `source/styles/landing.css`
- Every file in `source/landing-components/`

Then paste everything between the `---` lines below as your first message.

---

I have an existing React landing page for **Axoria** — a deterministic financial workflow engine for stablecoin (Solana USDC) payouts. I want to iterate on it inside Claude Design.

**What's attached**

- Screenshots of the current landing in both themes and of each major section.
- `brand.md` — the brand direction (color tokens, typography, voice). Treat this as the source of truth for palette and type.
- `landing-page-content.md` — the full landing page brief (positioning, section-by-section spec, copy, voice rules). Treat this as the source of truth for wording.
- `source/Landing.tsx` and `source/landing-components/*.tsx` — the actual React implementation of the current landing. These are *reference* so you can see how each section is structured, not the format you should output in.
- `source/styles/landing.css` — all landing-only styles, scoped to `.landing-root`. Shows how tokens are wired.

**Ground rules**

1. The palette in the files is the real one. **Do not invent new colors.** Light mode = warm off-white surface (`#F5F2EA`) + dark-mustard-yellow accent (`#9B7A00`). Dark mode = near-black surfaces + warm amber accent (`#E8B84F`). All tokens live on `.landing-root`.
2. Both themes must work. The landing has a working theme toggle in the nav; dark must read as confidently as light.
3. The hex-character canvas background (`CodeWall.tsx`) is part of the brand identity — keep it behind everything. All other visuals go *on top of* it.
4. Typography is Geist (UI) + Geist Mono (addresses, digests, numbers).
5. The landing has its own palette inside `.landing-root`; the rest of the app uses a different emerald palette. Don't propose changes that leak outside `.landing-root`.

**What I want iterated**

- **Hero section** — this is where I most need help. I want *artistic, atmospheric visuals* on the right side of the hero — not product screenshots, not dashboards, not mockups. Reference for the vibe: Runlayer's isometric illustrations, Linear's in-app motion art, the ambient compositions you see on Bridge or Fireblocks. Something that sets a mood without explaining the product. I've already tried: rotating ASCII torus, ASCII mountain-and-sun landscape, dense code block with gravity-well glows, rotating ASCII dollar-sign coin — all were rejected for feeling either too generic or too demo-scene. Open to: generative compositions, abstract forms made out of monospace characters, SVG illustrations that fit the "institutional + crypto-adjacent" aesthetic, something tactile, or something I haven't considered.
- **Features section** — the current carousel works but the visuals inside each panel (rules list, signature stack, intent/transfer match, proof digest) feel engineering-demo-ish. Happy to keep the carousel pattern; explore different visual treatments for each feature that still convey what the feature does.
- **CTA section** — current headline is "Stop reconciling. / Start shipping receipts." If there's a stronger landing for the final CTA, propose it.

**What I do NOT want changed (for now)**

- **Nav** — the sticky backdrop-blur nav with Axoria wordmark, `How it works` link, theme toggle, `Get started` button is final.
- **Workflow section** — the 5-step scroll-driven stepper (Create intent → Review → Approve → Execute → Export proof) with vertical rail on the left and crossfading mock panels on the right is the centerpiece of the page and works well. Don't redesign it.
- **Copy** — `landing-page-content.md` is locked. If wording needs to change, flag it and I'll decide.

**Output format**

- Give me each section as its own HTML/CSS/JS Artifact so I can preview live and compare.
- Don't bundle everything into one artifact at first — iterate section-by-section.
- When a section is approved, you can consolidate.

Start by proposing three distinct directions for the **hero right-side visual**. For each, give me: a short name, a 1-sentence concept, a sketch description of what it looks like, and a live Artifact that implements it so I can see the difference. After I pick one, we'll move to Features.

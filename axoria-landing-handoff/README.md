# Axoria landing — handoff bundle for Claude Design

This folder is everything Claude Design needs to understand the current Axoria landing page and help iterate on it. It is **not** the live source — the live source lives in `frontend/` and is what ships. This is a frozen snapshot packaged for design iteration.

## What's in here

```
axoria-landing-handoff/
├── README.md                  ← this file
├── PROMPT.md                  ← ready-to-paste prompt for the first Claude Design message
├── brand.md                   ← brand direction (colors, typography, voice)
├── landing-page-content.md    ← landing page brief (positioning, sections, copy, design rules)
├── screenshots/               ← fill this yourself; see below
└── source/
    ├── Landing.tsx            ← shell / nav / footer / theme toggle
    ├── styles/
    │   └── landing.css        ← every landing-only style, scoped to .landing-root
    └── landing-components/
        ├── Hero.tsx           ← headline, chip, CTAs
        ├── Workflow.tsx       ← 5-step scroll-driven stepper
        ├── Features.tsx       ← 4-feature carousel
        ├── FinalCTA.tsx       ← "Stop reconciling / Start shipping receipts"
        ├── CodeWall.tsx       ← <canvas> hex-character background
        ├── ProductUI.tsx      ← mock product cards used inside Workflow
        └── Icons.tsx          ← inline SVG icon set
```

## Screenshots — you still need to capture these

Run the dev server from the repo root and capture full-page shots of each theme + section. Save them into `screenshots/` before starting the Claude Design session.

```sh
cd frontend
npm run dev
```

Then open `http://localhost:5174/` and capture:

- `hero-dark.png` — full hero viewport (top ~900px) in dark mode
- `hero-light.png` — same in light mode (toggle the theme switch in the nav)
- `workflow-dark.png` — mid-scroll through the 5-step stepper
- `features-dark.png` — features carousel mid-state (any panel)
- `cta-dark.png` — bottom CTA
- `full-dark.png` — full-page scroll, dark
- `full-light.png` — full-page scroll, light

Chrome / Brave: `Cmd+Shift+P` → "full size screenshot". Safari: `Cmd+Shift+5`.

## How to use this bundle

Step-by-step in `PROMPT.md`. Short version:

1. Capture the screenshots above into `screenshots/`.
2. Go to **claude.ai/design** → start a new design.
3. Paste the prompt from `PROMPT.md` as the first message.
4. Attach everything in this folder (screenshots + `brand.md` + `landing-page-content.md` + all the files under `source/`).
5. Iterate. Claude Design will produce HTML/CSS/JS artifacts you can preview live.
6. When you've got a design you like, export the bundle (Claude Design offers an export flow similar to what's already in `axoria/` at the repo root).
7. Drop the exported bundle back into the repo and the coding agent (Claude Code) will port it to React following the existing conventions in `frontend/src/pages/landing/`.

## Notes for Claude Design

- The page is **already live** as React components under `frontend/src/pages/`. The `.tsx` + `.css` files here are *reference*, not what Claude Design should output. Claude Design outputs HTML/CSS/JS prototypes.
- Brand palette is scoped to `.landing-root`. The product app under the same domain uses a **different** emerald-on-white palette and should not be touched.
- Light surface: `#F5F2EA` (warm off-white). Dark surface: `#0A0A0B`. Accent: `#9B7A00` in light, `#E8B84F` in dark.
- Typography: Geist (UI) + Geist Mono (addresses, numbers, signatures).
- The hex-character background canvas (`CodeWall.tsx`) is part of the brand — keep it. Everything else is up for iteration.

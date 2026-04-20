# Axoria Brand

_Status: committed (2026-04-19)_

Written by Claude after the user delegated brand direction during the payouts-wedge frontend rebuild. This file is the source of truth for color, typography, tone, and visual system until the user explicitly overrides it.

## Positioning

> Axoria is the deterministic financial workflow engine for crypto payments.

NOT a reconciliation tool. NOT a wallet watcher. NOT an ops dashboard. The product takes payment intent and returns cryptographic proof that every step was controlled and verified.

Every piece of copy reinforces: **deterministic**, **workflow**, **engine**, **proof**. Not **monitor**, **track**, **observe**.

## Visual direction

**Institutional, not consumer.** References: Linear (precision), Mercury (clarity), Stripe (density + readability), Fireblocks/Squads (crypto-institutional weight), Bloomberg Terminal (monospace trust).

**Light-default, dark as a first-class toggle.** Institutional finance tools (Stripe, Mercury, Brex, Ramp) ship light by default; dark mode is table stakes but not the default. Theme preference persists per user in `localStorage` under `axoria.theme` and is toggled from the sidebar footer. Both themes use the same token set — the accent green shifts (`#059669` light / `#2EE6A8` dark) so contrast hits AA on both surfaces.

Restrained, flat, precise. No gradients except on marketing surfaces. No pill buttons. No soft shadows. Confident spacing. Information density over airiness inside the app (institutional users scan data).

## Typography

- **Sans (UI)**: Geist Variable — already installed. Used for everything except numbers and addresses.
- **Mono (numbers, addresses, signatures, proof digests)**: system monospace stack — `ui-monospace, 'SF Mono', Monaco, 'JetBrains Mono', Menlo, Consolas, monospace`. All currency amounts, tx hashes, and wallet addresses use mono + `font-variant-numeric: tabular-nums`.
- **Serif** (`Instrument Serif`): **dropped from the app**. The serif doesn't fit a deterministic-execution product. May keep for specific marketing moments only.

Hierarchy:
- Display: 32–40px, `font-weight: 500`, letter-spacing -0.02em
- Title: 20–24px, `font-weight: 600`
- Body: 14px default, 13px for dense tables
- Eyebrow/metadata: 11–12px, uppercase, letter-spacing 0.08em, muted color

## Color tokens

Light (default, `:root`):

```
--ax-surface-0   #FFFFFF   page background
--ax-surface-1   #FAFAFA   cards / panels
--ax-surface-2   #F3F3F1   popovers / elevated
--ax-surface-3   #EBEBE8   hover

--ax-text            #0A0A0B
--ax-text-secondary  rgba(0,0,0,0.68)
--ax-text-muted      rgba(0,0,0,0.52)
--ax-text-faint      rgba(0,0,0,0.32)

--ax-border          rgba(0,0,0,0.08)
--ax-border-strong   rgba(0,0,0,0.16)

--ax-accent          #059669   (AA on white)
--ax-accent-hover    #047857
--ax-accent-dim      rgba(5,150,105,0.08)
--ax-on-accent       #FFFFFF   text on accent

--ax-warning         #B45309
--ax-danger          #B91C1C
--ax-info            #1D4ED8
```

Dark (`:root[data-theme='dark']`):

```
--ax-surface-0   #0A0A0B
--ax-surface-1   #111114
--ax-surface-2   #17171B
--ax-surface-3   #1E1E22

--ax-text            #EDEDED
--ax-text-secondary  rgba(255,255,255,0.64)
--ax-text-muted      rgba(255,255,255,0.46)
--ax-text-faint      rgba(255,255,255,0.28)

--ax-border          rgba(255,255,255,0.07)
--ax-border-strong   rgba(255,255,255,0.14)

--ax-accent          #2EE6A8
--ax-accent-hover    #3BF0B2
--ax-accent-dim      rgba(46,230,168,0.12)
--ax-on-accent       #0A0A0B

--ax-warning         #F5B041
--ax-danger          #F76464
--ax-info            #6BA6FF
```

The verified-green accent does double duty as brand primary AND as the "settled" semantic color. This is intentional — it makes every completed payment reinforce the brand.

## Radii, borders, shadows

- Radii: `3px` (small controls), `6px` (buttons, inputs), `10px` (cards, panels), `14px` (page-level containers)
- Borders: 1px always, flat, never 2px
- Shadows: dark mode prefers subtle inner highlight (`inset 0 1px 0 rgba(255,255,255,0.04)`) over drop shadow. Reserve drop shadows for overlays (modals, popovers).

## Motion

Per skill duration tiers: 100ms (micro feedback), 150ms (small entrance), 220ms (dialogs/toasts), 320ms (page-level). Never `linear`, never CSS `all`. Entrance ease-out, exit ease-in.

## Tone and voice

- Imperative, specific, short. "Sign and submit" not "You can sign and submit this batch here."
- No marketing language inside the app. "All payments settled" not "🎉 Successfully reconciled!"
- Numbers speak louder than adjectives. Show "2 of 2 matched" not "complete".
- Trust over cleverness. Never cute. Never emoji.

## Still open (address later)

- Landing page redesign — the purple/Instrument Serif hero needs to be redone to match this system. Not touched yet.
- Light mode tokens.
- Logo / wordmark review — the existing `/axoria.png` stays for now.

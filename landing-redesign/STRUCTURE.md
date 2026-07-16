# Landing structure — v2 (brand-led)

Date: 2026-07-16. **Supersedes v1.** Rebuilt from `LANDING-RESEARCH.md` (20-company study)
after v1 read like a slide deck. Copy lives in `COPY.md`; positioning in
`POSITIONING-CORRECTED.md`. This file fixes section order, each section's single bet, its
visual, and the honesty constraint.

## The shape (7 sections, one bet each, product-led)

Gone from v1: the **problem section** (rule 2 — nobody does it), the **credibility strip**
(rule 5 — self-custody becomes a real section instead), and the **feature-block-per-stage
catalog** (the Brex anti-pattern). Density is inverted: sparse hero, detail below the fold.

1. **Hero** — one iconic claim + the real product as the visual + one primary CTA (Join the
   waitlist) and one secondary (See it work → the demo). AI is flexed in the line
   ("Self-driving accounts payable.") and by the product visual, not by "AI-powered." No
   explanatory paragraph. Hero visual = a real product screen (bill being read/coded) or the
   interactive demo itself — never abstract art, never a busy dashboard.

2. **Watch it work** — the AP loop in the REAL product: reads a bill → codes it → routes the
   approval you built. This is the AI flex by demonstration (rule 4). Product screens / short
   motion, one-line lead, no bullets. Links to the full interactive demo.

3. **Approvals (our edge)** — the complex-workflow builder is SHIPPED and one of our sharpest
   differentiators: most AP/finance software still can't give a good experience for building
   complex approval workflows (Zaid). Flex the **AI assist**: you describe how you approve in
   plain words → the AI lays the flow out on the canvas. The human AUTHORS it; the AI draws it
   — do NOT say "built by AI." The natural-language-to-canvas assist is roadmap, sold as built
   like the payout leg; the manual builder is real. Show the flow-builder canvas. Copy rules:
   no negation, don't name "templates," don't over-explain mechanics — assert positively.

4. **Pay anywhere** — one concrete, Wise-style cross-border claim shown as a payment
   completing in the product (Scheduled → Delivered, currency-flag chip, same screen as a
   domestic bill — Tipalti's model, no world map). Global as a believable moment, not a
   feature bullet.

5. **Your money never leaves your control** — self-custody as its own hero-level section,
   framed as upside (Mercury-style), plain English, zero crypto words. The moat.

6. **Works with your books** — QuickBooks two-way sync, one line + the mark. Neutralizes the
   "do I have to rip out my accounting?" objection. No customer wall.

7. **Final CTA** — one clear waitlist ask, restating the motif ("You just approve").

## Our honesty line (unchanged from the sell-the-dream decision)

We sell the full product vision as if built, including the cross-border payment leg that
isn't shipped — shown working in the demo, no "coming soon" hedge. Off-limits: fabricated
**live proof** — invented metrics, customer counts, logos, testimonials. Show it working;
don't cite results it hasn't earned. Grant/Solana stays off the public page.

## The interactive demo (CTA-linked destination — Ramp's model, NOT the hero)

Ramp links a **12-step guided product tour overlaid on a fully-seeded, clickable product**
(fake data, tooltips on real UI, Back/Next) — a separate walkthrough they link to, not their
hero. We do the same: link it from the hero's "See it work →" CTA and from section 2. It runs
on a self-contained sandbox (seeded fake vendors), which is how the cross-border payment leg
shows "as built" honestly. Our tour (~9 steps):
1. Intro on the real Bills page.
2. A bill arrives; extraction reads it (real).
3. AI codes each line, learns the vendor (real).
4. Policy gates flag a duplicate / a vendor on hold (real).
5. The approval flow you built routes it; separation of duties (real flow-builder).
6. Ready to approve; you approve (real).
7. Pay — vendor local or overseas, same screen, currency chip (**demo-only UI**).
8. Payment tracker: Scheduled → Initiated → Delivered (**demo-only UI**).
9. Writes back to QuickBooks; close on the one-line promise (real sync).

`[Build note: steps 1-6 + 9 run on the actually-shipped product seeded with fake vendors;
steps 7-8 need a demo-only payment UI. Real build — scope separately; it does NOT block
shipping the static page.]`

## Visual inventory (what design needs)

- Hero: one real product screen (bill in review) or an embed of the demo.
- Section 2: 2-3 real screens or short motion of extraction → coding → approval routing.
- Section 3 (Approvals): the flow-builder canvas — real, shipped. The centerpiece visual for our edge.
- Section 4 (Pay): a payment row/tracker with a currency-flag chip (demo-only UI is fine).
- Section 5 (Control): understated, type-led; maybe a simple "your account / rule can't be overridden" visual.
- Section 6 (Books): the QuickBooks mark.
- No stock art, no abstract gradients as the argument, no fabricated customer logos.

# YC Fall 2026 — application draft

**Deadline:** Mon Jul 27, 2026, 8:00pm PT. **Submit target:** Sun Jul 26 (one buffer day).
**Terms:** $500K (7% + MFN), USDC-on-Solana funding option, SF Oct–Dec. Solo / non-US friendly.
**Why #1:** YC's current RFS explicitly names stablecoin + cross-border money movement — Decimal's
exact thesis.

Answers drafted from `ASSET-KIT.md`; every claim checked against `CLAIMS-LEDGER.md`. Verify the live
question set on the YC form before submitting — these are the standard YC questions; fill any new/renamed
field from the kit. **⟨Zaid to refine every answer.⟩**

---

## Company

**Company name:** Decimal

**Describe what your company does in 50 characters or less.**
> AI accounts payable that pays vendors worldwide

**Company URL:** ⟨landing URL⟩
**Demo video / product:** ⟨link to a 60–90s product walkthrough of capture → code → approve → sync⟩

**What is your company going to make? (elaborate)**
> Decimal is AI-native accounts payable software. Today it reads every invoice with a vision model,
> codes it to the right GL account and learns each vendor, runs it through an approval flow the
> customer designs (cost-center hierarchies, tiered spend authority, delegation) that the system
> enforces, holds any new or look-alike vendor payout address for review to stop account-takeover
> fraud, and syncs two ways with QuickBooks. That AP core is built and working.
>
> The treasury already runs on a self-custodial Squads multisig, so the money sits in an account only
> the customer controls. What we are building next, and what the product is aimed at, is paying the
> vendor out of it: fast, transparent-FX, cross-border vendor settlement, integrating Bridge for the
> off-ramp and FX. Incumbents split the market: Ramp and BILL are fast domestic AP with weak global payout;
> Tipalti has global reach but sits outside the ERP with opaque multi-day FX; new AI-native AP is all
> on traditional bank rails. Decimal is the one product that is AI-native, ERP-native, and settles
> cross-border fast with transparent FX and self-custody.

**Where do you live now, and where would the company be based after YC?**
> ⟨Now: Zaid's city / India. After: SF for the batch; open to relocating.⟩

---

## Founders

**How long have the founders known each other and how did you meet?** (solo)
> Solo founder. I chose to start solo: the bar for a co-founder is high, and nothing so far has needed
> to wait for one. I am actively open to a technical co-founder who is a genuine peer.

**Who writes code, or does other technical work on your product? Was any of it done by a non-founder?**
> I do. I built the entire product end to end, myself: invoice extraction, the GL-coding agent, the
> approval engine, the fraud review gate, and the two-way QuickBooks sync.

**How far along are you? What have you built?**
> The AP core is shipped and demoable: capture → AI extraction → AI GL coding → a build-your-own,
> enforced approval engine → a BEC/look-alike fraud gate → two-way QuickBooks sync. The treasury runs
> on a self-custodial Squads multisig. Backed by a $10,000 grant from Solana Foundation × Superteam.
> Pre-launch, so no usage metrics claimed. The next build is the cross-border payout rail: integrating
> Bridge for the fiat off-ramp and FX.

**How many users do you have?** Pre-launch; no live users yet. First paid design partners are the
near-term goal.

---

## Progress & idea

**Why did you pick this idea? Do you have domain expertise? How do you know people need it?**
> AP is one of the last big back-office workflows still done by hand: invoices typed, coded, chased
> for approval, and reconciled by a person, and when the vendor is overseas the payment itself is slow
> and costs up to ~15% all-in. I kept seeing that businesses have to choose between a tool that does
> the AP work (BILL, Ramp) and one that pays vendors globally (Tipalti, Wise), never both well. I
> built the AP core to prove the judgment work is now automatable with agents, and the pull I want to
> resolve is the payment.

**What's new about what you're making? What substitutes do people resort to?**
> New: an agent that *resolves* AP exceptions rather than just routing them; an approval engine the
> customer designs and the system enforces; a fraud gate on vendor payout addresses; and a design
> aimed at self-custodial cross-border settlement. Substitutes today: BILL/Ramp plus a separate
> wire/Wise/Tipalti transfer, with reconciliation stitched by hand.

**Why now?**
> The settlement rail turned real in 2025–26 (~$226B B2B stablecoin volume, +733% YoY; Visa settling
> in USDC), the GENIUS Act (Jul 2025) gave payment stablecoins legal standing, and vision models plus
> agents finally make AP judgment work automatable. The three had to arrive together, and they just did.

**Who are your competitors, and who might become competitors? Who do you fear most?**
> Ramp, BILL, Brex (fast domestic AP, weak global); Tipalti (global reach, outside the ERP, opaque
> FX); new YC-backed AI-native AP (on bank rails). Most feared: whichever fast-moving AI-native AP
> company adds a real self-custodial cross-border rail first.

**How do or will you make money? How much could you make?**
> SaaS + a transparent take on cross-border settlement (a visible spread far below the 2.5–5% banks
> bury). B2B cross-border is a multi-hundred-billion-dollar flow; AP-heavy mid-market with overseas
> vendors is a large, underserved wedge of it.

**How will you get users?** Personalized outbound to Controllers/AP leads at import-heavy mid-market
companies; leverage the existing Superteam/Solana ecosystem relationships for warm intros; paid design
partnerships, not free pilots.

---

## YC RFS tie-in (put this in the "anything else" / equity or idea box)

> YC's RFS asks for stablecoin and cross-border money movement, and YC now funds its companies in USDC
> on Solana. Decimal is built for exactly that: an AI-native AP product whose next layer is fast,
> transparent, self-custodial cross-border vendor settlement. We would be building the category on the
> rail YC itself uses.

---

## 1-minute founder video script (founder only, no advisors)

Target 60s. Show the real product on screen for the middle third.

- **0:00–0:10 — Who + what (talking head).** "I'm ⟨name⟩, founder of Decimal. Decimal is AI accounts
  payable for businesses that pay vendors, and I built it solo."
- **0:10–0:20 — The problem.** "Companies still type invoices, code them by hand, chase approvals, and
  when the vendor is overseas the payment takes days and costs up to fifteen percent."
- **0:20–0:42 — Product (screen share, no fake steps).** Show: drop in an invoice → it extracts →
  the agent codes it → it hits an approval flow you designed → the fraud gate flags a changed payout
  address → it syncs to QuickBooks. Narrate plainly. Do not show or imply a live payment that isn't built.
- **0:42–0:55 — Why now + vision.** "Stablecoins made cross-border dollars move in minutes, the GENIUS
  Act made them legal, and agents finally do the AP judgment work. Next we pay the vendor: fast,
  transparent FX, in an account only the customer controls."
- **0:55–1:00 — Ask.** "I'm building the exact category YC is asking for, on the rail YC uses. Let's talk."

**Shoot notes:** good light, quiet room, one clean take of the screen segment. Founder only.

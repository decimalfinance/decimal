# Customer + GTM research — cross-border stablecoin AP

Date: 2026-07-14. Consolidates the background research on the ideal customer, the
cross-border/stablecoin market, and startup accelerators. Some sub-threads died to
API/tool errors (nested agents); the pieces below are the verified survivors.
Re-running: sharpest contractor-paying segment, YC criteria, founder narrative.

Companion file: `RESEARCH-ap-marketing.md` (how AP products market themselves).

---

## 1. Market + regulatory context (SOLID — agent ran its own searches, 26 tool calls)

**Scale.** US B2B cross-border payments ~$109B (2025) → ~$222B by 2035. B2B is 72.8%
of the US cross-border market; 66% of US enterprises transact internationally.
Wise's own sizing: ~$153B/year in hidden SMB cross-border fees.

**Corridors.** Biggest US outbound: US→India (~$103B, 54% of India's IT exports),
US→Philippines (BPO/contractors), plus broad global-contractor hiring. Deel alone
processed $250M in stablecoin payouts to 10,000+ contractors across 100+ countries in 2025.

**Pain (worse than the "3%" line).** World Bank: banks average **14.99%** on
remittance-scale transfers; B2B wire markup commonly 2.5–5%. Wires take 1–5 days;
each correspondent hop adds 24–48h. Correspondent-banking relationships have fallen
20–30% in a decade — worst in emerging markets (−41% vs −23% advanced), i.e. exactly
the corridors we'd target.

**Incumbents** (Wise, Payoneer, Mercury, BILL, Airwallex, Nium, PayPal) still clear
through banking hours / correspondent chains — none offer true 24/7 settlement; even
Nium admits gaps in "hard" corridors.

**GENIUS Act** — signed July 18 2025 (Public Law 119-27). Federal "payment stablecoin"
definition, mandatory 100% reserves, monthly attested disclosure, par redemption rights,
bankruptcy priority for holders, no-yield rule (marks stablecoins as payment instruments,
not investments). Effective by Jan 18 2027 (or 120 days after final rules).

**Adoption signals.** McKinsey/Artemis: real B2B stablecoin payment volume $226B in 2025
(60% of total stablecoin payments, +733% YoY). Visa hit ~$7B annualized USDC settlement
run-rate in 4 months. Stripe's Bridge got an OCC trust-bank charter Feb 2026.

**Sharpest corridor wedge:** US companies with recurring AP to contractors/offshore teams
in corridors where local banking is degrading AND vendors already prefer USDC — India,
Philippines, Argentina, Nigeria, Ukraine, Vietnam (all top-10 Chainalysis adoption). AVOID
leading with UK/EU/Canada where incumbents work fine.

**Trust framing:** borrowed trust (Visa/Mastercard/Stripe already settle USDC) + GENIUS
Act's specific legal protections (reserves, audited disclosure, redemption, bankruptcy
priority) + the no-yield provision as proof it's a payment instrument, not speculation.
DON'T use the "$33T stablecoins > Visa+Mastercard" claim (inflated by trading volume);
use the McKinsey $226B real-B2B-payments figure.

## 2. Segment: e-commerce / import-export paying overseas suppliers (DECENT — quote-verification flagged)

FBA/Shopify DTC brands + small import/export traders paying factories in China (dominant),
Vietnam, India, Mexico. Payments are per-PO with 30–50% deposits, not net-30; tickets a few
$k to six figures. Category incumbents built specifically for this pain: **PingPong,
Payoneer, Airwallex** (two well-funded fintechs existing solely for "China supplier payment"
is itself market proof). Alibaba built Trade Assurance/escrow around the same friction.
Crypto-adjacency: China export trade already uses USDT at OTC/trader level (factory-level
unverified). Reachability: r/FulfillmentByAmazon, r/importexport, r/dropship, Freedom
Fasttrack + My Silent Team (Amazon seller communities), Prosper Show / Seller Summit confs.

## 3. Accelerators (PARTIAL)

**a16z Speedrun is NOT the fit** — it's a16z *Games'* accelerator (gaming/interactive
entertainment), no fintech/stablecoin precedent found. The thesis-aligned a16z program is
**Crypto Startup School (CSX)** under a16z crypto, which has a documented 2026 cycle
(a16zcrypto.com). Target CSX, not Speedrun.

## 5. Accelerators + founder narrative (SOLID, clean re-run, 22 tool calls)

**YC is the standout — and the timing is a live tailwind, not a headwind.**
- **YC Fall 2026 (F26) on-time deadline: July 27 2026, 8pm PT (~2 weeks out).** Decisions
  by Aug 28; batch Oct–Dec in SF. Next after that = Winter 2027 (~Nov 2026, unconfirmed).
- **YC is bullish on stablecoins right now.** From Spring 2026, every YC company can take its
  $500K in USDC across major chains **including Solana**; YC did its first all-USDC-on-Solana
  seed (Totalis). Garry Tan: *"YC will invest in any YC company in stablecoins. The new
  financial rails of the revolution will not be over ACH or wire."* YC×Coinbase RFS names
  **cross-border financial services** as a target. We're building exactly what YC is telling
  founders to build, on the rail YC now uses itself. Put this in "why now."
- **What YC selects for:** formidable founders > idea; *resourcefulness* ("Be Relentlessly
  Resourceful"); "make something people want"; clarity over cleverness. Traction is defined
  broadly — grants, working product, LOIs, waitlist all count. Our devnet product + Solana
  grant = named traction categories, not a consolation.
- **Solo-founder headwind is real** (PG: "too hard for one person," can read as "a vote of no
  confidence"; ~10% of a batch is solo, ~5x worse odds). Offset: reframe as a chosen high bar
  ("using tools/contractors to move fast; open to a cofounder but only if they change the
  trajectory; executing meanwhile"), never "I don't need one." Address the gap head-on —
  silence reads worse.

**Other programs:**
- **South Park Commons Founder Fellowship — Fall 2026 deadline Aug 2 2026 (open now).** Most
  forgiving on stage ("-1 to 0, pre-revenue, pre-product, even pre-idea"), judges almost
  purely on the founder. $400K/7% + $600K guaranteed next round. Apply in parallel — narrative
  reuses the YC material.
- **a16z Crypto Startup School (CSX)** — the thesis-fit a16z program (NOT Speedrun, which is
  a16z Games/gaming). $500K/7%, ~12wk in-person, ~3% acceptance, technical-crypto-depth
  focused. Next window unconfirmed — check apply.a16zcrypto.com; treat as opportunistic third.

**Founder narrative to lead with:** a 22-yo technical founder who *alone* shipped a working
AI cross-border AP product settling USDC on Solana, and won a Solana Foundation grant before
writing a pitch deck — solo by choice (high cofounder bar), building exactly the category YC
is pushing, on the rail YC now uses. Lead with the *sequence of facts*, not adjectives.

**Recommended calendar:** YC F26 first (time-critical, best tailwind), SPC ~simultaneously
(low-friction, narrative-forgiving), CSX when its next window opens.

## 4. Contractor-paying segments — RANKED (SOLID, clean re-run, 21 tool calls)

Ranked by pain × stablecoin fit × reachability-for-a-cold-solo-founder:

**#1 — Digital/marketing/dev agencies with offshore teams.** Sharpest sub-segment: US
dev/design agencies (5–30 people) with a retained offshore team in Philippines / India /
Eastern Europe, paying 5–20 contractors monthly via Wise/Payoneer/PayPal, reconciling into
QuickBooks by hand. Why #1: (a) concentrated named buyer (agency owner/ops lead, not HR),
(b) recurring not one-off volume ($5k–50k/mo offshore payroll), (c) reachable — dense paid
Slack communities where vendor recommendations are traded (Grow Your Agency $35 lifetime;
Online Geniuses 53k+ members) + Clutch.co directory for cold outreach, (d) provable savings
(PayPal ~4.4% + 3–4% FX; Payoneer up to 2%; vs USDC ~$1.50 flat sub-hour). Real trust pain:
agencies force one payout rail (Payoneer) and freelancers suspect kickbacks.

**#2 — Remote-first startups paying international contractors.** Same corridor logic
(Argentina/Nigeria/Pakistan). Pain: Deel/Remote fee opacity (0.6–2% FX never itemized) +
per-seat tax ($29–49/mo/contractor) for teams that need a payment rail, not EOR compliance.
Reachable via YC jobs board / topstartups.io, but founders convert noisier than agency owners.

**#3 — Media/content/localization with global freelancers.** High but fragmented pain
(many tiny many-country payments); two-sided adoption problem (must convince many individual
freelancers). Hardest to reach cold (GALA, ProZ).

**Demand-side validation:** Deel added USDC payouts (via BVNK, ~$1.50 flat, sub-hour) in
2024; Upwork 2025; Fiverr early 2026 — contractor-side USDC demand is already proven in our
target corridors. (Caveat: several adoption claims came from stablecoin-vendor content —
eco.com/wayex — flagged for independent verification, not settled fact.)

**First-10-customers motion (for #1):** join the agency Slack communities as research not
pitch → build a 50–100 target list via Clutch.co filtered to offshore-delivery agencies →
cold outreach leading with the quantified pain ("your Payoneer/PayPal is 3–5%, contractors
shorted on FX, bookkeeper matching payouts by hand") → offer a free before/after cost
comparison on their real last-month data → recruit 5–10 design partners with fee-free 90 days
for a case study → expand peer-to-peer inside the same communities.

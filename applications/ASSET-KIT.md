# Decimal — Application Asset Kit

Canonical answers, written once, reused everywhere. Every program below adapts from these. Claims
are gated by `CLAIMS-LEDGER.md`; positioning follows `landing-redesign/POSITIONING-CORRECTED.md`.
Plain voice, no em-dashes in final copy, no crypto jargon to a business buyer (accelerators excepted).

> **The shipped story ends at the books, not at a payment.** Capture → code → approve → fraud-gate →
> QuickBooks sync is real and demoable. Cross-border vendor payment is the roadmap. Never present the
> old USDC/Squads code as a shipped settlement rail.

---

## 1. One-liner (three lengths)

**One line (what we make):**
> Decimal is AI-powered accounts payable software for businesses that pay vendors, locally and globally.

**50 words:**
> Decimal is AI-native accounts payable software. It reads every invoice, codes it to your books,
> and runs it through an approval flow you design and a fraud gate that catches vendor-account
> takeover, then syncs two ways with QuickBooks. It is built to pay vendors across borders as
> cheaply and fast as domestic ones.

**150 words:**
> Businesses that pay vendors still type invoices, code them to the books by hand, chase approvals
> across email and Slack, and reconcile manually. When those vendors are overseas, the payment
> itself is slow and expensive: bank wires that take days at up to ~15% all-in, or fintech apps that
> mark up the exchange rate through correspondent banks. No single tool does the AP work well and
> pays the vendor well.
>
> Decimal is one AI-native product that does both. A vision model extracts each invoice; an agent
> codes it to the right GL account and learns each vendor; you design the approval flow (cost-center
> hierarchies, tiered spend authority, delegation) and it is enforced, not advisory; a fraud gate
> holds any new or look-alike payout address before money can move; and everything syncs two ways
> with QuickBooks. The roadmap: settle cross-border vendor payments fast, with transparent FX, in an
> account only the customer controls.

---

## 2. Why now

Three things turned in 2025 and 2026:

- **The settlement rail became real.** B2B stablecoin payment volume hit ~$226B in 2025, up 733% year
  over year; Visa is settling billions in USDC; Stripe's Bridge got a bank charter. Dollars can now
  move across borders in minutes at a fraction of a percent.
- **The law caught up.** The GENIUS Act (July 18, 2025) gave payment stablecoins federal legal
  standing, 100% reserve rules, and redemption rights.
- **AP is finally automatable.** Vision models and agents can now do the judgment work AP software
  never could: read a messy invoice, code it, and resolve the exception, rather than just routing it.

Nobody has combined all of it: an agent that *resolves* AP exceptions, ERP-native sync with no
reconciliation lag, fast transparent cross-border settlement, and self-custodial control. That is the
open lane. (Accelerator beat: YC funds its companies in USDC on Solana and its RFS explicitly asks for
cross-border stablecoin payments. We are building exactly that.)

---

## 3. Traction (the working product, honest)

A solo technical founder has shipped the AP core end to end:

- **Invoice capture + AI extraction** — a PDF/image or CSV becomes structured payment orders via a
  vision model.
- **AI GL coding** — an agent codes each bill to the right account and learns each vendor's coding.
- **A build-your-own approval engine** — cost-center hierarchies, seats, tiered spend authority,
  delegation, and policy toggles; enforced by the system, not advisory. This is the strongest
  demoable feature.
- **A fraud review gate** — a new or changed payout address for a known vendor (account-takeover / BEC
  signal), or a near-duplicate look-alike address, is held for human review before any money can move.
- **Two-way QuickBooks sync** — a settled payment posts an idempotent Bill + BillPayment to the org's
  chart of accounts; idempotent at two layers so nothing double-posts.
- **A $10,000 grant from Solana Foundation × Superteam** — backing this project. (The relationship is
  also a warm asset for ecosystem intros.)

No usage or revenue metrics are claimed; the product is pre-launch, and no test-result numbers are
cited. The traction is the working product, the $10k Solana Foundation × Superteam grant, and the pace
of a single builder.

---

## 4. Market / customers

**The buyer:** mid-market businesses that are AP-heavy (many vendors, high invoice volume) and are
outgrowing BILL / Ramp / manual / Tipalti, on a modern-enough ERP (QuickBooks / NetSuite / Sage
Intacct). Two shapes of the *same* customer (internal lens, never pitched as two products):

- **AP-heavy, complex orgs** — construction, healthcare, manufacturing, distribution, real estate;
  drowning in invoices and approval chaos. Value: AI removes the manual hours and tames approvals.
- **Global vendor payers** — importers and businesses paying overseas suppliers; the rail replaces
  slow, expensive international transfers. Value: cheaper, faster, transparent cross-border payment.

Most real businesses are some of both. First design partners: import-heavy mid-market on QBO/NetSuite
paying many overseas suppliers, reachable through a Controller or founder (not an 18-month enterprise
sale).

**The gap we fill:** enterprise suites (Coupa/Ariba) are slow and rule-based; mid-market ERP-native
tools (Ramp/BILL/Stampli) are fast but shallow with weak or no global payout; Tipalti has real global
reach but sits outside the ERP, so reconciliation lags and FX is opaque and multi-day; new AI-native
entrants are all on traditional bank rails. Decimal is the one product that is AI-native + ERP-native
+ fast transparent cross-border + self-custodial.

Market facts (approved): World Bank ~15% bank cost on cross-border; 2.5–5% typical wire markup;
GENIUS Act (Jul 2025); ~$226B B2B stablecoin volume in 2025 (+733% YoY).

---

## 5. Why me / solo

A 22-year-old technical founder who, alone, shipped a working AI-native AP product — capture, coding,
a real approval engine, a fraud gate, and two-way QuickBooks sync — and earned Solana ecosystem grants
before writing a deck. Solo by choice: the bar for a co-founder is high, and nothing so far has needed
to wait for one. Framing: a chosen high bar and resourcefulness, not a gap. Building the exact category
YC is asking founders to build.

---

## 6. The payments narrative (roadmap, not shipped)

Be precise here. What is shipped is the AP workflow that ends at the books, and a **self-custodial
treasury built on Squads multisig** — the money already sits in an account only the customer controls.
What is next, and what the whole product is aimed at, is **paying the vendor across borders**: fast,
transparent-FX settlement out of that self-custodial treasury.

The concrete piece still to solve is the **payout rail: integrating Bridge (Stripe's stablecoin
infrastructure) for the fiat off-ramp and FX**, plus the fee/spread model and reconciliation back into
the ledger. That is the next build. For applications: state the Squads self-custody as real, and sell
cross-border payment as the roadmap the shipped AP product leads into. **Never claim cross-border
payments work today.**

The control story is the durable differentiator: **your money stays in an account only you control,
and the automation runs inside rules that cannot be flipped by us or an insider.**

---

## 7. The ask / use of funds

Raising to (1) build the cross-border payout rail (integrating Bridge for off-ramp and FX), and (2) land the first
paid design partners among import-heavy mid-market AP teams. Accelerator capital + network is the
fastest path to both: warm intros to mid-market Controllers/AP leads, and the credibility to sign
paid design partnerships rather than free pilots. Use of funds: founding engineering hires for the
payments build, design-partner onboarding, and compliance groundwork for the payout rail.

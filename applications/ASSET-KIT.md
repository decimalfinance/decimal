# Decimal — Application Asset Kit

Canonical answers, written once, reused everywhere. Every program adapts from these. Claims are gated
by `CLAIMS-LEDGER.md`. Plain voice, no em-dashes, no crypto jargon to a business buyer (accelerator
audiences are the exception, they want the rail named).

> **Honesty boundary.** The AP work is built and demoable, and the self-custodial treasury (Squads
> multisig) that holds the funds is real. Paying vendors *out of it* across borders is the roadmap: the
> next build is the payment processor plus Bridge for the fiat off-ramp and FX, targeted mid-September,
> gated on the legal setup. Never claim cross-border payments work today.

---

## The spine: Decimal does the work of an AP clerk

Every business that pays vendors hires an **AP clerk** (around **$50k/year**) to run accounts payable:
gathering the context on each bill, coding it, routing it for approval, chasing sign-offs, and sorting
out exceptions. Modern tools automate the data entry, but a person still does the real work. **Decimal
does that clerk's work with AI.** Two flexes:

- **AI-native, saves time.** Decimal automates the clerk's work and puts everything in one view so an
  approver clears a bill in a few clicks. Incumbents bolt an AI layer on top and still make you click
  through screens to piece the context together. We are built around the model, so we do not just show
  the bill, we recommend the decision.
- **Self-custodial global stablecoin account, saves money.** Businesses pay vendors anywhere in the
  world at a fraction of the ~6% banks charge, and the money stays in an account only they control.

AI is table stakes (every incumbent ships some). The durable differentiator is the **self-custodial
global account**: nobody else hands a business a global account it fully controls and pays vendors from.

---

## 1. One-liner (three lengths)

**One line:**
> Decimal is AI-native accounts payable software: it does the work of an AP clerk and pays vendors
> globally from a self-custodial stablecoin account.

**50 words:**
> Decimal is AI-native accounts payable software. It does the work businesses hire an AP clerk for:
> reading each bill, coding it, and running approvals. And it comes with a self-custodial, global
> stablecoin account, so businesses pay vendors anywhere in the world at a fraction of what banks charge,
> from money only they control.

**150 words:**
> Every business that pays vendors hires an AP clerk to run accounts payable: reading each bill, coding
> it to the books, routing it for approval, chasing sign-offs, and sorting out exceptions. Modern tools
> automate the data entry, but a person still does the real work, and when the vendor is overseas the
> payment is slow and banks take up to 6%.
>
> Decimal does that work with AI. It reads each bill, codes it, and puts everything in one view so an
> approver clears it in a few clicks: it recommends the decision instead of just showing documents. And
> it comes with a self-custodial, global stablecoin account, so a business pays vendors anywhere in the
> world at a fraction of bank cost, from an account only it controls. The AP core is built; the
> cross-border payout, over Bridge, is the next build.

---

## 2. Why now

- **The rail became real.** B2B stablecoin payment volume hit ~$226B in 2025, up 733% year over year;
  Visa settles billions in USDC; Stripe's Bridge is the infrastructure. Cross-border dollars now move in
  minutes at a fraction of a percent.
- **The law caught up.** The GENIUS Act (July 18, 2025) gave payment stablecoins federal legal standing,
  100% reserves, and redemption rights.
- **AP is finally automatable.** Vision models and agents can now do the AP clerk's judgment work: read
  a messy bill, code it, and resolve the exception, not just route it.

The open lane: an AI that does the clerk's job *and* a self-custodial global account that pays the
vendor. (Accelerator beat: YC's RFS explicitly asks for cross-border stablecoin payments and funds its
companies in USDC. We are building exactly that.)

---

## 3. Traction (honest)

A solo technical founder, full-time, has shipped the AP core end to end:

- **Invoice capture + AI extraction** (vision model into structured orders).
- **AI GL coding** that learns each vendor (rules + vendor memory + model).
- **A build-your-own approval engine**: cost-center hierarchies, seats, tiered authority, delegation,
  enforced by the system, not advisory.
- **A fraud review gate**: a new or look-alike vendor payout address is held for review before money
  can move.
- **Two-way QuickBooks sync**, idempotent at two layers.
- **A self-custodial Squads treasury** holding the funds.
- **A $10,000 grant from the Solana Foundation × Superteam.**

Pre-launch: no usage or revenue claimed. The payment processor and cross-border payout (over Bridge) are
the next build, targeted mid-September after the legal setup. Traction is the working product, the grant,
and the pace of a single builder.

---

## 4. Market, competition, and money

**Competitors:** Bill.com, Stampli, Tipalti (Ramp for domestic AP). The line: **"Bill.com shows you
documents; Decimal recommends the decision."** Accounts payable is a decision problem, not data entry.

**The structural edge:** Decimal is **non-custodial**, so we never hold or move the money, only the
business can. This skips much of the money-transmitter licensing Bill.com is built around, and lets us
settle natively on stablecoin rails. The incumbents are all on traditional bank rails.

**How we make money:**
- A subscription for the software.
- A fee on each payment.
- A spread on the currency conversion when a payment goes cross-border (the highest-margin line).

Banks charge around 6% on cross-border; our rail cost is a fraction (Bridge is roughly 10bps plus the
payout leg), so we price well under 1%, undercut every bank, and still hold a healthy margin.

**How big:** cross-border payments for mid-market businesses are a roughly **$160 billion revenue
market**. Capturing even 1% of it is **$1.6 billion in annual revenue**. The stablecoin slice is early
and growing fast (business stablecoin cross-border is projected to grow from ~$13B today toward the
trillions by 2035).

**The buyer:** mid-market AP-heavy businesses on QuickBooks / NetSuite, especially those paying overseas
vendors, reachable through a Controller or founder, not an 18-month enterprise sale.

---

## 5. Why me / solo

A 22-year-old technical founder who, alone and full-time, shipped a working AI-native AP product (capture,
coding, a real approval engine, a fraud gate, and two-way QuickBooks sync) and earned a Solana ecosystem
grant before writing a deck. Solo by choice, with a high bar for a cofounder, open to the right person,
not blocking on one. Building the exact category YC is asking founders to build.

---

## 6. The payments narrative (roadmap, honest)

The second pillar is a **self-custodial, global stablecoin account**: a concrete account the business
gets and controls, and pays vendors from. This is the catch, nobody else hands a business a global
account it fully controls. It is also the honest frame: **the account (Squads treasury) is real and
holds the money today; paying vendors out of it, across borders, is the roadmap.**

The concrete piece to build is the **payment processor plus Bridge (Stripe's stablecoin infrastructure)
for the fiat off-ramp and FX**, plus the fee/spread model and reconciliation back to the ledger.
Targeted mid-September, gated on the legal setup. Never claim cross-border payments work today. The
durable differentiator is control: **your money stays in an account only you control, and the automation
runs inside rules that cannot be flipped by us or an insider.**

---

## 7. The ask / use of funds

Raising to (1) build the cross-border payout rail (the payment processor plus Bridge for off-ramp and
FX), and (2) land the first paid design partners among mid-market AP teams paying overseas vendors.
Accelerator capital and network is the fastest path to both. Use of funds: founding engineering for the
payments build, design-partner onboarding, and compliance groundwork for the payout rail.

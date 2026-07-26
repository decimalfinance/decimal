# YC Fall 2026 — application (assembled)

**Deadline:** Mon Jul 27, 2026, 8:00pm PT — **TODAY.**
**Method:** Zaid writes every answer in his own voice; AI only checks (truth vs `CLAIMS-LEDGER.md`,
precision, story-beat). ✅ = locked this week. ⟨PENDING⟩ = still to do.

## Still to fill before submit
- ⟨PENDING⟩ 50-char company description (candidate below — confirm)
- ⟨PENDING⟩ "What is your company going to make?" (plain product description — draft below, make it yours)
- ⟨PENDING⟩ Q1 Idea: "Why this idea? / expertise / how you know people need it" (drafted earlier — paste final)
- ⟨PENDING⟩ Company URL (landing), Demo video + product login
- ⟨PENDING⟩ Equity numbers: cash in bank, monthly spend, runway
- ⟨PENDING⟩ Founder video (do last — follow YC's public guidelines exactly)

---

## Founders

**Who writes code / other technical work? Any of it by a non-founder?** ✅
> I do. I built the entire product end to end myself, and no non-founder has done any technical work on it.

**Are you looking for a cofounder?** ✅
> Not actively, but open to the right person.

---

## Founder Video ⟨PENDING — do last⟩
One minute, founder only, look at the camera, talk like a person. 60s arc: who you are + a line of
credibility → what Decimal is in one sentence → why you're the person to build it. Not a product demo.

---

## Company

**Company name:** Decimal

**Describe what your company does in 50 characters or less.** ⟨PENDING — confirm⟩
> AI accounts payable that pays vendors worldwide  *(47 chars)*

**Company URL:** ⟨PENDING⟩
**Demo (≤3 min) + product link + login:** ⟨PENDING⟩

**What is your company going to make?** ⟨PENDING — plain product description, make it yours⟩
> Decimal is AI-native accounts payable software. AI does the manual work of paying vendor bills:
> reading each invoice, coding it, and running it through the approvals you set. It comes with a
> self-custodial global USDC account, so a business can pay its vendors anywhere in the world from an
> account only it controls, without the slow, expensive bank wires cross-border payments take today.

**Where do you live now, and where would the company be based after YC?** ✅
> Hyderabad, India / San Francisco, USA

**Explain your decision regarding location.** ✅
> We have to be in the US: India has no regulatory clarity for stablecoin payments, but the US does with
> the GENIUS Act. In the US, we would want to be in SF, where our chances of building a billion-dollar
> stablecoin payments company are highest.

---

## Progress

**How far along are you?** ✅
> The core AP product is done and working. AI assistance is in progress, and Bridge integration for
> payments comes after the legal setup.

**How long have you been working on this? How much full-time?** ✅
> Full-time since mid-April 2026: started at Colosseum on a different idea, converged on accounts payable
> in June, and have been building the core since.

**What tech stack are you using, or planning to use? Include AI models and AI coding tools.** ✅
> Tech Stack:
> - Invoice OCR: OpenAI GPT-4o mini (vision)
> - GL coding: GPT-4o mini
> - Decimal agent: Claude Sonnet 5
> - Backend: Node, Express, TypeScript
> - Database: PostgreSQL, Prisma
> - Frontend: React, Vite, TanStack Query
> - Treasury: Squads Multisig v4 protocol on Solana
> - Payment Rails: Bridge.xyz
> - Payment Processor: Rust
>
> What I use to build the product:
> - Frontend and Design: Claude Design (Fable 5 for design and implementation)
> - Planning and Development: Claude Code (Opus 4.8 and Fable 5)
> - Research: Opus 4.8 as orchestrator and Sonnet 5 for agents

**Are people using your product?** ✅ No.
**When will you have a version people can use?** ✅
> Mid-September. The main gate is access to Bridge's payment rails and the legal setup so we can build
> the payment processor, not the rest of the software.

**Do you have revenue?** ✅ No.

**Have you applied with this idea before / did you pivot?** ✅
> First time applying. No prior batch. (The direction converged from a different idea at Colosseum into
> accounts payable in June.)

**Any incubator / accelerator / pre-accelerator joined or committed to?** ✅ No.

---

## Idea

**Q1 — Why this idea? Domain expertise? How do you know people need it?** ⟨PENDING — paste final⟩

**Q2 — Who are your competitors? What do you understand that they don't?** ✅
> Our competitors are Bill.com, Stampli, and Tipalti.
>
> Accounts payable is a decision problem, not data entry. Every bill is a call to approve, reject, or
> escalate. Even the latest tools automate parts of the process, but to understand a single bill you
> still click through a few screens to piece the context together. As Decimal is AI-native, we provide
> all the required information in one view, eliminating the time spent gathering context to make the
> decision.
>
> Decimal is non-custodial, so we never hold or move the money, only the business can. This skips much
> of the money-transmitter licensing Bill.com is built around, and lets us settle natively on stablecoin
> rails.

**Q3 — How do or will you make money? How much could you make?** ✅
> We make money three ways:
> - A subscription for the software.
> - A fee on each payment.
> - A spread on the currency conversion when a payment goes cross-border.
>
> Banks charge around 6% on cross-border. Stablecoin rails cost a fraction of that, so we can price well
> under 1%, undercut every bank, and still hold a healthy margin.
>
> Cross-border payments for mid-market businesses are a roughly $160 billion revenue market. Capturing
> even 1% of it is $1.6 billion in annual revenue, and 0.1% is $160 million. The lane we are built for,
> cross-border business payments on stablecoin rails, goes from $13 billion this year to a projected $5
> trillion by 2035.

**Q4 — Other ideas you considered applying with.** ✅
> - A global USDC account for businesses: a self-custodial account a business holds and controls, to
>   send and receive money anywhere.
> - A global payments API: the same cross-border stablecoin rail exposed for other companies to build
>   payments on.
>
> Both are directions Decimal naturally grows into. We chose accounts payable as the way in, because it
> is the concrete, recurring need that gets a business onto the account in the first place.

---

## Equity

**Have you formed any legal entity yet?** ✅ No.
**Planned ownership breakdown:** ✅ Zaid — 100%, Founder / CEO.
**Have you taken any investment?** ✅ No (the Solana Foundation × Superteam support is a non-dilutive grant).
**Total raised from investors (USD):** ✅ $0. (Note: $10,000 non-dilutive grant from Solana Foundation × Superteam.)
**Cash in bank now:** ⟨PENDING⟩
**Monthly spend:** ⟨PENDING⟩
**Runway:** ⟨PENDING⟩
**Currently fundraising?** ✅ No.

---

## Curious

**What convinced you to apply to YC? Did someone encourage you? Been to any YC events?** ✅
> YC is the fastest path to building this into a billion-dollar company. With so much stablecoin payment
> innovation happening in SF, being close to it lets us accelerate growth and find product-market fit
> faster. No one encouraged me to apply, and I haven't been to any YC events.

---

## Batch Preference
**Which batch?** ✅ Fall 2026.

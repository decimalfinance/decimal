# YC Fall 2026 — application (final, as entered in the form)

**Deadline:** Mon Jul 27, 2026, 8:00pm PT.
**Status:** All written answers entered in the YC form. **Only outstanding item: the 1-minute founder
video** (recording now). Equity radios set to No / No / No.

---

## Founders

**Who writes code, or does other technical work? Any of it by a non-founder?**
> I write and have written all the code.

**Are you looking for a cofounder?**
> Not actively, but open to the right person

---

## Founder Video
⟨Recording now — one minute, founder only, ≤100 MB.⟩

---

## Company

**Company name:** Decimal

**Describe what your company does in 50 characters or less.**
> AI accounts payable for global vendor payments

**Company URL:** https://decimal.finance

**Demo (≤3 min):** ⟨optional — none attached⟩
**Product link + login:** ⟨none⟩

**What is your company going to make? Please describe your product and what it does or will do.**
> Decimal is AI-native accounts payable software. It does the work an accounts payable clerk normally
> does: it reads each vendor bill a business sends in, codes it to the right account, prepares the
> approval with the context the approver needs, and once approved, pays the vendor anywhere in the world
> over stablecoin rails. It comes with a self-custodial global USDC account, so the money moves from an
> account only the business controls, saving the high fees banks charge on international payments.

**Where do you live now, and where would the company be based after YC?**
> Hyderabad, India / San Francisco, USA

**Explain your decision regarding location.**
> We have to be in the US, India has no regulatory clarity for stablecoin payments, but the US does with
> the GENIUS Act. In the USA, we would want to be in SF as our chances of building a billion dollar
> stablecoin payments company are the highest there.

---

## Progress

**How far along are you?**
> The core AP product is done and working. AI assistance is in progress, and Bridge integration for
> payments comes after the legal setup. We've also been awarded a $10k grant from the Solana Foundation.

**How long have you been working on this? How much full-time?**
> Since June, full-time.

**What tech stack are you using, or planning to use? Include AI models and AI coding tools.**
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

**Are people using your product?** No.

**When will you have a version people can use?**
> Mid September. The main gate is access to Bridge's payment rails and the legal setup, to build the
> payment processor.

**Do you have revenue?** No.

**Same idea as a previous batch / did you pivot?**
> Applying for the first time.

**Any incubator / accelerator / pre-accelerator joined or committed to?**
> No.

---

## Idea

**Why did you pick this idea? Domain expertise? How do you know people need it?**
> Out of curiosity, I started reverse-engineering how Bridge built its global payment rails, and the real
> bottleneck turned out not to be moving the money. It was all the manual work a business has to do before
> a payment can even happen, the reading, coding, and chasing of every bill. Very few products use AI and
> stablecoin rails together to fix that. Expense management and corporate cards are crowded, but accounts
> payable is still primitive and neglected, so I decided to build Decimal.
> AP software is a proven necessity. Businesses already spend billions on it, and Decimal saves them both
> time and money.

**Who are your competitors? What do you understand that they don't?**
> Our competitors are Bill.com, Stampli, Tipalti.
> Accounts payable is a decision problem, not data entry. Every bill is a call to approve, reject or
> escalate. Even the latest tools automate parts of the process, but to understand a single bill you
> still click through a few screens to piece the context together. Bill.com shows you documents; Decimal
> is AI-native, so it puts everything in one view and recommends the decision.
> Decimal is non custodial, so we never hold or move the money, only the business can. This skips much
> of the money transmitter licensing Bill.com is built around, and lets us settle natively on stablecoin
> rails.

**How do or will you make money? How much could you make?**
> We make money three ways:
> - A subscription for the software.
> - A fee on each payment.
> - A spread on the currency conversion when a payment goes cross-border.
>
> Banks charge around 6% on cross-border. Stablecoin rails cost a fraction of that, so we can price well
> under 1%, undercut every bank, and still hold a healthy margin.
>
> Cross-border payments for mid market businesses are a roughly $160 billion revenue market. Capturing
> even 1% of it is $1.6 billion in annual revenue.

**Other ideas you considered applying with.**
> - Global USDC accounts for businesses
> - Global payments API

---

## Equity

**Have you formed any legal entity yet?** No.
**Planned ownership breakdown:** Zaid, CEO: 100%.
**Have you taken any investment yet?** No.
**Are you currently fundraising?** No.

---

## Curious

**What convinced you to apply to YC? Did someone encourage you? Been to any YC events?**
> YC is the fastest path to building this into a billion-dollar company. With so much stablecoin payment
> innovation happening in SF, being close to it lets us accelerate growth and find product-market fit
> faster.
> No one encouraged me to apply, and I haven't been to any YC events.

**How did you hear about Y Combinator?**
> The internet.

---

## Batch Preference
**Which batch?** Fall 2026.

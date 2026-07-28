# Applications — one-week blitz kit (Jul 22–28, 2026)

This folder is the working kit for Decimal's accelerator + funding blitz. The week is applications
and outreach only; product work is frozen. The strategy: every program asks the same ~8 questions, so
we answer them **once** in `ASSET-KIT.md`, then adapt per program. YC's form is the superset.

## The core rule

**The spine: Decimal does the work of an AP clerk.** Every business hires an AP clerk (~$50k/year) to
run accounts payable: gathering context on each bill, coding it, routing approvals, chasing sign-offs,
sorting exceptions. Decimal does that with AI. Two flexes: **AI-native (saves time)** — one view,
recommends the decision, not just shows documents; and a **self-custodial global stablecoin account
(saves money)** — pay vendors anywhere at a fraction of the ~6% banks charge, from money only the
business controls.

**Sell the vision, never fabricate live proof.** The shipped, demoable story is **capture → AI
extraction → AI GL coding → build-your-own approval engine → vendor fraud gate → two-way QuickBooks
sync,** with a **self-custodial treasury on Squads multisig** holding the funds (real). Cross-border
vendor payout is the **roadmap**: the payment processor plus **Bridge for the fiat off-ramp and FX**,
targeted mid-September after the legal setup. Never present cross-border settlement as working today.
Every claim is gated by `CLAIMS-LEDGER.md`.

## Files

| File | What it is |
|---|---|
| `CLAIMS-LEDGER.md` | **Read first.** What's safe to claim (with code proof) vs. what's off-limits. The guardrail. |
| `ASSET-KIT.md` | Canonical reusable answers: the AP-clerk spine + two flexes, one-liner/50w/150w, why-now, traction, market/competition/money, why-me, payments-roadmap, the ask. |
| `yc-fall-2026.md` | Full YC answer draft + 1-min founder video script. The pin (deadline Jul 27). |
| `programs/*.md` | Per-program tailoring deltas (which kit answers to lift + the program-specific angle). |
| `outreach.md` | ≥8 personalized DM/email drafts; I draft, Zaid sends; reply tracking. |
| `tracker.md` | Every program: deadline, terms, status, owner, notes, verify/skip flags. |

## How to use it

1. Refine `ASSET-KIT.md` with Zaid until every canonical answer is his voice.
2. Finalize `yc-fall-2026.md`, shoot the 1-min video, **submit by Sun Jul 26**.
3. Fan the kit into the rolling quick-wins (each `programs/*.md` is a short tailoring pass, not a rewrite).
4. Send outreach (Superteam warm intro first), log replies in `outreach.md` + `tracker.md`.
5. Keep `tracker.md` current; verify the flagged ambiguous deadlines before relying on them.

## Deferred to next week (captured, not lost — NOT this week's scope)

- **The cross-border payout rail.** The self-custodial Squads treasury is in place; the next build is
  **integrating Bridge (Stripe's stablecoin infra) for the fiat off-ramp and FX**, plus the fee/spread
  model and reconciliation back to the ledger. Not sold as near-shipped in any application.
- **Pending intake:** Zaid's additional accelerator links from Twitter → slot into `tracker.md`.

## Open items needing Zaid

- **Grant:** stated as a **$10,000 grant from Solana Foundation × Superteam**. (Internal: $3k of the
  $10k disbursed; applications just say "$10k grant." The Solana Foundation program itself is the place
  to claim the remaining tranche.)
- **Entity:** no legal entity yet, by decision. Committed to a Delaware C-corp, but **holding** until it
  can be formed from the US — doing it from India adds legal friction. Will fund incorporation partly
  from grant money. AI Grant stays blocked until then; nothing else this sprint requires an entity.
- ⟨Confirm current location + relocation willingness for HF0/SF-based programs.⟩

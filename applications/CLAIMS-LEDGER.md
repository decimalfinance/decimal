# Claims Ledger — what we may say, and what we may not

This is the guardrail for every application answer and every outreach message. Before a claim goes
into a draft, it must appear on the **safe to say** side of this ledger, or be a marked placeholder
awaiting Zaid's confirmation. Grounded against the codebase on 2026-07-22.

House rule (from `landing-redesign/POSITIONING-CORRECTED.md`): **product vision is fine to sell;
fabricated present-tense evidence is not.** No invented metrics, user counts, logos, or testimonials.
No demo that pretends an unbuilt step ran live.

---

## Shipped — safe to claim as real, demoable today

| Capability | Safe sentence | Code proof |
|---|---|---|
| Invoice capture + AI extraction | "Upload a PDF/image or CSV; a vision model extracts the invoice into structured payment orders." | `api/src/payments/document-extract.ts`, `invoice-intake.ts`, `csv-intake.ts` |
| AI GL coding | "An agent codes each bill to the right GL account and learns each vendor's coding over time." | `api/src/accounting/gl-coding.ts`, `ocr-coding.ts`, `default-chart.ts` |
| Build-your-own approval engine + Policies | "Design your own approval flow: cost-center hierarchies, seats, tiered spend authority, delegation, and policy toggles — enforced, not advisory." | `api/src/approvals/*`, `tests/approval-engine.test.ts` (cost-center tree + tiered grants + delegation fixtures) |
| Fraud review gate (BEC + look-alike) | "Before anything can be paid, a new/changed payout address for a known vendor, or a near-duplicate look-alike address, is held for human review." | `system_explained/01-current-product.md` (review gate); `api/src/counterparty-wallets.ts` (trust states) |
| QuickBooks two-way sync | "A settled payment posts an idempotent Bill + BillPayment to the org's chart of accounts; the chart syncs back in. Idempotent at two layers." (No test-result numbers.) | `api/src/accounting/sync.ts` (`syncPaymentToQuickBooks`, `requestid`), `account-sync.ts` (per-order push + sweep, unique `accounting_syncs` row) |
| Self-custodial treasury (Squads multisig) | "Funds sit in a self-custodial Squads multisig only the customer controls." Do NOT stretch this into "we pay / settle cross-border." | `api/src/squads/treasury.ts` |
| Solo technical founder shipping fast | "A solo technical founder built the above end-to-end." | (founder-attested; consistent with the codebase) |
| Solana Foundation × Superteam grant | "Backed by a $10,000 grant from Solana Foundation × Superteam." (Applications don't need the disbursed-vs-pending split.) | founder-attested |

The shipped arc is: **capture → code → approve → fraud-gate → sync to the books,** with a
self-custodial Squads treasury holding the funds. It ends at the ledger, not at a payment.

---

## Do NOT claim — cross-border payments is roadmap

| Do not say | Why | What to say instead |
|---|---|---|
| "We settle vendor payments in USDC on Solana today." | Squads multisig holds the treasury (self-custody is real), but there is **no working cross-border payout**. The missing piece is integrating **Bridge** for the fiat off-ramp / FX. | "Self-custodial treasury via Squads multisig is in place; fast, transparent cross-border payout, via Bridge, is the roadmap we're building next." |
| "Shipped cross-border product settling in USDC." | Payout rail (Bridge integration, FX, off-ramp, reconciliation) is not built. Same guidance in `POSITIONING-CORRECTED.md`. | Present cross-border payment as the vision the shipped AP product leads into. |
| "Live on mainnet." | No live cross-border settlement in production. | Omit; the shipped story doesn't need it. |
| Any bill/mismatch/sandbox count or test-result proof | That validation (e.g. "621 bills / 0 mismatches / 12 sandboxes") was done in a **different repo** and is not being cited. | Describe QBO two-way sync as a built capability, with no numbers and no test-result claim. |
| "$33T stablecoin volume > Visa + Mastercard" | Inflated figure, flagged in every positioning doc. | Use the approved market figures below. |
| Invented users / revenue / logos / testimonials | Pre-launch; none exist. | Traction = the working product + the Solana Foundation grant + founder, not usage metrics. |
| "We're incorporated" / any entity-based eligibility | **No legal entity is formed yet.** Programs needing a Delaware C-corp (e.g. AI Grant) are blocked until one exists. | State the entity as not-yet-formed; flag such programs as blocked. |

---

## Approved market figures (cite only these)

**Cross-border cost / take rate (CORRECTED 2026-07-25 — the old "~15%" was wrong and is checkable):**
- **Banks charge ~6.3% on cross-border payments** (World Bank, global average cost ~6.36% Q3 2025; banks
  higher, ~12% on small remittances). **Do NOT say ~15%.** B2B wire markup commonly **2.5–5%**.
- **Wise (the efficient incumbent) blends ~0.52%** and is compressing on purpose (was 0.58%), and holds
  **under 1% of business cross-border.** Do not model a fat, permanent FX spread; the honest story is "we
  undercut bank rails and still profit."
- **Our own rail economics (Bridge, 2026-07-25) — do NOT overclaim "cost ~0.1%":** the ~10bps figure is
  only Bridge's *conversion fee at top volume tier*, not all-in. All-in cost = conversion + network fee +
  the payout/offramp leg (ACH near-free, SWIFT $15–30/wire, SEPA/local rails cheaper), and **the offramp
  leg dominates at ~30–100bps.** Bridge sets the platform's take via API (`fee_percent`/`minimum_fee`/
  `maximum_fee` per rail); **no public rate card — confirm via sales** (competitors cite a "1% ceiling" vs
  10bps-at-scale; unresolved). **Realistic holdable spread ≈ 40–90bps.** So in copy say "a fraction of the
  bank's ~6%, healthy margin" — NOT "our cost is ~0.1%" and NOT "we keep most of a sub-1% charge."

**Market size — sizing "how much could you make" (bottoms-up, use REVENUE pool not volume):**
- **Cross-border B2B payments = ~$154–161B in annual REVENUE** (triangulated: ~$154B from "B2B = 80% of
  $193B cross-border revenue pool"; ~$161B from Corpay's own investor deck, which concedes <1% share).
  Lead with this. **Do NOT cite cross-border B2B *volume* in trillions — unreconcilable across sources
  (20%–95% of flow depending on methodology) and attackable.**
- Global B2B payments (volume, ceiling context): **$83T (2024) → $124T (2028)** (Juniper, one methodology).
- Per-customer ACV, mid-market AP-with-payments: **~$45K/yr** (AvidXchange ~$52K, Tipalti ~$40K; bracketed
  by Ramp ~$20K SMB below and Coupa ~$400K enterprise above).
- AP automation software TAM (context only, de-emphasize): ~$6B (2026) → ~$14B by ~2031 (Mordor); analyst
  estimates span $3.4B–$18B, which is itself the reason not to lead with it.
- No credible global mid-market business count exists; US = ~200,000 (Nat'l Center for the Middle Market).
  If a global figure is needed, flag it as an estimate (US ≈ 25% of global GDP → order-of-magnitude ~800K).

**Stablecoin / regulatory:**
- **GENIUS Act** — signed **July 18, 2025** (Public Law 119-27): federal payment-stablecoin definition,
  100% reserves, par redemption, holder bankruptcy priority.
- **Cross-border B2B stablecoin volume: $13.4B (2026) → projected $5T by 2035** (Juniper, Apr 27 2026;
  85% of all stablecoin transaction value expected to be B2B by 2035). The sharpest growth stat.
- **B2B stablecoin payment volume ~$226B in 2025 (+733% YoY)** (McKinsey/Artemis).
- Optional: Visa ~$7B annualized USDC settlement run-rate; Stripe's Bridge got an OCC trust-bank charter (Feb 2026).
- Context only (not landing copy): YC funds companies in USDC on Solana and its RFS names cross-border stablecoin payments.

---

## Positioning non-negotiables (from `POSITIONING-CORRECTED.md`)

1. **Vendors, not contractors / employees / "teams."** AP = paying vendor invoices, not payroll.
2. **One unified product.** Global payment is a feature of the one product, never a second track or audience.
3. The two customer shapes (AP-heavy complex orgs; global vendor payers) are an **internal lens only** — never shown as a split.
4. **No crypto jargon to the buyer.** Sell outcomes (fast, cheap, transparent, safe, self-custodial), not "stablecoins / multisig / web3." (Accelerator audiences are the exception — they want the rail named.)
5. **The two flexes / product spine:** (a) **AI** automates the manual AP work; (b) **a self-custodial, global USDC account** — a concrete account the business gets and controls, that it pays vendors globally from. Frame the crypto pillar as this **account**, NOT as "stablecoin rails" (abstract/confusing). Honesty: the account is real/built; paying vendors *out of it* globally is the roadmap.
6. Plain voice, no em-dashes, human not AI-marketing.

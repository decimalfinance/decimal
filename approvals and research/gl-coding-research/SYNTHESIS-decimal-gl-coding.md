# Decimal GL coding — synthesis and build agenda

Sources: ramp.md · vicai-stampli.md · qbo-xero-billcom.md · enterprise-dimensions.md · coa-defaults-and-accuracy.md (researched 2026-07-13). Fourth research round, after roles, flows, and policies.

## 0. What Decimal already has (the honest inventory)

More than expected — the research validates the shape and names what's missing:

- **Vendor-history predictor** (`gl-coding.ts`): most-common account from this vendor's prior codings, deterministic, no LLM. The research's #1 finding everywhere: vendor memory is the strongest signal — QBO's own conclusion ("reusing the customer's past coding beats a model") and Bill.com's "last 5 bills" heuristic agree. ✓ correct bet.
- **OCR document-signal suggester** (`ocr-coding.ts`): line text + category hint → ranked account suggestions, deliberately document-only so it never double-counts history. This is the cold-start layer. ✓
- **Built-in default chart** (`default-chart.ts`, 20 accounts): research says a working AP coding set is 10–20 recurring expense accounts (charts hold 30–50, bills touch far fewer) — 20 QBO-named accounts is the right size and taxonomy. ✓
- **Coding inbox** + line-level categories that also feed the approval flow's category splits. ✓
- **The decision log** persists predicted vs confirmed vs source — explicitly designed to be promoted into `coding_rules`, which was never built. That's the gap.

## 1. The converged industry model (all five sources agree)

**A waterfall with strict precedence, where AI only fills blanks:**

1. **Explicit rules** (vendor default account, if/then rules) — always win.
2. **Vendor memory** (learned from this org's own corrections/history).
3. **AI suggestion** (document text, cross-pattern) — fills fields that are STILL BLANK, only at high confidence, and never overwrites anything a human or rule set. (Ramp states this verbatim; QBO's bank feed works the same: rules always beat the ML suggestion.)
4. **Catch-all** — when nothing is confident: an Uncategorized/Ask-my-accountant bucket, never a hard block. All three SMB products treat "can't code it" as park-it-for-close, not stop-the-bill.

Plus three cross-cutting agreements: coding is **line-item level**; coding stays **correctable through the whole lifecycle** until the accounting-side month closes (sync-readiness is the real gate, not entry); and **nobody ships a separate coding-approval stage** — coding review folds into bill approval, with defaults+validation at entry and month-end sampling.

## 2. Decisions

**D1 — Build the waterfall explicitly, and make every value carry its provenance.** Order: explicit vendor rule → vendor memory → OCR/AI suggestion → catch-all. Each coded field knows its source (`rule` / `vendor_history` / `ocr` / `human`) and the UI shows it (source chip + hover "why": which rule, which prior bills, which line text). Rules beat AI; specific beats general; **AI never overwrites a human- or rule-set value**. Our ranker already half-does this — the work is making precedence explicit and the provenance visible.

**D2 — Vendor memory becomes an inspectable object, not a side effect.** The missing `coding_rules` step: when a vendor's last N codings agree (Bill.com uses 5), promote that into a visible **vendor coding default** on the vendor record — a rule the owner can see, edit, or delete on the Vendors page, seeded automatically and adjustable by hand (Ramp's "passive learning + explicit instruction stack"). Corrections retrain it: override the suggestion twice in a row and the default follows current behavior, not six months ago.

**D3 — Chart handling: pass-through, never a competing taxonomy.** With QBO connected, the real chart (accounts + Classes + Locations via the API's Account/Class/Department entities) is the vocabulary; Decimal's category concept is a mapping layer over it (Ramp's model). Without QBO, the built-in 20 stays — plus one addition: a **built-in catch-all** ("Uncategorized expense — for your accountant to place") as the never-block fallback, matching the mental model every accountant already has. When QBO connects later, builtin-coded history maps across once.

**D4 — Dimensions: at most one extra, later, and only as pass-through.** GL account + optionally QBO Class OR Location per line (P2, behind the QBO sync scoping) — never our own tagging system, and never assume dimension parity on future connectors (Bill.com's lesson: it varies per backend). Skip: Items, 5-segment enterprise strings, budget-linked coding, amortization engines (reserve prepaid/start/end fields in the data model, build nothing).

**D5 — Confidence is per FIELD, shown as state not score.** Stampli's gate over Vic.ai's: high-confidence fields pre-fill (with source chip), low-confidence fields stay **blank** — an empty field is a clearer "I don't know" than a wrong guess. No numeric scores in the UI; provenance-on-hover is the trust surface (Ramp's color+hover pattern).

**D6 — No coding-approval gate; sync-readiness is the control point.** Coding rides the existing pipeline (reviewer codes at review, approvers may correct, editable until QBO close blocks the sync). The coding inbox stays what it is — an intake queue for uncoded/low-confidence items — which is exactly what "coding inbox" means everywhere else.

**D7 — Measure honestly, in two numbers nobody else separates.** Internal metric: % of suggested fields NOT corrected by a human before sync — tracked as (a) exact-account match and (b) category-level match, qualified by tenure (day-1 vs month-3). Never a blended headline. The decision log already captures everything needed to compute this. Bill.com's 99%-claim vs 60–85%-measured teardown is the cautionary tale; Stampli's own "touchless AP is a myth" post is the honest posture to emulate.

## 3. Build agenda

**P0 — vendor coding defaults + the visible waterfall.**
1. `coding_rules`: vendor→account default rules, auto-promoted from agreeing history (last-5 heuristic), editable/deletable on the Vendors page ("Bills from Helios code to Cloud hosting — learned from 5 bills · edit").
2. Precedence rewiring in the ranker: rule → history → OCR → blank, with source recorded per field.
3. Provenance UI in the review screen + coding inbox: source chip per coded line, hover explains (rule / N prior bills / document text), low-confidence renders blank.

**P1 — the catch-all + correction loop.**
4. Built-in "Uncategorized expense" account + route low-confidence there at sync time rather than blocking; surface a "for your accountant" sweep view in the coding inbox.
5. Correction capture: overriding a suggestion optionally asks for one sentence ("client work vs internal") stored on the decision log and shown on the vendor rule it retrains.

**P2 — with the QBO connection live:**
6. Class/Location pass-through per line (scoped to what QBO actually syncs).
7. Bulk coding in the inbox (checkbox + filter + apply), split lines across accounts.
8. Internal accuracy dashboard from the decision log (exact vs category match, by tenure).

**Skip:** per-tenant model training, cross-customer pattern models, Items support, amortization engine, a separate coding-approval stage, autonomous coding-to-post without review.

## 4. Anti-patterns (never do)

- Silent autofill — every machine-set value carries its chip; QBO itself badges rule-set values.
- AI overwriting human- or rule-set values, ever.
- A blended headline accuracy number, or any published number before real tenure data exists.
- Hard-blocking a bill because coding is uncertain — park it in the catch-all, keep money-movement gates (policies) separate from bookkeeping certainty.
- Building our own dimension taxonomy or assuming dimension sync parity beyond QBO.

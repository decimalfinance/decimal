# Organization-wide policies and invoice-processing controls: Stampli and Vic.ai

Scope: invoice-processing policies (duplicate detection, PO matching/tolerances, validation, required fields), vendor policies, how the AI interacts with policy (enforce vs. suggest vs. learn), where things are configured, enforcement behavior, overrides/audit trail, and defaults. Approval-chain routing itself is out of scope (researched separately) except where it's the direct output of a policy rule.

---

## Stampli

### Invoice-processing policies

**Duplicate detection.** Stampli checks run in layers across the invoice lifecycle — at upload, review, dispatch, release, and export — rather than as a single gate. Matching compares business data, not the document image: vendor, invoice number, amount, and date. It uses exact matching for identical resubmissions and fuzzy matching for near-misses (e.g., a 95%-similar invoice number combined with identical vendor/amount/date scores as a probable duplicate; similar numbers with different amounts can indicate legitimate recurring billing rather than a duplicate). Stampli explicitly frames plain ERP-level "unique invoice number" constraints as insufficient because they miss altered invoice numbers, duplicates split across different vendor records, cross-entity duplicates, and duplicates caught before posting.
Source: https://www.stampli.com/resources/duplicate-invoice-detection/

**PO matching and tolerances.** Stampli supports both 2-way and 3-way matching, including blanket POs, multiple invoices against one PO, and tax/freight handling. Line-level AI matching automatically identifies exact matches between header and line-level PO data and flags discrepancies when lines don't match. Tolerances are customer-defined (the docs give a concrete example: a company allows a 5% price variance on the PO-vs-invoice for purchases under $5,000, but only from certain vendors — i.e., tolerances can be scoped by amount tier and vendor, not just a single global percentage). When PO and invoice match within the configured tolerance, Stampli automatically skips the approval step for that invoice.
Sources: https://www.stampli.com/po-matching/, https://www.stampli.com/ai-line-level-po-matching/, https://www.stampli.com/blog/invoice-management/po-matching-invoice/

Stampli's own guidance on setting tolerances treats it as a cost/risk calibration exercise, not a fixed rule: "Set tolerance from data: distribution of your historical variances, the labor cost of investigating one (often $25–50 of someone's time), and risk appetite by category... Blocking a $3 variance on a $5,000 invoice costs more than it protects; auto-accepting 2% on million-dollar spend is real money." Recommended practice is tiered tolerances by spend category, reviewed quarterly against what actually auto-passed.
Source: https://www.stampli.com/resources/auto-approval-touchless-controls/

**Required-fields / validation rules.** Required invoice fields act as a hard stop: a blank required field stops the invoice from moving forward until resolved. Stampli's guidance separates required values into three sources — derivable from the invoice document or PO, must come from the vendor, or is an internal accounting value AP/the requester must supply — and expects a defined path to fill each rather than treating "missing field" as one bucket.
Source: https://www.stampli.com/resources/required-invoice-field-blank/

**The four-stage AI pipeline.** Stampli names its processing pipeline explicitly as extraction (structured fields/line items) → validation (duplicate checks, PO matching, tolerance tests) → coding (predicting GL account/department/dimensions) → routing (predicting and assigning approvers).
Source: https://www.stampli.com/resources/how-ai-invoice-processing-works/

### Vendor policies

**Onboarding / verification requirements.** Stampli's stated minimum bar for onboarding a vendor is: validation evidence (tax form, duplicate check, bank verification) plus sign-off from someone who did not request or create the vendor record (segregation of duties baked into the policy itself). Higher-risk vendors — high spend, international, or a banking-details change — require a second approver. Required fields span five categories: identity (legal name, DBA, EIN/SSN, address), tax (W-9/W-8, 1099 determination), payment (banking, remit-to, terms, currency), compliance (COI, licenses, industry certifications), and governance (requester, approver, date).
Sources: https://www.stampli.com/resources/vendor-creation-approval-workflow/, https://www.stampli.com/resources/vendor-onboarding-accounts-payable/

**Vendor-specific processing rules.** Vendor management is continuous, not a one-time gate: Stampli tracks required documents, monitors expirations, sends reminders, and — this is the enforcement teeth — can block invoices or payments outright when a vendor is missing mandatory records or no longer meets payable requirements. Onboarding uses customizable self-service forms and workflow logic so records are reviewed against org-specific requirements before the vendor can transact.
Source: https://www.stampli.com/vendor-management/

### How the AI interacts with policy

Stampli is explicit that its model is suggestion + guardrail, not autonomous enforcement: "The system does not autonomously enforce policy thresholds. Instead, it surfaces predictions with confidence scores, and a threshold decides its fate, based on organizational configuration. Humans retain final decision-making authority before posting to the ERP." High-confidence predictions are pre-filled for fast human confirmation; low-confidence ones are flagged or left blank. GL coding is explicitly a learning loop — the system "learns from your history," proposing accounts/dimensions from how similar past invoices were coded, and improves as AP corrects it. Validation (duplicate/PO/tolerance) is described as "configurable guardrails," not immutable policy — items that fail validation are surfaced for investigation, not auto-rejected.
Source: https://www.stampli.com/resources/how-ai-invoice-processing-works/

### Where configured, enforcement, overrides, audit trail

Auto-approval ("touchless" processing) is treated by Stampli as a control surface with explicit qualifying criteria — PO match within tolerance, trusted vendor status, amount ceiling — and, critically, a set of **hard preconditions that disqualify an invoice from skip-logic regardless of everything else matching**: a first invoice from a new vendor, a recent change to vendor banking details, an open duplicate/near-duplicate flag, or a price/quantity variance outside tolerance. Any one of these forces human routing even if the invoice would otherwise qualify for touchless processing.

Governance around the rules themselves: rule changes are restricted to named admins, criteria modifications require second-person sign-off, and all configuration changes are logged with version history. Every auto-approved invoice captures its skip reason in the activity record. Ongoing monitoring layers on top: periodic sampling of auto-approved invoices for accuracy, standing exception analytics (vendor concentration, amounts clustering just under the ceiling, velocity changes), and quarterly rule review against current risk. Stampli's own audit framing: "60% of invoices approved by a tested, tolerance-bound matching control with exception routing" is positioned as stronger audit evidence than 100% manual approval, because the control is documented and testable.
Source: https://www.stampli.com/resources/auto-approval-touchless-controls/

### Defaults out of the box

Not documented publicly with specific numbers — Stampli's material consistently frames tolerances, ceilings, and required-field sets as customer-configured from day one rather than shipping a fixed universal default. The one implicit default is architectural: duplicate detection and required-field checks are always-on validation steps in the pipeline (not optional), while PO-match tolerance and auto-approval ceilings are org-set values with no single published baseline.

---

## Vic.ai

### Invoice-processing policies

**Duplicate detection.** Vic.ai applies duplicate detection automatically across ingested invoices, paired with anomaly detection for other risk signals, and flags duplicates for human review.
Source: https://www.vic.ai/accounts-payable/invoice-processing

**PO matching and tolerances.** Organizations define acceptable variance thresholds for price or quantity differences; an invoice that falls within the configured tolerance can be auto-approved. Matching handles partial matches, multiple invoices against a single PO, and a single invoice split across multiple POs; non-PO invoices fall back to AI-based coding instead of matching. When matching fails or a discrepancy exceeds tolerance, the invoice is flagged for review (e.g., quantity mismatch, missing receipt). The Q1 2026 release added a "contains" operator so admins can build PO-matching approval rules against partial PO values (more flexible pattern matching in the rule builder), automatic dimension/tax-code preservation from matched PO lines onto ERP postings, and a new "Pending Receipt" status to distinguish invoices waiting on receipt confirmation from other exceptions.
Sources: https://www.vic.ai/frequently-asked-questions, https://www.vic.ai/blog/q1-2026-product-release-expanding-autonomy-across-the-ap-lifecycle

**Required fields / validation.** Not separately documented as a standalone "required fields" policy surface the way Stampli's is — validation is folded into the confidence-threshold/exception model described below rather than presented as a discrete blocking rule set.

### Vendor policies

**Onboarding / verification.** Vic.ai's Vendor Portal (self-service) plus VicPay give admins full visibility into onboarding status, vendor verification, and payment readiness, with automated routing/tagging/reporting. Verification is backed by Plaid-based banking validation and KYB/KYC checks before payment details are trusted; Vic.ai states payment details are "verified through Plaid" before any money moves. Vendor records are continuously (not just at intake) re-verified — tax information and payment terms are checked on an ongoing basis — and AI-driven risk assessments flag potential compliance issues proactively. Once onboarded, a vendor joins the "Vic Vendor Network" and can reuse the same verified profile across every Vic.ai client they work with (a shared-vendor-identity model, somewhat like a vendor passport).
Sources: https://www.vic.ai/vendor-portal, https://www.vic.ai/blog/q2-product-launch-from-automation-to-agentic-ai, https://www.vic.ai/news/vic-ai-launches-vicpay-vendor-portal-and-vicagents-accelerating-the-shift-to-autonomous-finance

### How the AI interacts with policy — autonomy levels and confidence thresholds (the central Vic.ai policy surface)

Vic.ai's framing is explicitly progressive autonomy tied to measured AI accuracy, not a fixed rules engine: "The longer clients use Vic.ai, the more autonomy they get." Concretely:

- Customers define confidence thresholds per prediction type (header, line-item) — e.g., "post autonomously above 95% confidence," everything below routes to a human. Confidence scores are shown transparently at header and line-item level so a reviewer can see exactly why something was or wasn't auto-processed.
- "Autopilot" can complete approval steps on the org's behalf once the AI has demonstrated it hits the org's target accuracy level for that class of invoice — this is explicitly gated on measured performance, not a one-time toggle.
- Once AI confidence is extremely high across all predictions on an invoice, it can go straight from ingestion into either (a) an approval flow, or (b) directly into the ERP ready for payment, skipping human approval entirely.
- Threshold/data rules can also trigger approval routing independent of confidence — by vendor, amount, GL account, cost center, or PO mismatch — so confidence-based autonomy and rule-based routing compose together (an invoice can be high-confidence but still forced into routing because it hits a vendor or amount rule).
- Users retain override rights on any AI-generated prediction — full review/edit capability is preserved even where autonomy is high, and Vic.ai frames the threshold configuration itself as something that must align with the org's internal controls requirements (i.e., it's audit-relevant, not just an efficiency knob).

Sources: https://www.vic.ai/blog/how-does-vic-ai-ap-autonomy-work, https://www.vic.ai/accounts-payable/approvals, https://www.vic.ai/frequently-asked-questions

### Where configured, enforcement, overrides, audit trail

Approval workflows and thresholds are configured by an org admin as business rules/conditions, supporting sequential or parallel approval chains. Every action (approval, rejection, comment) is logged with timestamp and user attribution for audit purposes. The Q1 2026 release added policy-adjacent workflow hardening: when a coding change (e.g., project/dimension edit) would trigger a different approval routing outcome, the system automatically recalculates routing rather than requiring a manual reset; timed reminders and automatic escalation fire when an approval stalls; a daily summary surfaces outstanding PO mismatches awaiting review.
Sources: https://www.vic.ai/frequently-asked-questions, https://www.vic.ai/blog/q1-2026-product-release-expanding-autonomy-across-the-ap-lifecycle

### Defaults out of the box

Not publicly documented with specific numbers. Vic.ai's own material treats the starting posture as low-autonomy/high-human-review, with autonomy increasing over time as the org's own accuracy data justifies raising thresholds — i.e., the "default" is functionally a ramp, not a fixed starting configuration. No default confidence percentage or default tolerance is published; these appear to be established per-customer during implementation, informed by the AI's live accuracy on that customer's own invoice population.

---

## What Decimal should steal / avoid

**Steal:**
- Stampli's "hard preconditions" pattern: a short, non-negotiable disqualifier list (new vendor's first invoice, recent bank-detail change, open duplicate flag, out-of-tolerance variance) that forces human review regardless of what else matches. This is a clean, auditable way to bound autonomy without needing a full confidence-scoring system — cheap to implement and easy to explain to an auditor.
- Vic.ai's transparent per-field confidence display paired with an org-configurable threshold: making the AI's uncertainty visible (not just a binary auto/manual split) gives reviewers a reason to trust or distrust a specific field, and gives the org a real dial to tune autonomy over time.
- Tolerance-as-calibration framing from Stampli: tolerances aren't a single global percentage, they're tiered by spend category and vendor, set from actual historical variance data and the labor cost of investigating a miss, and reviewed periodically. Worth building tolerance config with tiers from day one rather than one global number.
- Governance-on-the-governance: both platforms log rule/threshold changes themselves (who changed a tolerance, when, and require sign-off) — the policy configuration surface is itself audited, not just invoice-level actions.
- Vic.ai's "autonomy is earned, not granted" framing — gating increased automation on measured accuracy per invoice class is a strong sell for a product still building trust, and it's honest about the AI's real error rate rather than a marketing claim.

**Avoid:**
- Neither vendor publishes concrete default thresholds/tolerances — this leaves customers to guess during onboarding, which is a support/trust cost. Decimal is small enough that it could ship sane, stated defaults (e.g., a documented starting tolerance and confidence threshold) as a differentiator, then let orgs tune from there — "start safe, show your defaults" instead of "call us to configure."
- Vic.ai's confidence-threshold-plus-rule-based-routing composition (both systems can independently trigger routing) risks being hard for an org admin to reason about — two independent policy surfaces that both gate the same invoice. If Decimal builds both, keep the interaction model simple and visible (e.g., surface which rule fired, not just "flagged").
- Stampli frames validation as "configurable guardrails, not immutable policy" — fine for their audience, but for Decimal's crypto-rail context (real-time, largely irreversible settlement) some checks arguably should be closer to true hard blocks rather than soft flags, since there's no ACH-style reversal safety net once funds move.

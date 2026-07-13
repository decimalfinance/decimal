# Org-wide policies and spend controls: Ramp and Brex

Scope: policy TYPES, WHERE configured, ENFORCEMENT points, defaults, and AI-driven behavior. Approval-chain routing mechanics are covered elsewhere and intentionally excluded here except where policy and approvals intersect.

---

## Ramp

### Policy types

- **Card/fund controls** — merchant category and specific-merchant restrictions on a card or fund. Configured as an **allowlist**: admin picks which categories/merchants are allowed; everything else is declined. There's also a block-specific-merchants mode ("Blocking or restricting merchants on Ramp"). ([Setting up category and merchant restrictions](https://support.ramp.com/hc/en-us/articles/1500001319081-Setting-up-category-and-merchant-restrictions), [Setting up controls on Ramp cards and funds](https://support.ramp.com/hc/en-us/articles/360051065813-Setting-up-controls-on-Ramp-cards-and-funds))
- **Spend limits** — dollar caps per transaction and per recurring period (daily/weekly/monthly), separate from category/merchant controls. Limits and controls are evaluated independently; a transaction can be within the dollar cap and still be declined for violating a category rule, or vice versa. ([How do policy rules interact with spend limits?](https://ramp.com/answers/policy-enforcement/policy-rules-interact-with-spend-limits))
- **Spend programs** — reusable templates that bundle amount, frequency, merchant/category controls, issuance method (admin-issued vs employee-requested), recipient targeting (all employees or filtered by department/location), accounting auto-mapping, and post-purchase documentation/review requirements into one config applied to every fund/card issued from the program. This is Ramp's closest thing to a "policy object" that spans multiple control types at once. ([Spend programs creation and management](https://support.ramp.com/hc/en-us/articles/4417839254675-Spend-programs-creation-and-management))
- **Expense policy (documentation/behavior policy)** — a natural-language-ish policy document (receipts, memos, meal caps, category definitions, etc.) that is separate from hard card controls and is enforced by the AI policy agent, not by declining the card. This is the "written policy" layer, distinct from the "card will literally decline it" layer.
- **Bill Pay controls** — separate policy surface for AP/vendor payments: approval chains, separation of duties (bill creator cannot approve their own bill, toggleable), and a **Payment Release** gate — a second, explicit release step by a designated payer after approval, before funds move. Configured under Bill Pay settings → Approvals. ([Bill Pay approvals](https://support.ramp.com/hc/en-us/articles/4417843897747-Bill-Pay-approvals), [Bill Pay overview](https://support.ramp.com/hc/en-us/articles/4417743160211-Bill-Pay-overview))

### Where configured / UX

- Card/fund-level controls: configured per card or fund, at creation, request, or edit time, in a "Spend controls and restrictions" section (not one global page for these).
- Spend Programs: one config screen per program (7-step wizard: amount/controls → issuance method → recipients → accounting rules → submission policy → review/activate), reused across many cards/funds — this is the closer-to-centralized model for recurring spend.
- Expense/documentation policy: consolidated into a single **Policy Page**, recently redesigned to put policy logic at the top with a dedicated **Policy Editor**. This is explicitly the "written policy, AI-enforced" surface, separate from card-level hard controls. ([The New Policy Page & AI Agent](https://support.ramp.com/hc/en-us/articles/47610953810835-The-New-Policy-Page-AI-Agent))
- Bill Pay approvals/controls: separate settings area (Bill Pay → Approvals), not merged with the card/expense policy page.
- So Ramp's policy surface is **split across at least three places**: (1) per-card/fund controls, (2) a centralized written-policy page for expense documentation/behavior enforced by AI, (3) Bill Pay's own approval/release settings. Not one unified policy center.
- Configuration style: mostly structured toggles/dropdowns for card controls (pick categories, pick merchants, set $ caps), but the expense-policy layer is written as policy language/knowledge document that the AI agent reads and reasons over — closer to natural language than a rule builder. Ramp's Policy Builder can auto-generate this document from a Q&A ("basic company questions") and industry benchmarks. ([Build a personalized expense policy in minutes](https://ramp.com/blog/its-time-to-rewrite-your-expense-policy-for-ai-insights-from-10000-expense-policies))

### Enforcement points

- **Card/fund category & merchant restrictions: hard block.** Declined transaction, SMS notification to the cardholder, cardholder is told to contact finance for an exception; admins can grant exceptions/amend restrictions after the fact. No "warn and allow" mode described for these — it's allow or decline. ([category/merchant restrictions](https://support.ramp.com/hc/en-us/articles/1500001319081-Setting-up-category-and-merchant-restrictions))
- **Spend limits: hard block** at the dollar cap (auto-decline over limit).
- **Written expense policy (documentation, meal caps, etc.): AI-adjudicated, not point-of-sale blocked.** The card already charged; the AI Policy Agent reviews the expense after the fact against the policy document. About 3 of 4 in-policy expenses are auto-approved by the agent; ambiguous or out-of-policy ones escalate to a human reviewer. Admins can run the agent "in the background" to check its accuracy against a human reviewer before turning it fully on — i.e., there's a shadow/test mode before auto-enforcement goes live. ([Policy Builder blog](https://ramp.com/blog/its-time-to-rewrite-your-expense-policy-for-ai-insights-from-10000-expense-policies), [New Policy Page & AI Agent](https://support.ramp.com/hc/en-us/articles/47610953810835-The-New-Policy-Page-AI-Agent))
- **Bill Pay: separation of duties + Payment Release** — two independent enforcement gates (approve, then a separate explicit release-to-pay step by a different/designated person), plus full audit trail of who approved/released what and when.
- Overrides: for card controls, only an admin can override/amend; the cardholder cannot self-override. For the AI policy agent, escalated items go to a human reviewer who makes the final call — implicitly logged since it's part of the approval/review trail.

### Defaults for new org / interaction with roles & approvals

- Card/fund controls are optional per card — nothing is forced globally; an admin can leave a card fully unrestricted.
- The written policy has no single hard-coded default; Ramp instead pushes admins toward its benchmarked Policy Builder rather than shipping a boilerplate default doc.
- Policy and approvals are explicitly linked: Spend Programs attach approval workflows to bundles of controls; Bill Pay policy is inseparable from its approval chain (separation-of-duties, release gate); the written policy's escalations feed into "Approval Chains" (the renamed manual review workflow) when the AI can't auto-clear an expense.

### AI-driven behavior (Ramp Intelligence / Policy Agent)

- This is Ramp's most distinctive move: the expense policy is treated as a **knowledge document an AI agent reads and applies**, not a static rulebook a human checks. Ramp's own analysis of ~10,000 customer policies argues that AI-enforceable policies need to be *specific* (explicit $ amounts/categories, not "reasonable"), have 3-5 clean categories, build in auto-adjusting flexibility (e.g., GSA per diem + 10%, auto-adjusts by city instead of a fixed number), and get revised continuously as the agent surfaces friction patterns.
- Ramp reports customers using the agent's suggestions update their policy 7x more often (44% vs 6.4% over 6 months) — the AI actively nudges continuous policy tightening/loosening rather than an annual policy review cycle.
- Vague policies roughly double the rate of expenses kicked to a human — i.e., ambiguity directly increases human review load, which is the AI's core cost lever for Ramp: clearer policy = more autonomous adjudication = less human time.
- Shadow-mode rollout (agent runs silently, compared against human reviewer decisions, admin reviews an "Accuracy Metric" before flipping the agent on for the whole org) is a concrete pattern worth stealing: don't auto-enforce a new AI policy engine on day one, prove it against human judgment first.

---

## Brex

### Policy types

- **Spend limits** — the core object covering any spend type (card, bill pay, reimbursement, travel, procurement, stipends). A spend limit is not just a dollar cap; admins attach "additional rules" to it (category/vendor restrictions, transaction-max auto-decline, whether it can be used via physical card vs reimbursement, currency, budget reset cadence: weekly/monthly/quarterly/annually). ([Spend limits overview](https://www.brex.com/support/spend-limits-overview), [Manage budgets and spend limits](https://www.brex.com/support/manage-budgets-and-spend-limits))
- **Policy Engine / Policy Rule Builder** — the centralized, general-purpose rules layer. If-this-then-that logic over conditions (amount, expense category, merchant/vendor, employee role/level, custom HRIS fields such as Workday attributes, card type i.e. p-card vs employee card, combinable with AND) producing actions (require a specific approver, require attendee documentation, require receipt/memo, **block the transaction entirely**, require an accounting field). ([Policy Engine](https://www.brex.com/support/policy-engine), [Policy Rule Builder](https://www.brex.com/support/policy-rule-builder))
- **Documentation requirements** — receipts and memos, either globally or above a $ threshold, with role-based dynamic exceptions (by role, department, cost center, or specific employee/custom field). VAT documentation is Premium/Enterprise-only.
- **Automated audit rules** — flags high-risk categories by default pattern: alcohol, gifts, "upgrades," political spend.
- **Bill-pay-specific controls** — a spend limit can be scoped to a PO, vendor, or contract, enabling ACH/check/wire up to the contracted amount, so bill pay reuses the same spend-limit/policy engine rather than having a fully separate system (contrast with Ramp, where Bill Pay has its own settings area). ([Bill pay](https://www.brex.com/support/bill-pay-overview))
- **Request types** — presets for different spend scenarios (travel, procurement, stipend, etc.) that pair with a policy and a spend-limit template.

### Where configured / UX

- Single navigation path: **Cards and Limits → Manage policies**, accessible to account admins, card admins, bookkeepers, and custom roles with the right capability. This is meaningfully more centralized than Ramp — one policy management surface rather than three.
- Policies are structured into a **Default section** (applies to any spend not tied to a specific limit) plus optional **custom sections** for specific programs (e.g., stipends, travel benefits) — so it's one policy object with named sub-scopes, not N separate unlinked policies.
- UX is a structured **rule builder** (if-this-then-that), not natural language: pick a condition type, an operator, a value, then an action. Example given in docs: "If an expense is a Meal over $50 made by an Executive → require approval from [specific reviewer]."
- Rule ordering matters: **last matching rule wins**, so admins are told to put more specific rules later in the sequence — a real gotcha for anyone porting this model (silent rule-shadowing risk if the ordering isn't obvious in the UI).
- Currency: policies operate in a base currency; other-currency transactions are converted for evaluation; currency setting lives in Company Settings → Expenses, separately from the policy screen itself.

### Enforcement points

- Each rule's action is explicit and can be **block**, **require approval from a named approver/role**, **require documentation** (receipt/memo/attendees/accounting field), so Brex genuinely supports block vs flag/require-more-info vs route-to-approval as distinct outcomes on the same rule, not just binary block/allow.
- Enforcement happens **in real time at the point of spend** for spend-limit-bound transactions.
- Re-evaluation triggers: a rule can re-fire if policy changes, or if documentation/fields are updated before the approval is finalized — i.e., policy checks aren't a one-shot gate, they can re-run mid-review.
- Reminders for missing receipts/memos are automatic and recurring, and **stop once an admin marks the transaction as reviewed** — a concrete "override" mechanic: an admin can manually clear a documentation requirement by marking it reviewed, which implicitly is the audit record (the review action itself, by whom).
- The Brex marketing/help copy (via `brex.com/platform/spend-limits`) frames the philosophy explicitly as **policy-based controls rather than locked budgets** — rules can be overridden by managers/approved as exceptions rather than being a hard wall, in contrast to Ramp's harder "declined, ask finance for exception" default posture on card-level category restrictions.

### Defaults for new org / interaction with roles & approvals

- New orgs get **three pre-built default policies out of the box: Travel, Stipends, General** — any of the three (or a custom one) can be set as the org's default policy via a menu action. This is a concrete, opinionated starting point Ramp doesn't appear to ship (Ramp instead pushes you into its AI Policy Builder Q&A to generate one).
- If a spend limit is optional and an expense isn't tied to one, the **Default section of the default policy's approval chain applies automatically** — meaning "no policy assigned" still resolves to a real, defined policy+approval outcome, not an undefined state.
- Roles integrate two ways: (1) role/department/cost-center is a first-class rule *condition* (dynamic exceptions), and (2) policy management itself is gated to admin-type roles.

### AI-driven behavior

- Brex's public materials in this crawl lean more on the deterministic if-this-then-that Policy Engine than on an AI-adjudication layer comparable to Ramp's Policy Agent; no equivalent "AI reads a knowledge document and auto-approves 3 of 4 expenses" mechanic surfaced in the docs pulled here. Brex's "smarter bill pay" and AI framing exist in marketing pages but weren't detailed enough in the crawled content to state specifics with confidence — treat this as a gap, not a claim that Brex lacks AI enforcement.

---

## What Decimal should steal / avoid

**Steal:**
1. **Split the concept in two, on purpose**: (a) hard, deterministic, point-of-payment gates (amount caps, vendor/category allow-block lists) that block outright with no ambiguity, vs (b) a softer "documentation/behavior policy" layer (memo/receipt required, coding conventions) that can be AI-adjudicated after submission and only escalate to a human when unclear. Trying to force both into one rule type is what makes Ramp's UX feel scattered across three surfaces.
2. **Brex's single policy home + named sub-scopes (Default + custom sections)** is the better information architecture than Ramp's three-scattered-surfaces model for a product Decimal's size — one page, one mental model, scoped overrides for specific programs (e.g., "AP for Vendor X" as a custom section) rather than a totally separate settings area per feature.
3. **Brex's condition/action rule builder** (amount, category, vendor, role, custom field → require approval / require doc / block) maps directly onto Decimal's 4-layer approval engine and the 3-stage pipeline (Review/Approve/Release) already committed to — reuse those same condition types as policy triggers instead of inventing a new taxonomy.
4. **"No policy assigned still resolves to a real default"** (Brex) — avoid silent undefined behavior; every org should get a real default policy/approval chain from day one, not a null state.
5. **Ramp's shadow-mode rollout for AI policy enforcement** (run the agent silently, compare to human decisions, show an accuracy metric, only then flip on auto-enforcement) is the right pattern if/when Decimal lets an AI agent auto-clear invoices against policy — don't ship auto-block/auto-approve from an LLM without a trust-building staging step.
6. **Explicit audit trail as a first-class artifact**: Ramp's Bill Pay separation-of-duties + Payment Release gate, and Brex's "mark as reviewed stops reminders" pattern, both make the override/exception itself the audit record. Decimal's policy violations should always produce a loggable event (who overrode, when, why) rather than a silent pass.
7. **Ramp's "write AI-actionable policy" guidance** (specific $ amounts not "reasonable," 3-5 categories, self-adjusting thresholds like per diem + 10%) is directly reusable copy/UX guidance for however Decimal exposes a natural-language policy or OCR/GL-coding rule to its own coding-suggestion agent (already shipped per `ocr-coding.ts` / `gl-coding.ts`).

**Avoid:**
1. Ramp's fragmentation — card controls in one place, written policy in another, Bill Pay approvals in a third. For a lean AP product like Decimal, don't let policy config sprawl across unrelated settings screens as features ship independently.
2. Brex's "last rule wins" silent ordering trap — if Decimal builds a rule list, either make ordering visually obvious with conflict warnings, or don't rely on ordering at all (prefer most-specific-match with an explicit precedence indicator).
3. Neither platform's docs make clear, simple language for *why* a payment was blocked visible to a non-finance requester in the moment — both rely on after-the-fact SMS/notification-plus-contact-finance flows. Decimal should surface the specific policy clause that triggered a block directly in the UI at the point of failure, not just "declined, ask an admin."

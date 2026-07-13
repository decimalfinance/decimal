# GL coding / invoice coding at Vic.ai and Stampli

Research pass for Decimal's GL-coding suggestion flow. Both companies keep the actual model
architecture private — what's below is assembled from their marketing/product pages, FAQs, blog
posts, and case studies. Where a claim is vague or unverifiable, that's called out rather than
smoothed over.

---

## Vic.ai

**Positioning**: "AI accounting" platform, not just AP automation. Sells itself on autonomy —
"Autopilot" mode that takes invoices from ingestion through coding to approval with zero human
touch once confidence is high enough.

### Suggestion mechanics

- Vic.ai calls its GL coding "Intelligent GL coding" and explicitly does both header-level and
  line-item-level coding — line items get coded down to account + dimensions individually, not
  just the invoice as a whole.
  (https://www.vic.ai/accounts-payable/invoice-processing)
- Dimensions: the product pages mention "cost accounts, dimensions, assets" and PO matching, but
  don't enumerate department/class/location/project explicitly the way Stampli's docs do. The
  strong signal is that dimension coding is customer-specific — it's trained on "your chart of
  accounts" and "your team's coding preferences" during onboarding.
  (https://www.vic.ai/blog/the-unsung-hero-of-ai-accounting-historical-master-data-training)
- Training/setup: initial configuration involves mapping the chart of accounts, setting up
  approval workflows, and training the AI on coding preferences — described as 2-4 weeks of
  active work. Training data is customer-specific: "copies of actual invoices and information
  about the expense and GL codings" are fed in so the model learns which line item maps to which
  account/dimension for *that* customer.
  (https://www.vic.ai/blog/the-unsung-hero-of-ai-accounting-historical-master-data-training)
- This points to a per-customer trained/fine-tuned model (or at least per-customer coding logic
  layered on a shared base model) rather than one global model shared across all customers with
  no customer-specific weighting — Vic.ai's own language ("historical master data training")
  frames it as a deliberate per-tenant training step, not just retrieval over vendor history.

### Learning loop

- Corrections feed back into the model: "when an AP team member corrects a GL coding suggestion
  or overrides a matching decision, that correction feeds back into the model, improving accuracy
  over time." (https://www.vic.ai/frequently-asked-questions)
- Marketing explicitly ties adoption curve to time: one case study cites 85% no-touch by month
  six, implying the model needs several months of live correction volume to reach steady-state
  accuracy on a new customer, even though headline extraction accuracy (97-99%) is claimed "from
  day one" — i.e., raw OCR/extraction is good immediately, but GL-account-level coding accuracy
  and touchless rate climb over months as the model absorbs that customer's correction history.
  (https://www.vic.ai/frequently-asked-questions, https://www.vic.ai/accounts-payable/invoice-processing)
- No public detail on retraining cadence (real-time per-correction update vs. batch retrain) or
  whether corrections at one customer ever influence another customer's model. Given the emphasis
  on per-customer training data, the more likely architecture is a shared base model personalized
  per tenant, with corrections updating that tenant's layer specifically. This is an inference,
  not a stated fact.
- Cold start: not explicitly addressed for a brand-new vendor within an existing customer. The
  onboarding language suggests the 2-4 week setup is about bootstrapping the *customer*, not each
  new vendor — implying new vendors within an already-onboarded customer get coded reasonably
  well from day one using patterns learned from similar vendors/accounts, but this is not
  confirmed by any source found.

### Confidence

- Vic.ai shows "transparent confidence scores" at both header and line-item level, described as
  indicating "how accurate each data point is."
  (https://www.vic.ai/accounts-payable/invoice-processing)
- A concrete threshold appears in one case study: "Autopilot" is defined as all invoice details
  predicted with 95% or greater confidence — at that point the invoice moves straight to approval
  with no data entry or classification review.
  (search result citing a Vic.ai case study, via https://www.vic.ai/products/autonomous-approval-flows)
- Below-threshold invoices (or ones that fall outside configured rules) are automatically routed
  to a human queue for review — i.e., confidence gating is binary per-invoice (all fields must
  clear the bar) rather than a mixed per-field workflow where high-confidence fields auto-fill and
  only low-confidence fields get flagged. This is a meaningfully different design from Stampli's
  (see below).
- No published detail on how the confidence number itself is computed (calibrated probability vs.
  a heuristic score) or whether the threshold is customer-configurable vs. fixed platform-wide.
  Given they market it as adjustable per company's risk tolerance in places, it's likely tunable,
  but no source confirms an exact mechanism.

### Accuracy claims

- Extraction + coding accuracy: "97-99% accuracy... from day one," and a separate claim of "99%
  accuracy" trained on "a billion invoices" (base/foundation model, not per-customer).
  (https://www.vic.ai/frequently-asked-questions, https://www.vic.ai/)
- Touchless/no-touch rate: 85% no-touch by month six (aggregate marketing claim); one transportation
  company case study cites 84% no-touch processing rate with 99% invoice coding accuracy after
  reallocating 3 FTEs to higher-value work.
  (https://www.vic.ai/accounts-payable/invoice-processing)
- "Reducing exceptions to less than 1%" appears in onboarding copy, implying the exception rate is
  the operative accuracy metric they track post-ramp, not just raw field accuracy.
  (https://www.vic.ai/blog/the-unsung-hero-of-ai-accounting-historical-master-data-training)
- No source disaggregates "accuracy" into exact-GL-account-match vs. category-level-match. All the
  99% figures should be read as marketing claims (self-reported, no independent audit found) that
  most likely mean "matched the human-approved code," conflating extraction accuracy (invoice
  number, date, amount) with coding accuracy (GL account/dimension selection) in the same headline
  number.

### Workflow

- GL coding happens before approval, and Autopilot can chain coding directly into approval when
  confidence is high enough — "data extraction, GL coding, and approvals without human review."
  (https://www.vic.ai/accounts-payable/invoice-processing)
- Below-threshold or rule-flagged invoices route to a human review/approval queue instead — same
  approval workflow, just gated by AI confidence rather than always requiring a human step.
- No detail found on bulk-coding UI/operations or on what happens operationally when a customer's
  ERP chart of accounts changes (new account added, account deactivated). The one related mention
  is that GL coding "aligns with your chart of accounts" as part of onboarding, implying a
  resync/remap step exists, but nothing describes it.

---

## Stampli

**Positioning**: "Billy the Bot" — an AI agent framed as a coworker embedded in the invoice
workflow, not a black-box auto-poster. Stampli's messaging leans away from full autonomy and
toward "confident suggestion + fast human confirmation," which shows up consistently across their
docs.

### Suggestion mechanics

- The core mechanic, stated plainly: "for each line, it finds how similar past invoices from the
  same vendor were coded and proposes the most likely account, department, class, and location."
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Vendor is explicitly called out as the strongest signal: "a vendor change re-triggers
  prediction because vendor is the strongest coding signal" — i.e., changing the vendor on an
  invoice invalidates the current GL suggestion and forces a re-predict.
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Other signals referenced across pages: invoice line-item descriptions, department patterns, and
  seasonal trends feed the GL code prediction alongside vendor history.
  (via search summary of https://www.stampli.com/resources/invoice-gl-coding-fundamentals/ and
  related pages)
- Line-item coding is treated as the hard part relative to header extraction — header fields
  (invoice number, date, total) are extracted reliably while line-item coding lags, because line
  items involve variable table structures and free-text descriptions across vendors.
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Dimensions supported: GL account, department, class, location — with additional docs referencing
  project, cost center, subsidiary, employee, customer as ERP-specific segments that can be coded
  too. (https://www.stampli.com/resources/invoice-coding-and-fields-in-accounts-payable/)
- Coding is validated against the *live* ERP chart of accounts and dimension structure at
  suggestion time: "Stampli mirrors the ERP's chart of accounts, dimensions, field dependencies,
  and validation logic inside the invoice workflow, so coding happens against live ERP structure."
  This means a suggestion can never point at a stale/deleted account — the mirror is kept in sync.
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/,
  https://www.stampli.com/resources/invoice-coding-fields-and-erp-alignment/)
- Bulk/repeatable coding: "GL table templates" let a customer predefine a distribution (e.g. split
  a recurring vendor's invoice 60/40 across two departments) and apply it to auto-populate multiple
  line items at once, either built in-app or uploaded via CSV.
  (https://www.stampli.com/gl-table-templates/)
- Split coding: a single line item can be allocated across multiple GL accounts/departments/cost
  centers by percentage or amount.
  (https://www.stampli.com/resources/invoice-coding-in-accounts-payable/)

### Learning loop

- Billy is described as a single self-learning system trained on "millions of invoices" across
  Stampli's customer base ("observes millions of invoices and effectively programs itself"),
  which reads as a shared/global base model rather than a from-scratch per-customer model.
  (https://www.stampli.com/blog/inside-stampli/meet-billy-stamplis-accounts-payable-ai/)
- On top of that global base, predictions are explicitly personalized using the requesting
  customer's own vendor history ("similar past invoices from the same vendor were coded") — so
  the practical architecture looks like: global model for extraction/structure + per-customer,
  per-vendor retrieval/memory for the actual GL account prediction. This is a materially different
  claim from Vic.ai's "historical master data training," which reads more like true per-tenant
  model training.
- Feedback: "Every time you adjust its suggestions, it learns from you, and gets that much
  better" — corrections are described as immediately informing future suggestions, consistent
  with a memory/retrieval-based personalization layer rather than a slow retrain cycle.
  (https://www.stampli.com/blog/inside-stampli/meet-billy-stamplis-accounts-payable-ai/)
- Concrete accuracy-over-time numbers: straight-through-processing (STP) rates reach 70-80% after
  90 days of training on a given customer's invoice data, and GL-code prediction accuracy reaches
  90-95% specifically for organizations with 12+ months of historical data. This is the most
  precise "ramp curve" either vendor publishes.
  (per search summary of Stampli resources, cross-referenced against
  https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Cold start: implied rather than stated outright. Stampli emphasizes fast go-live ("up and
  running in days," ease into it at your own pace), suggesting a new customer starts on the
  global base model with low/no personalization and accuracy ramps as vendor-specific history
  accumulates — consistent with the 90-day/12-month figures above. No source explicitly describes
  what a brand-new vendor with zero invoice history looks like on day one (presumably: no
  suggestion, or a suggestion drawn only from similar vendors/global patterns, with the field left
  for manual entry until enough history exists).

### Confidence

- Stampli explicitly runs a two-tier confidence gate at the field level (not per-invoice like
  Vic.ai): "high-confidence values are suggested and pre-filled for quick confirmation;
  low-confidence values are left for a human to enter or are flagged for review."
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- This is a field-by-field split rather than an all-or-nothing gate on the whole invoice — one
  line item's GL account can be pre-filled with high confidence while another line's department
  code on the same invoice is left blank for a human, and the invoice as a whole still requires
  a human to touch it (since Stampli doesn't market full touchless auto-posting the way Vic.ai
  does).
- No numeric threshold (e.g., a specific %) is published anywhere found — contrast with Vic.ai's
  stated 95% figure. Stampli's messaging is generally softer on "autonomy" and harder on "assistive
  suggestion," consistent with not publishing a hard cutoff.

### Accuracy claims

- Headline field-level automation metric: "Stampli AI performs 87% of the field-level work across
  2,700+ unique fields, with humans handling validation and the exceptions that need judgment."
  This is explicitly a field-level metric across all extracted fields (not coding-specific), and
  it's framed as work-done, not accuracy-of-prediction.
  (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- GL-code-specific accuracy: 90-95% for customers with 12+ months of history (see Learning loop
  above) — this is the closest either company comes to a coding-accuracy number distinct from
  general extraction accuracy, and it's explicitly qualified by tenure, which is more transparent
  than Vic.ai's unconditioned "99%."
- STP: 70-80% after 90 days.
- No independent/audited accuracy studies found for either vendor — all numbers are self-reported
  marketing or single case-study anecdotes.

### Workflow

- Coding sits before posting and is explicitly framed as happening in-line with the approver's
  review, not as a separate step: "a default or AI-suggested code based on vendor and history,
  confirmed by the approver who knows what was bought, validated against accounting rules before
  posting." (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Validation ("clean before export, not cleaned up after") happens against the live ERP mirror
  at coding time, catching invalid account/dimension combinations before the invoice ever reaches
  the GL. (https://www.stampli.com/resources/how-ai-invoice-processing-works/)
- Chart-of-accounts changes: Stampli syncs its internal mirror of the ERP's chart of accounts,
  dimensions, and validation rules regularly, so a new/deactivated account propagates into the
  coding UI without a separate manual remap step — described as "regular synchronization to
  maintain alignment between the coding system and the ERP's current configuration."
  (https://www.stampli.com/resources/invoice-coding-fields-and-erp-alignment/)
- Bulk operations: GL table templates (predefined multi-line distributions applied in one click or
  via CSV upload) are the primary bulk-coding mechanism, aimed at recurring vendors/allocations
  rather than free-form bulk-edit across many invoices at once.
  (https://www.stampli.com/gl-table-templates/)
- No full touchless/zero-human-approval path is marketed the way Vic.ai's Autopilot is — Stampli's
  design keeps a human (the approver) in the coding-confirmation loop even when suggestions are
  high-confidence; the automation is in reducing that human's effort to "confirm" rather than
  eliminating their touch entirely.

---

## What Decimal should steal / avoid

**Steal:**
- Stampli's field-level (not invoice-level) confidence gate. Pre-filling only the fields the model
  is actually confident about, and leaving the rest blank for the human, is a better fit for
  Decimal's coding-inbox UI than an all-or-nothing per-invoice gate — it matches how the coding
  inbox modal already works (splittable line items, per-field edits).
- Stampli's "vendor is the strongest signal, changing vendor re-triggers prediction" rule. Cheap
  to implement, obviously correct, and prevents stale suggestions from surviving a header edit.
- Stampli's explicit ERP-mirror-and-resync framing for chart-of-accounts changes. Decimal's
  QBO-synced accounts should be the single source of truth the suggestion engine validates against
  at suggestion time, not something reconciled after the fact — this avoids ever suggesting a
  deactivated/renamed account.
- Publishing a tenure-qualified accuracy number ("90-95% for orgs with 12+ months of history")
  instead of an unconditioned "99%." More honest, and it sets the right expectation with new
  customers instead of over-promising on day one.
- GL table templates for recurring vendors/allocations — high leverage for AP teams with repeat
  vendors billed the same way every month (rent, SaaS subscriptions, split-by-department
  utilities), and reuses UI Decimal already has patterns for (coding inbox, split coding modal).

**Avoid:**
- Vic.ai's undifferentiated "99% accuracy" headline that blends extraction accuracy (invoice
  number/date/amount — genuinely easy, OCR-level) with coding accuracy (GL account selection —
  much harder, judgment-dependent). Decimal should track and report these separately internally,
  and never publish a single blended number externally.
- Fully autonomous "approve without human review" as a v1 goal. Given Decimal's users are
  currently ~1 month into the AP-approval-engine pivot and explicitly building a code-enforced
  gate as the moat, auto-posting past a confidence threshold without a human touch undercuts the
  product's own positioning (control/auditability) before trust is earned. Stampli's
  "always-confirmed-by-a-human" default is the safer starting posture; a Vic.ai-style full
  autopilot mode, if ever built, should be opt-in and per-org-configurable, consistent with how
  Decimal already treats separation-of-duties as org-configurable toggles rather than hardcoded
  behavior.
- Neither vendor publishes real technical detail on model architecture or confidence-score
  computation — don't assume there's a published best practice to copy verbatim here. Decimal
  will need to define its own confidence signal (e.g., similarity score against vendor's coding
  history + recency-weighted agreement) rather than looking for a reference implementation from
  either competitor.

---

### Sources
- https://www.vic.ai/how-it-works
- https://www.vic.ai/frequently-asked-questions
- https://www.vic.ai/accounts-payable/invoice-processing
- https://www.vic.ai/
- https://www.vic.ai/products/autonomous-approval-flows
- https://www.vic.ai/blog/the-unsung-hero-of-ai-accounting-historical-master-data-training
- https://www.stampli.com/resources/how-ai-invoice-processing-works/
- https://www.stampli.com/resources/invoice-gl-coding-fundamentals/
- https://www.stampli.com/blog/inside-stampli/meet-billy-stamplis-accounts-payable-ai/
- https://www.stampli.com/resources/invoice-coding-and-fields-in-accounts-payable/
- https://www.stampli.com/resources/invoice-coding-in-accounts-payable/
- https://www.stampli.com/resources/invoice-coding-fields-and-erp-alignment/
- https://www.stampli.com/gl-table-templates/

# How Ramp does GL coding for accounts payable

Research pulled from ramp.com blog, ramp.com/intelligence, support.ramp.com help center, and the AP Agents launch coverage. July 2026.

## 1. The coding workflow

**Where coding happens — everywhere in the bill lifecycle, not one screen.** Ramp's bill lifecycle runs Draft → Approval → Scheduled/In-Flight → Paid → History. Coding fields (GL account, department, class, location) can be touched at each of these points:

- **Draft stage**: when a bill is created (via forwarded email to `{company}@ap.ramp.com`, manual upload, or drag-and-drop of PDF/PNG/JPG/Excel/CSV/Word), Smart OCR extracts vendor, amount, line items, and the accounting-coding fields are populated separately by the "auto-coding agent." Customers can highlight regions of the invoice (e.g. the ship-to address) to steer a specific coding decision.
- **Approval stage**: "When enabled by an admin, approvers can also edit most bill fields during the approval process — including descriptions, dates, line items, and accounting fields." So approvers are not just gatekeepers, they can correct coding in place.
- **Post-payment**: fields including accounting codes remain editable after a bill is paid, as long as the accounting-system month isn't closed.
(Source: [Bill lifecycle](https://support.ramp.com/hc/en-us/articles/4417814078611-Bill-lifecycle))

For card/expense transactions (not bills), there's a dedicated **accounting review surface** in the Accounting tab with a "Suggested action" column (badges like "Mark ready," "Remind cardholders," "Review fields") and an optional "Smart Groups" beta that batches transactions by suggested action so a reviewer isn't context-switching between different types of work. (Source: [Ramp Accounting Agent admin guide](https://support.ramp.com/hc/en-us/articles/45051740591251-Ramp-Accounting-Agent-Enablement-Daily-Use-Admin-guide))

**Who does it — role split by company size, and AI increasingly does the first pass regardless of size.**
- Small companies: owner or single bookkeeper.
- Mid-size: dedicated AP staff or department managers.
- Large orgs: specialized AP teams with departmental workflows, sometimes hybrid (departments code locally, a central team reviews for consistency).
- **Controllers/finance managers don't code line items** — they own the framework: maintain the chart of accounts, set coding policy, and review coded data at month-end close.
- AP clerks do the actual line-matching, department/project tagging, and discrepancy resolution before routing for approval.
(Source: [Invoice Coding in AP Explained](https://ramp.com/blog/accounts-payable/invoice-coding))

Ramp's newer positioning (2026) pushes this further with "Agents for AP" — autonomous coding + fraud-check + approval-recommendation + payment execution, explicitly aimed at near-zero-touch processing, with humans reviewing recommendations rather than doing first-pass coding. 90,000 approval recommendations issued with a 90% acceptance rate is the cited proof point. (Source: [AP just became autonomous](https://ramp.com/blog/ramp-ap-agents-announcement))

**Line-item vs header-level coding.** Ramp explicitly codes at the line-item level, not just the bill header: "leading tools now extract individual line items, tax amounts, and payment terms at 99%+ accuracy, then map each line to the correct GL code based on vendor history and item descriptions." This is what lets a single invoice carry different GL codes per line (e.g., a mixed hardware+services invoice).

**Split coding across dimensions.** A single line/transaction can be split across multiple GL codes and dimensions simultaneously — department, project/class, location, cost center. Example given in Ramp's own materials: a $4,200 SaaS subscription coded as GL 6200-00 (Software subscriptions), Department 300 (Engineering), Cost Center CC-1020 (Product development), Project PRJ-045 (Platform migration) — four dimensions on one line. On the card/expense side this is done via "Splitting transactions or reimbursements," letting you divide one transaction into multiple lines each coded independently (category, department, location, or custom field). Advanced Rules also support **automatic splits**: a rule can be configured to auto-split a transaction by percentage or fixed amount across a saved split template or custom split, each portion getting its own department/location/category. (Sources: [Invoice Coding](https://ramp.com/blog/accounts-payable/invoice-coding), [Splitting transactions or reimbursements](https://support.ramp.com/hc/en-us/articles/360055243094-Splitting-transactions-or-reimbursements), [Managing Accounting Rules](https://support.ramp.com/hc/en-us/articles/7317831293203-Managing-Accounting-Rules))

Bulk coding is a first-class UX affordance for the reviewer: select transactions via checkboxes, filter down to a working set, then apply a field (e.g. Category) to all of them at once from a bottom toolbar; secondary fields like Location are reachable via a "..." menu next to "Mark as Ready." (Source: [Bulk Editing Accounting Tools](https://support.ramp.com/hc/en-us/articles/48376554725267-Bulk-Editing-Accounting-Tools))

## 2. Suggestion mechanics

Ramp layers three mechanisms, applied in a strict precedence order, with AI suggestions filling in what rules don't cover.

**Precedence order (highest to lowest):**
1. **Card / card-program rules** — always win.
2. **Advanced rules** (if/then, multi-condition) — beat simple mapping rules; among advanced rules, the more specific one (more input fields matched) wins.
3. **Standard mapping rules** (1:1 field mapping, e.g. Category → GL account) — applied after advanced rules. Within mapping rules there's a field-level pecking order too: for GL accounts, a merchant-based mapping beats a category-based mapping; same for vendor field.
4. **AI / auto-coding suggestions** — lowest priority. "Card rules and accounting rules take priority over AI suggestions. If a rule applies, Ramp will follow the rule instead." AI only fills fields that are still blank after rules run, and only when it has high confidence — it does not overwrite anything an employee, admin, or rule already set.
(Source: [Accounting rules and automation](https://support.ramp.com/hc/en-us/articles/7317831293203-Accounting-rules-and-automation))

**Vendor memory / defaults.** This is treated as a first-class, persistent object, not just a side effect of rules. Ramp's AP agent "studies the differences between the raw invoice scan and the finalized bills your team approved. It remembers every edit, learns the rule, and applies it next time" — i.e. every human correction becomes training signal specific to that vendor. On top of the passively-learned pattern, admins can give **explicit plain-English instructions** scoped to one vendor or globally (e.g. "Add service period to line items for this vendor," "Always pay net 60 from invoice date," "Aggregate line items into software and goods"). Explicit instructions and passively-learned history **stack** — "the AP agent combines what it observes with what you tell it." The system is also adaptive to behavior drift: if a team quietly switches a vendor from net-20 to pay-on-receipt, "the agent picks up on the shift — no rule changes required. It applies your current behavior, not what you did six months ago." (Sources: [Ramp's AP Agent That Remembers How You Process Invoices](https://ramp.com/blog/ap-agent-processes-invoices), [AP just became autonomous](https://ramp.com/blog/ramp-ap-agents-announcement))

**AI suggestions from line text / context.** Beyond vendor identity, the agent uses transaction memo, receipt content, requesting employee, and location as inputs, and for bills specifically can be pointed at a highlighted region of the invoice image (e.g., "ship to address") to drive a coding decision like location. GL suggestions on the expense side are described as informed by "how tens of thousands of accountants have coded similar expenses in Ramp" (cross-customer pattern matching), not just this org's own history — originally built on GPT-4. (Sources: [Managing Accounting Rules](https://support.ramp.com/hc/en-us/articles/7317831293203-Managing-Accounting-Rules), [Ramp Bill Pay OCR](https://support.ramp.com/hc/en-us/articles/45686841394579-Ramp-Bill-Pay-OCR))

**Conflict resolution summary:** rules > AI, specific rule > general rule, merchant mapping > category mapping, and within advanced rules more matched conditions = higher priority. Deleting a rule doesn't retroactively fix already-synced transactions, but on unsynced ones it can cause a less-specific rule (or AI, or nothing) to take over the field.

**Never-seen vendor.** Not explicitly documented in help center language, but inferable from the architecture: with no vendor history and no matching rule, the field falls through to general AI suggestion (informed by cross-customer patterns and the invoice content itself) at typically lower confidence, and low-confidence fields are visually flagged (see accuracy/trust section) for mandatory human review rather than auto-populated silently. The 60+ signal fraud-detection layer also runs on bills, which functionally doubles as new/unfamiliar-vendor scrutiny. (Source: [AP just became autonomous](https://ramp.com/blog/ramp-ap-agents-announcement))

## 3. Chart of accounts handling

**Sync mechanics.** Connecting an accounting provider (QuickBooks Online, QuickBooks Desktop, NetSuite, Xero, Sage Intacct, Workday, 40+ systems total, plus a Universal CSV export for anything unsupported) triggers Ramp to "automatically fetch essential data like your chart of accounts for precise spend classification." This is described as a **bi-directional sync**: GL codes/dimensions flow ERP → Ramp so the chart stays current, and coded transactions/bills flow Ramp → ERP for posting without manual re-entry. (Sources: [Overview of Ramp Accounting](https://support.ramp.com/hc/en-us/articles/4434982407443-Overview-of-Ramp-Accounting), [Invoice Coding](https://ramp.com/blog/accounts-payable/invoice-coding))

**Categories vs GL accounts.** Ramp does not force its own category taxonomy onto the ledger. It imports the provider's accounting fields (GL accounts + tracking dimensions) and "lets you decide which ones to use for financial transactions" in an Accounting Fields settings screen — i.e. Ramp's internal "Category" concept is a mapping layer on top of the real GL account list, not a replacement for it. This is also where the "conditional filtering" feature lives: admins can restrict which accounting-field options a given user sees based on their location, department, or other attributes, e.g. so a France-based employee is only offered France entity GL codes. (Sources: [Overview of Ramp Accounting](https://support.ramp.com/hc/en-us/articles/4434982407443-Overview-of-Ramp-Accounting), [Conditional filtering](https://support.ramp.com/hc/en-us/articles/18021104629139-Conditional-filtering))

**Dimensions.** Confirmed native dimensions synced/used alongside GL account: **Department, Location, Class, Vendor, Billable status**. These map directly to the standard QBO/NetSuite/Xero tracking-category concepts, not a Ramp-invented taxonomy. Multi-entity businesses get extra handling — see [Ramp support for multi-entity businesses](https://support.ramp.com/hc/en-us/articles/23815251559443-Ramp-support-for-multi-entity-businesses).

**No accounting integration.** Not explicitly documented in help-center prose found during this research, but the product answer is the **Universal CSV export**: without a live ERP connection, coded transactions still get GL/department/location/class values assigned inside Ramp (using a manually-maintained chart of accounts entered in Ramp itself), and periodic export replaces real-time sync. This wasn't confirmed with a direct quote — flagging as inferred, not sourced.

## 4. Accuracy & trust

Multiple accuracy claims appear across Ramp's marketing and product docs, not fully reconciled with each other (likely different products/measurement windows):

- **"90% of transactions auto-coded"** — customer-quoted stat on the general expense-coding side. (Source: [Ramp Intelligence](https://ramp.com/intelligence))
- **"85% of accounting fields right on the first pass"** for the AP Agent's line-by-line bill coding, explicitly framed as improving with every correction cycle. (Sources: [AP just became autonomous](https://ramp.com/blog/ramp-ap-agents-announcement), [AP Agent That Remembers](https://ramp.com/blog/ap-agent-processes-invoices), [Invoice Coding](https://ramp.com/blog/accounts-payable/invoice-coding))
- **"20% of manual coding automated"** via smart-coding suggestions in an earlier framing of the same feature set. (Source: [Announcing Ramp Intelligence](https://ramp.com/blog/announcing-ramp-intelligence))
- **90% acceptance rate** on 90,000 approval recommendations (a different metric — approval decisions, not coding fields). (Source: [AP just became autonomous](https://ramp.com/blog/ramp-ap-agents-announcement))

**Confidence display.** On the Accounting review screen, AI-coded fields carry a distinct **"Ramp Intelligence" icon** (described as blue) so a human can see at a glance which values were machine-set vs human-set. **Low-confidence AI suggestions render in yellow**, and hovering surfaces the reasoning ("who coded it and why"). This is a genuinely useful pattern: confidence is not a hidden score, it's a color + a hover explanation grounded in provenance (which bill/rule/instruction produced the value). (Source: [Ramp Accounting Agent admin guide](https://support.ramp.com/hc/en-us/articles/45051740591251-Ramp-Accounting-Agent-Enablement-Daily-Use-Admin-guide))

**Review/approval of coding.** Coding is not a silent background process — every AI-touched field stays editable through Draft → Approval → even Post-payment (pre-close). When an admin overrides an AI suggestion, Ramp pops a **feedback prompt** asking for a one-sentence reason (guidance given: "name the distinction, e.g., client vs internal") which is fed back into the model, but explicitly does **not** retroactively fix past entries — it only improves future suggestions.

**Auto-mark-ready / auto-sync gate.** Transactions/bills only sync to the ERP once marked "ready" — by a rule, by AI signal, or manually. Sync itself runs on a schedule (nightly at midnight in the docs referenced), decoupled from the coding decision itself, so "ready" is the actual control point, not "synced."

**Lock after close.** "As long as the month is still open" in the accounting provider, coding edits keep propagating on sync; once the provider-side month is closed, ERP-side coding can no longer be updated via sync (Ramp-side record can still be edited, it just won't push). Similarly, "managers usually cannot override accounting codes after month-end close to preserve data integrity" is stated as a general policy pattern, not universal — implies this is admin-configurable per org rather than hardcoded. (Sources: [Bill lifecycle](https://support.ramp.com/hc/en-us/articles/4417814078611-Bill-lifecycle), [How to Accurately Assign GL Codes](https://ramp.com/blog/gl-coding))

## 5. UX details worth copying

- **Suggested-action badges, not raw coding fields.** The Accounting tab doesn't just show a form to fill — it leads with a verdict badge ("Mark ready" / "Remind cardholders" / "Review fields"), and only expands to individual fields on demand. This reframes the reviewer's job from "code every transaction" to "triage the exceptions."
- **Smart Groups (beta): batch by suggested action**, not by vendor or date, to keep a reviewer in one cognitive mode (all "ready to mark ready" together, all "needs review" together) instead of switching mental models transaction to transaction.
- **Provenance on hover, not a modal.** Both the confidence color and the "who coded it and why" explanation appear inline on hover — no extra click, no separate audit-log screen for the common case.
- **Highlight-to-code on the source document.** Letting a user drag-select a region of the invoice image (e.g. ship-to address) and have that directly drive a coding field is a nice trust-building interaction — the human is pointing at evidence, not trusting a black box.
- **One-sentence correction capture.** The override-feedback prompt is deliberately minimal (one sentence, name the distinction) — low friction so people actually fill it in, versus a free-text "explain your reasoning" box that gets skipped.
- **Coding survives every lifecycle stage until close**, including post-payment — coding isn't a one-shot gate at bill entry; it's continuously correctable up to the real constraint (ERP month-close), which matches how AP actually works (corrections surface late).
- **Bulk actions target the review queue, not just individual rows** — checkbox + filter + bottom-toolbar apply pattern make coding hundreds of similar transactions a five-second action rather than N edits.
- **Rules stack with and are overridable via natural language**, not just structured condition builders — "Always pay net 60 from invoice date" as a first-class rule input lowers the barrier for non-technical AP staff to shape automation without learning a rule-builder UI.

## What Decimal should steal / avoid

**Steal:**
- The **rules-beat-AI, specific-beats-general precedence ladder** — cleanly solves "what wins" without needing a black-box arbiter. Card/vendor rule > advanced rule > mapping rule > AI suggestion, most-specific-wins within a tier, is a good default for Decimal's coding-inbox too.
- **Confidence as color + hover provenance**, not a numeric score buried in a tooltip. Cheap to build, immediately legible, and ties trust to "why" not just "how sure."
- **Vendor memory as persistent, inspectable object** (not just implicit weight in a model) that combines passive learning from corrections with explicit plain-English rules a human can set and see. This is very buildable for Decimal given the existing coding-inbox and OCR-suggestion work already shipped.
- **AI never overwrites a human/rule-set value, only fills blanks at high confidence** — a simple, safe default that avoids the "AI silently changed something a person set" trust failure.
- **One-sentence correction capture on override** as the feedback loop — low friction, high signal, feeds the vendor-memory system.
- **Suggested-action triage framing** over "review every field" — worth adopting once Decimal's coding inbox has volume; today with Decimal's smaller scale this may be premature, but the badge-first pattern is the right end state.

**Avoid / be skeptical of:**
- Ramp's own accuracy numbers are inconsistent across marketing pages (90% vs 85% vs 20% mean different things measured differently) — Decimal should pick one metric definition (e.g., "% of coded fields not corrected by a human before sync") and report it honestly rather than emulate the multi-number confusion.
- The "no accounting integration" story is thin/undocumented even for Ramp — Decimal shouldn't assume this is a solved, well-tested path; it likely needs real design work rather than copying an existing pattern.
- Full autonomous "Agents for AP" (auto-code + auto-approve-recommend + auto-pay) is a 2026 bet for Ramp with real fraud/trust surface area (they had to add a 60+ signal fraud layer to support it) — for Decimal, given the explicit design principle of a code-enforced approval gate and no floating trust, this is not a model to copy wholesale; keep AI suggestion-only with mandatory human sign-off, at least for the payment-authorization boundary (coding suggestions are lower-stakes and can be more aggressive).

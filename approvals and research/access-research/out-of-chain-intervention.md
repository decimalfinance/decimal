# Out-of-chain intervention in AP / procure-to-pay approval workflows

Research date: 2026-08-16.

## A note on research conditions (read before trusting the completeness of this doc)

Search tooling was badly degraded for this task: the session's web-search quota was already exhausted before this research started, a fallback search engine (Brave) answered the first ~15 queries and then hard rate-limited (HTTP 429) for the remainder of the session, and a second fallback (Bing via direct URL fetch) served correct results roughly half the time and unrelated/randomized results the other half (e.g. a query about "break glass" access returned English-grammar dictionary pages; a query about approval fallback returned pages about Taiwan). Several vendor help centers were also unreachable directly (TLS certificate errors on `help.bill.com`, DNS failure on `support.stampli.com`, 403s on `help.tipalti.com` and ICAEW/COSO org pages that only served navigation shells to the fetcher).

This means coverage below is **uneven by construction, not by choice** — some products have direct, quoted documentation; others have nothing because the tool genuinely could not retrieve anything, not because the feature doesn't exist. Every gap is called out explicitly rather than papered over. Treat silence on a vendor as "not found," never as "confirmed absent."

---

## 1. The real-world cases

I could not find any vendor, analyst, or audit-literature source that **quantifies** how often each case occurs (no source with a stat like "X% of bills sit waiting because the approver is on leave"). Nobody publishes this. What follows is the set of cases inferable from *what mechanisms vendors actually built* — a vendor building and documenting a specific feature is indirect evidence the underlying case is common enough to matter, but is not a frequency measurement.

- **Approver on leave / out of office.** Strong indirect evidence this is the dominant case: it is the *only* one of the candidate cases that has a dedicated, named, self-service feature ("Delegate" / "Approval Delegate") documented across multiple unrelated platforms (Coupa, SAP Concur, ServiceNow — see §2). No source quantifies frequency, but the universality of the feature is itself the signal.
- **Approver left the company.** Distinct from leave in that the delegation feature (self-service, time-boxed, set up by the departing person) doesn't work — the person is gone before they can hand off. This is the case that most plausibly forces an *admin*-initiated action rather than a self-service one, but I found no vendor doc that names this scenario specifically as distinct from "on leave."
- **Urgent payment / vendor threatening to cut off service.** Plausible and commonly discussed in AP practitioner content, but I found no vendor documentation describing a specific "urgent bypass" mechanism tied to this trigger. Not confirmed as a named product scenario — treat as inference from general AP domain knowledge, not sourced.
- **Chain misconfigured for this bill type.** No source found either confirming or describing product handling of this as a distinct case. Not researched successfully.
- **Dispute needing escalation.** Not found as a named case in any source retrieved. Plausible in general AP practice but not confirmed here.
- **Month-end close pressure.** Not found as a named case in any vendor source retrieved.
- **Approver not responding (non-leave, just slow).** This is the case SLA-timer escalation mechanisms (§2) implicitly address, but again, no vendor source frames it as a named, distinct scenario — it's inferred from the existence of timer-based escalation features in adjacent workflow platforms (see Camunda note in §2).

**Bottom line on Q1: none of the candidate cases could be confirmed as quantified or even individually named by vendors as a documented trigger.** The one case with real evidentiary support is "approver unavailable / on leave," and the evidence is indirect (feature universality), not a vendor statement of the underlying case.

---

## 2. The mechanisms, and which case each answers

### Delegation / out-of-office substitution — sourced, multiple vendors

This is the best-evidenced mechanism in this research.

**Coupa.** Delegation is self-service (the approver sets it up for themselves, not an admin acting on their behalf) and explicitly time-boxed:
> "Users can delegate their receiving and approvals to another user for a designated period of time by using the Delegates functionality."
— [KIPP TEAM and Family Help Center, Coupa Delegation](https://teamschools.zendesk.com/hc/en-us/articles/10818424215959-Coupa-Delegation)

A separate customer-published guide adds a real access-control constraint: the delegate must be *at least as privileged* as the person delegating —
> "assigned delegates must be of an equivalent or greater level of permissions"
— [Brandeis University, Approval Delegates (PDF)](https://www.brandeis.edu/business-finance/procurement-business/marketplace-plus/docs/approval-delegates.pdf)

Coupa's own data-export schema for delegations confirms delegation is logged with a start date, end date, the ID/login of whoever created the delegation record, and a free-text reason field:
> fields include "The day the delegation period begins," "The day the delegation period ends," "The user ID that created the approval delegation," "The reason for the approval"
— [Coupa Compass, Approval Delegates Export](https://compass.coupa.com/en-us/products/core-platform/integration-playbooks-and-resources/other-integration-playbooks/additional-csv-exports/approval-delegates-export)

I could **not** determine from available sources whether a delegate's approval is recorded under the delegate's own name or attributed back to the original approver in Coupa's audit trail — this specific attribution question is unanswered.

**SAP Concur.** Lower-confidence source (a customer community forum post, not official vendor documentation, and I could not load the full thread — only Brave's search-result snippet):
> delegate approvers "can be temporary (if your site is set up for this) or removed when no longer needed, very easily"
— [SAP Concur Community, "Adding a Delegate"](https://community.concur.com/t5/Concur-Expense-Forum/Adding-a-Delegate/m-p/85917) (snippet only, page itself returned 403 to direct fetch)

**ServiceNow** (general workflow engine, not AP-specific) runs *two parallel delegation systems* simultaneously by default — a legacy one and a newer "granular" one — selectable via a system property:
> the property `glide.approval.delegation.version` supports "v1 to support only the prior service delegation features... v2 to support only granular delegation... v3 to support both" (v3 is default)
— [ServiceNow Community, "Approvals and Delegation"](https://www.servicenow.com/community/now-platform-blog/approvals-and-delegation/ba-p/2283510)

I could not retrieve ServiceNow's official docs page body (`t_DelegateApprovalsTasks.html` returned only navigation chrome to the fetcher) to confirm who can configure delegation (self-service vs. admin-only) or how it is attributed in history — genuine gap.

**Jira Service Management** has a documented, named approval-delegation surface (page titles "Define approvers for a request type," "Allow customers to choose approvers" exist in the nav under [support.atlassian.com](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/)), but the body content of those pages was not retrievable — confirmed to exist, mechanics unconfirmed.

**Which case this answers:** approver on leave — this is a *self-service, time-boxed, pre-planned* substitution set up by the approver themselves (or possibly an admin on ServiceNow — unconfirmed), not something invoked reactively by an outsider after the fact. It does not by itself solve "approver already unreachable and didn't delegate in advance" or "approver left the company."

### Reassignment / rerouting by an admin

No vendor documentation was successfully retrieved that clearly separates "reassignment by an admin" from "delegation" as a distinct, named feature with its own rules (who can invoke it, whether the original approver stays on record). Salesforce's own product-idea backlog contains a customer request that is suggestive of a real gap in that platform:
> "Reassign existing approval records when Delegated Approver is set" — [Salesforce Ideas](https://ideas.salesforce.com/s/idea/a0B8W00000GddRuUAJ/reassign-existing-approval-records-when-delegated-approver-is-set)

This is a customer *asking* for reassignment behavior tied to delegation setup, which is indirect evidence that even where delegation exists, admin-driven reassignment of an *already in-flight* approval is a separate, sometimes-missing capability — but this is one unresolved product-idea ticket, not documentation of shipped behavior, and should be weighted accordingly.

### Ad-hoc approver addition mid-flight

Not found. No source retrieved describes a feature for inserting a net-new, previously-uninvolved approver into a single bill's chain mid-flight as a distinct capability.

### Escalation on an SLA timer

Not found for any named AP vendor. The clearest sourced material here is from **Camunda** (general-purpose BPMN workflow engine, not AP-specific), and it is useful mainly because it draws a sharp *conceptual* line that AP vendors don't publish:
> "Escalation events are events which reference a named escalation, and are used to communicate to a higher flow scope." "Unlike an error, an escalation event is non-critical and execution continues at the location of throwing." "If there are no escalation catch events that match the escalationCode, the escalation will not be caught... no incident is raised."
— [Camunda Docs, Escalation Events](https://docs.camunda.io/docs/components/modeler/bpmn/escalation-events/)

**Inference (mine, not sourced):** this maps cleanly onto what an AP "SLA reminder → escalate to manager" feature would need to do — notify a higher scope without halting or failing the underlying approval task — but I found no AP vendor that documents implementing escalation this way, or documents SLA-timer escalation at all. Treat the AP-specific application of this pattern as unconfirmed.

### Recall / withdraw and resubmit

This addresses a *different* case than out-of-chain intervention — it's the submitter pulling back a bill for correction, not an outsider stepping into someone else's approval slot. Per prior research already in this repo (`project_flow_research` — reject→resubmit loop, material-change restart policy), this mechanism is already covered and not re-derived here. Flagging only because the research brief listed it as a candidate: it does not actually solve the "someone outside the chain must intervene" problem, since the same original approver (or chain) re-evaluates after resubmission.

### "Force approve" / admin override / "break glass"

**No vendor documentation was found, for any product in scope, that names or describes a facility letting an admin directly supply an approval decision on a bill they were not routed to.** This is the central finding for Q3 — see below. I want to be explicit that "not found" here is weakened by the tool failures described at the top of this doc (Bing served unrelated results for the "break glass" and "force approve" queries specifically, and Brave was rate-limited before I could retry them), so this should be read as **"could not confirm either way with the tools available,"** not as a confident claim that no such feature exists anywhere.

---

## 3. The central question: can an admin substitute an approval decision, or only change who approves?

**This is the weakest-evidenced section of the whole research task, and that itself is a finding.**

What I could confirm:

- **Bill.com's public documentation actively suggests the answer is no**, and this is the one product where I got a clean, direct, textual check. I fetched the AP Bill Approvals API documentation and searched the actual page text for the words "reassign," "delegate," "override," "admin," and "unavailable" — **none of the first four appear at all**, and "Administrator" appears exactly once, naming it as one of three roles (Administrator, Accountant, Approver) with "permissions for bill approvals operations." [Bill.com Developer Docs, AP Bill Approvals](https://developer.bill.com/docs/ap-bill-approvals) The docs state plainly: "The bill cannot be paid until the approvers have approved the bill" — i.e., the actual assigned approver, not just any privileged user.

  Separately, Bill.com's own accountant-facing setup guide for the Approver role explicitly does **not** cover approval thresholds, approval chains, admin reassignment, or what happens if an approver is unavailable — a documented absence in Bill.com's own published material, not just my failure to find it. [Bill.com Accountant Resource Center, AP Setup Reference Guide: The Approver Role](https://www.bill.com/accountant-resource-center/articles/ap-setup-reference-guide-the-approver-role)

  Caveat: several `help.bill.com` community articles that likely cover this ground more directly (e.g. "Manage approval workflow and policies," "Manage Approvers on a bill or vendor credit") could not be fetched due to a TLS certificate error in the fetch tool used, not a content issue on Bill.com's side. So this finding is "not documented in the two Bill.com sources I could actually read," not "confirmed absent from Bill.com's product."

- **Coupa's delegation feature is structurally the closest thing found to a controlled admin-mediated substitute**, but it is still a delegation (the delegate approves *as the delegate*, per the export schema tracking who created the delegation and why), not a case of an admin directly entering an approval decision under their own identity for someone else's routed item. And its own access rule — delegate must hold equal-or-greater permission — reads as a designed guardrail specifically to prevent a *downward* substitution (i.e., prevents a junior admin from delegating a senior approver's authority to someone less qualified), which is suggestive of vendors treating this as a control-sensitive area worth constraining, even where I couldn't find the underlying design rationale documented.

- **For every other product in scope (Coupa's own "approve on behalf" wording, SAP Concur, Oracle NetSuite, Tipalti, Stampli, Ramp, Airbase, Workday), I was not able to retrieve documentation confirming or denying admin force-approve.** Search results for Airbase, Tipalti, Stampli, Workday, and NetSuite consistently failed to surface help-center content (returned marketing/login pages instead), and targeted queries for "force approve," "admin override," and "approve on behalf of" in an AP context returned no usable results before search tooling was rate-limited.

**Best answer I can support: no product in this research set was confirmed to offer admin force-approve, and the one product I could check in enough depth (Bill.com) has documentation that reads as consistent with *not* offering it.** But given how much of this section rests on absence-of-evidence from a degraded toolset rather than affirmative vendor statements, I'd treat this as a **directionally useful but not conclusive** answer. If this question is load-bearing for a design decision, it warrants a second research pass with working search tools, or direct product trials (most of these vendors offer free trials / demo sandboxes) rather than more doc-scraping.

**What was not found at all, from any source:** any vendor's own account of how a force-approve event (if one exists) is flagged in an audit report, or whether the original non-approving admin's action is distinguishable after the fact from a normal approval by the routed approver. Zero information obtained on this sub-question.

---

## 4. The audit / compliance angle (SOX, COSO, internal audit)

This is the strongest-sourced section, though still narrower than the brief asked for — COSO's own site could not be scraped (returned navigation only), so the authoritative-standard-body citation here is PCAOB, not COSO directly, with a practitioner blog as secondary color.

**PCAOB AS 2401** ("Consideration of Fraud in a Financial Statement Audit") is the primary authoritative source I could actually read. Key points, quoted directly:

- Management has a unique position to perpetrate fraud because it can "directly or indirectly manipulate accounting records and present fraudulent financial information," and "fraudulent financial reporting often involves management override of controls that otherwise may appear to be operating effectively."
- Named methods of override: recording inappropriate or unauthorized journal entries, making adjustments not reflected in formal entries, and directing employees to perpetrate fraud or soliciting their help.
- Override is treated as inherently hard to detect: "management override of controls can occur in unpredictable ways."
- The standard mandates specific auditor procedures in response (AS 2401 paragraphs .57–.67): examine journal entries for inappropriate/unauthorized activity, review accounting estimates for bias, evaluate significant unusual transactions for business purpose, test controls over financial reporting, and maintain professional skepticism throughout.
— [PCAOB, AS 2401](https://pcaobus.org/oversight/standards/auditing-standards/details/AS2401)

**Practitioner-level color (lower authority, useful for concreteness).** A CPA-authored explainer collects real override cases and detection guidance:
- WorldCom capitalizing expenses via unauthorized billion-dollar journal entries to inflate reported profit
- A company receiving $10M from a related party with minimal documentation ostensibly for "prior services rendered"
- Management lowering a reserve allowance from 90% to 50% to manufacture $400K of extra earnings
- A hospital CEO directing staff to wire company funds to personal accounts, threatening their jobs for non-compliance
- Recommended detection: test journal entries made at year-end, by unauthorized personnel, or to unusual accounts; use data-mining tools; do retrospective reviews comparing estimates year over year
— [CPA Hall Talk, Management Override of Internal Controls](https://cpahalltalk.com/management-override-internal-controls/)

**What I could not confirm, despite it being the highest-priority ask in this section:**
- I could not retrieve COSO's own Internal Control–Integrated Framework text on override (coso.org served only a navigation shell to the fetch tool). I cannot cite COSO directly.
- I confirmed that ICAEW maintains a dedicated guidance page specifically titled **"Addressing the risk of management override"** under its ISA-implementation resources — [icaew.com, Addressing the risk of management override](https://icaew.com/technical/audit-and-assurance/faculty-resources/implementing--isas-international/management-override) — which is itself a data point (a major professional body treats this as a named, standalone risk category worth its own guidance page), but I could not retrieve the page's actual guidance text (again, navigation-only content returned).
- I found **no source, anywhere, that directly addresses this research brief's most specific question**: is an admin who *can* approve anything (i.e., holds unrestricted override capability by design, not by abuse) itself considered a control deficiency, independent of whether they ever use it? This is a real, unanswered gap. My own read (**inference, not sourced**) is that this is likely covered under general segregation-of-duties / access-review guidance rather than a distinct "override capability" doctrine, since SOX ITGC practice generally treats broad standing access as a risk to be mitigated via periodic access review and compensating detective controls (e.g., an audit-committee-reviewed log of all such actions) rather than treating the mere *existence* of override capability as automatically disqualifying — but I have no citation for this and would not present it as researched fact.
- "Break glass" as a formal IT-governance/access-control term (used broadly in security and healthcare-IT compliance for emergency access outside normal authorization, always paired with mandatory post-hoc logging and review) is a real, established concept, but I obtained **zero usable search results** on it during this session — every attempt returned unrelated dictionary or trivia content due to the search-tool degradation described up top. I am naming the concept here from general knowledge, not from anything I sourced in this session, and it should be independently verified before being relied on.

---

## 5. The owner-is-everywhere problem: what happens when a chain resolves to no eligible approver

**I found no vendor documentation, from any product, that describes what happens when an approval chain resolves to zero eligible approvers.** This was one of the more actively pursued questions and it came back empty across Bill.com, Coupa, ServiceNow, SAP Concur, and every other product searched. No source confirms or denies:
- blocking the bill from being submitted at all,
- escalating to a fixed fallback role,
- auto-approving,
- assigning a designated admin,
- or falling back to the organization owner (our current behavior).

This is a genuine, clean gap — not a weak inference, an actual absence of retrievable information. Given how central this question is to your current design fork, I'd treat this as the single highest-value thing to re-research with working tools (or to check by hands-on trial in Bill.com/Coupa/Ramp free trials, several of which are self-serve signups) before committing to a direction based on "what others do," since nothing here supports a state-of-the-art claim either way.

---

## Strength assessment

**Strongest findings** (direct vendor/standard text, quoted, high confidence):
- PCAOB AS 2401 on management override of controls (§4) — authoritative standard, directly quoted.
- Bill.com's public API docs containing zero mention of reassign/delegate/override/unavailable, directly verified by searching the actual fetched page text (§3) — a clean, falsifiable check, not an inference.
- Coupa's delegation mechanics: self-service, time-boxed, equal-or-greater-permission constraint, logged with creator ID and reason (§2) — three independent sources agree.
- Camunda's escalation-vs-error semantics (§2) — directly quoted, useful conceptual scaffolding even though it's not AP-specific.

**Thin / low-confidence findings** (flagged individually above, collected here for visibility):
- SAP Concur delegation behavior — sourced only from a search-engine snippet of a community forum post, not the vendor's own docs, and not the full page.
- ServiceNow's dual delegation systems — sourced from a community blog, not official docs; official docs pages returned no usable body content.
- The Salesforce "reassign existing approval when delegate is set" idea ticket — a single unresolved customer request, not documented product behavior.
- The claim that no vendor in scope offers admin force-approve (§3) — genuinely unconfirmed either way for Concur, NetSuite, Tipalti, Stampli, Ramp, Airbase, and Workday; only reasonably well-supported for Bill.com.

**Outright gaps** (explicitly not found, not papered over):
- Frequency/quantification of any real-world intervention case (§1).
- COSO's own text on management override (§4) — could not access coso.org content.
- Whether "standing admin override capability" is itself a control deficiency under SOX/COSO, independent of use (§4) — no source found addressing this directly.
- "Break glass" access-control literature (§4) — zero usable results this session.
- Fallback behavior when an approval chain resolves to no eligible approver, for any vendor (§5) — the question most directly relevant to your current design fork, and the one with the least information recovered.
- Any documentation, for any vendor, of Tipalti, Stampli, Workday, or NetSuite's delegation/escalation/override mechanics (§2, §3) — search tooling could not surface their help centers at all.

If this research needs to actually move a decision (especially §3 and §5), the next step should not be more doc-scraping with degraded search tools — it should be either (a) a fresh research pass once search quota resets, or (b) direct hands-on trials of Bill.com, Coupa, and Ramp (all offer accessible trial/demo paths) to observe admin-side approval-management screens directly.

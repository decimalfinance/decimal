# Why AP separates "enter/code" from "approve" — and whether review and approve are genuinely different jobs

Research pass, 2026-08-16. Prior research established the WHAT (eight AP products all ship Clerk/Approver/Payer as separate roles). This pass is about the WHY: is enter-vs-approve a real control requirement, and are "review the details" and "approve the payment" actually different acts?

## Method note — search tooling was degraded

As warned going in: WebSearch hit a hard session budget wall immediately (0 results returned across 5 queries — "this session has used its web search budget"). DuckDuckGo, Mojeek, and Bing all either CAPTCHA'd or (Bing specifically) returned results for unrelated queries — e.g. a query for `"segregation of duties" accounts payable invoice approval` returned Wikipedia's *Racial segregation* article and Merriam-Webster's definition of "segregation"; a query about small-business AP controls returned PDF-compressor tools and dictionary definitions of "small." That is a genuine tool failure, not a lack of results — it's flagged here rather than papered over.

What worked: **direct fetches of known-URL primary documents** (GAO's Green Book PDF, ACFE's Report to the Nations PDF, Wikipedia's Segregation of Duties and Accounts Payable articles, three live PYMNTS Intelligence articles from 2025–2026). Everything below is sourced from that narrower set. Several avenues I tried and could not get through: AICPA, IIA (theiia.org), COSO's own site, Investopedia, AccountingTools, NetSuite, university (Yale/Princeton/Berkeley/MIT) internal-control policy pages, ACFE's own segregation-of-duties checklist detail, IOFM, Ardent Partners, Hackett Group — all 403'd, 404'd, or required JS I couldn't render. This materially thins coverage on Q4 (business vs. finance approver) especially. Flagged per-question below.

---

## 1. The control rationale — is enter≠approve a real requirement?

**SOURCED.** Segregation of duties (SoD) is a named control principle in both the COSO-aligned federal standard and general accounting practice, not a software convention.

The U.S. GAO's *Standards for Internal Control in the Federal Government* ("Green Book," GAO-14-704G — the federal government's adaptation of the COSO 2013 Internal Control–Integrated Framework, the standard nearly all SOX-404 work is built on) states it as a formal principle:

> "10.12 Management considers segregation of duties in designing control activity responsibilities so that incompatible duties are segregated... 10.13 Segregation of duties helps prevent fraud, waste, and abuse in the internal control system. Management considers the need to separate control activities related to **authority, custody, and accounting** of operations to achieve adequate segregation of duties. In particular, segregation of duties can address the risk of **management override**. ... Management addresses this risk through segregation of duties, but cannot absolutely prevent it because of the risk of collusion, where two or more employees act together to commit fraud."
> — GAO-14-704G, paras. 10.12–10.13

Critically, GAO's own definition of what gets segregated is **four functions, not two**:

> "Management divides or segregates key duties and responsibilities among different people to reduce the risk of error, misuse, or fraud. This includes separating the responsibilities for **authorizing** transactions, **processing and recording** them, **reviewing** the transactions, and **handling any related assets**..."
> — GAO-14-704G, Glossary, "Segregation of duties" (para. 10.13 cross-ref)

Note "reviewing" is listed as its own category, distinct from both "authorizing" and "processing and recording." This is direct evidence, from a COSO-lineage standard, that review and authorization are treated as conceptually separate control functions — which speaks directly to the user's question (see Q2).

Wikipedia's Segregation of Duties article (a secondary but well-cited summary, citing Botha & Eloff, *IBM Systems Journal* 2001) gives the classic accounting-specific version of the same model, older than any AP software:

> "With the concept of SoD, business critical duties can be categorized into four types of functions: **authorization, custody, record keeping, and reconciliation**. In a perfect system, no one person should handle more than one type of function."
> "The accounting profession has invested significantly in separation of duties because of the understood risks accumulated over **hundreds of years of accounting practice**."

The specific fraud scenario this addresses, per GAO: **management/employee override** — one person with both entry and authorization power can create a transaction and immediately bless it, with no independent check before money moves. ACFE's *Occupational Fraud 2024: Report to the Nations* (the largest fraud-case dataset in the field, ~1,900+ cases) quantifies the consequence rather than naming SoD directly: the top two contributors to occupational fraud were

> "a lack of internal controls (32%)... followed by an override of existing internal controls (19%). Taken together, this means that more than half of the cases occurred due to an insufficient system of internal controls."
> — ACFE, *Occupational Fraud 2024*, p.49

and ACFE's own fraud-prevention checklist lists "Proper separation of duties" and "Use of authorizations" as two **separate** checklist items under "strong anti-fraud controls" (p.103) — again treating segregation-of-roles and authorization-as-an-act as distinct control mechanisms, not one and the same.

**Verdict on Q1: SOURCED, and unambiguous.** Enter≠approve is a real, named control principle predating software, aimed specifically at preventing one person from creating and blessing a transaction alone (override risk), not a UI convenience.

---

## 2. What each person is actually attesting to — the heart of the question

**PARTIALLY SOURCED, partially INFERENCE.** This is where coverage is thinnest, because the sources that would spell this out precisely (AICPA audit guides, IIA practice guides, ERP-vendor role documentation with defined attestation language) were unreachable this pass.

What I can source: GAO's four-way split (Q1 above) explicitly separates:
- **Authorizing** the transaction (deciding it *should* happen / *should be paid*)
- **Processing and recording** it (entering, coding — creating the record)
- **Reviewing** the transaction (checking it, independent of having created it)
- **Custody** of the related asset (handling the money/instrument)

This is SOURCED evidence for a genuine three-or-four-way conceptual split, not two synonyms for the same check. Applied to AP: the person who enters/codes an invoice is performing the **recording** function — their implicit attestation is "this is what the invoice says, and here is where it belongs in the chart of accounts" (i.e., *the data is faithfully captured and classified*). The approver, performing the **authorizing** function, is attesting to something categorically different: "this transaction *should happen* — it's legitimate, it's ours, and it's cleared to be paid." Wikipedia's Accounts Payable page uses "**vouched**" for exactly this — an invoice is "approved for payment and has been recorded... as an outstanding liability" only once vouched, and separately describes the classic paper-era control: "a junior employee process and print a cheque and a senior employee review and sign the cheque" — again splitting *doing the mechanical work* from *authorizing the payment*, by seniority.

Where I could not find sourced material: a clean, explicit statement of "the approver certifies receipt-of-goods + price + budget + coding, while the clerk certifies only data-entry accuracy" — the kind of line-by-line attestation breakdown the question is really asking for. I did not find an AICPA/IIA source that spells this out at that level of granularity in this pass.

**INFERENCE, offered because it's directly responsive to your framing:** Your instinct — "if approve means checking correctness AND checking it's going to the right people, approve does both jobs" — is *partially* validated and *partially* contradicted by what I found. Validated: GAO's model shows recording (entering/coding) is a genuinely separate attestation from authorizing (approving) — someone who only enters data is not attesting to "should this be paid," only to "is this what the document says." That part of the split is real. Contradicted: nothing I found treats "checking the details are right" (price, coding, receipt) as the *same* act as "checking it's going to the right people" (a distinct fraud vector — vendor-identity/banking-detail fraud, business-email-compromise-style). GAO's model would put those under different functions too if pressed: "are the details right" is closer to **reviewing/reconciliation**, "should this be paid at all, to this party" is **authorization**. In a lot of real small-team practice these two get bundled into one "approve" click — which is exactly the pattern your product-role research already found (8/8 vendors collapse review+approve into one role called Approver). So: the theoretical control model says these are 3+ distinct functions; real-world SMB software practice collapses two of them (review + authorize) into one human decision while keeping recording (entry) and custody (payment release) separate. That collapse is a business/UX judgment call, not a violation of the underlying control logic — as long as *someone*, at some point, independently re-examines what the enterer created before money moves.

---

## 3. Three-way match — who does it, and is the approver re-checking or trusting it

**SOURCED (partial).** Wikipedia's Accounts Payable article states the classic sequence without fully naming the actor for the match step, but does isolate the approving manager as a distinct, separate check:

> "When the invoice is received by the purchaser, it is matched to the packing slip and purchase order, and if all is in order, the invoice is paid. This is referred to as the three-way match."
> "In the absence of a purchase order system, the first line of defense is the **approving manager**."

That second line is the key finding: it implies the three-way match (PO/receipt/invoice) is normally a *process/system* check performed upstream of or by AP — and where that system doesn't exist, the human approving manager becomes the **substitute** control, not a second check layered on top of it. That's evidence the match and the approval are understood as two different mechanisms aimed at the same risk (paying for something you didn't order/receive), one automatable, one not.

The most current sourced material (PYMNTS Intelligence, "Duplicate Invoices Expose the Weakest Link in Supply Chains," 2025 — cites the PYMNTS/Finexio *Accounts Payable Tracker* series) is explicit that the match and the approval are kept as separate, both-required controls even in an automated system:

> "Automated systems must still enforce three-way matching among purchase orders, receipts and invoices; segregate duties so that no individual can create and approve the same invoice."
> "AI and automation act as amplifiers, making it possible to flag duplicates **before** they become overpayments... [but] **final authorization still rests with finance staff**."

**Answer to "does the approver re-verify or trust the match":** based on this, the approver is expected to **trust** that the three-way match (a mechanical/system-level check on quantities and prices) has run and passed, and to decide something **else** — final authorization, i.e., should this specific payment go out. This is consistent with the GAO four-function model: three-way match ≈ reconciliation/reviewing function; final approval ≈ authorization function. They're not redundant checks on the same thing; the match checks "does this transaction reconcile against evidence," approval checks "should this transaction execute."

**Gap:** I could not source a document that names the specific job title/role that runs the three-way match (AP clerk vs. a dedicated "matching" role vs. pure system automation) — only that it's separate from the approving manager's decision.

---

## 4. Business approver vs. finance approver

**THIN — mostly INFERENCE, one weak data point.** I was not able to reach any source (university policy, AICPA/IIA guide, ERP vendor documentation) that explicitly documents a two-tier "budget-holder confirms it's ours to pay" + "finance/controller confirms coding and compliance" structure as distinct, named steps. This was the weakest-covered question this pass, entirely due to tool failures (every university AP-controls page I attempted 403'd or 404'd, and search couldn't find alternates).

The one data point I have is indirect: PYMNTS' "final authorization still rests with finance staff" (Q3 above) implies at least some organizations treat "finance staff" authorization as the terminal/definitive approval step, distinct from earlier flags/checks — consistent with a two-tier model where a department/business signal happens first and finance has last word — but this is a single line in a trade-press article, not a documented process, and I'm not confident generalizing from it.

**INFERENCE, clearly labeled as such:** Given how consistently the eight AP products in the earlier research all shipped a role that's business-context-aware (knows "we ordered this") separately from a role that's compliance/coding-aware (knows "this hits the right GL account and passes policy"), it's very plausible real companies run two logically distinct approvals even when software only exposes one "Approver" bundle — but I do not have a primary source confirming this for this report. Recommend treating this as an open question rather than a settled finding; a follow-up pass specifically against IIA's GTAG series or a SOX 404 walkthrough template (neither reachable this pass) would likely resolve it.

---

## 5. Has automation changed it

**SOURCED (light, but real and current).** PYMNTS Intelligence content (2025–2026, drawing on PYMNTS/Finexio's *Accounts Payable Tracker* series) is the only automation-trend material I could retrieve. Two findings:

1. Nobody in what I retrieved argues the review/check step should **disappear**. The framing throughout is automation **augments** the check, doesn't replace the need for one: "AI and automation act as amplifiers, making it possible to flag duplicates before they become overpayments" — but "final authorization still rests with finance staff." The human decision point is preserved even as the mechanical checking (three-way match, duplicate detection) is automated.
2. The stated failure mode automation is fixing is **fragmentation**, not the existence of a review step itself: "Manual and fragmented accounts payable... workflows... create blind spots where duplicates can pass unnoticed" — described as "one of the biggest risk vectors for invoice fraud," with 63% of CFOs (per PYMNTS data cited in-article) citing delays from manual AP workflows.

**Gap:** I could not reach Ardent Partners, IOFM, or Hackett Group directly (all attempts 403'd or the search infra that would have found specific reports was down), so I cannot confirm or deny that any named analyst is making the stronger claim you asked about — that the clerk role is *collapsing into* the approver role as capture automates (i.e., "confirm what the machine read" merging with "decide if it's right"). That would be a natural next thing to check with working search.

---

## 6. Small-company reality

**SOURCED.** Both ACFE and Wikipedia's SoD article address this directly.

ACFE, *Occupational Fraud 2024*, on why small orgs are more exposed:

> "Small organizations typically have limited resources to invest in their anti-fraud programs... This leaves these organizations particularly vulnerable to fraud, as the **smaller staff size typically means there are fewer checks and balances and less segregation of duties in place**."
> (Fig. 30 shows small orgs — under 100 employees — have anti-fraud controls at roughly half the implementation rate of larger organizations across every control category measured, e.g. external audit 59% vs. 91%, management certification 47% vs. 85%.)

Wikipedia's SoD article gives the standard prescription for what to do when you can't fully separate: **compensating controls**, defined and exemplified:

> "When duties cannot be separated, compensating controls should be in place. Compensating controls are internal controls that are intended to reduce the risk of an existing or potential control weakness."

Named compensating mechanisms from that article: **audit trails** (who did what, when — reconstructable transaction history), **independent reconciliation/verification** performed after the fact, **exception reports reviewed at supervisory level** (with a signature requirement), **transaction logs**, and **supervisory review through observation and inquiry**. The common thread across all five: if you can't split the *act*, you add an **independent, after-the-fact look** by someone who didn't do the original work — i.e., the segregation moves from "different people touch different steps in real time" to "one person acts, a different person checks the record later."

**Applied inference (labeled as such):** for a small team where the same person genuinely must enter and approve, the GAO/ACFE material supports two concrete minimum-viable patterns rather than "just don't bother": (a) a periodic independent review of everything that person approved (owner/controller spot-checks after the fact), or (b) hard-coded exception routing — anything above a threshold, or to a new payee, forces a second person regardless of normal workflow. Neither of these is explicitly written as "for AP" in what I retrieved, but both are directly drawn from the sourced compensating-control list above, not invented.

---

## Strong / thin / gap assessment

**Strong:**
- Q1 (control rationale is real, not a software artifact) — GAO Green Book + ACFE, directly on point, high confidence.
- Q6 (small-company compensating controls) — ACFE stats + Wikipedia's named mechanisms, directly on point.

**Thin (sourced but incomplete):**
- Q2 (what each role attests to) — the four-function GAO model is real and does answer "are they different things," but I lack a document that spells out the AP-specific attestation content (goods received / price / budget / coding) at the granularity the question wants.
- Q3 (three-way match ownership) — I have the *shape* of the answer (match ≈ reconciliation, approval ≈ authorization, approver trusts the match rather than redoing it) but not a named job title performing the match.
- Q5 (automation's effect) — real, current (2025–2026) sourcing that automation augments rather than removes the check, but I could not reach analyst-tier sources (Ardent Partners/IOFM/Hackett) to check for the stronger "clerk role collapsing into approver" claim.

**Gap — treat as unanswered, not answered by inference:**
- Q4 (business approver vs. finance approver as genuinely distinct, documented steps). I have one indirect trade-press line and nothing else. This is the question closest to your actual product decision, and it's the one I have the least real evidence for. If this matters for the roadmap call, it's worth a dedicated re-run once search tooling is working, targeted specifically at IIA GTAG documents, a SOX 404 AP walkthrough template, or ERP vendor (SAP/Oracle/Workday) role documentation — none of which I could reach this pass.

**On tooling:** WebSearch was dead for the entire session (budget exhausted before this task started). Three alternative search engines (DuckDuckGo, Mojeek, Bing) were all effectively non-functional — CAPTCHA-walled or returning content unrelated to the query. Everything above came from direct fetches of specific known URLs, which is a much narrower net than a working search tool would have cast. This should be re-run with working search before treating Q4 or the deeper parts of Q2 as settled.

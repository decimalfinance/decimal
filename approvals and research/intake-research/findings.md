# Intake research: sourced findings

Three research passes run 2026-08-06 against the open questions in
`cases-and-actions.md`. Kept because the useful part is the sourcing and the
evidence grading, which is easy to lose and expensive to redo.

Evidence grading is deliberate: several widely-repeated claims in this space
turn out to be practitioner folklore rather than agency guidance, and one of
them was in our own design note.

---

## A. Fraud and provenance (Gate 3, Gate 6)

### Well-evidenced

**Scale.** FBI IC3 puts BEC second by dollar loss in 2025: **$3.05B across
24,768 complaints**, up from $2.77B in 2024; **$50.8B cumulative** 2013–2022.
([IC3 2025 report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf),
[IC3 PSA 230609](https://www.ic3.gov/PSA/2023/psa230609))

**Vendor impersonation is the growth area, not CEO fraud.** AFP's 2025 survey
found vendor impersonation hit **45% of organisations, up from 34%**, overtaking
executive impersonation. This is precisely our threat model — we are an inbound
vendor-invoice pipe.
([2025 AFP Payments Fraud survey](https://7185359.fs1.hubspotusercontent-na1.net/hubfs/7185359/Research%20Surveys/SURVEYS/2025%20Payments%20Fraud%20and%20Control%20Survey%20Report%20Comprehensive.pdf))

**Out-of-band verification on payment-detail changes is the load-bearing
control.** CISA, IC3, FTC and UK bank guidance converge without contradiction.
"Out of band" has a precise meaning: verify through a channel *different from
the one carrying the request*, using contact details *already on file*. It
explicitly excludes replying to the email, calling a number printed on the
invoice, or following a link in it.
([CISA](https://www.cisa.gov/news-events/alerts/2015/06/24/business-email-compromise-continues-swindle-and-defraud-us-businesses),
[IC3 PSA 230609](https://www.ic3.gov/PSA/2023/psa230609))

**The control demonstrably works.** UK Finance reports invoice-and-mandate fraud
losses at a record low of **£41.3m in 2024** — the smallest APP-fraud category —
attributed to sustained industry investment in exactly this control. Useful
because it makes the gate an investment with evidence behind it rather than a
guess.
([UK Finance Annual Fraud Report 2025](https://www.ukfinance.org.uk/system/files/2025-05/UK%20Finance%20Annual%20Fraud%20report%202025.pdf))

**Email authentication proves nothing about legitimacy.** SPF/DKIM/DMARC verify
the sending domain. An attacker who registers a lookalike domain passes all
three trivially. Treat "authenticated" as necessary, nowhere near sufficient.
([CISA phishing guidance](https://www.cisa.gov/sites/default/files/2025-03/Phishing%20Guidance%20-%20Stopping%20the%20Attack%20Cycle%20at%20Phase%20One%20508.pdf))

**The hardest case has exactly one signal.** In vendor email compromise the
attacker is inside the real mailbox: domain matches, authentication passes,
the thread is genuine. Nothing in the envelope helps. The only reliable signal
is **a payment-detail delta against last-known-good** — which is the check we
already have, and it is doing more work than its size suggests.

### Corrected our own claim

We wrote that replying to an unknown sender "confirms a live monitored mailbox".
That reasoning appears only in vendor security research — no FBI, CISA, NCSC or
FTC source states it. The *conclusion* (don't reply to the inbound thread) is
still right, but the sourced reason is different: never use contact details
supplied by the suspicious message. `cases-and-actions.md` has been corrected.

### Thin evidence — do not over-claim

- No authoritative ranking of sub-mechanisms (account takeover vs lookalike
  domain vs thread hijacking) by loss. Vendor blogs rank them; agencies don't.
- **No agency guidance at all on auto-reject vs quarantine for invoices.** The
  DMARC quarantine/reject distinction is about mail delivery and should not be
  mapped onto payment decisioning. Practitioner consensus favours hold-for-
  review; that is a product-policy decision we own, not a researched best
  practice.

---

## B. Document type (Gate 1)

### The two expensive confusions have mechanical markers

**Statement of account** — lists invoices already in the system, so paying it
double-pays all of them. Markers: the word "Statement" / "Statement of Account";
"Balance Forward"; an "Aging"/"Ageing" column with 0-30/31-60/61-90 buckets;
and the strongest structural tell — **more than one distinct invoice number in
the line-item table**, where a real invoice carries exactly one that refers to
itself.

**Credit note** — money owed *to us*; paying it is a sign error. Markers in
descending reliability: the title "Credit Note"/"Credit Memo"; a `CN-`/`CM-`
numbering series; **a mandatory reference to the original invoice it corrects**
(a credit note cannot exist standalone); a negative total or "Amount Credited"
instead of "Amount Due".

Explicitly *not* reliable, despite being common folklore: red text, and "Do not
pay" boilerplate. Use only as corroboration.

**Cost of getting it wrong, indirectly.** No source isolates "statement paid as
invoice" as its own statistic. The containing category: SAP Concur finds
**1.29% of processed invoices are duplicates at ~$2,034 each**; APQC puts
erroneous disbursement at **0.8–2% of AP spend**. Mostly sloppy process, not
fraud.

### No cloud API solves this

Verified rather than assumed:

- **AWS Textract `AnalyzeExpense`** does not classify subtype at all. It will
  extract vendor/total/date from a statement exactly as readily as from an
  invoice, with nothing in the response to distinguish them.
- **Azure Document Intelligence** is the only one with a real classification
  API, and there is **no prebuilt classifier** for invoice vs statement vs
  credit note — you train your own, minimum 5 labelled samples per class. Its
  `splitMode: auto` is the best-documented mechanism for multi-invoice PDFs.
- **Google Document AI** has per-type processors and a procurement
  splitter/classifier, but you still route the file yourself.

Treat IDP vendor accuracy claims (Rossum, Klippa, Nanonets, Docsumo) as
marketing until measured on our own mix.

### Recommendation, with a caveat

**Deterministic rules as a hard gate, feeding a cheap classification call —
not a field bolted onto the extraction schema.**

Reasoning: our two worst outcomes both have near-mechanical textual markers, so
they are a rules problem, not a judgement problem — auditable, deterministic,
free. Adding `documentType` to the existing extraction schema is the weakest
option precisely because *the schema presupposes an invoice*, biasing the model
toward the answer we most need it to question. The harder cases (proforma vs
commercial, self-billing authenticity) justify a separate cheap classification
call whose only job is "what is this, is it payable", gating whether the
expensive extraction runs at all.

Caveat stated by the research: no vendor-neutral benchmark compares these
approaches for these confusions. This is reasoned architecture from how the most
transparent vendor (Azure) actually builds it, not an empirical result. Validate
the rule set against real forwarded traffic before trusting it as the only gate.

### The VAT angle — the one positive signal

EU Directive 2006/112/EC Art. 226 and HMRC both mandate a specific field set for
a valid tax invoice: sequential invoice number, supplier VAT ID, per-rate VAT
breakdown, VAT amount. Their presence is strong positive evidence of a genuine
tax invoice — but useless for US domestic invoices, so it is a supplementary
signal, not a universal one.
([Art. 226 explainer](https://www.vatupdate.com/2022/05/12/eu-vat-directive-2006-112-ec-explained-art-226-content-of-an-invoice/))


---

## C. What AP platforms actually let people click (section 3)

Six platforms, from their own help centres and API docs rather than marketing:
Bill.com, Ramp, Tipalti, Coupa, Stampli, AvidXchange.

### The finding that changed our design

**"Reject" is not a universal primitive.** AvidXchange's app has no Reject
permission at all — cross-checked against its exhaustive permissions list.
Tipalti has no Reject action and no Rejected status on bills. Both split it:

| Platform | Internal correction | Vendor-facing | Terminal |
|---|---|---|---|
| Tipalti | Send back to AP | Dispute | Delete |
| AvidXchange | — | Dispute (To/CC named people) | Void (no resurrection) |
| Coupa | — | Dispute (structured reason codes) | Reject — terminal |
| Bill.com | Deny (resets whole chain) | — | — |
| Ramp | Reject → edit &amp; resubmit | — | Archive |
| Stampli | Reject (pre-posting) | — | Void (post-posting) |

Coupa's Reject is a dead end: the documented remedy is *create a new invoice*.
AvidXchange's Void is stricter still — "cannot be reinstated", start from a new
upload. Meanwhile Tipalti's Send back and Dispute are both reversible. Same
word, opposite semantics, depending on the product.

### Rare, and therefore our opportunity

**A first-class "ask a question" exists in only two of six.** Stampli treats it
as an explicit verb ("approves, rejects, or questions it") on a messaging thread
that vendors join *without a separate licence*. AvidXchange's Dispute is
documented as exactly this, addressed manually to named people via To/CC.

The other four have nothing. Ramp's own community forum carries a live customer
request for @mentions, because "the only way to notify [a non-approver] is to
add them as an approver." Bill.com's nearest equivalent is Deny + comment, which
**resets the entire approval chain** — destructive, not a park.

### Autonomy is more common than the marketing admits

Four of six ship a documented, config-gated **auto-approve** path with no human
click: Ramp (recurring series, imported bills), Tipalti (PO-matched lines within
tolerance), Coupa (in-tolerance invoices skip the chain entirely), Stampli
("Skip Approval", with duplicate/variance flags as an automatic kill switch).

Coupa is the only one with documented **auto-reject** — its Process Automator
acting on admin-authored rules, not model judgement.

Stampli's framing is the one worth stealing: *"auto-approval is safe when it's
designed as a control, not an absence of one."*

### Actions worth stealing outright

- **Retract approval** (Tipalti) — undo your *own* approval while payment has
  not gone out. On an irreversible rail this is the last stop-point that exists.
- **Mark as synced** (Ramp) — "already paid outside the system", purely to
  prevent double payment at reconciliation.
- **Vendor-level hold** (Ramp) — blocks all current *and future* payments to a
  vendor in one click.
- **Retract / approve on behalf** (Tipalti) — approval is not a one-way ratchet,
  and delegation is explicit rather than implied by task assignment.
- **Ultimate approver** (Coupa) — documented as a circuit breaker for *broken
  approval configuration*, explicitly not a bigger-limit approver.

### Duplicate handling splits two ways

Hard block on import (Ramp's accounting sync: "we won't import a bill if one
exists with the same vendor and invoice number", no override; Coupa: duplicate
invoice numbers auto-trigger a Dispute) versus flag-and-let-a-human-clear
(Bill.com, Tipalti's "Mark as non-duplicate", Stampli's confirmed/potential
two-tier). Ramp logs a required reason on dismissing a high-severity alert.

Ours is currently the second kind, admin-clearable with a logged reason, which
puts us with the majority and matches the irreversibility argument.

### Low confidence — do not build on these

AvidXchange's duplicate UI (no authoritative source found at all); whether
Stampli's or Coupa's plain reject notifies anyone externally; whether Ramp's or
Stampli's reject reason is free text or a picklist. Coupa's internal AP-reviewer
screens generally sit behind a customer login, so its entries lean on API and
config docs more than the other five.

# Intake: what can happen, and what we let people do about it

Status: design note, no implementation. Written 2026-08-06 after a bill addressed
to another company reached review reading "Ready for approval".

## Why that bill got through

Not because the model missed anything. It extracted `billToName: "Halcyon Labs,
Inc."` correctly. The failure was that nothing downstream was *shaped* to carry
that fact to a person. The check existed, matched loosely, and lived as an
ad-hoc `if` inside the review builder rather than as a rule. The list screen
never consulted it at all.

That is worth naming precisely, because it is the pattern this document exists
to prevent: **we extract more than we surface, and we surface more than we make
actionable.** Each of those gaps is where a wrong payment hides.

## The trap in "enumerate all the cases"

The case space is open-ended. Invoices are documents produced by every kind of
business on earth with no enforced standard, arriving through email, which
accepts anything. Any list we write is incomplete the week we write it, and a UI
built as one screen per case would be unbuildable and unusable.

The action space is not open-ended. Across every case below, there are **eight
things a human can actually do**. That asymmetry is the design.

So the goal is not an exhaustive case list. It is:

1. A **closed set of actions** (section 3) that the UI implements once.
2. A rule that **every case routes to at least one action** — including cases we
   have not thought of, which land on a generic "needs a human" path rather than
   silently passing.
3. Cases enumerated (section 2) mainly to *test* that the action set is
   sufficient, and to decide each case's **default**.

The expensive, slow part is not enumeration. It is deciding the default action
per case and who is allowed to take it. That is the work.

## The principle that sets our defaults

**Our rail is irreversible.** Bill.com can be wrong and claw an ACH back. We
cannot. A wrong on-chain payment is gone.

Every AP tool's exception handling is tuned for a world with recourse. Ours
should not be a copy of theirs. Where they optimise for throughput and recover
the rare mistake, we should be willing to stop more often, because our mistakes
do not have a recovery path.

Concretely: **when in doubt, ask — never auto-proceed, and never auto-reject
either.** Auto-reject destroys a real payable and annoys a real vendor; both
failure directions are real, so the default for genuine ambiguity is always a
question routed to a named human, not a decision made for them.

---

## 1. Where things go wrong

Eight gates, in the order a document passes them. Ordering matters: it is
pointless to run extraction quality checks on a document that is not an invoice,
and pointless to check whether an invoice is ours if the email never carried a
document.

```
0  Delivery          did a document arrive at all?
1  Document type     is it an invoice?
2  Ownership         is it ours?
3  Provenance        who sent it, and may they?
4  Extraction        did we read it correctly?
5  Vendor identity   who is this, and do we know them?
6  Payment details   where does money go, and has that changed?
7  Commercial        do we actually owe this, once?
8  Policy            are we allowed to pay it?
```

Gates 4, 6, 7 and 8 are where our ten existing rules live. **Gates 0, 1, 2 and 3
are essentially unimplemented.** That is the finding: we built the gates that
check arithmetic and fraud, and skipped the ones that check *what this document
even is and where it came from*.

---

## 2. The cases

Marked `[have]` where something in the code addresses it today, `[partial]`
where it exists but is weak, `[none]` where nothing does.

### Gate 0 — Delivery

| Case | Now |
|---|---|
| Email with no attachment; invoice is in the body text/HTML | `[none]` |
| Attachment is not a document (.zip, .docx, .xlsx, screenshot) | `[none]` |
| PDF is password-protected or encrypted | `[none]` |
| Scan with no text layer, skewed, cropped, or illegible | `[partial]` low confidence only |
| Several attachments — which are invoices? (invoice + W-9 + contract) | `[none]` |
| Signature-block logos arriving as attachments | `[none]` |
| Invoice buried in a quoted reply chain | `[none]` |
| Same email forwarded twice | `[partial]` duplicate catches it late |
| Attachment download fails | `[have]` retry queue |
| Non-English invoice | `[none]` |

The logo-as-attachment case is worth calling out: it is the single most common
source of junk in every inbound-email AP product, and today it would become a
bill.

### Gate 1 — Is it an invoice?

Each of these is a document that *looks* like an invoice to a model asked to
extract invoice fields — because we never ask it whether it is one.

| Case | Consequence if missed |
|---|---|
| Statement of account (summarises invoices already in the system) | **Double-pays every invoice on it** |
| Receipt / paid confirmation | Pays something already paid |
| Quote, estimate, or proforma | Pays something not yet owed |
| Purchase order we issued | Pays our own paperwork |
| Credit note (money owed **to** us) | Sign error — pays out what we should receive |
| Dunning letter referencing an existing invoice | Duplicate payment |
| Contract or SOW with amounts in it | Pays a contract value, not an invoice |
| Marketing material with prices | Junk bill |
| Several invoices in one PDF | Only the first is captured |

All `[none]`. The statement and credit-note cases are the expensive ones.

### Gate 2 — Is it ours?

| Case | Now |
|---|---|
| Bill-to is a different company | `[have]` as of today |
| Bill-to is our subsidiary, DBA, or former name | `[none]` — will false-positive |
| No bill-to on the document at all | `[none]` — currently silent |
| Addressed to an employee personally, not the company | `[none]` |
| Right group, wrong legal entity | `[none]` |

Note the tension: hardening the name match (today's fix) makes the
subsidiary/DBA case worse. The real fix is an org-level list of "names we also
trade as", not a cleverer string comparison.

### Gate 3 — Who sent it?

Unimplemented, and the highest-leverage gate we do not have. Provenance is what
decides the *action* for most other cases.

| Case | Signal |
|---|---|
| Vendor sent direct from their known domain | Normal |
| Employee forwarded | Normal; ask them when unsure |
| Sender domain does not match the vendor on the invoice | Impersonation |
| Unknown external sender, unknown vendor | Highest risk |
| Reply-to differs from sender | Classic BEC marker |
| Lookalike domain (`acme-corp.com` vs `acmecorp.com`) | Targeted fraud |

### Gate 4 — Did we read it right?

| Case | Now |
|---|---|
| Field absent from the document | `[partial]` shown as "Not on document" |
| Field present, low confidence | `[have]` `low_extraction_confidence` |
| Field genuinely unreadable | `[have]` for wallets only |
| Two candidate totals on the page | `[have]` `amount_ambiguous` |
| **Line items do not sum to subtotal** | `[none]` |
| **Subtotal + tax does not equal total** | `[none]` |
| Currency symbol ambiguous (`$` = USD/CAD/AUD/SGD) | `[none]` |
| Date format ambiguous (03/04/2026) | `[none]` |
| Decimal format ambiguous (`1.234,56`) | `[none]` |
| Extracted address landed in a field the UI never reads | `[have]` as of today |

The arithmetic checks are cheap, deterministic, need no model, and catch real
extraction errors. They are the best value-per-line on this page.

### Gate 5 — Who is the vendor?

| Case | Now |
|---|---|
| Known vendor, exact match | `[have]` |
| Genuinely new vendor | `[have]` info flag |
| Fuzzy match ("Acme Inc" vs "Acme Incorporated") — merge or create? | `[none]` |
| Two existing vendors both match | `[none]` |
| Vendor renamed or rebranded | `[none]` |
| Vendor on hold or blocked | `[have]` |

Left alone, fuzzy matching quietly creates duplicate vendor records, which then
defeats duplicate detection, which is a gate we rely on.

### Gate 6 — Payment details

Best-covered gate, because it is where fraud was already modelled.

| Case | Now |
|---|---|
| Bank details differ from what we hold | `[have]` blocking |
| Wallet address invalid or OCR-ambiguous | `[have]` blocking |
| Near-duplicate wallet address | `[have]` blocking |
| No payment details anywhere | `[none]` |
| **Payment details in the email body, not the invoice** | `[none]` — the standard BEC vector |
| Method we cannot pay | `[none]` |

### Gate 7 — Do we owe it, once?

| Case | Now |
|---|---|
| Exact duplicate | `[have]` blocking, admin-clearable |
| Near duplicate (same vendor and amount, different number) | `[partial]` |
| Already paid | `[none]` |
| Amount disagrees with the PO | `[none]` |
| Policy requires a PO and none is referenced | `[none]` |
| Already past due on arrival | `[none]` |
| Dated in the future | `[none]` |
| Very old / stale | `[none]` |
| Tax implausible for the jurisdiction | `[none]` |

### Gate 8 — Are we allowed to pay it?

| Case | Now |
|---|---|
| Over the org bill ceiling | `[have]` |
| Vendor held or blocked | `[have]` |
| Category unbudgeted | `[none]` |
| Needs a specific approver | `[have]` via approval engine |

---

## 3. The eight actions

This is the part that becomes UI. Everything above resolves to one of these.

| # | Action | What it does | Who |
|---|---|---|---|
| 1 | **Fix** | Edit a field inline and confirm it | Reviewer |
| 2 | **Ask the sender** | Question to whoever forwarded it; bill waits | Reviewer |
| 3 | **Ask the vendor** | Outbound question; bill waits | Reviewer |
| 4 | **Reject** | Close with a typed reason | Reviewer |
| 5 | **Link** | Attach to an existing bill, PO, or vendor instead of creating new | Reviewer |
| 6 | **Hold** | Snooze to a date or pending a condition | Reviewer |
| 7 | **Escalate** | Route to a named person or role | Reviewer |
| 8 | **Override** | Proceed anyway, with a logged reason | Admin only |

Reject needs typed reasons, not free text, because the reason determines what
happens next and what the vendor is told: *not ours, duplicate, already paid,
not an invoice, disputed, wrong amount, cannot verify sender.*

**Where AI-native actually shows up.** Not in extracting fields — everyone
extracts fields. It shows up here: the system picks the right action, pre-fills
it, and the human clicks once. "This is addressed to Halcyon Labs. **Ask Priya**
(who forwarded it) / **Reject as not ours**" with the message already drafted
beats a red banner that leaves the person to go find Priya in Slack.

The rule that keeps it honest: **the AI proposes and drafts; the human commits.**
It never sends, rejects, or pays on its own. Given an irreversible rail, that
line is not negotiable.

---

## 4. The question: the bill is not ours — reject, or ask?

It depends entirely on Gate 3, which is why that gate matters more than it looks.

| Who sent it | Default | Why |
|---|---|---|
| **Employee forwarded it** | Ask the sender | They have context we lack — it may be a subsidiary, a rebrand, or a genuine mistake. Rejecting silently makes us look broken to our own user. |
| **Vendor sent it direct** | Reject "not ours" and notify | Little ambiguity: they misdirected it. The notification is the useful part — it gets the invoice to the right payer. |
| **Unknown external sender** | Quarantine, do not reply | **Never auto-reply.** A reply confirms a live monitored mailbox to whoever is probing it. Route to an admin instead. |

That last row is the one that would not have come up without asking the
question, and it is a genuine security decision rather than a UX preference.

---

## 5. What actually needs research

Most of this does not. AP exception handling is a mature domain and the taxonomy
above is largely derivable from the pipeline plus first principles. Being honest
about that matters, because the instinct to research everything is what turns a
two-week job into a two-month one.

**Settle from our own code — no research needed:**
- Which cases our current extraction can already detect versus which need new
  fields. (Most of Gate 4 and all arithmetic checks need nothing new.)
- What our ten rules cover and where the gaps are. Done, section 1.
- Whether `addressed_elsewhere` should become a real rule. It should.

**Genuinely worth researching, in priority order:**

1. **BEC and invoice-fraud vectors.** The one area where being wrong is
   expensive and the literature is real and specific (FBI IC3 reporting,
   payment-detail-change patterns, lookalike domains). Directly sets Gate 3 and
   Gate 6 defaults. *Highest value.*
2. **Competitor action vocabularies** — not their feature lists, their *verbs*.
   What can a Bill.com / Ramp / Tipalti / Coupa user actually click on an
   exception, and what does rejecting do to the vendor? Validates section 3 is
   complete. We have run this shape of research three times already
   (`roles-research/`, `flow-research/`, policy); same method, about six
   platforms.
3. **Document-type classification.** Whether a standard taxonomy exists for
   invoice vs statement vs credit note vs proforma, and how others detect it.
   Gate 1 is entirely unbuilt and contains our two worst outcomes.
4. **Audit and legal.** Who may reject, what must be retained, and whether
   receipt of an invoice starts any clock we would be interfering with. Narrow,
   but it constrains permissions, so it should land before we build them.

**Not worth researching:** the case list itself. Enumerate it ourselves from the
pipeline, then let research 1 to 3 tell us what we missed.

---

## 6. Suggested order

Deliberately not "build the UI last" — the whole point is that the missing thing
was never extraction, it was the path from a known fact to a person who can act.

1. **Make flags a first-class concept** rather than an ad-hoc list built inside
   the review query. One place that produces flags, consumed by review *and*
   list *and* approvals. Today's fix papered over this by computing the same
   check twice. Prerequisite for everything else.
2. **Cheap deterministic checks** — the arithmetic in Gate 4, plus
   `addressed_elsewhere` as a real rule. No model, no research, immediate value.
3. **Gate 3 (provenance)**, because it determines the default action for
   everything else. Needs research item 1.
4. **The eight actions**, built once, generically.
5. **Gate 1 (document type)**, needs research item 3.
6. Everything else, by frequency observed once real invoices flow.

Step 1 is the one to resist skipping. The bug found today was not a missing
check — the check existed. It was that a fact had no structured path to a
screen. Any number of new checks built on the current shape will reproduce that
failure.

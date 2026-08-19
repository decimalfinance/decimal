# When the document is not a bill

Status: design note, no implementation. Written 2026-08-19, testing the B series.
Follows `cases-and-actions.md`, which enumerated nine non-invoice document types
and marked statement and credit note as the expensive ones.

## What testing showed

A statement of account from Meridian Logistics reached the draft screen as a
bill: vendor filled, three line items coded to Shipping & delivery, a total of
$35,350, and a Confirm button. The document says $22,950.

Nothing was broken. `looks_like_statement` fired (deterministic: more than one
invoice reference in the lines), `lines_do_not_sum` fired, Confirm throws on any
blocking flag, and a statement has no clear-and-pay resolution — only "Close
it". The document cannot be paid.

But the three "line items" are not charges. They are references to three other
documents, one of which the statement itself marks **Paid**. The extraction kept
invoice number, date and amount, and dropped the status column — the single most
important column on a statement, and the difference between "you owe this" and
"you already sent this money". Paying a statement is the classic double-payment
route in AP, and it happens exactly because a summary gets treated as a bill.

Worth noting how thin the protection actually is. If every row on that statement
had been Open, the lines would have summed to the balance due and
`lines_do_not_sum` would have stayed silent. Two flags fired, but only one was
ever load-bearing.

## The shape of the problem

We extract, then flag. By the time the document is classified, it has already
been shaped into a bill — fields filled, lines coded, total computed, Confirm
offered. Every one of those says *this is payable*.

The order is backwards. Decide what the document is, then choose the screen.

## One interface, not nine

`cases-and-actions.md` lists nine non-invoice types: statement, receipt,
quote/proforma, our own purchase order, credit note, dunning letter, contract
with amounts, marketing material, several invoices in one PDF. A bespoke screen
each is nine screens to build and keep true.

One shape covers all of them, answering three questions:

1. **What this is** — named plainly, with the evidence that says so.
2. **What it refers to** — the type-specific body. This is where they differ.
3. **What to do instead** — the actions, which also differ by type.

It must not look like a bill. No editable field grid, no line-item table with
category pickers, no Confirm. Someone who has seen fifty bills should know from
the shape of the screen, before reading a word, that this one is different.

## The body is where the value is

### Statement of account — reconcile it

The useful thing about a statement is not that we refuse it. It is that a
statement tells you what the vendor thinks you owe, and we can check that
against what we hold:

| Reference | Amount | What we have |
|---|---|---|
| MER-8801 | $12,400 | paid — 2026-07-02 |
| MER-8842 | $13,150 | in approval, waiting on Marcus |
| MER-8890 | $9,800 | **not in the system** |

That last row is the whole point. A vendor sends a statement so you can find the
invoice you never received. Today we treat a statement as a threat to be
refused; this treats it as information, and ends with a useful action — upload
the missing invoice.

It also surfaces the dangerous row honestly: MER-8801 is listed on a document
somebody might have been about to pay, and it is already settled.

### Credit note — say what it is worth and to whom

A credit note means the vendor owes us. The body should name the invoice it
applies to (CN-0442 says "Applies to invoice VP-3390"), whether we hold that
invoice, and whether it is still open. The action is *apply against a bill*,
never *pay*.

Every accounting system models this as its own transaction type — vendor credit,
credit memo — separate from a bill, precisely because the action is different. We
do not need that object yet, but the screen should stop pretending it is a bill.

### The rest

Receipt, quote, our own PO, dunning letter, contract, marketing material: the
body is a sentence or two and a reference if there is one. They are cheap
because nothing is owed and nothing needs reconciling. Multi-invoice PDFs are
their own problem — the useful action is "split this into three bills" — and
should be treated separately from this note.

## How much of this is actually AI

Worth being precise, because "AI-native" done badly means reaching for a model
where a join would do.

| Step | How |
|---|---|
| Classify the document | model, plus the deterministic tells we already have |
| Read the rows and the status column | model, structured output |
| Match a reference to a bill we hold | **a query** — invoice number + vendor |
| "You are missing MER-8890" | **derived from the query**, template |

Only the first two are model work. The reconciliation is a join, and it should
stay one: it makes the answer reliable rather than probabilistic, and it is the
part a person will act on. The model's job is turning a PDF into structure; the
system's job is knowing what that structure means against its own records.

## Where classification should live

Document type becomes a first-class fact recorded at intake, not a flag derived
later in the draft builder. The flags stay — they are the safety net and they are
deterministic — but the screen should be chosen from the type, not from whether
a flag happens to be blocking.

## What NOT to do

**Do not create a second object model yet.** Every upload currently creates a
payment order in draft, which is also the container for the document, the audit
trail, questions, and history. Splitting that is a large change with a long tail.

The cheaper shape: keep the payment order, record the document type on it, and
let the type pick the screen and forbid the payable path. Reversible, and it
gets the whole benefit of this note without a migration.

**Do not make the lines sum to the balance due.** That would quiet
`lines_do_not_sum` and leave a statement that reads like a clean bill. The
disagreement is the signal.

**Do not build this before the extraction changes.** The screen and the
extractor are the same fix from two ends. A statement screen fed by an extractor
that still turns references into charges is a nicer presentation of the wrong
data.

## Sequencing

After the C, D and E test series. Current behaviour is safe — nothing can pay a
statement or a credit note — so this is a clarity and usefulness feature, not a
correctness one. It wants doing in one piece: classify at intake, record the
type, choose the screen, and reconcile.

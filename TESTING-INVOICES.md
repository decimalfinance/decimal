# Invoice requirements for testing the Draft → Approval → Pay pipeline

Brief for whoever generates the synthetic invoices. **Every invoice below exists
to make one specific branch or gate observable.** If an invoice doesn't change
what the product does, it isn't worth generating.

The existing `synthetic_data/` invoices predate the pipeline rewrite and route
through paths that no longer exist. Treat them as unusable.

---

## Context: the flow they must exercise

Testing Labs (`testing-labs@bills.decimal.finance`) routes on **amount**, on
whether it's a vendor's **first bill**, and nothing else:

| Condition | Chain |
|---|---|
| ≥ $10,000 | Marcus + Tom + Ines + Sam (any 3 of 4) → Nadia |
| ≥ $1,000 | Marcus → Tom or Ines |
| first bill from a vendor | Ines or Sam |
| otherwise | any of Marcus / Tom / Ines / Sam |
| after approval | Dara Mensah releases |

The org is **Testing Labs**, so every invoice must be **billed to "Testing Labs"**
unless the test is specifically about a misaddressed bill.

---

## A. Routing coverage — one per branch (4 invoices)

Plain, clean invoices. No flags, figures that reconcile. Their only job is to
land in the right chain.

| # | Amount | Vendor | Purpose |
|---|---|---|---|
| A1 | $24,800.00 | a vendor used in A2/A4 | high-value, 3-of-4 quorum then controller |
| A2 | $4,500.00 | same vendor as A1 | mid-band, sequential then any-of-two |
| A3 | $312.40 | a vendor appearing **nowhere else** | first-bill branch |
| A4 | $312.40 | same vendor as A1 | routine branch — same amount as A3, different chain |

A3 and A4 being the same amount is the point: it proves the split is on vendor
history, not money.

## B. Draft-stage gates — bills that must NOT reach approval (6 invoices)

Each should be blocked at Confirm with a specific flag.

| # | What to make wrong | Expected flag |
|---|---|---|
| B1 | Billed to **"Halcyon Labs, Inc."** instead of Testing Labs | addressed elsewhere |
| B2 | Line items sum to $4,000 but the total says $4,820 | lines do not sum |
| B3 | Subtotal $4,000 + tax $320 but total $4,820 | total does not reconcile |
| B4 | Exact duplicate of A2 — same vendor, same invoice number, same amount | possible duplicate |
| B5 | A **statement of account** listing several prior invoice numbers | looks like a statement |
| B6 | A **credit note** (negative total, or a CN-/CM- series number) | looks like a credit note |

B4 must be byte-different from A2 as a file but identical in its figures —
otherwise the sha256 dedupe catches it at intake and it never reaches the gate.

## C. Extraction difficulty — the AI should struggle honestly (5 invoices)

These test that low confidence surfaces rather than being guessed at.

| # | Make it |
|---|---|
| C1 | A photographed paper invoice, slightly skewed, shadow across one corner |
| C2 | A scan at ~150 DPI, legible but soft |
| C3 | Multi-page (3+), with the total on the last page only |
| C4 | A layout with two columns and the remit-to address in a footer |
| C5 | Handwritten amount or a stamped "PAID" overlapping the total |

## D. Shape variety — realistic mess (5 invoices)

| # | Make it |
|---|---|
| D1 | 20+ line items, so the per-line coding has something to chew on |
| D2 | A single line, no tax, no PO |
| D3 | Foreign currency (EUR or GBP) — should be refused as unsupported |
| D4 | A vendor whose name nearly matches an existing one ("Brightwave Media Ltd" vs "Brightwave Media") |
| D5 | No invoice number at all |

## E. Payment-path (2 invoices)

| # | Amount | Purpose |
|---|---|---|
| E1 | $850.00 | clean bill for the full walk: draft → approve → release by Dara |
| E2 | $150,000.00 | above any sane ceiling — tests the over-ceiling block |

---

## Format requirements

- **PDF preferred**, one invoice per file. Images (PNG/JPEG/HEIC) welcome for
  section C — that's the point of C1/C2.
- Realistic vendor names, addresses, invoice numbers, dates. Dates within the
  last 90 days; due dates 15–45 days out.
- **Line items must carry a description, quantity, unit price and amount** —
  approval routes on amounts, and a line without one blocks Confirm by design.
- Include a remit-to address and bank details on most; leave them off a couple
  deliberately, so the "unreadable payment details" path gets exercised.
- File names should say what they are: `A1-high-value-24800.pdf`,
  `B4-duplicate-of-A2.pdf`. The tester needs to know what they're opening.

## What NOT to do

- Don't make every invoice pathological. Sections A and E must be **clean** —
  if everything is broken, a real flag stops standing out.
- Don't reuse invoice numbers across vendors except where B4 requires it.
- Don't bill anything to a company other than Testing Labs except B1.
- Don't generate hundreds. 22 invoices covering distinct behaviour beats 200
  that all take the same path.

## How they'll be used

Forwarded to `testing-labs@bills.decimal.finance` or uploaded on the Bills
screen, then prepared by a Bill Clerk (Priya or Omar), confirmed, and routed.

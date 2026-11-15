# Decimal

Accounts-payable software with agents built into the work. A bill arrives by upload or email. Decimal reads it, gives each line a Category, flags what looks wrong, and investigates duplicates and figures that don't add up. Then it routes the bill for approval and posts it to QuickBooks Online or Xero. A person checks every bill before it goes for approval, the team's approvers approve it, and nothing reaches the books before that.

**Status.** Everything up to and including posting to the books is built. Paying the bill isn't built yet. There is no hosted version yet.

## What happens to a bill

1. **It arrives.** Someone uploads it or forwards the email. A PDF holding several invoices becomes one bill per invoice, each with its own pages.
2. **Decimal reads it.** A model reads PDFs, scans and photos into fields. Where a value can be found on the page, clicking it shows where it came from.
3. **Each line gets a Category.** A line the team has coded before for the same vendor gets the same Category. Otherwise the model suggests one, and the bill marks it as a first guess.
4. **Decimal checks it.** Flags catch duplicates, figures that don't add up, credit notes, statements, bills addressed to another company, vendors on hold and bills over the team's ceiling. For a duplicate, or figures that don't add up, an agent starts investigating as soon as the bill arrives.
5. **People approve it.** Rules the team draws in a flow builder decide who.
6. **It's posted to the books.** Once approved, it goes into QuickBooks or Xero with the invoice attached.

## Where the AI works and where it stops

The rule throughout: **the model decides what to do next; code decides what is allowed and does anything that must be exact.**

- **Agents recommend, people act.** No agent approves a bill, closes one or writes to the books. A recommendation is a button a person presses. It goes through the bill's own endpoints as that person, so permissions and checks apply at the click.
- **Code checks the reading against the document.** On a PDF with a text layer, code looks for the total and the invoice number in the document's text. One that isn't printed there is marked for a person, and the bill can't be sent until someone checks or changes it. Doubt comes from the model's status for each field, not its confidence score: that came back 0.98 for clean PDFs and creased photos alike. Where code can't check, as on a scan, the bill says so.
- **Code does the arithmetic.** When the arithmetic investigator proposes a correction, code checks that each amount is printed on the line it cites and that the corrections close the gap to the cent. An answer that fails goes back to the model with the reason, twice at most, and is then marked unsure.
- **Findings cite evidence.** A finding has to cite records its tools returned in that run. Figures that contradict a verdict cut its confidence to low.
- **Recommendations don't go stale.** Each investigation is tied to a fingerprint of the figures it saw, and runs again when they change.
- **The setup agent can't write to the books.** It holds a read-only view of them, and everything it saves stays in Decimal. Bills reach the books only through the posting code, after their own approval.
- **Agreement is recorded.** Suggested Categories and the investigators' recommendations are logged with what the person then did.

## The agents

| Agent | What it does | How it was measured |
|---|---|---|
| **Reading bills** | Reads a PDF, scan or photo into structured fields. A PDF with a text layer takes a cheaper text-only path. | A one-off run of 31 synthetic invoices on Claude Haiku 5.5 (8 Nov 2026): 28 read exactly as expected, the one in euros refused (Decimal only makes bills in US dollars), and both credit notes flagged as credit notes. About $0.001 per invoice. |
| **Duplicate investigator** | When two bills look like the same bill, it compares them, reads both documents' text (a scan has none, so it works from the extracted fields) and checks the vendor's history. It decides between a duplicate, a replacement, not a duplicate, and unsure, and recommends what to do: close the copy, close the bill a correction replaced, clear the flag, or ask someone. | 7 synthetic pairs, run three times on Claude Haiku 5.5 (12 Nov 2026): all 21 verdicts right, none confidently wrong. The pair the documents can't settle (same line and amount, nine days apart, no invoice numbers) came back "unsure" each time. |
| **Arithmetic investigator** | When a bill's lines and tax don't reach its total, it reads the document line by line and works out why: a charge the reading missed, a figure misread, or the document disagreeing with itself. It proposes the exact correction. | 6 synthetic cases, three runs on Claude Haiku 5.5 (12 Nov 2026). Every answer that came back was right. In the last run all six came back, and all five corrections applied and added up; the two earlier runs each lost one case to a network error or a timeout. Under a tenth of a cent and 2 to 3 seconds a check. |
| **Accounting setup** | Sets up QuickBooks or Xero in a conversation with an admin. The admin signs in, Decimal reads 24 months of the books and asks about what it found: look-alike vendors, a line coded two ways, the closing date. Posting starts only when the admin presses Go. What it learns codes each vendor's first bill in Decimal. | 18 scripted setups on made-up companies. A model plays the admin, code checks what was saved, and a second model flags anything Decimal said that was wrong; both run on Claude Opus 5.5, Decimal on Claude Haiku 5.5. QuickBooks: 15 to 17 of 18 across five runs (8 and 9 Nov 2026). Xero: 13, 17 and 16 of 18 across three runs (9 and 12 Nov 2026). Decimal's own model calls for all 18 cost about $0.17. |
| **Companion** | Answers questions about bills, the team and the approval rules in a chat, and suggests next steps as cards a person clicks. Its tools are read-only and see only what the person asking can see. | Tested against a hostile scripted model: every tool with malformed arguments, reads across organisations, smuggled requests. "Changed nothing" is checked by fingerprinting every business table before and after. A 38-case red-team script runs it against a real model. |

The investigators, the setup agent and the companion share one tool-calling loop (`api/src/exceptions/agent.ts`). Every AI call runs on Claude or OpenAI, whichever has a key, Claude first when both do unless `AI_PROVIDER` says otherwise. The default model is Claude Haiku 5.5. All test documents are synthetic.

## Approvals

An approval engine built for Decimal, in three stages: review, approve and release (release belongs to payment, which isn't built).

- Admins draw the rules as a tree on a canvas, splitting by amount, vendor, Category or a vendor's first bill.
- Separation of duties is three settings the organisation controls, not rules in the code.
- An overdue approval escalates after 72 hours. Nothing is ever denied automatically.
- A bill sent back goes to review with the reason; it is never a dead end.
- A sender can ask for a bill back. It stops where it is until the recall is granted or refused.

## Posting to the books

- **Connecting only reads.** Posting starts when an admin presses Go, which records who said yes and when. Only bills approved after that are posted.
- **A bill posts at the approved total.** Decimal reads it back afterwards and compares the totals. If they differ, the bill is held for a person and never sent again.
- **It looks for the same bill keyed in by hand** before posting. On a QuickBooks sandbox, QuickBooks accepted a second bill with the same number from the same vendor without a warning.
- **Retries carry the same key:** QuickBooks request ids and Xero idempotency keys. On Xero's Demo Company, a key sent again after one minute and after nine and a half minutes brought back the same bill.
- **Closed periods.** A bill dated in a period the books have closed posts on the first open day and keeps its own due date.
- **Checked against the real services.** QuickBooks posting on an Intuit sandbox (8 Nov 2026), including the invoice file reading back byte for byte. Xero posting on Xero's Demo Company (12 Nov 2026).

## Not built yet

- **Paying the bill.**
- **Currencies other than the US dollar.**
- **Tax rates on lines, and tracking categories (Xero) or classes, locations and items (QuickBooks).** A line carries only its Category, and tax goes on a line of its own.
- **Password reset and invitation emails.** An admin copies the invitation link and sends it.

The full list is in [`docs/OPEN-WORK.md`](docs/OPEN-WORK.md).

## How it's built

- **API:** TypeScript, Express, PostgreSQL through Prisma, with the schema written as plain SQL in `postgres/init/`. Payloads are validated with Zod. Bill amounts are stored as integers in minor units, never floats.
- **Frontend:** React, Vite and TanStack Query.
- **AI:** one provider switch for Claude and OpenAI (`api/src/infra/ai.ts`).
- **Evals:** the duplicate and arithmetic investigators and the companion have scripts that run them against a real model: [`exception-eval.mts`](api/scripts/exception-eval.mts), [`arithmetic-eval.mts`](api/scripts/arithmetic-eval.mts) and [`companion-redteam.mts`](api/scripts/companion-redteam.mts). The invoices they use are made by `scripts/invoice-gen/` and aren't committed.
- **Tests:** about 780 API tests. The agents are tested through scripted models, and `make test` blanks the AI keys, so no test can call a paid model.
- **Size:** about 115,000 lines of TypeScript, 22,000 of them tests, and over 900 commits since March 2026.
- **Built with coding agents.** [`CLAUDE.md`](CLAUDE.md) holds the rules agents follow in this repo. [`TESTBENCH.md`](TESTBENCH.md) describes the bench: a separate stack where an agent checks a change by using the product in a real browser.

## Where to look

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the system is built, subsystem by subsystem. Start here. |
| [`docs/OPEN-WORK.md`](docs/OPEN-WORK.md) | Designed but not built yet. |
| [`CLAUDE.md`](CLAUDE.md) | Rules and commands for coding agents in this repo. |
| [`TESTBENCH.md`](TESTBENCH.md) | How a change gets checked in a real browser by an agent. |
| [`TESTING-INVOICES.md`](TESTING-INVOICES.md) | How the synthetic invoices the evals run on are made. They're generated locally, not committed. |

Built by Zaid Khan ([@fuyofulo](https://github.com/fuyofulo)).

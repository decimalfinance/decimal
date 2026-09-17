# Decimal

Accounts payable for companies that pay vendors across borders. A bill comes in, Decimal reads it, a person checks it, it gets coded to the ledger, the right people approve it, and it syncs to QuickBooks Online.

## What is built

- **Intake.** Upload a bill or forward it by email. Decimal reads PDFs, scans and photos into structured fields and shows where on the document each value came from.
- **Review.** A workbench of bills by state, a review screen with the document beside the fields, flags for duplicates and vendor problems, and a question-and-comment thread on every bill.
- **GL coding.** Each line is coded to an account from rules, then vendor history, then a model, with a catch-all. Corrections are remembered.
- **Approvals.** An in-house engine with three configurable stages, a visual Flow Builder, policies, prebuilt roles, separation of duties, recall, and out-of-office substitutes.
- **QuickBooks Online.** OAuth connection, chart-of-accounts sync, and bill sync.

## What is not built

**Paying the bill.** A Squads treasury on Solana settling in USDC is wired into the codebase and tested against an in-memory chain, but it has not been developed since August 2026 and no real payment has executed. It is an open product question.

## Run it

Requires Docker and a current Node LTS.

```bash
cp api/.env.example api/.env    # then fill in the secrets
make dev                        # http://localhost:5174
```

```
make dev     start everything
make test    run all tests
make reset   wipe local data
make stop    stop everything
make bench   isolated stack for agent-driven testing
make help    show this list
```

## Where to look

| | |
|---|---|
| `docs/ARCHITECTURE.md` | How the system is built, by subsystem. Start here. |
| `CLAUDE.md` | Rules and commands for AI agents working in the repo. |
| `docs/OPEN-WORK.md` | Designed but not yet built. |
| `TESTBENCH.md` | How changes get verified in a real browser by an agent. |
| `frontend/src/pages/PAGE-PLAYBOOK.md` | The design system contract for every page. |
| `approvals and research/` | The research behind approvals, roles, policies, coding and intake. |

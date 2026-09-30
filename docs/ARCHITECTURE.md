# Architecture

How Decimal is built, by subsystem. Each section opens with its status so a reader knows how much to trust it as a foundation.

Verified against the code on 2026-09-17; the exception agent section on 2026-09-24. When you change a subsystem, update its section in the same commit.

| Status | Meaning |
|---|---|
| **Live** | In daily use, actively developed. Build on it. |
| **Frozen** | Wired, tested and reachable, but not developed since mid-August 2026 and not proven in production. Do not extend without a product decision. |

## What the product does

Decimal is an accounts-payable product. A bill arrives by upload or forwarded email. A vision model reads it into structured fields. A person checks it, the system codes each line to a ledger account, and an approval flow routes it to the right people. Approved bills sync to QuickBooks Online.

The final step, paying the bill, is the frozen part. See [Payment execution](#payment-execution-frozen).

## Repo layout

```
api/            Express + Prisma API on PostgreSQL. ESM TypeScript, run with tsx.
frontend/       React + Vite + TanStack Query operator UI.
postgres/init/  Ordered, idempotent SQL. The source of truth for the database schema.
scripts/        Shell scripts behind the Makefile, plus the test-invoice generator.
config/         Committed, non-secret runtime config.
docs/           This file, open work, and frozen reference material.
.design-sync/   Pipeline that publishes UI primitives to the external Claude Design project.
```

Code comments that cite a `*-research` document refer to a research folder that was removed. `docs/OPEN-WORK.md` explains how to read it from git history.

## Runtime (Live)

One Docker Postgres on port `54329` holds three databases that cannot see each other.

| Database | Used by | API | Frontend |
|---|---|---|---|
| `usdc_ops_local` | `make dev`, what a human looks at | `:3100` | `:5174` |
| `usdc_ops_bench` | `make bench`, what an agent drives | `:3200` | `:5274` |
| `usdc_ops_test` | `make test`, truncated on every run | | |

`api/src/index.ts` starts the HTTP server and then four background workers:

- `registerPaymentApprovalBridge()` connects approval outcomes to bill state.
- `startSettlementReconciler()` verifies on-chain settlement. Frozen subsystem.
- `startAccountingSync()` pushes and pulls QuickBooks data.
- `startInboundEmailIntake()` turns forwarded emails into draft bills.
- An approval timer sweep escalates overdue approval tasks. It never auto-denies.

## Request pipeline (Live)

`api/src/app.ts` mounts middleware and routers in a deliberate order.

1. Request logging, CORS, public rate limiting.
2. Raw body parsing for the inbound-email webhook only, so its signature can be verified. JSON parsing for everything else.
3. **Public routers:** health, capabilities, OpenAPI, auth, public invites, the QuickBooks OAuth callback, the inbound-email webhook.
4. `requireAuth()`. Auth is a session token (`auth/sessions.ts`) sent as a bearer token.
5. `capabilityAccessMiddleware()` enforces role-based access on organization-scoped routes. Owners and admins bypass it.
6. The server-sent events stream and the Solana RPC proxy. They mount before idempotency because one is long-lived and the other is a pass-through.
7. `idempotencyMiddleware()`.
8. **Authed routers:** user wallets, automation agents, organizations, invites, ops, treasury wallets, wallet authorizations, counterparty wallets, invoices, inbound email, bills, payment orders, proposals, approvals, accounting.

Conventions that hold everywhere:

- **Money is bigint minor units.** USDC raw is dollars × 10^6. Never floats, never cents.
- **JSON payloads are validated with Zod** at the boundary.
- **ESM throughout.** Relative imports use explicit `.js` extensions even in `.ts` source.

## Database (Live)

**The schema is SQL-first.** `postgres/init/*.sql` is the source of truth, applied in filename order by `scripts/db-setup.sh` on every `make dev`, `make bench` and `make test`. Every file must stay idempotent because it re-runs on every startup. There are no Prisma migrations. Prisma is a typed client only: after editing SQL, update `api/prisma/schema.prisma` to match and the Makefile regenerates the client.

**Two schemas.**

- `public` holds the product tables, mirrored in `schema.prisma` (37 models). The main groups:
  - Identity: `Organization`, `User`, `OrganizationMembership`, `OrganizationInvite`, `AuthSession`.
  - Bills: `PaymentOrder` is the bill. Also `InvoiceDocument`, `InvoiceDocumentPage`, `PaymentOrderEvent`.
  - Bill collaboration: `BillComment`, `BillQuestion`, `BillFieldChange`, `AiSuggestion`, `AiSuggestionOutcome`.
  - Vendors: `Counterparty`, `CounterpartyWallet`.
  - Accounting: `AccountingConnection`, `AccountingAccountMap`, `AccountingSync`, `VendorCodingRule`, `PaymentOrderGlCoding`.
  - Inbound email: `InboundEmailMessage`, `InboundEmailAttachment`.
  - Payment execution, frozen: `TreasuryWallet`, `DecimalProposal`, `SpendingLimitPolicy`, `SpendingLimitExecution`, `TransferRequest`, `ExecutionRecord`, `AutomationAgent`, `AgentWallet`.
- `approval` holds the approval engine (21 tables, defined from `002-approval-engine.sql` onward). It is **deliberately outside Prisma** and is reached only through raw SQL in `api/src/approvals/store.ts`. Do not model these tables in Prisma.

In code and the database a bill is a `PaymentOrder`. In every piece of UI copy it is a "bill". Its states are `draft`, `submitted`, `proposed`, `executed`, `settled`, `cancelled` (`payments/order-state.ts`). The operator sees five buckets derived from those: Draft, In approval, To pay, Done, Needs attention.

## Bill intake and review (Live)

`api/src/payments/`, the largest module.

1. **Arrival.** Upload (`invoice-intake.ts`), CSV (`csv-intake.ts`), or forwarded email (`agents/inbound-email-intake.ts`). Only team members may forward mail in.
2. **Extraction.** `document-extract.ts` sends the document to an OpenAI model and validates the result with Zod into an `ExtractedInvoice`. Scans and photos are rendered to images for a vision model. A PDF with its own text layer takes a cheaper text-only path. Both models are config (`openAiModel`, `openAiTextModel`), not code. The default is `gpt-6-luna` (chosen 2026-09-30: same accuracy as gpt-4.1-mini on the 27-invoice catalog, a quarter of the price). Every Chat Completions call goes through `infra/openai-params.ts`, which translates a body for reasoning models: `max_completion_tokens` with headroom, `reasoning_effort` (`none` when the call has tools, since Chat Completions refuses tools with reasoning; `low` otherwise), and no `temperature` when reasoning is on.
3. **Provenance.** `doc-provenance.ts` locates every extracted value in the document's text layer and stores its page and bounding box. This powers "click a field, see where it came from" in the UI.
4. **Flags.** `bill-flags.ts` evaluates problems. Three are policy gates: `duplicate-check.ts`, `vendor-payable.ts` and the org bill ceiling. `vendor-similarity.ts` catches near-duplicate vendor names. Each flag carries its own resolutions, and a resolution names who may take it: `anyone`, `admin`, or `primary_admin`.

   Duplicates are settled **per pair**, not per bill. A duplicate flag sits on both bills, and "not a duplicate" answers for the pair: the clearance names the bills it settles (`against`), and a pair cleared on either bill is settled on both. A bill uploaded later is never covered, because nobody has looked at that pair. Every duplicate check — the draft flag, the workbench, confirm, release, the autopay veto and the exception agent — asks `settleDuplicates` / `settleDuplicatesWith` in `duplicate-check.ts`, so they cannot disagree.

   The bill ceiling is checked in three places and they must not drift: the draft flag, the confirm gate in `bills.ts`, and `release-gate.ts`. A bill may be let past it one at a time — `ceiling-exception.ts`, primary admin only, with a reason, leaving the ceiling itself unchanged. All three gates ask `activeCeilingException`, which returns a grant only while the bill is still for the amount it was granted for. Changing the total voids it.
5. **Review.** `bills.ts` serves the workbench list and the draft screen. Questions and comments live in the bill thread (`question-fields.ts`, `question-settle.ts`). Every edit is logged (`bill-history.ts`).
6. **Confirm.** The reviewer confirms, which submits the bill to the approval engine. Verification always happens before routing.

Frontend: `pages/Bills.tsx` (list), `pages/BillDraft.tsx` (review and coding, with the document pane), `pages/BillDetail.tsx` (approval tracking).

## Exception agent (Live)

`api/src/exceptions/`. When a flag fires, an agent investigates it before anyone opens the bill and recommends one of the flag's own resolutions, with evidence. It never acts: the flag still blocks, and a person confirms. Only `possible_duplicate` has an investigator so far.

- `agent.ts` is a generic tool-calling loop (6 turns, one timeout, a terminal tool ends the run). `setExceptionAgentRuntimeForTests` replaces the model with a script. The model is `OPENAI_AGENT_MODEL`, falling back to `OPENAI_MODEL`. With no key, nothing runs and flags behave as they always did.
- `duplicate-logic.ts` is everything that must not be a model: bill facts in the draft screen's precedence, a line-by-line comparison, the pair key and fingerprint, the verdict → action mapping, and the validator. Findings must cite refs a tool returned in that run, and figures that contradict a verdict cap its confidence.
- `duplicate.ts` is the investigator: tools `get_bill`, `compare_bills`, `vendor_history`, `read_document`, and a strict-schema `submit_finding`. Verdicts are `duplicate`, `replacement`, `not_duplicate` and `unsure`. A duplicate keeps the older bill; a replacement keeps the newer one. Exactly one side is ever closed.
- `briefs.ts` decides when it runs and stores the answer in `bill_exception_briefs`, **one row per bill pair**, since a duplicate flag sits on both bills. It runs from exactly two places: after intake, and when `getBillDraft` is read. Never from `flagsForOrder` or the workbench. A read claims the run with one atomic upsert, so concurrent reads start one investigation. A fingerprint over both bills (including whether each was cleared) re-runs a stale brief.
- Every recommendation goes to the suggestion log under stage `exception_brief`, and clearing, closing or asking logs what the person did against it (`recordBriefOutcome`). That is the agreement rate.

Frontend: the brief renders on its flag in `BillDraft.tsx`. The recommended resolution is the primary button with its reason prefilled, and a "Why" fold links each piece of evidence to where it was read. Evaluate with `api/scripts/exception-eval.mts` on the bench.

## Companion (Live)

`api/src/companion/`. The companion does the work before a person looks and shows it happening. The landing page is its console.

- **Steps** (`steps.ts`, table `companion_steps`). A job is one document. Intake writes each stage as a step as it happens (received, opened, read, figures checked, categories, vendor, checks) with a sentence the server writes once. The duplicate investigation writes a step for itself and one per tool call, by wrapping each tool's `run`. Recording is best-effort and never throws. Steps left running by a crash are closed as interrupted when the console loads.
- **Readiness** (`readiness.ts`). A strict verdict per draft: ready only when nothing calls for judgement, otherwise the single most important reason. Attached to each workbench row as `companion`.
- **Console** (`today.ts`, `GET /companion/console`). Running: documents being read and bills being investigated. Waiting on you: approvals, drafts needing input, bills sent back, unreadable documents, ready drafts to sign off. Done: bills that moved past review in the window, and learned habits. The window is "since you last looked" (`companion_views`; a gap over 30 minutes starts a new visit). A bill waiting on you is never also done, and a draft still being worked on is running, not waiting. Each person sees their own work; admins also see who is holding approvals.
- **Jobs** (`GET /companion/jobs/:jobId`). A job's steps and bills, to whoever may see its bills (`involvedBillIds`).

- **Chat** (`chat.ts`, `chat-tools.ts`, tables `companion_chats` and `companion_messages`). Ramp Stack style: a person asks, the answer is worked out in the background with the exception agent's loop (`runAgent`, with the conversation as history), and each tool call appends a thought to the answer while it runs. Tools are read-only and read through the same functions the screens use, so the companion sees exactly what the asker can. Bills (`chat-tools.ts`): `find_bills` (by invoice number, vendor, state, date, amount), `get_bill` (with QuickBooks sync status), `spend_summary`, `vendor_profile` (with any payment hold), `whats_waiting` (with questions asked of you). The organisation (`chat-tools-org.ts`): `team` (members, access, roles, and a code-defined list of which job is whose), `approval_trail`, `bill_history` (changes, comments, questions, lifecycle), `approval_rules` (the published flow in words, the ceiling, separation of duties), `categories`, `what_i_know` (category habits). The prompt carries the team's time zone so UTC timestamps are converted. The answer is text, up to three tables, the bills it rests on, and action cards; bill ids a tool never returned are dropped. Chats belong to the asker.
- **Inbox** (`inbox.ts`, tables `inbox_asks`, `inbox_seen`; `GET /inbox`, `POST /inbox/seen`, `/inbox/asks/:id/done`, `/inbox/nudge`). One item per bill per person. System lines are derived from state every time and never stored: your approval, a question asked of you, a draft to review or sign off, a bill sent back, an unreadable document. People's asks are stored as lines on the recipient's item and close when they act on the bill, tick it, or the bill closes. An item is new when anything in it is later than the person's last look (marked when they pick it, or all at once with `POST /inbox/seen-all`; never just by opening the page). The rail's first section shows it; `pages/Inbox.tsx` is the full page (sidebar "Inbox", with the new count): the list with filters on the left, the selected bill on the right with every line, Done on asks, and the action for its most urgent line.
- **Asking people** (`ask_person` card, `ask-classifier.ts`). The companion names a teammate and the ask; code resolves the person (ambiguous names match no one), reads their inbox item without tidying it, and Luna decides how it lands: already covered (an info card, nothing to send), adds something (a nudge, which does not hold the bill), or needs an answer first (a question through the existing Ask, which holds it). A plain rule decides when there is no model.
- **Action cards** (`actions.ts`). The companion proposes, a person clicks: send a ready bill for approval, close the copy in a duplicate pair, clear a duplicate flag, approve a bill waiting on you. The model names only a kind, a bill and a reason; code decides whether it fits the bill as it is now and builds the exact request. The button calls the bill's own endpoint as the person clicking, so every permission check and gate runs at the click (separation of duties included). `POST /bills/:id/confirm-as-read` sends a ready bill exactly as read. Outcomes are recorded on the card; dropped proposals are logged as `companion_action.dropped`.

Frontend: Home and every chat share one frame (`pages/CompanionRail.tsx`): the conversation fills the main area with the prompt docked at the bottom, and a fixed rail on the right shows Waiting on you, Running and Done; a rail card opens its job's steps in a drawer, polled every second while it runs. `pages/Home.tsx` is the greeting, suggestions and prompt; `pages/Chat.tsx` is a conversation: each answer's thoughts (live while running), text, tables, action cards and bill cards. Recent chats are listed in the sidebar.

## Approval engine (Live)

`api/src/approvals/`. An in-house routing and approval system with three configurable stages: review, approve, release.

| Layer | File | Job |
|---|---|---|
| L1 | `l1.ts` | Resolves people, seats and hierarchy. |
| L2 | `compile.ts` | Turns a policy set plus an approvable into a pinned plan with provenance. |
| L3 | `sod.ts` | Separation-of-duties veto pass. Org-configurable, never hardcoded. |

Around the layers:

- `flow.ts` translates between Flow Builder JSON and engine policy.
- `roles.ts` and `permissions.ts` hold the prebuilt role bundles and the `all` versus `involved` record scope.
- `lifecycle.ts` runs tasks and sweeps overdue ones. It escalates and never auto-denies.
- `recall.ts` and `out-of-office.ts` handle pulling a bill back and substitute approvers.
- `protections.ts` holds org policies.
- `store.ts` is the only file that touches the `approval` schema.
- `wiring.ts` and `hooks.ts` connect the engine to bills.

`payments/approval-bridge.ts` is the glue. An approved bill is marked submitted and a release run is spawned. A rejected bill goes **back to review** with the reason. Rejection is never terminal.

Frontend: `pages/FlowBuilder.tsx`, `pages/Approvals.tsx`, `pages/Protections.tsx` (shown as Policies), `pages/Members.tsx`.

## GL coding and QuickBooks (Live)

`api/src/accounting/`.

- `gl-coding.ts` runs the coding waterfall for each bill line: explicit rules, then vendor memory (`VendorCodingRule`), then AI for the blanks, then a catch-all. Repeated corrections promote into vendor memory.
- `ocr-coding.ts` and `default-chart.ts` supply the chart of accounts, with a built-in fallback when QuickBooks is not connected.
- `quickbooks.ts`, `connections.ts`, `account-sync.ts` and `sync.ts` handle QuickBooks Online OAuth, account sync and bill sync.

The UI never says "GL coding". It says "Line items" and "Category".

Frontend: `pages/Accounting.tsx`, `pages/CodingInbox.tsx`.

## Auth and roles (Live)

`api/src/auth/`. Session tokens, email and password, Google OAuth. `capability-access.ts` maps roles to capabilities and the frontend hides what a user cannot do.

Dev sign-in exists only when `DEV_AUTH_SECRET` is set, which it never is in production: `POST /auth/dev/login`, `POST /auth/dev/seed`, and the `/dev-login` page. Only `@dev.decimal.test` addresses are accepted. `config.ts` refuses this flag and the fake-chain flag in production.

## Frontend (Live)

React Router with every page lazy-loaded in `src/App.tsx`, which keeps Solana web3 out of the initial bundle. Data goes through TanStack Query over the typed client in `src/api.ts`. Runtime config comes from the API's `/capabilities` endpoint.

**Before touching any page, read `frontend/src/pages/PAGE-PLAYBOOK.md`.** It is mandatory. Use only the class vocabulary in `src/styles/decimal/{tokens,components,pages}.css`, grep before typing a class name, and never hardcode colours, spacing or fonts. Primitives live in `src/dec/`.

The public landing page is `src/pages/landing-v4/`.

## Payment execution (Frozen)

Squads v4 multisig treasury on Solana, settling in USDC. The code is mounted, called by the frontend, shown in the sidebar behind the `treasury.view` capability, and covered by tests. It has not been developed since mid-August 2026 and **no real payment has ever executed.** Treat how Decimal pays a bill as an open product question, not a solved one.

- `api/src/squads/` is the on-chain treasury layer. `fake-chain.ts` is an in-memory chain used by the bench.
- `api/src/payments/algorithm.ts` and `agents/payment-automation.ts` route an approved bill to a spending-limit lane or a Squads proposal.
- `agents/spending-limit-execution.ts`, `agents/settlement-reconciler.ts` and `solana.ts` execute and verify.
- `payments/order-proof.ts` builds the proof packet.
- `api/src/transfer-requests/` and `api/src/wallets/` support all of the above.

Frontend: `Wallets`, `TreasuryWalletDetail`, `VaultDetail`, `OrganizationProposals`, `OrganizationProposalDetail`, `PaymentDetail`, `SpendingLimits`, `SpendingLimitDetail`.

Deep reference lives in `docs/reference/`. Read it only when payment work resumes.

## Testing

- `make test` runs the API typecheck, the API tests against `usdc_ops_test`, and the frontend build.
- **Never run `tsx --test` or `npm test` directly inside `api/`.** It inherits the dev database URL and the tests truncate every table.
- `make test-one FILE=tests/x.test.ts [NAME=pattern]` runs one file (or matching tests) against `usdc_ops_test`, for iterating. `make test` still gates every commit.
- `api/tests/companion-safety.test.ts` attacks the companion with a hostile scripted model: every tool with every malformed argument, cross-organisation reads, a (person × action × bill) matrix of card proposals, smuggled requests and junk in answers, double clicks, stale cards, a model that throws or loops. "Changed nothing" is measured by fingerprinting every row of every business table before and after; only the companion's own tables may move. Each protection was deliberately broken once to prove a test catches it.
- `api/scripts/companion-redteam.mts` is the live counterpart, run by hand on the bench against the real model: 38 adversarial cases (direct commands, role abuse, social engineering, instructions hidden in invoice PDFs, invented bills and people, cross-organisation questions, long/foreign/markup input, positive controls), each turn bracketed by a snapshot of the org's business tables. Run from `api/` with `./node_modules/.bin/tsx scripts/companion-redteam.mts [caseId…]` after `make bench`.
- `make bench` starts an isolated stack for agent-driven browser verification. `TESTBENCH.md` is the contract.
- `TESTING-INVOICES.md` specifies the synthetic invoice set. The generator is `scripts/invoice-gen/`.

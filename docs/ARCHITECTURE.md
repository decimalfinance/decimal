# Architecture

How Decimal is built, by subsystem. Each section opens with its status so a reader knows how much to trust it as a foundation.

Verified against the code on 2026-09-17. When you change a subsystem, update its section in the same commit.

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
2. **Extraction.** `document-extract.ts` sends the document to an OpenAI model and validates the result with Zod into an `ExtractedInvoice`. Scans and photos are rendered to images for a vision model. A PDF with its own text layer takes a cheaper text-only path. Both models are config (`openAiModel`, `openAiTextModel`), not code.
3. **Provenance.** `doc-provenance.ts` locates every extracted value in the document's text layer and stores its page and bounding box. This powers "click a field, see where it came from" in the UI.
4. **Flags.** `bill-flags.ts` evaluates problems. Two are policy gates: `duplicate-check.ts` and `vendor-payable.ts`. `vendor-similarity.ts` catches near-duplicate vendor names. Each flag carries its own resolutions.
5. **Review.** `bills.ts` serves the workbench list and the draft screen. Questions and comments live in the bill thread (`question-fields.ts`, `question-settle.ts`). Every edit is logged (`bill-history.ts`).
6. **Confirm.** The reviewer confirms, which submits the bill to the approval engine. Verification always happens before routing.

Frontend: `pages/Bills.tsx` (list), `pages/BillDraft.tsx` (review and coding, with the document pane), `pages/BillDetail.tsx` (approval tracking).

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
- `make bench` starts an isolated stack for agent-driven browser verification. `TESTBENCH.md` is the contract.
- `TESTING-INVOICES.md` specifies the synthetic invoice set. The generator is `scripts/invoice-gen/`.

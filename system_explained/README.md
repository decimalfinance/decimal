# Axoria System Explained

This folder is the onboarding manual for Axoria. It explains the product, the runtime architecture, the codebase, the data model, the reconciliation pipeline, the API surface, the frontend, the worker, observability, and the current risks.

The goal is not to describe only the happy path. The goal is to make a new engineer productive enough to change the system without accidentally breaking execution tracking, reconciliation, or proof generation.

## What Axoria Is

Axoria is the **deterministic financial workflow engine for crypto payments**.

The product takes a CSV or API-created payout intent, walks it through policy approval, one-signature batch execution, and on-chain matching, then hands back a cryptographic proof packet that a finance or audit team can verify.

Axoria is deliberately narrow. The current wedge is **Solana USDC payouts** — not general reconciliation, not a wallet watcher, not an analytics dashboard. Payouts come first because that's where crypto operations break down for finance teams; everything else (inbound matching, treasury analytics, agent runtime) is downstream of getting this one flow right.

In product terms, Axoria answers:

- What payment did we intend to make?
- Who requested it? Was it allowed by policy?
- Which treasury wallet sent it? Which destination received it?
- Was an execution packet prepared? Was a signature submitted?
- Did Solana show the expected USDC movement?
- Does observed settlement match the business intent?
- If not, what exception should an operator review?
- Can we export a signed, deterministic proof packet?

In system terms, Axoria has four layers:

```text
Input layer
Payment requests, payment runs, CSV imports, destinations, counterparties.

Control plane
Approval policy, payment orders, execution packets, state machines, audit events.

Execution handoff
Prepared Solana USDC transfer instructions, wallet signing, submitted signatures.

Verification and proof
Yellowstone observation, matching engine, reconciliation state, exceptions, proof packets.
```

The backend is the source of truth and is API-first. The frontend is one client; human operators, scripts, and agents can all drive the same flows.

## How To Read These Docs

Read these files in order if you are new:

1. [01 Product Mental Model](./01-product-mental-model.md)
2. [02 Repository And Runtime Map](./02-repository-and-runtime-map.md)
3. [03 Backend Control Plane](./03-backend-control-plane.md)
4. [04 Postgres Data Model](./04-postgres-data-model.md)
5. [05 Payment Workflows And States](./05-payment-workflows-and-states.md)
6. [06 Reconciliation And Matching](./06-reconciliation-and-matching.md)
7. [07 Yellowstone Worker](./07-yellowstone-worker.md)
8. [08 ClickHouse And Observability](./08-clickhouse-and-observability.md)
9. [09 Frontend Application](./09-frontend-application.md)
10. [10 API First And Agent Surface](./10-api-first-and-agent-surface.md)
11. [11 Operating Testing And Debugging](./11-operating-testing-and-debugging.md)
12. [12 Current Risks And Cleanup Map](./12-current-risks-and-cleanup-map.md)
13. [13 API Route Catalog](./13-api-route-catalog.md)
14. [14 Code Module Index](./14-code-module-index.md)

## Source Of Truth

The current source of truth is the code, not older README files or older screenshots. These docs and the code are authoritative; anything that disagrees is stale.

Important code and docs entrypoints:

- `api/src/app.ts` — Express app composition and route mounting.
- `api/prisma/schema.prisma` — Postgres schema.
- `api/src/api-contract.ts` — canonical API contract used for OpenAPI.
- `api/src/treasury-wallets.ts` — workspace treasury-wallet service (our-owned Solana wallets).
- `api/src/pricing.ts` — SOL/USD price via Binance with 60s TTL and stale fallback.
- `yellowstone/src/main.rs` — Yellowstone worker entrypoint.
- `yellowstone/src/yellowstone/mod.rs` — worker loop and matching pipeline.
- `frontend/src/App.tsx` — React router shell.
- `frontend/src/pages/*.tsx` — one file per top-level page.
- `frontend/src/styles/*.css` — institutional dual-theme design system (`canonical.css`, `run-detail.css`, `sidebar.css`).
- `brand.md` — brand direction (colors, typography, voice). Source of truth for `--ax-*` tokens.
- `landing-page-content.md` — landing page brief: positioning, section spec, handoff instructions.
- `Makefile` — developer workflows.
- `docker-compose.yml` — local infrastructure.

## Vocabulary

The project contains several similarly named objects. These are **not** interchangeable:

- `TreasuryWallet` — a Solana wallet **we own** in a workspace. Sources for payments. Only these are watched for "ours" on-chain. (Renamed from the older `WorkspaceAddress`.)
- `Destination` — a counterparty wallet we pay. Stores `walletAddress` directly; we do not own it. First-class table with its own trust state, notes, and optional counterparty tag.
- `Counterparty` — an optional business-entity tag (org-scoped) you can attach to destinations for grouping and reporting. Not required.
- `PaymentRequest` — an input object, typically created manually or from CSV. Captures business intent (reason, amount, destination, reference).
- `PaymentRun` — a batch of payment requests/orders, usually imported from CSV. Owns a `sourceTreasuryWalletId` (the batch signer).
- `PaymentOrder` — the main control-plane object for one intended payment. Drives policy, execution packets, and matching.
- `TransferRequest` — the lower-level expected-settlement object used by the matcher.
- `ExecutionRecord` — evidence that someone prepared / submitted / observed an execution attempt.
- `SettlementMatch` — the ClickHouse record proving observed settlement was matched to an expected request.
- `Exception` — a reconciliation issue that needs operator review.

If you remember only one thing: **humans think in `PaymentRequest` / `PaymentRun` / `PaymentOrder` and `Destination`; the matcher thinks in `TransferRequest` / observed transfers / matches / exceptions; the worker only cares about `TreasuryWallet` addresses as the "ours" set.**

There is no `Payee` and no `WorkspaceAddress` anymore — both were removed in the 2026-04-19 schema split. Older docs, notes, or commit messages may mention them; treat any such reference as legacy.

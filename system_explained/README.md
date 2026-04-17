# Axoria System Explained

This folder is the onboarding manual for Axoria. It explains the product, the runtime architecture, the codebase, the data model, the reconciliation pipeline, the API surface, the frontend, the worker, observability, and the current risks.

The goal is not to describe only the happy path. The goal is to make a new engineer productive enough to change the system without accidentally breaking reconciliation, execution tracking, or proof generation.

## What Axoria Is

Axoria is a stablecoin payment reconciliation and control system for Solana USDC.

In product terms, Axoria helps an operator answer:

- What payment did we intend to make?
- Who requested it?
- Was it allowed by policy?
- What wallet was supposed to send it?
- What destination was supposed to receive it?
- Was an execution packet prepared?
- Was a transaction submitted?
- Did Solana show the expected USDC movement?
- Did the observed settlement match the business intent?
- If not, what exception should an operator review?
- Can we export a proof packet that explains the whole lifecycle?

In system terms, Axoria has four layers:

```text
Input layer
Payment requests, payment runs, CSV imports, payees, destinations.

Control plane
Approval policy, payment orders, execution packets, state machines, audit events.

Execution handoff
Prepared Solana USDC transfer instructions, wallet signing, submitted signatures.

Verification and proof
Yellowstone observation, matching engine, reconciliation state, exceptions, proof packets.
```

The frontend is only one client of the system. The backend is intended to be the source of truth and an API-first surface that can be used by humans, scripts, and eventually agents.

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

The current source of truth is the code, not older README files. Some older docs still describe earlier versions of the product such as expected transfers only. Use these files and the current code as the authoritative description.

Important code entrypoints:

- `api/src/app.ts`: Express app composition and route mounting.
- `api/prisma/schema.prisma`: Postgres schema.
- `api/src/api-contract.ts`: Canonical API contract used for OpenAPI.
- `yellowstone/src/main.rs`: Yellowstone worker entrypoint.
- `yellowstone/src/yellowstone/mod.rs`: Worker loop and matching pipeline.
- `frontend/src/App.tsx`: Main React application and page composition.
- `Makefile`: Developer workflows.
- `docker-compose.yml`: Local infrastructure.

## Vocabulary

The project contains several similarly named objects. These are not interchangeable:

- `WorkspaceAddress`: a raw wallet/address Axoria knows about.
- `Counterparty`: a business owner or external/internal entity.
- `Destination`: the operator-facing payment endpoint. Payment orders pay destinations.
- `Payee`: lightweight input-layer object used to make payment requests more human.
- `PaymentRequest`: an input object, often created manually or from CSV.
- `PaymentRun`: a batch of payment requests/orders, usually imported from CSV.
- `PaymentOrder`: the main business/control object for one intended payment.
- `TransferRequest`: the lower-level expected settlement object used by the matcher.
- `ExecutionRecord`: evidence that someone prepared/submitted/observed an execution attempt.
- `SettlementMatch`: the ClickHouse record proving observed settlement was matched to an expected request.
- `Exception`: a reconciliation issue that needs operator review.

If you remember only one thing: users should mostly think in `PaymentRequest`, `PaymentRun`, and `PaymentOrder`; the reconciliation engine thinks in `TransferRequest`, observed transfers, matches, and exceptions.

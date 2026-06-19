# Decimal System Explained

This folder describes the current Decimal system: an AI-powered accounts-payable product on
Solana. Invoices come in, an agent pays approved bills in USDC from a non-custodial Squads
treasury — automatically within an on-chain spending limit (auto-pay), or via member approval
(a Squads voting proposal) when policy doesn't allow auto-pay.

The old Yellowstone/ClickHouse global-stream architecture has been removed; settlement is now
verified by Solana RPC over the known execution signature, plus deterministic JSON proof packets.

Read these files in order:

1. [01 Current Product](./01-current-product.md)
2. [02 Backend Architecture](./02-backend-architecture.md)
3. [03 Payment Lifecycle](./03-payment-lifecycle.md)
4. [04 Data Model](./04-data-model.md)
5. [05 Operating Guide](./05-operating-guide.md)
6. [06 Squads v4 Capability Map](./06-squads-v4-capability-map.md)
7. [07 Payment Routing Algorithm](./07-payment-routing-algorithm.md) — auto-pay vs proposal

(`squads_cost_breakdown.md` covers on-chain cost.)

## Source Of Truth

- `api/src/app.ts` mounts the API routers.
- `api/src/api-contract.ts` defines the OpenAPI-backed endpoint inventory (`/openapi.json`).
- `api/src/routes/capabilities.ts` exposes a human/agent-readable workflow map.
- `api/src/squads/treasury.ts` owns Squads v4 transaction/proposal + spending-limit logic.
- `api/src/agents/payment-automation.ts` owns the routing decision (auto-pay vs proposal);
  `api/src/agents/spending-limit-execution.ts` builds/submits the agent's `spendingLimitUse` tx.
- `api/src/transfer-requests/settlement-read-model.ts` owns Postgres/RPC settlement read models.
- `api/src/counterparty-wallets.ts` owns counterparties and the unified counterparty-wallet
  address book (trust, primary, remove).
- `api/src/payments/orders.ts` owns single-payment commands and read models.
- `api/src/payments/invoice-intake.ts` and `csv-intake.ts` own document/CSV intake;
  `api/src/payments/document-extract.ts` owns OpenAI-vision extraction into payment rows.
- `api/src/payments/order-proof.ts` and `api/src/proof-packet.ts` generate JSON proofs.
- `api/src/routes/solana-rpc.ts` proxies Solana RPC (keeps the key server-side);
  `api/src/routes/events.ts` streams live proposal/settlement updates (SSE).
- `api/src/collections/requests.ts` owns expected inbound collection records (intent/proof only).
- `api/prisma/schema.prisma` defines durable PostgreSQL state.
- `Makefile` defines local and production-backed workflows.

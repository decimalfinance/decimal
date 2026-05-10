# Decimal System Explained

This folder describes the current Decimal architecture after the backend cleanup
and the counterparty-wallet schema refactor.

The old Yellowstone/ClickHouse watcher architecture has been removed from the active product. Decimal is now a Squads treasury workflow, RPC verification, and proof-packet system.

Read these files in order:

1. [01 Current Product](./01-current-product.md)
2. [02 Backend Architecture](./02-backend-architecture.md)
3. [03 Payment Lifecycle](./03-payment-lifecycle.md)
4. [04 Data Model](./04-data-model.md)
5. [05 Operating Guide](./05-operating-guide.md)

## Source Of Truth

- `api/src/app.ts` mounts the API routers.
- `api/src/api-contract.ts` defines the OpenAPI-backed endpoint inventory.
- `api/src/routes/capabilities.ts` exposes a human/agent-readable workflow map.
- `api/src/squads/treasury.ts` owns Squads v4 transaction/proposal logic.
- `api/src/transfer-requests/settlement-read-model.ts` owns Postgres/RPC settlement read models.
- `api/src/counterparty-wallets.ts` owns counterparties and unified counterparty wallets.
- `api/src/payments/orders.ts` owns single-payment commands and read models.
- `api/src/payments/runs.ts` owns CSV/document batch imports and run state.
- `api/src/payments/document-extract.ts` owns PDF/image extraction into payment rows.
- `api/src/payments/order-proof.ts` and `api/src/payments/run-proof.ts` generate JSON proofs.
- `api/src/collections/requests.ts` owns expected inbound collection records.
- `api/prisma/schema.prisma` defines durable PostgreSQL state.
- `Makefile` defines local and production-backed workflows.

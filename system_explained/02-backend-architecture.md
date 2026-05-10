# 02 Backend Architecture

## Runtime

```text
React frontend
  -> Express API
  -> PostgreSQL
  -> Solana RPC
  -> Squads v4 program
  -> Privy API
  -> OpenRouter API for document extraction
```

PostgreSQL is the durable product database. Solana RPC is used for live chain verification. Privy is used only for managed personal wallet operations. OpenRouter is used only when an operator imports an invoice/document into a payment run.

## Main API Modules

- `auth/*` and `routes/auth.ts` handle sessions, password login, Google OAuth, and email verification.
- `auth/organization-access.ts` gates organization access and admin actions.
- `routes/organization-invites.ts` handles invite-only membership.
- `routes/user-wallets.ts` handles personal wallet registration, creation, deletion, and signing.
- `wallets/treasury.ts` and `routes/treasury-wallets.ts` handle organization treasury records.
- `counterparty-wallets.ts` handles counterparties and the unified counterparty wallet registry.
- `squads/treasury.ts` prepares and confirms Squads treasury, config proposal, vault proposal, vote, reject, and execute transactions.
- `payments/orders.ts` handles single-payment commands and read models.
- `payments/runs.ts` handles CSV batch imports, document imports, and run state.
- `payments/document-extract.ts` extracts payment rows from PDF/image invoices.
- `transfer-requests/settlement-read-model.ts` replaces the old indexer-backed reconciliation reads with Postgres/RPC state.
- `payments/order-proof.ts`, `payments/run-proof.ts`, and `collections/proof.ts` emit canonical JSON proof packets.
- `api-contract.ts` generates `/openapi.json`; `routes/capabilities.ts` exposes the higher-level workflow map for humans and agents.

## Request Flow

Most authenticated routes follow this shape:

```text
route schema validation
  -> requireAuth
  -> assertOrganizationAccess or assertOrganizationAdmin
  -> command/read-model module
  -> Prisma transaction when durable state changes
  -> JSON response
```

The frontend should not depend on implementation-specific tables. It should call the route-level API and treat `api/src/api-contract.ts` plus `/openapi.json` as the contract surface.

The frontend also consumes `/capabilities` for runtime network/config awareness and for API-first workflow discovery.

## Squads Flow

Squads routes produce signable Solana transactions. Decimal does not sign treasury transactions itself.

```text
prepare intent
  -> frontend/user wallet signs and submits
  -> confirm submission signature
  -> members approve/reject via signable vote txs
  -> execute approved proposal
  -> confirm execution signature
  -> verify USDC deltas through RPC
```

`decimal_proposals` is the local mirror. The on-chain Squads proposal remains the source of truth for member votes, status, threshold, and execution authority.

## Settlement Read Model

`settlement-read-model.ts` intentionally returns the old `reconciliationDetail` response shape because payment and proof code already consume that shape. Internally it no longer reads an observed-transfer warehouse.

It builds settlement truth from:

- `transfer_requests`
- `execution_records`
- `transfer_request_events`
- `approval_decisions`
- `metadataJson.rpcSettlementVerification`

This keeps API compatibility while removing the expensive global USDC indexing system.

## Counterparty Wallet Registry

`counterparty_wallets` replaces the old split between outbound destinations and inbound collection sources. It stores the address, optional token account, label, trust state, wallet type, and optional business counterparty link.

The same real-world address can now be represented once and used as:

- an outbound payee wallet
- an inbound payer wallet
- an internal/org-linked receiving wallet
- a generic counterparty wallet that can later become any of the above

Payment creation should target `counterpartyWalletId`, not a legacy destination/source table.

## Document Import

The document-import route accepts a base64 PDF/image payload and uses `payments/document-extract.ts` to extract payment rows. The extracted rows are normalized into the same CSV/payment-run path as manual batch imports.

This means document import is an input convenience layer, not a separate execution model.

## Removed Architecture

The previous architecture had:

- Rust streaming worker.
- Matching index SSE routes.
- ClickHouse observed transfer tables.
- Worker-facing internal API routes.
- Reconciliation queue and exception routes.

Those were removed because the current product verifies app-originated Squads payments by signature and token-account deltas. Storing the global USDC stream is unnecessary for this direction.

# 02 Backend Architecture

## Runtime

```text
React frontend (Vercel)
  -> Express API (local laptop :3100, exposed via Cloudflare Tunnel)
  -> PostgreSQL (local docker)
  -> Solana RPC (proxied through the backend)
  -> Squads v4 program
  -> Privy API (managed personal + agent wallets)
  -> OpenAI API (GPT-4o mini vision, only on invoice/document import)
```

PostgreSQL is the durable product database. Solana RPC is used for live chain verification
and is **proxied through the backend** (`routes/solana-rpc.ts`) so the RPC key never reaches
the browser. Privy manages personal signing wallets and the agent wallet. OpenAI is used only
when an operator imports an invoice/document into payment orders.

See [05 Operating Guide](./05-operating-guide.md) for the local-prod runtime (Vercel SPA +
laptop API + Cloudflare tunnel + the three docker Postgres DBs).

## Main API Modules

- `auth/*` and `routes/auth.ts`: sessions, password login, Google OAuth, email verification.
- `auth/organization-access.ts`: gates organization access and admin actions.
- `routes/organization-invites.ts`: invite-only membership.
- `routes/user-wallets.ts`: personal wallet registration, creation, deletion, signing.
- `wallets/treasury.ts` and `routes/treasury-wallets.ts`: organization treasury records.
- `counterparty-wallets.ts`: counterparties and the unified counterparty-wallet address book
  (create / update / set-primary / remove, trust states).
- `squads/treasury.ts`: prepares and confirms Squads treasury, config-proposal, vault-proposal,
  vote, reject, and execute transactions, plus spending-limit (auto-pay) config proposals.
- `agents/*`: the auto-pay layer. `payment-automation.ts` owns the routing decision
  (`advancePaymentOrderWithAgent` / `routePayment`); `spending-limit-execution.ts` builds and
  submits the `spendingLimitUse` transaction via the Privy agent wallet; `automation.ts`,
  `settlement-reconciler.ts`, and `payment-markers.ts` support it.
- `payments/orders.ts`: single-payment commands and read models (create, cancel, clear-review).
- `payments/invoice-intake.ts` and `payments/csv-intake.ts`: invoice and CSV import into
  payment orders (these replaced the old `runs.ts`). `payments/document-extract.ts` extracts
  rows from PDF/image invoices via OpenAI vision. `payments/algorithm.ts` and
  `payments/order-state.ts` hold the routing/state logic.
- `transfer-requests/settlement-read-model.ts`: builds settlement reads from Postgres + RPC
  (it replaced the old indexer-backed reconciliation).
- `payments/order-proof.ts`, `proof-packet.ts`, and `collections/proof.ts`: canonical JSON
  proof packets.
- `routes/proposals.ts` + `routes/events.ts`: proposal reads and Server-Sent Events for live
  proposal/settlement updates in the UI.
- `routes/automation-agents.ts`: the agent / spending-limit (auto-pay) endpoints.
- `routes/solana-rpc.ts`: the backend RPC proxy.
- `api-contract.ts` generates `/openapi.json`; `routes/capabilities.ts` exposes the
  higher-level workflow map for humans and agents.

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

The frontend should not depend on implementation-specific tables. It calls the route-level API
and treats `api/src/api-contract.ts` plus `/openapi.json` as the contract surface, and
`/capabilities` for runtime network/config awareness and workflow discovery.

## Payment Routing (Two Paths)

When a payment order is advanced, the agent routes it. See
[07 Payment Routing Algorithm](./07-payment-routing-algorithm.md) for the full algorithm.

```text
payment order ready
  -> review gate (unreviewed/changed/look-alike address -> needs_review, stop)
  -> matches an active spending limit (cap, allowlisted destination, period budget)?
       YES -> AUTO-PAY: agent submits spendingLimitUse via its Privy wallet
       NO  -> Squads voting proposal: members approve/reject, then execute
  -> RPC settlement verification (token-account deltas)
  -> JSON proof packet
```

Both paths move money only within on-chain guarantees: a spending limit's destinations + cap
are SVM-enforced, and a voting proposal needs the multisig threshold. Decimal never signs a
treasury transaction with its own authority for the proposal path; for auto-pay, the agent
wallet can only spend within the on-chain limit.

`decimal_proposals` is the local mirror; the on-chain Squads proposal/limit remains the source
of truth for votes, status, threshold, destinations, and execution authority.

## Settlement Read Model

`settlement-read-model.ts` returns the established `reconciliationDetail` shape (payment and
proof code already consume it). Internally it builds settlement truth from `transfer_requests`,
`execution_records`, `transfer_request_events`, and `metadata_json.rpcSettlementVerification`
— **not** from a global USDC warehouse, and no longer from the removed approval-decision tables.

## Document Import

The import route accepts a base64 PDF/image and uses `payments/document-extract.ts`
(OpenAI GPT-4o mini vision, Zod-validated) to extract payment rows, which flow into the same
intake path as CSV/manual entry. Document import is an input convenience layer, not a separate
execution model.

## Removed Architecture

Gone: the Rust streaming worker, matching-index SSE worker routes, ClickHouse observed-transfer
tables, worker-facing internal API, and the reconciliation-queue / exception routes. The current
product verifies app-originated Squads payments by signature and token-account deltas, so storing
the global USDC stream is unnecessary.

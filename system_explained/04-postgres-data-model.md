# 04 Postgres Data Model

Postgres is Axoria's control plane: the canonical source of truth for business intent, policy state, approvals, execution evidence, and the audit timeline. ClickHouse holds chain facts; Postgres holds everything operators decide or configure.

The schema lives in `api/prisma/schema.prisma` and the seed SQL is under `postgres/init/`.

Two schema rules that shape almost every table:

1. **We split "ours" from "theirs."** `TreasuryWallet` records the Solana wallets *we* own (sources for payments, the only thing the Yellowstone worker watches as "ours"). `Destination` records *counterparty* wallets we pay, storing the external `walletAddress` directly. They are deliberately separate tables with no foreign key between them.
2. **Business intent lives on top of the transfer-level matcher.** `PaymentRequest` / `PaymentRun` / `PaymentOrder` are the business objects operators think in. `TransferRequest` / `ExecutionRecord` / `ApprovalDecision` are the lower-level matcher objects the worker and reconciliation engine think in.

Older docs and old code references may mention `Payee` or `WorkspaceAddress` — those no longer exist. `Payee` was removed entirely; `WorkspaceAddress` was renamed to `TreasuryWallet`.

## Identity And Access Tables

### `Organization`

Fields: `organizationId`, `organizationName`, `status`, timestamps.

An organization owns workspaces, counterparties, memberships, auth sessions, and API keys.

### `User`

Fields: `userId`, `email` (unique), `displayName`, `status`, timestamps.

Users join organizations via `OrganizationMembership` (role + status). They own approval decisions, notes, exception state updates, payment records, API keys created, and export jobs.

### `OrganizationMembership`

Joins `User ↔ Organization` with a `role` and `status`. Unique per `(organizationId, userId)`.

### `AuthSession`

Session tokens for user logins. Fields: `authSessionId`, `sessionToken` (unique), optional `organizationId`, `userId`, `expiresAt`, `lastSeenAt`. Cascade on org/user deletion.

### `ApiKey`

Machine credentials scoped to a workspace. Fields: `apiKeyId`, `workspaceId`, `organizationId`, `createdByUserId?`, `keyPrefix`, `keyHash` (unique), `label`, `status`, `role` (default `agent_operator`), `scopes` (JSON array), `lastUsedAt?`, `expiresAt?`, `revokedAt?`. Unique `(workspaceId, label)`.

### `IdempotencyRecord`

Stores the outcome of an idempotent POST so replays return the same response. Fields: `idempotencyRecordId`, `key`, `requestMethod`, `requestPath`, `requestHash`, `actorType`, `actorId`, `status`, `statusCode?`, `responseBodyJson?`, timestamps, `expiresAt`. Unique `(actorType, actorId, requestMethod, requestPath, key)`.

### `Workspace`

A workspace is the scope everything else lives under. Fields: `workspaceId`, `organizationId`, `workspaceName`, `status`. Cascade on org deletion. All treasury wallets, destinations, payment objects, approvals, and events reference `workspaceId`.

## Address Book Tables

### `TreasuryWallet`

Wallets the workspace *owns*. Source side of every payment. The Yellowstone worker only watches these addresses as "ours."

Fields:

- `treasuryWalletId` (uuid, pk)
- `workspaceId`
- `chain` (e.g. `solana`)
- `address`
- `assetScope` (default `usdc`)
- `usdcAtaAddress` — the derived USDC ATA; populated at creation time
- `isActive`
- `source` (e.g. `manual`), `sourceRef`
- `displayName`, `notes`, `propertiesJson`
- timestamps

Unique on `(workspaceId, address)`. Relations: outbound `TransferRequest`s, source `PaymentOrder`s, source `PaymentRun`s.

This table was renamed from `WorkspaceAddress` in the 2026-04-19 schema split. Any code that still mentions `workspaceAddressId` is legacy.

### `Counterparty`

An optional business entity you can tag destinations with. Org-scoped (lives above workspaces).

Fields: `counterpartyId`, `organizationId`, `displayName`, `category`, `externalReference?`, `status`, `metadataJson`, timestamps.

Indexed on `(organizationId, createdAt desc)`. Counterparties are never required — destinations work without them.

### `Destination`

Counterparty endpoint we pay. Stores the external wallet address directly. No FK to `TreasuryWallet`; these are their wallets, not ours.

Fields:

- `destinationId`
- `counterpartyId?` — optional link to a Counterparty
- `workspaceId`
- `chain` (e.g. `solana`)
- `asset` (default `usdc`)
- `walletAddress` — the counterparty's wallet
- `tokenAccountAddress?` — optional pre-resolved ATA
- `destinationType` (default `wallet`)
- `trustState` — one of `unreviewed | trusted | restricted | blocked`
- `label` — human name ("Acme payout wallet")
- `notes?` — free-form context
- `isInternal` — boolean for `internal` vs `external` classification used by policy
- `isActive`
- `metadataJson`
- timestamps

Unique on `(workspaceId, walletAddress)`. Indexed on `(workspaceId, createdAt desc)` and `(counterpartyId, createdAt desc)`. Relations: `TransferRequest`s, `PaymentOrder`s, `PaymentRequest`s.

### `AddressLabel`

A generic label registry that is *not* scoped to a workspace. Used to enrich arbitrary on-chain addresses seen during observation. Fields: `addressLabelId`, `chain`, `address`, `entityName`, `entityType`, `labelKind`, `roleTags` (JSON), `source`, `sourceRef?`, `confidence`, `isActive`, `notes?`, timestamps. Unique on `(chain, address)`.

## Business Intent Tables

### `PaymentRequest`

An input-layer object: "someone asked to pay this."

Fields:

- `paymentRequestId`
- `workspaceId`, `paymentRunId?`
- `destinationId`, `counterpartyId?`
- `requestedByUserId?`
- `amountRaw` (BigInt raw base units), `asset` (default `usdc`)
- `reason` (required, free text — e.g. "April vendor payout")
- `externalReference?`, `dueAt?`
- `state` (default `submitted`)
- `metadataJson`
- timestamps

Unique combo `(workspaceId, destinationId, amountRaw, externalReference)` prevents casual duplicates. Indexed heavily for the list UI.

Has an optional one-to-one `PaymentOrder` via `paymentRequestId` back-reference.

There is **no `memo`**, **no `source`**, and **no `payeeId`** on this table. All three live elsewhere or were removed.

### `PaymentRun`

A batch of payment requests/orders, usually imported from CSV.

Fields: `paymentRunId`, `workspaceId`, `sourceTreasuryWalletId?` (the intended batch signer), `runName`, `inputSource` (e.g. `csv_import`, `manual`), `state` (default `draft`), `metadataJson`, `createdByUserId?`, timestamps.

The run doesn't store prepared packets or signatures; those live on the orders / execution records.

### `PaymentOrder`

The main control-plane object for one intended payment. Drives policy, execution packets, and matching.

Fields:

- `paymentOrderId`
- `workspaceId`, `paymentRequestId?` (unique, optional one-to-one), `paymentRunId?`
- `destinationId`, `counterpartyId?`, `sourceTreasuryWalletId?`
- `amountRaw`, `asset`
- `memo?`, `externalReference?`, `invoiceNumber?`, `attachmentUrl?`, `dueAt?`
- `state` (default `draft`)
- `sourceBalanceSnapshotJson` — snapshot of the source treasury wallet's balance when the order was prepared
- `metadataJson`, `createdByUserId?`
- timestamps

No `preparedExecutionPacketJson` and no `submittedSignature` here — those live on `ExecutionRecord` via the order's `TransferRequest`.

## Transfer-Level Tables (The Matcher's View)

### `TransferRequest`

The lower-level expected-settlement record. A `PaymentOrder` usually spawns one `TransferRequest`. This is what the matcher reconciles observed USDC movement against.

Fields: `transferRequestId`, `workspaceId`, `paymentOrderId?`, `sourceTreasuryWalletId?`, `destinationId`, `requestType`, `asset`, `amountRaw`, `requestedByUserId?`, `reason?`, `externalReference?`, `status` (default `submitted`), `requestedAt`, `dueAt?`, `propertiesJson`, timestamps.

Relations: approvals, execution records, events, notes. Several compound indexes for matcher and UI queries.

### `ApprovalPolicy`

One per workspace (unique on `workspaceId`). Fields: `approvalPolicyId`, `workspaceId`, `policyName`, `isActive`, `ruleJson`, timestamps.

All policy knobs live in `ruleJson`:

```jsonc
{
  "requireTrustedDestination": true,
  "requireApprovalForExternal": true,
  "requireApprovalForInternal": false,
  "externalApprovalThresholdRaw": "1000000",
  "internalApprovalThresholdRaw": "10000000"
}
```

No separate columns per knob — we deliberately keep `ruleJson` flexible so new policy rules can ship without migrations.

### `ApprovalDecision`

Decisions against `TransferRequest`s.

Fields: `approvalDecisionId`, `approvalPolicyId?`, `transferRequestId`, `workspaceId`, `actorUserId?`, `actorType` (default `user` — could also be `policy` for auto-clear), `action` (one of `routed_for_approval | auto_approved | approve | reject | escalate`), `comment?`, `payloadJson`, `createdAt`.

Decisions are append-only; the current state of a request is derived from the latest decision.

### `ExecutionRecord`

Evidence that someone prepared / submitted / observed an execution attempt for a `TransferRequest`.

Fields: `executionRecordId`, `transferRequestId`, `workspaceId`, `submittedSignature?`, `executionSource` (default `manual`), `executorUserId?`, `state` (one of `ready_for_execution | submitted_onchain | broadcast_failed | observed | settled | execution_exception`), `submittedAt?`, `metadataJson`, timestamps.

When a signature is attached back via `/attach-signature`, a new `ExecutionRecord` is created (or the existing one is updated) with the signature and `submittedAt`.

### `TransferRequestEvent`

An append-only audit log per transfer request. Fields: `transferRequestEventId`, `transferRequestId`, `workspaceId`, `eventType`, `actorType`, `actorId?`, `eventSource`, `beforeState?`, `afterState?`, `linkedSignature?`, `linkedPaymentId?`, `linkedTransferIds` (JSON array), `payloadJson`, `createdAt`.

### `TransferRequestNote`

Human notes on a transfer request. Fields: `transferRequestNoteId`, `transferRequestId`, `workspaceId`, `authorUserId?`, `body`, `createdAt`.

### `PaymentOrderEvent`

Parallel audit log at the `PaymentOrder` level. Fields: `paymentOrderEventId`, `paymentOrderId`, `workspaceId`, `eventType`, `actorType`, `actorId?`, `beforeState?`, `afterState?`, `linkedTransferRequestId?`, `linkedExecutionRecordId?`, `linkedSignature?`, `payloadJson`, `createdAt`.

Useful for rendering the lifecycle rail on the Payment detail and Payment run detail pages.

## Exception And Audit Tables

### `ExceptionState`

The current state of a reconciliation exception, unique per `(workspaceId, exceptionId)`. Fields: `exceptionStateId`, `workspaceId`, `exceptionId`, `status`, `updatedByUserId?`, `assignedToUserId?`, `resolutionCode?`, `severity?`, timestamps.

The exception's facts (transfers, amounts, cause) live in ClickHouse; this table is the operator-decided state on top.

### `ExceptionNote`

Human notes on an exception. Fields: `exceptionNoteId`, `workspaceId`, `exceptionId`, `authorUserId?`, `body`, `createdAt`.

### `ExportJob`

Records a proof / audit export. Fields: `exportJobId`, `workspaceId`, `requestedByUserId?`, `exportKind` (e.g. `payment_order_proof`, `payment_run_proof`, `audit_csv`), `format` (`json` | `csv`), `status` (default `completed`), `rowCount`, `filterJson`, `createdAt`, `completedAt?`.

## Design Rules

Rules that shape Postgres usage across the codebase:

1. **Ours vs theirs is a table boundary, not a column.** `TreasuryWallet` and `Destination` never share a row. Do not add a FK from `Destination` back to `TreasuryWallet` — they are different concepts.
2. **Business intent and transfer mechanics are different layers.** `PaymentOrder` is what humans care about; `TransferRequest` is what the matcher reconciles. Keep them as siblings via `paymentOrderId` on `TransferRequest` — do not collapse them.
3. **Events are append-only.** Both `PaymentOrderEvent` and `TransferRequestEvent` are audit logs. Never update, only append.
4. **`ruleJson` on `ApprovalPolicy` is deliberately loose.** Add new policy knobs there before adding columns. If a knob becomes load-bearing for queries, promote it.
5. **Idempotency is stored, not stateless.** Any mutation that can retry (CSV import, order creation, sign attach) goes through `IdempotencyRecord`.
6. **ClickHouse for chain facts, Postgres for decisions.** Do not mirror observed transfers into Postgres "for convenience"; reference them by signature.

## Things Intentionally Missing

- No `Payee` table. Payees were folded into `Destination` + optional `Counterparty`.
- No `WorkspaceAddress` table. It's `TreasuryWallet` now.
- No `audit_log` generic table. Use the per-entity `*Event` tables instead.
- No `Transaction`-the-row table for on-chain txs. ClickHouse owns observed transactions; Postgres references them by signature.
- No separate password store — auth is token-based against `AuthSession` plus API keys.

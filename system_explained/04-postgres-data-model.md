# 04 Postgres Data Model

Postgres stores the control plane. It is the durable system of record for users, organizations, workspaces, payment intent, policy, execution evidence, operator metadata, and API access.

The Prisma schema lives at:

```text
api/prisma/schema.prisma
```

This document explains the data model by domain rather than by raw table order.

## Identity And Workspace Model

### User

Represents a person using Axoria.

Important fields:

- `userId`
- `email`
- `displayName`
- `createdAt`
- `updatedAt`

Current login is email-based and lightweight.

### AuthSession

Stores frontend/user bearer sessions.

Important fields:

- `sessionToken`
- `userId`
- `organizationId`
- `expiresAt`
- `lastSeenAt`

### Organization

Top-level tenant object.

Important fields:

- `organizationId`
- `name`
- `slug`
- `status`
- `createdByUserId`

Organizations have:

- users through memberships
- workspaces
- API keys

### OrganizationMembership

Connects users to organizations.

Important fields:

- `organizationId`
- `userId`
- `role`

Roles are currently simple. Long-term, role definitions should become more explicit.

### Workspace

The operational scope. Most product objects are workspace-scoped.

Important fields:

- `workspaceId`
- `organizationId`
- `name`
- `slug`
- `status`
- `createdByUserId`

A workspace is where a team defines addresses, destinations, policy, payment requests, payment orders, and reconciliation.

## API Access Model

### ApiKey

Workspace-scoped token for agents, scripts, and non-frontend clients.

Important fields:

- `apiKeyId`
- `workspaceId`
- `organizationId`
- `createdByUserId`
- `label`
- `keyPrefix`
- `keyHash`
- `status`
- `role`
- `scopes`
- `lastUsedAt`
- `expiresAt`
- `revokedAt`

Only the hash is stored. The raw token is returned once.

### IdempotencyRecord

Stores mutation replay data.

Important fields:

- `actorType`
- `actorId`
- `requestMethod`
- `requestPath`
- `key`
- `requestHash`
- `status`
- `statusCode`
- `responseBodyJson`
- `expiresAt`

This prevents duplicate creation when clients retry.

## Address Book Model

The address book separates raw wallet data from human/payment abstractions.

### WorkspaceAddress

A raw wallet or address known to the workspace.

Important fields:

- `workspaceAddressId`
- `workspaceId`
- `address`
- `usdcAtaAddress`
- `displayName`
- `addressType`
- `isActive`
- `createdByUserId`

Use this when Axoria needs a raw wallet identity. Do not use it as the product-facing payment endpoint unless the UI/flow genuinely needs raw wallet management.

### Counterparty

A business owner/entity. It may represent a vendor, internal team, partner, contributor group, or any entity behind one or more destinations.

Important fields:

- `counterpartyId`
- `workspaceId`
- `displayName`
- `status`
- `metadataJson`

Counterparties are optional. A destination can be unassigned.

### Destination

The operator-facing payment endpoint.

This is more important than raw addresses for product flows.

Important fields:

- `destinationId`
- `workspaceId`
- `label`
- `destinationType`
- `trustState`
- `scope`
- `walletAddress`
- `usdcAtaAddress`
- `linkedWorkspaceAddressId`
- `counterpartyId`
- `isActive`
- `notes`

Trust state affects approval and request creation behavior.

Typical trust states:

- `trusted`
- `unreviewed`
- `restricted`

Typical scopes:

- `internal`
- `external`

Product rule:

```text
Operators should pay destinations, not raw wallet addresses.
```

### Payee

Lightweight input-layer object.

Important fields:

- `payeeId`
- `workspaceId`
- `name`
- `defaultDestinationId`
- `counterpartyId`
- `status`
- `metadataJson`

Payees make imports and payment requests more natural. They help users think "pay Acme Corp" rather than "send USDC to this address".

## Payment Input And Control Model

### PaymentRequest

The input-layer object. It represents a request to pay someone.

Important fields:

- `paymentRequestId`
- `workspaceId`
- `paymentRunId`
- `payeeId`
- `destinationId`
- `counterpartyId`
- `amountRaw`
- `asset`
- `memo`
- `externalReference`
- `dueAt`
- `source`
- `state`
- `metadataJson`
- `createdByUserId`

Payment requests can be created manually or by CSV import.

They can be promoted into payment orders.

### PaymentRun

A batch container.

Important fields:

- `paymentRunId`
- `workspaceId`
- `name`
- `source`
- `state`
- `sourceWorkspaceAddressId`
- `submittedSignature`
- `preparedExecutionPacketJson`
- `metadataJson`
- `createdByUserId`

A payment run is used for CSV/batch workflows such as payroll-like payout lists.

It owns:

- payment requests
- payment orders

### PaymentOrder

The main control-plane payment object.

Important fields:

- `paymentOrderId`
- `workspaceId`
- `paymentRequestId`
- `paymentRunId`
- `payeeId`
- `destinationId`
- `counterpartyId`
- `sourceWorkspaceAddressId`
- `amountRaw`
- `asset`
- `memo`
- `externalReference`
- `invoiceNumber`
- `attachmentUrl`
- `dueAt`
- `state`
- `sourceBalanceSnapshotJson`
- `preparedExecutionPacketJson`
- `submittedSignature`
- `metadataJson`
- `createdByUserId`

Payment orders are where policy, execution, settlement, and proof converge.

### TransferRequest

The lower-level expected settlement object used by the reconciliation system.

Important fields:

- `transferRequestId`
- `workspaceId`
- `paymentOrderId`
- `sourceWorkspaceAddressId`
- `destinationWorkspaceAddressId`
- `destinationId`
- `fromLabel`
- `toLabel`
- `expectedAmountRaw`
- `asset`
- `status`
- `requestedAt`
- `observedSignature`
- `metadataJson`
- `createdByUserId`

Payment orders may feel like the product object, but transfer requests are what the matcher indexes.

### ExecutionRecord

Evidence that an execution attempt existed.

Important fields:

- `executionRecordId`
- `workspaceId`
- `transferRequestId`
- `paymentOrderId`
- `executionState`
- `submittedSignature`
- `externalReference`
- `preparedPacketJson`
- `metadataJson`
- `createdByUserId`

Execution records prevent the system from confusing "approved" with "sent".

## Policy And Approval Model

### ApprovalPolicy

Workspace-level rules for whether requests can become active automatically.

Important fields:

- `approvalPolicyId`
- `workspaceId`
- `name`
- `status`
- `trustedDestinationRequired`
- `alwaysRequireApprovalForExternal`
- `alwaysRequireApprovalForInternal`
- `externalApprovalThresholdRaw`
- `internalApprovalThresholdRaw`
- `metadataJson`

### ApprovalDecision

Records a decision on a transfer request.

Important fields:

- `approvalDecisionId`
- `workspaceId`
- `transferRequestId`
- `decision`
- `reason`
- `decidedByUserId`
- `metadataJson`

Approval decisions are part of the audit/proof trail.

## Event And Audit Model

### PaymentOrderEvent

Timeline event for payment orders.

Examples:

- payment order created
- payment order submitted
- approval evaluated
- execution packet prepared
- signature attached
- settlement matched

### TransferRequestEvent

Timeline event for transfer requests.

Examples:

- request created
- status transition
- approval decision
- settlement observed
- settlement matched
- partial settlement

### WorkspaceAuditLog

Workspace-level audit log.

Used for broader operational events and exports.

## Exception Metadata Model

ClickHouse stores worker-generated exceptions. Postgres stores operator metadata about those exceptions.

### ExceptionState

Overlay state for a ClickHouse exception.

Important fields:

- `exceptionId`
- `workspaceId`
- `status`
- `assignedToUserId`
- `severity`
- `metadataJson`

### ExceptionNote

Operator note for an exception.

Important fields:

- `exceptionNoteId`
- `exceptionId`
- `workspaceId`
- `authorUserId`
- `body`

## Export Model

### ExportJob

Tracks proof/export generation.

Important fields:

- `exportJobId`
- `workspaceId`
- `exportType`
- `status`
- `resourceType`
- `resourceId`
- `fileName`
- `metadataJson`

## Address Labels

### AddressLabel

Stores known labels for addresses.

Sources can include:

- manual
- workspace registry
- Orb tag resolver

Important implementation lesson:

```text
If Orb returns no usable label, cache that negative result or avoid repeatedly logging/fetching the same address.
```

Repeated unresolved label logs have been a recurring local issue.

## Design Rule

Do not merge these concepts:

- Raw wallet address.
- Destination.
- Payee.
- Counterparty.
- Payment order.
- Transfer request.

They exist because they answer different questions:

- wallet: where on-chain?
- destination: which endpoint should operators pay?
- payee: who are we trying to pay?
- counterparty: what business entity owns this?
- order: what controlled payment are we running?
- transfer request: what settlement should the matcher expect?


# 10 API First And Agent Surface

Axoria should be usable by humans through the frontend and by agents through the API.

This does not mean the product currently has autonomous agents doing useful work. It means the backend is being shaped so agents can operate it safely.

## What "API First" Means Here

API first means:

- every important workflow can be performed without the frontend
- endpoints are documented
- auth works for non-human clients
- responses are structured and predictable
- mutation requests can be retried safely
- tasks and available actions can be discovered
- proof output can be consumed by machines

## Current API-First Building Blocks

### OpenAPI

The API exposes an OpenAPI spec generated from `api-contract.ts`.

This gives agents and external clients a discoverable contract.

### API Keys

Workspace-scoped API keys allow non-frontend clients to authenticate.

Default agent scopes include:

- workspace read/write
- payments write
- approvals write
- execution write
- reconciliation read
- exceptions write
- proofs read

### Idempotency Keys

Agents can safely retry mutations with `Idempotency-Key`.

This is important because agents often run long workflows where network failures happen.

### Agent Tasks

The API exposes:

```text
GET /workspaces/:workspaceId/agent/tasks
GET /workspaces/:workspaceId/agent/tasks/events
```

The task list combines:

- approval reviews
- payment orders ready for execution
- payment orders awaiting settlement
- reconciliation reviews
- open exceptions

Each task includes:

- task id
- kind
- priority
- title
- status
- resource href
- recommended action
- available actions
- context

This is the beginning of an agent-native operating surface.

## Example Agent Workflow

A payment operations agent could:

1. Authenticate with workspace API key.
2. Fetch tasks.
3. Find pending approval tasks.
4. Inspect the linked transfer request/payment order.
5. Apply policy/business rules outside Axoria.
6. POST approval decision if allowed.
7. Fetch ready-for-execution tasks.
8. Prepare execution packet.
9. Hand packet to a signer or multisig integration.
10. Attach submitted signature.
11. Wait for agent task or reconciliation event.
12. Review exceptions if any.
13. Fetch proof packet after settlement.

## Example API Sequence

### Import a batch

```text
POST /workspaces/:workspaceId/payment-runs/import-csv
Authorization: Bearer <api key>
Idempotency-Key: import-run-2026-04-18-001
```

### List tasks

```text
GET /workspaces/:workspaceId/agent/tasks
Authorization: Bearer <api key>
```

### Prepare execution

```text
POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution
Authorization: Bearer <api key>
Idempotency-Key: prepare-payment-<id>
```

### Attach signature

```text
POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature
Authorization: Bearer <api key>
Idempotency-Key: attach-signature-<signature>
```

### Fetch proof

```text
GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof
Authorization: Bearer <api key>
```

## What Agents Should Not Do Yet

Agents should not:

- hold private keys
- silently sign transactions
- bypass approval policy
- mark exceptions resolved without evidence
- mutate destinations/trust state without explicit authorization
- rely on frontend-only state

## Best-Case Agent Scenario

The best near-term agent is not "AI moves money by itself".

The best near-term agent is:

```text
An operations copilot that watches Axoria tasks, prepares safe next actions, explains exceptions, drafts approvals, fetches proof packets, and hands execution to human/multisig signers.
```

More advanced later:

- agent imports CSV from trusted source
- agent validates destinations (including trust state and counterparty tags)
- agent flags duplicate/suspicious payouts
- agent prepares batch execution packet
- human/multisig signs
- agent monitors settlement
- agent closes proofs and sends audit packets

## Gaps Before Agents Are Truly Strong

Needed improvements:

- More complete OpenAPI descriptions and examples.
- Stable resource schemas with versioning.
- Better typed error codes.
- Webhooks or event subscriptions beyond in-process SSE.
- Durable task state.
- Explicit permissions per action.
- More structured proof packets.
- Safer approval policies.
- Stronger audit log coverage.
- Agent-specific integration tests.

## Security Notes

API keys are powerful.

Production hardening should include:

- expiration defaults
- rotation UX
- audit logs for API-key actions
- per-scope enforcement tests
- rate limits per key
- IP allowlisting if needed
- secret scanning
- admin approval for high-privilege keys

## Design Rule For Agent Features

Do not build "agent magic" into the frontend.

Agent support belongs in:

- API contracts
- task discovery
- idempotent workflows
- explicit actions
- structured errors
- auditable decisions
- proof outputs


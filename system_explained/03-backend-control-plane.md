# 03 Backend Control Plane

The backend is the product source of truth. The frontend is a client. Agents should also be clients.

The backend lives in `api/`.

## Main Entrypoints

```text
api/src/server.ts
Starts the HTTP server.

api/src/app.ts
Creates the Express app, middleware, route mounting, and error handling.

api/src/prisma.ts
Exports the Prisma client.

api/prisma/schema.prisma
Defines the Postgres schema.

api/src/api-contract.ts
Defines the API contract used to generate OpenAPI.
```

## Express App Composition

`api/src/app.ts` builds the app in this order:

1. Request ID middleware.
2. CORS.
3. Public route metrics.
4. JSON body parser.
5. Public rate limit.
6. Matching-index invalidation middleware.
7. Public routes.
8. Authentication middleware.
9. Idempotency middleware.
10. Protected routes.
11. Error handler.

This ordering matters.

Public routes must be mounted before `requireAuth()`. Protected routes must be mounted after it.

## Request IDs

Every request gets a request ID from:

- Existing `x-request-id` header if present.
- Generated random UUID if absent.

Responses include `x-request-id`.

Errors include `requestId` in JSON.

This is important for debugging agents and frontend failures.

## CORS

The API accepts configured origins plus local development origins:

- `http://localhost:*`
- `http://127.0.0.1:*`

This was necessary because Vite sometimes uses different local ports.

## Authentication

Authentication supports two modes:

### User Session

The frontend logs in by email. The API creates or resumes a user and returns a bearer token.

The session token is stored in Postgres as `AuthSession`.

Session auth context includes:

- `authType: user_session`
- user id
- email
- display name
- actor type `user`

### API Key

API keys are workspace-scoped and intended for scripts/agents.

An API key token looks like:

```text
axoria_live_<token_id>.<secret>
```

Only the hash is stored in Postgres. The raw token is returned once on creation.

API key auth context includes:

- `authType: api_key`
- API key id
- label
- prefix
- workspace id
- organization id
- role
- scopes
- actor type `api_key`

## API Key Scoping

API keys are restricted to:

- `/auth/session`
- `/auth/logout`
- `/workspaces/:workspaceId/*` where `workspaceId` equals the key's workspace.

API keys cannot access arbitrary organizations or other workspaces.

Scope mapping is implemented in `auth.ts`.

Common scopes:

- `workspace:read`
- `workspace:write`
- `payments:write`
- `approvals:write`
- `execution:write`
- `reconciliation:read`
- `exceptions:write`
- `proofs:read`
- `api_keys:write`

Default agent scopes are defined in `api/src/api-keys.ts`.

## Idempotency

Mutation requests can include:

```text
Idempotency-Key: some-client-generated-key
```

The middleware applies to:

- `POST`
- `PATCH`
- `DELETE`

It stores:

- actor type
- actor id
- method
- path
- key
- stable request body hash
- completed response body

Behavior:

- Same key and same body returns cached response.
- Same key and different body returns `409 idempotency_conflict`.
- Same key while prior request is in progress returns `409 idempotency_in_progress`.

This is important for agents because they may retry requests after network failures.

## Matching-Index Invalidation

After relevant mutations complete successfully, the API notifies subscribers that the matching index should refresh.

The invalidation middleware watches paths involving:

- organizations
- workspaces
- addresses
- destinations
- payment requests
- payment runs
- payment orders
- transfer requests
- approvals
- executions

The Yellowstone worker subscribes to matching-index events and refreshes without polling.

## Public Routes

Public routes include:

- Health.
- Capabilities.
- OpenAPI.
- Auth.
- Internal worker endpoints.

Internal worker endpoints are protected by service token logic where applicable, not regular user sessions.

## Protected Route Groups

Protected routes include:

- API keys.
- Organization management.
- Workspace operations.
- Treasury wallets (`/workspaces/:id/treasury-wallets`, `/balances`).
- Counterparties and Destinations.
- Address labels (chain-wide, not workspace-scoped, but auth'd).
- Payment requests.
- Payment runs.
- Payment orders.
- Approval policy and inbox.
- Transfer requests.
- Events/reconciliation/exceptions.
- Agent task endpoints.

## Error Handling

The API maps:

- Zod validation errors to `400 ValidationError`.
- Known domain errors through `mapKnownError`.
- Regular `Error` objects to `400`.
- Unknown errors to `500 InternalError`.

This is pragmatic for MVP but not ideal long-term. Some domain errors should become explicit typed errors instead of generic `Error`.

## API Contract And OpenAPI

`api/src/api-contract.ts` is the canonical route list for API documentation.

The OpenAPI route is mounted publicly. This matters for:

- Developer onboarding.
- API-first usage.
- Agent tool generation.
- Keeping frontend and backend aligned.

If you add a route, update:

- Route implementation.
- Tests if applicable.
- `api-contract.ts`.
- OpenAPI descriptions if the route should be agent/client visible.

## Core Backend Modules

### `payment-requests.ts`

Handles input-layer requests.

Responsibilities:

- Create payment requests.
- List and fetch requests.
- Import requests from CSV.
- Preview CSV imports.
- Promote a payment request to a payment order.
- Cancel requests.

### `payment-runs.ts`

Handles batch workflows.

Responsibilities:

- Import CSV batches.
- Create payment run records.
- Create request/order rows for each imported line.
- Prepare batch execution.
- Attach batch signatures.
- Close/cancel runs.
- Build run detail read models.

### `payment-orders.ts`

Handles the main payment lifecycle.

Responsibilities:

- Create payment orders.
- Submit payment orders.
- Evaluate approval policy.
- Create lower-level transfer requests.
- Prepare Solana execution packets.
- Attach signatures or execution references.
- Cancel orders.
- Serialize read models.
- Pull reconciliation detail into payment order views.

This is currently one of the most important and largest service modules.

### `approval-policy.ts`

Handles workspace approval rules.

Responsibilities:

- Create default approval policy.
- Evaluate whether a request/order needs approval.
- Produce human-readable policy reason summaries.

### `execution-records.ts`

Handles execution evidence.

Responsibilities:

- Create execution records.
- Serialize execution records.
- Represent whether an execution was prepared, submitted, observed, or failed.

### `reconciliation.ts`

Reads ClickHouse reconciliation data and overlays Postgres operator metadata.

Responsibilities:

- List observed transfers.
- List reconciliation queue.
- Fetch reconciliation detail.
- Explain reconciliation state.
- List exceptions.
- Apply exception actions.
- Add exception notes.

### `proof-packet.ts`

Builds canonical digest data for proofs.

Proof routes build human-readable Markdown and/or compact JSON proof packets around these primitives.

### `agent-tasks.ts`

Builds a machine-readable task list for agents.

It merges:

- Approval inbox items.
- Payment orders requiring execution/reconciliation attention.
- Open exceptions.

Each task includes recommended actions and API hrefs.

## Route Modules

Routes are in `api/src/routes/`.

The route modules should stay thin. Business logic should live in service modules.

Current reality:

- Many routes are thin enough.
- Some validation/request shaping is in routes.
- Some service modules are large and should later be split into smaller domain services.

## Backend Design Principle

The API should be a complete product surface independent of the frontend.

If a feature only works because the frontend knows hidden sequencing logic, it is not API-first enough.

For every important frontend workflow, an agent or CLI should be able to do the same thing through documented API calls.


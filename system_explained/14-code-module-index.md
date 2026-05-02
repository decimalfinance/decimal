# 14 Code Module Index

This file explains what the important source files do. Use it as a map when you need to find where a concern lives. Paths are relative to the repo root.

Files that no longer exist but may still appear in old search results:
- `api/src/workspace-addresses.ts` → renamed to `api/src/treasury-wallets.ts`.
- `api/src/payees.ts` — **deleted**.
- `api/src/routes/addresses.ts` → replaced by `api/src/routes/treasury-wallets.ts`.
- `api/src/routes/payees.ts` — **deleted**.
- `api/src/api-keys.ts`, `api/src/routes/api-keys.ts` — **deleted** during lean cleanup.
- `api/src/agent-tasks.ts`, `api/src/agent-task-events.ts`, `api/src/routes/agent.ts` — **deleted** during lean cleanup.
- `api/src/address-label-registry.ts`, `api/src/routes/address-labels.ts` — **deleted**. Destination/counterparty labels are workspace-owned now.
- `api/src/routes/transfer-requests.ts` — **deleted**. Transfer requests remain an internal reconciliation model; public workflows use payment requests/orders/runs.

## Backend Core (`api/src/`)

### App composition

- `app.ts` — Express app wiring. Middleware order, route mounting, error handler.
- `server.ts` — boots the app, binds the port.
- `config.ts` — env parsing, derived config, feature flags.
- `prisma.ts` — Prisma client singleton.
- `api-contract.ts` — canonical endpoint contracts, consumed by the OpenAPI generator and the frontend types (indirectly).
- `openapi.ts` — turns `api-contract.ts` into the `/openapi.json` response.
- `api-errors.ts` — typed error classes (`NotFoundError`, `ValidationError`, etc.) and HTTP mapping.
- `api-format.ts` — JSON response helpers (pagination shapes, list envelopes).
- `rate-limit.ts` — request rate-limit middleware.
- `route-helpers.ts` — `asyncRoute`, pagination/list schemas, response helpers.
- `workspace-access.ts` — `assertWorkspaceAccess` / `assertWorkspaceAdmin` checks used by every workspace-scoped route.

### Auth and access

- `auth.ts` — login, session creation, session lookup, `requireAuth` middleware.
- `idempotency.ts` — idempotency-key handling backed by `IdempotencyRecord`.
- `actor.ts` — uniform user actor representation for audit logs.
- `decimal-client.ts` — internal HTTP client used by the API to talk to the worker and back.

### Treasury wallets, destinations, counterparties, collection sources

- `treasury-wallets.ts` — CRUD for workspace treasury wallets. Handles `usdcAtaAddress` derivation on create. Serializes rows for the API.
- `destinations.ts` — CRUD for `Destination` + `Counterparty`. Destinations store `walletAddress` directly; this module enforces the `(workspaceId, walletAddress)` uniqueness and the trust-state transitions.
- `collection-sources.ts` — CRUD for `CollectionSource` (saved expected payer wallets). Handles `findOrCreateCollectionSourceForPayer` used by the collections service when a payer is referenced by raw wallet address.
- `pricing.ts` — SOL/USD price with a 60-second in-memory TTL. Uses Binance `SOLUSDT`, with stale fallback if the HTTP call fails. Consumed by `/treasury-wallets/balances`.
- `solana.ts` — Solana helpers: RPC client, ATA derivation, balance fetch.

### Business intent and workflow

- `payment-requests.ts` — request service: create, import CSV, preview, materialize-to-order.
- `payment-runs.ts` — batch service: CSV import with idempotent fingerprinting, prepare execution, attach signature, cancel/close.
- `payment-run-state.ts` — derived state for a `PaymentRun` based on its child orders.
- `payment-orders.ts` — order service: submit, cancel, prepare, attach signature, proof.
- `payment-order-state.ts` — state machine for a single `PaymentOrder`.
- `collections.ts` — collection request service: create / list / cancel / proof, plus CSV import preview. Resolves `collectionSourceId` or raw payer wallet into the underlying `TransferRequest` with `requestType: 'collection_request'`.
- `collection-runs.ts` (if present) / collection batch helpers in `collections.ts` — CSV import for a `CollectionRun`, mirroring `payment-runs.ts` shape.
- `collection-request-proof.ts` / `collection-run-proof.ts` — JSON proof packets for collections (parallel to the payment-side proof modules).
- `approval-policy.ts` — policy evaluation. Reads `ruleJson` and decides whether a request is auto-cleared, routed, or needs escalation.
- `execution-records.ts` — `ExecutionRecord` creation and updates. Used when preparing packets and attaching signatures.
- `transfer-request-lifecycle.ts` — the transfer-request-level state machine.
- `transfer-request-events.ts` — append-only event writing for `TransferRequestEvent`.
- `payment-order-proof.ts` — canonical JSON proof packet for one payment order (digest is a SHA-256 of the sorted representation).
- `payment-run-proof.ts` — proof packet for a run (aggregates child packets).
- `payment-proof-markdown.ts` — human-readable Markdown rendering of a proof packet.
- `proof-packet.ts` — shared helpers (canonical stringify, digest computation).

### Reconciliation and observation

- `reconciliation.ts` — joins observed transfers ↔ expected transfer requests, classifies outcomes (exact/split/partial/overfill/exception).
- `reconciliation-timeline.ts` — builds the per-request event-log view.
- `observed-transfers.ts` — helpers for reading observed transfers from ClickHouse.
- `clickhouse.ts` — ClickHouse client factory and query helpers.
- `matching-index-events.ts` — SSE fan-out for matching-index invalidations.
- `matching-context.ts` (if present) — per-workspace matcher context bundling.

### Routes (`api/src/routes/`)

One file per route group; each wires its own router that `app.ts` mounts. Current files:

- `health.ts`, `capabilities.ts`, `openapi.ts`
- `auth.ts` (register / login / logout / session), `organizations.ts`
- `treasury-wallets.ts` *(replaces old `addresses.ts`)*
- `destinations.ts`
- `collection-sources.ts`, `collections.ts` *(handles both collection requests and collection runs)*
- `payment-requests.ts`, `payment-runs.ts`, `payment-orders.ts`
- `approvals.ts`, `events.ts`
- `ops.ts`
- `internal.ts`

There is **no `payees.ts`** route module, and **no `addresses.ts`** route module.

### Tests (`api/tests/`)

- `control-plane.test.ts` — core flows (auth, orgs, workspaces, destinations, policy).
- `payment-orders.test.ts` — order creation, submission, approval, preparation, signature attach, proof export.
- `payment-run-state.test.ts` — run-derived-state unit tests.
- `transfer-request-lifecycle.test.ts` — transfer-request state machine.
- `api-contract.test.ts` — guards against `api-contract.ts` drifting from actual handlers.
- `clickhouse.test.ts` — ClickHouse reader helpers.

## Frontend (`frontend/src/`)

The frontend was fully rebuilt around an institutional dual-theme design system. `App.tsx` is now a router shell; page content lives in `frontend/src/pages/*.tsx`.

### Shell

- `App.tsx` — React Router route table, auth gate, top-level layout, sidebar mounting.
- `Sidebar.tsx` — institutional sidebar with workspace switcher, nav groups (Operations / Registry / Advanced), theme toggle.
- `main.tsx` — React entry.
- `api.ts` — typed HTTP client for every API endpoint the UI uses.
- `domain.ts` — cross-cutting helpers: address shortening, USDC formatting, Solana wallet discovery / signing.
- `status-labels.ts` — mapping from derived states → display strings and tones.
- `csv-parse.ts` — client-side CSV preview parser used by the import dialog.
- `proof-json-view.tsx` — structured viewer for proof packets.
- `types.ts` — TypeScript domain types that mirror the API contract.
- `lib/app.ts` — small app-scoped helpers (query keys, etc.).

### Pages (`frontend/src/pages/`)

- `Landing.tsx` + `landing/` (Hero, Features, Workflow, ProductUI, CodeWall, FinalCTA, Icons, heroVisuals/) — pre-auth marketing page served at `/landing`. Same Vercel build, no separate site.
- `CommandCenter.tsx` — workspace Overview. Treasury hero (`$total`, USDC, SOL), operations metric strip, Recent activity table (same shape as the Payments table), onboarding empty state.
- `Wallets.tsx` — Treasury wallets with live RPC balances (USDC + SOL + USD value via Binance), add-wallet modal.
- `Destinations.tsx` — destinations table (the Counterparties.tsx page hosts both).
- `Counterparties.tsx` — destinations + counterparties with trust filters, Edit modal for destinations (label, trust state, counterparty, notes, active flag).
- `Payments.tsx` — unified table of runs + standalone orders. Source column, Origin pill (`Single` / `Batch · N rows`), CSV import dialog with preview and duplicate-fingerprint error surfacing.
- `PaymentDetail.tsx` — single payment order view (approval, execution, reconciliation).
- `PaymentRunDetail.tsx` — run view with lifecycle rail, primary action card (`Approve all` / `Review individually`), per-payment rows, signer selection, proof export.
- `Collections.tsx` — unified list of collection runs + standalone collection requests. New-collection dialog with "Any payer / Known source / New wallet" picker; Known source supports inline source-add via the exported `AddCollectionSourceDialog`.
- `CollectionDetail.tsx` — per-collection-request detail (proof readiness, source review, matched transfer, JSON proof preview).
- `CollectionRunDetail.tsx` — per-collection-run batch view, parallel to `PaymentRunDetail.tsx`.
- `CollectionSources.tsx` — saved expected payer wallets with Add / Edit dialogs and trust filter. Exports `AddCollectionSourceDialog` for inline reuse from `Collections.tsx`.
- `Approvals.tsx` — batch-expandable pending table, runId filter banner (from "Review individually"), green Approve / red Reject, decision history also batch-grouped.
- `Proofs.tsx` — single unified list (batches expand to reveal payments). Inline Preview / Export. Preview dialog renders `ProofJsonView`.
- `Execution.tsx` — All / Ready to sign / In flight / Executed tabs, batch-expandable rows with aggregated signature display.
- `Settlement.tsx` — All / Matched / Pending / Exceptions tabs, per-row match pill and signature/time.

### UI primitives

- `ui/Toast.tsx` — toast provider (success / error / info).

### Styles (`frontend/src/styles/`)

- `design-tokens.css` — `--ax-*` tokens shared by both themes.
- `canonical.css` — the canonical component layer: buttons, inputs, dialogs, tables, pills, metrics, `rd-table` with batch-expandable conventions.
- `run-detail.css` — `rd-*` classes used across Payments / Payment run detail / Proofs / Execution / Settlement / Approvals.
- `sidebar.css` — sidebar layout and item states.
- `app-dark.css` — dark theme overrides (applied via `:root[data-theme='dark']`).
- `styles.css` (legacy) — older layout/spacing rules being phased out. New code should prefer `canonical.css` and `run-detail.css`.

The dark/light theme toggle is wired in `Sidebar.tsx` and persists in `localStorage` under `decimal.theme`.

## Yellowstone Worker (`yellowstone/src/`)

- `main.rs` — binary entrypoint.
- `config.rs` — env parsing.
- `control_plane.rs` — talks to the API's `/internal/*` routes: fetches the matching index, subscribes to invalidations via SSE, reports worker stage events.
- `storage.rs` — ClickHouse writes (JSONEachRow inserts for observed data).
- `yellowstone/mod.rs` — the main loop: subscribe to gRPC transactions, build the matching index, reconstruct USDC transfers, reconstruct payments, run the matcher.
- `yellowstone/transaction.rs`, `transfer.rs`, `payment.rs`, `matcher.rs` — stage-specific modules (exact names may vary — check the `mod` tree).

The worker only treats `TreasuryWallet.address` entries as "ours." Destination wallet addresses are the expected counterparty side of a match, not part of the owned set.

## Infrastructure

- `Makefile` — `make prod-backend` (production-backed runtime serving https://decimal.finance), `make dev` (full local stack), `make infra-up`, `make test`, `make backup-db` / `make restore-db` / `make list-backups`, `make reset-data`, `make reset-prod-data`, individual `dev-api` / `dev-frontend` / `dev-worker` / `tunnel`. `.SILENT` is set so recipe text is not echoed.
- `docker-compose.yml` — Postgres + ClickHouse dev stack. Container names: `usdc-ops-postgres`, `usdc-ops-clickhouse`. Postgres volume: `stablecoin_intelligence_postgres_data`.
- `vercel.json` — frontend deploy config (static SPA, no functions).
- `postgres/init/001-control-plane.sql` — initial Postgres seed / support objects (idempotent CREATE IF NOT EXISTS). Note: `002-supabase-hardening.sql` was deleted 2026-04-26 when the project moved off Supabase to local docker — it would have errored against any non-Supabase Postgres because it referenced the `anon` and `authenticated` roles.
- `clickhouse/init/` — observed-data tables, matcher events, settlement matches, exceptions.
- `config/worker.config.json` — non-secret runtime settings for the Yellowstone worker (gRPC endpoint, ClickHouse URL, control-plane API URL, refresh interval).
- `config/frontend.public.json` — non-secret browser-facing values (`apiBaseUrl`, `solanaRpcUrl`).
- `scripts/reset-prod-data.sh` — generic Postgres + ClickHouse truncate, prompts for confirmation. Operates on whatever `DATABASE_URL` points at.

## Repo-root docs and briefs

- `brand.md` — brand direction (colors, typography, voice). Source of truth for `--ax-*` tokens.
- `landing-page-content.md` — marketing landing brief (positioning, section spec, brand tokens summary, handoff flow).
- `system_explained/` — this onboarding folder.

## How to add a new feature cleanly

1. Decide which layer it touches: input / control / execution / verification / proof.
2. Add or modify the Prisma model in `api/prisma/schema.prisma` if needed. Write a migration via `make migrate`.
3. Add the service logic under `api/src/<feature>.ts`.
4. Expose it via a route in `api/src/routes/<feature>.ts` and register the router in `app.ts`.
5. Update `api/src/api-contract.ts` so `/openapi.json` reflects the new shape.
6. Add a test in `api/tests/<feature>.test.ts`.
7. If the feature touches the matching index, bump invalidations via `matching-index-events.ts`.
8. Add a frontend method to `frontend/src/api.ts`.
9. Update the relevant page under `frontend/src/pages/` or add a new one and register its route in `App.tsx`.
10. If the page introduces new UI patterns, use the `rd-*` classes and `--ax-*` tokens — do not hardcode colors.
11. Update `system_explained/` (this folder). At minimum: this module index, the API route catalog (`13-...`), and whichever chapter is load-bearing for the new feature.

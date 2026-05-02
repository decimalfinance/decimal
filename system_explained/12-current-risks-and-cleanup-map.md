# 12 Current Risks And Cleanup Map

This file is intentionally direct. It lists the main risks and cleanup areas that a new engineer should understand before making changes.

## Recently resolved (context — do not reopen)

- **Schema split** (landed 2026-04-19): `WorkspaceAddress` → `TreasuryWallet`; `Destination` made first-class (stores `walletAddress` directly); `Payee` removed entirely; `Counterparty` is an optional org-scoped tag. All compat shims removed. Old code that still mentions the legacy names is actively legacy.
- **Frontend v2**: fully rebuilt around an institutional dual-theme design system (`--ax-*` tokens, `brand.md`). All primary pages use the `rd-*` batch-expandable pattern. Toast system, institutional sidebar, and the Decimal positioning landed.
- **Pricing**: SOL/USD via Binance SOLUSDT with a 60s TTL and stale fallback, wired into `/treasury-wallets/balances`.

## Doc-staleness risk

- `system_explained/` was last reconciled with the schema split on 2026-04-20. If you land changes to the schema, routes, or page structure, update the relevant chapter (usually 04, 09, 13, 14) in the same PR. A stale doc is worse than no doc.
- External price dependency on Binance is not alerted on — if the endpoint fails and stale fallback also fails, balances will show `"solUsdPrice": null` and the Overview hero falls back to USDC-only. Consider adding ops-health coverage.

## Product Risks

### Input Layer Is Still Young

Payment requests and CSV import exist, but Decimal does not yet deeply plug into real customer workflows.

Needed:

- better CSV validation/reporting
- payroll/vendor payout run UX
- import templates
- API import examples
- external request sources

### Execution Is Credible But Not Fully Mature

Decimal can prepare/sign/submit through a browser wallet path, but execution UX and integration options need hardening.

Needed:

- better wallet compatibility errors
- multisig/Squads proposal generation
- clearer source wallet balance checks
- transaction simulation before signing
- execution retry/replacement story

### Proof Needs Product Packaging

Proof exists, but a proof packet should become a polished artifact.

Needed:

- short human summary
- deterministic canonical digest
- full evidence appendix
- downloadable PDF/Markdown/JSON variants
- proof verification instructions

## Backend Risks

### Large Service Modules

`payment-orders.ts` and `payment-runs.ts` are large.

Future split candidates:

- order creation service
- approval orchestration service
- execution packet service
- signature attachment service
- order read model service
- run import service
- run execution service
- proof service

### Route Contract Drift

The backend has route implementations and an API contract file.

Risk:

```text
route exists but OpenAPI contract is stale
```

Mitigation:

- update `api-contract.ts` with every route change
- keep `api/tests/api-contract.test.ts` strict

### Error Model Is Too Generic

Many domain errors are thrown as `Error`.

Needed:

- typed domain errors
- stable error codes
- better HTTP status mapping
- structured validation details

This matters for agents.

### Role/Permission Model Is Basic

API scopes exist, but human roles are still simple.

Needed:

- explicit permissions
- role inheritance
- protected high-risk actions
- audit log for all privileged actions

## Reconciliation Risks

### Classification Must Stay Conservative

Past issue: unrelated transaction was labeled as fee.

Rule:

```text
Unknown is better than wrong.
```

The worker should not over-classify swaps or unrelated activity.

### Duplicate Matching Ambiguity

Two same-amount pending payments to same destination can be ambiguous without signature/source/reference.

Mitigation:

- duplicate detection
- signature-first matching
- source wallet matching where possible
- clear confidence/explanation in proof

### Partial Exception Lifecycle

When a partial settlement is later fully satisfied, exceptions should be updated/dismissed correctly.

This behavior is important and should have tests.

### Negative Label Cache

Repeated Orb label logs are a known operational smell.

Needed:

- negative cache
- TTL
- workspace labels first
- log suppression

## Worker Risks

### Provider Differences

Yellowstone providers differ.

Known issue:

- `from_slot is not supported`

Needed:

- provider capability detection
- explicit live-only mode
- replay/backfill strategy if needed

### Reconnect Semantics

Reconnects must not double-process transactions or miss relevant updates silently.

Needed:

- clearer checkpoint/finality model
- metrics for reconnects
- more tests around dedupe

### High-Volume Filtering

The architecture should avoid storing all USDC activity.

Needed:

- ensure only relevant materialized rows are retained
- benchmark filtering throughput

## Frontend Risks

### `App.tsx` cleanup is partially done

`App.tsx` was once ~5,400 lines of inline page components. Most user-facing pages (Payments, Collections, Approvals, Execution, Settlement, Proofs, Wallets, Counterparties, CommandCenter, Landing, plus the *Detail variants) are now extracted to `frontend/src/pages/`. As of 2026-04-26 `App.tsx` is still ~5,280 lines because:

- Router shell, auth gate, and shared layout still live there.
- Legacy inline pages (Policy, Exceptions, parts of the address book) haven't been extracted.
- Several large shared components (table primitives, lifecycle rails, dialog templates) are still inline.

Remaining cleanup:

- extract Policy and Exceptions into pages
- pull shared table/dialog primitives out of App.tsx
- centralize lifecycle UI components

### UX Still Needs Institutional Polish

The UI is functional, but not final.

Needed:

- stronger information architecture
- fewer raw state labels
- clear next-action surfaces
- consistent data tables
- detail pages instead of overloaded modals where appropriate

### Frontend Should Not Own Business Logic

Any rule that affects payment safety belongs in the backend.

Frontend can guide users, but backend must enforce.

## Observability Risks

### Observability Needs Product Ownership

Production metrics need ownership.

Needed:

- alert thresholds
- ingestion lag alerts
- exception spike alerts
- route error alerts
- proof/export failure alerts

### Log Noise

Repeated matching refresh logs or unknown-address logs can hide real errors.

Needed:

- structured logs
- log levels
- suppression/cooldowns

## API Client Risks

### API Client Surface Is Early

The API is usable by scripts, but machine-client auth and a validated agent workflow were intentionally removed from the lean build.

Needed before bringing agents back:

- concrete agent workflow
- machine-auth threat model
- integration tests with a real client
- safer action permissions
- better OpenAPI examples

### API Clients Need Better Error Codes

Agents need stable machine-readable errors, not only human messages.

Needed:

- typed errors
- remediation hints
- retryability flags

## Cleanup Priority

Recommended cleanup order:

1. Stabilize API contract and typed errors.
2. Split payment order/run service modules.
3. Add tests for signature-first matching, partial-to-settled transition, and proof output.
4. Keep unknown-address handling local and quiet.
5. Harden execution packet/signature workflow.
6. Validate a real machine-client workflow before reintroducing agent auth/tasks.
7. Split frontend pages/components.
8. Redesign UX once backend semantics are stable.

## What Not To Remove Casually

Do not delete these just because they look indirect:

- `TransferRequest`: matcher still depends on it.
- `ExecutionRecord`: separates approval from actual execution evidence.
- `PaymentOrderEvent` and `TransferRequestEvent`: audit/proof timeline.
- `ExceptionState`: overlays operator workflow onto ClickHouse exceptions.
- matching-index SSE: avoids polling.
- `IdempotencyRecord`: important for safe API retries.

## What Can Probably Be Simplified Later

- legacy wording around expected transfers
- duplicate frontend table implementations
- old README files that no longer match product
- direct transfer-request creation flows if payment orders fully replace them
- excessive proof JSON verbosity
- route-heavy logic once service modules are split

## Collections-Specific Risks

The collections wedge landed recently (CollectionRequest / CollectionRun / CollectionSource entities, frontend pages, source-wallet match guard). It is functional and demoable, but the polish lags payouts:

- **No historical backfill.** The Yellowstone worker only sees live slots. A collection created BEFORE the worker started will never match retroactively. Same constraint as payouts — affects collections more because users naturally try inbound test payments before bringing the worker up.
- **Source trust workflow is shallow.** `CollectionSource.trustState` exists but there's no review queue or approval-policy hook for unreviewed sources analogous to destination trust on the payout side.
- **No source verification beyond label.** A user can save a CollectionSource for any wallet address; nothing currently proves the wallet actually belongs to the named counterparty. Future: signed-message verification, KYB hook, or oracle attestation.
- **Inbound timing UX is sparse.** No "expected by" SLA, no late-payment escalation. Collections with a `dueAt` in the past don't surface anywhere prominent.
- **No duplicate-source detection across workspaces.** A wallet labeled "Acme — ops" in one workspace might be flagged differently in another. Outside MVP scope.

## Operational Risks (laptop-hosted production)

The "production" runtime serving https://decimal.finance runs on the user's laptop. This is intentional (free, low latency, see `local_prod_architecture.md`) but adds operational risks not present in managed-infra setups:

- Mac sleep / lid close kills the cloudflared tunnel. Mitigation: `caffeinate -i make prod-backend`.
- Internet drop kills the API entirely. Mitigation: mobile hotspot backup before any demo.
- Data loss if the docker volume is removed (`docker compose down -v`). Mitigation: `make backup-db` before risky operations; backups land in `./backups/`.
- No automated monitoring / restart on crash. The Vercel frontend will keep loading but every API call will 502 until the tunnel is back.

These are explicitly accepted for the hackathon + grant period. Migrating to a hosted API + DB is a follow-up.

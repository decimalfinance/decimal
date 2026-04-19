# 12 Current Risks And Cleanup Map

This file is intentionally direct. It lists the main risks and cleanup areas that a new engineer should understand before making changes.

## Recently resolved (context — do not reopen)

- **Schema split** (landed 2026-04-19): `WorkspaceAddress` → `TreasuryWallet`; `Destination` made first-class (stores `walletAddress` directly); `Payee` removed entirely; `Counterparty` is an optional org-scoped tag. All compat shims removed. Old code that still mentions the legacy names is actively legacy.
- **Frontend v2**: fully rebuilt around an institutional dual-theme design system (`--ax-*` tokens, `brand.md`). All primary pages use the `rd-*` batch-expandable pattern. Toast system, institutional sidebar, and the Axoria positioning landed.
- **Pricing**: SOL/USD via Binance SOLUSDT with a 60s TTL and stale fallback, wired into `/treasury-wallets/balances`.

## Doc-staleness risk

- `system_explained/` was last reconciled with the schema split on 2026-04-20. If you land changes to the schema, routes, or page structure, update the relevant chapter (usually 04, 09, 13, 14) in the same PR. A stale doc is worse than no doc.
- External price dependency on Binance is not alerted on — if the endpoint fails and stale fallback also fails, balances will show `"solUsdPrice": null` and the Overview hero falls back to USDC-only. Consider adding ops-health coverage.

## Product Risks

### Input Layer Is Still Young

Payment requests and CSV import exist, but Axoria does not yet deeply plug into real customer workflows.

Needed:

- better CSV validation/reporting
- payroll/vendor payout run UX
- import templates
- API import examples
- external request sources

### Execution Is Credible But Not Fully Mature

Axoria can prepare/sign/submit through a browser wallet path, but execution UX and integration options need hardening.

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
- define raw observation retention
- benchmark filtering throughput

## Frontend Risks

### Large `App.tsx`

The frontend has too much page/component logic in one file.

Needed:

- split pages
- split shared table components
- split modals/drawers
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

### Grafana Is Present But Needs Operational Ownership

Dashboards exist, but production metrics need ownership.

Needed:

- alert thresholds
- ingestion lag alerts
- exception spike alerts
- route error alerts
- proof/export failure alerts

### Log Noise

Repeated label resolver logs and matching refresh logs can hide real errors.

Needed:

- structured logs
- log levels
- suppression/cooldowns

## Agent Risks

### Agent Surface Is Early

Agent tasks exist, but no real agent has been validated end-to-end.

Needed:

- agent integration tests
- example agent scripts
- task execution receipts
- safer action permissions
- better OpenAPI examples

### Agents Need Better Error Codes

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
4. Add negative cache for unresolved address labels.
5. Harden execution packet/signature workflow.
6. Add agent end-to-end workflow tests.
7. Split frontend pages/components.
8. Redesign UX once backend semantics are stable.

## What Not To Remove Casually

Do not delete these just because they look indirect:

- `TransferRequest`: matcher still depends on it.
- `ExecutionRecord`: separates approval from actual execution evidence.
- `PaymentOrderEvent` and `TransferRequestEvent`: audit/proof timeline.
- `ExceptionState`: overlays operator workflow onto ClickHouse exceptions.
- matching-index SSE: avoids polling.
- API keys/idempotency: important for agent/API-first direction.

## What Can Probably Be Simplified Later

- legacy wording around expected transfers
- duplicate frontend table implementations
- old README files that no longer match product
- direct transfer-request creation flows if payment orders fully replace them
- excessive proof JSON verbosity
- route-heavy logic once service modules are split


# Axoria Implementation Checklist

## API-First And Agents

- [x] Granular API key scopes enforced per route, not just stored.
- [x] Idempotency keys for all mutating endpoints.
- [x] Agent audit identity cleanup so events/notes/approvals clearly show user, api_key, system, or worker.
- [ ] OpenAPI spec for the full backend.
- [ ] MCP server wrapper for agent tools.
- [x] Rate limiting and abuse protection for public/API-key routes.
- [x] Request correlation IDs and structured error codes.
- [x] Webhooks or SSE for agent task updates instead of repeated polling.
- [ ] Agent-safe dry-run mode for payment creation, approval decisions, execution prep, and exception actions.
- [ ] Stronger permission model: owner/admin/operator/viewer/agent roles.
- [ ] Workspace-level API key management UI in frontend.
- [ ] Production auth upgrade: real user auth, passwordless/OAuth, organization invites, session hardening.
- [ ] Secrets/config hardening for production deployment.

## Reconciliation And Matching

- [ ] Reconciliation confidence scoring cleanup.
- [x] Signature-first reconciliation made the default for app-originated payments.
- [x] Better handling for unmatched but relevant transfers.
- [ ] Better handling for overpayment, underpayment, duplicate payment, wrong source, wrong destination, late settlement, and split settlement.
- [ ] Clear reconciliation state machine with explicit terminal states.
- [x] Reconciliation re-run/recompute endpoint for a request, payment order, or workspace.
- [x] Matching explainability endpoint that shows why a transfer matched or did not match.
- [ ] Historical backfill controls for watched wallets.
- [ ] Data retention policy for raw observations, observed transfers, matches, exceptions, and audit exports.
- [x] Reconciliation metrics exposed for Grafana: match latency, unmatched count, partials, exceptions, stale approvals, stale executions.

## Payment Runs And Input Layer

- [ ] Payment run workflow hardening.
- [ ] Batch transaction signing UX improvement.
- [ ] Batch payment partial failure handling.
- [x] Payment run proof packet.
- [x] Payment run reconciliation summary.
- [ ] Payment run cancellation/close lifecycle.
- [ ] Payment run idempotent CSV import.
- [ ] CSV validation preview before committing rows.
- [x] CSV import error report with row numbers and reasons.
- [ ] Duplicate payee/destination/reference detection during import.
- [ ] Payee merge/edit/archive flows.
- [ ] Destination trust review workflow.

## Execution Layer

- [ ] Execution layer cleanup.
- [ ] Wallet adapter UX hardening.
- [ ] Better connected-wallet/source-wallet validation.
- [ ] Recent blockhash and transaction expiry handling.
- [ ] Submitted signature tracking tied directly to prepared packet IDs.
- [ ] Retry/replacement transaction handling.
- [ ] Manual external execution evidence flow cleanup.
- [ ] Squads proposal generation.
- [ ] Optional multisig execution integration.
- [x] Source wallet balance snapshots before execution.
- [x] Insufficient balance warnings before preparing packets.

## Proof And Audit

- [x] Proof and audit improvements.
- [ ] Human-readable payment proof packet.
- [x] JSON proof packet for agents.
- [x] CSV/PDF export polish.
- [x] Cryptographic proof bundle or signed audit manifest.
- [x] Full timeline export across payment request, order, execution, settlement, exception, and proof.
- [x] Workspace-level audit log endpoint.
- [ ] Export history cleanup and retention.

## Frontend Product Flow

- [ ] Frontend product flow revamp.
- [ ] Workspace API key management page.
- [x] Payment request detail page.
- [x] Payment run detail page.
- [x] Payment order detail page cleanup.
- [x] Exception detail page cleanup.
- [x] Approval inbox page.
- [x] Execution queue page.
- [x] Reconciliation queue page.
- [x] Proof packet viewer.
- [ ] Agent tasks/admin page.
- [x] Better onboarding: org, workspace, wallets, destinations, policy, first payment run.
- [ ] Institutional-grade UI pass after backend flows stabilize.

## Observability And Operations

- [x] Grafana dashboard refinement.
- [x] API latency metrics.
- [x] Worker stream health metrics.
- [x] Matching engine metrics.
- [ ] Error-rate metrics by route and worker stage.
- [ ] Dead-letter/error table for failed processing.
- [ ] Alerting rules for worker disconnect, stale stream, high exception rate, API failures.
- [x] Structured logs with request IDs.
- [ ] Production deployment checklist.
- [ ] Backup and restore plan for Postgres and ClickHouse.

## Backend Architecture Cleanup

- [ ] Split route handlers from service logic consistently.
- [x] Normalize actor handling across all services.
- [ ] Normalize state transitions into explicit service modules.
- [ ] Add domain-level tests separate from route tests.
- [ ] Add contract tests for agent/API clients.
- [ ] Add OpenAPI-generated client or typed SDK.
- [x] Remove remaining frontend-shaped response assumptions.
- [ ] Standardize pagination, filters, sorting, and error responses.
- [ ] Standardize date/time and amount formatting at API boundaries.

## Security Hardening

- [ ] CSRF/session hardening for human auth.
- [ ] API key rotation.
- [ ] API key expiration enforcement UI.
- [x] API key last-used visibility.
- [x] Audit all sensitive mutations.
- [x] Prevent API keys from managing API keys.
- [x] Scope-sensitive route enforcement.
- [ ] Input validation review across all endpoints.
- [ ] Dependency/security audit.
- [ ] Threat model for agents, execution, and proof exports.

## Product Expansion Candidates

- [ ] Payroll-style batch flow prototype.
- [ ] Vendor payout workflow.
- [ ] Contractor payout workflow.
- [ ] DAO grant payout workflow.
- [ ] Recurring payment requests.
- [x] Payment request approvals by policy threshold.
- [ ] Webhook/API ingestion from external systems.
- [x] Email/CSV input layer beyond manual forms.
- [ ] Accounting export formats.
- [ ] Design partner feedback loop before deeper AP/payroll work.

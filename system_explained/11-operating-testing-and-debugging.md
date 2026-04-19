# 11 Operating Testing And Debugging

This file explains how to run, test, and debug Axoria locally.

## Start Everything

```bash
make dev
```

This starts:

- Postgres
- ClickHouse
- API
- frontend
- Yellowstone worker if configured

## Start Infrastructure Only

```bash
make infra-up
```

Use this when running API/frontend manually.

## Start Grafana

```bash
make grafana-up
```

Grafana:

```text
http://127.0.0.1:3001
admin / admin
```

## Run Tests

```bash
make test
```

Individual:

```bash
make test-api
make test-worker
make test-frontend
```

## Current Test Coverage

API tests include:

- API contract.
- ClickHouse integration.
- Control plane workflow.
- Payment orders.
- Payment run state.
- Transfer request lifecycle.

Frontend tests are present through the frontend test command.

Worker tests run through Cargo if Rust tests exist in the crate.

## Health Checks

API health endpoints are public.

Ops health endpoints are workspace-scoped and protected.

Use ops health to understand:

- worker freshness
- API route health
- matching latency
- exception counts
- ClickHouse reachability

## Debug A Payment That Did Not Settle

Work through this checklist.

### 1. Check Payment Order

In API/frontend:

- Does the payment order exist?
- Is it approved?
- Does it have a destination?
- Does it have a source wallet if expected?
- Does it have a transfer request?
- Does it have a submitted signature?

### 2. Check Matching Index

Confirm the worker knows about it.

Questions:

- Did the API emit a matching-index refresh event?
- Did the worker log a new matching-index version?
- Does the index include the transfer request?
- Does the index include the submitted signature?
- Does the index include the destination token account/wallet?

### 3. Check Solana Transaction

Questions:

- Did the transaction confirm?
- Was it mainnet/devnet consistent with the worker endpoint?
- Was it USDC mint expected by Axoria?
- Did it transfer to the intended token account/wallet?
- Was the amount raw value correct?

### 4. Check ClickHouse

Query by signature:

```sql
SELECT * FROM observed_transactions WHERE signature = '<signature>';
SELECT * FROM observed_transfers WHERE signature = '<signature>';
SELECT * FROM observed_payments WHERE signature = '<signature>';
```

Query matches:

```sql
SELECT * FROM settlement_matches WHERE has(matched_signatures, '<signature>');
```

### 5. Check Exceptions

```sql
SELECT * FROM exceptions WHERE signature = '<signature>';
```

Then check API exception overlays.

## Debug Repeated Matching Index Refreshes

Repeated logs:

```text
Matching index refreshed to version N.
```

mean the worker received refresh events or refreshed on startup/reconnect.

If it refreshes constantly:

- inspect API mutation traffic
- inspect matching-index invalidation middleware
- inspect frontend polling/mutations
- inspect SSE reconnect behavior

The worker should not need polling to stay fresh.

## Debug Repeated Orb Label Logs

Repeated logs like:

```text
[address-label-registry] Orb returned no usable labels for 1 unresolved address(es)
```

mean the label resolver is repeatedly trying to resolve an address that Orb cannot label.

Correct behavior should be:

- use workspace labels first
- use saved wallet/destination labels first
- cache negative Orb result
- avoid repeated log spam

## Debug CORS

Local frontend may run on different ports.

The API should allow localhost/127.0.0.1 dev origins.

If a browser request fails with CORS:

- check method is allowed
- check route exists
- check CORS config includes method
- check API server actually restarted after changes

## Debug Wallet Signing

If sign/submit fails:

- verify browser wallet is installed
- verify correct wallet is selected
- verify selected public key equals required signer
- verify RPC endpoint is reachable
- verify recent blockhash can be fetched
- verify transaction is built with correct accounts
- verify source wallet has USDC token account and balance

The frontend uses configured RPC. A 403 from RPC means provider access issue, not necessarily an Axoria transaction bug.

## Debug CSV Import

Expected header:

```csv
counterparty,destination,amount,reference,due_date
```

`counterparty` is optional human-readable context. `destination` is the external Solana wallet address of the recipient. Re-importing the same CSV returns the existing `PaymentRun` with `importResult.imported: 0` (idempotent by fingerprint); the frontend surfaces this as an error toast ("This CSV was already imported as …").

If import does nothing:

- open browser console
- check network request
- check API validation error
- verify button handler submits correctly
- verify backend route accepts body shape
- verify destination/wallet validation rules

## Reset Local Data

```bash
make reset-data
```

This deletes local Docker volumes and restarts clean.

Only use when intentionally discarding local state.

## Development Safety Rules

- Do not change payment lifecycle states without tests.
- Do not change matcher allocation behavior without tests.
- Do not change proof packet shape without checking consumers.
- Do not change API route paths without updating `api-contract.ts`.
- Do not make frontend the only place where business rules exist.
- Do not store all observed world data just because the stream has it.


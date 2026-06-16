# Executed Payment Stuck “Unverified”, Sync Could Never Fix It

## Summary

A 2-of-2 payment proposal was **fully executed on-chain** — the USDC moved, the Squads `Proposal` account was `Executed`, both approvals were in — yet the product showed it as **executed-but-unverified** (DB `status = submitted`, `executed_signature = null`, no stored settlement verification). The **Sync** button never fixed it.

Investigation uncovered **three stacked bugs**, each of which independently blocked settlement verification. Any one of them is enough to leave a real, finalized payment looking unverifiable forever:

1. **Wrong cluster** — settlement/signature reads used the backend’s *primary* RPC (mainnet under `make prod-backend`), while the payment lived on **devnet**.
2. **Wrong signature** — Sync verified `executedSignature ?? submittedSignature`, which fell back to the proposal-**creation** transaction (no USDC transfer), because the real execution signature was never recorded.
3. **Recent-cache-only signature check** — `getSignatureStatuses` without `searchTransactionHistory` returns `null` for any signature older than a few minutes, so an older-but-finalized execution read back as **“has not landed on chain.”**

The misleading part: **fresh** payments verified fine, so nothing looked broken until a payment was reconciled minutes/hours after execution.

## Symptom

- A payment that was demonstrably executed (visible and finalized on Solscan, devnet) showed in the app as executed but **never settlement-verified**.
- Clicking **Sync** did nothing useful. Depending on which surface and which fix had landed, it either:
  - silently no-op’d (the frontend swallowed the error), or
  - returned `400 bad_request: "Transaction signature has not landed on chain."` with the **correct** execution signature in `details.signature`.

## Investigation (how the layers were peeled)

The signature the operator was looking at (`5mTN…`) turned out to be the **proposal-creation** transaction, not an execution:

| signature | instruction(s) | USDC moved |
|---|---|---|
| `5mTN…` | `VaultTransactionCreate` + `ProposalCreate` (tx index 7) | — |
| `3K6pE…` | `ProposalApprove` | — |
| `ZGHeu…` | `ProposalApprove` | — |
| **`4kJr4…`** | **`VaultTransactionExecute`** | **yes (USDC)** |

DB row for the proposal:

```
semantic_type     = send_payment
status            = submitted          <- never advanced
executed_signature= (null)             <- execution never recorded
submitted_signature = 5mTN…            <- the creation tx
transaction_index = 7
squads_multisig_pda = H8x8FbqM…
rpcSettlementVerification = (none)
```

On-chain (`Proposal.fromAccountAddress`, devnet): `status = { __kind: 'Executed' }`, `approved.length = 2`, multisig threshold 2. **The payment really happened; the app just never recorded or verified it.**

## Root Cause

### 1. Verification queried the wrong cluster

`config.solanaRpcUrl` resolves from `SOLANA_RPC_URL` (or the network default). The running prod backend is started with **`make prod-backend`**, which is `prod-backend-mainnet` → **mainnet**. The devnet payment had been created during a `make dev devnet` run, so the treasury, proposal, and all four transactions live on **devnet**. The DB carries no per-treasury network marker (single-network-per-backend design), so nothing in the data signals “this is devnet.”

Both read paths used the single global primary connection:

- `api/src/solana.ts` — `verifyUsdcSettlementFromSignature` → `getSolanaConnection().getParsedTransaction(...)`
- `api/src/squads/treasury.ts` — `checkRpcSignatureStatus` → `waitForSignatureVisible(getSolanaConnection(), ...)`

Proven directly on the execution signature:

```
PRIMARY (mainnet RPC): getParsedTransaction => NULL
DEVNET  RPC:           getParsedTransaction => FOUND (err: null)
```

A devnet transaction is simply not on a mainnet node, so the verifier saw `null` and reported `pending` (“transaction not yet available”). The signature-status gate saw `seen: false`. Both wrong-cluster.

### 2. Sync verified the creation signature, not the execution

`confirmDecimalProposalExecution` verifies settlement against whatever signature it’s handed. Both Sync buttons handed it `executedSignature ?? submittedSignature`:

- `frontend/src/pages/OrganizationProposalDetail.tsx` (proposal detail Sync)
- `frontend/src/pages/PaymentDetail.tsx` (payment detail Sync)

With `executed_signature = null`, that fell back to `submitted_signature` = the **`VaultTransactionCreate`** tx, which contains **no USDC transfer**. Settlement verification computes the USDC delta on the destination token account; against the creation tx that delta is 0 → it could only ever be `mismatch`/`pending`, never `settled`.

`executed_signature` was null in the first place **because** confirm-execution had failed at execution time (root causes #1 and #3 below), so the app never captured the real execution signature even though the chain had it.

### 3. `getSignatureStatuses` only returns recent signatures

This was the final, decisive blocker. `checkRpcSignatureStatus` (`api/src/squads/treasury.ts`) gates confirm-execution on whether the signature is visible on chain, via `getSignatureStatuses`. **Without `{ searchTransactionHistory: true }`, `getSignatureStatuses` only consults the recent status cache (~the last few minutes).** Any older signature returns `null` — *even on the correct cluster* — so the code threw:

```
bad_request: "Transaction signature has not landed on chain."
```

Proven on the real execution signature against the devnet RPC:

```
getSignatureStatuses([sig])                                  => null
getSignatureStatuses([sig], {searchTransactionHistory:true}) => {confirmationStatus:"finalized", err:null}
```

This is why **fresh** confirms worked and stale ones didn’t: a just-executed signature is still in the recent cache; an old one has aged out. It silently broke delayed in-app confirms, the agent catching up after a gap, and every reconcile — not just this incident.

## The Fix

### A. Cluster-robust reads (`api/src/solana.ts`)

- `candidateSettlementConnections()` — returns `[primary]`, or `[primary, devnetConnection]` when they differ. Lets a devnet treasury be read even when the backend’s primary RPC is mainnet, with no extra call on a devnet-only backend.
- `getParsedTransactionAcrossClusters(signature)` — used by `verifyUsdcSettlementFromSignature`; tries each cluster, returns the first hit.
- `waitForSignatureVisibleAcrossClusters(signature, opts)` — used by `checkRpcSignatureStatus`; polls every candidate cluster.

### B. Search transaction history (`api/src/solana.ts`)

`waitForSignatureVisibleAcrossClusters` now calls `getSignatureStatuses([signature], { searchTransactionHistory: true })`, so an older finalized signature is found instead of reading back as `null`. (`getParsedTransaction`, used by the verifier, already searches full history, so only the status gate needed this.) The previous single-connection shortcut was removed because it delegated to the non-history `waitForSignatureVisible` and reintroduced the bug on a devnet-only backend.

### C. Recover the missing execution signature from chain (`api/src/squads/treasury.ts`)

- `findVaultExecuteSignatureOnChain(multisigPda, transactionIndex)` — derives the proposal PDA, scans its signature history (across clusters), and returns the signature whose logs contain `VaultTransactionExecute`.
- `reconcileDecimalProposalFromChain(orgId, userId, proposalId)` — if `executed_signature` is missing, discovers it via the above, then feeds it back through `confirmDecimalProposalExecution` (which records it and runs the now-cluster-robust, history-aware verification). Exposed as `POST /organizations/:id/proposals/:id/reconcile`.

### D. Sync → reconcile (frontend)

Both Sync buttons now call `api.reconcileProposalFromChain(...)` instead of re-confirming whatever signature happened to be on hand, and the dead client-side `getSignatureStatuses` poll was removed from the payment-detail Sync:

- `frontend/src/pages/OrganizationProposalDetail.tsx`
- `frontend/src/pages/PaymentDetail.tsx`
- `frontend/src/api.ts` — `reconcileProposalFromChain`

### End-to-end after the fix

reconcile finds `4kJr4…` (the real execution) → `checkRpcSignatureStatus` finds it via history search on devnet → `getParsedTransactionAcrossClusters` reads the USDC delta → `status = settled`, `executed_signature` recorded.

## Why It Took Three Layers

Each bug masked the next:

- Wrong cluster (#1) made the verifier and status gate return `null`/`not seen`, which looks identical to “not landed yet.”
- The missing execution signature (#2) meant even a correct cluster would verify the wrong (transfer-less) transaction.
- The history-cache gate (#3) would have blocked confirmation even with the right signature on the right cluster.

Fresh payments dodged all three because: the backend was on the matching network during that session, the execution signature was recorded immediately, and the signature was still in the recent cache. The failure only appears when you verify after the fact — exactly what reconcile/Sync is for.

## Operational Notes / Prevention

- **`getSignatureStatuses` is a recent-cache lookup.** For any “did this (possibly old) signature land?” check, pass `searchTransactionHistory: true`, or use `getTransaction`/`getParsedTransaction` (which always search full history).
- **The data has no network marker.** A single-network-per-backend design means devnet rows in a mainnet-running backend can only be read via the devnet-fallback connection. If treasuries ever need to span networks intentionally, add an explicit `network` column rather than relying on the cross-cluster probe.
- **Never verify settlement against a non-execution signature.** Settlement = USDC delta on the destination token account; only the `VaultTransactionExecute` tx carries it. Sync/confirm must resolve the execution signature (from chain if necessary), not fall back to the submission/creation signature.
- **Sync lives in two places** (proposal detail and payment detail). Changes to reconciliation behavior must be applied to both.

## Related (same session, tracked separately)

While tracing this, two adjacent changes were made and are worth their own notes if needed:

- **RPC key exposure** — the frontend used the backend’s paid RPC URL (advertised via `/capabilities`) directly in the browser. Added an authenticated backend RPC proxy (`POST /solana/rpc`, allow-listed methods) and a frontend-safe public RPC default so the key stays server-side.
- **Realtime co-signer updates** — replaced slow polling with an SSE stream (`GET /organizations/:id/events`) plus a small in-process event bus, so a co-signer’s screen updates the instant a proposal changes.

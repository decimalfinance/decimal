# Payment UI Showed “Executed” Before Wallet Signing

## Summary

After calling **`POST …/prepare-execution`** (single payment order or payment run batch), the product surfaced **`derivedState === 'execution_recorded'`** and the frontend displayed statuses equivalent to **“Executed”**, even though:

- no Solana transaction had been signed in the browser yet, and  
- **`submittedSignature`** was still empty on the latest execution record.

Operators reasonably interpreted this as “the system executed without asking my wallet,” or assumed recent “API-first / agent-first” work had bypassed signing. **Signing was still required**; the failure was **state derivation and labeling**, not the execution pipeline skipping the wallet.

## Symptom

- Open the execution modal and click **Execute payment(s)**.
- Immediately after the **prepare** API returned, the UI looked like execution was already done (“Executed” / execution bucket / run summary), **without** a wallet prompt yet (or while the next step was still pending).
- Network tab still showed the correct sequence eventually (`prepare-execution` → wallet/RPC → `attach-signature`), but the **first paint after prepare** was misleading.

## Root Cause

### 1. `derivePaymentOrderState` treated “any latest execution row” as post-execution

In `api/src/payment-orders.ts`, `derivePaymentOrderState` maps reconciliation truth into a single `derivedState` string for the API and UI.

**Before the fix**, the logic effectively did:

- If `reconciliationDetail.latestExecution` is non-null → return **`'execution_recorded'`**.

But **`prepare-execution`** (both order-level and run-level flows) **creates** an `ExecutionRecord` in **`ready_for_execution`** and links it as the primary execution artifact **before** any signature exists. Reconciliation surfaces that row as `latestExecution` immediately.

So the moment preparation completed:

- `latestExecution` existed  
- `latestExecution.submittedSignature` was still `null`  
- `latestExecution.state` was still **`ready_for_execution`**  

…yet `derivedState` became **`execution_recorded`**, which elsewhere in the product reads as “execution is done.”

Relevant code path (conceptual; see git history for exact pre-fix lines):

- `api/src/payment-orders.ts` — `derivePaymentOrderState`  
- `api/src/payment-orders.ts` — `preparePaymentOrderExecution` (persists execution record + `preparedExecution` in `metadataJson`, sets order `state` to `execution_recorded` in DB for the payment-order row — separate from `derivedState` but easy to conflate)  
- `api/src/payment-runs.ts` — `preparePaymentRunExecution` (same pattern for batch: execution rows + run `state` updated when preparation is recorded)

The **DB** `payment_order.state` field being `execution_recorded` after “prepare” is intentional internal vocabulary (“we recorded an execution artifact”). The bug was specifically **`derivedState` overloading that internal moment as the same label as “signature attached / past signing.”**

### 2. Frontend status copy mapped `execution_recorded` → “Executed”

In `frontend/src/status-labels.ts`, **`execution_recorded`** is displayed as **“Executed”** (and similar run labels). That is correct **only after** evidence of submission exists; it was wrong for the “prepared, awaiting signature” window.

### 3. (Minor) `getPreparedPacket` looked for the wrong JSON key

The API persists the signer-ready payload under **`metadataJson.preparedExecution`** (see `preparePaymentOrderExecution` writing `preparedExecution` on the execution record).

The frontend helper **`getPreparedPacket`** in `frontend/src/App.tsx` only looked for **`metadataJson.executionPacket`**, so it almost never reused the persisted packet from reconciliation. That did not cause the “Executed” label by itself, but it made reuse of prepared payloads inconsistent with the server contract.

## Relevant Code (Post-Fix)

### Backend: distinguish “awaiting wallet” from “execution evidence recorded”

**File:** `api/src/payment-orders.ts`  
**Function:** `derivePaymentOrderState`

**Fix:** If `latestExecution` exists:

- If there is **no** non-empty `submittedSignature` and `state` is **`ready_for_execution`** or **`broadcast_failed`** → return **`'ready_for_execution'`** (operator should still sign / retry signing).
- Otherwise → return **`'execution_recorded'`** (normal post-attach / post-evidence semantics).

This aligns `derivedState` with user intent: **“Ready to sign”** until a signature path has completed, then **“Executed”** (in UI terms) for the recorded-evidence phase.

### Frontend: read persisted packet from the key the API uses

**File:** `frontend/src/App.tsx`  
**Function:** `getPreparedPacket`

**Fix:** Resolve packet as `metadataJson.executionPacket ?? metadataJson.preparedExecution` before `isPaymentExecutionPacket` validation.

### Tests

**File:** `api/tests/payment-orders.test.ts`

After **batch** `prepare-execution` only (no `attach-signature` yet), the payment run’s **`derivedState`** is now asserted as **`ready_for_execution`**, reflecting that all included orders are in the “awaiting signature” window, not falsely “executed.”

The test that attaches an external signature still expects **`execution_recorded`** on the order after evidence exists, unchanged in intent.

## Why This Was Confused With “Agent / API First”

Recent work emphasizes **prepare on the API** (packet, execution records, events) and **sign in the client** (wallet + RPC + `attach-signature`). That split is correct.

The bug made **the first half (prepare)** look like **the second half (done)** in the UI because **`derivedState`** and labels collapsed “execution row exists” into “execution finished.” No agent change was required to restore correct behavior; **derivation and copy had to respect `submittedSignature` and execution `state`.**

## Operational Notes

- **Prepare** intentionally writes durable execution rows before chain submission; that is not a bug.  
- **Misleading `derivedState`** was the bug; fix is entirely in how we **project** reconciliation to operators.  
- If new execution sources appear, review whether they should fall into the “awaiting wallet” bucket using the same `submittedSignature` + `state` rule.

## Follow-up: Wallet Never Prompted (or Felt “Skipped”)

Separate from misleading **`derivedState`**, operators reported **no wallet signing UI** when clicking execute. Contributing causes addressed in code:

1. **Invalid default Solana RPC** — `frontend/src/lib/solana-wallet.ts` used `DEFAULT_SOLANA_RPC_URL = 'API_KEY_HERE'`. `getLatestBlockhash` runs **before** any wallet call; a bad URL fails there, so the wallet never opens. **Fix:** default to `https://api.mainnet-beta.solana.com`, validate URL shape, and wrap the blockhash fetch with an error that tells the operator to set **`VITE_SOLANA_RPC_URL`**.

2. **Stale prepared packet vs selected source** — Payment detail flow reused **`preparedPacket`** or **`getPreparedPacket()`** even when the operator changed the **source wallet** in the modal. The packet’s **`signerWallet`** no longer matched the connected wallet; **`assertSignerMatches`** threw after **`connect()`**, which can feel like “wallet did not ask to sign.” **Fix:** clear **`preparedPacket`** when **`selectedSourceAddressId`** changes; always **re-prepare** when **`packet.signerWallet`** ≠ on-chain address for the selected workspace address. Payment run flow: clear **`prepared`** on source change; re-prepare when run source UUID **or** packet **`signerWallet`** disagrees with the selected address row.

3. **Execute button after signature** — The payment detail header still offered **Execute** for **`execution_recorded`**, so users could retry against old metadata. **Fix:** only offer execute when **`approved`**, **`ready_for_execution`**, or legacy **`execution_recorded`** with **no** **`latestExecution.submittedSignature`**.

4. **Closure / ordering on run detail** — Batch **`signMutation`** referenced **`sourceAddresses`** / **`effectiveSourceAddressId`** before they were defined (they lived after early returns). **Fix:** derive **`sourceAddresses`** and **`effectiveSourceAddressId`** from **`runQuery.data?.sourceWorkspaceAddressId`** immediately after queries, before mutations.

## Related (Separate Issue)

Yellowstone worker **matching-index SSE** reconnecting with `error decoding response body` was traced to a **reqwest global 3s timeout** on a long-lived stream; see `yellowstone/src/control_plane.rs` and any ops notes if that gets written up separately.

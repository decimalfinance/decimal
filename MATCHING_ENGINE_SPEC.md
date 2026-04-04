# Matching Engine Spec

## Purpose

This document defines the core matching engine for `Stablecoin Ops Control Surface`.

It covers:

- the matching algorithm
- the heuristic ladder
- failure and exception states

This is the highest-risk part of the product.

If we cannot reliably map:

- `transfer request`

to

- `observed on-chain settlement`

then the product does not work.

## Core Principle

Matching is not binary. It is a progressive confidence process.

We should not assume that every request maps cleanly to one transaction.
We should support:

- exact match
- strong probable match
- partial match
- ambiguous match
- no match

And we must preserve:

- why we matched
- why we failed to match
- what a human should do next

## Inputs

## 1. Transfer Request

Minimum fields required for matching:

- `transfer_request_id`
- `workspace_id`
- `type`
- `asset`
- `requested_amount`
- `destination_address` or `destination_id`
- `counterparty_id` optional
- `requested_at`
- `due_at` optional
- `external_reference` optional
- `status`

Optional but useful fields:

- `source_wallet_id`
- `business_object_id`
- `batch_id`
- `memo_reference`
- `corridor`
- `request_group_key`

## 2. Observed Settlement Facts

Minimum fields required:

- `signature`
- `slot`
- `block_time`
- `finality_state`
- `asset`
- `movement_amount`
- `source_address`
- `destination_address`
- `source_owner`
- `destination_owner`

Optional but useful fields:

- `transaction_index`
- `instruction_index`
- `memo`
- `token_account_role`
- `workspace_id` projection if already derived

## Output

For v1, the engine produces one `current best match state` per `transfer_request_id`.

That means:

- one active `settlement_match` record per request
- updated when a better deterministic interpretation is found
- no separate persisted candidate table in v1

Candidate evidence can be kept transiently in worker memory or written later to a separate debug table if needed, but it should not complicate the first implementation.

Suggested fields:

- `settlement_match_id`
- `workspace_id`
- `transfer_request_id`
- `signature` nullable
- `match_status`
- `confidence_score`
- `confidence_band`
- `matched_amount`
- `amount_variance`
- `destination_match_type`
- `time_delta_seconds`
- `match_rule`
- `candidate_count`
- `explanation`
- `created_at`
- `updated_at`

## Match Statuses

- `matched_exact`
- `matched_strong`
- `matched_partial`
- `matched_ambiguous`
- `unmatched_pending`
- `unmatched_expired`
- `unexpected_observation`

These are different from exception states. A match result is what the engine believes. An exception is what the operator must act on.

## Matching Algorithm

The engine should run in passes, not one giant query.

## Pass 0: Eligibility Filter

Only compare a request against candidate observed movements that satisfy:

- same workspace
- same asset
- observed after request creation or within a small pre-request tolerance if needed later
- observed within a bounded time window

Initial default window:

- from `requested_at - 2 minutes`
- to `requested_at + 24 hours`

For payout batches, use:

- batch creation time or release time

## Pass 1: Destination Match

First find candidate movements where:

- `destination_address == request.destination_address`

For v1, matching is against the exact registered destination address only.

If destination is stored as an internal destination object, it must resolve to one canonical payout destination address for matching.

V1 does not use owner-only matching.
V1 does not use implicit wallet-to-token-account inference at match time.
If the operator wants a destination to be matchable, they must register the exact destination token account or exact destination address used in settlement.

Destination match types:

- `exact_destination`
- `no_destination_match`

We should strongly prefer exact destination matches.
`resolved_destination` and `owner_only_destination` are future extensions, not part of the first implementation slice.

## Pass 2: Amount Match

For destination-matched candidates, compare amount.

Amount buckets:

- `exact_amount`
- `within_tolerance`
- `partial_amount`
- `no_amount_match`

Initial tolerances:

- exact: `movement_amount == requested_amount`
- within tolerance: only if explicitly enabled for a buyer flow
- partial: movement amount is a strict subset of requested amount

For MVP, keep tolerance narrow:

- zero tolerance for normal transfers
- partial allowed only if product flow explicitly supports batched or split settlement later

## Pass 3: Source Constraint

If request has a source wallet or source token account, prefer candidates that also match source.

Source match types:

- `exact_source`
- `workspace_source`
- `unknown_source`
- `source_mismatch`

Source should increase confidence, but source absence should not kill an otherwise exact destination+amount match in the first version.

## Pass 4: Time Proximity

For v1, use exactly one anchor:

- `requested_at`

Do not support multiple anchor semantics in the first implementation.
Do not switch between `requested_at`, `approved_at`, or `released_at` in v1.

Time buckets:

- `0-60s`
- `1-10m`
- `10-60m`
- `1-6h`
- `6-24h`
- `>24h`

Time is a ranking factor, not a sole match factor.

## Pass 5: Business Context Check

Use optional context when available:

- batch id
- memo / reference
- counterparty
- business object

This is especially useful for:

- marketplace payouts
- cross-border payouts
- treasury sweeps with known categories

## Pass 6: Candidate Resolution

Choose result according to this rule order:

1. One candidate with exact destination + exact amount, and no conflicting candidate nearby
   - `matched_exact`

2. One candidate with exact destination + exact amount, but weak source or looser timing
   - `matched_strong`

3. One or more candidates whose sum equals requested amount and destination matches
   - `matched_partial`
   - only if split settlements are explicitly enabled for that request type

4. Multiple candidates all plausibly match and cannot be disambiguated
   - `matched_ambiguous`

5. No plausible candidate yet, but request is still within search window
   - `unmatched_pending`

6. No plausible candidate and search window expired
   - `unmatched_expired`

Separately:

- any observed movement touching a watched source or destination with no associated request becomes `unexpected_observation`

## Heuristic Ladder

The engine should use a deterministic confidence ladder.

This is the order of trust:

## Level 1: Exact Intent Match

Requirements:

- exact destination
- exact amount
- valid time window

Optional booster:

- exact source

Result:

- `matched_exact`
- highest confidence

## Level 2: Strong Operational Match

Requirements:

- exact destination
- exact amount
- time window acceptable
- source unknown or not modeled

Result:

- `matched_strong`

## Level 3: Structured Partial Match

Requirements:

- exact destination
- multiple observed movements whose total equals requested amount
- all within matching window

Use only for:

- request types that allow split settlement

Result:

- `matched_partial`

## Level 4: Ambiguous Match

Requirements:

- more than one plausible candidate
- no deterministic winner

Result:

- `matched_ambiguous`

This must go to human review.

## Level 5: Pending No-Match

Requirements:

- no candidate yet
- search window not expired

Result:

- `unmatched_pending`

## Level 6: Expired No-Match

Requirements:

- no candidate
- request past configured match window

Result:

- `unmatched_expired`

## Confidence Scoring

Keep this simple and explainable.

Suggested banding:

- `100`: exact destination + exact amount + exact/known source
- `90`: exact destination + exact amount
- `75`: exact destination + summed partials with no conflicts
- `50`: plausible but ambiguous
- `0`: no usable candidate

Expose both:

- numeric score
- reason string

Never expose only a score without explanation.

## Exception Taxonomy

Exceptions are operational tasks, not just match results.

## Match-Driven Exceptions

- `missing_settlement`
- `ambiguous_match`
- `partial_settlement`
- `amount_mismatch`
- `wrong_destination`
- `duplicate_candidate`
- `late_settlement`

## Observation-Driven Exceptions

- `unexpected_transaction`
- `unexpected_destination_activity`
- `unexpected_source_activity`
- `unknown_counterparty_movement`

## Control-Driven Exceptions

- `policy_violation`
- `destination_not_trusted`
- `source_wallet_unapproved`
- `manual_review_required`

## Operational Exceptions

- `insufficient_funds`
- `execution_not_observed`
- `export_blocked`
- `finance_close_mismatch`

## Exception Severity

Use three levels for MVP:

- `high`
- `medium`
- `low`

Suggested defaults:

- wrong destination: `high`
- unexpected transaction: `high`
- missing settlement after window expiry: `high`
- ambiguous match: `medium`
- partial settlement: `medium`
- export blocked: `low`

## Matching Windows

These should be request-type specific.

Initial defaults:

- `treasury_transfer`: 6 hours
- `vendor_payment`: 24 hours
- `payout_item`: 24 hours
- `rebalance`: 2 hours

These are not business SLAs. They are match-expiry windows.

## Special Cases

## 1. Duplicate Requests

If two requests have the same:

- destination
- amount
- close creation time

then matching must prefer:

- approved / released request over draft
- earliest released request over later one

If still ambiguous:

- emit `ambiguous_match`

## 2. Split Settlement

Do not support this by default for every request type.

Enable only for request types where product semantics allow it.

For MVP:

- `payout_item`: no split settlement
- `treasury_transfer`: no split settlement
- `rebalance`: optional later

## 3. Unexpected On-Chain Movement

If a treasury wallet or approved source wallet emits an observed USDC movement with no linked request:

- create `unexpected_observation`
- create high-severity exception

This is a core product surface, especially for treasury ops.

## 4. Batch Payouts

For marketplace flows:

- batch is not the match unit
- payout item is the match unit

The batch is a grouping object only.

## 5. Multiple Token Accounts Per Counterparty

Never match only by counterparty label if a destination address is known.

Counterparty helps ranking.
Destination should drive matching.

## Core Engineering Rules

1. Matching must be deterministic.
2. Matching must be explainable.
3. Matching must preserve all candidate evidence.
4. Matching must prefer `ambiguous` over false certainty.
5. A human must be able to understand why a request did or did not match.

## First Implementation Slice

The very first slice should support only:

- USDC
- one observed movement per request
- exact destination matching
- exact amount matching
- one configurable time window
- unmatched and unexpected exceptions

That is enough to validate the product’s core assumption.

## Recommended Tables For First Slice

## Postgres

- `transfer_requests`
- `destinations`
- `counterparties`

## ClickHouse

- `observed_transactions`
- `observed_token_movements`
- `settlement_matches`
- `exceptions`

## Recommended API For First Slice

- `POST /workspaces/:workspaceId/transfer-requests`
- `GET /workspaces/:workspaceId/transfer-requests`
- `GET /workspaces/:workspaceId/reconciliation`
- `GET /workspaces/:workspaceId/exceptions`

## Success Criteria

The first slice is successful if:

- a request can be created
- a real observed on-chain USDC transfer can be matched back to it
- unmatched requests become visible
- unexpected transfers become visible
- the system explains why it matched or failed

If we cannot make that loop trustworthy, we should not build the broader control plane yet.

## Locked V1 Decisions

These are now fixed for the first implementation:

1. `settlement_matches` stores one current best match state per `transfer_request_id`
2. matching uses exact destination address only
3. matching uses exact amount only
4. matching uses one bounded time window anchored on `requested_at`
5. no owner-only matching in v1
6. no split-settlement logic in v1

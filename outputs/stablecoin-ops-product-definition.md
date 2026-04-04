# Product Definition: Stablecoin Ops Control Surface

As of 2026-03-31.

This document combines the two strongest ideas:

- stablecoin reconciliation and settlement assurance
- stablecoin treasury control plane

The conclusion of this pass is that they should be treated as one product, not two separate companies.

Working name:

- `Stablecoin Ops Control Surface`

Core thesis:

- teams that already move stablecoins do not mainly need a new rail
- they need a system that helps them request, approve, execute, reconcile, and explain stablecoin money movement

This product should sit above wallets, custody, and raw chain data. It is the operating layer for stablecoin-moving teams.

## 1. Exact first buyer

The best first buyer is:

- `finance / payment operations lead at a stablecoin-native fintech, marketplace, or payout platform using USDC on Solana for outbound payouts and treasury transfers`

This is more specific than “treasury team” or “ops team.”

Why this buyer:

- they already have stablecoin movement in production
- they already feel both problems at once:
  - outbound transfer control
  - post-transfer reconciliation
- they usually operate across multiple internal systems, counterparties, and payout batches
- they already spend labor on spreadsheets, approval messages, manual tagging, and exception handling
- they can buy software before they need a full enterprise custody stack

This buyer is better than a pure DAO treasury operator because:

- the workflow is more repetitive
- the pain is more operational than ideological
- the business case is easier to measure

This buyer is better than a large institution at first because:

- large institutions are more likely to default to Fireblocks or equivalent vendors
- they have much longer security, legal, and procurement cycles

## 2. Exact daily workflow

The product should be designed around one daily loop.

That loop is:

1. `Intake`
- new payout batch, vendor payment, treasury sweep, or treasury rebalance request is created
- business context exists before the chain transaction:
  - who is being paid
  - why
  - how much
  - by when
  - from which internal balance

2. `Control`
- the request is evaluated against policies:
  - amount thresholds
  - approved stablecoins
  - approved destination addresses
  - whitelisted counterparties
  - risk flags
  - role-based approvers

3. `Approval`
- the request is approved, rejected, or escalated
- approvers need context, not just a wallet prompt

4. `Execution`
- once approved, the transfer or batch is executed through the chosen wallet/custody/provider
- the system tracks the transaction through chain submission and settlement state

5. `Observation`
- on-chain data is observed and normalized:
  - tx hash
  - token movement
  - amount
  - source
  - destination
  - status / finality

6. `Matching`
- the observed transaction is matched to the original request or expected payment
- if the match is clean, it becomes settled
- if not, it becomes an exception

7. `Exception handling`
- human operator handles:
  - wrong amount
  - duplicate payment
  - unexpected destination
  - partial completion
  - delayed or failed payout
  - unknown transaction touching treasury addresses

8. `Evidence and export`
- final record is exported or synced:
  - ERP / accounting
  - payout ledger
  - internal treasury ledger
  - audit logs

This is the loop the product exists to compress and harden.

## 3. Current workaround

Today this workflow is usually fragmented across:

- wallet or custody dashboard
- explorer tabs
- spreadsheets
- Slack / Telegram approval threads
- CSV exports
- internal scripts
- finance tools that do not understand on-chain settlement

Modern Treasury’s docs make clear that mature finance tooling is built around:

- expected payments
- payment orders
- rule-based matching
- partial reconciliation
- transaction categorization
- linked entities
- approval rules
- audit trails

Sources:

- [Reconciliation Overview](https://docs.moderntreasury.com/reconciliation/docs/overview)
- [Expected Payments Overview](https://docs.moderntreasury.com/reconciliation/docs/expected-payments)
- [Reconciliation Rules Overview](https://docs.moderntreasury.com/reconciliation/docs/defining-your-reconciliation-rules)
- [Transaction Categorization](https://docs.moderntreasury.com/reconciliation/docs/manage-categorization-rules)
- [Entity Linking Overview](https://docs.moderntreasury.com/reconciliation/docs/entity-links)
- [Payments Overview](https://docs.moderntreasury.com/payments/docs/overview)

Fireblocks shows the same thing on the control side:

- whitelisted destination addresses
- approval quorums
- role-based controls
- transaction policies
- automated approval workflows
- audit history

Sources:

- [Fireblocks Treasury Management](https://www.fireblocks.com/products/treasury-management)
- [Fireblocks Governance and Policy Engine](https://www.fireblocks.com/platforms/governance-and-policy-engine/)
- [Manage Destination Addresses](https://developers.fireblocks.com/docs/whitelist-addresses)
- [Define Approval Quorums](https://developers.fireblocks.com/docs/define-approval-quorums)

The opportunity is not to re-invent those ideas. It is to make them stablecoin-native, Solana-native, lighter-weight, and directly tied to settlement assurance.

## 4. Smallest lovable product

The smallest lovable product should be opinionated and narrow.

It should be:

- `USDC on Solana`
- `outbound payouts and treasury transfers only`
- `single organization, multi-user`
- `one workspace per money-moving operation`

It should not try to solve:

- all chains
- all stablecoins
- all accounting
- full custody
- fiat rails
- on/off-ramp orchestration
- merchant checkout

### MVP scope

The MVP should do six things well:

1. `Create expected payment or transfer requests`
- amount
- recipient / counterparty
- reason
- due date
- internal object reference

2. `Maintain a trusted destination and counterparty registry`
- known addresses
- labels
- internal objects
- whitelisted counterparties

3. `Run approval policies`
- threshold rules
- role-based approvals
- whitelisted destination checks
- manual escalation path

4. `Observe and normalize on-chain settlement`
- tx hash
- token movement
- finality / settlement state
- link to request

5. `Reconcile requests to observed settlement`
- matched
- partially matched
- unmatched
- exception

6. `Give operators an exception queue and export`
- who needs attention
- why
- what to do
- exportable record

### Why this is lovable

It replaces the ugliest current workflow:

- “I have a payout or treasury action to run”
- “I need the right person to approve it”
- “I need to know it actually settled”
- “I need to prove what happened later”

That is a coherent, painful, daily job.

## 5. What the product is not

This is important.

The product is not:

- a wallet
- a bank
- a custody provider
- a general blockchain analytics dashboard
- a stablecoin issuer
- a payout network

It is:

- an operational control and assurance layer

That constraint should protect the scope.

## 6. Core product objects

The data model should follow the workflow, not the chain.

There are three layers:

- business intent
- operational control
- settlement observation

### A. Business intent layer

These represent what the organization intended to happen.

1. `Organization`
- account owner

2. `Workspace`
- one operational environment or money movement system

3. `Counterparty`
- vendor, creator, merchant, customer, treasury destination, internal desk

4. `Destination`
- one or more on-chain addresses associated with a counterparty or internal object

5. `Business Object`
- invoice
- payout batch
- treasury sweep
- vendor payment
- refund

6. `Transfer Request`
- the atomic requested action
- examples:
  - pay contractor
  - rebalance treasury
  - settle supplier invoice

Suggested fields:

- `id`
- `workspace_id`
- `type`
- `direction`
- `asset`
- `amount`
- `counterparty_id`
- `destination_id`
- `business_object_id`
- `requested_by`
- `requested_at`
- `status`
- `reason`
- `external_reference`

### B. Operational control layer

These represent how an organization decides whether the action is allowed.

1. `Approval Policy`
- conditions and rules

Suggested fields:

- `id`
- `workspace_id`
- `name`
- `conditions_json`
- `enabled`

2. `Approval Rule Match`
- which policy applied to which request

3. `Approval Action`
- approve
- reject
- escalate
- cancel

Suggested fields:

- `id`
- `transfer_request_id`
- `actor_user_id`
- `action`
- `timestamp`
- `note`

4. `Approval Group`
- role-based or named approval teams

5. `Address Trust State`
- pending
- approved
- blocked
- archived

6. `Audit Event`
- immutable event log of every state transition

### C. Settlement observation layer

These represent what actually happened on-chain.

1. `Observed Transaction`
- normalized tx-level record

Suggested fields:

- `signature`
- `slot`
- `block_time`
- `status`
- `finality_state`

2. `Observed Token Movement`
- one movement line per source/destination/amount

Suggested fields:

- `id`
- `signature`
- `mint`
- `amount`
- `source_address`
- `destination_address`
- `source_owner`
- `destination_owner`

3. `Settlement Match`
- relation between `Transfer Request` and `Observed Transaction`

Suggested fields:

- `id`
- `transfer_request_id`
- `signature`
- `match_status`
- `matched_amount`
- `variance_amount`
- `match_reason`

4. `Exception`
- explicit unresolved operational problem

Suggested fields:

- `id`
- `workspace_id`
- `transfer_request_id`
- `signature`
- `exception_type`
- `severity`
- `status`
- `owner_user_id`
- `opened_at`
- `resolved_at`

### D. Why this model is right

This structure separates:

- what we wanted to happen
- what rules applied
- what actually happened
- where humans need to intervene

That is exactly what the workflow requires.

## 7. UI surfaces required

The UI should not start from “dashboard.”
It should start from operator jobs.

### Screen 1: `Operations Inbox`

Purpose:

- the default screen for an operator

Contains:

- pending approvals
- unmatched settlements
- failed or delayed transfers
- high-severity exceptions
- recent resolved exceptions

This is the screen that answers:

- what needs my attention right now?

### Screen 2: `Transfer Requests`

Purpose:

- create and review outgoing requests

Contains:

- transfer request table
- filters by status, asset, counterparty, requester
- create request flow
- request detail panel

The request detail should show:

- business context
- destination
- policy outcome
- approval chain
- linked observed transaction once executed

### Screen 3: `Approvals`

Purpose:

- isolate approval work

Contains:

- pending approval queue
- policy rule that triggered
- destination trust state
- risk flags
- approve / reject / escalate

This screen should feel like a review system, not a wallet popup.

### Screen 4: `Settlement & Reconciliation`

Purpose:

- the heart of the product

Contains:

- matched items
- partial matches
- unmatched requests
- unexpected observed transactions
- export controls

Key filters:

- date
- counterparty
- business object type
- exception type
- status

### Screen 5: `Exception Queue`

Purpose:

- dedicated operational resolution view

Contains:

- severity
- owner
- reason
- linked request
- linked transaction
- suggested resolution steps

This is where the product becomes operationally indispensable.

### Screen 6: `Counterparties & Destinations`

Purpose:

- address registry and trust layer

Contains:

- counterparties
- destination addresses
- trust state
- labels
- internal mappings

This is the foundation for safe execution and meaningful reconciliation.

### Screen 7: `Policies`

Purpose:

- configure controls

Contains:

- approval thresholds
- whitelisted destination rules
- asset restrictions
- user/group roles
- policy simulation or preview

### Screen 8: `Audit & Exports`

Purpose:

- evidence surface for finance and compliance

Contains:

- immutable audit events
- export jobs
- reconciled CSV / API sync status

## 8. The one workflow to design around first

The first workflow to productize should be:

- `outbound USDC payout / treasury transfer from request to approval to on-chain settlement to reconciliation`

Not inbound.
Not swaps.
Not multi-chain.
Not merchant checkout.

Why this workflow:

- it contains both control and assurance
- it forces the product to own real operational value
- it is common across fintechs, marketplaces, and crypto-native businesses

## 9. Product definition in one sentence

This product is:

- `a stablecoin operations control surface for teams using USDC on Solana, combining transfer approvals, trusted destination management, on-chain settlement tracking, reconciliation, and exception handling in one workflow`

## 10. Recommended next step

Before writing the formal product spec, do one more narrowing pass:

Pick one exact first buyer out of these three:

1. cross-border fintech finance / ops team
2. marketplace payout ops team
3. crypto-native treasury ops team

Then rewrite the workflow and MVP entirely around that one buyer.

That is the step that will make the product feel inevitable instead of generic.

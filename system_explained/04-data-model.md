# 04 Data Model

Durable state lives in PostgreSQL, defined by `api/prisma/schema.prisma`. Tables group
into: identity/access, treasury, counterparties (the address book), payments, the agent
auto-pay layer, collections, and audit trails.

## Identity And Access

- `users`: global human accounts (email/password or Google OAuth).
- `auth_sessions`: API session tokens.
- `organizations`: tenants.
- `organization_memberships`: a user's role inside an organization.
- `organization_invites`: invite-bound membership (you join through an invite, not self-serve).
- `user_wallets`: personal signing wallets (Privy-managed embedded wallets in the active
  path, not browser-wallet challenge records). Not treasury funds.
- `organization_wallet_authorizations`: local link between a personal wallet and treasury
  permissions.
- `idempotency_records`: dedupe key for write routes so retries don't double-execute.

## Treasury State

- `treasury_wallets`: organization-owned treasury accounts. For Squads accounts,
  `source = "squads_v4"` and the Squads PDA/vault metadata is in `properties_json`.
- `decimal_proposals`: Decimal's local mirror of the Squads proposal lifecycle (proposal
  type, transaction index, submitted/executed signatures, local status, verification
  metadata). The chain remains authoritative for votes, threshold, and execution; Decimal
  stores enough to render the product, retry confirmations, and build proofs.

## Counterparties (The Address Book)

- `counterparties`: optional business entities (a vendor/customer). Identity is the display
  name; a counterparty can hold several wallets.
- `counterparty_wallets`: the actual Solana addresses paid (or, historically, received from).
  One row per address per organization (`@@unique(organization_id, wallet_address)` —
  load-bearing for the on-chain allowlist; an address maps to exactly one trust decision).

Key columns:
- `trust_state`: `unreviewed | trusted | restricted | blocked` — gates whether the address
  can be paid. Only a `trusted` address can be delegated to an agent spending limit.
- `is_primary`: the vendor's default payout address. Exactly one per vendor (enforced in the
  service layer); the first verified address auto-promotes; an invoice that names a vendor but
  carries no address routes to the primary.
- `wallet_type`, `is_internal`, `is_active` (archived addresses set `is_active = false`),
  `label`, `notes`, optional `counterparty_id`, optional `token_account_address`.

Intake review signals (e.g. `known_counterparty_wallet_changed`, `near_duplicate_address`,
`unreviewed_counterparty`) are **not** tables — they are computed per invoice and stored on
the resulting payment order under `metadata_json.agent.triggeredRules`. See
[07 Payment Routing Algorithm](./07-payment-routing-algorithm.md).

## Payment State

- `payment_orders`: one executable outbound payment intent. Manual entry, CSV rows, and
  invoice extraction all converge here. Batch metadata lives on the order itself
  (`input_batch_id`, `input_batch_label`, `metadata_json`) — there is no separate run table.
  Each order can still link to a `transfer_request` (the shared approval/settlement primitive
  the proof builders consume).
- `payment_order_events`: payment audit trail.
- `transfer_requests`: the approval/settlement intent row behind a payment order. Still the
  shared primitive used by proof builders and settlement read models; not dead code.
- `transfer_request_events`, `transfer_request_notes`: approval/settlement audit trail.
- `execution_records`: submitted/executed signature evidence.

## Agent Auto-Pay Layer

This is the "Auto-pay" feature — the agent paying an approved bill on its own, gated by a
Squads spending limit. See [07 Payment Routing Algorithm](./07-payment-routing-algorithm.md).

- `automation_agents`: an organization's backend-managed agent (status active/paused/archived).
- `agent_wallets`: the agent's Privy-managed signing wallet that submits `spendingLimitUse`
  transactions.
- `spending_limit_policies`: Decimal's mirror of an on-chain Squads spending limit (mint, cap,
  period, member set). The on-chain limit is the enforcement authority.
- `spending_limit_policy_destinations`: the allowlist — links a spending limit to the
  `counterparty_wallets` it may pay (must be `trusted`).
- `spending_limit_executions`: records of agent auto-pay executions (the spend against a limit).

## Collections (Inbound)

- `collection_runs`, `collection_requests`, `collection_request_events`: expected inbound
  payment records and their audit trail. These are intent/proof records only — they are not
  auto-verified on-chain (Decimal does not create the inbound transaction), and inbound
  collection is not the active product direction (the wedge is outbound AP / auto-pay).

## Removed / Not In The Model

No longer present (dropped from the schema, some via self-healing `DROP TABLE IF EXISTS`):

- ClickHouse observed-transfer tables and the global USDC index.
- `destinations` and `collection_sources` (merged into `counterparty_wallets`).
- `approval_policies`, `approval_decisions` (the old policy-decision workflow).
- `payment_requests`, `payment_runs`, `exception_notes`, `exception_states`,
  `wallet_challenges`, and the old workspace tables.

RPC settlement mismatches are represented in read models and proposal metadata
(`metadata_json.rpcSettlementVerification`), not in a separate exception workflow.

## Proof State

Proofs are generated on demand from current database state, not stored as rows. A canonical
digest is computed over stable JSON and returned with each proof packet.

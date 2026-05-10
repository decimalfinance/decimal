# 04 Data Model

Important tables:

- `users`: human accounts.
- `auth_sessions`: API sessions.
- `organizations`: tenants.
- `organization_memberships`: roles inside organizations.
- `organization_invites`: email-bound invites.
- `user_wallets`: personal signing wallets.
- `wallet_challenges`: external-wallet ownership challenge records.
- `treasury_wallets`: organization treasury accounts, including Squads vaults.
- `organization_wallet_authorizations`: local link between personal wallets and treasury permissions.
- `counterparties`: business labels.
- `counterparty_wallets`: unified address book for payees, payers, and internal receiving wallets.
- `payment_requests`: input-layer payment requests.
- `payment_runs`: CSV/batch payment parent.
- `payment_orders`: one outbound payment intent.
- `collection_runs`: batch wrapper for expected inbound collections.
- `collection_requests`: expected inbound collection intents.
- `collection_request_events`: collection audit trail.
- `transfer_requests`: approval/settlement intent row behind a payment order or collection.
- `approval_policies`: policy config.
- `approval_decisions`: policy decisions.
- `decimal_proposals`: local mirror of Squads proposals.
- `execution_records`: submitted/executed signature evidence.
- `payment_order_events`: payment audit trail.
- `transfer_request_events`: approval/settlement audit trail.

`TransferRequest` remains in the schema because it is still the shared approval/settlement intent primitive used by proof builders and older read models. It may eventually be renamed, but it is not dead code.

## Identity And Access

`users` are global human accounts. `organizations` are tenants. A user receives access through `organization_memberships`; joining an organization should happen through `organization_invites`.

`user_wallets` are personal signing wallets. They are not treasury wallets and should not be treated as organization funds. A personal wallet can be linked to organization permissions through `organization_wallet_authorizations`.

## Treasury State

`treasury_wallets` stores organization-owned treasury accounts. For Squads accounts, `source = "squads_v4"` and the Squads PDA/vault metadata is stored in `properties_json`.

`decimal_proposals` stores Decimal's local mirror of Squads proposal lifecycle:

- local proposal identity
- treasury wallet link
- proposal type
- transaction index
- submitted/executed signatures
- local status
- verification metadata

The chain remains authoritative. Decimal stores enough data to render the product, retry confirmations, and generate proofs.

## Counterparty State

`counterparties` are optional business entities such as vendors, customers, contractors, or payers.

`counterparty_wallets` are the actual Solana addresses Decimal uses in payments and collections. They replace the old `destinations` and `collection_sources` split.

Key rules:

- One organization can store one row per wallet address.
- A row may link to a `counterparty`, but does not have to.
- `walletType` describes intent, for example payee, payer, wallet, or internal receiver.
- `trustState` gates outbound execution. Unreviewed or blocked wallets should not be paid from a Squads treasury.
- `isInternal` marks organization-controlled receiving addresses created for collection bookkeeping.
- Payment orders, payment requests, collection requests, and transfer requests all point at `counterpartyWalletId` where applicable.

This is the correct abstraction for the current product because the same address can be both a payer and a payee over time.

## Payment State

`payment_requests` are input-layer requests. `payment_orders` are executable outbound payment intents. `payment_runs` group many orders into one batch flow.

For compatibility with earlier code, each payment order can still link to a `transfer_request`. That row carries approval and settlement state used by the proof builders.

Document imports are not a separate table. They become `payment_runs` with metadata about extraction and skipped rows.

## Collection State

`collection_requests` are expected inbound payment records. They link to:

- a receiving `treasury_wallet`
- an optional payer `counterparty_wallet`
- an optional `counterparty`
- an optional `transfer_request` compatibility row

Collections are currently intent/proof records. They do not yet have an RPC verifier equivalent to outbound Squads execution because Decimal is not creating the inbound transaction.

## Removed Tables

The following old tables are no longer part of the active model:

- ClickHouse observed-transfer tables.
- `destinations`.
- `collection_sources`.
- `exception_notes`.
- `exception_states`.
- workspace tables.

RPC settlement mismatches are represented in read models and proposal metadata, not persisted into a separate exception workflow.

## Proof State

Proofs are generated on demand from current database state. They are not stored as separate rows.

The canonical digest is computed over stable JSON and returned with each proof packet.

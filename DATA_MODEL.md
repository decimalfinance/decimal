# Data Model

## Purpose

This document defines the initial data model for `USDC Ops Layer` under the chosen architecture:

- `Rust`
- `ClickHouse` for event data
- `Postgres` for control-plane data
- `Architecture 2`: raw -> canonical -> serving

The model is designed around one non-negotiable product truth:

`A transaction is only useful when it can be interpreted in the context of a specific customer's address universe.`

That means the system must separate:

- global chain facts,
- customer-specific configuration,
- customer-specific interpretation,
- and customer-facing serving records.

## Core Design Rule

We should not try to make one giant universal table that does everything.

Instead, the model should have four layers:

1. `global raw layer`
2. `global canonical layer`
3. `workspace interpretation layer`
4. `workspace serving layer`

This gives us flexibility without destroying correctness.

## Physical Storage Mapping

The logical model is split across two databases.

### Stored In Postgres

These are control-plane tables:

- `workspaces`
- `workspace_addresses`
- `workspace_labels`
- `workspace_address_labels`
- `workspace_objects`
- `workspace_address_object_mappings`
- `global_entities`
- `global_entity_addresses`

These tables need:

- uniqueness constraints,
- transactional updates,
- relational integrity,
- and simple API-facing CRUD behavior.

The TypeScript control plane should access these tables through `Prisma`.

### Stored In ClickHouse

These are data-plane tables:

- `raw_observations`
- `canonical_account_mutations`
- `canonical_transaction_events`
- `workspace_event_links`
- `workspace_event_participants`
- `workspace_operational_events`
- `workspace_reconciliation_rows`

These tables are append-heavy and optimized for ingestion, filtering, and analytical query patterns.

## Product Truths The Model Must Support

The product is useless unless each customer can provide:

- a set of known addresses
- labels for what those addresses are
- optional mappings to internal business objects like `customer`, `merchant`, `treasury`, `payout`, `hot_wallet`

Those three things are customer-specific.

So the system must treat:

- chain data as global
- interpretation as workspace-scoped

That is the main modeling decision.

## Flexibility Principle

We want the model to be flexible, but not shapeless.

So the rule is:

- core identifiers and relationships are typed
- extra properties are stored in JSON
- interpretations are versionable
- serving tables are rebuildable

This gives us room to evolve without losing structure.

## High-Level Model

### Global Chain Layer

This layer stores what happened on Solana, regardless of customer.

Main objects:

- raw observations
- canonical transaction events
- canonical account mutations
- global known entities

### Workspace Interpretation Layer

This layer stores what a workspace cares about.

Main objects:

- workspaces
- watched addresses
- workspace labels
- workspace business objects
- address-to-object mappings
- workspace relevance links

### Workspace Serving Layer

This layer stores customer-facing events.

Main objects:

- interpreted workspace events
- event participants
- reconciliation rows
- exports

## Main Entity Groups

## 1. Workspace

This represents one customer account / tenant / team.

### Table

`workspaces`

### Purpose

Defines the isolation boundary for:

- watched addresses
- labels
- internal business objects
- relevance
- serving events

### Suggested fields

- `workspace_id` `UUID`
- `workspace_slug` `String`
- `workspace_name` `String`
- `status` `Enum`
- `created_at` `DateTime64`
- `updated_at` `DateTime64`

### Notes

Every interpretation object should be tied to a `workspace_id`.

## 2. Workspace Address Registry

This is the most important product table.

It defines the address universe that makes a transaction relevant.

### Table

`workspace_addresses`

### Purpose

Stores all addresses the workspace wants the system to understand.

This includes:

- wallet addresses
- token accounts
- treasury addresses
- payout addresses
- customer deposit addresses
- merchant addresses
- operational hot wallets

### Suggested fields

- `workspace_id` `UUID`
- `workspace_address_id` `UUID`
- `chain` `Enum`
- `address` `String`
- `address_kind` `Enum`
- `asset_scope` `Enum`
- `is_active` `UInt8`
- `source` `Enum`
- `source_ref` `String`
- `notes` `String`
- `properties_json` `JSON`
- `created_at` `DateTime64`
- `updated_at` `DateTime64`

### `address_kind`

Suggested values:

- `wallet`
- `token_account`
- `vault`
- `treasury`
- `deposit`
- `payout`
- `merchant`
- `hot_wallet`
- `cold_wallet`
- `unknown`

### `source`

Suggested values:

- `manual`
- `csv_import`
- `api`
- `derived`
- `system`

### Why this table matters

If an address is not in this registry, it is usually not part of the workspace's operational universe.

## 3. Workspace Labels

These are human-meaningful tags attached to addresses or objects.

### Table

`workspace_labels`

### Purpose

Stores labels like:

- `main_treasury`
- `merchant_settlement`
- `customer_funds`
- `exchange_hot_wallet`
- `ops_payout`

### Suggested fields

- `workspace_id` `UUID`
- `label_id` `UUID`
- `label_name` `String`
- `label_type` `Enum`
- `color` `String`
- `description` `String`
- `created_at` `DateTime64`
- `updated_at` `DateTime64`

### Table

`workspace_address_labels`

### Purpose

Many-to-many assignment of labels to addresses.

### Suggested fields

- `workspace_id` `UUID`
- `workspace_address_id` `UUID`
- `label_id` `UUID`
- `created_at` `DateTime64`

## 4. Workspace Business Objects

This is the abstraction layer that makes the product operationally useful.

An address is not enough. Customers think in terms of business objects.

Examples:

- `customer_123`
- `merchant_456`
- `treasury_main`
- `exchange_binance`
- `payout_batch_wallet`

### Table

`workspace_objects`

### Purpose

Represents customer-specific business entities.

### Suggested fields

- `workspace_id` `UUID`
- `workspace_object_id` `UUID`
- `object_type` `Enum`
- `object_key` `String`
- `display_name` `String`
- `status` `Enum`
- `properties_json` `JSON`
- `created_at` `DateTime64`
- `updated_at` `DateTime64`

### `object_type`

Suggested values:

- `customer`
- `merchant`
- `treasury`
- `payout`
- `exchange`
- `counterparty`
- `protocol`
- `internal_account`
- `ops_bucket`

### Why this table matters

This is how we move from blockchain addresses to business interpretation.

## 5. Address-To-Object Mapping

This is the heart of interpretation.

### Table

`workspace_address_object_mappings`

### Purpose

Maps registered addresses to workspace business objects.

### Suggested fields

- `workspace_id` `UUID`
- `mapping_id` `UUID`
- `workspace_address_id` `UUID`
- `workspace_object_id` `UUID`
- `mapping_role` `Enum`
- `confidence` `Float32`
- `source` `Enum`
- `is_primary` `UInt8`
- `valid_from` `DateTime64`
- `valid_to` `Nullable(DateTime64)`
- `properties_json` `JSON`
- `created_at` `DateTime64`

### `mapping_role`

Suggested values:

- `owner`
- `deposit_for`
- `settlement_for`
- `payout_for`
- `treasury_for`
- `counterparty_for`
- `managed_by`
- `receives_for`

### Why this table matters

Without this mapping, we cannot answer:

- whose funds are these?
- is this deposit relevant to customer X?
- did treasury move money or did a merchant receive settlement?

## 6. Global Known Entities

This is separate from workspace objects.

Workspace objects are customer-specific.
Global entities are chain-wide known actors.

Examples:

- Orca pool
- Meteora vault
- Binance deposit wallet
- Circle mint authority

### Table

`global_entities`

### Purpose

Stores curated shared knowledge that can be reused across workspaces.

### Suggested fields

- `global_entity_id` `UUID`
- `entity_name` `String`
- `entity_type` `Enum`
- `chain` `Enum`
- `confidence` `Float32`
- `source` `Enum`
- `properties_json` `JSON`
- `created_at` `DateTime64`
- `updated_at` `DateTime64`

### Table

`global_entity_addresses`

### Suggested fields

- `global_entity_id` `UUID`
- `address` `String`
- `address_kind` `Enum`
- `confidence` `Float32`
- `created_at` `DateTime64`

### Why this table matters

It lets us enrich a workspace without forcing every customer to relabel common Solana infrastructure from scratch.

## 7. Raw Observations

This is the first global chain table.

### Table

`raw_observations`

### Purpose

Stores immutable ingestion records exactly as observed from Yellowstone.

### Suggested fields

- `observation_id` `UUID`
- `ingest_time` `DateTime64`
- `slot` `UInt64`
- `signature` `String`
- `update_type` `Enum`
- `pubkey` `String`
- `owner_program` `String`
- `write_version` `UInt64`
- `raw_payload_json` `JSON`
- `raw_payload_bytes` `String`
- `parser_version` `UInt32`

### Notes

This table is not customer-specific.

It exists so we can:

- replay
- debug parsers
- re-normalize later

## 8. Canonical Account Mutations

This is still global.

### Table

`canonical_account_mutations`

### Purpose

Represents normalized token-account-level balance mutations derived from raw observations.

This is the first table where we can speak in terms of:

- token account
- owner
- mint
- amount_before
- amount_after
- delta

### Suggested fields

- `mutation_id` `UUID`
- `slot` `UInt64`
- `signature` `String`
- `event_time` `DateTime64`
- `mint` `String`
- `token_account` `String`
- `wallet_owner` `String`
- `amount_before_raw` `Int128`
- `amount_after_raw` `Int128`
- `delta_raw` `Int128`
- `decimals` `UInt8`
- `mutation_kind` `Enum`
- `canonical_version` `UInt32`
- `properties_json` `JSON`

### Why this table matters

This is the bridge between raw chain writes and product-grade events.

## 9. Canonical Transaction Events

This is the transaction-scoped global interpretation layer.

### Table

`canonical_transaction_events`

### Purpose

Groups multiple account mutations into a transaction-level canonical event envelope.

### Suggested fields

- `canonical_event_id` `UUID`
- `slot` `UInt64`
- `signature` `String`
- `event_time` `DateTime64`
- `asset` `Enum`
- `chain` `Enum`
- `canonical_version` `UInt32`
- `raw_mutation_count` `UInt32`
- `participant_count` `UInt32`
- `event_summary_json` `JSON`
- `properties_json` `JSON`

### Notes

This table should not yet be customer-scoped.

It should only answer:

- what happened on chain at a normalized level?

It should not answer:

- what does this mean for workspace X?

## 10. Workspace Relevance Links

This is where global events become customer-specific.

### Table

`workspace_event_links`

### Purpose

Links canonical transaction events to workspaces when the event intersects that workspace's address universe.

### Suggested fields

- `workspace_id` `UUID`
- `canonical_event_id` `UUID`
- `link_reason` `Enum`
- `matched_address_count` `UInt32`
- `matched_object_count` `UInt32`
- `created_at` `DateTime64`

### `link_reason`

Suggested values:

- `matched_registered_address`
- `matched_registered_token_account`
- `matched_workspace_object`
- `matched_global_entity_of_interest`

### Why this table matters

This is how we decide relevance.

Not every global event belongs in every workspace.

## 11. Workspace Event Participants

This table explains who was involved from the workspace perspective.

### Table

`workspace_event_participants`

### Purpose

Stores interpreted participants for a workspace-visible event.

### Suggested fields

- `workspace_id` `UUID`
- `canonical_event_id` `UUID`
- `participant_id` `UUID`
- `role` `Enum`
- `address` `String`
- `workspace_address_id` `Nullable(UUID)`
- `workspace_object_id` `Nullable(UUID)`
- `global_entity_id` `Nullable(UUID)`
- `direction` `Enum`
- `amount_raw` `Int128`
- `confidence` `Float32`
- `properties_json` `JSON`

### `role`

Suggested values:

- `source`
- `destination`
- `counterparty`
- `treasury`
- `customer_funds`
- `merchant_settlement`
- `pool`
- `exchange`

## 12. Workspace Operational Events

This is the main serving table.

### Table

`workspace_operational_events`

### Purpose

This is the customer-facing event feed.

It should contain one row per interpreted event for one workspace.

### Suggested fields

- `workspace_id` `UUID`
- `workspace_event_id` `UUID`
- `canonical_event_id` `UUID`
- `slot` `UInt64`
- `signature` `String`
- `event_time` `DateTime64`
- `asset` `Enum`
- `event_type` `Enum`
- `direction` `Enum`
- `amount_raw` `Int128`
- `amount_decimal` `Decimal(38, 6)`
- `primary_object_id` `Nullable(UUID)`
- `counterparty_object_id` `Nullable(UUID)`
- `primary_label` `String`
- `counterparty_label` `String`
- `confidence` `Float32`
- `is_actionable` `UInt8`
- `summary_text` `String`
- `properties_json` `JSON`
- `model_version` `UInt32`
- `created_at` `DateTime64`

### `event_type`

Suggested values:

- `wallet_transfer`
- `exchange_deposit`
- `exchange_withdrawal`
- `pool_deposit`
- `pool_withdrawal`
- `swap_related_movement`
- `treasury_rebalance`
- `mint`
- `burn`
- `unknown`

### Why this table matters

This is the table the product exists to serve.

## 13. Workspace Reconciliation Rows

This is the finance-friendly serving table.

### Table

`workspace_reconciliation_rows`

### Purpose

Produces exportable rows for reconciliation workflows.

### Suggested fields

- `workspace_id` `UUID`
- `reconciliation_row_id` `UUID`
- `workspace_event_id` `UUID`
- `event_time` `DateTime64`
- `asset` `Enum`
- `amount_raw` `Int128`
- `amount_decimal` `Decimal(38, 6)`
- `direction` `Enum`
- `internal_object_key` `String`
- `counterparty_name` `String`
- `event_type` `Enum`
- `signature` `String`
- `token_account` `String`
- `notes` `String`
- `export_status` `Enum`
- `created_at` `DateTime64`

### Why this table matters

Operations and finance users often care less about the full event graph and more about exportable, human-readable rows.

## Minimum Relationship Graph

The minimum useful graph is:

- `workspace`
- `workspace_address`
- `workspace_label`
- `workspace_object`
- `workspace_address_object_mapping`
- `canonical_transaction_event`
- `workspace_event_link`
- `workspace_operational_event`

Without those objects, the product cannot work.

## Why This Model Is Flexible

This model stays flexible because:

- raw chain observations are immutable
- canonical events are versioned
- workspace interpretation is isolated from global chain facts
- labels are many-to-many
- business objects are separate from addresses
- mappings are time-bounded and confidence-aware
- serving tables can be rebuilt when logic changes
- JSON fields allow extension without forcing immediate schema churn

## Important Modeling Decision

We should not bind product logic directly to wallet addresses.

The product should interpret addresses through:

- labels
- business objects
- mappings

That indirection is what gives us multi-customer flexibility.

## MVP-First Table Priority

We should not implement everything at once.

### Phase 1

- `workspaces`
- `workspace_addresses`
- `workspace_labels`
- `workspace_address_labels`
- `workspace_objects`
- `workspace_address_object_mappings`
- `raw_observations`
- `canonical_account_mutations`
- `canonical_transaction_events`
- `workspace_event_links`
- `workspace_operational_events`

### Phase 2

- `global_entities`
- `global_entity_addresses`
- `workspace_event_participants`
- `workspace_reconciliation_rows`

## Recommendation

The key modeling decision is now fixed:

`global chain truth and workspace interpretation must remain separate`

That is the only way to support many customers, each with their own:

- address set
- labels
- internal business objects
- and operational meaning

If we agree on this model, the next step is to convert it into actual ClickHouse table definitions and decide:

- partition keys
- order keys
- primary query patterns
- and which tables are append-only versus rebuildable

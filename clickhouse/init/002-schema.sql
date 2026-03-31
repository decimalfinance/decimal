USE usdc_ops;

-- Raw layer:
-- Immutable ingestion records exactly as seen from Yellowstone.

CREATE TABLE IF NOT EXISTS raw_observations
(
    observation_id UUID,
    ingest_time DateTime64(3, 'UTC') DEFAULT now64(3),
    slot UInt64,
    signature String DEFAULT '',
    update_type LowCardinality(String),
    pubkey String,
    owner_program Nullable(String),
    write_version UInt64,
    raw_payload_json String,
    raw_payload_bytes Nullable(String),
    parser_version UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingest_time)
ORDER BY (slot, signature, pubkey, write_version, observation_id);

-- Canonical layer:
-- Normalized append-only facts derived from raw observations.

CREATE TABLE IF NOT EXISTS canonical_account_mutations
(
    mutation_id UUID,
    slot UInt64,
    signature String,
    event_time DateTime64(3, 'UTC'),
    mint String,
    token_account String,
    wallet_owner Nullable(String),
    amount_before_raw Int128,
    amount_after_raw Int128,
    delta_raw Int128,
    decimals UInt8,
    mutation_kind LowCardinality(String),
    canonical_version UInt32,
    properties_json Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (signature, token_account, mutation_id);

CREATE TABLE IF NOT EXISTS canonical_transaction_events
(
    canonical_event_id UUID,
    slot UInt64,
    signature String,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    chain LowCardinality(String),
    canonical_version UInt32,
    raw_mutation_count UInt32,
    participant_count UInt32,
    event_summary_json Nullable(String),
    properties_json Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, signature, canonical_event_id);

-- Workspace interpretation layer:
-- These records decide whether a global event matters to a given workspace.

CREATE TABLE IF NOT EXISTS workspace_event_links
(
    workspace_id UUID,
    canonical_event_id UUID,
    link_reason LowCardinality(String),
    matched_address_count UInt32,
    matched_object_count UInt32,
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (workspace_id, canonical_event_id, created_at);

CREATE TABLE IF NOT EXISTS workspace_event_participants
(
    workspace_id UUID,
    canonical_event_id UUID,
    participant_id UUID,
    role LowCardinality(String),
    address String,
    workspace_address_id Nullable(UUID),
    workspace_object_id Nullable(UUID),
    global_entity_id Nullable(UUID),
    direction LowCardinality(String),
    amount_raw Int128,
    confidence Float32,
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (workspace_id, canonical_event_id, participant_id);

-- Serving layer:
-- Customer-facing operational records. These are rebuildable from canonical + workspace config.

CREATE TABLE IF NOT EXISTS workspace_operational_events
(
    workspace_id UUID,
    workspace_event_id UUID,
    canonical_event_id UUID,
    slot UInt64,
    signature String,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    event_type LowCardinality(String),
    direction LowCardinality(String),
    amount_raw Int128,
    amount_decimal Decimal(38, 6),
    primary_object_id Nullable(UUID),
    counterparty_object_id Nullable(UUID),
    primary_label Nullable(String),
    counterparty_label Nullable(String),
    confidence Float32,
    is_actionable UInt8 DEFAULT 0,
    summary_text String,
    properties_json Nullable(String),
    model_version UInt32,
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (workspace_id, event_time, workspace_event_id);

CREATE TABLE IF NOT EXISTS workspace_reconciliation_rows
(
    workspace_id UUID,
    reconciliation_row_id UUID,
    workspace_event_id UUID,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    amount_raw Int128,
    amount_decimal Decimal(38, 6),
    direction LowCardinality(String),
    internal_object_key Nullable(String),
    counterparty_name Nullable(String),
    event_type LowCardinality(String),
    signature String,
    token_account Nullable(String),
    notes Nullable(String),
    export_status LowCardinality(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (workspace_id, event_time, reconciliation_row_id);

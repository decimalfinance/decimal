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

CREATE TABLE IF NOT EXISTS observed_transactions
(
    signature String,
    slot UInt64,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    finality_state LowCardinality(String),
    status LowCardinality(String),
    raw_mutation_count UInt32,
    participant_count UInt32,
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, signature);

CREATE TABLE IF NOT EXISTS observed_transfers
(
    transfer_id UUID,
    signature String,
    slot UInt64,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    source_token_account Nullable(String),
    source_wallet Nullable(String),
    destination_token_account String,
    destination_wallet Nullable(String),
    amount_raw Int128,
    amount_decimal Decimal(38, 6),
    transfer_kind LowCardinality(String),
    instruction_index Nullable(UInt32),
    inner_instruction_index Nullable(UInt32),
    route_group String DEFAULT '',
    leg_role LowCardinality(String) DEFAULT 'unknown',
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, signature, destination_token_account, transfer_id);

ALTER TABLE observed_transfers
    DROP COLUMN IF EXISTS workspace_id;

ALTER TABLE observed_transfers
    ADD COLUMN IF NOT EXISTS instruction_index Nullable(UInt32) AFTER transfer_kind;

ALTER TABLE observed_transfers
    ADD COLUMN IF NOT EXISTS inner_instruction_index Nullable(UInt32) AFTER instruction_index;

ALTER TABLE observed_transfers
    ADD COLUMN IF NOT EXISTS route_group String DEFAULT '' AFTER inner_instruction_index;

ALTER TABLE observed_transfers
    ADD COLUMN IF NOT EXISTS leg_role LowCardinality(String) DEFAULT 'unknown' AFTER route_group;

CREATE TABLE IF NOT EXISTS observed_payments
(
    payment_id UUID,
    signature String,
    slot UInt64,
    event_time DateTime64(3, 'UTC'),
    asset LowCardinality(String),
    source_wallet Nullable(String),
    destination_wallet Nullable(String),
    gross_amount_raw Int128,
    gross_amount_decimal Decimal(38, 6),
    net_destination_amount_raw Int128,
    net_destination_amount_decimal Decimal(38, 6),
    fee_amount_raw Int128,
    fee_amount_decimal Decimal(38, 6),
    route_count UInt32,
    payment_kind LowCardinality(String),
    reconstruction_rule LowCardinality(String),
    confidence_band LowCardinality(String),
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, signature, payment_id);

CREATE TABLE IF NOT EXISTS matcher_events
(
    event_id UUID,
    workspace_id UUID,
    destination_address String,
    transfer_request_id Nullable(UUID),
    observed_transfer_id Nullable(UUID),
    signature Nullable(String),
    event_type LowCardinality(String),
    quantity_raw Int128,
    remaining_request_raw Nullable(Int128),
    remaining_observation_raw Nullable(Int128),
    explanation String,
    event_time DateTime64(3, 'UTC'),
    properties_json Nullable(String),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (workspace_id, destination_address, event_time, event_id);

ALTER TABLE matcher_events
    RENAME COLUMN IF EXISTS observed_movement_id TO observed_transfer_id;

ALTER TABLE matcher_events
    ADD COLUMN IF NOT EXISTS observed_transfer_id Nullable(UUID) AFTER transfer_request_id;

CREATE TABLE IF NOT EXISTS request_book_snapshots
(
    workspace_id UUID,
    destination_address String,
    transfer_request_id UUID,
    requested_at DateTime64(3, 'UTC'),
    request_type LowCardinality(String),
    requested_amount_raw Int128,
    allocated_amount_raw Int128,
    remaining_amount_raw Int128,
    fill_count UInt32,
    book_status LowCardinality(String),
    last_signature Nullable(String),
    last_observed_transfer_id Nullable(UUID),
    observed_event_time Nullable(DateTime64(3, 'UTC')),
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(updated_at)
ORDER BY (workspace_id, destination_address, transfer_request_id);

ALTER TABLE request_book_snapshots
    RENAME COLUMN IF EXISTS last_observed_movement_id TO last_observed_transfer_id;

ALTER TABLE request_book_snapshots
    ADD COLUMN IF NOT EXISTS last_observed_transfer_id Nullable(UUID) AFTER last_signature;

ALTER TABLE request_book_snapshots
    ADD COLUMN IF NOT EXISTS observed_event_time Nullable(DateTime64(3, 'UTC')) AFTER last_observed_transfer_id;

CREATE TABLE IF NOT EXISTS settlement_matches
(
    workspace_id UUID,
    transfer_request_id UUID,
    signature Nullable(String),
    observed_transfer_id Nullable(UUID),
    match_status LowCardinality(String),
    confidence_score UInt8,
    confidence_band LowCardinality(String),
    matched_amount_raw Int128,
    amount_variance_raw Int128,
    destination_match_type LowCardinality(String),
    time_delta_seconds Int64,
    match_rule LowCardinality(String),
    candidate_count UInt32,
    explanation String,
    observed_event_time Nullable(DateTime64(3, 'UTC')),
    matched_at Nullable(DateTime64(3, 'UTC')),
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(updated_at)
ORDER BY (workspace_id, transfer_request_id);

ALTER TABLE settlement_matches
    RENAME COLUMN IF EXISTS observed_movement_id TO observed_transfer_id;

ALTER TABLE settlement_matches
    ADD COLUMN IF NOT EXISTS observed_transfer_id Nullable(UUID) AFTER signature;

ALTER TABLE settlement_matches
    ADD COLUMN IF NOT EXISTS observed_event_time Nullable(DateTime64(3, 'UTC')) AFTER explanation;

ALTER TABLE settlement_matches
    ADD COLUMN IF NOT EXISTS matched_at Nullable(DateTime64(3, 'UTC')) AFTER observed_event_time;

CREATE TABLE IF NOT EXISTS exceptions
(
    workspace_id UUID,
    exception_id UUID,
    transfer_request_id Nullable(UUID),
    signature Nullable(String),
    observed_transfer_id Nullable(UUID),
    exception_type LowCardinality(String),
    severity LowCardinality(String),
    status LowCardinality(String),
    explanation String,
    properties_json Nullable(String),
    observed_event_time Nullable(DateTime64(3, 'UTC')),
    processed_at Nullable(DateTime64(3, 'UTC')),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(updated_at)
ORDER BY (workspace_id, exception_id);

ALTER TABLE exceptions
    RENAME COLUMN IF EXISTS observed_movement_id TO observed_transfer_id;

ALTER TABLE exceptions
    ADD COLUMN IF NOT EXISTS observed_transfer_id Nullable(UUID) AFTER signature;

ALTER TABLE exceptions
    ADD COLUMN IF NOT EXISTS observed_event_time Nullable(DateTime64(3, 'UTC')) AFTER properties_json;

ALTER TABLE exceptions
    ADD COLUMN IF NOT EXISTS processed_at Nullable(DateTime64(3, 'UTC')) AFTER observed_event_time;

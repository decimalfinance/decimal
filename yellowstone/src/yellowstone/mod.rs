use crate::control_plane::{
    WorkspaceAddressMatch, WorkspaceObjectMappingView, WorkspaceRegistry, WorkspaceRegistryCache,
};
use crate::storage::{
    CanonicalAccountMutationRow, CanonicalTransactionEventRow, ClickHouseWriter, RawObservationRow,
    WorkspaceEventLinkRow, WorkspaceEventParticipantRow, WorkspaceOperationalEventRow,
    WorkspaceReconciliationRow,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use spl_token::solana_program::program_option::COption;
use spl_token::solana_program::program_pack::Pack;
use spl_token::state::{
    Account as SplTokenAccount, AccountState as SplTokenAccountState, Mint as SplTokenMint,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
use yellowstone_grpc_proto::prelude::SubscribeUpdate;

pub mod client;
pub mod subscriptions;

#[derive(Default)]
struct WorkerState {
    current_slot: Option<u64>,
    current_signature: Option<String>,
    current_transaction: Option<TransactionBuffer>,
    last_seen_amounts: HashMap<String, u64>,
}

struct TransactionBuffer {
    slot: u64,
    signature: String,
    event_time: chrono::DateTime<Utc>,
    raw_mutation_count: u32,
    participants: HashSet<String>,
    net_amount_raw: i128,
    mutations: Vec<TransactionMutation>,
}

#[derive(Clone)]
struct TransactionMutation {
    token_account: String,
    wallet_owner: String,
    delta_raw: i128,
    amount_before_raw: i128,
    amount_after_raw: i128,
}

pub struct YellowstoneWorker {
    endpoint: String,
    x_token: Option<String>,
    writer: ClickHouseWriter,
    registry_cache: tokio::sync::Mutex<WorkspaceRegistryCache>,
}

impl YellowstoneWorker {
    pub fn new(
        endpoint: String,
        x_token: Option<String>,
        writer: ClickHouseWriter,
        registry_cache: WorkspaceRegistryCache,
    ) -> Self {
        Self {
            endpoint,
            x_token,
            writer,
            registry_cache: tokio::sync::Mutex::new(registry_cache),
        }
    }

    pub async fn run(self) {
        let endpoint = self.endpoint.clone();
        let x_token = self.x_token.clone();

        println!("Yellowstone Worker started! Connecting to {}...", endpoint);

        let mut client = match client::connect(&endpoint, x_token).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Failed to connect to Yellowstone gRPC: {}", e);
                return;
            }
        };

        println!("Connected to Yellowstone gRPC!");

        if let Err(error) = self.refresh_registry_if_stale().await {
            eprintln!("Failed to load workspace registry on startup: {}", error);
        }

        let request = subscriptions::create_subscription_request();

        let (mut subscribe_tx, mut stream) = match client.subscribe().await {
            Ok(res) => res,
            Err(e) => {
                eprintln!("Failed to subscribe: {}", e);
                return;
            }
        };

        if let Err(e) = subscribe_tx.send(request).await {
            eprintln!("Failed to send subscription request: {}", e);
            return;
        }

        println!("Subscribed to updates! Waiting for data...");
        let mut worker_state = WorkerState::default();

        loop {
            match stream.next().await {
                Some(Ok(update)) => {
                    if let Err(error) = self.refresh_registry_if_stale().await {
                        eprintln!("Failed to refresh workspace registry: {}", error);
                    }
                    self.handle_update(update, &mut worker_state).await;
                }
                Some(Err(e)) => {
                    eprintln!("Stream error: {}", e);
                }
                None => {
                    println!("Stream ended");
                    break;
                }
            }
        }

        self.flush_transaction_event(&mut worker_state).await;
        println!("Yellowstone Worker shutting down...");
    }

    async fn handle_update(&self, update: SubscribeUpdate, worker_state: &mut WorkerState) {
        let filters = if update.filters.is_empty() {
            "-".to_string()
        } else {
            update.filters.join(",")
        };

        match update.update_oneof {
            Some(UpdateOneof::Account(account_update)) => {
                if let Some(account) = account_update.account {
                    let pubkey = bs58::encode(&account.pubkey).into_string();
                    let signature = account
                        .txn_signature
                        .as_ref()
                        .map(|signature| bs58::encode(signature).into_string())
                        .unwrap_or_else(|| "none".to_string());
                    let owner_program = bs58::encode(&account.owner).into_string();
                    let ingest_time = Utc::now();

                    if worker_state.current_slot != Some(account_update.slot) {
                        self.flush_transaction_event(worker_state).await;
                        worker_state.current_slot = Some(account_update.slot);
                        worker_state.current_signature = None;
                        println!();
                        println!("======== slot={} ========", account_update.slot);
                    }

                    if worker_state.current_signature.as_deref() != Some(signature.as_str()) {
                        self.flush_transaction_event(worker_state).await;
                        worker_state.current_signature = Some(signature.clone());
                        println!("-------- txn={} --------", signature);
                        if signature != "none" {
                            worker_state.current_transaction = Some(TransactionBuffer {
                                slot: account_update.slot,
                                signature: signature.clone(),
                                event_time: ingest_time,
                                raw_mutation_count: 0,
                                participants: HashSet::new(),
                                net_amount_raw: 0,
                                mutations: Vec::new(),
                            });
                        }
                    }

                    let raw_payload_json = json!({
                        "filters": update.filters,
                        "slot": account_update.slot,
                        "pubkey": pubkey,
                        "signature": signature,
                        "owner_program": owner_program,
                        "data_len": account.data.len(),
                        "write_version": account.write_version,
                    })
                    .to_string();

                    let raw_row = RawObservationRow {
                        observation_id: Uuid::new_v4().to_string(),
                        ingest_time,
                        slot: account_update.slot,
                        signature: signature.clone(),
                        update_type: "account".to_string(),
                        pubkey: bs58::encode(&account.pubkey).into_string(),
                        owner_program: Some(bs58::encode(&account.owner).into_string()),
                        write_version: account.write_version,
                        raw_payload_json,
                        raw_payload_bytes: Some(BASE64.encode(&account.data)),
                        parser_version: 1,
                    };

                    if let Err(error) = self.writer.insert_raw_observation(&raw_row).await {
                        eprintln!("Failed to insert raw observation: {}", error);
                    }

                    match filters.as_str() {
                        "usdc_token_accounts" => match SplTokenAccount::unpack(&account.data) {
                            Ok(token_account) => {
                                let amount_after_raw = i128::from(token_account.amount);
                                let amount_before_raw = worker_state
                                    .last_seen_amounts
                                    .get(&pubkey)
                                    .copied()
                                    .map(i128::from)
                                    .unwrap_or(amount_after_raw);
                                let delta_raw = amount_after_raw - amount_before_raw;
                                worker_state
                                    .last_seen_amounts
                                    .insert(pubkey.clone(), token_account.amount);

                                let mutation_kind = if delta_raw > 0 {
                                    "credit"
                                } else if delta_raw < 0 {
                                    "debit"
                                } else {
                                    "account_write"
                                };

                                let mutation_row = CanonicalAccountMutationRow {
                                    mutation_id: Uuid::new_v4().to_string(),
                                    slot: account_update.slot,
                                    signature: signature.clone(),
                                    event_time: ingest_time,
                                    mint: token_account.mint.to_string(),
                                    token_account: pubkey.clone(),
                                    wallet_owner: Some(token_account.owner.to_string()),
                                    amount_before_raw,
                                    amount_after_raw,
                                    delta_raw,
                                    decimals: 6,
                                    mutation_kind: mutation_kind.to_string(),
                                    canonical_version: 1,
                                    properties_json: Some(
                                        json!({
                                            "state": token_account_state_label(token_account.state),
                                            "delegated_amount": token_account.delegated_amount,
                                            "delegate": coption_pubkey_to_string(&token_account.delegate),
                                            "is_native": token_account.is_native(),
                                            "close_authority": coption_pubkey_to_string(&token_account.close_authority),
                                            "write_version": account.write_version,
                                        })
                                        .to_string(),
                                    ),
                                };

                                if let Err(error) = self
                                    .writer
                                    .insert_canonical_account_mutation(&mutation_row)
                                    .await
                                {
                                    eprintln!(
                                        "Failed to insert canonical account mutation: {}",
                                        error
                                    );
                                }

                                if let Some(transaction) = worker_state.current_transaction.as_mut()
                                {
                                    transaction.raw_mutation_count += 1;
                                    transaction.participants.insert(pubkey.clone());
                                    transaction
                                        .participants
                                        .insert(token_account.owner.to_string());
                                    transaction.net_amount_raw += delta_raw.abs();
                                    transaction.mutations.push(TransactionMutation {
                                        token_account: pubkey.clone(),
                                        wallet_owner: token_account.owner.to_string(),
                                        delta_raw,
                                        amount_before_raw,
                                        amount_after_raw,
                                    });
                                }

                                println!(
                                    "account={} token_owner={} mint={} amount={} state={} delegated_amount={} delegate={} is_native={} close_authority={} write_version={}",
                                    pubkey,
                                    token_account.owner,
                                    token_account.mint,
                                    token_account.amount,
                                    token_account_state_label(token_account.state),
                                    token_account.delegated_amount,
                                    coption_pubkey_to_string(&token_account.delegate),
                                    token_account.is_native(),
                                    coption_pubkey_to_string(&token_account.close_authority),
                                    account.write_version,
                                );
                            }
                            Err(error) => {
                                println!(
                                    "account={} owner_program={} data_len={} decode_error={} write_version={}",
                                    pubkey,
                                    owner_program,
                                    account.data.len(),
                                    error,
                                    account.write_version,
                                );
                            }
                        },
                        "usdc_mint" => match SplTokenMint::unpack(&account.data) {
                            Ok(mint) => {
                                println!(
                                    "mint_account={} supply={} decimals={} initialized={} mint_authority={} freeze_authority={} write_version={}",
                                    pubkey,
                                    mint.supply,
                                    mint.decimals,
                                    mint.is_initialized,
                                    coption_pubkey_to_string(&mint.mint_authority),
                                    coption_pubkey_to_string(&mint.freeze_authority),
                                    account.write_version,
                                );
                            }
                            Err(error) => {
                                println!(
                                    "mint_account={} owner_program={} data_len={} decode_error={} write_version={}",
                                    pubkey,
                                    owner_program,
                                    account.data.len(),
                                    error,
                                    account.write_version,
                                );
                            }
                        },
                        _ => {
                            println!(
                                "account={} filters=[{}] owner_program={} write_version={} data_len={}",
                                pubkey,
                                filters,
                                owner_program,
                                account.write_version,
                                account.data.len(),
                            );
                        }
                    }
                } else {
                    println!(
                        "ACCOUNT filters=[{}] slot={} missing_account",
                        filters, account_update.slot
                    );
                }
            }
            Some(UpdateOneof::Ping(_)) => {
                println!("PING filters=[{}] keepalive", filters);
            }
            Some(UpdateOneof::Transaction(tx)) => {
                let signature = tx
                    .transaction
                    .as_ref()
                    .map(|tx| bs58::encode(&tx.signature).into_string())
                    .unwrap_or_else(|| "none".to_string());
                println!(
                    "TRANSACTION filters=[{}] slot={} signature={}",
                    filters, tx.slot, signature
                );
            }
            Some(UpdateOneof::TransactionStatus(status)) => {
                println!(
                    "TRANSACTION_STATUS filters=[{}] slot={} signature={}",
                    filters,
                    status.slot,
                    bs58::encode(&status.signature).into_string(),
                );
            }
            Some(UpdateOneof::Slot(slot)) => {
                println!(
                    "SLOT filters=[{}] slot={} status={}",
                    filters, slot.slot, slot.status
                );
            }
            Some(UpdateOneof::Block(block)) => {
                println!(
                    "BLOCK filters=[{}] slot={} txs={} accounts={}",
                    filters,
                    block.slot,
                    block.executed_transaction_count,
                    block.updated_account_count,
                );
            }
            Some(UpdateOneof::BlockMeta(block_meta)) => {
                println!(
                    "BLOCK_META filters=[{}] slot={} txs={}",
                    filters, block_meta.slot, block_meta.executed_transaction_count
                );
            }
            Some(UpdateOneof::Entry(entry)) => {
                println!(
                    "ENTRY filters=[{}] slot={} index={} txs={}",
                    filters, entry.slot, entry.index, entry.executed_transaction_count
                );
            }
            Some(UpdateOneof::Pong(pong)) => {
                println!("PONG filters=[{}] id={}", filters, pong.id);
            }
            None => {
                println!("UPDATE filters=[{}] empty", filters);
            }
        }
    }

    async fn flush_transaction_event(&self, worker_state: &mut WorkerState) {
        let Some(transaction) = worker_state.current_transaction.take() else {
            return;
        };

        if transaction.signature == "none" {
            return;
        }

        let event_row = CanonicalTransactionEventRow {
            canonical_event_id: Uuid::new_v4().to_string(),
            slot: transaction.slot,
            signature: transaction.signature.clone(),
            event_time: transaction.event_time,
            asset: "usdc".to_string(),
            chain: "solana".to_string(),
            canonical_version: 1,
            raw_mutation_count: transaction.raw_mutation_count,
            participant_count: transaction.participants.len() as u32,
            event_summary_json: Some(
                json!({
                    "participant_count": transaction.participants.len(),
                    "observed_abs_delta_raw": transaction.net_amount_raw,
                })
                .to_string(),
            ),
            properties_json: None,
        };

        if let Err(error) = self
            .writer
            .insert_canonical_transaction_event(&event_row)
            .await
        {
            eprintln!("Failed to insert canonical transaction event: {}", error);
        }

        let registry_guard = self.registry_cache.lock().await;
        self.materialize_workspace_events(registry_guard.registry(), &event_row, &transaction)
            .await;
    }

    async fn refresh_registry_if_stale(&self) -> Result<(), reqwest::Error> {
        let mut cache = self.registry_cache.lock().await;
        cache.refresh_if_stale().await
    }

    async fn materialize_workspace_events(
        &self,
        registry: &WorkspaceRegistry,
        event_row: &CanonicalTransactionEventRow,
        transaction: &TransactionBuffer,
    ) {
        let mut by_workspace: HashMap<String, WorkspaceMaterialization> = HashMap::new();

        for mutation in &transaction.mutations {
            self.apply_workspace_matches(
                registry,
                &mutation.token_account,
                mutation,
                "token_account",
                &mut by_workspace,
            );
            self.apply_workspace_matches(
                registry,
                &mutation.wallet_owner,
                mutation,
                "wallet_owner",
                &mut by_workspace,
            );
        }

        for (_, materialization) in by_workspace {
            let matched_address_count = materialization.matched_address_ids.len() as u32;
            let matched_object_count = materialization.matched_object_ids.len() as u32;

            let link_row = WorkspaceEventLinkRow {
                workspace_id: materialization.workspace_id.clone(),
                canonical_event_id: event_row.canonical_event_id.clone(),
                link_reason: "watched_address_match".to_string(),
                matched_address_count,
                matched_object_count,
            };

            if let Err(error) = self.writer.insert_workspace_event_link(&link_row).await {
                eprintln!("Failed to insert workspace event link: {}", error);
            }

            for participant in &materialization.participants {
                let participant_row = WorkspaceEventParticipantRow {
                    workspace_id: materialization.workspace_id.clone(),
                    canonical_event_id: event_row.canonical_event_id.clone(),
                    participant_id: Uuid::new_v4().to_string(),
                    role: participant.role.clone(),
                    address: participant.address.clone(),
                    workspace_address_id: Some(participant.workspace_address_id.clone()),
                    workspace_object_id: participant.workspace_object_id.clone(),
                    global_entity_id: None,
                    direction: classify_direction(participant.amount_raw).to_string(),
                    amount_raw: participant.amount_raw,
                    confidence: 1.0,
                    properties_json: Some(
                        json!({
                            "address_kind": participant.address_kind,
                            "match_type": participant.match_type,
                            "mapping_role": participant.mapping_role,
                            "token_account": participant.token_account,
                            "wallet_owner": participant.wallet_owner,
                            "amount_before_raw": participant.amount_before_raw,
                            "amount_after_raw": participant.amount_after_raw,
                        })
                        .to_string(),
                    ),
                };

                if let Err(error) = self
                    .writer
                    .insert_workspace_event_participant(&participant_row)
                    .await
                {
                    eprintln!("Failed to insert workspace event participant: {}", error);
                }
            }

            let (event_type, direction) = classify_workspace_event(
                materialization.positive_flow_raw,
                materialization.negative_flow_raw,
            );
            let amount_raw = if direction == "inflow" {
                materialization.positive_flow_raw
            } else if direction == "outflow" {
                materialization.negative_flow_raw.abs()
            } else {
                materialization.abs_flow_raw
            };

            let primary_mapping = materialization.primary_mapping.as_ref();
            let workspace_event_id = Uuid::new_v4().to_string();
            let summary_text = format!(
                "{} observed {} {} USDC movement in txn {}",
                materialization.workspace_name,
                direction,
                format_amount(amount_raw),
                event_row.signature,
            );

            let operational_row = WorkspaceOperationalEventRow {
                workspace_id: materialization.workspace_id.clone(),
                workspace_event_id: workspace_event_id.clone(),
                canonical_event_id: event_row.canonical_event_id.clone(),
                slot: event_row.slot,
                signature: event_row.signature.clone(),
                event_time: event_row.event_time,
                asset: "usdc".to_string(),
                event_type: event_type.to_string(),
                direction: direction.to_string(),
                amount_raw,
                amount_decimal: format_amount(amount_raw),
                primary_object_id: primary_mapping.map(|value| value.workspace_object_id.clone()),
                counterparty_object_id: None,
                primary_label: materialization.primary_label.clone(),
                counterparty_label: None,
                confidence: 1.0,
                is_actionable: if direction == "mixed" { 0 } else { 1 },
                summary_text,
                properties_json: Some(
                    json!({
                        "matched_address_count": matched_address_count,
                        "matched_object_count": matched_object_count,
                        "abs_flow_raw": materialization.abs_flow_raw,
                    })
                    .to_string(),
                ),
                model_version: 1,
            };

            if let Err(error) = self
                .writer
                .insert_workspace_operational_event(&operational_row)
                .await
            {
                eprintln!("Failed to insert workspace operational event: {}", error);
            }

            let reconciliation_row = WorkspaceReconciliationRow {
                workspace_id: materialization.workspace_id,
                reconciliation_row_id: Uuid::new_v4().to_string(),
                workspace_event_id,
                event_time: event_row.event_time,
                asset: "usdc".to_string(),
                amount_raw,
                amount_decimal: format_amount(amount_raw),
                direction: direction.to_string(),
                internal_object_key: primary_mapping.map(|value| value.object_key.clone()),
                counterparty_name: None,
                event_type: event_type.to_string(),
                signature: event_row.signature.clone(),
                token_account: materialization.primary_token_account.clone(),
                notes: primary_mapping.map(|value| value.display_name.clone()),
                export_status: "pending".to_string(),
            };

            if let Err(error) = self
                .writer
                .insert_workspace_reconciliation_row(&reconciliation_row)
                .await
            {
                eprintln!("Failed to insert workspace reconciliation row: {}", error);
            }
        }
    }

    fn apply_workspace_matches(
        &self,
        registry: &WorkspaceRegistry,
        address: &str,
        mutation: &TransactionMutation,
        match_type: &str,
        by_workspace: &mut HashMap<String, WorkspaceMaterialization>,
    ) {
        let Some(matches) = registry.matches_for_address(address) else {
            return;
        };

        for matched in matches {
            let entry = by_workspace
                .entry(matched.workspace_id.clone())
                .or_insert_with(|| WorkspaceMaterialization::from_match(matched));

            entry
                .matched_address_ids
                .insert(matched.workspace_address_id.clone());
            entry.abs_flow_raw += mutation.delta_raw.abs();

            if mutation.delta_raw > 0 {
                entry.positive_flow_raw += mutation.delta_raw;
            } else if mutation.delta_raw < 0 {
                entry.negative_flow_raw += mutation.delta_raw;
            }

            if entry.primary_label.is_none() {
                entry.primary_label = matched.label_names.first().cloned();
            }

            if entry.primary_token_account.is_none() {
                entry.primary_token_account = Some(mutation.token_account.clone());
            }

            if matched.object_mappings.is_empty() {
                entry
                    .participants
                    .push(WorkspaceParticipantMaterialization {
                        role: "workspace_address".to_string(),
                        address: matched.address.clone(),
                        address_kind: matched.address_kind.clone(),
                        workspace_address_id: matched.workspace_address_id.clone(),
                        workspace_object_id: None,
                        mapping_role: None,
                        match_type: match_type.to_string(),
                        amount_raw: mutation.delta_raw,
                        token_account: mutation.token_account.clone(),
                        wallet_owner: mutation.wallet_owner.clone(),
                        amount_before_raw: mutation.amount_before_raw,
                        amount_after_raw: mutation.amount_after_raw,
                    });
                continue;
            }

            for mapping in &matched.object_mappings {
                entry
                    .matched_object_ids
                    .insert(mapping.workspace_object_id.clone());

                if entry.primary_mapping.is_none() {
                    entry.primary_mapping = Some(mapping.clone());
                }

                entry
                    .participants
                    .push(WorkspaceParticipantMaterialization {
                        role: "workspace_object".to_string(),
                        address: matched.address.clone(),
                        address_kind: matched.address_kind.clone(),
                        workspace_address_id: matched.workspace_address_id.clone(),
                        workspace_object_id: Some(mapping.workspace_object_id.clone()),
                        mapping_role: Some(mapping.mapping_role.clone()),
                        match_type: match_type.to_string(),
                        amount_raw: mutation.delta_raw,
                        token_account: mutation.token_account.clone(),
                        wallet_owner: mutation.wallet_owner.clone(),
                        amount_before_raw: mutation.amount_before_raw,
                        amount_after_raw: mutation.amount_after_raw,
                    });
            }
        }
    }
}

struct WorkspaceMaterialization {
    workspace_id: String,
    workspace_name: String,
    matched_address_ids: HashSet<String>,
    matched_object_ids: HashSet<String>,
    participants: Vec<WorkspaceParticipantMaterialization>,
    positive_flow_raw: i128,
    negative_flow_raw: i128,
    abs_flow_raw: i128,
    primary_mapping: Option<WorkspaceObjectMappingView>,
    primary_label: Option<String>,
    primary_token_account: Option<String>,
}

impl WorkspaceMaterialization {
    fn from_match(matched: &WorkspaceAddressMatch) -> Self {
        Self {
            workspace_id: matched.workspace_id.clone(),
            workspace_name: matched.workspace_name.clone(),
            matched_address_ids: HashSet::new(),
            matched_object_ids: HashSet::new(),
            participants: Vec::new(),
            positive_flow_raw: 0,
            negative_flow_raw: 0,
            abs_flow_raw: 0,
            primary_mapping: None,
            primary_label: None,
            primary_token_account: None,
        }
    }
}

struct WorkspaceParticipantMaterialization {
    role: String,
    address: String,
    address_kind: String,
    workspace_address_id: String,
    workspace_object_id: Option<String>,
    mapping_role: Option<String>,
    match_type: String,
    amount_raw: i128,
    token_account: String,
    wallet_owner: String,
    amount_before_raw: i128,
    amount_after_raw: i128,
}

fn classify_workspace_event(
    positive_flow_raw: i128,
    negative_flow_raw: i128,
) -> (&'static str, &'static str) {
    if positive_flow_raw > 0 && negative_flow_raw == 0 {
        ("workspace_inflow", "inflow")
    } else if negative_flow_raw < 0 && positive_flow_raw == 0 {
        ("workspace_outflow", "outflow")
    } else if positive_flow_raw > 0 && negative_flow_raw < 0 {
        ("workspace_mixed", "mixed")
    } else {
        ("workspace_observed_write", "neutral")
    }
}

fn classify_direction(amount_raw: i128) -> &'static str {
    if amount_raw > 0 {
        "inflow"
    } else if amount_raw < 0 {
        "outflow"
    } else {
        "neutral"
    }
}

fn format_amount(amount_raw: i128) -> String {
    let negative = amount_raw < 0;
    let amount = amount_raw.abs();
    let whole = amount / 1_000_000;
    let frac = amount % 1_000_000;

    if negative {
        format!("-{}.{:06}", whole, frac)
    } else {
        format!("{}.{:06}", whole, frac)
    }
}

fn coption_pubkey_to_string(value: &COption<spl_token::solana_program::pubkey::Pubkey>) -> String {
    match value {
        COption::Some(pubkey) => pubkey.to_string(),
        COption::None => "none".to_string(),
    }
}

fn token_account_state_label(state: SplTokenAccountState) -> &'static str {
    match state {
        SplTokenAccountState::Uninitialized => "uninitialized",
        SplTokenAccountState::Initialized => "initialized",
        SplTokenAccountState::Frozen => "frozen",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::WorkspaceRegistry;
    use crate::control_plane::WorkspaceRegistryCache;
    use crate::storage::ClickHouseWriter;
    use reqwest::Client;
    use serde_json::Value;
    use spl_token::solana_program::program_option::COption;
    use spl_token::solana_program::pubkey::Pubkey;
    use spl_token::state::Account as SplAccount;
    use std::str::FromStr;
    use yellowstone_grpc_proto::geyser::{SubscribeUpdateAccount, SubscribeUpdateAccountInfo};

    #[test]
    fn classify_workspace_event_detects_inflow_outflow_and_mixed() {
        assert_eq!(classify_workspace_event(10, 0), ("workspace_inflow", "inflow"));
        assert_eq!(classify_workspace_event(0, -10), ("workspace_outflow", "outflow"));
        assert_eq!(classify_workspace_event(10, -5), ("workspace_mixed", "mixed"));
        assert_eq!(
            classify_workspace_event(0, 0),
            ("workspace_observed_write", "neutral")
        );
    }

    #[test]
    fn classify_direction_maps_signs() {
        assert_eq!(classify_direction(5), "inflow");
        assert_eq!(classify_direction(-5), "outflow");
        assert_eq!(classify_direction(0), "neutral");
    }

    #[test]
    fn format_amount_renders_usdc_decimals() {
        assert_eq!(format_amount(1), "0.000001");
        assert_eq!(format_amount(12_345_678), "12.345678");
        assert_eq!(format_amount(-12_345_678), "-12.345678");
    }

    #[tokio::test]
    async fn worker_writes_inflow_across_raw_canonical_and_workspace_tables() {
        if !should_run_clickhouse_tests() {
            return;
        }

        let harness = ClickHouseHarness::new().await;
        harness.reset().await;

        let wallet = Pubkey::new_unique();
        let token_account = Pubkey::new_unique();
        let workspace_id = Uuid::new_v4().to_string();
        let registry = WorkspaceRegistry::from_matches(vec![WorkspaceAddressMatch {
            workspace_id: workspace_id.clone(),
            workspace_name: "Acme Ops".to_string(),
            workspace_address_id: Uuid::new_v4().to_string(),
            address: wallet.to_string(),
            address_kind: "treasury_wallet".to_string(),
            label_names: vec!["treasury".to_string()],
            object_mappings: vec![WorkspaceObjectMappingView {
                workspace_object_id: Uuid::new_v4().to_string(),
                object_key: "main".to_string(),
                display_name: "Main Treasury".to_string(),
                mapping_role: "owner".to_string(),
            }],
        }]);

        let worker = test_worker(registry);
        let mut state = WorkerState::default();
        state
            .last_seen_amounts
            .insert(token_account.to_string(), 100_000_000);

        worker
            .handle_update(
                make_usdc_account_update(
                    1,
                    "11111111111111111111111111111111",
                    token_account,
                    wallet,
                    150_000_000,
                    1,
                ),
                &mut state,
            )
            .await;
        worker.flush_transaction_event(&mut state).await;

        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.raw_observations")
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.canonical_account_mutations")
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.canonical_transaction_events")
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.workspace_operational_events")
                .await,
            1
        );

        let mutations = harness
            .query_rows(
                "SELECT signature, delta_raw, amount_before_raw, amount_after_raw FROM usdc_ops.canonical_account_mutations FORMAT JSONEachRow",
            )
            .await;
        assert_eq!(mutations[0]["delta_raw"], Value::String("50000000".to_string()));
        assert_eq!(
            mutations[0]["amount_before_raw"],
            Value::String("100000000".to_string())
        );
        assert_eq!(
            mutations[0]["amount_after_raw"],
            Value::String("150000000".to_string())
        );

        let events = harness
            .query_rows(
                "SELECT workspace_id, event_type, direction, amount_raw FROM usdc_ops.workspace_operational_events FORMAT JSONEachRow",
            )
            .await;
        assert_eq!(events[0]["workspace_id"], Value::String(workspace_id));
        assert_eq!(
            events[0]["event_type"],
            Value::String("workspace_inflow".to_string())
        );
        assert_eq!(events[0]["direction"], Value::String("inflow".to_string()));
        assert_eq!(events[0]["amount_raw"], Value::String("50000000".to_string()));
    }

    #[tokio::test]
    async fn worker_writes_outflow_workspace_event() {
        if !should_run_clickhouse_tests() {
            return;
        }

        let harness = ClickHouseHarness::new().await;
        harness.reset().await;

        let wallet = Pubkey::new_unique();
        let token_account = Pubkey::new_unique();
        let registry = WorkspaceRegistry::from_matches(vec![WorkspaceAddressMatch {
            workspace_id: Uuid::new_v4().to_string(),
            workspace_name: "Beta Ops".to_string(),
            workspace_address_id: Uuid::new_v4().to_string(),
            address: wallet.to_string(),
            address_kind: "payout_wallet".to_string(),
            label_names: vec!["payout".to_string()],
            object_mappings: vec![],
        }]);

        let worker = test_worker(registry);
        let mut state = WorkerState::default();
        state
            .last_seen_amounts
            .insert(token_account.to_string(), 200_000_000);

        worker
            .handle_update(
                make_usdc_account_update(
                    2,
                    "11111111111111111111111111111112",
                    token_account,
                    wallet,
                    125_000_000,
                    2,
                ),
                &mut state,
            )
            .await;
        worker.flush_transaction_event(&mut state).await;

        let events = harness
            .query_rows(
                "SELECT event_type, direction, amount_raw FROM usdc_ops.workspace_operational_events FORMAT JSONEachRow",
            )
            .await;
        assert_eq!(
            events[0]["event_type"],
            Value::String("workspace_outflow".to_string())
        );
        assert_eq!(events[0]["direction"], Value::String("outflow".to_string()));
        assert_eq!(events[0]["amount_raw"], Value::String("75000000".to_string()));
    }

    #[tokio::test]
    async fn worker_writes_mixed_event_when_both_sides_are_watched() {
        if !should_run_clickhouse_tests() {
            return;
        }

        let harness = ClickHouseHarness::new().await;
        harness.reset().await;

        let source_wallet = Pubkey::new_unique();
        let source_token_account = Pubkey::new_unique();
        let destination_wallet = Pubkey::new_unique();
        let destination_token_account = Pubkey::new_unique();
        let workspace_id = Uuid::new_v4().to_string();

        let registry = WorkspaceRegistry::from_matches(vec![
            WorkspaceAddressMatch {
                workspace_id: workspace_id.clone(),
                workspace_name: "Gamma Ops".to_string(),
                workspace_address_id: Uuid::new_v4().to_string(),
                address: source_wallet.to_string(),
                address_kind: "hot_wallet".to_string(),
                label_names: vec!["ops".to_string()],
                object_mappings: vec![],
            },
            WorkspaceAddressMatch {
                workspace_id: workspace_id.clone(),
                workspace_name: "Gamma Ops".to_string(),
                workspace_address_id: Uuid::new_v4().to_string(),
                address: destination_wallet.to_string(),
                address_kind: "treasury_wallet".to_string(),
                label_names: vec!["treasury".to_string()],
                object_mappings: vec![],
            },
        ]);

        let worker = test_worker(registry);
        let mut state = WorkerState::default();
        state
            .last_seen_amounts
            .insert(source_token_account.to_string(), 90_000_000);
        state
            .last_seen_amounts
            .insert(destination_token_account.to_string(), 10_000_000);

        let signature = "11111111111111111111111111111113";
        worker
            .handle_update(
                make_usdc_account_update(
                    3,
                    signature,
                    source_token_account,
                    source_wallet,
                    70_000_000,
                    3,
                ),
                &mut state,
            )
            .await;
        worker
            .handle_update(
                make_usdc_account_update(
                    3,
                    signature,
                    destination_token_account,
                    destination_wallet,
                    30_000_000,
                    4,
                ),
                &mut state,
            )
            .await;
        worker.flush_transaction_event(&mut state).await;

        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.raw_observations")
                .await,
            2
        );
        assert_eq!(
            harness
                .query_count("SELECT count() AS count FROM usdc_ops.workspace_event_participants")
                .await,
            2
        );

        let events = harness
            .query_rows(
                "SELECT event_type, direction, amount_raw, signature FROM usdc_ops.workspace_operational_events FORMAT JSONEachRow",
            )
            .await;
        assert_eq!(
            events[0]["event_type"],
            Value::String("workspace_mixed".to_string())
        );
        assert_eq!(events[0]["direction"], Value::String("mixed".to_string()));
        assert_eq!(events[0]["amount_raw"], Value::String("40000000".to_string()));
        assert_eq!(
            events[0]["signature"],
            Value::String(signature.to_string())
        );
    }

    fn should_run_clickhouse_tests() -> bool {
        std::env::var("RUN_CLICKHOUSE_TESTS")
            .map(|value| value == "1")
            .unwrap_or(false)
    }

    fn test_worker(registry: WorkspaceRegistry) -> YellowstoneWorker {
        YellowstoneWorker::new(
            "http://127.0.0.1:0".to_string(),
            None,
            ClickHouseWriter::new(
                std::env::var("CLICKHOUSE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8123".to_string()),
                "usdc_ops".to_string(),
                "default".to_string(),
                String::new(),
            ),
            WorkspaceRegistryCache::with_registry(registry),
        )
    }

    fn make_usdc_account_update(
        slot: u64,
        signature: &str,
        token_account_pubkey: Pubkey,
        wallet_owner: Pubkey,
        amount: u64,
        write_version: u64,
    ) -> SubscribeUpdate {
        let mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
            .expect("valid usdc mint");
        let mut data = vec![0_u8; SplAccount::LEN];
        SplAccount {
            mint,
            owner: wallet_owner,
            amount,
            delegate: COption::None,
            state: SplTokenAccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);

        SubscribeUpdate {
            filters: vec!["usdc_token_accounts".to_string()],
            update_oneof: Some(UpdateOneof::Account(SubscribeUpdateAccount {
                account: Some(SubscribeUpdateAccountInfo {
                    pubkey: token_account_pubkey.to_bytes().to_vec(),
                    lamports: 0,
                    owner: spl_token::id().to_bytes().to_vec(),
                    executable: false,
                    rent_epoch: 0,
                    data,
                    write_version,
                    txn_signature: Some(bs58::decode(signature).into_vec().unwrap()),
                }),
                slot,
                is_startup: false,
            })),
            created_at: None,
        }
    }

    struct ClickHouseHarness {
        client: Client,
        base_url: String,
    }

    impl ClickHouseHarness {
        async fn new() -> Self {
            Self {
                client: Client::new(),
                base_url: std::env::var("CLICKHOUSE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8123".to_string()),
            }
        }

        async fn reset(&self) {
            for table in [
                "workspace_reconciliation_rows",
                "workspace_operational_events",
                "workspace_event_participants",
                "workspace_event_links",
                "canonical_transaction_events",
                "canonical_account_mutations",
                "raw_observations",
            ] {
                self.execute(&format!("TRUNCATE TABLE usdc_ops.{}", table)).await;
            }
        }

        async fn query_count(&self, query: &str) -> u64 {
            let rows = self.query_rows(&format!("{} FORMAT JSONEachRow", strip_format(query))).await;
            rows[0]["count"]
                .as_u64()
                .or_else(|| rows[0]["count"].as_str().and_then(|value| value.parse().ok()))
                .expect("count should be numeric")
        }

        async fn query_rows(&self, query: &str) -> Vec<Value> {
            let response = self
                .client
                .post(format!(
                    "{}/?query={}",
                    self.base_url,
                    urlencoding::encode(query)
                ))
                .body("\n")
                .send()
                .await
                .expect("clickhouse query should execute")
                .error_for_status()
                .expect("clickhouse query should succeed")
                .text()
                .await
                .expect("clickhouse response should be text");

            response
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str::<Value>(line).expect("valid json each row"))
                .collect()
        }

        async fn execute(&self, query: &str) {
            self.client
                .post(format!(
                    "{}/?query={}",
                    self.base_url,
                    urlencoding::encode(query)
                ))
                .body("\n")
                .send()
                .await
                .expect("clickhouse execute should run")
                .error_for_status()
                .expect("clickhouse execute should succeed");
        }
    }

    fn strip_format(query: &str) -> &str {
        query.strip_suffix(" FORMAT JSONEachRow").unwrap_or(query)
    }
}

use crate::control_plane::{WorkspaceRegistry, WorkspaceRegistryCache, WorkspaceTransferRequestMatch};
use crate::storage::{
    ClickHouseWriter, ExceptionRow, MatcherEventRow, ObservedPaymentRow, ObservedTransferRow,
    ObservedTransactionRow, RawObservationRow, RequestBookSnapshotRow, SettlementMatchRow,
};
use crate::yellowstone::matcher::{allocate_observation, BookRequest, MatcherState, RequestFillState};
use crate::yellowstone::payment_reconstruction::reconstruct_observed_payments;
use crate::yellowstone::transaction_context::{build_transaction_context, TransactionContext};
use crate::yellowstone::transfer_reconstruction::reconstruct_observed_transfers;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use spl_token::solana_program::program_option::COption;
use spl_token::solana_program::program_pack::Pack;
use spl_token::state::{Account as SplTokenAccount, AccountState as SplTokenAccountState, Mint as SplTokenMint};
use std::collections::HashSet;
use uuid::Uuid;
use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
use yellowstone_grpc_proto::prelude::SubscribeUpdate;

pub mod client;
pub mod matcher;
pub mod payment_reconstruction;
pub mod subscriptions;
pub mod transaction_context;
pub mod transfer_reconstruction;

const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MATCH_WINDOW_BEFORE_REQUEST_SECONDS: i64 = 120;
const MATCH_WINDOW_AFTER_REQUEST_SECONDS: i64 = 24 * 60 * 60;

#[derive(Default)]
struct WorkerState {
    matcher_state: MatcherState,
}

pub struct YellowstoneWorker {
    endpoint: String,
    x_token: Option<String>,
    writer: ClickHouseWriter,
    registry_cache: tokio::sync::Mutex<WorkspaceRegistryCache>,
    debug_account_logs: bool,
}

impl YellowstoneWorker {
    pub fn new(
        endpoint: String,
        x_token: Option<String>,
        writer: ClickHouseWriter,
        registry_cache: WorkspaceRegistryCache,
        debug_account_logs: bool,
    ) -> Self {
        Self {
            endpoint,
            x_token,
            writer,
            registry_cache: tokio::sync::Mutex::new(registry_cache),
            debug_account_logs,
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
        if let Err(error) = hydrate_matcher_state(&self.writer, &mut worker_state).await {
            eprintln!("Failed to hydrate matcher state on startup: {}", error);
        }

        loop {
            match stream.next().await {
                Some(Ok(update)) => {
                    if let Err(error) = self.refresh_registry_if_stale().await {
                        let mut cache = self.registry_cache.lock().await;
                        if cache.should_log_refresh_error() {
                            eprintln!(
                                "Workspace registry refresh failed; continuing with last known cache: {}",
                                error
                            );
                        }
                    }
                    self.handle_update(update, &mut worker_state).await;
                }
                Some(Err(e)) => eprintln!("Stream error: {}", e),
                None => break,
            }
        }

        println!("Yellowstone Worker shutting down...");
    }

    async fn refresh_registry_if_stale(&self) -> Result<(), reqwest::Error> {
        let mut cache = self.registry_cache.lock().await;
        cache.refresh_if_stale().await
    }

    async fn handle_update(&self, update: SubscribeUpdate, worker_state: &mut WorkerState) {
        let filters = if update.filters.is_empty() {
            "-".to_string()
        } else {
            update.filters.join(",")
        };
        let update_time = update
            .created_at
            .as_ref()
            .and_then(timestamp_to_utc)
            .unwrap_or_else(Utc::now);

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

                    let raw_row = RawObservationRow {
                        observation_id: Uuid::new_v4().to_string(),
                        ingest_time: Utc::now(),
                        slot: account_update.slot,
                        signature: signature.clone(),
                        update_type: "account".to_string(),
                        pubkey: pubkey.clone(),
                        owner_program: Some(owner_program.clone()),
                        write_version: account.write_version,
                        raw_payload_json: json!({
                            "filters": update.filters,
                            "slot": account_update.slot,
                            "pubkey": pubkey,
                            "signature": signature,
                            "owner_program": owner_program,
                            "data_len": account.data.len(),
                            "write_version": account.write_version,
                        })
                        .to_string(),
                        raw_payload_bytes: Some(BASE64.encode(&account.data)),
                        parser_version: 1,
                    };

                    if let Err(error) = self.writer.insert_raw_observation(&raw_row).await {
                        eprintln!("Failed to insert raw observation: {}", error);
                    }

                    if self.debug_account_logs {
                        match filters.as_str() {
                            "usdc_token_accounts" => match SplTokenAccount::unpack(&account.data) {
                                Ok(token_account) => {
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
                                    pubkey, filters, owner_program, account.write_version, account.data.len()
                                );
                            }
                        }
                    }
                }
            }
            Some(UpdateOneof::Transaction(tx)) => {
                let signature = tx
                    .transaction
                    .as_ref()
                    .map(|tx| bs58::encode(&tx.signature).into_string())
                    .unwrap_or_else(|| "none".to_string());
                println!("TRANSACTION filters=[{}] slot={} signature={}", filters, tx.slot, signature);

                if let Some(context) = build_transaction_context(&tx, update_time) {
                    self.persist_transaction_context(context, worker_state).await;
                }
            }
            Some(UpdateOneof::Ping(_)) => println!("PING filters=[{}] keepalive", filters),
            Some(UpdateOneof::TransactionStatus(status)) => {
                println!(
                    "TRANSACTION_STATUS filters=[{}] slot={} signature={}",
                    filters,
                    status.slot,
                    bs58::encode(&status.signature).into_string(),
                );
            }
            Some(UpdateOneof::Slot(slot)) => {
                println!("SLOT filters=[{}] slot={} status={}", filters, slot.slot, slot.status);
            }
            Some(UpdateOneof::Block(block)) => {
                println!(
                    "BLOCK filters=[{}] slot={} txs={} accounts={}",
                    filters, block.slot, block.executed_transaction_count, block.updated_account_count
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
            Some(UpdateOneof::Pong(pong)) => println!("PONG filters=[{}] id={}", filters, pong.id),
            None => println!("UPDATE filters=[{}] empty", filters),
        }
    }

    async fn persist_transaction_context(
        &self,
        context: TransactionContext,
        worker_state: &mut WorkerState,
    ) {
        match self.writer.observed_transaction_exists(&context.signature).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => eprintln!(
                "Failed to check existing observed transaction {}: {}",
                context.signature, error
            ),
        }

        let mut registry_guard = self.registry_cache.lock().await;
        if let Err(error) = registry_guard.refresh_now().await {
            if registry_guard.should_log_refresh_error() {
                eprintln!(
                    "Failed to force refresh workspace registry before matching {}; continuing with stale cache: {}",
                    context.signature, error
                );
            }
        }
        self.materialize_observed_settlement(registry_guard.registry(), &context, worker_state)
            .await;
    }

    async fn materialize_observed_settlement(
        &self,
        registry: &WorkspaceRegistry,
        context: &TransactionContext,
        worker_state: &mut WorkerState,
    ) {
        let processing_time = Utc::now();
        let observed_transfers = reconstruct_observed_transfers(context);
        let observed_payments = reconstruct_observed_payments(context, &observed_transfers);

        let observed_transaction_row = ObservedTransactionRow {
            signature: context.signature.clone(),
            slot: context.slot,
            event_time: context.event_time,
            asset: "usdc".to_string(),
            finality_state: "processed".to_string(),
            status: "observed".to_string(),
            raw_mutation_count: context.raw_mutation_count,
            participant_count: context.participants.len() as u32,
            properties_json: Some(
                json!({
                    "participant_count": context.participants.len(),
                    "signers": context.signers,
                    "account_key_count": context.account_keys.len(),
                    "top_level_instruction_count": context.top_level_instruction_count,
                    "inner_instruction_set_count": context.inner_instruction_set_count,
                    "log_message_count": context.log_message_count,
                    "reconstruction_mode": "balance_delta_route_groups",
                })
                .to_string(),
            ),
        };

        if let Err(error) = self.writer.insert_observed_transaction(&observed_transaction_row).await {
            eprintln!("Failed to insert observed transaction: {}", error);
        }

        for transfer in &observed_transfers {
            let observed_transfer_id = Uuid::new_v4().to_string();

            let transfer_row = ObservedTransferRow {
                transfer_id: observed_transfer_id.clone(),
                signature: context.signature.clone(),
                slot: context.slot,
                event_time: context.event_time,
                asset: "usdc".to_string(),
                source_token_account: transfer.source_token_account.clone(),
                source_wallet: transfer.source_wallet.clone(),
                destination_token_account: transfer.destination_token_account.clone(),
                destination_wallet: transfer.destination_wallet.clone(),
                amount_raw: transfer.amount_raw,
                amount_decimal: format_amount(transfer.amount_raw),
                transfer_kind: "credit".to_string(),
                instruction_index: transfer.instruction_index,
                inner_instruction_index: transfer.inner_instruction_index,
                route_group: transfer.route_group.clone(),
                leg_role: transfer.leg_role.clone(),
                properties_json: transfer.properties_json.clone(),
            };

            if let Err(error) = self.writer.insert_observed_transfer(&transfer_row).await {
                eprintln!("Failed to insert observed transfer: {}", error);
            }

            let Some(destination_matches) =
                registry.matches_for_usdc_ata(&transfer.destination_token_account)
            else {
                continue;
            };

            let destination_workspaces: HashSet<String> = destination_matches
                .iter()
                .map(|matched| matched.workspace_id.clone())
                .collect();

            for workspace_id in &destination_workspaces {
                let pending_requests = registry
                    .pending_requests_for_destination_ata(workspace_id, &transfer.destination_token_account)
                    .unwrap_or(&[]);

                let windowed_requests: Vec<&WorkspaceTransferRequestMatch> = pending_requests
                    .iter()
                    .filter(|request| is_within_match_window(request.requested_at, context.event_time))
                    .collect();

                let book_requests: Vec<BookRequest<'_>> = windowed_requests
                    .iter()
                    .map(|request| {
                        let snapshot_state = worker_state
                            .matcher_state
                            .request_state(&request.transfer_request_id);
                        let remaining_amount_raw = if snapshot_state.remaining_amount_raw > 0 {
                            snapshot_state.remaining_amount_raw
                        } else {
                            request.amount_raw - snapshot_state.allocated_amount_raw
                        };

                        BookRequest {
                            request,
                            fill_state: RequestFillState {
                                allocated_amount_raw: snapshot_state.allocated_amount_raw,
                                remaining_amount_raw,
                                fill_count: snapshot_state.fill_count,
                                book_status: if snapshot_state.book_status.is_empty() {
                                    "open".to_string()
                                } else {
                                    snapshot_state.book_status
                                },
                                last_signature: snapshot_state.last_signature,
                            },
                        }
                    })
                    .collect();

                let allocation_result =
                    allocate_observation(transfer.amount_raw, context.event_time, &book_requests);
                let remaining_observation_raw = allocation_result.remaining_observation_raw;
                let eligible_request_count = allocation_result.eligible_request_count;

                let observation_event = MatcherEventRow {
                    event_id: Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    destination_address: transfer.destination_token_account.clone(),
                    transfer_request_id: None,
                    observed_transfer_id: Some(observed_transfer_id.clone()),
                    signature: Some(context.signature.clone()),
                    event_type: "observation_received".to_string(),
                    quantity_raw: transfer.amount_raw,
                    remaining_request_raw: None,
                    remaining_observation_raw: Some(remaining_observation_raw),
                    explanation: format!(
                        "Observed {} USDC credit to destination {}.",
                        format_amount(transfer.amount_raw),
                        transfer.destination_token_account
                    ),
                    event_time: context.event_time,
                    properties_json: Some(
                        json!({
                            "windowed_request_count": eligible_request_count,
                            "route_group": transfer.route_group,
                            "leg_role": transfer.leg_role,
                        })
                        .to_string(),
                    ),
                };

                if let Err(error) = self.writer.insert_matcher_event(&observation_event).await {
                    eprintln!("Failed to insert matcher event: {}", error);
                }

                for allocation in allocation_result.allocations {
                    let Some(request) = windowed_requests
                        .iter()
                        .find(|request| request.transfer_request_id == allocation.transfer_request_id)
                    else {
                        continue;
                    };

                    let snapshot_row = RequestBookSnapshotRow {
                        workspace_id: workspace_id.clone(),
                        destination_address: transfer.destination_token_account.clone(),
                        transfer_request_id: request.transfer_request_id.clone(),
                        requested_at: request.requested_at,
                        request_type: request.request_type.clone(),
                        requested_amount_raw: request.amount_raw,
                        allocated_amount_raw: allocation.allocated_total_raw,
                        remaining_amount_raw: allocation.remaining_request_raw,
                        fill_count: allocation.fill_count,
                        book_status: allocation.match_status.to_string(),
                        last_signature: Some(context.signature.clone()),
                        last_observed_transfer_id: Some(observed_transfer_id.clone()),
                        observed_event_time: Some(context.event_time),
                        updated_at: processing_time,
                    };

                    if let Err(error) = self.writer.upsert_request_book_snapshot(&snapshot_row).await {
                        eprintln!("Failed to upsert request book snapshot: {}", error);
                    }

                    worker_state.matcher_state.set_request_state(
                        request.transfer_request_id.clone(),
                        RequestFillState {
                            allocated_amount_raw: allocation.allocated_total_raw,
                            remaining_amount_raw: allocation.remaining_request_raw,
                            fill_count: allocation.fill_count,
                            book_status: allocation.match_status.to_string(),
                            last_signature: Some(context.signature.clone()),
                        },
                    );

                    let allocation_event = MatcherEventRow {
                        event_id: Uuid::new_v4().to_string(),
                        workspace_id: workspace_id.clone(),
                        destination_address: transfer.destination_token_account.clone(),
                        transfer_request_id: Some(request.transfer_request_id.clone()),
                        observed_transfer_id: Some(observed_transfer_id.clone()),
                        signature: Some(context.signature.clone()),
                        event_type: "allocation_applied".to_string(),
                        quantity_raw: allocation.allocated_now_raw,
                        remaining_request_raw: Some(allocation.remaining_request_raw),
                        remaining_observation_raw: Some(remaining_observation_raw),
                        explanation: format!(
                            "Allocated {} USDC from observed credit on {} to planned transfer {}.",
                            format_amount(allocation.allocated_now_raw),
                            transfer.destination_token_account,
                            request.transfer_request_id
                        ),
                        event_time: context.event_time,
                        properties_json: Some(
                            json!({
                                "allocated_total_raw": allocation.allocated_total_raw,
                                "fill_count": allocation.fill_count,
                                "match_status": allocation.match_status,
                                "route_group": transfer.route_group,
                                "leg_role": transfer.leg_role,
                            })
                            .to_string(),
                        ),
                    };

                    if let Err(error) = self.writer.insert_matcher_event(&allocation_event).await {
                        eprintln!("Failed to insert matcher allocation event: {}", error);
                    }

                    let settlement_match = SettlementMatchRow {
                        workspace_id: workspace_id.clone(),
                        transfer_request_id: request.transfer_request_id.clone(),
                        signature: Some(context.signature.clone()),
                        observed_transfer_id: Some(observed_transfer_id.clone()),
                        match_status: allocation.match_status.to_string(),
                        confidence_score: match allocation.match_status {
                            "matched_exact" => 100,
                            "matched_split" => 96,
                            "matched_partial" => 72,
                            _ => 50,
                        },
                        confidence_band: match allocation.match_status {
                            "matched_exact" => "exact".to_string(),
                            "matched_split" => "split".to_string(),
                            "matched_partial" => "partial".to_string(),
                            _ => "low".to_string(),
                        },
                        matched_amount_raw: allocation.allocated_total_raw,
                        amount_variance_raw: allocation.remaining_request_raw,
                        destination_match_type: "exact_destination".to_string(),
                        time_delta_seconds: allocation.time_delta_seconds,
                        match_rule: "destination_book_fifo_allocator".to_string(),
                        candidate_count: allocation.fill_count,
                        explanation: format!(
                            "Allocated total {} of requested {} USDC to destination {} using FIFO request-book matching.",
                            format_amount(allocation.allocated_total_raw),
                            format_amount(request.amount_raw),
                            transfer.destination_token_account,
                        ),
                        observed_event_time: Some(context.event_time),
                        matched_at: Some(processing_time),
                        updated_at: processing_time,
                    };

                    if let Err(error) = self.writer.upsert_settlement_match(&settlement_match).await {
                        eprintln!("Failed to upsert settlement match: {}", error);
                    }
                }

                if remaining_observation_raw > 0 {
                    let exception_row = ExceptionRow {
                        workspace_id: workspace_id.clone(),
                        exception_id: Uuid::new_v4().to_string(),
                        transfer_request_id: None,
                        signature: Some(context.signature.clone()),
                        observed_transfer_id: Some(observed_transfer_id.clone()),
                        exception_type: if eligible_request_count == 0 {
                            "unexpected_observation".to_string()
                        } else {
                            "unallocated_residual".to_string()
                        },
                        severity: "warning".to_string(),
                        status: "open".to_string(),
                        explanation: if eligible_request_count == 0 {
                            format!(
                                "Observed {} USDC credit to registered destination {} without any open request in the active window.",
                                format_amount(transfer.amount_raw),
                                transfer.destination_token_account
                            )
                        } else {
                            format!(
                                "Observed residual {} USDC on destination {} after FIFO allocation across {} open request(s).",
                                format_amount(remaining_observation_raw),
                                transfer.destination_token_account,
                                eligible_request_count
                            )
                        },
                        properties_json: Some(
                            json!({
                                "destination_address": transfer.destination_token_account,
                                "observed_amount_raw": transfer.amount_raw,
                                "remaining_observation_raw": remaining_observation_raw,
                                "eligible_request_count": eligible_request_count,
                                "route_group": transfer.route_group,
                                "leg_role": transfer.leg_role,
                            })
                            .to_string(),
                        ),
                        observed_event_time: Some(context.event_time),
                        processed_at: Some(processing_time),
                        created_at: processing_time,
                        updated_at: processing_time,
                    };

                    if let Err(error) = self.writer.upsert_exception(&exception_row).await {
                        eprintln!("Failed to insert residual exception: {}", error);
                    }
                }
            }
        }

        for payment in observed_payments {
            let payment_row = ObservedPaymentRow {
                payment_id: payment.payment_id,
                signature: payment.signature,
                slot: payment.slot,
                event_time: payment.event_time,
                asset: payment.asset,
                source_wallet: payment.source_wallet,
                destination_wallet: payment.destination_wallet,
                gross_amount_raw: payment.gross_amount_raw,
                gross_amount_decimal: format_amount(payment.gross_amount_raw),
                net_destination_amount_raw: payment.net_destination_amount_raw,
                net_destination_amount_decimal: format_amount(payment.net_destination_amount_raw),
                fee_amount_raw: payment.fee_amount_raw,
                fee_amount_decimal: format_amount(payment.fee_amount_raw),
                route_count: payment.route_count,
                payment_kind: payment.payment_kind,
                reconstruction_rule: payment.reconstruction_rule,
                confidence_band: payment.confidence_band,
                properties_json: payment.properties_json,
            };

            if let Err(error) = self.writer.insert_observed_payment(&payment_row).await {
                eprintln!("Failed to insert observed payment: {}", error);
            }
        }
    }

}

fn is_within_match_window(requested_at: DateTime<Utc>, observed_at: DateTime<Utc>) -> bool {
    let delta = observed_at.signed_duration_since(requested_at).num_seconds();
    (-MATCH_WINDOW_BEFORE_REQUEST_SECONDS..=MATCH_WINDOW_AFTER_REQUEST_SECONDS).contains(&delta)
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

fn parse_amount_raw(value: &str) -> i128 {
    value.parse::<i128>().unwrap_or_default()
}

async fn hydrate_matcher_state(
    writer: &ClickHouseWriter,
    worker_state: &mut WorkerState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let snapshots = writer.load_request_book_snapshots().await?;
    for snapshot in snapshots {
        worker_state.matcher_state.set_request_state(
            snapshot.transfer_request_id,
            RequestFillState {
                allocated_amount_raw: parse_amount_raw(&snapshot.allocated_amount_raw),
                remaining_amount_raw: parse_amount_raw(&snapshot.remaining_amount_raw),
                fill_count: snapshot.fill_count,
                book_status: snapshot.book_status,
                last_signature: snapshot.last_signature,
            },
        );
    }

    Ok(())
}

fn timestamp_to_utc(value: &yellowstone_grpc_proto::prost_types::Timestamp) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp(value.seconds, value.nanos as u32)
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
    use crate::control_plane::{
        WorkspaceAddressMatch, WorkspaceRegistry, WorkspaceRegistryCache, WorkspaceTransferRequestMatch,
    };
    use crate::storage::ClickHouseWriter;
    use reqwest::Client;
    use serde_json::Value;
    use spl_token::solana_program::program_option::COption;
    use spl_token::solana_program::pubkey::Pubkey;
    use spl_token::state::Account as SplAccount;
    use std::str::FromStr;
    use yellowstone_grpc_proto::geyser::{
        SubscribeUpdateAccount, SubscribeUpdateAccountInfo, SubscribeUpdateTransaction,
        SubscribeUpdateTransactionInfo,
    };
    use yellowstone_grpc_proto::prelude::{
        CompiledInstruction, InnerInstruction, InnerInstructions, Message, MessageHeader,
        TokenBalance, Transaction, TransactionStatusMeta, UiTokenAmount,
    };

    #[test]
    fn format_amount_renders_usdc_decimals() {
        assert_eq!(format_amount(1), "0.000001");
        assert_eq!(format_amount(12_345_678), "12.345678");
        assert_eq!(format_amount(-12_345_678), "-12.345678");
    }

    #[tokio::test]
    async fn worker_writes_raw_observed_and_exact_match_rows() {
        if !should_run_clickhouse_tests() {
            return;
        }

        let harness = ClickHouseHarness::new().await;
        harness.reset().await;

        let wallet = Pubkey::new_unique();
        let token_account = Pubkey::new_unique();
        let workspace_id = Uuid::new_v4().to_string();
        let transfer_request_id = Uuid::new_v4().to_string();

        let registry = WorkspaceRegistry::with_transfer_requests(
            vec![WorkspaceAddressMatch {
                workspace_id: workspace_id.clone(),
                workspace_address_id: Uuid::new_v4().to_string(),
                wallet_address: wallet.to_string(),
                usdc_ata_address: Some(token_account.to_string()),
            }],
            vec![WorkspaceTransferRequestMatch {
                transfer_request_id: transfer_request_id.clone(),
                workspace_id: workspace_id.clone(),
                destination_match_address: token_account.to_string(),
                amount_raw: 50_000_000,
                requested_at: Utc::now(),
                request_type: "wallet_transfer".to_string(),
            }],
        );

        let worker = test_worker(registry);
        let mut state = WorkerState::default();
        let signature = "11111111111111111111111111111111";

        worker
            .handle_update(
                make_usdc_account_update(1, signature, token_account, wallet, 150_000_000, 1),
                &mut state,
            )
            .await;
        worker
            .handle_update(
                make_usdc_transaction_update(
                    1,
                    signature,
                    vec![TokenBalanceDelta {
                        token_account,
                        wallet_owner: wallet,
                        amount_before_raw: 100_000_000,
                        amount_after_raw: 150_000_000,
                    }],
                ),
                &mut state,
            )
            .await;

        assert_eq!(
            harness
                .query_count(&format!(
                    "SELECT count() AS count FROM usdc_ops.raw_observations WHERE signature = '{}'",
                    signature
                ))
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count(&format!(
                    "SELECT count() AS count FROM usdc_ops.observed_transactions WHERE signature = '{}'",
                    signature
                ))
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count(&format!(
                    "SELECT count() AS count FROM usdc_ops.observed_transfers WHERE signature = '{}' AND destination_token_account = '{}'",
                    signature, token_account
                ))
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count(&format!(
                    "SELECT count() AS count FROM usdc_ops.observed_payments WHERE signature = '{}'",
                    signature
                ))
                .await,
            1
        );
        assert_eq!(
            harness
                .query_count(&format!(
                    "SELECT count() AS count FROM usdc_ops.settlement_matches FINAL WHERE transfer_request_id = '{}'",
                    transfer_request_id
                ))
                .await,
            1
        );
    }

    #[tokio::test]
    async fn worker_writes_unexpected_observation_exception_for_unmatched_destination_credit() {
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
            workspace_address_id: Uuid::new_v4().to_string(),
            wallet_address: wallet.to_string(),
            usdc_ata_address: Some(token_account.to_string()),
        }]);

        let worker = test_worker(registry);
        let mut state = WorkerState::default();

        worker
            .handle_update(
                make_usdc_transaction_update(
                    5,
                    "11111111111111111111111111111115",
                    vec![TokenBalanceDelta {
                        token_account,
                        wallet_owner: wallet,
                        amount_before_raw: 25_000_000,
                        amount_after_raw: 75_000_000,
                    }],
                ),
                &mut state,
            )
            .await;

        let exceptions = harness
            .query_rows(
                "SELECT exception_type, severity, status FROM usdc_ops.exceptions FINAL FORMAT JSONEachRow",
            )
            .await;
        assert_eq!(exceptions[0]["exception_type"], Value::String("unexpected_observation".to_string()));
        assert_eq!(exceptions[0]["severity"], Value::String("warning".to_string()));
        assert_eq!(exceptions[0]["status"], Value::String("open".to_string()));
    }

    #[tokio::test]
    async fn worker_allocates_partial_fill_and_then_split_fill() {
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
        let transfer_request_id = Uuid::new_v4().to_string();

        let registry = WorkspaceRegistry::with_transfer_requests(
            vec![WorkspaceAddressMatch {
                workspace_id: workspace_id.clone(),
                workspace_address_id: Uuid::new_v4().to_string(),
                wallet_address: destination_wallet.to_string(),
                usdc_ata_address: Some(destination_token_account.to_string()),
            }],
            vec![WorkspaceTransferRequestMatch {
                transfer_request_id: transfer_request_id.clone(),
                workspace_id: workspace_id.clone(),
                destination_match_address: destination_token_account.to_string(),
                amount_raw: 10_000,
                requested_at: Utc::now(),
                request_type: "wallet_transfer".to_string(),
            }],
        );

        let worker = test_worker(registry);
        let mut state = WorkerState::default();

        worker
            .handle_update(
                make_usdc_transaction_update(
                    8,
                    "11111111111111111111111111111118",
                    vec![
                        TokenBalanceDelta {
                            token_account: source_token_account,
                            wallet_owner: source_wallet,
                            amount_before_raw: 10_000,
                            amount_after_raw: 836,
                        },
                        TokenBalanceDelta {
                            token_account: destination_token_account,
                            wallet_owner: destination_wallet,
                            amount_before_raw: 0,
                            amount_after_raw: 9_164,
                        },
                    ],
                ),
                &mut state,
            )
            .await;

        worker
            .handle_update(
                make_usdc_transaction_update(
                    9,
                    "11111111111111111111111111111119",
                    vec![
                        TokenBalanceDelta {
                            token_account: source_token_account,
                            wallet_owner: source_wallet,
                            amount_before_raw: 836,
                            amount_after_raw: 0,
                        },
                        TokenBalanceDelta {
                            token_account: destination_token_account,
                            wallet_owner: destination_wallet,
                            amount_before_raw: 9_164,
                            amount_after_raw: 10_000,
                        },
                    ],
                ),
                &mut state,
            )
            .await;

        let matches = harness
            .query_rows(&format!(
                "SELECT match_status, matched_amount_raw, amount_variance_raw, candidate_count FROM usdc_ops.settlement_matches FINAL WHERE transfer_request_id = '{}' FORMAT JSONEachRow",
                transfer_request_id
            ))
            .await;
        assert_eq!(matches[0]["match_status"], Value::String("matched_split".to_string()));
        assert_eq!(matches[0]["matched_amount_raw"], Value::String("10000".to_string()));
        assert_eq!(matches[0]["amount_variance_raw"], Value::String("0".to_string()));
        assert_eq!(matches[0]["candidate_count"], Value::Number(2.into()));
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
            false,
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
        let mint = Pubkey::from_str(USDC_MINT).expect("valid usdc mint");
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

    #[derive(Clone, Copy)]
    struct TokenBalanceDelta {
        token_account: Pubkey,
        wallet_owner: Pubkey,
        amount_before_raw: u64,
        amount_after_raw: u64,
    }

    fn make_usdc_transaction_update(
        slot: u64,
        signature: &str,
        deltas: Vec<TokenBalanceDelta>,
    ) -> SubscribeUpdate {
        make_usdc_transaction_update_with_instructions(slot, signature, deltas, vec![], vec![])
    }

    fn make_usdc_transaction_update_with_instructions(
        slot: u64,
        signature: &str,
        deltas: Vec<TokenBalanceDelta>,
        instructions: Vec<CompiledInstruction>,
        inner_instructions: Vec<InnerInstructions>,
    ) -> SubscribeUpdate {
        let mint = Pubkey::from_str(USDC_MINT).expect("valid usdc mint");
        let signer = Pubkey::new_unique();

        let mut account_keys = vec![signer.to_bytes().to_vec()];
        let mut pre_token_balances = Vec::new();
        let mut post_token_balances = Vec::new();

        for (index, delta) in deltas.iter().enumerate() {
            let account_index = (index + 1) as u32;
            account_keys.push(delta.token_account.to_bytes().to_vec());

            pre_token_balances.push(TokenBalance {
                account_index,
                mint: mint.to_string(),
                ui_token_amount: Some(UiTokenAmount {
                    ui_amount: delta.amount_before_raw as f64 / 1_000_000.0,
                    decimals: 6,
                    amount: delta.amount_before_raw.to_string(),
                    ui_amount_string: format_amount(delta.amount_before_raw as i128),
                }),
                owner: delta.wallet_owner.to_string(),
                program_id: spl_token::id().to_string(),
            });

            post_token_balances.push(TokenBalance {
                account_index,
                mint: mint.to_string(),
                ui_token_amount: Some(UiTokenAmount {
                    ui_amount: delta.amount_after_raw as f64 / 1_000_000.0,
                    decimals: 6,
                    amount: delta.amount_after_raw.to_string(),
                    ui_amount_string: format_amount(delta.amount_after_raw as i128),
                }),
                owner: delta.wallet_owner.to_string(),
                program_id: spl_token::id().to_string(),
            });
        }

        account_keys.push(spl_token::id().to_bytes().to_vec());

        SubscribeUpdate {
            filters: vec!["usdc_token_transactions".to_string()],
            update_oneof: Some(UpdateOneof::Transaction(SubscribeUpdateTransaction {
                transaction: Some(SubscribeUpdateTransactionInfo {
                    signature: bs58::decode(signature).into_vec().unwrap(),
                    is_vote: false,
                    transaction: Some(Transaction {
                        signatures: vec![bs58::decode(signature).into_vec().unwrap()],
                        message: Some(Message {
                            header: Some(MessageHeader {
                                num_required_signatures: 1,
                                num_readonly_signed_accounts: 0,
                                num_readonly_unsigned_accounts: 0,
                            }),
                            account_keys,
                            recent_blockhash: vec![0; 32],
                            instructions,
                            versioned: false,
                            address_table_lookups: vec![],
                        }),
                    }),
                    meta: Some(TransactionStatusMeta {
                        pre_token_balances,
                        post_token_balances,
                        inner_instructions,
                        ..Default::default()
                    }),
                    index: 0,
                }),
                slot,
            })),
            created_at: None,
        }
    }

    #[tokio::test]
    async fn worker_populates_instruction_route_metadata_on_observed_transfers() {
        if !should_run_clickhouse_tests() {
            return;
        }

        let harness = ClickHouseHarness::new().await;
        harness.reset().await;

        let source_wallet = Pubkey::new_unique();
        let source_token_account = Pubkey::new_unique();
        let destination_wallet = Pubkey::new_unique();
        let destination_token_account = Pubkey::new_unique();

        let worker = test_worker(WorkspaceRegistry::default());
        let mut state = WorkerState::default();
        let signature = "1111111111111111111111111111111A";

        worker
            .handle_update(
                make_usdc_transaction_update_with_instructions(
                    12,
                    signature,
                    vec![
                        TokenBalanceDelta {
                            token_account: source_token_account,
                            wallet_owner: source_wallet,
                            amount_before_raw: 10_000,
                            amount_after_raw: 0,
                        },
                        TokenBalanceDelta {
                            token_account: destination_token_account,
                            wallet_owner: destination_wallet,
                            amount_before_raw: 0,
                            amount_after_raw: 10_000,
                        },
                    ],
                    vec![],
                    vec![InnerInstructions {
                        index: 0,
                        instructions: vec![InnerInstruction {
                            program_id_index: 3,
                            accounts: vec![1, 2, 0],
                            data: spl_token::instruction::TokenInstruction::Transfer {
                                amount: 10_000,
                            }
                            .pack(),
                            stack_height: Some(2),
                        }],
                    }],
                ),
                &mut state,
            )
            .await;

        let rows = harness
            .query_rows(&format!(
                "SELECT instruction_index, inner_instruction_index, route_group, leg_role, properties_json FROM usdc_ops.observed_transfers WHERE signature = '{}' FORMAT JSONEachRow",
                signature
            ))
            .await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["route_group"], Value::String(format!("{}:ix:0", signature)));
        assert_eq!(rows[0]["leg_role"], Value::String("direct_settlement".to_string()));

        let instruction_index = &rows[0]["instruction_index"];
        assert!(
            *instruction_index == Value::String("0".to_string())
                || *instruction_index == Value::Number(0.into())
        );
        let inner_instruction_index = &rows[0]["inner_instruction_index"];
        assert!(
            *inner_instruction_index == Value::String("0".to_string())
                || *inner_instruction_index == Value::Number(0.into())
        );
        assert!(
            rows[0]["properties_json"]
                .as_str()
                .map(|value| value.contains("instruction_transfer"))
                .unwrap_or(false)
        );
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
                "exceptions",
                "settlement_matches",
                "request_book_snapshots",
                "matcher_events",
                "observed_payments",
                "observed_transfers",
                "observed_transactions",
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
                .post(format!("{}/?query={}", self.base_url, urlencoding::encode(query)))
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
                .post(format!("{}/?query={}", self.base_url, urlencoding::encode(query)))
                .body("\n")
                .send()
                .await
                .expect("clickhouse execute should run")
                .error_for_status()
                .expect("clickhouse execute should succeed");
        }
    }

    fn strip_format(query: &str) -> &str {
        query.split(" FORMAT ").next().unwrap_or(query)
    }
}

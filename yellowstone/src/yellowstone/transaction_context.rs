use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction;

const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

#[derive(Clone, Debug)]
pub struct TokenBalanceChange {
    pub token_account: String,
    pub wallet_owner: String,
    pub amount_before_raw: i128,
    pub amount_after_raw: i128,
    pub delta_raw: i128,
}

#[derive(Clone, Debug)]
pub struct InstructionContext {
    pub instruction_index: u32,
    pub inner_instruction_index: Option<u32>,
    pub program_id: String,
    pub account_indices: Vec<u32>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct TransactionContext {
    pub signature: String,
    pub slot: u64,
    pub event_time: DateTime<Utc>,
    pub raw_mutation_count: u32,
    pub participants: HashSet<String>,
    pub signers: Vec<String>,
    pub account_keys: Vec<String>,
    pub instruction_contexts: Vec<InstructionContext>,
    pub top_level_instruction_count: u32,
    pub inner_instruction_set_count: u32,
    pub log_message_count: u32,
    pub usdc_balance_changes: Vec<TokenBalanceChange>,
}

#[derive(Default)]
struct TokenBalanceSnapshot {
    token_account: Option<String>,
    wallet_owner: Option<String>,
    amount_before_raw: i128,
    amount_after_raw: i128,
}

pub fn build_transaction_context(
    tx_update: &SubscribeUpdateTransaction,
    event_time: DateTime<Utc>,
) -> Option<TransactionContext> {
    let info = tx_update.transaction.as_ref()?;
    let meta = info.meta.as_ref()?;
    let transaction = info.transaction.as_ref()?;
    let message = transaction.message.as_ref()?;
    let signature = bs58::encode(&info.signature).into_string();

    let mut account_keys: Vec<String> = message
        .account_keys
        .iter()
        .map(|key| bs58::encode(key).into_string())
        .collect();
    account_keys.extend(
        meta.loaded_writable_addresses
            .iter()
            .map(|key| bs58::encode(key).into_string()),
    );
    account_keys.extend(
        meta.loaded_readonly_addresses
            .iter()
            .map(|key| bs58::encode(key).into_string()),
    );

    let signer_count = message
        .header
        .as_ref()
        .map(|header| header.num_required_signatures as usize)
        .unwrap_or_default()
        .min(account_keys.len());
    let signers = account_keys.iter().take(signer_count).cloned().collect::<Vec<_>>();

    let mut instruction_contexts = Vec::new();
    for (instruction_index, instruction) in message.instructions.iter().enumerate() {
        let program_id = account_keys
            .get(instruction.program_id_index as usize)
            .cloned()
            .unwrap_or_default();
        instruction_contexts.push(InstructionContext {
            instruction_index: instruction_index as u32,
            inner_instruction_index: None,
            program_id,
            account_indices: instruction.accounts.iter().map(|value| *value as u32).collect(),
            data: instruction.data.clone(),
        });
    }

    for inner_set in &meta.inner_instructions {
        for (inner_instruction_index, instruction) in inner_set.instructions.iter().enumerate() {
            let program_id = account_keys
                .get(instruction.program_id_index as usize)
                .cloned()
                .unwrap_or_default();
            instruction_contexts.push(InstructionContext {
                instruction_index: inner_set.index,
                inner_instruction_index: Some(inner_instruction_index as u32),
                program_id,
                account_indices: instruction.accounts.iter().map(|value| *value as u32).collect(),
                data: instruction.data.clone(),
            });
        }
    }

    let mut snapshots: HashMap<u32, TokenBalanceSnapshot> = HashMap::new();

    for balance in &meta.pre_token_balances {
        if balance.mint != USDC_MINT {
            continue;
        }

        let snapshot = snapshots.entry(balance.account_index).or_default();
        snapshot.token_account = account_keys.get(balance.account_index as usize).cloned();
        snapshot.wallet_owner = if balance.owner.is_empty() {
            snapshot.wallet_owner.clone()
        } else {
            Some(balance.owner.clone())
        };
        snapshot.amount_before_raw = balance
            .ui_token_amount
            .as_ref()
            .map(|value| parse_amount_raw(&value.amount))
            .unwrap_or_default();
    }

    for balance in &meta.post_token_balances {
        if balance.mint != USDC_MINT {
            continue;
        }

        let snapshot = snapshots.entry(balance.account_index).or_default();
        snapshot.token_account = account_keys.get(balance.account_index as usize).cloned();
        snapshot.wallet_owner = if balance.owner.is_empty() {
            snapshot.wallet_owner.clone()
        } else {
            Some(balance.owner.clone())
        };
        snapshot.amount_after_raw = balance
            .ui_token_amount
            .as_ref()
            .map(|value| parse_amount_raw(&value.amount))
            .unwrap_or_default();
    }

    let mut participants = HashSet::new();
    let mut usdc_balance_changes = Vec::new();

    for snapshot in snapshots.into_values() {
        let Some(token_account) = snapshot.token_account else {
            continue;
        };
        let Some(wallet_owner) = snapshot.wallet_owner else {
            continue;
        };

        let delta_raw = snapshot.amount_after_raw - snapshot.amount_before_raw;
        if delta_raw == 0 {
            continue;
        }

        participants.insert(token_account.clone());
        participants.insert(wallet_owner.clone());
        usdc_balance_changes.push(TokenBalanceChange {
            token_account,
            wallet_owner,
            amount_before_raw: snapshot.amount_before_raw,
            amount_after_raw: snapshot.amount_after_raw,
            delta_raw,
        });
    }

    if usdc_balance_changes.is_empty() {
        return None;
    }

    Some(TransactionContext {
        signature,
        slot: tx_update.slot,
        event_time,
        raw_mutation_count: usdc_balance_changes.len() as u32,
        participants,
        signers,
        account_keys,
        instruction_contexts,
        top_level_instruction_count: message.instructions.len() as u32,
        inner_instruction_set_count: meta.inner_instructions.len() as u32,
        log_message_count: meta.log_messages.len() as u32,
        usdc_balance_changes,
    })
}

fn parse_amount_raw(value: &str) -> i128 {
    value.parse::<i128>().unwrap_or_default()
}

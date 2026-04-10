use crate::yellowstone::transaction_context::{InstructionContext, TokenBalanceChange, TransactionContext};
use spl_token::instruction::TokenInstruction;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct ObservedTransfer {
    pub source_token_account: Option<String>,
    pub source_wallet: Option<String>,
    pub destination_token_account: String,
    pub destination_wallet: Option<String>,
    pub amount_raw: i128,
    pub instruction_index: Option<u32>,
    pub inner_instruction_index: Option<u32>,
    pub route_group: String,
    pub leg_role: String,
    pub properties_json: Option<String>,
}

#[derive(Clone)]
struct DebitState {
    token_account: String,
    wallet_owner: String,
    remaining_raw: i128,
}

pub fn reconstruct_observed_transfers(context: &TransactionContext) -> Vec<ObservedTransfer> {
    let instruction_transfers = reconstruct_from_instructions(context);
    if !instruction_transfers.is_empty() {
        let mut transfers = instruction_transfers;
        classify_leg_roles(&mut transfers);
        return transfers;
    }

    let mut transfers = reconstruct_from_balance_deltas(context);
    classify_leg_roles(&mut transfers);
    transfers
}

fn reconstruct_from_instructions(context: &TransactionContext) -> Vec<ObservedTransfer> {
    let change_by_token_account = context
        .usdc_balance_changes
        .iter()
        .map(|change| (change.token_account.clone(), change))
        .collect::<HashMap<_, _>>();

    let mut transfers = Vec::new();
    for instruction in &context.instruction_contexts {
        if !is_spl_token_program(&instruction.program_id) {
            continue;
        }

        let Ok(token_instruction) = TokenInstruction::unpack(&instruction.data) else {
            continue;
        };

        match token_instruction {
            TokenInstruction::Transfer { amount } => {
                if let Some(transfer) =
                    build_transfer_from_instruction(context, instruction, amount as i128, false, &change_by_token_account)
                {
                    transfers.push(transfer);
                }
            }
            TokenInstruction::TransferChecked { amount, .. } => {
                if let Some(transfer) =
                    build_transfer_from_instruction(context, instruction, amount as i128, true, &change_by_token_account)
                {
                    transfers.push(transfer);
                }
            }
            _ => {}
        }
    }

    transfers
}

fn build_transfer_from_instruction(
    context: &TransactionContext,
    instruction: &InstructionContext,
    amount_raw: i128,
    is_transfer_checked: bool,
    change_by_token_account: &HashMap<String, &TokenBalanceChange>,
) -> Option<ObservedTransfer> {
    let minimum_accounts = if is_transfer_checked { 3 } else { 2 };
    if instruction.account_indices.len() < minimum_accounts {
        return None;
    }

    let source_account_index = 0usize;
    let destination_account_index = if is_transfer_checked { 2usize } else { 1usize };
    let source_token_account = context
        .account_keys
        .get(*instruction.account_indices.get(source_account_index)? as usize)?
        .clone();
    let destination_token_account = context
        .account_keys
        .get(*instruction.account_indices.get(destination_account_index)? as usize)?
        .clone();

    let source_wallet = change_by_token_account
        .get(&source_token_account)
        .map(|change| change.wallet_owner.clone());
    let destination_change = change_by_token_account.get(&destination_token_account).copied();
    let destination_wallet = destination_change.map(|change| change.wallet_owner.clone());

    Some(ObservedTransfer {
        source_token_account: Some(source_token_account.clone()),
        source_wallet,
        destination_token_account: destination_token_account.clone(),
        destination_wallet,
        amount_raw,
        instruction_index: Some(instruction.instruction_index),
        inner_instruction_index: instruction.inner_instruction_index,
        route_group: format!("{}:ix:{}", context.signature, instruction.instruction_index),
        leg_role: "unknown".to_string(),
        properties_json: Some(
            serde_json::json!({
                "reconstruction_source": "instruction_transfer",
                "instruction_kind": if is_transfer_checked { "transfer_checked" } else { "transfer" },
                "program_id": instruction.program_id,
                "source_account": source_token_account,
                "destination_account": destination_token_account,
                "destination_amount_before_raw": destination_change.map(|change| change.amount_before_raw),
                "destination_amount_after_raw": destination_change.map(|change| change.amount_after_raw),
            })
            .to_string(),
        ),
    })
}

fn reconstruct_from_balance_deltas(context: &TransactionContext) -> Vec<ObservedTransfer> {
    let mut debits: Vec<DebitState> = context
        .usdc_balance_changes
        .iter()
        .filter(|change| change.delta_raw < 0)
        .map(|change| DebitState {
            token_account: change.token_account.clone(),
            wallet_owner: change.wallet_owner.clone(),
            remaining_raw: change.delta_raw.abs(),
        })
        .collect();

    debits.sort_by(|left, right| {
        right
            .remaining_raw
            .cmp(&left.remaining_raw)
            .then_with(|| left.token_account.cmp(&right.token_account))
    });

    let mut transfers = Vec::new();
    let credits: Vec<&TokenBalanceChange> = context
        .usdc_balance_changes
        .iter()
        .filter(|change| change.delta_raw > 0)
        .collect();

    for credit in credits {
        let mut remaining_credit = credit.delta_raw;

        for debit in &mut debits {
            if remaining_credit <= 0 {
                break;
            }
            if debit.remaining_raw <= 0 {
                continue;
            }

            let allocated_raw = remaining_credit.min(debit.remaining_raw);
            if allocated_raw <= 0 {
                continue;
            }

            let route_group = format!("{}:{}", context.signature, debit.token_account);
            transfers.push(ObservedTransfer {
                source_token_account: Some(debit.token_account.clone()),
                source_wallet: Some(debit.wallet_owner.clone()),
                destination_token_account: credit.token_account.clone(),
                destination_wallet: Some(credit.wallet_owner.clone()),
                amount_raw: allocated_raw,
                instruction_index: None,
                inner_instruction_index: None,
                route_group,
                leg_role: "unknown".to_string(),
                properties_json: Some(
                    serde_json::json!({
                        "reconstruction_source": "balance_deltas",
                        "credit_amount_before_raw": credit.amount_before_raw,
                        "credit_amount_after_raw": credit.amount_after_raw,
                    })
                    .to_string(),
                ),
            });

            debit.remaining_raw -= allocated_raw;
            remaining_credit -= allocated_raw;
        }

        if remaining_credit > 0 {
            transfers.push(ObservedTransfer {
                source_token_account: None,
                source_wallet: None,
                destination_token_account: credit.token_account.clone(),
                destination_wallet: Some(credit.wallet_owner.clone()),
                amount_raw: remaining_credit,
                instruction_index: None,
                inner_instruction_index: None,
                route_group: format!("{}:unattributed:{}", context.signature, credit.token_account),
                leg_role: "unknown".to_string(),
                properties_json: Some(
                    serde_json::json!({
                        "reconstruction_source": "balance_deltas_unattributed",
                        "credit_amount_before_raw": credit.amount_before_raw,
                        "credit_amount_after_raw": credit.amount_after_raw,
                    })
                    .to_string(),
                ),
            });
        }
    }

    transfers
}

fn is_spl_token_program(program_id: &str) -> bool {
    program_id == spl_token::id().to_string()
}

fn classify_leg_roles(transfers: &mut [ObservedTransfer]) {
    let mut totals_by_group_destination: HashMap<(String, String), i128> = HashMap::new();
    let mut dominant_destination_by_group: HashMap<String, String> = HashMap::new();
    let mut max_amount_by_group: HashMap<String, i128> = HashMap::new();

    for transfer in transfers.iter() {
        let destination_key = transfer
            .destination_wallet
            .clone()
            .unwrap_or_else(|| transfer.destination_token_account.clone());
        *totals_by_group_destination
            .entry((transfer.route_group.clone(), destination_key))
            .or_default() += transfer.amount_raw;
    }

    for ((group, destination), amount) in totals_by_group_destination {
        let current_max = max_amount_by_group.get(&group).copied().unwrap_or_default();
        if amount > current_max {
            max_amount_by_group.insert(group.clone(), amount);
            dominant_destination_by_group.insert(group, destination);
        }
    }

    for transfer in transfers.iter_mut() {
        if transfer.source_wallet.is_some() && transfer.source_wallet == transfer.destination_wallet {
            transfer.leg_role = "self_change".to_string();
            continue;
        }

        let dominant_destination = dominant_destination_by_group.get(&transfer.route_group);
        let destination_key = transfer
            .destination_wallet
            .clone()
            .unwrap_or_else(|| transfer.destination_token_account.clone());

        transfer.leg_role = match dominant_destination {
            Some(dominant) if dominant == &destination_key => "direct_settlement".to_string(),
            Some(_) => "other_destination".to_string(),
            None => "unknown".to_string(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_leg_roles, ObservedTransfer};

    fn make_transfer(
        route_group: &str,
        destination_wallet: Option<&str>,
        destination_token_account: &str,
        amount_raw: i128,
    ) -> ObservedTransfer {
        ObservedTransfer {
            source_token_account: Some("source-token".to_string()),
            source_wallet: Some("source-wallet".to_string()),
            destination_token_account: destination_token_account.to_string(),
            destination_wallet: destination_wallet.map(str::to_string),
            amount_raw,
            instruction_index: Some(1),
            inner_instruction_index: None,
            route_group: route_group.to_string(),
            leg_role: "unknown".to_string(),
            properties_json: None,
        }
    }

    #[test]
    fn classify_leg_roles_keeps_non_dominant_routes_neutral() {
        let mut transfers = vec![
            make_transfer("sig:ix:1", Some("expected-wallet"), "expected-ata", 9_500),
            make_transfer("sig:ix:1", Some("aggregator-wallet"), "aggregator-ata", 500),
        ];

        classify_leg_roles(&mut transfers);

        assert_eq!(transfers[0].leg_role, "direct_settlement");
        assert_eq!(transfers[1].leg_role, "other_destination");
    }
}

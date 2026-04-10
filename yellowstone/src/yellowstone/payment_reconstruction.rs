use crate::yellowstone::transfer_reconstruction::ObservedTransfer;
use crate::yellowstone::transaction_context::TransactionContext;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct ObservedPayment {
    pub payment_id: String,
    pub route_group: String,
    pub signature: String,
    pub slot: u64,
    pub event_time: chrono::DateTime<chrono::Utc>,
    pub asset: String,
    pub source_wallet: Option<String>,
    pub destination_wallet: Option<String>,
    pub gross_amount_raw: i128,
    pub net_destination_amount_raw: i128,
    pub fee_amount_raw: i128,
    pub route_count: u32,
    pub payment_kind: String,
    pub reconstruction_rule: String,
    pub confidence_band: String,
    pub properties_json: Option<String>,
}

pub fn reconstruct_observed_payments(
    context: &TransactionContext,
    transfers: &[ObservedTransfer],
) -> Vec<ObservedPayment> {
    let mut groups: HashMap<String, Vec<&ObservedTransfer>> = HashMap::new();

    for transfer in transfers {
        groups
            .entry(transfer.route_group.clone())
            .or_default()
            .push(transfer);
    }

    let mut payments = Vec::new();

    for (route_group, grouped_transfers) in groups {
        if grouped_transfers.is_empty() {
            continue;
        }

        let source_wallet = grouped_transfers
            .iter()
            .find_map(|transfer| transfer.source_wallet.clone());

        let mut destination_totals: HashMap<String, i128> = HashMap::new();
        for transfer in &grouped_transfers {
            let destination_key = transfer
                .destination_wallet
                .clone()
                .unwrap_or_else(|| transfer.destination_token_account.clone());
            *destination_totals.entry(destination_key).or_default() += transfer.amount_raw;
        }

        let mut destination_entries = destination_totals.into_iter().collect::<Vec<_>>();
        destination_entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

        let destination_wallet = destination_entries.first().map(|entry| entry.0.clone());
        let net_destination_amount_raw = destination_entries.first().map(|entry| entry.1).unwrap_or_default();
        let gross_amount_raw = grouped_transfers.iter().map(|transfer| transfer.amount_raw).sum::<i128>();
        let fee_amount_raw = gross_amount_raw - net_destination_amount_raw;
        let distinct_destinations = destination_entries.len() as u32;
        let route_count = grouped_transfers.len() as u32;

        let payment_kind = if route_count == 1 {
            "direct".to_string()
        } else if distinct_destinations == 1 {
            "multi_leg_settlement".to_string()
        } else {
            "multi_destination_route".to_string()
        };

        let confidence_band = if grouped_transfers.iter().all(|transfer| transfer.source_wallet.is_some()) {
            "high".to_string()
        } else {
            "medium".to_string()
        };

        payments.push(ObservedPayment {
            payment_id: Uuid::new_v4().to_string(),
            route_group: route_group.clone(),
            signature: context.signature.clone(),
            slot: context.slot,
            event_time: context.event_time,
            asset: "usdc".to_string(),
            source_wallet,
            destination_wallet,
            gross_amount_raw,
            net_destination_amount_raw,
            fee_amount_raw,
            route_count,
            payment_kind,
            reconstruction_rule: "route_group_balance_bundle".to_string(),
            confidence_band,
            properties_json: Some(
                serde_json::json!({
                    "route_group": route_group,
                    "transfer_count": grouped_transfers.len(),
                    "destinations": destination_entries
                        .iter()
                        .map(|(wallet, amount_raw)| serde_json::json!({
                            "wallet": wallet,
                            "amount_raw": amount_raw.to_string(),
                        }))
                        .collect::<Vec<_>>(),
                    "transfer_legs": grouped_transfers
                        .iter()
                        .map(|transfer| serde_json::json!({
                            "source_wallet": transfer.source_wallet,
                            "source_token_account": transfer.source_token_account,
                            "destination_wallet": transfer.destination_wallet,
                            "destination_token_account": transfer.destination_token_account,
                            "amount_raw": transfer.amount_raw.to_string(),
                            "leg_role": transfer.leg_role,
                        }))
                        .collect::<Vec<_>>(),
                })
                .to_string(),
            ),
        });
    }

    payments.sort_by(|left, right| {
        left.source_wallet
            .cmp(&right.source_wallet)
            .then_with(|| left.destination_wallet.cmp(&right.destination_wallet))
    });
    payments
}

#[cfg(test)]
mod tests {
    use super::reconstruct_observed_payments;
    use crate::yellowstone::transaction_context::TransactionContext;
    use crate::yellowstone::transfer_reconstruction::ObservedTransfer;
    use chrono::Utc;
    use std::collections::HashSet;

    #[test]
    fn reconstruct_observed_payments_uses_neutral_multi_destination_kind() {
        let context = TransactionContext {
            signature: "sig".to_string(),
            slot: 1,
            event_time: Utc::now(),
            raw_mutation_count: 2,
            participants: HashSet::new(),
            signers: Vec::new(),
            account_keys: Vec::new(),
            instruction_contexts: Vec::new(),
            top_level_instruction_count: 0,
            inner_instruction_set_count: 0,
            log_message_count: 0,
            usdc_balance_changes: Vec::new(),
        };

        let transfers = vec![
            ObservedTransfer {
                source_token_account: Some("src-ata".to_string()),
                source_wallet: Some("src-wallet".to_string()),
                destination_token_account: "expected-ata".to_string(),
                destination_wallet: Some("expected-wallet".to_string()),
                amount_raw: 9_500,
                instruction_index: Some(1),
                inner_instruction_index: None,
                route_group: "sig:ix:1".to_string(),
                leg_role: "direct_settlement".to_string(),
                properties_json: None,
            },
            ObservedTransfer {
                source_token_account: Some("src-ata".to_string()),
                source_wallet: Some("src-wallet".to_string()),
                destination_token_account: "other-ata".to_string(),
                destination_wallet: Some("other-wallet".to_string()),
                amount_raw: 500,
                instruction_index: Some(1),
                inner_instruction_index: Some(0),
                route_group: "sig:ix:1".to_string(),
                leg_role: "other_destination".to_string(),
                properties_json: None,
            },
        ];

        let payments = reconstruct_observed_payments(&context, &transfers);
        assert_eq!(payments.len(), 1);
        assert_eq!(payments[0].payment_kind, "multi_destination_route");
        assert_eq!(payments[0].fee_amount_raw, 500);
    }
}

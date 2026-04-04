use std::collections::HashMap;
use yellowstone_grpc_proto::geyser::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterAccounts,
    SubscribeRequestFilterAccountsFilter, SubscribeRequestFilterAccountsFilterMemcmp,
    SubscribeRequestFilterTransactions,
    subscribe_request_filter_accounts_filter::Filter as AccountFilter,
    subscribe_request_filter_accounts_filter_memcmp::Data as MemcmpData,
};

const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_ACCOUNT_SIZE: u64 = 165;

pub fn create_subscription_request() -> SubscribeRequest {
    let mut accounts = HashMap::new();
    let mut transactions = HashMap::new();
    accounts.insert(
        "usdc_token_accounts".to_string(),
        SubscribeRequestFilterAccounts {
            account: vec![],
            owner: vec![SPL_TOKEN_PROGRAM_ID.to_string()],
            filters: vec![
                SubscribeRequestFilterAccountsFilter {
                    filter: Some(AccountFilter::Datasize(SPL_TOKEN_ACCOUNT_SIZE)),
                },
                SubscribeRequestFilterAccountsFilter {
                    filter: Some(AccountFilter::TokenAccountState(true)),
                },
                SubscribeRequestFilterAccountsFilter {
                    filter: Some(AccountFilter::Memcmp(
                        SubscribeRequestFilterAccountsFilterMemcmp {
                            offset: 0,
                            data: Some(MemcmpData::Base58(USDC_MINT.to_string())),
                        },
                    )),
                },
            ],
            nonempty_txn_signature: None,
        },
    );

    accounts.insert(
        "usdc_mint".to_string(),
        SubscribeRequestFilterAccounts {
            account: vec![USDC_MINT.to_string()],
            owner: vec![SPL_TOKEN_PROGRAM_ID.to_string()],
            filters: vec![],
            nonempty_txn_signature: None,
        },
    );

    transactions.insert(
        "usdc_token_transactions".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            signature: None,
            account_include: vec![],
            account_exclude: vec![],
            account_required: vec![USDC_MINT.to_string(), SPL_TOKEN_PROGRAM_ID.to_string()],
        },
    );

    SubscribeRequest {
        accounts,
        slots: HashMap::new(),
        transactions,
        transactions_status: HashMap::new(),
        blocks: HashMap::new(),
        blocks_meta: HashMap::new(),
        entry: HashMap::new(),
        commitment: Some(CommitmentLevel::Confirmed as i32),
        accounts_data_slice: vec![],
        ping: None,
        from_slot: None,
    }
}

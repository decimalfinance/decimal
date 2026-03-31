use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Serialize, Serializer};

pub struct ClickHouseWriter {
    client: Client,
    base_url: String,
    database: String,
    user: String,
    password: String,
}

impl ClickHouseWriter {
    pub fn new(base_url: String, database: String, user: String, password: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
            database,
            user,
            password,
        }
    }

    pub async fn insert_raw_observation(
        &self,
        row: &RawObservationRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("raw_observations", row).await
    }

    pub async fn insert_canonical_account_mutation(
        &self,
        row: &CanonicalAccountMutationRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("canonical_account_mutations", row)
            .await
    }

    pub async fn insert_canonical_transaction_event(
        &self,
        row: &CanonicalTransactionEventRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("canonical_transaction_events", row)
            .await
    }

    async fn insert_json_each_row<T: Serialize>(
        &self,
        table: &str,
        row: &T,
    ) -> Result<(), reqwest::Error> {
        let query = format!("INSERT INTO {}.{} FORMAT JSONEachRow", self.database, table);
        let url = format!("{}/?query={}", self.base_url, urlencoding::encode(&query));
        let payload = format!(
            "{}\n",
            serde_json::to_string(row).expect("row should serialize to JSON")
        );

        self.client
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            .body(payload)
            .send()
            .await?
            .error_for_status()?;

        Ok(())
    }
}

#[derive(Serialize)]
pub struct RawObservationRow {
    pub observation_id: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub ingest_time: DateTime<Utc>,
    pub slot: u64,
    pub signature: String,
    pub update_type: String,
    pub pubkey: String,
    pub owner_program: Option<String>,
    pub write_version: u64,
    pub raw_payload_json: String,
    pub raw_payload_bytes: Option<String>,
    pub parser_version: u32,
}

#[derive(Serialize)]
pub struct CanonicalAccountMutationRow {
    pub mutation_id: String,
    pub slot: u64,
    pub signature: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub mint: String,
    pub token_account: String,
    pub wallet_owner: Option<String>,
    pub amount_before_raw: i128,
    pub amount_after_raw: i128,
    pub delta_raw: i128,
    pub decimals: u8,
    pub mutation_kind: String,
    pub canonical_version: u32,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct CanonicalTransactionEventRow {
    pub canonical_event_id: String,
    pub slot: u64,
    pub signature: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub chain: String,
    pub canonical_version: u32,
    pub raw_mutation_count: u32,
    pub participant_count: u32,
    pub event_summary_json: Option<String>,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct WorkspaceEventLinkRow {
    pub workspace_id: String,
    pub canonical_event_id: String,
    pub link_reason: String,
    pub matched_address_count: u32,
    pub matched_object_count: u32,
}

#[derive(Serialize)]
pub struct WorkspaceEventParticipantRow {
    pub workspace_id: String,
    pub canonical_event_id: String,
    pub participant_id: String,
    pub role: String,
    pub address: String,
    pub workspace_address_id: Option<String>,
    pub workspace_object_id: Option<String>,
    pub global_entity_id: Option<String>,
    pub direction: String,
    pub amount_raw: i128,
    pub confidence: f32,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct WorkspaceOperationalEventRow {
    pub workspace_id: String,
    pub workspace_event_id: String,
    pub canonical_event_id: String,
    pub slot: u64,
    pub signature: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub event_type: String,
    pub direction: String,
    pub amount_raw: i128,
    pub amount_decimal: String,
    pub primary_object_id: Option<String>,
    pub counterparty_object_id: Option<String>,
    pub primary_label: Option<String>,
    pub counterparty_label: Option<String>,
    pub confidence: f32,
    pub is_actionable: u8,
    pub summary_text: String,
    pub properties_json: Option<String>,
    pub model_version: u32,
}

#[derive(Serialize)]
pub struct WorkspaceReconciliationRow {
    pub workspace_id: String,
    pub reconciliation_row_id: String,
    pub workspace_event_id: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub amount_raw: i128,
    pub amount_decimal: String,
    pub direction: String,
    pub internal_object_key: Option<String>,
    pub counterparty_name: Option<String>,
    pub event_type: String,
    pub signature: String,
    pub token_account: Option<String>,
    pub notes: Option<String>,
    pub export_status: String,
}

impl ClickHouseWriter {
    pub async fn insert_workspace_event_link(
        &self,
        row: &WorkspaceEventLinkRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("workspace_event_links", row)
            .await
    }

    pub async fn insert_workspace_event_participant(
        &self,
        row: &WorkspaceEventParticipantRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("workspace_event_participants", row)
            .await
    }

    pub async fn insert_workspace_operational_event(
        &self,
        row: &WorkspaceOperationalEventRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("workspace_operational_events", row)
            .await
    }

    pub async fn insert_workspace_reconciliation_row(
        &self,
        row: &WorkspaceReconciliationRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("workspace_reconciliation_rows", row)
            .await
    }
}

fn serialize_clickhouse_datetime<S>(
    value: &DateTime<Utc>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
}

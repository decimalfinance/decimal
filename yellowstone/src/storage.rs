use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use std::error::Error;

type QueryResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

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

    pub async fn insert_observed_transaction(
        &self,
        row: &ObservedTransactionRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("observed_transactions", row).await
    }

    pub async fn insert_observed_transfer(
        &self,
        row: &ObservedTransferRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("observed_transfers", row)
            .await
    }

    pub async fn insert_observed_payment(
        &self,
        row: &ObservedPaymentRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("observed_payments", row).await
    }

    pub async fn upsert_settlement_match(
        &self,
        row: &SettlementMatchRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("settlement_matches", row).await
    }

    pub async fn insert_matcher_event(
        &self,
        row: &MatcherEventRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("matcher_events", row).await
    }

    pub async fn upsert_request_book_snapshot(
        &self,
        row: &RequestBookSnapshotRow,
    ) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("request_book_snapshots", row).await
    }

    pub async fn upsert_exception(&self, row: &ExceptionRow) -> Result<(), reqwest::Error> {
        self.insert_json_each_row("exceptions", row).await
    }

    pub async fn observed_transaction_exists(&self, signature: &str) -> QueryResult<bool> {
        let escaped_signature = signature.replace('\'', "\\'");
        let rows: Vec<CountRow> = self
            .query_json_each_row(&format!(
                "SELECT count() AS count FROM {}.observed_transactions WHERE signature = '{}' FORMAT JSONEachRow",
                self.database, escaped_signature
            ))
            .await?;
        Ok(rows.first().map(|row| row.count).unwrap_or(0) > 0)
    }

    pub async fn load_request_book_snapshots(&self) -> QueryResult<Vec<RequestBookSnapshotStateRow>> {
        self.query_json_each_row(&format!(
                "SELECT transfer_request_id, allocated_amount_raw, remaining_amount_raw, fill_count, book_status, last_signature FROM {}.request_book_snapshots FINAL FORMAT JSONEachRow",
                self.database
            ))
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

    async fn query_json_each_row<T: DeserializeOwned>(&self, query: &str) -> QueryResult<Vec<T>> {
        let url = format!("{}/?query={}", self.base_url, urlencoding::encode(query));
        let body = self
            .client
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            .body("\n")
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        let mut rows = Vec::new();
        for line in body.lines().filter(|line| !line.trim().is_empty()) {
            rows.push(serde_json::from_str(line)?);
        }

        Ok(rows)
    }
}

#[derive(serde::Deserialize)]
struct CountRow {
    #[serde(deserialize_with = "deserialize_u64_from_string_or_number")]
    count: u64,
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
pub struct ObservedTransactionRow {
    pub signature: String,
    pub slot: u64,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub finality_state: String,
    pub status: String,
    pub raw_mutation_count: u32,
    pub participant_count: u32,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct ObservedTransferRow {
    pub transfer_id: String,
    pub signature: String,
    pub slot: u64,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub source_token_account: Option<String>,
    pub source_wallet: Option<String>,
    pub destination_token_account: String,
    pub destination_wallet: Option<String>,
    pub amount_raw: i128,
    pub amount_decimal: String,
    pub transfer_kind: String,
    pub instruction_index: Option<u32>,
    pub inner_instruction_index: Option<u32>,
    pub route_group: String,
    pub leg_role: String,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct ObservedPaymentRow {
    pub payment_id: String,
    pub signature: String,
    pub slot: u64,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub asset: String,
    pub source_wallet: Option<String>,
    pub destination_wallet: Option<String>,
    pub gross_amount_raw: i128,
    pub gross_amount_decimal: String,
    pub net_destination_amount_raw: i128,
    pub net_destination_amount_decimal: String,
    pub fee_amount_raw: i128,
    pub fee_amount_decimal: String,
    pub route_count: u32,
    pub payment_kind: String,
    pub reconstruction_rule: String,
    pub confidence_band: String,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct MatcherEventRow {
    pub event_id: String,
    pub workspace_id: String,
    pub destination_address: String,
    pub transfer_request_id: Option<String>,
    pub observed_transfer_id: Option<String>,
    pub signature: Option<String>,
    pub event_type: String,
    pub quantity_raw: i128,
    pub remaining_request_raw: Option<i128>,
    pub remaining_observation_raw: Option<i128>,
    pub explanation: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub event_time: DateTime<Utc>,
    pub properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct RequestBookSnapshotRow {
    pub workspace_id: String,
    pub destination_address: String,
    pub transfer_request_id: String,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub requested_at: DateTime<Utc>,
    pub request_type: String,
    pub requested_amount_raw: i128,
    pub allocated_amount_raw: i128,
    pub remaining_amount_raw: i128,
    pub fill_count: u32,
    pub book_status: String,
    pub last_signature: Option<String>,
    pub last_observed_transfer_id: Option<String>,
    #[serde(serialize_with = "serialize_optional_clickhouse_datetime")]
    pub observed_event_time: Option<DateTime<Utc>>,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub updated_at: DateTime<Utc>,
}

#[derive(serde::Deserialize)]
pub struct RequestBookSnapshotStateRow {
    pub transfer_request_id: String,
    pub allocated_amount_raw: String,
    pub remaining_amount_raw: String,
    pub fill_count: u32,
    pub book_status: String,
    pub last_signature: Option<String>,
}

#[derive(Serialize)]
pub struct SettlementMatchRow {
    pub workspace_id: String,
    pub transfer_request_id: String,
    pub signature: Option<String>,
    pub observed_transfer_id: Option<String>,
    pub match_status: String,
    pub confidence_score: u8,
    pub confidence_band: String,
    pub matched_amount_raw: i128,
    pub amount_variance_raw: i128,
    pub destination_match_type: String,
    pub time_delta_seconds: i64,
    pub match_rule: String,
    pub candidate_count: u32,
    pub explanation: String,
    #[serde(serialize_with = "serialize_optional_clickhouse_datetime")]
    pub observed_event_time: Option<DateTime<Utc>>,
    #[serde(serialize_with = "serialize_optional_clickhouse_datetime")]
    pub matched_at: Option<DateTime<Utc>>,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ExceptionRow {
    pub workspace_id: String,
    pub exception_id: String,
    pub transfer_request_id: Option<String>,
    pub signature: Option<String>,
    pub observed_transfer_id: Option<String>,
    pub exception_type: String,
    pub severity: String,
    pub status: String,
    pub explanation: String,
    pub properties_json: Option<String>,
    #[serde(serialize_with = "serialize_optional_clickhouse_datetime")]
    pub observed_event_time: Option<DateTime<Utc>>,
    #[serde(serialize_with = "serialize_optional_clickhouse_datetime")]
    pub processed_at: Option<DateTime<Utc>>,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(serialize_with = "serialize_clickhouse_datetime")]
    pub updated_at: DateTime<Utc>,
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

fn serialize_optional_clickhouse_datetime<S>(
    value: &Option<DateTime<Utc>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serializer.serialize_some(&value.format("%Y-%m-%d %H:%M:%S%.3f").to_string()),
        None => serializer.serialize_none(),
    }
}

fn deserialize_u64_from_string_or_number<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Unexpected};
    use serde_json::Value;

    match Value::deserialize(deserializer)? {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| Error::invalid_type(Unexpected::Other("non-u64 number"), &"u64")),
        Value::String(value) => value
            .parse::<u64>()
            .map_err(|_| Error::invalid_value(Unexpected::Str(&value), &"u64 string")),
        other => Err(Error::invalid_type(
            Unexpected::Other(match other {
                Value::Null => "null",
                Value::Bool(_) => "bool",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
                _ => "unknown",
            }),
            &"u64 or stringified u64",
        )),
    }
}

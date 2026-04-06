use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Serialize, Serializer};
use std::error::Error;
use std::fmt;

type QueryResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
const OBSERVED_TRANSFERS_INSERT_ROWS: usize = 128;
const OBSERVED_PAYMENTS_INSERT_ROWS: usize = 64;
const RAW_OBSERVATIONS_INSERT_ROWS: usize = 512;
const MATCHER_EVENTS_INSERT_ROWS: usize = 128;
const SNAPSHOTS_INSERT_ROWS: usize = 128;
const MATCHES_INSERT_ROWS: usize = 128;
const EXCEPTIONS_INSERT_ROWS: usize = 128;
const ASYNC_INSERT_BUSY_TIMEOUT_MS: u32 = 1_000;

#[derive(Debug)]
struct ClickHouseHttpError {
    status: reqwest::StatusCode,
    body: String,
}

impl fmt::Display for ClickHouseHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ClickHouse HTTP {}: {}", self.status, self.body)
    }
}

impl Error for ClickHouseHttpError {}

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

    pub async fn insert_raw_observations(
        &self,
        rows: &[RawObservationRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "raw_observations",
            rows,
            RAW_OBSERVATIONS_INSERT_ROWS,
        )
        .await
    }

    pub async fn insert_observed_transaction(
        &self,
        row: &ObservedTransactionRow,
    ) -> QueryResult<()> {
        self.insert_json_each_row("observed_transactions", row).await
    }

    pub async fn insert_observed_transfers(
        &self,
        rows: &[ObservedTransferRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "observed_transfers",
            rows,
            OBSERVED_TRANSFERS_INSERT_ROWS,
        )
        .await
    }

    pub async fn insert_observed_payments(
        &self,
        rows: &[ObservedPaymentRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "observed_payments",
            rows,
            OBSERVED_PAYMENTS_INSERT_ROWS,
        )
        .await
    }

    pub async fn upsert_settlement_matches(
        &self,
        rows: &[SettlementMatchRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "settlement_matches",
            rows,
            MATCHES_INSERT_ROWS,
        )
        .await
    }

    pub async fn insert_matcher_events(
        &self,
        rows: &[MatcherEventRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "matcher_events",
            rows,
            MATCHER_EVENTS_INSERT_ROWS,
        )
        .await
    }

    pub async fn upsert_request_book_snapshots(
        &self,
        rows: &[RequestBookSnapshotRow],
    ) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "request_book_snapshots",
            rows,
            SNAPSHOTS_INSERT_ROWS,
        )
        .await
    }

    pub async fn upsert_exceptions(&self, rows: &[ExceptionRow]) -> QueryResult<()> {
        self.insert_json_each_row_many_chunked(
            "exceptions",
            rows,
            EXCEPTIONS_INSERT_ROWS,
        )
        .await
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
    ) -> QueryResult<()> {
        let query = format!("INSERT INTO {}.{} FORMAT JSONEachRow", self.database, table);
        let url = self.insert_url(&query);
        let payload = format!(
            "{}\n",
            serde_json::to_string(row).expect("row should serialize to JSON")
        );

        let response = self
            .client
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            .body(payload)
            .send()
            .await?;
        self.ensure_success(response).await?;

        Ok(())
    }

    async fn insert_json_each_row_many<T: Serialize>(
        &self,
        table: &str,
        rows: &[T],
    ) -> QueryResult<()> {
        if rows.is_empty() {
            return Ok(());
        }

        let query = format!("INSERT INTO {}.{} FORMAT JSONEachRow", self.database, table);
        let url = self.insert_url(&query);
        let mut payload = String::new();

        for row in rows {
            payload.push_str(&serde_json::to_string(row).expect("row should serialize to JSON"));
            payload.push('\n');
        }

        let response = self
            .client
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            .body(payload)
            .send()
            .await?;
        self.ensure_success(response).await?;

        Ok(())
    }

    fn insert_url(&self, query: &str) -> String {
        format!(
            "{}/?query={}&async_insert=1&wait_for_async_insert=1&async_insert_busy_timeout_ms={}",
            self.base_url,
            urlencoding::encode(query),
            ASYNC_INSERT_BUSY_TIMEOUT_MS
        )
    }

    async fn insert_json_each_row_many_chunked<T: Serialize>(
        &self,
        table: &str,
        rows: &[T],
        max_rows_per_insert: usize,
    ) -> QueryResult<()> {
        if rows.is_empty() {
            return Ok(());
        }

        let mut pending = chunk_ranges(rows.len(), max_rows_per_insert.max(1));

        while let Some((start, end)) = pending.pop() {
            let slice = &rows[start..end];
            match self.insert_json_each_row_many(table, slice).await {
                Ok(()) => {}
                Err(error) => {
                    if slice.len() > 1 && should_split_batch_after_error(error.as_ref()) {
                        let mid = start + (slice.len() / 2);
                        pending.push((mid, end));
                        pending.push((start, mid));
                        continue;
                    }

                    return Err(error);
                }
            }
        }

        Ok(())
    }

    async fn query_json_each_row<T: DeserializeOwned>(&self, query: &str) -> QueryResult<Vec<T>> {
        let url = format!("{}/?query={}", self.base_url, urlencoding::encode(query));
        let response = self
            .client
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            .body("\n")
            .send()
            .await?;
        let body = self.ensure_success(response).await?;

        let mut rows = Vec::new();
        for line in body.lines().filter(|line| !line.trim().is_empty()) {
            rows.push(serde_json::from_str(line)?);
        }

        Ok(rows)
    }

    async fn ensure_success(&self, response: reqwest::Response) -> QueryResult<String> {
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(Box::new(ClickHouseHttpError { status, body }));
        }

        Ok(body)
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

fn chunk_ranges(total_rows: usize, max_rows_per_chunk: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;

    while start < total_rows {
        let end = (start + max_rows_per_chunk).min(total_rows);
        ranges.push((start, end));
        start = end;
    }

    ranges.reverse();
    ranges
}

fn should_split_batch_after_error(error: &(dyn Error + Send + Sync)) -> bool {
    let message = error.to_string();
    message.contains("MEMORY_LIMIT_EXCEEDED")
        || message.contains("memory limit exceeded")
        || message.contains("Code: 241")
}

#[cfg(test)]
mod tests {
    use super::{chunk_ranges, should_split_batch_after_error, ClickHouseWriter, ASYNC_INSERT_BUSY_TIMEOUT_MS};
    use std::error::Error;
    use std::fmt;

    #[derive(Debug)]
    struct TestError(&'static str);

    impl fmt::Display for TestError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{}", self.0)
        }
    }

    impl Error for TestError {}

    #[test]
    fn chunk_ranges_splits_and_reverses_for_stack_processing() {
        assert_eq!(chunk_ranges(0, 128), Vec::<(usize, usize)>::new());
        assert_eq!(chunk_ranges(3, 128), vec![(0, 3)]);
        assert_eq!(chunk_ranges(260, 128), vec![(256, 260), (128, 256), (0, 128)]);
    }

    #[test]
    fn split_retry_only_triggers_for_memory_pressure_errors() {
        let memory = TestError("ClickHouse HTTP 500 Internal Server Error: Code: 241. DB::Exception: MEMORY_LIMIT_EXCEEDED");
        let generic = TestError("network timeout");

        assert!(should_split_batch_after_error(&memory));
        assert!(!should_split_batch_after_error(&generic));
    }

    #[test]
    fn insert_url_uses_async_insert_settings() {
        let writer = ClickHouseWriter::new(
            "http://127.0.0.1:8123".to_string(),
            "usdc_ops".to_string(),
            "default".to_string(),
            "".to_string(),
        );
        let url = writer.insert_url("INSERT INTO usdc_ops.observed_transfers FORMAT JSONEachRow");

        assert!(url.contains("async_insert=1"));
        assert!(url.contains("wait_for_async_insert=1"));
        assert!(url.contains(&format!(
            "async_insert_busy_timeout_ms={}",
            ASYNC_INSERT_BUSY_TIMEOUT_MS
        )));
    }
}

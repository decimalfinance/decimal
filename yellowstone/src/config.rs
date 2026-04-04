use std::env;
use std::time::Duration;

pub struct AppConfig {
    pub yellowstone_endpoint: String,
    pub yellowstone_token: Option<String>,
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub control_plane_api_url: String,
    pub control_plane_service_token: Option<String>,
    pub workspace_refresh_interval: Duration,
    pub debug_account_logs: bool,
    pub debug_stream_logs: bool,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, env::VarError> {
        let yellowstone_endpoint = env::var("YELLOWSTONE_ENDPOINT")?;
        let yellowstone_token = non_empty_env("YELLOWSTONE_TOKEN");
        let clickhouse_url =
            env::var("CLICKHOUSE_URL").unwrap_or_else(|_| "http://127.0.0.1:8123".to_string());
        let clickhouse_database =
            env::var("CLICKHOUSE_DATABASE").unwrap_or_else(|_| "usdc_ops".to_string());
        let clickhouse_user = env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "default".to_string());
        let clickhouse_password = env::var("CLICKHOUSE_PASSWORD").unwrap_or_default();
        let control_plane_api_url = env::var("CONTROL_PLANE_API_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3100".to_string());
        let control_plane_service_token = non_empty_env("CONTROL_PLANE_SERVICE_TOKEN");
        let workspace_refresh_interval = Duration::from_secs(
            env::var("WORKSPACE_REFRESH_INTERVAL_SECONDS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(60),
        );
        let debug_account_logs = env::var("DEBUG_YELLOWSTONE_ACCOUNTS")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let debug_stream_logs = env::var("DEBUG_YELLOWSTONE_STREAM")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);

        Ok(Self {
            yellowstone_endpoint,
            yellowstone_token,
            clickhouse_url,
            clickhouse_database,
            clickhouse_user,
            clickhouse_password,
            control_plane_api_url,
            control_plane_service_token,
            workspace_refresh_interval,
            debug_account_logs,
            debug_stream_logs,
        })
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
}

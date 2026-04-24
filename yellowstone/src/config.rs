use serde::Deserialize;
use std::{env, fs, path::PathBuf};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct FileConfig {
    yellowstone_endpoint: String,
    clickhouse_url: String,
    clickhouse_database: String,
    clickhouse_user: String,
    control_plane_api_url: String,
    workspace_refresh_interval_seconds: u64,
}

pub struct AppConfig {
    pub yellowstone_endpoint: String,
    pub yellowstone_token: Option<String>,
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub control_plane_api_url: String,
    pub control_plane_service_token: Option<String>,
    pub debug_account_logs: bool,
    pub debug_stream_logs: bool,
    pub debug_parsed_updates: bool,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, env::VarError> {
        let node_env = env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string());
        let is_production = node_env == "production";
        let file_config = load_worker_file_config();
        let yellowstone_endpoint = if !file_config.yellowstone_endpoint.trim().is_empty() {
            file_config.yellowstone_endpoint.clone()
        } else {
            env::var("YELLOWSTONE_ENDPOINT")?
        };
        let yellowstone_token = non_empty_env("YELLOWSTONE_TOKEN");
        let clickhouse_url = if !file_config.clickhouse_url.trim().is_empty() {
            file_config.clickhouse_url.clone()
        } else {
            env::var("CLICKHOUSE_URL").unwrap_or_else(|_| "http://127.0.0.1:8123".to_string())
        };
        let clickhouse_database = if !file_config.clickhouse_database.trim().is_empty() {
            file_config.clickhouse_database.clone()
        } else {
            env::var("CLICKHOUSE_DATABASE").unwrap_or_else(|_| "usdc_ops".to_string())
        };
        let clickhouse_user = if !file_config.clickhouse_user.trim().is_empty() {
            file_config.clickhouse_user.clone()
        } else {
            env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "default".to_string())
        };
        let clickhouse_password = env::var("CLICKHOUSE_PASSWORD").unwrap_or_default();
        let control_plane_api_url = if !file_config.control_plane_api_url.trim().is_empty() {
            file_config.control_plane_api_url.clone()
        } else {
            env::var("CONTROL_PLANE_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3100".to_string())
        };
        let control_plane_service_token = non_empty_env("CONTROL_PLANE_SERVICE_TOKEN");
        let debug_account_logs = env::var("DEBUG_YELLOWSTONE_ACCOUNTS")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let debug_stream_logs = env::var("DEBUG_YELLOWSTONE_STREAM")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let debug_parsed_updates = env::var("DEBUG_YELLOWSTONE_PARSED_UPDATES")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);

        if is_production && control_plane_service_token.is_none() {
            panic!("CONTROL_PLANE_SERVICE_TOKEN is required in production");
        }

        Ok(Self {
            yellowstone_endpoint,
            yellowstone_token,
            clickhouse_url,
            clickhouse_database,
            clickhouse_user,
            clickhouse_password,
            control_plane_api_url,
            control_plane_service_token,
            debug_account_logs,
            debug_stream_logs,
            debug_parsed_updates,
        })
    }
}

fn load_worker_file_config() -> FileConfig {
    let mut candidates = Vec::new();
    if let Ok(explicit) = env::var("AXORIA_WORKER_CONFIG_PATH") {
        if !explicit.trim().is_empty() {
            candidates.push(PathBuf::from(explicit));
        }
    }
    candidates.push(PathBuf::from("config/worker.config.json"));
    candidates.push(PathBuf::from("../config/worker.config.json"));

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }

        if let Ok(raw) = fs::read_to_string(&candidate) {
            if let Ok(parsed) = serde_json::from_str::<FileConfig>(&raw) {
                return parsed;
            }
        }
    }

    FileConfig::default()
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

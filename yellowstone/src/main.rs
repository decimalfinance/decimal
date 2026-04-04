use std::error::Error;

mod config;
mod control_plane;
mod storage;
mod yellowstone;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv::dotenv().ok();

    let config = config::AppConfig::from_env()?;

    println!("Starting Yellowstone ingestor...");
    println!("   Endpoint: {}", config.yellowstone_endpoint);
    println!(
        "   Token: {}",
        if config.yellowstone_token.is_some() {
            "Set"
        } else {
            "Not set"
        }
    );
    println!("   ClickHouse: {}", config.clickhouse_url);
    println!("   Control plane: {}", config.control_plane_api_url);
    println!(
        "   Control plane token: {}",
        if config.control_plane_service_token.is_some() {
            "Set"
        } else {
            "Not set"
        }
    );

    let writer = storage::ClickHouseWriter::new(
        config.clickhouse_url,
        config.clickhouse_database,
        config.clickhouse_user,
        config.clickhouse_password,
    );
    let control_plane_client = control_plane::ControlPlaneClient::new(
        config.control_plane_api_url,
        config.control_plane_service_token,
    );
    let registry_cache = control_plane::WorkspaceRegistryCache::new(
        control_plane_client,
        config.workspace_refresh_interval,
    );
    let worker = yellowstone::YellowstoneWorker::new(
        config.yellowstone_endpoint,
        config.yellowstone_token,
        writer,
        registry_cache,
        config.debug_account_logs,
    );
    worker.run().await;

    Ok(())
}

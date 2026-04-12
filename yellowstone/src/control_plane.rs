use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub struct ControlPlaneClient {
    client: Client,
    base_url: String,
    service_token: Option<String>,
}

impl ControlPlaneClient {
    pub fn new(base_url: String, service_token: Option<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("control plane client should build"),
            base_url,
            service_token,
        }
    }

    pub async fn fetch_registry(&self) -> Result<WorkspaceRegistry, reqwest::Error> {
        let workspaces = self.fetch_workspaces().await?;
        let mut snapshots = Vec::with_capacity(workspaces.items.len());

        for workspace in workspaces.items {
            let url = format!(
                "{}/internal/workspaces/{}/matching-context",
                self.base_url, workspace.workspace_id
            );
            let snapshot = self
                .with_internal_auth(self.client.get(url))
                .send()
                .await?
                .error_for_status()?
                .json::<WorkspaceMatchingSnapshot>()
                .await?;
            snapshots.push(snapshot);
        }

        Ok(WorkspaceRegistry::new(snapshots))
    }

    async fn fetch_workspaces(&self) -> Result<WorkspaceListResponse, reqwest::Error> {
        let url = format!("{}/internal/workspaces", self.base_url);
        self.with_internal_auth(self.client.get(url))
            .send()
            .await?
            .error_for_status()?
            .json::<WorkspaceListResponse>()
            .await
    }

    fn with_internal_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = &self.service_token {
            builder.header("x-service-token", token)
        } else {
            builder
        }
    }
}

pub struct WorkspaceRegistryCache {
    client: ControlPlaneClient,
    refresh_interval: Duration,
    last_refresh_at: Option<Instant>,
    last_refresh_error_log_at: Option<Instant>,
    registry: WorkspaceRegistry,
}

impl WorkspaceRegistryCache {
    pub fn new(client: ControlPlaneClient, refresh_interval: Duration) -> Self {
        Self {
            client,
            refresh_interval,
            last_refresh_at: None,
            last_refresh_error_log_at: None,
            registry: WorkspaceRegistry::default(),
        }
    }

    pub async fn refresh_if_stale(&mut self) -> Result<(), reqwest::Error> {
        let should_refresh = self
            .last_refresh_at
            .map(|last_refresh| last_refresh.elapsed() >= self.refresh_interval)
            .unwrap_or(true);

        if should_refresh {
            self.refresh_now().await?;
        }

        Ok(())
    }

    pub async fn refresh_now(&mut self) -> Result<(), reqwest::Error> {
        let mut last_error = None;
        for _ in 0..3 {
            match self.client.fetch_registry().await {
                Ok(registry) => {
                    self.registry = registry;
                    self.last_refresh_at = Some(Instant::now());
                    self.last_refresh_error_log_at = None;
                    return Ok(());
                }
                Err(error) => {
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }

        Err(last_error.expect("refresh retry loop should capture error"))
    }

    pub fn refresh_age(&self) -> Option<Duration> {
        self.last_refresh_at.map(|last_refresh| last_refresh.elapsed())
    }

    pub fn should_log_refresh_error(&mut self) -> bool {
        let should_log = self
            .last_refresh_error_log_at
            .map(|logged_at| logged_at.elapsed() >= Duration::from_secs(5))
            .unwrap_or(true);

        if should_log {
            self.last_refresh_error_log_at = Some(Instant::now());
        }

        should_log
    }

    pub fn registry(&self) -> &WorkspaceRegistry {
        &self.registry
    }
}

#[cfg(test)]
impl WorkspaceRegistryCache {
    pub fn with_registry(registry: WorkspaceRegistry) -> Self {
        Self {
            client: ControlPlaneClient::new("http://127.0.0.1:0".to_string(), None),
            refresh_interval: Duration::from_secs(3600),
            last_refresh_at: Some(Instant::now()),
            last_refresh_error_log_at: None,
            registry,
        }
    }
}

#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    wallet_matches_by_address: HashMap<String, Vec<WorkspaceAddressMatch>>,
    pending_requests_by_workspace_wallet:
        HashMap<String, HashMap<String, Vec<WorkspaceTransferRequestMatch>>>,
}

impl WorkspaceRegistry {
    fn new(raw_snapshots: Vec<WorkspaceMatchingSnapshot>) -> Self {
        let mut wallet_matches_by_address: HashMap<String, Vec<WorkspaceAddressMatch>> =
            HashMap::new();
        let mut pending_requests_by_workspace_wallet: HashMap<
            String,
            HashMap<String, Vec<WorkspaceTransferRequestMatch>>,
        > = HashMap::new();

        for raw_snapshot in raw_snapshots {
            for address in &raw_snapshot.addresses {
                let matched = WorkspaceAddressMatch {
                    workspace_id: raw_snapshot.workspace.workspace_id.clone(),
                    #[cfg(test)]
                    wallet_address: address.address.clone(),
                };

                wallet_matches_by_address
                    .entry(address.address.clone())
                    .or_default()
                    .push(matched.clone());
            }

            for request in &raw_snapshot.transfer_requests {
                let Some(destination_workspace_address) = &request.destination_workspace_address
                else {
                    continue;
                };

                let destination_wallet_address = destination_workspace_address.address.clone();
                let request_match = WorkspaceTransferRequestMatch {
                    transfer_request_id: request.transfer_request_id.clone(),
                    amount_raw: request.amount_raw.parse().unwrap_or_default(),
                    requested_at: request.requested_at,
                    request_type: request.request_type.clone(),
                    submitted_signature: request
                        .latest_execution
                        .as_ref()
                        .and_then(|execution| execution.submitted_signature.clone()),
                    #[cfg(test)]
                    workspace_id: raw_snapshot.workspace.workspace_id.clone(),
                    #[cfg(test)]
                    destination_wallet_address: destination_wallet_address.clone(),
                };

                pending_requests_by_workspace_wallet
                    .entry(raw_snapshot.workspace.workspace_id.clone())
                    .or_default()
                    .entry(destination_wallet_address)
                    .or_default()
                    .push(request_match.clone());
            }
        }

        Self {
            wallet_matches_by_address,
            pending_requests_by_workspace_wallet,
        }
    }

    pub fn matches_for_wallet(&self, address: &str) -> Option<&[WorkspaceAddressMatch]> {
        self.wallet_matches_by_address.get(address).map(Vec::as_slice)
    }

    pub fn pending_requests_for_destination_wallet(
        &self,
        workspace_id: &str,
        destination_wallet_address: &str,
    ) -> Option<&[WorkspaceTransferRequestMatch]> {
        self.pending_requests_by_workspace_wallet
            .get(workspace_id)
            .and_then(|requests| requests.get(destination_wallet_address))
            .map(Vec::as_slice)
    }
}

#[cfg(test)]
impl WorkspaceRegistry {
    pub fn from_matches(matches: Vec<WorkspaceAddressMatch>) -> Self {
        let mut wallet_matches_by_address: HashMap<String, Vec<WorkspaceAddressMatch>> =
            HashMap::new();

        for matched in matches {
            #[cfg(test)]
            let wallet_address = matched.wallet_address.clone();
            wallet_matches_by_address
                .entry(wallet_address)
                .or_default()
                .push(matched);
        }

        Self {
            wallet_matches_by_address,
            pending_requests_by_workspace_wallet: HashMap::new(),
        }
    }

    pub fn with_transfer_requests(
        matches: Vec<WorkspaceAddressMatch>,
        transfer_requests: Vec<WorkspaceTransferRequestMatch>,
    ) -> Self {
        let mut registry = Self::from_matches(matches);

        for request in transfer_requests {
            #[cfg(test)]
            let workspace_id = request.workspace_id.clone();
            #[cfg(test)]
            let destination_wallet_address = request.destination_wallet_address.clone();
            registry
                .pending_requests_by_workspace_wallet
                .entry(workspace_id)
                .or_default()
                .entry(destination_wallet_address)
                .or_default()
                .push(request);
        }

        registry
    }
}

#[derive(Clone)]
pub struct WorkspaceAddressMatch {
    pub workspace_id: String,
    #[cfg(test)]
    pub wallet_address: String,
}

#[derive(Clone)]
pub struct WorkspaceTransferRequestMatch {
    pub transfer_request_id: String,
    pub amount_raw: i128,
    pub requested_at: DateTime<Utc>,
    pub request_type: String,
    pub submitted_signature: Option<String>,
    #[cfg(test)]
    pub workspace_id: String,
    #[cfg(test)]
    pub destination_wallet_address: String,
}

#[derive(Deserialize)]
struct WorkspaceListResponse {
    items: Vec<WorkspaceView>,
}

#[derive(Deserialize)]
struct WorkspaceMatchingSnapshot {
    workspace: WorkspaceView,
    addresses: Vec<WorkspaceAddressView>,
    #[serde(rename = "transferRequests")]
    transfer_requests: Vec<TransferRequestDetails>,
}

#[derive(Deserialize)]
struct WorkspaceView {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
}

#[derive(Deserialize)]
struct WorkspaceAddressView {
    address: String,
}

#[derive(Deserialize)]
struct TransferRequestDetails {
    #[serde(rename = "transferRequestId")]
    transfer_request_id: String,
    #[serde(rename = "requestType")]
    request_type: String,
    #[serde(rename = "amountRaw")]
    amount_raw: String,
    #[serde(rename = "requestedAt")]
    requested_at: DateTime<Utc>,
    #[serde(rename = "destinationWorkspaceAddress")]
    destination_workspace_address: Option<TransferRequestWorkspaceAddressDetails>,
    #[serde(rename = "latestExecution")]
    latest_execution: Option<TransferRequestExecutionDetails>,
}

#[derive(Deserialize)]
struct TransferRequestWorkspaceAddressDetails {
    address: String,
}

#[derive(Deserialize)]
struct TransferRequestExecutionDetails {
    #[serde(rename = "submittedSignature")]
    submitted_signature: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_indexes_wallets_and_pending_requests() {
        let registry = WorkspaceRegistry::new(vec![WorkspaceMatchingSnapshot {
            workspace: WorkspaceView {
                workspace_id: "workspace-1".to_string(),
            },
            addresses: vec![WorkspaceAddressView {
                address: "Wallet111".to_string(),
            }],
            transfer_requests: vec![TransferRequestDetails {
                transfer_request_id: "request-1".to_string(),
                request_type: "wallet_transfer".to_string(),
                amount_raw: "10000".to_string(),
                requested_at: Utc::now(),
                destination_workspace_address: Some(TransferRequestWorkspaceAddressDetails {
                    address: "Wallet111".to_string(),
                }),
                latest_execution: Some(TransferRequestExecutionDetails {
                    submitted_signature: Some("signature-1".to_string()),
                }),
            }],
        }]);

        let wallet_matches = registry
            .matches_for_wallet("Wallet111")
            .expect("wallet should be indexed");
        assert_eq!(wallet_matches.len(), 1);
        assert_eq!(wallet_matches[0].workspace_id, "workspace-1");

        let pending_by_wallet = registry
            .pending_requests_for_destination_wallet("workspace-1", "Wallet111")
            .expect("pending request should also be indexed by wallet");
        assert_eq!(pending_by_wallet.len(), 1);
        assert_eq!(pending_by_wallet[0].transfer_request_id, "request-1");
        assert_eq!(pending_by_wallet[0].destination_wallet_address, "Wallet111");
        assert_eq!(
            pending_by_wallet[0].submitted_signature.as_deref(),
            Some("signature-1")
        );
    }
}

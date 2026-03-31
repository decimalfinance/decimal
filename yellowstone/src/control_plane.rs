use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub struct ControlPlaneClient {
    client: Client,
    base_url: String,
}

impl ControlPlaneClient {
    pub fn new(base_url: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
        }
    }

    pub async fn fetch_registry(&self) -> Result<WorkspaceRegistry, reqwest::Error> {
        let workspaces = self.fetch_workspaces().await?;
        let mut snapshots = Vec::with_capacity(workspaces.items.len());

        for workspace in workspaces.items {
            let url = format!(
                "{}/workspaces/{}/onboarding",
                self.base_url, workspace.workspace_id
            );
            let snapshot = self
                .client
                .get(url)
                .send()
                .await?
                .error_for_status()?
                .json::<WorkspaceOnboardingSnapshot>()
                .await?;
            snapshots.push(snapshot);
        }

        Ok(WorkspaceRegistry::new(snapshots))
    }

    async fn fetch_workspaces(&self) -> Result<WorkspaceListResponse, reqwest::Error> {
        let url = format!("{}/workspaces", self.base_url);
        self.client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json::<WorkspaceListResponse>()
            .await
    }
}

pub struct WorkspaceRegistryCache {
    client: ControlPlaneClient,
    refresh_interval: Duration,
    last_refresh_at: Option<Instant>,
    registry: WorkspaceRegistry,
}

impl WorkspaceRegistryCache {
    pub fn new(client: ControlPlaneClient, refresh_interval: Duration) -> Self {
        Self {
            client,
            refresh_interval,
            last_refresh_at: None,
            registry: WorkspaceRegistry::default(),
        }
    }

    pub async fn refresh_if_stale(&mut self) -> Result<(), reqwest::Error> {
        let should_refresh = self
            .last_refresh_at
            .map(|last_refresh| last_refresh.elapsed() >= self.refresh_interval)
            .unwrap_or(true);

        if should_refresh {
            self.registry = self.client.fetch_registry().await?;
            self.last_refresh_at = Some(Instant::now());
        }

        Ok(())
    }

    pub fn registry(&self) -> &WorkspaceRegistry {
        &self.registry
    }
}

#[cfg(test)]
impl WorkspaceRegistryCache {
    pub fn with_registry(registry: WorkspaceRegistry) -> Self {
        Self {
            client: ControlPlaneClient::new("http://127.0.0.1:0".to_string()),
            refresh_interval: Duration::from_secs(3600),
            last_refresh_at: Some(Instant::now()),
            registry,
        }
    }
}

#[derive(Default)]
pub struct WorkspaceRegistry {
    by_address: HashMap<String, Vec<WorkspaceAddressMatch>>,
}

impl WorkspaceRegistry {
    fn new(raw_snapshots: Vec<WorkspaceOnboardingSnapshot>) -> Self {
        let mut by_address: HashMap<String, Vec<WorkspaceAddressMatch>> = HashMap::new();

        for raw_snapshot in raw_snapshots {
            let label_names_by_address_id = raw_snapshot.address_labels.iter().fold(
                HashMap::<String, Vec<String>>::new(),
                |mut acc, link| {
                    acc.entry(link.workspace_address_id.clone())
                        .or_default()
                        .push(link.label.label_name.clone());
                    acc
                },
            );

            let object_mappings_by_address_id = raw_snapshot.address_object_mappings.iter().fold(
                HashMap::<String, Vec<WorkspaceObjectMappingView>>::new(),
                |mut acc, mapping| {
                    acc.entry(mapping.workspace_address_id.clone())
                        .or_default()
                        .push(WorkspaceObjectMappingView {
                            workspace_object_id: mapping
                                .workspace_object
                                .workspace_object_id
                                .clone(),
                            object_key: mapping.workspace_object.object_key.clone(),
                            display_name: mapping.workspace_object.display_name.clone(),
                            mapping_role: mapping.mapping_role.clone(),
                        });
                    acc
                },
            );

            for address in &raw_snapshot.addresses {
                by_address.entry(address.address.clone()).or_default().push(
                    WorkspaceAddressMatch {
                        workspace_id: raw_snapshot.workspace.workspace_id.clone(),
                        workspace_name: raw_snapshot.workspace.workspace_name.clone(),
                        workspace_address_id: address.workspace_address_id.clone(),
                        address: address.address.clone(),
                        address_kind: address.address_kind.clone(),
                        label_names: label_names_by_address_id
                            .get(&address.workspace_address_id)
                            .cloned()
                            .unwrap_or_default(),
                        object_mappings: object_mappings_by_address_id
                            .get(&address.workspace_address_id)
                            .cloned()
                            .unwrap_or_default(),
                    },
                );
            }
        }

        Self { by_address }
    }

    pub fn matches_for_address(&self, address: &str) -> Option<&[WorkspaceAddressMatch]> {
        self.by_address.get(address).map(Vec::as_slice)
    }
}

#[cfg(test)]
impl WorkspaceRegistry {
    pub fn from_matches(matches: Vec<WorkspaceAddressMatch>) -> Self {
        let mut by_address: HashMap<String, Vec<WorkspaceAddressMatch>> = HashMap::new();
        for matched in matches {
            by_address
                .entry(matched.address.clone())
                .or_default()
                .push(matched);
        }
        Self { by_address }
    }
}

#[derive(Clone)]
pub struct WorkspaceAddressMatch {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_address_id: String,
    pub address: String,
    pub address_kind: String,
    pub label_names: Vec<String>,
    pub object_mappings: Vec<WorkspaceObjectMappingView>,
}

#[derive(Clone)]
pub struct WorkspaceObjectMappingView {
    pub workspace_object_id: String,
    pub object_key: String,
    pub display_name: String,
    pub mapping_role: String,
}

#[derive(Deserialize)]
struct WorkspaceListResponse {
    items: Vec<WorkspaceView>,
}

#[derive(Deserialize)]
struct WorkspaceOnboardingSnapshot {
    workspace: WorkspaceView,
    addresses: Vec<WorkspaceAddressView>,
    #[serde(rename = "addressLabels")]
    address_labels: Vec<WorkspaceAddressLabelView>,
    #[serde(rename = "addressObjectMappings")]
    address_object_mappings: Vec<WorkspaceAddressObjectMappingView>,
}

#[derive(Deserialize)]
struct WorkspaceView {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "workspaceName")]
    workspace_name: String,
}

#[derive(Deserialize)]
struct WorkspaceAddressView {
    #[serde(rename = "workspaceAddressId")]
    workspace_address_id: String,
    address: String,
    #[serde(rename = "addressKind")]
    address_kind: String,
}

#[derive(Deserialize)]
struct WorkspaceAddressLabelView {
    #[serde(rename = "workspaceAddressId")]
    workspace_address_id: String,
    label: WorkspaceLabelDetails,
}

#[derive(Deserialize)]
struct WorkspaceLabelDetails {
    #[serde(rename = "labelName")]
    label_name: String,
}

#[derive(Deserialize)]
struct WorkspaceAddressObjectMappingView {
    #[serde(rename = "workspaceAddressId")]
    workspace_address_id: String,
    #[serde(rename = "mappingRole")]
    mapping_role: String,
    #[serde(rename = "workspaceObject")]
    workspace_object: WorkspaceObjectDetails,
}

#[derive(Deserialize)]
struct WorkspaceObjectDetails {
    #[serde(rename = "workspaceObjectId")]
    workspace_object_id: String,
    #[serde(rename = "objectKey")]
    object_key: String,
    #[serde(rename = "displayName")]
    display_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_indexes_addresses_with_labels_and_object_mappings() {
        let registry = WorkspaceRegistry::new(vec![WorkspaceOnboardingSnapshot {
            workspace: WorkspaceView {
                workspace_id: "workspace-1".to_string(),
                workspace_name: "Acme Ops".to_string(),
            },
            addresses: vec![WorkspaceAddressView {
                workspace_address_id: "address-1".to_string(),
                address: "Wallet111".to_string(),
                address_kind: "treasury_wallet".to_string(),
            }],
            address_labels: vec![WorkspaceAddressLabelView {
                workspace_address_id: "address-1".to_string(),
                label: WorkspaceLabelDetails {
                    label_name: "treasury".to_string(),
                },
            }],
            address_object_mappings: vec![WorkspaceAddressObjectMappingView {
                workspace_address_id: "address-1".to_string(),
                mapping_role: "owner".to_string(),
                workspace_object: WorkspaceObjectDetails {
                    workspace_object_id: "object-1".to_string(),
                    object_key: "main".to_string(),
                    display_name: "Main Treasury".to_string(),
                },
            }],
        }]);

        let matches = registry
            .matches_for_address("Wallet111")
            .expect("address should be indexed");

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].workspace_id, "workspace-1");
        assert_eq!(matches[0].label_names, vec!["treasury".to_string()]);
        assert_eq!(matches[0].object_mappings.len(), 1);
        assert_eq!(matches[0].object_mappings[0].object_key, "main");
    }
}

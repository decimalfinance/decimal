export type User = {
  userId: string;
  email: string;
  displayName: string;
};

export type Workspace = {
  workspaceId: string;
  organizationId?: string;
  workspaceSlug: string;
  workspaceName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: string;
  status: string;
  workspaces: Workspace[];
};

export type OrganizationDirectoryItem = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  status: string;
  workspaceCount: number;
  isMember: boolean;
  membershipRole: string | null;
};

export type AuthenticatedSession = {
  authenticated: true;
  user: User;
  organizations: OrganizationMembership[];
};

export type LoginResponse = {
  status: 'authenticated';
  sessionToken: string;
  user: User;
  organizations: OrganizationMembership[];
};

export type WorkspaceAddress = {
  workspaceAddressId: string;
  workspaceId: string;
  chain: string;
  address: string;
  addressKind: string;
  assetScope: string;
  source: string;
  sourceRef: string | null;
  notes: string | null;
  propertiesJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceLabel = {
  labelId: string;
  workspaceId: string;
  labelName: string;
  labelType: string;
  color: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceObject = {
  workspaceObjectId: string;
  workspaceId: string;
  objectType: string;
  objectKey: string;
  displayName: string;
  status: string;
  propertiesJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AddressLabelLink = {
  workspaceId: string;
  workspaceAddressId: string;
  labelId: string;
  workspaceAddress: WorkspaceAddress;
  label: WorkspaceLabel;
  createdAt: string;
};

export type AddressObjectMapping = {
  mappingId?: string;
  workspaceId: string;
  workspaceAddressId: string;
  workspaceObjectId: string;
  mappingRole: string;
  confidence: number;
  source: string;
  isPrimary: boolean;
  validTo: string | null;
  propertiesJson: Record<string, unknown>;
  workspaceAddress: WorkspaceAddress;
  workspaceObject: WorkspaceObject;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingSnapshot = {
  workspace: Workspace;
  addresses: WorkspaceAddress[];
  labels: WorkspaceLabel[];
  addressLabels: AddressLabelLink[];
  objects: WorkspaceObject[];
  addressObjectMappings: AddressObjectMapping[];
};

export type OperationalEvent = {
  workspace_event_id: string;
  canonical_event_id: string;
  slot: number;
  signature: string;
  event_time: string;
  asset: string;
  event_type: string;
  direction: string;
  amount_raw: string;
  amount_decimal: string;
  primary_object_id: string | null;
  primary_label: string | null;
  summary_text: string;
  confidence: number;
};

export type ReconciliationRow = {
  reconciliation_row_id: string;
  workspace_event_id: string;
  event_time: string;
  asset: string;
  amount_raw: string;
  amount_decimal: string;
  direction: string;
  internal_object_key: string | null;
  counterparty_name: string | null;
  event_type: string;
  signature: string;
  token_account: string | null;
  notes: string | null;
  export_status: string;
};

export type EventParticipant = {
  participant_id: string;
  role: string;
  address: string;
  workspace_address_id: string | null;
  workspace_object_id: string | null;
  direction: string;
  amount_raw: string;
  confidence: number;
  properties_json: string | null;
};

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS organizations
(
  organization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users
(
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_memberships
(
  membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions
(
  auth_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token TEXT NOT NULL UNIQUE,
  organization_id UUID REFERENCES organizations(organization_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces
(
  workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  workspace_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_addresses
(
  workspace_address_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  address_kind TEXT NOT NULL DEFAULT 'wallet',
  asset_scope TEXT NOT NULL DEFAULT 'usdc',
  usdc_ata_address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  display_name TEXT,
  notes TEXT,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, address)
);

ALTER TABLE workspace_addresses
  ADD COLUMN IF NOT EXISTS usdc_ata_address TEXT;

ALTER TABLE workspace_addresses
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS organization_slug;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS workspace_slug;

CREATE TABLE IF NOT EXISTS transfer_requests
(
  transfer_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  source_workspace_address_id UUID REFERENCES workspace_addresses(workspace_address_id) ON DELETE SET NULL,
  destination_workspace_address_id UUID NOT NULL REFERENCES workspace_addresses(workspace_address_id) ON DELETE RESTRICT,
  request_type TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'usdc',
  amount_raw BIGINT NOT NULL,
  requested_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  reason TEXT,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS source_workspace_address_id UUID;

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS destination_workspace_address_id UUID;

ALTER TABLE transfer_requests
  DROP COLUMN IF EXISTS counterparty_id;

ALTER TABLE transfer_requests
  DROP COLUMN IF EXISTS destination_id;

DROP TABLE IF EXISTS workspace_address_object_mappings CASCADE;
DROP TABLE IF EXISTS workspace_address_labels CASCADE;
DROP TABLE IF EXISTS workspace_objects CASCADE;
DROP TABLE IF EXISTS workspace_labels CASCADE;
DROP TABLE IF EXISTS global_entity_addresses CASCADE;
DROP TABLE IF EXISTS global_entities CASCADE;
DROP TABLE IF EXISTS destinations CASCADE;
DROP TABLE IF EXISTS counterparties CASCADE;

CREATE INDEX IF NOT EXISTS idx_memberships_organization_id ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id ON auth_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_organization_id ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_workspace_id ON workspace_addresses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_address ON workspace_addresses(address);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_usdc_ata ON workspace_addresses(usdc_ata_address);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_workspace_id ON transfer_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_source_address_id ON transfer_requests(source_workspace_address_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_address_id ON transfer_requests(destination_workspace_address_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_memberships_updated_at ON organization_memberships;
CREATE TRIGGER trg_memberships_updated_at
BEFORE UPDATE ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspaces_updated_at ON workspaces;
CREATE TRIGGER trg_workspaces_updated_at
BEFORE UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_addresses_updated_at ON workspace_addresses;
CREATE TRIGGER trg_workspace_addresses_updated_at
BEFORE UPDATE ON workspace_addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_transfer_requests_updated_at ON transfer_requests;
CREATE TRIGGER trg_transfer_requests_updated_at
BEFORE UPDATE ON transfer_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

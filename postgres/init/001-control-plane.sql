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
  organization_slug TEXT NOT NULL UNIQUE,
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

ALTER TABLE auth_sessions
  ALTER COLUMN organization_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS workspaces
(
  workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_slug TEXT NOT NULL UNIQUE,
  workspace_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS organization_id UUID;

INSERT INTO organizations (organization_slug, organization_name)
VALUES ('legacy-org', 'Legacy Organization')
ON CONFLICT (organization_slug) DO NOTHING;

UPDATE workspaces
SET organization_id = (
  SELECT organization_id
  FROM organizations
  WHERE organization_slug = 'legacy-org'
)
WHERE organization_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_organization_id_fkey'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES organizations(organization_id)
      ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE workspaces
  ALTER COLUMN organization_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_addresses
(
  workspace_address_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  address_kind TEXT NOT NULL,
  asset_scope TEXT NOT NULL DEFAULT 'usdc',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  notes TEXT,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, address)
);

CREATE TABLE IF NOT EXISTS workspace_labels
(
  label_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  label_name TEXT NOT NULL,
  label_type TEXT NOT NULL,
  color TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, label_name)
);

CREATE TABLE IF NOT EXISTS workspace_address_labels
(
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  workspace_address_id UUID NOT NULL REFERENCES workspace_addresses(workspace_address_id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES workspace_labels(label_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, workspace_address_id, label_id)
);

CREATE TABLE IF NOT EXISTS workspace_objects
(
  workspace_object_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, object_type, object_key)
);

CREATE TABLE IF NOT EXISTS workspace_address_object_mappings
(
  mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  workspace_address_id UUID NOT NULL REFERENCES workspace_addresses(workspace_address_id) ON DELETE CASCADE,
  workspace_object_id UUID NOT NULL REFERENCES workspace_objects(workspace_object_id) ON DELETE CASCADE,
  mapping_role TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'manual',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_entities
(
  global_entity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  chain TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'system',
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_entity_addresses
(
  global_entity_address_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  global_entity_id UUID NOT NULL REFERENCES global_entities(global_entity_id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  address_kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memberships_organization_id ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id ON auth_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_organization_id ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_workspace_id ON workspace_addresses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_address ON workspace_addresses(address);
CREATE INDEX IF NOT EXISTS idx_workspace_labels_workspace_id ON workspace_labels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_objects_workspace_id ON workspace_objects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_mappings_workspace_id ON workspace_address_object_mappings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_mappings_address_id ON workspace_address_object_mappings(workspace_address_id);
CREATE INDEX IF NOT EXISTS idx_global_entity_addresses_entity_id ON global_entity_addresses(global_entity_id);

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

DROP TRIGGER IF EXISTS trg_workspace_labels_updated_at ON workspace_labels;
CREATE TRIGGER trg_workspace_labels_updated_at
BEFORE UPDATE ON workspace_labels
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_objects_updated_at ON workspace_objects;
CREATE TRIGGER trg_workspace_objects_updated_at
BEFORE UPDATE ON workspace_objects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_mappings_updated_at ON workspace_address_object_mappings;
CREATE TRIGGER trg_workspace_mappings_updated_at
BEFORE UPDATE ON workspace_address_object_mappings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_global_entities_updated_at ON global_entities;
CREATE TRIGGER trg_global_entities_updated_at
BEFORE UPDATE ON global_entities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_global_entity_addresses_updated_at ON global_entity_addresses;
CREATE TRIGGER trg_global_entity_addresses_updated_at
BEFORE UPDATE ON global_entity_addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

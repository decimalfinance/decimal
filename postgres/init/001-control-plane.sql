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

CREATE TABLE IF NOT EXISTS transfer_request_events
(
  transfer_request_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id UUID NOT NULL REFERENCES transfer_requests(transfer_request_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_source TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  linked_signature TEXT,
  linked_payment_id UUID,
  linked_transfer_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_request_notes
(
  transfer_request_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id UUID NOT NULL REFERENCES transfer_requests(transfer_request_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exception_notes
(
  exception_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  exception_id UUID NOT NULL,
  author_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exception_states
(
  exception_state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  exception_id UUID NOT NULL,
  status TEXT NOT NULL,
  updated_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, exception_id)
);

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS source_workspace_address_id UUID;

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS destination_workspace_address_id UUID;

ALTER TABLE transfer_requests
  DROP COLUMN IF EXISTS counterparty_id;

ALTER TABLE transfer_requests
  DROP COLUMN IF EXISTS destination_id;

ALTER TABLE transfer_requests
  DROP CONSTRAINT IF EXISTS chk_transfer_requests_status;

ALTER TABLE transfer_requests
  ADD CONSTRAINT chk_transfer_requests_status CHECK (
    status IN (
      'draft',
      'submitted',
      'pending_approval',
      'approved',
      'ready_for_execution',
      'submitted_onchain',
      'observed',
      'matched',
      'partially_matched',
      'exception',
      'closed',
      'rejected'
    )
  );

ALTER TABLE transfer_request_events
  DROP CONSTRAINT IF EXISTS chk_transfer_request_events_actor_type;

ALTER TABLE transfer_request_events
  ADD CONSTRAINT chk_transfer_request_events_actor_type CHECK (
    actor_type IN ('user', 'system', 'worker')
  );

ALTER TABLE transfer_request_events
  DROP CONSTRAINT IF EXISTS chk_transfer_request_events_event_source;

ALTER TABLE transfer_request_events
  ADD CONSTRAINT chk_transfer_request_events_event_source CHECK (
    event_source IN ('user', 'system', 'worker')
  );

ALTER TABLE exception_states
  DROP CONSTRAINT IF EXISTS chk_exception_states_status;

ALTER TABLE exception_states
  ADD CONSTRAINT chk_exception_states_status CHECK (
    status IN ('open', 'reviewed', 'expected', 'dismissed', 'reopened')
  );

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
CREATE INDEX IF NOT EXISTS idx_transfer_requests_workspace_status_requested_at
  ON transfer_requests(workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_status_requested_at
  ON transfer_requests(destination_workspace_address_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_events_request_created_at
  ON transfer_request_events(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_events_workspace_created_at
  ON transfer_request_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_notes_request_created_at
  ON transfer_request_notes(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_notes_workspace_created_at
  ON transfer_request_notes(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_notes_exception_created_at
  ON exception_notes(exception_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_exception_notes_workspace_created_at
  ON exception_notes(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_states_workspace_exception
  ON exception_states(workspace_id, exception_id);
CREATE INDEX IF NOT EXISTS idx_exception_states_workspace_status_updated_at
  ON exception_states(workspace_id, status, updated_at DESC);

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

DROP TRIGGER IF EXISTS trg_exception_states_updated_at ON exception_states;
CREATE TRIGGER trg_exception_states_updated_at
BEFORE UPDATE ON exception_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

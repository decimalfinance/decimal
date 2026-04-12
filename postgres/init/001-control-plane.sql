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
  destination_id UUID,
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
  assigned_to_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  resolution_code TEXT,
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, exception_id)
);

CREATE TABLE IF NOT EXISTS export_jobs
(
  export_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  requested_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  export_kind TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  row_count INTEGER NOT NULL DEFAULT 0,
  filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS address_labels
(
  address_label_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  label_kind TEXT NOT NULL,
  role_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  confidence TEXT NOT NULL DEFAULT 'seeded',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, address)
);

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS source_workspace_address_id UUID;

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS destination_workspace_address_id UUID;

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS payment_order_id UUID;

ALTER TABLE exception_states
  ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE exception_states
  ADD COLUMN IF NOT EXISTS resolution_code TEXT;

ALTER TABLE exception_states
  ADD COLUMN IF NOT EXISTS severity TEXT;

CREATE TABLE IF NOT EXISTS counterparties
(
  counterparty_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS destinations
(
  destination_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  linked_workspace_address_id UUID REFERENCES workspace_addresses(workspace_address_id) ON DELETE SET NULL,
  chain TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'usdc',
  wallet_address TEXT NOT NULL,
  token_account_address TEXT,
  destination_type TEXT NOT NULL DEFAULT 'wallet',
  trust_state TEXT NOT NULL DEFAULT 'unreviewed',
  label TEXT NOT NULL,
  notes TEXT,
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, linked_workspace_address_id)
);

CREATE TABLE IF NOT EXISTS payees
(
  payee_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  default_destination_id UUID REFERENCES destinations(destination_id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS approval_policies
(
  approval_policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  policy_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  rule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_decisions
(
  approval_decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_policy_id UUID REFERENCES approval_policies(approval_policy_id) ON DELETE SET NULL,
  transfer_request_id UUID NOT NULL REFERENCES transfer_requests(transfer_request_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  comment TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_records
(
  execution_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id UUID NOT NULL REFERENCES transfer_requests(transfer_request_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  submitted_signature TEXT,
  execution_source TEXT NOT NULL DEFAULT 'manual',
  executor_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'ready_for_execution',
  submitted_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_orders
(
  payment_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  payment_request_id UUID,
  payee_id UUID REFERENCES payees(payee_id) ON DELETE SET NULL,
  destination_id UUID NOT NULL REFERENCES destinations(destination_id) ON DELETE RESTRICT,
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  source_workspace_address_id UUID REFERENCES workspace_addresses(workspace_address_id) ON DELETE SET NULL,
  amount_raw BIGINT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'usdc',
  memo TEXT,
  external_reference TEXT,
  invoice_number TEXT,
  attachment_url TEXT,
  due_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'draft',
  source_balance_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_requests
(
  payment_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  payee_id UUID REFERENCES payees(payee_id) ON DELETE SET NULL,
  destination_id UUID NOT NULL REFERENCES destinations(destination_id) ON DELETE RESTRICT,
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  requested_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  amount_raw BIGINT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'usdc',
  reason TEXT NOT NULL,
  external_reference TEXT,
  due_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'submitted',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, destination_id, amount_raw, external_reference)
);

CREATE TABLE IF NOT EXISTS payment_order_events
(
  payment_order_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  before_state TEXT,
  after_state TEXT,
  linked_transfer_request_id UUID,
  linked_execution_record_id UUID,
  linked_signature TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transfer_requests
  ADD COLUMN IF NOT EXISTS destination_id UUID;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS payment_request_id UUID;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS payee_id UUID REFERENCES payees(payee_id) ON DELETE SET NULL;

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS payee_id UUID REFERENCES payees(payee_id) ON DELETE SET NULL;

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_payment_request_id_fkey;

ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_payment_request_id_fkey
  FOREIGN KEY (payment_request_id) REFERENCES payment_requests(payment_request_id) ON DELETE SET NULL;

ALTER TABLE transfer_requests
  DROP CONSTRAINT IF EXISTS transfer_requests_payment_order_id_fkey;

ALTER TABLE transfer_requests
  ADD CONSTRAINT transfer_requests_payment_order_id_fkey
  FOREIGN KEY (payment_order_id) REFERENCES payment_orders(payment_order_id) ON DELETE SET NULL;

ALTER TABLE transfer_requests
  DROP CONSTRAINT IF EXISTS transfer_requests_destination_id_fkey;

ALTER TABLE transfer_requests
  ADD CONSTRAINT transfer_requests_destination_id_fkey
  FOREIGN KEY (destination_id) REFERENCES destinations(destination_id) ON DELETE SET NULL;

ALTER TABLE transfer_requests
  DROP COLUMN IF EXISTS counterparty_id;

ALTER TABLE transfer_requests
  DROP CONSTRAINT IF EXISTS chk_transfer_requests_status;

ALTER TABLE transfer_requests
  ADD CONSTRAINT chk_transfer_requests_status CHECK (
    status IN (
      'draft',
      'submitted',
      'pending_approval',
      'escalated',
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

ALTER TABLE approval_decisions
  DROP CONSTRAINT IF EXISTS chk_approval_decisions_actor_type;

ALTER TABLE approval_decisions
  ADD CONSTRAINT chk_approval_decisions_actor_type CHECK (
    actor_type IN ('user', 'system')
  );

ALTER TABLE approval_decisions
  DROP CONSTRAINT IF EXISTS chk_approval_decisions_action;

ALTER TABLE approval_decisions
  ADD CONSTRAINT chk_approval_decisions_action CHECK (
    action IN ('routed_for_approval', 'auto_approved', 'approve', 'reject', 'escalate')
  );

ALTER TABLE execution_records
  DROP CONSTRAINT IF EXISTS chk_execution_records_state;

ALTER TABLE execution_records
  ADD CONSTRAINT chk_execution_records_state CHECK (
    state IN (
      'ready_for_execution',
      'submitted_onchain',
      'broadcast_failed',
      'observed',
      'settled',
      'execution_exception'
    )
  );

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS chk_payment_orders_state;

ALTER TABLE payment_orders
  ADD CONSTRAINT chk_payment_orders_state CHECK (
    state IN (
      'draft',
      'pending_approval',
      'approved',
      'ready_for_execution',
      'execution_recorded',
      'partially_settled',
      'settled',
      'exception',
      'closed',
      'cancelled'
    )
  );

ALTER TABLE payment_requests
  DROP CONSTRAINT IF EXISTS chk_payment_requests_state;

ALTER TABLE payment_requests
  ADD CONSTRAINT chk_payment_requests_state CHECK (
    state IN ('submitted', 'converted_to_order', 'cancelled')
  );

ALTER TABLE payment_order_events
  DROP CONSTRAINT IF EXISTS chk_payment_order_events_actor_type;

ALTER TABLE payment_order_events
  ADD CONSTRAINT chk_payment_order_events_actor_type CHECK (
    actor_type IN ('user', 'system', 'worker')
  );

ALTER TABLE exception_states
  DROP CONSTRAINT IF EXISTS chk_exception_states_status;

ALTER TABLE exception_states
  ADD CONSTRAINT chk_exception_states_status CHECK (
    status IN ('open', 'reviewed', 'expected', 'dismissed', 'reopened')
  );

ALTER TABLE address_labels
  DROP CONSTRAINT IF EXISTS chk_address_labels_confidence;

ALTER TABLE address_labels
  ADD CONSTRAINT chk_address_labels_confidence CHECK (
    confidence IN ('seeded', 'verified', 'operator', 'unverified')
  );

DROP TABLE IF EXISTS workspace_address_object_mappings CASCADE;
DROP TABLE IF EXISTS workspace_address_labels CASCADE;
DROP TABLE IF EXISTS workspace_objects CASCADE;
DROP TABLE IF EXISTS workspace_labels CASCADE;
DROP TABLE IF EXISTS global_entity_addresses CASCADE;
DROP TABLE IF EXISTS global_entities CASCADE;
CREATE INDEX IF NOT EXISTS idx_memberships_organization_id ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id ON auth_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_organization_id ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_workspace_id ON workspace_addresses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_address ON workspace_addresses(address);
CREATE INDEX IF NOT EXISTS idx_workspace_addresses_usdc_ata ON workspace_addresses(usdc_ata_address);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_workspace_id ON transfer_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_payment_order_id ON transfer_requests(payment_order_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_source_address_id ON transfer_requests(source_workspace_address_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_address_id ON transfer_requests(destination_workspace_address_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_workspace_status_requested_at
  ON transfer_requests(workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_status_requested_at
  ON transfer_requests(destination_workspace_address_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_id
  ON transfer_requests(destination_id);
CREATE INDEX IF NOT EXISTS idx_counterparties_organization_created_at
  ON counterparties(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_workspace_created_at
  ON destinations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_counterparty_created_at
  ON destinations(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_wallet_address
  ON destinations(wallet_address);
CREATE INDEX IF NOT EXISTS idx_payees_workspace_status_created_at
  ON payees(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payees_default_destination_created_at
  ON payees(default_destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_policies_workspace_id
  ON approval_policies(workspace_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_workspace_created_at
  ON approval_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request_created_at
  ON approval_decisions(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_execution_records_workspace_created_at
  ON execution_records(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_records_request_created_at
  ON execution_records(transfer_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_workspace_state_created_at
  ON payment_orders(workspace_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_payment_request_id_unique
  ON payment_orders(payment_request_id)
  WHERE payment_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_orders_payment_request_id
  ON payment_orders(payment_request_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_payee_created_at
  ON payment_orders(payee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_destination_created_at
  ON payment_orders(destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_source_created_at
  ON payment_orders(source_workspace_address_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_unique_active_reference
  ON payment_orders(workspace_id, destination_id, amount_raw, lower(coalesce(external_reference, invoice_number)))
  WHERE coalesce(external_reference, invoice_number) IS NOT NULL
    AND state NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_payment_order_events_order_created_at
  ON payment_order_events(payment_order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_payment_order_events_workspace_created_at
  ON payment_order_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_workspace_state_created_at
  ON payment_requests(workspace_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_payee_created_at
  ON payment_requests(payee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_destination_created_at
  ON payment_requests(destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_counterparty_created_at
  ON payment_requests(counterparty_id, created_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_address_labels_chain_address
  ON address_labels(chain, address);
CREATE INDEX IF NOT EXISTS idx_address_labels_entity_name
  ON address_labels(entity_name);

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

DROP TRIGGER IF EXISTS trg_counterparties_updated_at ON counterparties;
CREATE TRIGGER trg_counterparties_updated_at
BEFORE UPDATE ON counterparties
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_destinations_updated_at ON destinations;
CREATE TRIGGER trg_destinations_updated_at
BEFORE UPDATE ON destinations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payees_updated_at ON payees;
CREATE TRIGGER trg_payees_updated_at
BEFORE UPDATE ON payees
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_approval_policies_updated_at ON approval_policies;
CREATE TRIGGER trg_approval_policies_updated_at
BEFORE UPDATE ON approval_policies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_execution_records_updated_at ON execution_records;
CREATE TRIGGER trg_execution_records_updated_at
BEFORE UPDATE ON execution_records
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_orders_updated_at ON payment_orders;
CREATE TRIGGER trg_payment_orders_updated_at
BEFORE UPDATE ON payment_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_requests_updated_at ON payment_requests;
CREATE TRIGGER trg_payment_requests_updated_at
BEFORE UPDATE ON payment_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_exception_states_updated_at ON exception_states;
CREATE TRIGGER trg_exception_states_updated_at
BEFORE UPDATE ON exception_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_address_labels_updated_at ON address_labels;
CREATE TRIGGER trg_address_labels_updated_at
BEFORE UPDATE ON address_labels
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO address_labels
(
  chain,
  address,
  entity_name,
  entity_type,
  label_kind,
  role_tags,
  source,
  source_ref,
  confidence,
  is_active,
  notes
)
VALUES
(
  'solana',
  '69yhtoJR4JYPPABZcSNkzuqbaFbwHsCkja1sP1Q2aVT5',
  'Jupiter Aggregator Authority 11',
  'aggregator',
  'fee_collector',
  '["fee_recipient","aggregator"]'::jsonb,
  'orb_seed',
  'https://orbmarkets.io',
  'seeded',
  TRUE,
  'Seeded from explorer labeling for recurring Jupiter fee recipient behavior.'
)
ON CONFLICT (chain, address) DO UPDATE
SET
  entity_name = EXCLUDED.entity_name,
  entity_type = EXCLUDED.entity_type,
  label_kind = EXCLUDED.label_kind,
  role_tags = EXCLUDED.role_tags,
  source = EXCLUDED.source,
  source_ref = EXCLUDED.source_ref,
  confidence = EXCLUDED.confidence,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;

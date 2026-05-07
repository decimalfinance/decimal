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
  password_hash TEXT,
  google_subject TEXT UNIQUE,
  avatar_url TEXT,
  email_verified_at TIMESTAMPTZ,
  email_verification_code_hash TEXT,
  email_verification_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_subject TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verification_code_hash TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;

-- Personal wallets belong to individual users. They are not organization treasury
-- wallets and should never be treated as org funds. The physical table remains
-- user_wallets for compatibility with earlier builds.
CREATE TABLE IF NOT EXISTS user_wallets
(
  user_wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'solana',
  wallet_address TEXT NOT NULL,
  wallet_type TEXT NOT NULL,
  provider TEXT,
  provider_wallet_id TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  verified_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, chain, wallet_address)
);

CREATE TABLE IF NOT EXISTS wallet_challenges
(
  wallet_challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  chain TEXT NOT NULL DEFAULT 'solana',
  wallet_address TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS organization_invites
(
  organization_invite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invite_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  accepted_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS idempotency_records
(
  idempotency_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  status_code INTEGER,
  response_body_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_type, actor_id, request_method, request_path, key)
);

CREATE TABLE IF NOT EXISTS treasury_wallets
(
  treasury_wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
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
  UNIQUE (organization_id, address)
);

-- Explicit authorization bridge from a personal wallet to an organization
-- treasury wallet. This answers "which member wallet may act for this org
-- wallet?" without making the member wallet part of the treasury.
CREATE TABLE IF NOT EXISTS organization_wallet_authorizations
(
  wallet_authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE CASCADE,
  user_wallet_id UUID NOT NULL REFERENCES user_wallets(user_wallet_id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES organization_memberships(membership_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'signer',
  status TEXT NOT NULL DEFAULT 'active',
  scope TEXT NOT NULL DEFAULT 'treasury_wallet',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, treasury_wallet_id, user_wallet_id, role)
);

ALTER TABLE treasury_wallets
  ADD COLUMN IF NOT EXISTS usdc_ata_address TEXT;

ALTER TABLE treasury_wallets
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS organization_slug;

DO $$
DECLARE
  target_table TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'treasury_wallets',
    'transfer_requests',
    'transfer_request_events',
    'transfer_request_notes',
    'exception_notes',
    'exception_states',
    'destinations',
    'collection_sources',
    'approval_policies',
    'approval_decisions',
    'execution_records',
    'payment_runs',
    'payment_orders',
    'payment_order_events',
    'payment_requests',
    'collection_runs',
    'collection_requests',
    'collection_request_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = target_table
          AND column_name = 'workspace_id'
      ) THEN
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id UUID', target_table);

        IF to_regclass('public.workspaces') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workspaces'
              AND column_name = 'workspace_id'
          )
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workspaces'
              AND column_name = 'organization_id'
          )
        THEN
          EXECUTE format(
            'UPDATE %I child SET organization_id = parent.organization_id FROM workspaces parent WHERE child.workspace_id = parent.workspace_id AND child.organization_id IS NULL',
            target_table
          );
        END IF;

        FOR constraint_name IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = format('public.%I', target_table)::regclass
            AND pg_get_constraintdef(oid) ILIKE '%workspace_id%'
        LOOP
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', target_table, constraint_name);
        END LOOP;

        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS workspace_id CASCADE', target_table);
      END IF;
    END IF;
  END LOOP;

  DROP TABLE IF EXISTS workspaces CASCADE;
END $$;

CREATE TABLE IF NOT EXISTS transfer_requests
(
  transfer_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  source_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL,
  destination_id UUID NOT NULL,
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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exception_notes
(
  exception_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  exception_id UUID NOT NULL,
  author_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exception_states
(
  exception_state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  exception_id UUID NOT NULL,
  status TEXT NOT NULL,
  updated_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  assigned_to_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  resolution_code TEXT,
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, exception_id)
);

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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  UNIQUE (organization_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS collection_sources
(
  collection_source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  chain TEXT NOT NULL DEFAULT 'solana',
  asset TEXT NOT NULL DEFAULT 'usdc',
  wallet_address TEXT NOT NULL,
  token_account_address TEXT,
  source_type TEXT NOT NULL DEFAULT 'payer_wallet',
  trust_state TEXT NOT NULL DEFAULT 'unreviewed',
  label TEXT NOT NULL,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, wallet_address),
  UNIQUE (organization_id, label)
);

CREATE TABLE IF NOT EXISTS approval_policies
(
  approval_policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  payment_request_id UUID,
  payment_run_id UUID,
  destination_id UUID NOT NULL REFERENCES destinations(destination_id) ON DELETE RESTRICT,
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  source_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS payment_runs
(
  payment_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  source_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL,
  run_name TEXT NOT NULL,
  input_source TEXT NOT NULL DEFAULT 'manual',
  state TEXT NOT NULL DEFAULT 'draft',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_requests
(
  payment_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  payment_run_id UUID,
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
  UNIQUE (organization_id, destination_id, amount_raw, external_reference)
);

CREATE TABLE IF NOT EXISTS collection_runs
(
  collection_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  receiving_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL,
  run_name TEXT NOT NULL,
  input_source TEXT NOT NULL DEFAULT 'manual',
  state TEXT NOT NULL DEFAULT 'open',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collection_requests
(
  collection_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  collection_run_id UUID REFERENCES collection_runs(collection_run_id) ON DELETE SET NULL,
  receiving_treasury_wallet_id UUID NOT NULL REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE RESTRICT,
  collection_source_id UUID REFERENCES collection_sources(collection_source_id) ON DELETE SET NULL,
  counterparty_id UUID REFERENCES counterparties(counterparty_id) ON DELETE SET NULL,
  transfer_request_id UUID UNIQUE REFERENCES transfer_requests(transfer_request_id) ON DELETE SET NULL,
  payer_wallet_address TEXT,
  payer_token_account_address TEXT,
  amount_raw BIGINT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'usdc',
  reason TEXT NOT NULL,
  external_reference TEXT,
  due_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'open',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, receiving_treasury_wallet_id, amount_raw, external_reference)
);

ALTER TABLE collection_requests
  ADD COLUMN IF NOT EXISTS collection_source_id UUID REFERENCES collection_sources(collection_source_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS collection_request_events
(
  collection_request_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_request_id UUID NOT NULL REFERENCES collection_requests(collection_request_id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  before_state TEXT,
  after_state TEXT,
  linked_transfer_request_id UUID,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_order_events
(
  payment_order_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(payment_order_id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
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
  ADD COLUMN IF NOT EXISTS payment_run_id UUID;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS source_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL;

ALTER TABLE payment_runs
  ADD COLUMN IF NOT EXISTS source_treasury_wallet_id UUID REFERENCES treasury_wallets(treasury_wallet_id) ON DELETE SET NULL;

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS payment_run_id UUID;

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_payment_run_id_fkey;

ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_payment_run_id_fkey
  FOREIGN KEY (payment_run_id) REFERENCES payment_runs(payment_run_id) ON DELETE SET NULL;

ALTER TABLE payment_requests
  DROP CONSTRAINT IF EXISTS payment_requests_payment_run_id_fkey;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_payment_run_id_fkey
  FOREIGN KEY (payment_run_id) REFERENCES payment_runs(payment_run_id) ON DELETE SET NULL;

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
  FOREIGN KEY (destination_id) REFERENCES destinations(destination_id) ON DELETE RESTRICT;

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

ALTER TABLE payment_runs
  DROP CONSTRAINT IF EXISTS chk_payment_runs_state;

ALTER TABLE payment_runs
  ADD CONSTRAINT chk_payment_runs_state CHECK (
    state IN (
      'draft',
      'pending_approval',
      'approved',
      'ready_for_execution',
      'execution_recorded',
      'submitted_onchain',
      'partially_settled',
      'settled',
      'exception',
      'closed',
      'cancelled'
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

ALTER TABLE collection_runs
  DROP CONSTRAINT IF EXISTS chk_collection_runs_state;

ALTER TABLE collection_runs
  ADD CONSTRAINT chk_collection_runs_state CHECK (
    state IN ('open', 'partially_collected', 'collected', 'exception', 'closed', 'cancelled')
  );

ALTER TABLE collection_requests
  DROP CONSTRAINT IF EXISTS chk_collection_requests_state;

ALTER TABLE collection_requests
  ADD CONSTRAINT chk_collection_requests_state CHECK (
    state IN ('open', 'partially_collected', 'collected', 'exception', 'closed', 'cancelled')
  );

ALTER TABLE collection_request_events
  DROP CONSTRAINT IF EXISTS chk_collection_request_events_actor_type;

ALTER TABLE collection_request_events
  ADD CONSTRAINT chk_collection_request_events_actor_type CHECK (
    actor_type IN ('user', 'system', 'worker')
  );

ALTER TABLE collection_sources
  DROP CONSTRAINT IF EXISTS chk_collection_sources_trust_state;

ALTER TABLE collection_sources
  ADD CONSTRAINT chk_collection_sources_trust_state CHECK (
    trust_state IN ('unreviewed', 'trusted', 'restricted', 'blocked')
  );

ALTER TABLE payment_order_events
  DROP CONSTRAINT IF EXISTS chk_payment_order_events_actor_type;

ALTER TABLE payment_order_events
  ADD CONSTRAINT chk_payment_order_events_actor_type CHECK (
    actor_type IN ('user', 'system', 'worker', 'api_key')
  );

ALTER TABLE transfer_request_events
  DROP CONSTRAINT IF EXISTS chk_transfer_request_events_actor_type;

ALTER TABLE transfer_request_events
  ADD CONSTRAINT chk_transfer_request_events_actor_type CHECK (
    actor_type IN ('user', 'system', 'worker', 'api_key')
  );

ALTER TABLE transfer_request_events
  DROP CONSTRAINT IF EXISTS chk_transfer_request_events_event_source;

ALTER TABLE transfer_request_events
  ADD CONSTRAINT chk_transfer_request_events_event_source CHECK (
    event_source IN ('user', 'system', 'worker', 'api_key')
  );

ALTER TABLE approval_decisions
  DROP CONSTRAINT IF EXISTS chk_approval_decisions_actor_type;

ALTER TABLE approval_decisions
  ADD CONSTRAINT chk_approval_decisions_actor_type CHECK (
    actor_type IN ('user', 'system', 'api_key')
  );

ALTER TABLE exception_states
  DROP CONSTRAINT IF EXISTS chk_exception_states_status;

ALTER TABLE exception_states
  ADD CONSTRAINT chk_exception_states_status CHECK (
    status IN ('open', 'reviewed', 'expected', 'dismissed', 'reopened')
  );

DROP TABLE IF EXISTS workspace_objects CASCADE;
DROP TABLE IF EXISTS workspace_labels CASCADE;
DROP TABLE IF EXISTS global_entity_addresses CASCADE;
DROP TABLE IF EXISTS global_entities CASCADE;
DROP TABLE IF EXISTS address_labels CASCADE;
CREATE INDEX IF NOT EXISTS idx_memberships_organization_id ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_invites_org_status_created_at
  ON organization_invites(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organization_invites_email_status
  ON organization_invites(invited_email, status);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id ON auth_sessions(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject ON users(google_subject) WHERE google_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_wallets_user_status_created_at
  ON user_wallets(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_wallets_wallet_address
  ON user_wallets(wallet_address);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_actor_created_at
  ON idempotency_records(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
  ON idempotency_records(expires_at);
CREATE INDEX IF NOT EXISTS idx_organizations_status_created_at ON organizations(organization_id);
CREATE INDEX IF NOT EXISTS idx_treasury_wallets_organization_id ON treasury_wallets(organization_id);
CREATE INDEX IF NOT EXISTS idx_treasury_wallets_address ON treasury_wallets(address);
CREATE INDEX IF NOT EXISTS idx_treasury_wallets_usdc_ata ON treasury_wallets(usdc_ata_address);
CREATE INDEX IF NOT EXISTS idx_wallet_authorizations_org_status
  ON organization_wallet_authorizations(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_authorizations_user_wallet_status
  ON organization_wallet_authorizations(user_wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_authorizations_membership_status
  ON organization_wallet_authorizations(membership_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_organization_id ON transfer_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_payment_order_id ON transfer_requests(payment_order_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_source_treasury_wallet_id ON transfer_requests(source_treasury_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_org_status_requested_at
  ON transfer_requests(organization_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_destination_id
  ON transfer_requests(destination_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_counterparties_organization_created_at
  ON counterparties(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_org_created_at
  ON destinations(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_counterparty_created_at
  ON destinations(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_destinations_wallet_address
  ON destinations(wallet_address);
CREATE INDEX IF NOT EXISTS idx_collection_sources_org_trust_created_at
  ON collection_sources(organization_id, trust_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_sources_counterparty_created_at
  ON collection_sources(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_sources_wallet_address
  ON collection_sources(wallet_address);
CREATE INDEX IF NOT EXISTS idx_approval_policies_organization_id
  ON approval_policies(organization_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_org_created_at
  ON approval_decisions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_request_created_at
  ON approval_decisions(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_execution_records_org_created_at
  ON execution_records(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_records_request_created_at
  ON execution_records(transfer_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_runs_org_state_created_at
  ON payment_runs(organization_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_runs_source_created_at
  ON payment_runs(source_treasury_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_org_state_created_at
  ON payment_orders(organization_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_payment_request_id_unique
  ON payment_orders(payment_request_id)
  WHERE payment_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_orders_payment_request_id
  ON payment_orders(payment_request_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_payment_run_created_at
  ON payment_orders(payment_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_destination_created_at
  ON payment_orders(destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_source_created_at
  ON payment_orders(source_treasury_wallet_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_unique_active_reference
  ON payment_orders(organization_id, destination_id, amount_raw, lower(coalesce(external_reference, invoice_number)))
  WHERE coalesce(external_reference, invoice_number) IS NOT NULL
    AND state NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_payment_order_events_order_created_at
  ON payment_order_events(payment_order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_payment_order_events_org_created_at
  ON payment_order_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_org_state_created_at
  ON payment_requests(organization_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_payment_run_created_at
  ON payment_requests(payment_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_destination_created_at
  ON payment_requests(destination_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_counterparty_created_at
  ON payment_requests(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_runs_org_state_created_at
  ON collection_runs(organization_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_runs_receiving_created_at
  ON collection_runs(receiving_treasury_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_requests_org_state_created_at
  ON collection_requests(organization_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_requests_run_created_at
  ON collection_requests(collection_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_requests_receiving_created_at
  ON collection_requests(receiving_treasury_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_requests_source_created_at
  ON collection_requests(collection_source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_requests_counterparty_created_at
  ON collection_requests(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_request_events_request_created_at
  ON collection_request_events(collection_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_collection_request_events_org_created_at
  ON collection_request_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_events_request_created_at
  ON transfer_request_events(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_events_org_created_at
  ON transfer_request_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_notes_request_created_at
  ON transfer_request_notes(transfer_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_transfer_request_notes_org_created_at
  ON transfer_request_notes(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_notes_exception_created_at
  ON exception_notes(exception_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_exception_notes_org_created_at
  ON exception_notes(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_states_org_exception
  ON exception_states(organization_id, exception_id);
CREATE INDEX IF NOT EXISTS idx_exception_states_org_status_updated_at
  ON exception_states(organization_id, status, updated_at DESC);
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

DROP TRIGGER IF EXISTS trg_organization_invites_updated_at ON organization_invites;
CREATE TRIGGER trg_organization_invites_updated_at
BEFORE UPDATE ON organization_invites
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_wallets_updated_at ON user_wallets;
CREATE TRIGGER trg_user_wallets_updated_at
BEFORE UPDATE ON user_wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_wallet_authorizations_updated_at ON organization_wallet_authorizations;
CREATE TRIGGER trg_wallet_authorizations_updated_at
BEFORE UPDATE ON organization_wallet_authorizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_idempotency_records_updated_at ON idempotency_records;
CREATE TRIGGER trg_idempotency_records_updated_at
BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_treasury_wallets_updated_at ON treasury_wallets;
CREATE TRIGGER trg_treasury_wallets_updated_at
BEFORE UPDATE ON treasury_wallets
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

DROP TRIGGER IF EXISTS trg_collection_sources_updated_at ON collection_sources;
CREATE TRIGGER trg_collection_sources_updated_at
BEFORE UPDATE ON collection_sources
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

DROP TRIGGER IF EXISTS trg_payment_runs_updated_at ON payment_runs;
CREATE TRIGGER trg_payment_runs_updated_at
BEFORE UPDATE ON payment_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payment_requests_updated_at ON payment_requests;
CREATE TRIGGER trg_payment_requests_updated_at
BEFORE UPDATE ON payment_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_collection_runs_updated_at ON collection_runs;
CREATE TRIGGER trg_collection_runs_updated_at
BEFORE UPDATE ON collection_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_collection_requests_updated_at ON collection_requests;
CREATE TRIGGER trg_collection_requests_updated_at
BEFORE UPDATE ON collection_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_exception_states_updated_at ON exception_states;
CREATE TRIGGER trg_exception_states_updated_at
BEFORE UPDATE ON exception_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

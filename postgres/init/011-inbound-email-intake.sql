-- Inbound email invoice intake: each organization gets a readable local part on
-- the receiving domain (acme@bills.decimal.finance) that vendors and AP clerks
-- forward bills to. The receiving domain is a CATCH-ALL, so the `to` address is
-- the only thing identifying the customer — hence the global unique on the slug.
--
-- Every message we receive gets a durable row here BEFORE the webhook responds,
-- accepted or not. That record is what makes "we ignored mail from X, and here
-- is why" answerable; without it, a rejected forward is a black hole.
--
-- Idempotent; applied by scripts/db-setup.sh after 010.

-- ---------------------------------------------------------------------------
-- Organization intake slug
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS intake_slug TEXT;

-- Global uniqueness: the local part IS the address book. Partial index so orgs
-- created before the backfill (or whose minting failed) don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_intake_slug
  ON organizations (intake_slug)
  WHERE intake_slug IS NOT NULL;

-- Shape only. The reserved-word list lives in TypeScript
-- (api/src/payments/inbound-email/slug.ts) so there is exactly one authority
-- for it; the database guards format and uniqueness.
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS chk_organizations_intake_slug;
ALTER TABLE organizations
  ADD CONSTRAINT chk_organizations_intake_slug
  CHECK (intake_slug IS NULL OR intake_slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$');

-- ---------------------------------------------------------------------------
-- Every message we receive, accepted or not
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_email_messages
(
  inbound_email_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT NOT NULL DEFAULT 'resend',
  -- svix-id: the DELIVERY id. The same message redelivered carries the same id.
  provider_event_id        TEXT NOT NULL,
  -- data.email_id: the MESSAGE id. This is the dedupe authority for
  -- "have we already ingested this?" across redeliveries.
  provider_email_id        TEXT,
  -- NULL when the address matched no organization. The row is kept anyway:
  -- that IS the record of mail we received and ignored.
  organization_id          UUID REFERENCES organizations (organization_id) ON DELETE CASCADE,
  to_address               TEXT NOT NULL,
  intake_slug              TEXT,
  -- Parsed from acme+uk@… and stored, but unused in v1. Multi-entity routing is
  -- the natural extension and the data will already be here when it is asked for.
  plus_tag                 TEXT,
  from_address             TEXT NOT NULL,
  from_display             TEXT,
  sender_user_id           UUID REFERENCES users (user_id) ON DELETE SET NULL,
  subject                  TEXT,
  message_id_header        TEXT,
  attachment_count         INTEGER NOT NULL DEFAULT 0,
  disposition              TEXT NOT NULL DEFAULT 'pending',
  disposition_reason       TEXT,
  -- SPF/DKIM/DMARC verdict when the provider supplies one. Captured from day
  -- one, not enforced yet — `from` is spoofable, and enforcing the verdict is
  -- the planned hardening step.
  auth_results_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pending            → row written, attachments queued
-- accepted           → every accepted attachment ingested
-- partially_accepted → at least one ingested, others skipped or failed
-- rejected           → unknown_org | org_inactive | sender_not_member
--                      | no_attachments | no_supported_attachments | malformed_payload
-- failed             → attachment_fetch_exhausted
ALTER TABLE inbound_email_messages
  DROP CONSTRAINT IF EXISTS chk_inbound_email_messages_disposition;
ALTER TABLE inbound_email_messages
  ADD CONSTRAINT chk_inbound_email_messages_disposition
  CHECK (disposition IN ('pending', 'accepted', 'partially_accepted', 'rejected', 'failed'));

-- Redelivery of the same MESSAGE never re-ingests.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_messages_email
  ON inbound_email_messages (provider, provider_email_id)
  WHERE provider_email_id IS NOT NULL;
-- Redelivery of the same DELIVERY never double-writes (belt and braces).
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_messages_event
  ON inbound_email_messages (provider, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_inbound_email_messages_org_received
  ON inbound_email_messages (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_email_messages_disposition
  ON inbound_email_messages (disposition, received_at DESC);

DROP TRIGGER IF EXISTS trg_inbound_email_messages_updated_at ON inbound_email_messages;
CREATE TRIGGER trg_inbound_email_messages_updated_at
BEFORE UPDATE ON inbound_email_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- One row per attachment = the retry queue.
--
-- Bytes are deliberately NOT stored here. Resend's webhook carries attachment
-- metadata only, so fetching the bytes is a separate network call that can
-- fail; this table is what lets a sweep retry it. Once ingested the bytes live
-- exactly once, in invoice_documents.data, deduped by sha256.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_email_attachments
(
  inbound_email_attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_message_id    UUID NOT NULL
    REFERENCES inbound_email_messages (inbound_email_message_id) ON DELETE CASCADE,
  provider_attachment_id      TEXT NOT NULL,
  filename                    TEXT NOT NULL,
  content_type                TEXT,
  content_disposition         TEXT,
  byte_size                   INTEGER,
  status                      TEXT NOT NULL DEFAULT 'pending',
  status_reason               TEXT,
  invoice_document_id         UUID REFERENCES invoice_documents (invoice_document_id) ON DELETE SET NULL,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbound_email_message_id, provider_attachment_id)
);

-- pending  → queued for the sweep
-- ingested → handed to the invoice pipeline (invoice_document_id set)
-- skipped  → deliberately not a bill (inline logo, unsupported type, too large)
-- failed   → fetch burned its retry budget
ALTER TABLE inbound_email_attachments
  DROP CONSTRAINT IF EXISTS chk_inbound_email_attachments_status;
ALTER TABLE inbound_email_attachments
  ADD CONSTRAINT chk_inbound_email_attachments_status
  CHECK (status IN ('pending', 'ingested', 'skipped', 'failed'));

CREATE INDEX IF NOT EXISTS idx_inbound_email_attachments_queue
  ON inbound_email_attachments (status, next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbound_email_attachments_message
  ON inbound_email_attachments (inbound_email_message_id);

DROP TRIGGER IF EXISTS trg_inbound_email_attachments_updated_at ON inbound_email_attachments;
CREATE TRIGGER trg_inbound_email_attachments_updated_at
BEFORE UPDATE ON inbound_email_attachments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

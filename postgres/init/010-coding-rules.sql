-- Vendor coding defaults (GL-coding synthesis D2): vendor memory as an
-- INSPECTABLE object. Auto-promoted from agreeing coding history ("learned"),
-- or set by hand ("manual" — never auto-changed). One rule per vendor per
-- accounting provider; the coding waterfall consults it first.
CREATE TABLE IF NOT EXISTS vendor_coding_rules
(
  vendor_coding_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  counterparty_id       UUID NOT NULL REFERENCES counterparties (counterparty_id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'quickbooks',
  account_id            TEXT NOT NULL,
  account_name          TEXT,
  source                TEXT NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'manual')),
  learned_from_count    INTEGER NOT NULL DEFAULT 0,
  set_by_user_id        UUID REFERENCES users (user_id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, counterparty_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_vendor_coding_rules_org
  ON vendor_coding_rules (organization_id, updated_at DESC);

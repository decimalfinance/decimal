-- Connecting QuickBooks lets Decimal read. Writing to a customer's books takes a
-- person's separate yes (2026-11-01), recorded here: who turned posting on, and
-- when. Null means posting is off, which is where every existing connection
-- starts. Bills approved before that moment do not post by themselves.
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS posting_enabled_at timestamptz;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS posting_enabled_by_user_id uuid REFERENCES users (user_id) ON DELETE SET NULL;

-- Learning you can see.
--
-- A category habit names the people who taught it (whose confirmed bills
-- agreed), and is announced once to whoever codes bills (bill clerks, admins) — "I learned: Brightwave goes to
-- Marketing, from 3 bills Priya coded that way" — until one of them keeps or
-- forgets it. Changing the habit announces it again.
ALTER TABLE vendor_coding_rules ADD COLUMN IF NOT EXISTS taught_by JSONB NOT NULL DEFAULT '[]';
ALTER TABLE vendor_coding_rules ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE vendor_coding_rules ADD COLUMN IF NOT EXISTS acknowledged_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL;

-- A habit someone told the companion to forget. Without this, the next
-- confirmed bill would teach it straight back from the same history; with it,
-- only bills confirmed AFTER the forget can teach it again.
CREATE TABLE IF NOT EXISTS forgotten_habits
(
  organization_id      UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  counterparty_id      UUID NOT NULL REFERENCES counterparties (counterparty_id) ON DELETE CASCADE,
  account_name         TEXT,
  forgotten_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  forgotten_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, counterparty_id)
);

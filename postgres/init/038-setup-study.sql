-- What a setup learned about a company, and what it asked the person.

-- The company this setup is about, who said it was the right one, and how the
-- study of it went. A sign-in to a different company clears all of these.
ALTER TABLE integration_setups
  ADD COLUMN IF NOT EXISTS company_id TEXT,
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS company_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS company_confirmed_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  -- null until asked for; then running, finished or failed.
  ADD COLUMN IF NOT EXISTS study_status TEXT,
  ADD COLUMN IF NOT EXISTS study_lease_until TIMESTAMPTZ,
  -- Tries since the last sign-in.
  ADD COLUMN IF NOT EXISTS study_attempts INTEGER NOT NULL DEFAULT 0,
  -- What it has read so far, for the live steps: [{key, text, at}].
  ADD COLUMN IF NOT EXISTS study_steps JSONB NOT NULL DEFAULT '[]',
  -- Why the last try failed: {kind, message}.
  ADD COLUMN IF NOT EXISTS study_error JSONB,
  ADD COLUMN IF NOT EXISTS findings JSONB,
  -- What the person's calls come to. Set when they say go; fixed code reads it.
  ADD COLUMN IF NOT EXISTS outcome JSONB;

-- Built by code, never written by the model: the buttons on a message, and the
-- sentences that open the records behind them.
ALTER TABLE integration_setup_messages
  ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS claims JSONB NOT NULL DEFAULT '[]';

-- What only the person can decide. One row per call, so a repeated turn cannot
-- ask twice or lose an answer.
CREATE TABLE IF NOT EXISTS integration_setup_calls
(
  setup_id            UUID NOT NULL REFERENCES integration_setups (setup_id) ON DELETE CASCADE,
  key                 TEXT NOT NULL,
  -- closing_date, who_approves, lookalike_vendors, coded_two_ways,
  -- approved_before_connecting or other.
  kind                TEXT NOT NULL,
  question            TEXT NOT NULL,
  recommendation      TEXT,
  why                 TEXT,
  -- The records behind it, as refs: ["vendor:56", "bill:1041"].
  refs                JSONB NOT NULL DEFAULT '[]',
  -- Opened by code rather than the model: go waits on these.
  required            BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'open',
  answer              TEXT,
  -- The part of an answer fixed code can use: {date}, {useVendorId}, {categoryId}.
  value               JSONB,
  answer_message_id   UUID REFERENCES integration_setup_messages (message_id) ON DELETE SET NULL,
  answered_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  answered_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (setup_id, key)
);

-- A copy of a company's records, in one shape across systems. The model asks this,
-- not the live system, so what it sees is what was counted. Deleted on disconnect.
CREATE TABLE IF NOT EXISTS books_records
(
  organization_id UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  system          TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  -- category, vendor, bill or expense.
  kind            TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  -- The columns a lookup filters on. Everything else is in data.
  date            DATE,
  name            TEXT,
  party_id        TEXT,
  amount_minor    BIGINT,
  currency        TEXT,
  search_text     TEXT NOT NULL DEFAULT '',
  data            JSONB NOT NULL,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, system, company_id, kind, record_id)
);

CREATE INDEX IF NOT EXISTS books_records_by_party
  ON books_records (organization_id, system, company_id, kind, party_id);

-- A setup is a chat between one person and the Decimal agent that connects an
-- accounting system. The model picks its next step. This is what survives between
-- steps, so a restart only repeats a turn and nothing lives in a process.

CREATE TABLE IF NOT EXISTS integration_setups
(
  setup_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  system               TEXT NOT NULL,
  started_by_user_id   UUID REFERENCES users (user_id) ON DELETE SET NULL,
  -- open: under way. stopped: it hit a limit, said so, and its record waits.
  -- done: a person said go.
  status               TEXT NOT NULL DEFAULT 'open',
  -- token_limit, turn_limit or failures, while stopped.
  stop_reason          TEXT,
  -- Whoever holds the turn, until when. A process that dies lets go by itself.
  turn_lease_until     TIMESTAMPTZ,
  -- Every event up to here has had its turn.
  handled_through_seq  BIGINT NOT NULL DEFAULT 0,
  -- Turns in a row that ended without an answer.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  tokens_used          BIGINT NOT NULL DEFAULT 0,
  turns_used           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One setup under way per organisation and system.
CREATE UNIQUE INDEX IF NOT EXISTS integration_setups_one_live
  ON integration_setups (organization_id, system) WHERE status IN ('open', 'stopped');

-- What the person and the agent said to each other.
CREATE TABLE IF NOT EXISTS integration_setup_messages
(
  message_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id       UUID NOT NULL REFERENCES integration_setups (setup_id) ON DELETE CASCADE,
  -- user or assistant.
  role           TEXT NOT NULL,
  -- running while the agent works on it; then done or failed.
  status         TEXT NOT NULL DEFAULT 'done',
  author_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  text           TEXT NOT NULL DEFAULT '',
  -- What the agent looked at, as it looked: [{text, detail, at}].
  thoughts       JSONB NOT NULL DEFAULT '[]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_setup_messages_by_setup
  ON integration_setup_messages (setup_id, created_at);

-- The receipt: everything that happened, in order, and never edited. A waking
-- event also asks for a turn: a message, the sign-in coming back.
CREATE TABLE IF NOT EXISTS integration_setup_events
(
  seq           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setup_id      UUID NOT NULL REFERENCES integration_setups (setup_id) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Null means Decimal.
  actor_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  wakes         BOOLEAN NOT NULL DEFAULT FALSE,
  payload       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS integration_setup_events_by_setup
  ON integration_setup_events (setup_id, seq);

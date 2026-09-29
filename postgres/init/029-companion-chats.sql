-- Conversations with the companion.
--
-- A chat belongs to the person who started it. Each turn is a message: the
-- person's words, or the companion's answer. An answer is written while it is
-- being worked out — its thoughts (each thing it looked at) are appended as
-- they happen, so the screen can show the work, and it is marked done when the
-- answer is in.
CREATE TABLE IF NOT EXISTS companion_chats
(
  chat_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS companion_chats_owner_idx
  ON companion_chats (organization_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS companion_messages
(
  message_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID NOT NULL REFERENCES companion_chats (chat_id) ON DELETE CASCADE,
  -- 'user' or 'assistant'.
  role        TEXT NOT NULL,
  -- running while the companion works on an answer; then done or failed.
  status      TEXT NOT NULL DEFAULT 'done',
  text        TEXT NOT NULL DEFAULT '',
  -- What the companion looked at, in order: [{text, detail, at}].
  thoughts    JSONB NOT NULL DEFAULT '[]',
  -- Structured parts of an answer: tables and the bills it rests on.
  blocks      JSONB NOT NULL DEFAULT '{}',
  model       TEXT,
  latency_ms  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS companion_messages_chat_idx
  ON companion_messages (chat_id, created_at);

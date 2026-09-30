-- Line memory: a line the companion was told to forget.
--
-- Categories are remembered per KIND OF LINE (line-memory.ts), learned from the
-- lines people settle. Forgetting one records its key (the words that say what
-- the line is), so lines settled BEFORE the forget no longer teach it; lines
-- settled after it do, the same way forgetting a vendor habit worked.
CREATE TABLE IF NOT EXISTS forgotten_lines
(
  organization_id      UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  line_key             TEXT NOT NULL,
  description          TEXT NOT NULL,
  category             TEXT,
  forgotten_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  forgotten_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, line_key)
);

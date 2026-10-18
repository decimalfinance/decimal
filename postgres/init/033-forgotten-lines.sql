-- Line memory: a line the companion was told to forget.
--
-- Categories are remembered per VENDOR + KIND OF LINE (line-memory.ts), learned
-- from the lines people settle. Forgetting one records the vendor and the
-- line's key (the words that say what the line is), so that vendor's lines
-- settled BEFORE the forget no longer teach it; lines settled after it do.
CREATE TABLE IF NOT EXISTS forgotten_lines
(
  organization_id      UUID NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  counterparty_id      UUID NOT NULL REFERENCES counterparties (counterparty_id) ON DELETE CASCADE,
  line_key             TEXT NOT NULL,
  description          TEXT NOT NULL,
  category             TEXT,
  forgotten_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  forgotten_by_user_id UUID REFERENCES users (user_id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, counterparty_id, line_key)
);

-- Until 2026-10-19 a line was learned from any vendor, so a forget named none.
-- Each such forget becomes one for every vendor whose bills carry a line worded
-- exactly as the forgotten one (the line What I know showed when it was
-- forgotten). A forget that matches no bill is dropped: nothing is left for it
-- to stop. Runs once, while the column is missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'forgotten_lines' AND column_name = 'counterparty_id') THEN
    ALTER TABLE forgotten_lines ADD COLUMN counterparty_id UUID REFERENCES counterparties (counterparty_id) ON DELETE CASCADE;
    ALTER TABLE forgotten_lines DROP CONSTRAINT forgotten_lines_pkey;
    INSERT INTO forgotten_lines (organization_id, counterparty_id, line_key, description, category, forgotten_at, forgotten_by_user_id)
    SELECT DISTINCT f.organization_id, po.counterparty_id, f.line_key, f.description, f.category, f.forgotten_at, f.forgotten_by_user_id
    FROM forgotten_lines f
    JOIN payment_orders po ON po.organization_id = f.organization_id AND po.counterparty_id IS NOT NULL
    WHERE f.counterparty_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(po.metadata_json -> 'verification' -> 'lines') = 'array'
               THEN po.metadata_json -> 'verification' -> 'lines'
               ELSE '[]'::jsonb END) AS line
        WHERE lower(btrim(line ->> 'description')) = lower(btrim(f.description)));
    DELETE FROM forgotten_lines WHERE counterparty_id IS NULL;
    ALTER TABLE forgotten_lines ALTER COLUMN counterparty_id SET NOT NULL;
    ALTER TABLE forgotten_lines ADD PRIMARY KEY (organization_id, counterparty_id, line_key);
  END IF;
END $$;

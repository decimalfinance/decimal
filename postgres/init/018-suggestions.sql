-- What we suggested, and what the human did about it.
--
-- We record the value that was chosen but not the one we PROPOSED, so nothing
-- can answer "how often is the suggestion right?", "is its confidence
-- calibrated?", or "which vendors do people always override us on?". Those
-- questions cannot be answered retroactively: the suggestion is gone, and the
-- features that produced it are gone with it.
--
-- Two linked append-only rows, never one mutable row:
--
--   suggestion  written UNCONDITIONALLY the moment we propose something,
--               whatever the human later does. Without this the data has no
--               negatives — you cannot tell "we were right and nobody needed to
--               act" from "we were never asked" from "we were overridden and
--               nobody wrote it down".
--   outcome     what the human did, referencing the suggestion.
--
-- The inputs are snapshotted at suggestion time rather than reconstructed
-- later, because rebuilding "what did the model know at time T" from other
-- tables is fragile and quietly wrong once anything upstream changes.
CREATE TABLE IF NOT EXISTS ai_suggestions
(
  ai_suggestion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (organization_id),
  -- What kind of suggestion: 'question_fields', 'gl_coding', 'ask_recipient'.
  stage            TEXT NOT NULL,
  -- What it was about, loosely coupled on purpose — a suggestion may concern a
  -- bill, a question, or something that does not exist yet.
  subject_type     TEXT NOT NULL,
  subject_id       UUID,
  suggested        JSONB NOT NULL,
  confidence       DOUBLE PRECISION,
  -- Which model or rule produced it, so a change in behaviour is attributable
  -- to a change in us rather than a change in the world.
  producer         TEXT NOT NULL,
  inputs           JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_suggestion_outcomes
(
  ai_suggestion_outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_suggestion_id UUID NOT NULL REFERENCES ai_suggestions (ai_suggestion_id),
  -- 'accepted'  taken as offered
  -- 'edited'    kept but changed — the most informative outcome we get, because
  --             the delta says exactly where we were wrong
  -- 'rejected'  discarded entirely
  outcome          TEXT NOT NULL CHECK (outcome IN ('accepted', 'edited', 'rejected')),
  final_value      JSONB,
  decided_by_user_id UUID REFERENCES users (user_id),
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_stage
  ON ai_suggestions (organization_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_subject
  ON ai_suggestions (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_outcomes_suggestion
  ON ai_suggestion_outcomes (ai_suggestion_id);

-- Append-only, by trigger rather than by grant — the application connects as
-- the owner, and owners bypass REVOKE.
CREATE OR REPLACE FUNCTION forbid_suggestion_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'suggestion records are append-only: what we proposed cannot be rewritten afterwards';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_suggestions_immutable ON ai_suggestions;
CREATE TRIGGER trg_ai_suggestions_immutable
  BEFORE UPDATE OR DELETE ON ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION forbid_suggestion_mutation();

DROP TRIGGER IF EXISTS trg_ai_suggestion_outcomes_immutable ON ai_suggestion_outcomes;
CREATE TRIGGER trg_ai_suggestion_outcomes_immutable
  BEFORE UPDATE OR DELETE ON ai_suggestion_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_suggestion_mutation();

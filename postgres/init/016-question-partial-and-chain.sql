-- Partial answers, and questions that get passed along.
--
-- A question about four fields is rarely all-or-nothing. Someone knows the
-- street and not the ZIP; someone knows none of it but knows who does. Forcing
-- that into "answered" or "couldn't answer" throws away the useful half and
-- makes the asker chase what was already handled.
--
-- resolved_fields  which of the asked fields this reply actually settled
-- forwarded_to     the question raised when passing it on, so a chain reads
--                  end to end instead of looking like unrelated questions
ALTER TABLE bill_questions
  ADD COLUMN IF NOT EXISTS resolved_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS forwarded_to_question_id UUID REFERENCES bill_questions (bill_question_id),
  ADD COLUMN IF NOT EXISTS forwarded_from_question_id UUID REFERENCES bill_questions (bill_question_id);

ALTER TABLE bill_questions DROP CONSTRAINT IF EXISTS bill_questions_outcome_check;
ALTER TABLE bill_questions ADD CONSTRAINT bill_questions_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('answered', 'partial', 'handed_back', 'forwarded'));

CREATE INDEX IF NOT EXISTS idx_bill_questions_chain
  ON bill_questions (forwarded_from_question_id);

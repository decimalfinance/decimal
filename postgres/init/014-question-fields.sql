-- Which form fields a question is about, so the person asked can be shown
-- exactly where to look instead of reading a sentence and hunting.
--
-- Nullable and defaulted to empty: a question without a mapping is still a
-- perfectly good question, and the screen must behave normally without one.
ALTER TABLE bill_questions
  ADD COLUMN IF NOT EXISTS highlight_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

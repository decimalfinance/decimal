-- How a question ended, not just that it ended.
--
-- "I don't know man, it's all you" closed a question as ANSWERED. The asker's
-- concern was untouched, the fields they wanted checked went back to normal,
-- and the record claimed it was resolved — worse than never asking, because it
-- manufactures confidence nobody earned.
--
-- 'answered'    the person confirmed or corrected what was asked
-- 'handed_back' a real reply that does not resolve it ("I don't know", "ask X")
ALTER TABLE bill_questions
  ADD COLUMN IF NOT EXISTS outcome TEXT;

ALTER TABLE bill_questions DROP CONSTRAINT IF EXISTS bill_questions_outcome_check;
ALTER TABLE bill_questions ADD CONSTRAINT bill_questions_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('answered', 'handed_back'));

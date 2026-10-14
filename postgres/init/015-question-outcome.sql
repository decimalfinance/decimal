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

-- The allowed outcomes are defined once, in 034-open-questions.sql. Every file
-- re-runs on every startup, so a narrower list here would refuse rows the later
-- files allow.

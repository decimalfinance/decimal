-- How much of a question the flag it was raised from would answer.
--
-- 'covered_by_flag' means settling the check answers the whole question, so the
-- deed that settles the check settles the question too. 'asks_more' means it
-- asked something the check's own resolution would not address, and closing it
-- on the clearance would drop that with no trace.
--
-- Judged once, when the question is written, and kept here. That is what makes
-- resolution a join rather than a judgement repeated per edit: the same deed
-- settles the same questions today and next year, which is what an audit trail
-- is for.
--
-- Null on every question asked before this existed. Those are read as
-- 'asks_more' — a person answers them, exactly as they do today.
ALTER TABLE bill_questions
  ADD COLUMN IF NOT EXISTS question_scope TEXT;

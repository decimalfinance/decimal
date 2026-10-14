-- Questions hold nothing (2026-10-14). Asking a colleague about a bill no longer
-- parks it: anyone who works on bills may answer, and the asker may close their
-- own question. So the record says who answered, which is no longer always the
-- person asked, and when the asker dealt with the reply in their Inbox.
ALTER TABLE bill_questions ADD COLUMN IF NOT EXISTS answered_by_user_id uuid;
ALTER TABLE bill_questions ADD COLUMN IF NOT EXISTS asker_done_at timestamptz;

-- How a question ended. The one place the list is defined (015 and 016 used to
-- redefine it, narrower, on every startup).
--
-- 'answered'    somebody who works on bills answered it
-- 'handed_back' the person asked could not answer; it goes back to the asker
-- 'forwarded'   the person asked passed it on; a linked question carries on
-- 'closed'      the asker closed it themselves, with an optional note
-- 'partial'     no longer written; kept for rows from before 2026-10-14
ALTER TABLE bill_questions DROP CONSTRAINT IF EXISTS bill_questions_outcome_check;
ALTER TABLE bill_questions ADD CONSTRAINT bill_questions_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('answered', 'handed_back', 'forwarded', 'closed', 'partial'));

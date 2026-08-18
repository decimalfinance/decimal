-- A recall stops being a button and becomes a request an admin answers.
--
-- Recall destroys collected approvals. A bill sitting at two of four approved
-- has two people's judgement recorded against it, and the old recall threw
-- both away the instant the requester clicked, with no reason captured and
-- nobody asked. That is a large, silent, unattributable act.
--
-- The research in `approvals and research/review-vs-approve/recall-and-withdraw.md`
-- found no product that lets the submitter do this alone: fourteen products,
-- and every one of them gates withdrawal by role or offers a second admin
-- path. Salesforce, which has the closest thing to a named submitter recall,
-- documents the other half of its own switch as "only administrators can
-- recall approval requests".
--
-- So: the requester asks and states why, the bill freezes on the spot, and an
-- admin decides. Three outcomes, and two of them cost nothing:
--
--   granted  -> the recall happens, approvals invalidated, bill back to draft
--   denied   -> the bill resumes exactly where it stood, approvals intact
--   withdrawn-> the requester changed their mind, same as denied
--
-- Freezing on the request rather than on the decision is the point. Without
-- it a third approver can approve into a bill everyone already knows is
-- wrong, and the recall then destroys three approvals instead of two.
--
-- The pause reuses the engine's existing 'on_hold' macro state; nothing new
-- is added to the state machine.
CREATE TABLE IF NOT EXISTS approval.recall_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(organization_id),
  approvable_id    uuid NOT NULL REFERENCES approval.approvables(id),
  requested_by     uuid NOT NULL REFERENCES approval.people(id),
  reason           text NOT NULL,
  state            text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'granted', 'denied', 'withdrawn')),

  -- What the bill was doing when we froze it. A denial has to put it back
  -- where it was, and that is not always 'pending_approval' — a bill parked
  -- in 'returned_for_info' waiting on an answer must return to waiting on
  -- that answer, not silently rejoin the approval queue.
  paused_from      text NOT NULL,

  decided_by       uuid REFERENCES approval.people(id),
  decided_at       timestamptz,
  decision_note    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One open request per bill. Two people asking at once, or one person asking
-- twice, would leave two rows racing to unfreeze the same bill — and the
-- second grant would recall a bill already back in draft. The partial index
-- makes that a constraint violation rather than a bug to discover later.
CREATE UNIQUE INDEX IF NOT EXISTS recall_requests_one_open
  ON approval.recall_requests (approvable_id) WHERE state = 'pending';

-- The admin's queue: "what is waiting on me". Partial, because decided rows
-- are history and nobody pages through them to find work.
CREATE INDEX IF NOT EXISTS recall_requests_pending_by_org
  ON approval.recall_requests (organization_id) WHERE state = 'pending';

-- The bill's own history: every request ever raised against it, newest first.
CREATE INDEX IF NOT EXISTS recall_requests_by_approvable
  ON approval.recall_requests (approvable_id, created_at DESC);

-- Decided is final. A granted request cannot be re-granted, and a denial
-- cannot be quietly flipped to a grant after the fact — raise a new request,
-- which leaves both the refusal and the second ask in the record. Without
-- this the decision is editable, and an editable decision is not evidence.
CREATE OR REPLACE FUNCTION approval.recall_requests_decide_once() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'recall request % is already %', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recall_requests_decide_once ON approval.recall_requests;
CREATE TRIGGER trg_recall_requests_decide_once
  BEFORE UPDATE ON approval.recall_requests
  FOR EACH ROW EXECUTE FUNCTION approval.recall_requests_decide_once();

-- Pipeline Control, phase 1: Review becomes a first-class configurable stage
-- alongside Approve and Release, and separation-of-duties becomes the org's own
-- choice (three switches) rather than a rule we hardcode. Idempotent.

-- 1) Separation-of-duties switches. Defaults preserve today's behavior (fully
--    separated): the engine's R1/R2/R5 exclusions are ON unless the org opts out.
--      reviewer_can_approve   → R2 (the person who entered/coded a bill may approve it)
--      submitter_can_approve  → R1 (a person may approve their own bill; +R7 vendor_change)
--      approver_can_release   → R5 (an approver of a bill may also release its payment)
ALTER TABLE approval.org_settings
  ADD COLUMN IF NOT EXISTS reviewer_can_approve  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS submitter_can_approve boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approver_can_release  boolean NOT NULL DEFAULT false;

-- 2) Review as an approvable type (phase 2 spawns real review approvables; adding
--    it now is forward-compat and harmless for phase 1's review policy set).
ALTER TABLE approval.approvables DROP CONSTRAINT IF EXISTS approvables_type_check;
ALTER TABLE approval.approvables ADD CONSTRAINT approvables_type_check
  CHECK (type IN ('invoice','vendor_change','payment_run','po','review'));

-- 3) The flow-builder draft now keys by (org, kind) so the review flow gets the
--    same survives-navigation draft autosave as the approval flow.
ALTER TABLE approval.flow_drafts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'invoice';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'approval.flow_drafts'::regclass AND contype = 'p'
      AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE approval.flow_drafts DROP CONSTRAINT flow_drafts_pkey;
    ALTER TABLE approval.flow_drafts ADD CONSTRAINT flow_drafts_pkey PRIMARY KEY (organization_id, kind);
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'approval.flow_drafts'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE approval.flow_drafts ADD CONSTRAINT flow_drafts_pkey PRIMARY KEY (organization_id, kind);
  END IF;
END $$;

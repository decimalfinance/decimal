-- Reviewer becomes Bill Clerk.
--
-- "Reviewer" named a stage we have since established does not exist: the
-- reviewing happens at approval, and what comes before it is preparation. The
-- role was never really about reviewing anything — it enters and codes bills,
-- which every AP product in the roles research calls a clerk or processor
-- (Bill.com: Clerk. QuickBooks: Bill Clerk. Tipalti: AP Clerk. Stampli:
-- Requester). Borrowing the name people already know beats inventing one.
--
-- The role's permissions do not change. Only the word does.
--
-- Idempotent: the constraint is dropped, the rows converted, the constraint
-- re-added with the new vocabulary. A database already on the new names has no
-- 'reviewer' rows to convert and re-adds the same constraint.
ALTER TABLE approval.person_roles
  DROP CONSTRAINT IF EXISTS person_roles_role_check;

UPDATE approval.person_roles SET role = 'bill_clerk' WHERE role = 'reviewer';

ALTER TABLE approval.person_roles
  ADD CONSTRAINT person_roles_role_check
  CHECK (role IN ('bill_clerk', 'approver', 'payer', 'viewer'));

-- The separation setting named after the old role follows it.
--
--   reviewer_can_approve -> clerk_can_approve
--
-- Same rule (R2: the person who entered a bill may not approve it), same
-- default. Renamed so the column agrees with the role it is about.
--
-- Copy-then-drop rather than RENAME, because 006 runs first and has already
-- created clerk_can_approve by the time this file executes — renaming into an
-- existing column fails. Guarded on the old column, so a converted database
-- skips it entirely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'approval' AND table_name = 'org_settings'
      AND column_name = 'reviewer_can_approve'
  ) THEN
    UPDATE approval.org_settings SET clerk_can_approve = reviewer_can_approve;
    ALTER TABLE approval.org_settings DROP COLUMN reviewer_can_approve;
  END IF;
END $$;

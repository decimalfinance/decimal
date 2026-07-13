-- Approval roles = permission-free named seats the org creates and routing points
-- at (CFO, Finance, Budget owner…). They reuse the engine's existing seat table;
-- this flag distinguishes them from the internal quorum seats (approvers/keyholders)
-- so the Members & roles UI only shows the ones a human made. Idempotent.
ALTER TABLE approval.seats
  ADD COLUMN IF NOT EXISTS is_approval_role BOOLEAN NOT NULL DEFAULT FALSE;

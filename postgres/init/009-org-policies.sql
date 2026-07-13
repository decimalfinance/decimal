-- Org-wide policy settings beyond SoD flags (SYNTHESIS-decimal-policies.md P1).
-- bill_ceiling_minor: hard org ceiling — bills over this amount (USDC minor
-- units) are blocked from leaving Review and from release. NULL = no ceiling.
ALTER TABLE approval.org_settings
  ADD COLUMN IF NOT EXISTS bill_ceiling_minor bigint;

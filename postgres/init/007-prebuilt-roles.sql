-- Prebuilt roles (roles-research/SYNTHESIS-decimal-roles.md). Roles stop being
-- permission-free seat labels and become fixed permission bundles: reviewer,
-- approver, payer, viewer (owner/admin come from the membership). A person may
-- hold several roles; access = union. Idempotent.

CREATE TABLE IF NOT EXISTS approval.person_roles (
  organization_id uuid NOT NULL REFERENCES organizations(organization_id),
  person_id       uuid NOT NULL REFERENCES approval.people(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('reviewer','approver','payer','viewer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, person_id, role)
);

-- Carry over legacy free-form role seats whose names already match a prebuilt
-- role (case-insensitive). Non-matching labels (e.g. "CFO") are dropped — the
-- owner re-assigns from the fixed set.
INSERT INTO approval.person_roles (organization_id, person_id, role)
SELECT h.organization_id, sa.person_id, lower(s.name)
FROM approval.seat_assignments sa
JOIN approval.seats s ON s.id = sa.seat_id AND s.is_approval_role = true
JOIN approval.nodes n ON n.id = s.node_id
JOIN approval.hierarchies h ON h.id = n.hierarchy_id
WHERE lower(s.name) IN ('reviewer','approver','payer','viewer')
  AND (sa.eff_to IS NULL OR sa.eff_to > now())
ON CONFLICT DO NOTHING;

-- Admins/primary admins hold every capability, so pipeline roles on them are
-- dead weight (Ramp's rule: admin takes no add-on roles). The app refuses new
-- assignments and sheds roles on promotion; this keeps re-runs self-healing.
DELETE FROM approval.person_roles pr
USING approval.people p, organization_memberships om
WHERE p.id = pr.person_id
  AND om.organization_id = pr.organization_id AND om.user_id = p.user_id
  AND om.status = 'active' AND om.role IN ('owner','admin');

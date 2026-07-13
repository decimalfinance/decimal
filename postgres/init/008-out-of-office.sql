-- Out-of-office fill-ins (flow-research P1, Vic.ai's shadow-substitute model).
-- One row per person per org: while active, their newly opened approval tasks
-- gain a fill-in task for the substitute (and their open ones are mirrored at
-- scheduling time). Idempotent.
CREATE TABLE IF NOT EXISTS approval.out_of_office (
  organization_id      uuid NOT NULL REFERENCES organizations(organization_id),
  person_id            uuid NOT NULL REFERENCES approval.people(id) ON DELETE CASCADE,
  substitute_person_id uuid NOT NULL REFERENCES approval.people(id) ON DELETE CASCADE,
  starts_at            timestamptz NOT NULL DEFAULT now(),
  ends_at              timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, person_id),
  CHECK (substitute_person_id <> person_id),
  CHECK (ends_at > starts_at)
);

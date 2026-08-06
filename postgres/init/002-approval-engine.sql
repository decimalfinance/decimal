-- =============================================================================
-- 002 — APPROVAL ENGINE SCHEMA
-- This file is the canonical schema for the approval engine. Notable choices:
--   * Engine tables live in the `approval` Postgres schema (control plane owns
--     `public`); org identity is public.organizations, not a new orgs table —
--     per-org engine settings live in approval.org_settings.
--   * approval.people carries an optional user_id -> public.users link
--     (approvers may exist before they ever log in).
--   * approvable_lines has `description` (engine Amendment 4, 2026-07-05:
--     coding-precedent memory embeds line text; it must live in the log's reach).
--   * Idempotent throughout — db-setup.sh re-applies this file on every boot.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS approval;

-- ---------------------------------------------------------------------------
-- Org settings (design's `orgs` table, minus identity — that is public.organizations)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.org_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(organization_id),
  base_currency   char(3) NOT NULL DEFAULT 'USD',  -- Amendment 3: grants compare in this
  headcount       int NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- L1 · Hierarchy substrate
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.people (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(organization_id),
  user_id         uuid REFERENCES users(user_id),
  name            text NOT NULL,
  email           text NOT NULL,
  external        boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS approval.hierarchies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(organization_id),
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN
                        ('reporting','cost_center','legal_entity','project','department','custom')),
  allows_multi_parent boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'))
);

CREATE TABLE IF NOT EXISTS approval.nodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hierarchy_id uuid NOT NULL REFERENCES approval.hierarchies(id),
  name         text NOT NULL,
  external_ref text,                         -- GL segment / QBO class
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'))
);

CREATE TABLE IF NOT EXISTS approval.node_edges (
  child_id  uuid NOT NULL REFERENCES approval.nodes(id),
  parent_id uuid NOT NULL REFERENCES approval.nodes(id),
  kind      text NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','dotted')),
  eff_from  timestamptz NOT NULL DEFAULT now(),
  eff_to    timestamptz,                     -- NULL = current
  PRIMARY KEY (child_id, parent_id, eff_from),
  CHECK (child_id <> parent_id)
);

-- DB-INVARIANT: edges stay within one hierarchy.
CREATE OR REPLACE FUNCTION approval.check_edge_same_hierarchy() RETURNS trigger AS $$
BEGIN
  IF (SELECT hierarchy_id FROM approval.nodes WHERE id = NEW.child_id)
     <> (SELECT hierarchy_id FROM approval.nodes WHERE id = NEW.parent_id) THEN
    RAISE EXCEPTION 'edge crosses hierarchies';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_edge_same_hierarchy ON approval.node_edges;
CREATE TRIGGER trg_edge_same_hierarchy BEFORE INSERT OR UPDATE ON approval.node_edges
  FOR EACH ROW EXECUTE FUNCTION approval.check_edge_same_hierarchy();

-- DB-INVARIANT: no cycles among *active* edges (walk ancestors of new parent).
CREATE OR REPLACE FUNCTION approval.check_edge_acyclic() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE anc(id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT e.parent_id FROM approval.node_edges e JOIN anc ON e.child_id = anc.id
      WHERE e.eff_to IS NULL
    )
    SELECT 1 FROM anc WHERE id = NEW.child_id
  ) THEN
    RAISE EXCEPTION 'cycle detected in hierarchy %', NEW.child_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_edge_acyclic ON approval.node_edges;
CREATE TRIGGER trg_edge_acyclic BEFORE INSERT ON approval.node_edges
  FOR EACH ROW EXECUTE FUNCTION approval.check_edge_acyclic();

-- DB-INVARIANT: single-parent hierarchies allow max one active primary parent.
-- (DAG hierarchies enforce multi-parent rules in the app service — documented deviation.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_single_primary_parent
  ON approval.node_edges (child_id)
  WHERE kind = 'primary' AND eff_to IS NULL;

CREATE TABLE IF NOT EXISTS approval.seats (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES approval.nodes(id),
  name    text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('single','group')),
  quorum  int,
  CHECK ((kind = 'group' AND quorum >= 1) OR (kind = 'single' AND quorum IS NULL))
);

CREATE TABLE IF NOT EXISTS approval.seat_assignments (
  seat_id   uuid NOT NULL REFERENCES approval.seats(id),
  person_id uuid NOT NULL REFERENCES approval.people(id),
  kind      text NOT NULL CHECK (kind IN ('permanent','acting','delegate')),
  eff_from  timestamptz NOT NULL DEFAULT now(),
  eff_to    timestamptz,
  PRIMARY KEY (seat_id, person_id, eff_from)
);

-- DB-INVARIANT: no overlapping PERMANENT assignments on one SINGLE seat.
-- (Design schema expressed this as an EXCLUDE constraint, but that also blocked
-- group seats — committees/keyholders hold many permanent members (catalog C4).
-- Seat kind lives in approval.seats, which EXCLUDE can't consult → trigger.
-- Found by acceptance tests 2026-07-05; reported back to the design workstream.)
ALTER TABLE approval.seat_assignments DROP CONSTRAINT IF EXISTS excl_overlapping_permanent;
CREATE OR REPLACE FUNCTION approval.check_single_seat_occupancy() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'permanent'
     AND (SELECT kind FROM approval.seats WHERE id = NEW.seat_id) = 'single'
     AND EXISTS (
       SELECT 1 FROM approval.seat_assignments sa
       WHERE sa.seat_id = NEW.seat_id AND sa.kind = 'permanent'
         AND (sa.person_id, sa.eff_from) IS DISTINCT FROM (NEW.person_id, NEW.eff_from)
         AND tstzrange(sa.eff_from, COALESCE(sa.eff_to, 'infinity'::timestamptz))
             && tstzrange(NEW.eff_from, COALESCE(NEW.eff_to, 'infinity'::timestamptz))
     ) THEN
    RAISE EXCEPTION 'single seat % already has an active permanent occupant in that window', NEW.seat_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_single_seat_occupancy ON approval.seat_assignments;
CREATE TRIGGER trg_single_seat_occupancy BEFORE INSERT OR UPDATE ON approval.seat_assignments
  FOR EACH ROW EXECUTE FUNCTION approval.check_single_seat_occupancy();

CREATE TABLE IF NOT EXISTS approval.authority_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id          uuid NOT NULL REFERENCES approval.seats(id),
  authority_type   text NOT NULL,            -- invoice_approval | payment_release | ...
  max_amount_minor bigint,                   -- NULL = unlimited; org base currency
  scope_node_id    uuid NOT NULL REFERENCES approval.nodes(id),
  inherits_down    boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Approvables (per-line dimensions; Amendment 4 adds line description text)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.approvables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(organization_id),
  type             text NOT NULL CHECK (type IN ('invoice','vendor_change','payment_run','po')),
  requester_id     uuid NOT NULL REFERENCES approval.people(id),
  enterer_id       uuid REFERENCES approval.people(id),
  vendor_id        uuid,                     -- counterparty reference (no FK: counterparty tables owned by control plane)
  total_minor_base bigint NOT NULL,
  macro_state      text NOT NULL DEFAULT 'draft' CHECK (macro_state IN
    ('draft','pending_approval','returned_for_info','on_hold',
     'approved','auto_approved','rejected','cancelled')),
  attributes       jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS approval.approvable_lines (
  approvable_id uuid NOT NULL REFERENCES approval.approvables(id),
  line_no       int  NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      char(3) NOT NULL,
  description   text,                        -- Amendment 4: feeds coding-precedent memory
  dimensions    jsonb NOT NULL DEFAULT '{}', -- {"cost_center": "<node uuid>", ...}
  PRIMARY KEY (approvable_id, line_no)
);

-- DB-INVARIANT: material fields locked while pending_approval (change goes
-- through invalidation path, never in-place edit).
CREATE OR REPLACE FUNCTION approval.lock_pending_approvable() RETURNS trigger AS $$
BEGIN
  IF OLD.macro_state = 'pending_approval'
     AND (NEW.total_minor_base <> OLD.total_minor_base
          OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id) THEN
    RAISE EXCEPTION 'approvable % is locked pending approval; invalidate the plan first', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_lock_pending ON approval.approvables;
CREATE TRIGGER trg_lock_pending BEFORE UPDATE ON approval.approvables
  FOR EACH ROW EXECUTE FUNCTION approval.lock_pending_approvable();

-- ---------------------------------------------------------------------------
-- L2 · Policies (immutable versions) + compiled plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.policies (
  id              uuid NOT NULL,
  version         int  NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(organization_id),
  approvable_type text NOT NULL,
  name            text NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  body            jsonb NOT NULL,            -- PolicyNode[] (validated in app by zod)
  PRIMARY KEY (id, version)
);

-- DB-INVARIANT: policy versions are immutable.
CREATE OR REPLACE FUNCTION approval.forbid_policy_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'policies are immutable; insert a new version'; END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_policy_immutable ON approval.policies;
CREATE TRIGGER trg_policy_immutable BEFORE UPDATE OR DELETE ON approval.policies
  FOR EACH ROW EXECUTE FUNCTION approval.forbid_policy_mutation();

CREATE TABLE IF NOT EXISTS approval.policy_sets (
  organization_id        uuid NOT NULL REFERENCES organizations(organization_id),
  approvable_type        text NOT NULL,
  rules                  jsonb NOT NULL DEFAULT '[]',  -- ordered SelectorRule[]
  default_policy_id      uuid NOT NULL,
  default_policy_version int NOT NULL,
  PRIMARY KEY (organization_id, approvable_type),
  FOREIGN KEY (default_policy_id, default_policy_version) REFERENCES approval.policies(id, version)
);

CREATE TABLE IF NOT EXISTS approval.approval_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approvable_id  uuid NOT NULL REFERENCES approval.approvables(id),
  policy_id      uuid NOT NULL,
  policy_version int  NOT NULL,
  selector_rule  text NOT NULL,              -- index or 'default'
  compiled_at    timestamptz NOT NULL DEFAULT now(),
  steps          jsonb NOT NULL,             -- PlannedStep[] (resolved people pinned)
  sod_outcomes   jsonb NOT NULL DEFAULT '[]',
  superseded_by  uuid REFERENCES approval.approval_plans(id),
  FOREIGN KEY (policy_id, policy_version) REFERENCES approval.policies(id, version)
);

CREATE TABLE IF NOT EXISTS approval.tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES approval.approval_plans(id),
  step_index     int  NOT NULL,
  seat_id        uuid REFERENCES approval.seats(id),
  person_id      uuid NOT NULL REFERENCES approval.people(id),
  state          text NOT NULL DEFAULT 'scheduled' CHECK (state IN
    ('scheduled','open','approved','rejected','delegated','escalated',
     'pushed_back','info_requested','vetoed','obsolete')),
  escalated_ever boolean NOT NULL DEFAULT false, -- persists (IBM semantics)
  sla_deadline   timestamptz
);

-- ---------------------------------------------------------------------------
-- L3 · Constraint rules + relaxations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.constraint_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(organization_id),
  name            text NOT NULL,
  cap_a           jsonb NOT NULL,
  cap_b           jsonb NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('same_approvable','same_vendor','same_scope_node','org')),
  remedy          jsonb NOT NULL,
  relaxable       boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS approval.rule_relaxations (
  rule_id             uuid NOT NULL REFERENCES approval.constraint_rules(id),
  organization_id     uuid NOT NULL REFERENCES organizations(organization_id),
  acknowledged_by     uuid NOT NULL REFERENCES approval.people(id),
  acknowledged_at     timestamptz NOT NULL DEFAULT now(),
  compensating        text[] NOT NULL,
  review_at_headcount int NOT NULL,
  revoked_at          timestamptz,           -- reversible, visible
  PRIMARY KEY (rule_id, organization_id, acknowledged_at)
);

-- ---------------------------------------------------------------------------
-- Lifecycle · append-only event log (state is a projection of this)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval.approval_events (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL REFERENCES organizations(organization_id),
  approvable_id   uuid NOT NULL REFERENCES approval.approvables(id),
  plan_id         uuid REFERENCES approval.approval_plans(id),
  task_id         uuid REFERENCES approval.tasks(id),
  actor_id        uuid,                      -- NULL = system
  acting_as_seat  uuid REFERENCES approval.seats(id),
  idempotency_key text,
  payload         jsonb NOT NULL             -- typed in app; packet_hash lives here
);

-- DB-INVARIANT: append-only. No UPDATE, no DELETE. Ever.
CREATE OR REPLACE FUNCTION approval.forbid_event_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'approval_events is append-only'; END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_events_append_only ON approval.approval_events;
CREATE TRIGGER trg_events_append_only BEFORE UPDATE OR DELETE ON approval.approval_events
  FOR EACH ROW EXECUTE FUNCTION approval.forbid_event_mutation();

-- Idempotency: same key never applies twice.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_idempotency
  ON approval.approval_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_tasks_open  ON approval.tasks (person_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_tasks_sla   ON approval.tasks (sla_deadline) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_events_appr ON approval.approval_events (approvable_id, seq);
CREATE INDEX IF NOT EXISTS idx_assign_seat ON approval.seat_assignments (seat_id) WHERE eff_to IS NULL;

-- Person-scoped relaxations (2026-07-06, Fuyo's call overriding design ruling 2:
-- per-person allowed, but safeguards are identical regardless of scope —
-- NULL scoped_person_ids = relaxed for everyone).
ALTER TABLE approval.rule_relaxations ADD COLUMN IF NOT EXISTS scoped_person_ids uuid[];

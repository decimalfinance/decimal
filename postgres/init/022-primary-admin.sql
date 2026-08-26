-- "Owner" was never a thing this product has.
--
-- The screens have said "primary admin" for a long time — there is exactly one
-- per organization, they manage the admin tier, and nobody owns anything. The
-- stored value stayed 'owner', so the code read one word and the customer read
-- another, and every new comparison had to remember the translation. That is
-- the kind of gap that quietly outlives the people who know about it.
--
-- One tier vocabulary now, all the way down: primary_admin, admin, member.
--
-- Idempotent by construction: a value already renamed matches nothing. There is
-- no CHECK constraint on the column, so this is the whole migration.
UPDATE organization_memberships
SET role = 'primary_admin', updated_at = NOW()
WHERE role = 'owner';

-- Wallet authorizations have their OWN 'owner' role, meaning who is authorised
-- on a wallet rather than who runs the organization. Deliberately untouched:
-- the two were never the same word by accident of the same spelling.

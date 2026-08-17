/**
 * Give the existing Testing Labs org the roles its people were always meant to
 * hold.
 *
 * The seed script now does this for orgs created from here on. This is for the
 * one already standing: it was seeded before roles were assigned to anybody, so
 * it runs on the two fallbacks — owner/admin bypasses every check, and a member
 * with no roles gets the viewer bundle, which sees every bill. Nothing is
 * scoped until somebody actually holds the Approver role.
 *
 * Goes through the real endpoint with the owner's session, same as the seed.
 * Re-runnable: assigning a role somebody already holds is not an error.
 *
 *   npx tsx scripts/assign-testing-labs-roles.mts
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3100';
const PASSWORD = 'TestingLabs123!';
const OWNER = 'zara.owner@dev.decimal.test';

const ROLES: Array<{ email: string; role: 'bill_clerk' | 'approver' | 'payer' }> = [
  { email: 'priya.ap@dev.decimal.test', role: 'bill_clerk' },
  { email: 'marcus.ops@dev.decimal.test', role: 'approver' },
  { email: 'tom.proc@dev.decimal.test', role: 'approver' },
];

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const owner = await call('/auth/login', { email: OWNER, password: PASSWORD });
const orgs = owner.organizations ?? [];
const org = orgs.find((o: { organizationName: string }) => o.organizationName === 'Testing Labs');
if (!org) throw new Error(`no Testing Labs org for ${OWNER} — found: ${orgs.map((o: { organizationName: string }) => o.organizationName).join(', ') || 'none'}`);

const members = await call(`/organizations/${org.organizationId}/roles`, undefined, owner.sessionToken);
const idByEmail = new Map<string, string>(
  (members.members ?? []).map((m: { email: string; userId: string }) => [m.email, m.userId]),
);

for (const { email, role } of ROLES) {
  const userId = idByEmail.get(email);
  if (!userId) { console.log(`  skip  ${email.padEnd(34)} not a member`); continue; }
  await call(`/organizations/${org.organizationId}/roles/${role}/holders`, { userId }, owner.sessionToken);
  console.log(`  role  ${email.padEnd(34)} ${role}`);
}

console.log('\nZara and Nadia keep no role on purpose: admins already hold every');
console.log('capability, and the roles endpoint refuses to assign one to them.');
console.log('Marcus and Tom are now scoped to the bills they are involved in.');

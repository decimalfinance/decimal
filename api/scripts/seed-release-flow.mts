/**
 * Wire the release stage to the Payer role.
 *
 * Approval was connected to the Approver role, but release was still routing
 * on the seeded `payment_release` authority — the keyholders seat, which only
 * the org owner sits in. So a bill could be approved and then had nowhere to
 * go except back to the owner, and the Payer role held no release duty at all.
 *
 *   npx tsx scripts/seed-release-flow.mts
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3100';
const PASSWORD = 'TestingLabs123!';

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const owner = await call('/auth/login', { email: 'zara.owner@dev.decimal.test', password: PASSWORD });
const org = (owner.organizations ?? []).find((o: { organizationName: string }) => o.organizationName === 'Testing Labs');
if (!org) throw new Error('no Testing Labs org');
const orgId = org.organizationId as string;

// The release config takes engine person ids, same as the approval flow.
const release = await call(`/organizations/${orgId}/approvals/release`, undefined, owner.sessionToken);
const people = (release.people ?? []) as Array<{ id: string; name: string }>;
const dara = people.find((p) => p.name === 'Dara Mensah');
if (!dara) {
  console.log('people the release stage can see:', people.map((p) => p.name).join(', ') || '(none)');
  throw new Error('Dara Mensah not resolvable — is the payer role assigned?');
}

const published = await call(`/organizations/${orgId}/approvals/release/publish`,
  { approvers: [dara.id], quorum: 'all' }, owner.sessionToken);

console.log(`release stage published — Dara Mensah signs to send money`);
console.log(JSON.stringify(published, null, 1).slice(0, 400));

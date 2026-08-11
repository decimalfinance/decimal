/**
 * Stand up "Testing Labs": a six-person organization to test with.
 *
 * One- and two-person orgs hide most of what the approval engine does —
 * separation of duties has nothing to separate, quorums collapse to one, and
 * every question is asked of the only other person. This builds an org big
 * enough for routing, hand-backs and forwarding chains to behave like they
 * would in a real finance team.
 *
 * Goes through the REAL endpoints — register, create org, invite — rather than
 * writing rows directly, so the seeded org is indistinguishable from one a
 * person made. A fixture built by a back door tests the back door.
 *
 *   npx tsx scripts/seed-testing-labs.mts
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3100';

// Reserved dev domain: created pre-verified, so there is no inbox to read a
// code from. Everything else about these accounts is ordinary.
const PASSWORD = 'TestingLabs123!';
const PEOPLE = [
  { email: 'zara.owner@dev.decimal.test', name: 'Zara Okafor', access: 'owner', part: 'Primary admin — owns policy and the ceiling' },
  { email: 'priya.ap@dev.decimal.test', name: 'Priya Raman', access: 'member', part: 'AP clerk — enters and codes bills' },
  { email: 'marcus.ops@dev.decimal.test', name: 'Marcus Bell', access: 'member', part: 'Ops lead — approves spend for his team' },
  { email: 'nadia.fin@dev.decimal.test', name: 'Nadia Haddad', access: 'admin', part: 'Finance manager — second pair of eyes' },
  { email: 'tom.proc@dev.decimal.test', name: 'Tom Whitfield', access: 'member', part: 'Procurement — owns vendor relationships' },
] as const;

const INVITE = 'phoenixkia625@gmail.com';

async function call(path: string, body?: unknown, token?: string, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method: body ? method : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function registerOrLogin(person: { email: string; name: string }) {
  try {
    return await call('/auth/register', { email: person.email, password: PASSWORD, displayName: person.name });
  } catch (error) {
    // Re-runnable: an account that already exists just logs in.
    if (!(error instanceof Error) || !/already|exists|taken|409/i.test(error.message)) throw error;
    return await call('/auth/login', { email: person.email, password: PASSWORD });
  }
}

const sessions = new Map<string, { token: string; userId: string }>();
for (const p of PEOPLE) {
  const r = await registerOrLogin(p);
  sessions.set(p.email, { token: r.sessionToken, userId: r.user.userId });
  console.log(`  user  ${p.email.padEnd(34)} ${p.name}`);
}

const owner = sessions.get(PEOPLE[0].email)!;
const org = await call('/organizations', { organizationName: 'Testing Labs' }, owner.token);
console.log(`\n  org   Testing Labs  ${org.organizationId}`);

// Everyone else joins by real invite, accepted with their own session — the
// same path a colleague walks, so invite acceptance is exercised too.
for (const p of PEOPLE.slice(1)) {
  const invite = await call(`/organizations/${org.organizationId}/invites`,
    { email: p.email, role: p.access === 'admin' ? 'admin' : 'member' }, owner.token);
  const token = invite.inviteToken ?? invite.invite?.inviteToken;
  if (!token) { console.log(`  WARN  no invite token returned for ${p.email}`); continue; }
  await call(`/invites/${token}/accept`, {}, sessions.get(p.email)!.token);
  console.log(`  join  ${p.email.padEnd(34)} as ${p.access}`);
}

// The human tester, invited for real — they accept from their own inbox.
const humanInvite = await call(`/organizations/${org.organizationId}/invites`, { email: INVITE, role: 'admin' }, owner.token);
const humanToken = humanInvite.inviteToken ?? humanInvite.invite?.inviteToken;

const slug = await call(`/organizations/${org.organizationId}/inbound-email/address`, undefined, owner.token).catch(() => null);

console.log('\n--- for the credentials file ---');
console.log(JSON.stringify({
  organizationId: org.organizationId,
  intakeAddress: slug?.address ?? null,
  inviteFor: INVITE,
  inviteLink: humanToken ? `http://localhost:5174/invites/${humanToken}` : null,
}, null, 2));

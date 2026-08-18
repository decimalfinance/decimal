/**
 * A deliberately hard approval flow for Testing Labs, plus the people it needs.
 *
 * The point is coverage, not realism: every branch below exists to make one
 * specific mechanism observable. Quorum modes, amount thresholds, a
 * category split, a first-bill split, sequential steps, and enough approvers
 * that separation of duties has somewhere to reroute rather than deadlock.
 *
 *   npx tsx scripts/seed-complex-flow.mts
 */
const API = process.env.API_BASE_URL ?? 'http://localhost:3100';
// Supplied, never written down here. This repository is public, and a password
// committed to it is a password published — true even for throwaway local
// accounts, which is why TESTING-LABS.md (where this value lives) is
// gitignored. There is deliberately no default: a fixture that silently seeds
// itself with a known password is the same mistake with extra steps.
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) {
  console.error('Set SEED_PASSWORD before seeding — the value is in TESTING-LABS.md (gitignored).');
  process.exit(1);
}
const OWNER = 'zara.owner@dev.decimal.test';

// Added on top of the base seed. Roles chosen so every stage has depth: four
// approvers means a quorum of three still has a spare when SoD removes one.
const NEW_PEOPLE = [
  { email: 'ines.controller@dev.decimal.test', name: 'Ines Volkov', access: 'member', role: 'approver' },
  { email: 'sam.eng@dev.decimal.test', name: 'Sam Okonkwo', access: 'member', role: 'approver' },
  { email: 'dara.pay@dev.decimal.test', name: 'Dara Mensah', access: 'member', role: 'payer' },
  { email: 'kit.audit@dev.decimal.test', name: 'Kit Alvarez', access: 'member', role: 'viewer' },
  { email: 'omar.clerk@dev.decimal.test', name: 'Omar Haddad', access: 'member', role: 'bill_clerk' },
] as const;

async function call(path: string, body?: unknown, token?: string, method?: string) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method ?? (body ? 'POST' : 'GET')} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function registerOrLogin(p: { email: string; name: string }) {
  try {
    return await call('/auth/register', { email: p.email, password: PASSWORD, displayName: p.name });
  } catch (e) {
    if (!(e instanceof Error) || !/already|exists|taken|409/i.test(e.message)) throw e;
    return await call('/auth/login', { email: p.email, password: PASSWORD });
  }
}

const owner = await call('/auth/login', { email: OWNER, password: PASSWORD });
const org = (owner.organizations ?? []).find((o: { organizationName: string }) => o.organizationName === 'Testing Labs');
if (!org) throw new Error('no Testing Labs org — run seed-testing-labs.mts first');
const orgId = org.organizationId as string;
console.log(`org  Testing Labs  ${orgId}\n`);

for (const p of NEW_PEOPLE) {
  const s = await registerOrLogin(p);
  try {
    const invite = await call(`/organizations/${orgId}/invites`,
      { email: p.email, role: p.access === 'admin' ? 'admin' : 'member' }, owner.sessionToken);
    const token = invite.inviteToken ?? invite.invite?.inviteToken;
    if (token) await call(`/invites/${token}/accept`, {}, s.sessionToken);
  } catch (e) {
    if (!(e instanceof Error) || !/already an active|already a member|exists|409/i.test(e.message)) throw e;
  }
  await call(`/organizations/${orgId}/roles/${p.role}/holders`, { userId: s.user.userId }, owner.sessionToken)
    .catch((e) => console.log(`  note  ${p.email}: ${String(e).slice(0, 90)}`));
  console.log(`  add   ${p.email.padEnd(36)} ${p.role}`);
}

// Resolve engine person ids, and confirm who the engine will accept.
const flowData = await call(`/organizations/${orgId}/approvals/flow`, undefined, owner.sessionToken);
const byName = new Map<string, { id: string; can_approve: boolean }>(
  (flowData.people ?? []).map((p: { id: string; name: string; can_approve: boolean }) => [p.name, p]),
);
const id = (name: string) => {
  const p = byName.get(name);
  if (!p) throw new Error(`no engine person for ${name}`);
  if (!p.can_approve) throw new Error(`${name} cannot approve — wrong role for this chain`);
  return p.id;
};

const marcus = id('Marcus Bell');
const tom = id('Tom Whitfield');
const ines = id('Ines Volkov');
const sam = id('Sam Okonkwo');
const nadia = id('Nadia Haddad');   // admin, always eligible

const step = (sid: string, title: string, approvers: string[], quorum: 'all' | 'any' | number, purpose: string) =>
  ({ id: sid, type: 'step' as const, title, approvers, quorum, purpose });

// Every branch has to END somewhere, explicitly.
//
// A path with no terminal reads as unfinished: the builder draws "Finish this
// path" on the open tail and leaves the stage's end pill floating,
// disconnected from everything. That is not cosmetic — the terminal is the
// author SAYING this path is complete, and it is what joins the branch to
// "Approved — forwarded for payment".
//
// It compiles to { type: 'marker', kind: 'forward' }, deliberately not an
// engine terminal: a real terminal would auto-approve the bill and discard the
// steps above it (flow.ts:193).
const done = (sid: string) => ({ id: sid, type: 'auto' as const });

// The flow, outermost condition first. Each leaf is reachable by a bill you
// can construct on purpose, which is what makes it testable rather than
// decorative.
const flow = [
  {
    id: 'big-money', type: 'if' as const, amountGteUsd: 10000, split: null,
    // >= $10k: three of four must sign. Quorum with a spare, so removing one
    // approver by SoD still leaves the step satisfiable.
    then: [
      step('s-big', 'High-value approval', [marcus, tom, ines, sam], 3,
        'Three of four sign anything at or above $10,000'),
      step('s-big-fin', 'Controller sign-off', [nadia], 'all',
        'Finance countersigns high-value spend'),
      done('t-big'),
    ],
    otherwise: [
      {
        id: 'mid-money', type: 'if' as const, amountGteUsd: 1000, split: null,
        // $1k-$10k: two named people, in order. Tests sequential progression.
        then: [
          step('s-mid-1', 'Team approval', [marcus], 'all', 'The team lead signs first'),
          step('s-mid-2', 'Second pair of eyes', [tom, ines], 'any',
            'Either of two signs second'),
          done('t-mid'),
        ],
        otherwise: [
          {
            id: 'first-bill', type: 'if' as const, amountGteUsd: 0, split: { kind: 'firstBill' as const },
            // A vendor's FIRST bill is scrutinised however small it is.
            then: [
              step('s-new-vendor', 'New vendor check', [ines, sam], 'any',
                'A vendor we have never paid gets looked at whatever the amount'),
              done('t-new-vendor'),
            ],
            // Under $1k from a known vendor: one signature, any approver.
            otherwise: [
              step('s-small', 'Routine approval', [marcus, tom, ines, sam], 'any',
                'Anyone can clear a small bill from a vendor we already pay'),
              done('t-small'),
            ],
          },
        ],
      },
    ],
  },
];

const published = await call(`/organizations/${orgId}/approvals/flow/publish`, { flow }, owner.sessionToken);
console.log(`\nflow published — version ${published.version ?? '?'}`);

// Dry-run each branch so the output states what a tester should expect.
const probes = [
  { label: '$25,000 known vendor', amountUsd: 25000, firstBill: false },
  { label: '$4,500 known vendor', amountUsd: 4500, firstBill: false },
  { label: '$300 NEW vendor', amountUsd: 300, firstBill: true },
  { label: '$300 known vendor', amountUsd: 300, firstBill: false },
];
console.log('\nwhat each branch should route to:');
for (const probe of probes) {
  try {
    const sim = await call(`/organizations/${orgId}/approvals/flow/simulate`, {
      flow,
      sample: { amountUsd: probe.amountUsd, requesterPersonId: null, firstBill: probe.firstBill },
    }, owner.sessionToken);
    const steps = (sim.approve?.chain ?? sim.chain ?? []) as Array<Record<string, unknown>>;
    const names = steps.map((s) => {
      const people = (s.people ?? []) as Array<{ name?: string }>;
      return `${s.purpose ?? s.title ?? 'step'} [${people.map((p) => p.name?.split(' ')[0]).join(', ')}]`;
    });
    console.log(`  ${probe.label.padEnd(24)} ${names.join('  ->  ') || '(no steps)'}`);
  } catch (e) {
    console.log(`  ${probe.label.padEnd(24)} simulate failed: ${String(e).slice(0, 120)}`);
  }
}

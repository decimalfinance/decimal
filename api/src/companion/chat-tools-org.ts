// What the companion can see about the organisation around the bills: the team
// and who does which job, how approval works, what happened on a bill and who
// it is waiting on, the categories, and what it has learned.
//
// People and roles are not sensitive (Zaid, 2026-09-30): anyone on the team
// can see the Members page, and knowing who does what is what lets the
// companion say who to ask. Everything else reads through the same functions
// the screens use, so it sees what the asker could see and no further.
import { prisma } from '../infra/prisma.js';
import type { AgentTool } from '../exceptions/agent.js';
import { getMembersAndRoles } from '../approvals/roles.js';
import { ROLE_BUNDLES, ROLE_DEFINITIONS, type RoleKey } from '../approvals/permissions.js';
import { getFlow, getSodSettings, type FlowNode } from '../approvals/flow.js';
import { getBillCeilingMinor } from '../approvals/store.js';
import { getBillDetail } from '../payments/bills.js';
import { involvedBillIds } from '../payments/bill-visibility.js';
import { listExpenseAccounts } from '../accounting/ocr-coding.js';
import { DEFAULT_EXPENSE_ACCOUNTS } from '../accounting/default-chart.js';
import { plural } from './steps.js';
import { localDay, usd, type Thought } from './chat-tools.js';

/**
 * Who does which job. Written down here, once, from where each job is actually
 * enforced (role bundles for screen work, the routes for the admin-only acts),
 * so the companion never has to guess a responsibility.
 */
const JOBS: Array<{ job: string; who: 'capability' | 'admin' | 'primary_admin' | 'flow'; capability?: string; note: string }> = [
  { job: 'Upload or forward bills', who: 'capability', capability: 'bills.create', note: 'Bill clerks and admins.' },
  { job: 'Review bills and assign categories (coding)', who: 'capability', capability: 'bills.edit', note: 'Bill clerks and admins check each bill and pick the category for every line.' },
  { job: 'Send a bill for approval', who: 'capability', capability: 'bills.edit', note: 'Whoever reviews it: bill clerks and admins.' },
  { job: 'Approve a bill', who: 'flow', note: 'The approval flow decides who, bill by bill (by amount, vendor or category). People with the Approver role can be placed in it. Separation-of-duties rules may stop someone approving a bill they submitted.' },
  { job: 'Clear a duplicate flag, or close a bill as not a bill', who: 'admin', note: 'Admins only: it overrides a check or removes a payable.' },
  { job: 'Save a category habit for a vendor', who: 'admin', note: 'Admins only.' },
  { job: 'Let one bill past the bill ceiling', who: 'primary_admin', note: 'The primary admin only.' },
  { job: 'Change the approval flow, the ceiling or the separation-of-duties rules', who: 'primary_admin', note: 'The primary admin only.' },
  { job: 'Invite people and assign roles', who: 'admin', note: 'Admins.' },
  { job: 'Answer a question about a bill', who: 'capability', capability: 'bills.view', note: 'Whoever it was asked of.' },
];

const ACCESS_WORDS: Record<string, string> = { primary_admin: 'Primary admin', admin: 'Admin', member: 'Member' };

function describeFlow(nodes: FlowNode[], names: Map<string, string>, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  const who = (ids: string[]) => ids.map((id) => names.get(id) ?? 'someone').join(', ');
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === 'step') {
      const quorum = n.quorum === 'all' ? 'all of' : n.quorum === 'any' ? 'any one of' : `${n.quorum} of`;
      out.push(`${pad}Step "${n.title}": ${quorum} ${who(n.approvers)}${n.purpose ? ` (${n.purpose})` : ''}`);
    } else if (n.type === 'auto') {
      out.push(`${pad}Approved automatically`);
    } else if (n.type === 'notify') {
      out.push(`${pad}Tell ${who(n.people)}`);
    } else if (n.type === 'if') {
      const cond = n.split?.kind === 'vendor' ? `vendor is ${n.split.vendorNames.join(' or ')}`
        : n.split?.kind === 'category' ? `category is ${n.split.categories.join(' or ')}`
          : n.split?.kind === 'firstBill' ? 'it is the first bill from the vendor'
            : `the bill is ${usd(n.amountGteUsd)} or more`;
      out.push(`${pad}If ${cond}:`, ...describeFlow(n.then, names, depth + 1), `${pad}Otherwise:`, ...describeFlow(n.otherwise, names, depth + 1));
    }
  }
  return out;
}

export function orgTools(args: {
  organizationId: string;
  viewerUserId: string;
  onThought: (t: Thought) => Promise<void>;
  seen: Set<string>;
}): AgentTool[] {
  const canSee = async (billId: string) => {
    const visible = await involvedBillIds(args.organizationId, args.viewerUserId);
    return visible === null || visible.has(billId);
  };
  const detailFor = async (billId: unknown) => {
    if (typeof billId !== 'string' || !(await canSee(billId))) return null;
    return getBillDetail(args.organizationId, billId, args.viewerUserId).catch(() => null);
  };

  return [
    {
      name: 'team',
      description: 'The team: everyone in the organisation with their access (primary admin, admin, member) and roles (bill clerk, approver, payer, viewer), what each role is for, and which job is whose — e.g. who assigns categories, who can clear a duplicate flag, who approves. Use it for any "who" question.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const { members } = await getMembersAndRoles(args.organizationId);
        const people = members.map((m) => {
          const isAdmin = m.access === 'primary_admin' || m.access === 'admin';
          const caps = new Set<string>(isAdmin ? Object.values(ROLE_BUNDLES).flat() : m.roles.flatMap((r) => ROLE_BUNDLES[r as RoleKey] ?? []));
          return { name: m.name, email: m.email, access: ACCESS_WORDS[m.access] ?? m.access, roles: m.roles.map((r) => ROLE_DEFINITIONS.find((d) => d.key === r)?.name ?? r), isYou: m.userId === args.viewerUserId, isAdmin, isPrimary: m.access === 'primary_admin', caps };
        });
        const jobs = JOBS.map((j) => {
          const holders = j.who === 'primary_admin' ? people.filter((p) => p.isPrimary)
            : j.who === 'admin' ? people.filter((p) => p.isAdmin)
              : j.who === 'capability' ? people.filter((p) => p.caps.has(j.capability!))
                : people.filter((p) => p.isAdmin || p.roles.includes('Approver'));
          return { job: j.job, rule: j.note, people: holders.map((p) => p.name) };
        });
        await args.onThought({ text: 'Looked up the team and who does what', detail: `${plural(people.length, 'person', 'people')}.` });
        return {
          people: people.map(({ caps: _c, isAdmin: _a, isPrimary: _p, ...p }) => p),
          roles: ROLE_DEFINITIONS.map((d) => ({ role: d.name, whatItIsFor: d.summary })),
          jobs,
        };
      },
    },
    {
      name: 'approval_trail',
      description: 'Where one bill is in approval: who asked for it, each approval step with who is on it, who approved or rejected and when, who it is waiting on now, and any open conversation on a step.',
      parameters: { type: 'object', additionalProperties: false, properties: { billId: { type: 'string' } }, required: ['billId'] },
      run: async (a) => {
        const d = await detailFor(a.billId);
        if (!d) {
          await args.onThought({ text: 'Looked for a bill I could not find', detail: null });
          return { error: 'No such bill, or this person cannot see it.' };
        }
        args.seen.add(String(a.billId));
        const steps = (d.approval?.steps ?? []).map((s: Record<string, any>) => ({
          step: s.stepIndex + 1,
          person: s.person?.name ?? null,
          state: s.state,
          at: s.actedAt ?? null,
          declineReason: s.declineReason ?? null,
          openThread: s.thread?.open ? { waitingOn: s.thread.waitingOn ?? null, lastMessage: s.thread.messages?.at(-1) ?? null } : null,
        }));
        const current = steps.filter((s) => s.state === 'current').map((s) => s.person);
        const vendor = d.draft?.vendor?.name ?? 'the bill';
        await args.onThought({
          text: `Checked the approval trail for ${vendor}`,
          detail: current.length ? `Waiting on ${current.join(', ')}.` : d.approval ? `${d.status?.subStatus ?? d.approval.macroState}.` : 'Not in approval yet.',
        });
        return {
          status: d.status,
          requestedBy: d.requester?.name ?? null,
          waitingOn: current,
          steps,
          note: d.approval?.protectionNote ?? null,
        };
      },
    },
    {
      name: 'bill_history',
      description: 'Everything that happened on one bill: how it arrived, who changed which field, flags raised and cleared, comments, questions (asked by whom, of whom, answered or still open), sent back, recalled, cancelled.',
      parameters: { type: 'object', additionalProperties: false, properties: { billId: { type: 'string' } }, required: ['billId'] },
      run: async (a) => {
        const d = await detailFor(a.billId);
        if (!d) {
          await args.onThought({ text: 'Looked for a bill I could not find', detail: null });
          return { error: 'No such bill, or this person cannot see it.' };
        }
        args.seen.add(String(a.billId));
        const draft = d.draft as Record<string, any>;
        const questions = (draft.questions ?? []) as Array<Record<string, any>>;
        const open = questions.filter((q) => !q.answeredAt);
        await args.onThought({
          text: `Read the history of ${draft.vendor?.name ?? 'the bill'}`,
          detail: `${plural((draft.workLog ?? []).length, 'change')}, ${plural((draft.comments ?? []).length, 'comment')}, ${plural(questions.length, 'question')}${open.length ? ` (${open.length} open)` : ''}.`,
        });
        return {
          lifecycle: d.history,
          changes: (draft.workLog ?? []).map((w: Record<string, any>) => ({ at: w.at, by: w.byName, what: w.text, detail: w.detail })),
          comments: (draft.comments ?? []).map((c: Record<string, any>) => ({ at: c.at, by: c.authorName, said: c.body })),
          questions: questions.map((q) => ({ askedAt: q.askedAt, askedBy: q.askedByName, askedOf: q.askedOfName, question: q.question, answer: q.answer, open: !q.answeredAt })),
          correctionsBeforeConfirm: d.corrections,
        };
      },
    },
    {
      name: 'approval_rules',
      description: 'How approval works in this organisation: the published approval flow (who approves what, by amount, vendor or category), the bill ceiling, and the separation-of-duties rules (whether the person who reviewed or submitted a bill may approve it).',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const [flow, sod, ceiling] = await Promise.all([
          getFlow(args.organizationId),
          getSodSettings(args.organizationId),
          getBillCeilingMinor(prisma, args.organizationId),
        ]);
        const names = new Map(flow.people.map((p) => [p.id, p.name]));
        const lines = flow.flow.length ? describeFlow(flow.flow, names) : ['No flow published yet: every bill goes to the organisation owner.'];
        await args.onThought({ text: 'Read the approval rules', detail: `${plural(lines.length, 'rule line')}${ceiling ? `, a bill ceiling of ${usd(Number(ceiling) / 1_000_000)}` : ''}.` });
        return {
          flow: lines,
          billCeiling: ceiling ? usd(Number(ceiling) / 1_000_000) : null,
          separationOfDuties: {
            reviewerMayApprove: sod.clerkCanApprove,
            submitterMayApprove: sod.submitterCanApprove,
            approverMayRelease: sod.approverCanRelease,
          },
        };
      },
    },
    {
      name: 'categories',
      description: 'The categories bills can be coded to (the chart of accounts: QuickBooks when connected, otherwise the standard list).',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const live = await listExpenseAccounts(args.organizationId).catch(() => []);
        const list = live.length ? live : DEFAULT_EXPENSE_ACCOUNTS;
        await args.onThought({ text: 'Looked up the categories', detail: `${plural(list.length, 'category', 'categories')}${live.length ? ' from QuickBooks' : ', the standard list'}.` });
        return { source: live.length ? 'QuickBooks' : 'standard list', categories: list.map((c) => ({ name: c.name, description: c.description ?? null })) };
      },
    },
    {
      name: 'what_i_know',
      description: 'The category habits the companion has learned or been told, vendor by vendor: which category, learned from how many bills or set by a person, and when.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const rules = await prisma.vendorCodingRule.findMany({
          where: { organizationId: args.organizationId },
          orderBy: { updatedAt: 'desc' },
          select: { accountName: true, accountId: true, source: true, learnedFromCount: true, updatedAt: true, counterparty: { select: { displayName: true } } },
        });
        await args.onThought({ text: 'Checked what I have learned', detail: `${plural(rules.length, 'category habit')}.` });
        return {
          habits: rules.map((r) => ({
            vendor: r.counterparty.displayName,
            category: r.accountName ?? r.accountId,
            how: r.source === 'learned' ? `learned from ${plural(r.learnedFromCount, 'bill')}` : 'set by a person',
            since: localDay(r.updatedAt),
          })),
        };
      },
    },
  ];
}

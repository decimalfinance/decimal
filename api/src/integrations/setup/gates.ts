// What has to be true before a person can say go. Decided here, from the record
// and the live connection, never by the model: it can ask, and code answers.

import type { IntegrationSetup } from '@prisma/client';
import { prisma } from '../../infra/prisma.js';
import { connectorFor } from '../connectors.js';
import { playbookFor } from './playbooks.js';
import type { StudyFindings } from './study.js';

export type DoneCondition = { key: string; done: boolean; missing: string };

export async function doneConditions(setup: IntegrationSetup): Promise<DoneCondition[]> {
  const [connection, calls, postingElsewhere] = await Promise.all([
    connectorFor(setup.system).connection(setup.organizationId),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, select: { key: true, status: true } }),
    // A team's bills post to one set of books: while another posts, Go here would send them to two.
    prisma.accountingConnection.findFirst({
      where: { organizationId: setup.organizationId, provider: { not: setup.system }, postingEnabledAt: { not: null }, status: { not: 'disconnected' } },
      select: { provider: true },
    }),
  ]);
  const elsewhere = postingElsewhere ? playbookFor(postingElsewhere.provider).label : null;
  const signedIn = connection?.status === 'connected' && connection.companyId === setup.companyId;
  const closing = calls.find((c) => c.key === 'closing_date');
  // A question the model thought worth asking is one the person sees through: Go doesn't drop it.
  const open = calls.filter((c) => c.status !== 'answered' && c.key !== 'closing_date');
  return [
    { key: 'signed_in', done: signedIn, missing: 'A live sign-in to the confirmed company.' },
    { key: 'company_confirmed', done: Boolean(setup.companyConfirmedAt), missing: 'The person has not confirmed the company.' },
    { key: 'study_finished', done: setup.studyStatus === 'finished', missing: 'Reading their books has not finished.' },
    { key: 'closing_date', done: closing?.status === 'answered', missing: 'The person has not answered the closing date.' },
    { key: 'required_calls', done: open.length === 0, missing: `Still open: ${open.map((c) => c.key).join(', ')}.` },
    {
      key: 'one_set_of_books',
      done: elsewhere === null,
      missing: `Bills already post to ${elsewhere} for this team, and Decimal posts to one set of books. Someone has to disconnect ${elsewhere} first, from its row in Organisation, under Accounting.`,
    },
  ];
}

export const readyForGo = (conditions: DoneCondition[]) => conditions.every((c) => c.done);
export const stillMissing = (conditions: DoneCondition[]) => conditions.filter((c) => !c.done).map((c) => c.missing);

/** inACall: it is cited in a question, so the person has to see it. Otherwise it can wait, for a reason. */
export type NotRaised = { id: string; what: string; inACall: boolean; refs: string[] };

/**
 * What the study found that changes how a bill posts, and no call has taken up. Which of
 * them matter is the model's to judge, so this doesn't stop Go: it has to raise each one
 * or say why not, and a why goes on the receipt. Forgetting isn't one of the choices.
 */
const wordsOf = (text: string) => text.toLowerCase().replace(/['’`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const wordsSaid = (texts: string[]) => new Set(texts.flatMap(wordsOf));
/** Did this business come up? Its first word is enough, in whatever form the agent named it. */
export const cameUp = (name: string, said: Set<string>) => said.has(wordsOf(name).find((w) => w !== 'the') ?? '');

/** What their books put in front of the agent that the person hasn't heard: cited in a call, and named in what they were told. */
export function notRaised(findings: StudyFindings | null, calls: Array<{ kind: string; refs: unknown }>, said: Set<string>, claimed: Set<string>): NotRaised[] {
  if (!findings) return [];
  const cited = calls.map((c) => ({ kind: c.kind, refs: new Set(Array.isArray(c.refs) ? (c.refs as string[]) : []) }));
  const missing: NotRaised[] = [];
  for (const group of findings.lookalikeVendors) {
    const ids = group.vendors.map((v) => `vendor:${v.id}`);
    const inACall = cited.some((c) => ids.filter((id) => c.refs.has(id)).length >= 2);
    if (!inACall || !group.vendors.some((v) => cameUp(v.name, said))) {
      missing.push({ id: `lookalike:${group.vendors[0]!.id}`, what: `Vendors that look alike: ${group.vendors.map((v) => v.name).join(', ')}`, inACall, refs: ids });
    }
  }
  for (const line of findings.codedTwoWays) {
    const inACall = cited.some((c) => c.refs.has(`vendor:${line.vendorId}`) && c.kind !== 'lookalike_vendors');
    if (!inACall || !cameUp(line.vendorName, said)) {
      missing.push({ id: `coded:${line.vendorId}:${line.line ?? ''}`, what: `${line.vendorName}: "${line.example ?? 'their lines'}" went to ${line.accounts.map((a) => a.name).join(' and ')}`, inACall, refs: [`vendor:${line.vendorId}`, ...line.accounts.map((a) => `category:${a.id}`)] });
    }
  }
  // Not a question: they never post by themselves, so there's nothing to decide. They only have to hear it, with the bills to open.
  const approved = findings.decimal.approvedBeforeConnecting;
  if (approved.bills > 0 && !approved.sampleBillIds.some((id) => claimed.has(`decimal-bill:${id}`))) {
    missing.push({ id: 'approved_before_connecting', what: `${approved.bills} bills approved in Decimal before connecting, which they haven't been told about in a claim citing them`, inACall: false, refs: approved.sampleBillIds.map((id) => `decimal-bill:${id}`) });
  }
  return missing;
}

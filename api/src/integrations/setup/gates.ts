// What has to be true before a person can say go. Decided here, from the record
// and the live connection, never by the model: it can ask, and code answers.

import type { IntegrationSetup } from '@prisma/client';
import { prisma } from '../../infra/prisma.js';
import { connectorFor } from '../connectors.js';
import type { StudyFindings } from './study.js';

export type DoneCondition = { key: string; done: boolean; missing: string };

export async function doneConditions(setup: IntegrationSetup): Promise<DoneCondition[]> {
  const [connection, calls] = await Promise.all([
    connectorFor(setup.system).connection(setup.organizationId),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, select: { key: true, status: true } }),
  ]);
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
  ];
}

export const readyForGo = (conditions: DoneCondition[]) => conditions.every((c) => c.done);
export const stillMissing = (conditions: DoneCondition[]) => conditions.filter((c) => !c.done).map((c) => c.missing);

/** inACall: it is cited in a question, so the person has to see it. Otherwise it can wait, for a reason. */
export type NotRaised = { id: string; what: string; inACall: boolean };

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
export function notRaised(findings: StudyFindings | null, calls: Array<{ kind: string; refs: unknown }>, said: Set<string>): NotRaised[] {
  if (!findings) return [];
  const cited = calls.map((c) => ({ kind: c.kind, refs: new Set(Array.isArray(c.refs) ? (c.refs as string[]) : []) }));
  const missing: NotRaised[] = [];
  for (const group of findings.lookalikeVendors) {
    const ids = group.vendors.map((v) => `vendor:${v.id}`);
    const inACall = cited.some((c) => ids.filter((id) => c.refs.has(id)).length >= 2);
    if (!inACall || !group.vendors.some((v) => cameUp(v.name, said))) {
      missing.push({ id: `lookalike:${group.vendors[0]!.id}`, what: `Vendors that look alike: ${group.vendors.map((v) => v.name).join(', ')}`, inACall });
    }
  }
  for (const line of findings.codedTwoWays) {
    const inACall = cited.some((c) => c.refs.has(`vendor:${line.vendorId}`) && c.kind !== 'lookalike_vendors');
    if (!inACall || !cameUp(line.vendorName, said)) {
      missing.push({ id: `coded:${line.vendorId}:${line.line ?? ''}`, what: `${line.vendorName}: "${line.example ?? 'their lines'}" went to ${line.accounts.map((a) => a.name).join(' and ')}`, inACall });
    }
  }
  if (findings.decimal.approvedBeforeConnecting.bills > 0 && !cited.some((c) => c.kind === 'approved_before_connecting')) {
    missing.push({ id: 'approved_before_connecting', what: `${findings.decimal.approvedBeforeConnecting.bills} bills approved in Decimal before connecting`, inACall: false });
  }
  return missing;
}

// What has to be true before a person can say go. Decided here, from the record
// and the live connection, never by the model: it can ask, and code answers.

import type { IntegrationSetup } from '@prisma/client';
import { prisma } from '../../infra/prisma.js';
import { connectorFor } from '../connectors.js';

export type DoneCondition = { key: string; done: boolean; missing: string };

export async function doneConditions(setup: IntegrationSetup): Promise<DoneCondition[]> {
  const [connection, calls] = await Promise.all([
    connectorFor(setup.system).connection(setup.organizationId),
    prisma.integrationSetupCall.findMany({ where: { setupId: setup.setupId }, select: { key: true, required: true, status: true } }),
  ]);
  const signedIn = connection?.status === 'connected' && connection.companyId === setup.companyId;
  const closing = calls.find((c) => c.key === 'closing_date');
  const open = calls.filter((c) => c.required && c.status !== 'answered' && c.key !== 'closing_date');
  return [
    { key: 'signed_in', done: signedIn, missing: 'A live sign-in to the confirmed company.' },
    { key: 'company_confirmed', done: Boolean(setup.companyConfirmedAt), missing: 'The person has not confirmed the company.' },
    { key: 'study_finished', done: setup.studyStatus === 'finished', missing: 'The study has not finished.' },
    { key: 'closing_date', done: closing?.status === 'answered', missing: 'The person has not answered the closing date.' },
    { key: 'required_calls', done: open.length === 0, missing: `Still open: ${open.map((c) => c.key).join(', ')}.` },
  ];
}

export const readyForGo = (conditions: DoneCondition[]) => conditions.every((c) => c.done);
export const stillMissing = (conditions: DoneCondition[]) => conditions.filter((c) => !c.done).map((c) => c.missing);

// The study: fixed code reads a company's records into the copy and works out the
// findings. No model is involved, and nothing here writes to the books. It runs
// apart from the chat, so the person can leave, and tells the harness by an event
// when it is finished.

import { Prisma, type IntegrationSetup } from '@prisma/client';
import { approvedBillsNotInTheBooks, someoneElseCanApprove } from '../../approvals/store.js';
import { listProtections } from '../../approvals/protections.js';
import { errorToLogFields, logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { BooksReadError, type BooksCompany, type BooksReader } from '../books.js';
import { connectorFor } from '../connectors.js';
import { deleteCopy, replaceRecords, toRows, type CopyScope } from '../copy.js';
import { computeFindings, type Findings } from './findings.js';
import { appendEvent } from './record.js';

const LEASE_SECONDS = 600;
const HISTORY_MONTHS = 24;

export type DecimalSide = {
  /** Someone other than the person setting this up can approve what they send. */
  someoneElseCanApprove: boolean;
  /** No self-approval has been turned off, so they can approve their own. */
  selfApprovalOff: boolean;
  /** Bills approved in Decimal that never reached the books, and now never will by themselves. */
  approvedBeforeConnecting: { bills: number; sampleBillIds: string[] };
};

export type StudyFindings = Findings & { decimal: DecimalSide };

export const historySince = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, now.getUTCDate())).toISOString().slice(0, 10);

/** Who can approve, as far as a setup needs to know. Asked fresh each time: a person can join mid-chat. */
export async function approvalPicture(organizationId: string, userId: string | null) {
  const [elseCan, protections] = await Promise.all([
    userId ? someoneElseCanApprove(organizationId, userId) : Promise.resolve(false),
    listProtections(organizationId),
  ]);
  return {
    someoneElseCanApprove: elseCan,
    selfApprovalOff: protections.some((p) => p.code === 'R1' && p.relaxed && p.scopedPeople === null),
  };
}

/** Take the study, if it wants running and nobody is on it. Atomic: two wake-ups start one. */
export async function claimStudy(setupId: string): Promise<IntegrationSetup | null> {
  const rows = await prisma.$queryRaw<Array<{ setup_id: string }>>`
    UPDATE integration_setups
    SET study_lease_until = NOW() + make_interval(secs => ${LEASE_SECONDS}::double precision), updated_at = NOW()
    WHERE setup_id = ${setupId}::uuid AND status IN ('open', 'stopped') AND study_status = 'running'
      AND (study_lease_until IS NULL OR study_lease_until < NOW())
    RETURNING setup_id`;
  if (rows.length === 0) return null;
  return prisma.integrationSetup.findUnique({ where: { setupId } });
}

/** Studies a restart left behind: running, and nobody's lease on them. */
export async function studiesOwed(limit = 10): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ setup_id: string }>>`
    SELECT setup_id FROM integration_setups
    WHERE status IN ('open', 'stopped') AND study_status = 'running'
      AND (study_lease_until IS NULL OR study_lease_until < NOW())
    LIMIT ${limit}`;
  return rows.map((r) => r.setup_id);
}

async function step(setupId: string, key: string, text: string) {
  const entry = [{ key, text, at: new Date().toISOString() }];
  await prisma.$executeRaw`
    UPDATE integration_setups
    SET study_steps = study_steps || ${JSON.stringify(entry)}::jsonb,
        study_lease_until = NOW() + make_interval(secs => ${LEASE_SECONDS}::double precision), updated_at = NOW()
    WHERE setup_id = ${setupId}::uuid`;
}

function countOf(read: { records: unknown[]; expected: number }, one: string, many = `${one}s`): string {
  const got = read.records.length.toLocaleString('en-US');
  const unit = read.expected === 1 ? one : many;
  return read.records.length === read.expected ? `Read ${got} ${unit}` : `Read ${got} of ${read.expected.toLocaleString('en-US')} ${unit}`;
}

async function readEverything(setup: IntegrationSetup, reader: BooksReader): Promise<{ company: BooksCompany; findings: StudyFindings }> {
  const { setupId, organizationId, system } = setup;
  const scope: CopyScope = { organizationId, system, companyId: reader.companyId };
  const since = historySince();

  // A company signed out of leaves nothing behind for the next one to find.
  await deleteCopy(organizationId, system, reader.companyId);

  const company = await reader.company();
  await step(setupId, 'company', `Read the settings for ${company.name}`);

  const accounts = await reader.accounts();
  await replaceRecords(scope, 'category', accounts.records.map(toRows.category));
  await step(setupId, 'categories', countOf(accounts, 'category', 'categories'));

  const vendors = await reader.vendors();
  await replaceRecords(scope, 'vendor', vendors.records.map(toRows.vendor));
  await step(setupId, 'vendors', countOf(vendors, 'vendor'));

  const bills = await reader.bills(since);
  await replaceRecords(scope, 'bill', bills.records.map(toRows.bill));
  await step(setupId, 'bills', `${countOf(bills, 'bill')} since ${since}`);

  const expenses = await reader.expenses(since);
  await replaceRecords(scope, 'expense', expenses.records.map(toRows.expense));
  await step(setupId, 'expenses', `${countOf(expenses, 'expense')} since ${since}`);

  const [picture, approved] = await Promise.all([
    approvalPicture(organizationId, setup.startedByUserId),
    approvedBillsNotInTheBooks(organizationId),
  ]);
  await step(setupId, 'findings', 'Worked out how the team has been categorising');
  return {
    company,
    findings: {
      ...computeFindings({ company, since, accounts, vendors, bills, expenses }),
      decimal: { ...picture, approvedBeforeConnecting: { bills: approved.length, sampleBillIds: approved.slice(0, 5) } },
    },
  };
}

/** Questions code insists on. The model words them to the person, and can add its own. */
async function openRequiredCalls(setup: IntegrationSetup, findings: StudyFindings, closingDate: string | null) {
  const required = [
    {
      key: 'closing_date',
      kind: 'closing_date',
      question: 'What date are the books closed through? A bill dated on or before it cannot post.',
      recommendation: closingDate ? `Use ${closingDate}, the closing date in the books.` : null,
      why: closingDate ? 'It is what the books say today.' : 'The books do not say, so only the person can.',
    },
    ...(findings.decimal.someoneElseCanApprove || findings.decimal.selfApprovalOff ? [] : [{
      key: 'who_approves',
      kind: 'who_approves',
      question: 'Nobody else can approve a bill you send, so it would stop there and never post. Will you invite an approver, or turn No self-approval off?',
      recommendation: 'Invite an approver before the first bill.',
      why: 'A second person checking each bill is the safer setup. Turning the rule off goes on the record, and only the primary admin can do it.',
    }]),
  ];
  for (const call of required) {
    await prisma.integrationSetupCall.upsert({
      where: { setupId_key: { setupId: setup.setupId, key: call.key } },
      create: { setupId: setup.setupId, required: true, ...call },
      // A repeated study keeps an answer already given; only the words can change.
      update: { question: call.question, recommendation: call.recommendation, why: call.why },
    });
  }
}

/**
 * One go at the study. Whatever happens it ends with an event that asks for a turn,
 * so a person is always told. Returns whether it finished at all, so the caller
 * knows there is something to wake for.
 */
export async function runStudy(setupId: string): Promise<boolean> {
  const setup = await claimStudy(setupId);
  if (!setup) return false;
  const failed = async (kind: string, message: string) => {
    await prisma.integrationSetup.updateMany({
      where: { setupId, studyStatus: 'running' },
      data: { studyStatus: 'failed', studyLeaseUntil: null, studyError: { kind, message } },
    });
    await appendEvent(setupId, 'study_failed', { kind, message }, { wakes: true });
    return true;
  };
  const reader = await connectorFor(setup.system).reader(setup.organizationId);
  if (!reader) return failed('sign_in_lost', 'There is no live connection to read through.');
  try {
    const { company, findings } = await readEverything(setup, reader);
    // The person may have signed in to another company meanwhile: then this study is about nothing.
    const { count } = await prisma.integrationSetup.updateMany({
      where: { setupId, studyStatus: 'running', companyId: reader.companyId },
      data: { studyStatus: 'finished', studyLeaseUntil: null, studyError: Prisma.DbNull, findings: findings as object },
    });
    if (count === 0) return false;
    await openRequiredCalls(setup, findings, company.closingDate);
    await appendEvent(setupId, 'study_finished', { counts: findings.counts, shortfalls: findings.shortfalls }, { wakes: true });
    return true;
  } catch (error) {
    if (error instanceof BooksReadError) return failed(error.kind, error.message);
    logger.warn('integration_setup.study_crashed', { setupId, ...errorToLogFields(error) });
    return failed('crashed', 'The study stopped because of a problem on our side.');
  }
}

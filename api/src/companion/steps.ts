// The companion's work, written down as it happens.
//
// A job is one document. Each thing the companion does to it — open it, read
// it, check the figures, find the vendor, pick categories, look for copies — is
// a step, written when it starts and finished when it ends, so the console can
// show the work happening rather than report it afterwards.
//
// Recording is best-effort and never throws. A step that fails to write costs
// a line on a screen; it must never cost a bill.
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';

export type StepStatus = 'running' | 'done' | 'noted' | 'failed';

export type JobRef = {
  organizationId: string;
  invoiceDocumentId: string | null;
  paymentOrderId?: string | null;
};

export type Step = {
  /** Finished; nothing about it needs a person. */
  done(text?: string, detail?: string | null): Promise<void>;
  /** Finished, with something worth a look — shown, not blocking. */
  noted(text: string, detail?: string | null): Promise<void>;
  failed(text: string, detail?: string | null): Promise<void>;
};

const NOOP_STEP: Step = { done: async () => {}, noted: async () => {}, failed: async () => {} };

function clip(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Start a step. Its sentence says what is happening now ("Reading the bill"). */
export async function startStep(job: JobRef, kind: string, text: string, detail: string | null = null): Promise<Step> {
  if (!job.invoiceDocumentId) return NOOP_STEP;
  let stepId: string;
  try {
    const row = await prisma.companionStep.create({
      data: {
        organizationId: job.organizationId,
        invoiceDocumentId: job.invoiceDocumentId,
        paymentOrderId: job.paymentOrderId ?? null,
        kind,
        text: clip(text, 200)!,
        detail: clip(detail, 600),
      },
      select: { stepId: true },
    });
    stepId = row.stepId;
  } catch (error) {
    logger.warn('companion_step.start_failed', { kind, ...(error instanceof Error ? { message: error.message } : {}) });
    return NOOP_STEP;
  }
  const finish = async (status: StepStatus, next?: string, nextDetail?: string | null) => {
    try {
      await prisma.companionStep.update({
        where: { stepId },
        data: {
          status,
          ...(next ? { text: clip(next, 200)! } : {}),
          ...(nextDetail !== undefined ? { detail: clip(nextDetail, 600) } : {}),
          finishedAt: new Date(),
        },
      });
    } catch (error) {
      logger.warn('companion_step.finish_failed', { kind, ...(error instanceof Error ? { message: error.message } : {}) });
    }
  };
  return {
    done: (t, d) => finish('done', t, d),
    noted: (t, d) => finish('noted', t, d),
    failed: (t, d) => finish('failed', t, d),
  };
}

/** A step that is over the moment it is written. */
export async function recordStep(job: JobRef, kind: string, status: Exclude<StepStatus, 'running'>, text: string, detail: string | null = null): Promise<void> {
  const step = await startStep(job, kind, text, detail);
  if (status === 'done') await step.done();
  else if (status === 'noted') await step.noted(text);
  else await step.failed(text);
}

/**
 * Close anything a crash or restart left open. A step still "running" long
 * after its job could possibly be working is a lie on the console; it is
 * marked as interrupted instead.
 */
export async function closeAbandonedSteps(organizationId: string, olderThanMs = 5 * 60_000): Promise<void> {
  try {
    await prisma.companionStep.updateMany({
      where: { organizationId, status: 'running', startedAt: { lt: new Date(Date.now() - olderThanMs) } },
      data: { status: 'failed', detail: 'This step was interrupted before it finished.', finishedAt: new Date() },
    });
  } catch { /* the console survives without the tidy-up */ }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

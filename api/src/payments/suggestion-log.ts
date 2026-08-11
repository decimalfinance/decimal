// What we suggested, and what the human did about it.
//
// Recording only the value a person ended up with destroys the ability to ask
// whether we were any help. "The GL code is 7410" cannot tell you whether we
// proposed it, whether we proposed something else and were overridden, or
// whether nobody consulted us at all — and those are the same row.
//
// So: the suggestion is written UNCONDITIONALLY the moment it is made, and the
// outcome is a separate row that references it. Never one row updated in place,
// because an update erases the thing worth keeping.
//
// Both writes are best-effort. Instrumentation must never be the reason a
// person cannot get their work done, and a lost measurement costs less than a
// blocked bill.
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';

export type SuggestionStage = 'question_fields' | 'gl_coding' | 'ask_recipient';

/**
 * Call at the moment of suggesting, before knowing what the human will do.
 * Returns the id to attach an outcome to, or null if logging failed.
 */
export async function logSuggestion(args: {
  organizationId: string;
  stage: SuggestionStage;
  subjectType: string;
  subjectId?: string | null;
  suggested: unknown;
  confidence?: number | null;
  /** Model or rule that produced it, so behaviour changes are attributable. */
  producer: string;
  /**
   * Snapshotted here, not reconstructed later. Rebuilding "what did the model
   * know at time T" from other tables is fragile and quietly wrong as soon as
   * anything upstream changes.
   */
  inputs?: Record<string, unknown>;
  correlationId?: string | null;
}): Promise<string | null> {
  try {
    const row = await prisma.aiSuggestion.create({
      data: {
        organizationId: args.organizationId,
        stage: args.stage,
        subjectType: args.subjectType,
        subjectId: args.subjectId ?? null,
        suggested: (args.suggested ?? null) as never,
        confidence: args.confidence ?? null,
        producer: args.producer,
        inputs: (args.inputs ?? {}) as never,
        correlationId: args.correlationId ?? null,
      },
      select: { aiSuggestionId: true },
    });
    return row.aiSuggestionId;
  } catch (error) {
    logger.warn('suggestion_log.write_failed', {
      stage: args.stage,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
    return null;
  }
}

/**
 * Call when the human decides.
 *
 * 'edited' is the most informative outcome we get — the delta between what we
 * proposed and what they kept says exactly where we were wrong, which
 * 'accepted' and 'rejected' both hide.
 */
export async function logSuggestionOutcome(args: {
  aiSuggestionId: string | null;
  outcome: 'accepted' | 'edited' | 'rejected';
  finalValue?: unknown;
  decidedByUserId?: string | null;
}): Promise<void> {
  if (!args.aiSuggestionId) return;
  try {
    await prisma.aiSuggestionOutcome.create({
      data: {
        aiSuggestionId: args.aiSuggestionId,
        outcome: args.outcome,
        finalValue: (args.finalValue ?? null) as never,
        decidedByUserId: args.decidedByUserId ?? null,
      },
    });
  } catch (error) {
    logger.warn('suggestion_log.outcome_failed', {
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

/** Same shape, compared order-insensitively — field lists are sets, not lists. */
export function sameFieldSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

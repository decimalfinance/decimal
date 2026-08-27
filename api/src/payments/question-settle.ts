// A question settles when the thing it asked about is done.
//
// Somebody asks "please resolve this flag", an admin resolves it, and the
// question used to sit there anyway — still parking the bill, still demanding a
// typed sentence for something already handled. The question had been answered
// by the deed.
//
// The tempting fix is to send every edit to a model and ask "did that answer
// anything?". It is the wrong shape. It puts a model in the path of every save,
// makes cost scale with EDITS rather than questions, and destroys replayability
// inside an audit trail whose whole job is to say what happened — the same edit
// could settle a question today and not tomorrow. Worst of all it has a model
// deciding a bill may move toward payment.
//
// A question already declares what would settle it. `aboutFlag` names the check
// it came from; `highlightFields` names the fields it wants filled. So this is
// a join, not a judgement — the same call document-reconcile.ts makes about
// statements ("deliberately a query, not a model call").
//
// The one genuinely hard part is not about state at all, it is about language:
// did this question ask for MORE than the flag covers? That is judged once when
// the question is written and stored on the row as `questionScope`. See
// question-fields.ts.
import type { Prisma } from '@prisma/client';
import { prisma } from '../infra/prisma.js';
import { logger } from '../infra/logger.js';
import type { BillFlag } from './bill-flags.js';

/** What one deed did, in the terms a question can be measured against. */
export type Deed = {
  organizationId: string;
  paymentOrderId: string;
  /** Who did it. Anyone's deed settles a question, not only the person asked. */
  actorUserId: string | null;
  /** Their name, for the sentence written into the answer. */
  actorName: string;
  /** Said in plain words: "recorded 'X' as a name your organization trades under". */
  what: string;
  flagsBefore: BillFlag[];
  flagsAfter: BillFlag[];
  /** Field keys this deed changed, in the draft screen's vocabulary. */
  changedFields?: string[];
  at: Date;
};

type Settlement = {
  billQuestionId: string;
  taskId: string | null;
  /** Everything the deed put to rest, for the answer sentence. */
  resolvedFields: string[];
};

/**
 * Settle whatever this deed settled, and say so.
 *
 * Best-effort, and deliberately so: a bill that has been fixed must not fail
 * because its history could not be written. Matches the existing flag hook.
 */
export async function settleQuestionsFromDeed(deed: Deed): Promise<void> {
  try {
    const open = await prisma.billQuestion.findMany({
      where: {
        organizationId: deed.organizationId,
        paymentOrderId: deed.paymentOrderId,
        answeredAt: null,
      },
      select: {
        billQuestionId: true, taskId: true, aboutFlag: true,
        questionScope: true, highlightFields: true, resolvedFields: true,
      },
    });
    if (open.length === 0) return;

    // Compared as plain strings: `aboutFlag` is free text off the wire and may
    // name a check that no longer exists, which must read as "not cleared"
    // rather than fail to compile against the current flag vocabulary.
    const stillRaised = new Set<string>(deed.flagsAfter.map((f) => String(f.kind)));
    const cleared = new Set<string>(
      deed.flagsBefore.map((f) => String(f.kind)).filter((k) => !stillRaised.has(k)),
    );
    const changed = new Set(deed.changedFields ?? []);

    const settled: Settlement[] = [];
    const partial: Array<{ billQuestionId: string; resolvedFields: string[] }> = [];

    for (const q of open) {
      const asked = readStrings(q.highlightFields);
      const already = readStrings(q.resolvedFields);

      // Fields this deed put to rest, on top of whatever was already settled.
      const nowSettled = [...new Set([...already, ...asked.filter((f) => changed.has(f))])];
      const allFieldsDone = asked.length > 0 && nowSettled.length === asked.length;

      // A null scope is every question asked before this existed. Read as
      // 'asks_more': a person answers it, exactly as they do today.
      const coveredByFlag = q.questionScope === 'covered_by_flag';
      const flagSettled = Boolean(q.aboutFlag && cleared.has(q.aboutFlag));

      if ((flagSettled && coveredByFlag) || allFieldsDone) {
        settled.push({
          billQuestionId: q.billQuestionId,
          taskId: q.taskId,
          resolvedFields: nowSettled,
        });
      } else if (nowSettled.length > already.length) {
        // Some of what was asked is done and some is not. The existing partial
        // shape says exactly that, so use it rather than inventing a third.
        partial.push({ billQuestionId: q.billQuestionId, resolvedFields: nowSettled });
      }
    }

    for (const p of partial) {
      await prisma.billQuestion.update({
        where: { billQuestionId: p.billQuestionId },
        data: { resolvedFields: p.resolvedFields as Prisma.InputJsonValue },
      });
    }

    for (const s of settled) {
      // The answer is the deed, written out. An empty answer on a settled
      // question would tell the asker it was handled and nothing about how.
      const answer = `${deed.actorName} ${deed.what}`;
      await prisma.billQuestion.update({
        where: { billQuestionId: s.billQuestionId },
        data: {
          answer,
          answeredAt: deed.at,
          outcome: 'answered',
          resolvedFields: s.resolvedFields as Prisma.InputJsonValue,
        },
      });

      // Un-park the bill through the same command a typed answer uses, so the
      // engine and the record cannot drift apart.
      if (s.taskId && deed.actorUserId) {
        try {
          const { executeCommand } = await import('../approvals/lifecycle.js');
          const person = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM approval.people
            WHERE organization_id = ${deed.organizationId}::uuid
              AND user_id = ${deed.actorUserId}::uuid LIMIT 1`;
          if (person[0]) {
            await executeCommand({
              taskId: s.taskId,
              actorId: person[0].id,
              idempotencyKey: `settle:${s.billQuestionId}`,
              command: { kind: 'provide_info', answer } as never,
            });
          }
        } catch (error) {
          logger.warn('question_settle.resume_failed', {
            billQuestionId: s.billQuestionId,
            ...(error instanceof Error ? { message: error.message } : {}),
          });
        }
      }

      await prisma.paymentOrderEvent.create({
        data: {
          organizationId: deed.organizationId,
          paymentOrderId: deed.paymentOrderId,
          eventType: 'bill_question_settled',
          actorType: 'user',
          actorId: deed.actorUserId,
          beforeState: 'draft',
          afterState: 'draft',
          payloadJson: { answer, resolvedFields: s.resolvedFields },
          createdAt: deed.at,
        },
      });
    }
  } catch (error) {
    logger.warn('question_settle.failed', {
      paymentOrderId: deed.paymentOrderId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

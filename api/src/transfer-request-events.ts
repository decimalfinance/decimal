import type { Prisma } from '@prisma/client';

export async function createTransferRequestEvent(
  tx: Prisma.TransactionClient,
  input: {
    transferRequestId: string;
    workspaceId: string;
    eventType: string;
    actorType: 'user' | 'system' | 'worker';
    actorId?: string | null;
    eventSource: 'user' | 'system' | 'worker';
    beforeState?: string | null;
    afterState?: string | null;
    linkedSignature?: string | null;
    linkedPaymentId?: string | null;
    linkedTransferIds?: string[];
    payloadJson?: Prisma.InputJsonValue;
  },
) {
  await tx.transferRequestEvent.create({
    data: {
      transferRequestId: input.transferRequestId,
      workspaceId: input.workspaceId,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      eventSource: input.eventSource,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      linkedSignature: input.linkedSignature ?? null,
      linkedPaymentId: input.linkedPaymentId ?? null,
      linkedTransferIds: input.linkedTransferIds ?? [],
      payloadJson: input.payloadJson ?? {},
    },
  });
}

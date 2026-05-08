import type { ExecutionRecord, User } from '@prisma/client';

export const EXECUTION_RECORD_STATES = [
  'ready_for_execution',
  'submitted_onchain',
  'broadcast_failed',
  'settled',
  'execution_exception',
] as const;

export type ExecutionRecordState = (typeof EXECUTION_RECORD_STATES)[number];

export function isExecutionRecordState(value: string): value is ExecutionRecordState {
  return EXECUTION_RECORD_STATES.includes(value as ExecutionRecordState);
}

export function isManualExecutionRecordState(value: string) {
  return value === 'ready_for_execution' || value === 'submitted_onchain' || value === 'broadcast_failed';
}

export function serializeExecutionRecord(
  record: ExecutionRecord & {
    executorUser?: Pick<User, 'userId' | 'email' | 'displayName'> | null;
  },
) {
  return {
    executionRecordId: record.executionRecordId,
    transferRequestId: record.transferRequestId,
    organizationId: record.organizationId,
    submittedSignature: record.submittedSignature,
    executionSource: record.executionSource,
    executorUserId: record.executorUserId,
    state: record.state,
    submittedAt: record.submittedAt,
    metadataJson: record.metadataJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executorUser: record.executorUser
      ? {
          userId: record.executorUser.userId,
          email: record.executorUser.email,
          displayName: record.executorUser.displayName,
        }
      : null,
  };
}

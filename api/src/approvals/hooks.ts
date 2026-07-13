// Post-commit hooks: the engine's boundary to the rest of the product.
// Fired AFTER the engine's transaction commits (payment execution and other
// side effects must never run inside the engine's DB transaction). Handlers
// are best-effort: a failing hook logs, it never rolls back an approval.
import { logger } from '../infra/logger.js';
import type { ApprovableRow } from './store.js';

export type ApprovalTransition = 'approved' | 'auto_approved' | 'rejected' | 'cancelled' | 'pending_approval' | 'returned_for_info' | 'on_hold';

type Handler = (approvable: ApprovableRow, transition: ApprovalTransition) => Promise<void>;

const handlers: Handler[] = [];

export function registerApprovalHook(handler: Handler): void {
  handlers.push(handler);
}

export async function fireApprovalTransition(approvable: ApprovableRow, transition: ApprovalTransition): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(approvable, transition);
    } catch (error) {
      logger.warn('approval_hook.failed', {
        approvableId: approvable.id,
        transition,
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    }
  }
}

// The Inbox's lines as the Inbox page and Home both read them: the order they
// come in, which tab each is under, and the page each opens.
import type { InboxItem, InboxLineKind } from '../api';

/** Approvals first, then questions and the replies to yours, then the team's pile. */
export const LINE_ORDER: InboxLineKind[] = ['approval', 'question', 'reply', 'sent_back', 'sync_failed', 'review', 'unreadable', 'sign_off'];

/** The Questions tab: questions put to you, and the answers to yours. */
export const ASK_KINDS: InboxLineKind[] = ['question', 'reply'];

/** The page a line opens: its bill, or the file no bill came out of. */
export function pathOf(item: InboxItem, organizationId: string): string {
  return item.billId
    ? `/organizations/${organizationId}/bills/${item.billId}${item.href === 'draft' ? '/draft' : ''}`
    : `/organizations/${organizationId}/bills/documents/${item.jobId}/draft`;
}

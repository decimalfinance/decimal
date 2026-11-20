// What the Inbox endpoint sends, as a page receives it (JSON: dates are ISO strings).
// The contract between the API and the frontend: see bills.ts for how it works.
// Pure types, no imports beyond this folder.

export type InboxLineKind = 'approval' | 'question' | 'reply' | 'review' | 'sign_off' | 'sent_back' | 'unreadable' | 'sync_failed' | 'sync_held';

/** One thing wanted of a person on a bill: who it comes from, what they did, their words. */
export interface InboxLine {
  kind: InboxLineKind;
  /** The whole line as one sentence. */
  text: string;
  /** Before any quote: "Zara Okafor asked". */
  lead: string;
  /** Their own words: a question, an answer, a reason. */
  quote: string | null;
  /** None for what Decimal raises itself. */
  who: { name: string; avatarUrl: string | null } | null;
  at: string;
  /** Since this person last opened the bill. */
  isNew: boolean;
  /** For a line about the books: which, by name. */
  books?: string;
  from?: string | null;
  questionId?: string;
}

/** One bill in a person's inbox, with everything wanted of them on it. */
export interface InboxItem {
  key: string;
  billId: string | null;
  jobId: string | null;
  vendorName: string;
  /** What the bill is for: its first line, or its memo. */
  description: string | null;
  invoiceNumber: string | null;
  amountUsd: number | null;
  status: string | null;
  dueAt: string | null;
  href: 'draft' | 'bill' | null;
  lines: InboxLine[];
  latestAt: string;
  isNew: boolean;
}

/** GET /organizations/:organizationId/inbox: everything wanted of the viewer, a bill to an item. */
export interface Inbox {
  items: InboxItem[];
  count: number;
  newCount: number;
}

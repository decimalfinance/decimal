// Is a draft bill READY, or does it need a person?
//
// The companion's briefing sorts every draft into those two piles, and the
// briefing is only worth reading if "ready" can be trusted. So this is strict:
// a bill is ready only when nothing about it calls for judgement — no flag, no
// doubtful read, a vendor seen before, and categories that come from a habit
// rather than a guess. Everything else needs a person, with the single most
// important reason in one line.
//
// Starting strict is deliberate. A too-generous "ready" is the fastest way to
// teach people to stop trusting the briefing. It loosens later, on evidence.

import { DOUBTFUL_FIELD_STATUSES } from '../payments/document-extract.js';

export type CompanionVerdict = {
  ready: boolean;
  /** Why it needs a person, in one line. Null when ready. */
  reason: string | null;
};

/** The fields a doubt about which means somebody must look. */
const KEY_FIELDS: Record<string, string> = {
  vendorName: 'the vendor',
  invoiceNumber: 'the invoice number',
  total: 'the total',
  invoiceDate: 'the invoice date',
  dueDate: 'the due date',
  lineItems: 'the line items',
};

export function companionReadiness(args: {
  state: string;
  vendorName: string;
  /** The bill's flags, as bill-flags.ts evaluated them. */
  flags: Array<{ severity: 'danger' | 'warning' | 'info'; blocking: boolean; short: string }>;
  /** Facts the bill cannot leave draft without (amount, line items). */
  missing: string[];
  priorBillsFromVendor: number;
  /** A coding rule exists for this vendor, so its categories are not a guess. */
  hasCodingRule: boolean;
  /** How sure the reader was of each field, as extracted. */
  fieldStatus: Record<string, unknown> | null;
  /** Values the reader gave that appear nowhere in the document. */
  ungrounded: string[];
  /** A person has already confirmed the values, so the reader's doubts are settled. */
  confirmedByPerson: boolean;
  /** Someone asked a question about this bill that is not answered yet: who was asked. */
  openQuestionTo?: string | null;
}): CompanionVerdict | null {
  if (args.state !== 'draft') return null;

  // In order of importance: the first that applies is the reason given.
  const blocking = args.flags.find((f) => f.blocking);
  if (blocking) return { ready: false, reason: blocking.short };
  if (args.missing.length > 0) return { ready: false, reason: `Missing ${args.missing.join(' and ')}` };
  const warning = args.flags.find((f) => f.severity === 'warning');
  if (warning) return { ready: false, reason: warning.short };
  // A question is a judgement somebody is still making about this bill.
  if (args.openQuestionTo) return { ready: false, reason: `Waiting on an answer from ${args.openQuestionTo}` };

  if (!args.confirmedByPerson) {
    const doubtful = Object.keys(KEY_FIELDS).find((k) => {
      const status = args.fieldStatus?.[k];
      return typeof status === 'string' && DOUBTFUL_FIELD_STATUSES.has(status);
    }) ?? Object.keys(KEY_FIELDS).find((k) => args.ungrounded.includes(k));
    if (doubtful) return { ready: false, reason: `Worth a second look at ${KEY_FIELDS[doubtful]}` };
  }

  if (args.priorBillsFromVendor === 0) return { ready: false, reason: `First bill from ${args.vendorName}` };
  if (!args.hasCodingRule) return { ready: false, reason: `No category habit for ${args.vendorName} yet` };

  return { ready: true, reason: null };
}

// What the bill endpoints send, as a page receives it (JSON: dates are ISO strings).
//
// This is the contract between the API and the frontend. The frontend reads
// these types (frontend/src/api.ts re-exports them); the API's typecheck proves
// it sends them (checks.ts). So a field a page relies on can't quietly go
// missing or change type on one side: `make test` fails on whichever side is wrong.
//
// Pure types, no imports beyond this folder: both the API (NodeNext) and the
// frontend (bundler) compile this file.

/** What a document turned out to be, when it isn't an invoice. */
export type DocumentKind = 'statement' | 'credit_note' | 'receipt' | 'quote' | 'purchase_order' | 'other';

/** Why a bill was closed without being paid. */
export type BillCloseReason = 'duplicate' | 'statement' | 'credit_note' | 'not_ours' | 'unreadable' | 'other';

/** Where one approver on the route stands, in the three words a strip can render (and upcoming). */
export type RouteStepState = 'done' | 'declined' | 'waiting' | 'upcoming';

/** The file a bill came from: 'processing' while Decimal is still working on it. */
export type DocumentStatus = 'processing' | 'processed' | 'failed' | 'removed';

/** Looking for the bill in the books: the page asks again until it is done. */
export type BooksCheckStatus = 'running' | 'ready' | 'failed';

/** Why a line has the Category it has, so the page can say so. */
export type CategoryFrom =
  | { kind: 'memory'; like: string; invoiceNumber: string | null; paymentOrderId: string | null; by: string | null; books?: string | null }
  | { kind: 'similar'; like: string; invoiceNumber: string | null; paymentOrderId: string | null; by: string | null; vendorName?: string | null }
  | { kind: 'model' };

export type BillBucket = 'draft' | 'in_approval' | 'to_pay' | 'done' | 'needs_attention';

/**
 * A document we hold but have not finished reading. Not a bill: no vendor, no
 * amount, no payment order behind it. It becomes one when extraction lands.
 */
export interface PendingDocument {
  invoiceDocumentId: string;
  filename: string;
  status: 'processing' | 'failed';
  error: string | null;
  createdAt: string;
  uploadedByName: string | null;
}

/** GET /organizations/:organizationId/bills/workbench: the Bills page. */
export interface BillsWorkbench {
  counts: Record<BillBucket, number>;
  draftCounts: { ready: number; missingInfo: number };
  /** Uploaded, stored, not yet read: no bill exists for these yet. */
  pending: PendingDocument[];
  bills: WorkbenchBill[];
  questionsForYou: number;
}

export interface WorkbenchBill {
  paymentOrderId: string;
  bucket: BillBucket;
  state: string;
  vendorName: string;
  /** The vendor record it is filed under. */
  counterpartyId: string | null;
  /** The vendor's contact as this bill gives it: what a person verified, else what was read. */
  vendorEmail: string | null;
  vendorAddress: { street: string | null; city: string | null; state: string | null; zip: string | null; country: string | null } | null;
  description: string | null;
  amountUsd: number;
  amountOriginal: { amount: number; currency: string } | null;
  invoiceNumber: string | null;
  invoiceDocumentId: string | null;
  filename: string | null;
  /** In review, and nothing could be read off its document. */
  unreadable: boolean;
  dueAt: string | null;
  createdAt: string;
  // How the bill arrived. 'email' means someone forwarded it to the org's
  // intake address; sourceLabel names them ("Emailed by Priya Sharma").
  source: 'email' | 'upload';
  sourceLabel: string | null;
  discountLabel: string | null;
  readiness: 'ready' | 'missing_info' | null;
  missing: string[];
  subStatus: {
    kind: 'plain' | 'person' | 'loud';
    text: string;
    tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    blockedBy?: { name: string } | null;
  };
  // Present when this bill was flagged as a duplicate and an admin cleared it.
  duplicateCleared: { byName: string; reason: string } | null;
  /** Somebody is waiting on YOU for an answer about this bill. */
  questionForYou: { billQuestionId: string; question: string; askedByName: string | null } | null;
  /** What is flagged on it, worst first. */
  flags: Array<{ kind: string; severity: 'danger' | 'warning' | 'info'; blocking: boolean; short: string }>;
  blocking: boolean;
  /** An approver sent it back to review, or an admin did after approval. */
  sentBack: boolean;
  /** Who sent it back and why, as they said it. */
  sentBackBy: { name: string | null; reason: string | null } | null;
  /** Everyone who could act on it now: "Tom or Ines" when either may. */
  waitingOn: Array<{ userId: string | null; name: string }>;
  /** Where the books have got to with it, once approved; `books` says which, QuickBooks or Xero. `held`: it may be there already, and waits for an answer. */
  posting: { status: 'posted' | 'failed' | 'pending' | 'held'; books: string; at: string } | null;
  /** Why a closed bill was closed. */
  closedReason: BillCloseReason | null;
}

export type DocSource = {
  page: number;
  box: [number, number, number, number];
  /** Degrees the page's text is tilted, when it is; the highlight turns with it. */
  angle?: number;
} | null;

export interface BillDraftField {
  /** Worked out from the address rather than read off the document. */
  inferred?: boolean;
  key: string;
  label: string;
  value: string | number | null;
  /** `changed`: a person changed it from Decimal's reading. `confirmed`: a person ticked a reading Decimal doubted. */
  state: 'read' | 'needs_look' | 'not_on_document' | 'confirmed' | 'changed';
  reason: string | null;
  source?: DocSource;
}

/**
 * A field against Decimal's reading, by the bill page's keys: what was read and how
 * that went (what the field goes back to when a value is put back), whether a person
 * changed it, and who put the value there.
 */
export interface BillFieldMark {
  read: string | null;
  look: 'read' | 'needs_look' | 'not_on_document';
  reason: string | null;
  changed: boolean;
  by: { name: string; avatarUrl: string | null } | null;
}

/**
 * One thing somebody did to a bill. The server writes the sentence — a history
 * that phrases itself differently on each screen is two histories.
 */
export interface BillWorkLogEntry {
  id: string;
  kind: 'field_changed' | 'flag_raised' | 'flag_cleared' | 'policy_overridden' | 'question_settled';
  at: string;
  byName: string | null;
  text: string;
  field: string | null;
  detail: string | null;
  /** The check an override set aside: 'pay_the_itemised_total', 'duplicate_bill', 'bill_ceiling', 'similar_vendor'. */
  rule?: string | null;
}

export interface CategoryOption { value: string; label: string; num?: string | null; group: string }

/** The exception agent's finding for a flag about one bill. A person still decides. */
export interface FlagFinding {
  status: 'ready' | 'running';
  headline: string;
  points: Array<{ text: string; tone: 'ok' | 'warn' | 'bad'; billId?: string | null; billState?: string | null }>;
  recommended: { action: string; reason: string } | null;
  /**
   * The arithmetic flags only: what the document shows the bill is missing or
   * has wrong. "Correct the figures" applies exactly this (billsApi.correctFigures).
   */
  correction?: FigureCorrection;
}

export interface FigureCorrection {
  /** Lines to add. Signed: a discount or a deposit is negative. */
  add: Array<{ description: string; amount: number; page: number }>;
  /** Figures to put right. `line` is the bill line's index, from 0. */
  change: Array<{ what: 'line' | 'tax' | 'total'; line: number | null; label: string; from: number; to: number; page: number }>;
  /** The bill's total once corrected: its lines and tax come to this. */
  total: number;
}

export interface BillDraftLine {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  category: string | null;
  /**
   * Why this line has its category, while it is still the machine's. memory: a
   * line the team settled before from this vendor, here or (books set) in their
   * accounting system, so known. similar: the model
   * followed a past line it judged the same purchase (vendorName set when that
   * line was another vendor's), still a guess. model: its own reading. Null
   * once a person has settled it.
   */
  categoryFrom?: CategoryFrom | null;
  /** The person who picked this category or ticked the guess. */
  categoryConfirmedBy?: { name: string; avatarUrl: string | null } | null;
  source?: DocSource;
}

export interface BillDraft {
  paymentOrderId: string;
  state: string;
  readOnly: boolean;
  /**
   * Present only when the document is NOT an invoice. The screen switches on
   * this rather than on whether a flag happens to be blocking: what a document
   * IS should choose the interface, not what it tripped.
   */
  notABill: {
    kind: DocumentKind;
    /** Credit notes: the invoice the credit applies to, if named. */
    appliesToInvoice: string | null;
    /** Statements: their rows, checked against the bills we already hold. */
    statement: {
      rows: Array<{
        reference: string | null;
        date: string | null;
        amountUsd: number | null;
        statedStatus: 'paid' | 'open' | 'overdue' | 'unknown' | null;
        held: { paymentOrderId: string; invoiceNumber: string | null; state: string; where: string } | null;
      }>;
      missing: number;
      alreadyPaid: number;
    } | null;
  } | null;
  /** Why, when it is read-only: the bill has left draft, or preparing it
   *  is not this reader's job. Null when the form is editable. */
  readOnlyReason?: 'settled' | 'not_your_job' | null;
  /** Whether this reader may answer, reply and comment here. Wider than
   *  editing: approvers asked about a draft take part too. */
  canJoinConversation: boolean;
  // How the bill arrived; sourceLabel names who forwarded it.
  source: 'email' | 'upload';
  sourceLabel: string | null;
  // An approver sent this bill back for changes — shown as the bill clerk's homework.
  sentBack: { reason: string | null; byName: string | null; at: string | null } | null;
  /** `name` is what the DOCUMENT prints; `paidAs` is the vendor record it is
   *  linked to, present only when that record goes by a different name. */
  vendor: { name: string; paidAs?: string | null; counterpartyId?: string | null; email: string | null; nameSource?: DocSource; emailSource?: DocSource; nameState: BillDraftField['state']; emailState: BillDraftField['state']; isNew: boolean; trustState: string };
  document: {
    invoiceDocumentId: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    pageCount: number | null;
    /** 'processing' while Decimal is still working on the file the bill came from. */
    status: DocumentStatus;
  } | null;
  /**
   * The file it was uploaded in, when that held other bills too. `document` is then
   * this bill's own pages of it, when they could be told apart (`pages`), or the
   * whole file when they couldn't (`pages` null).
   */
  upload?: {
    invoiceDocumentId: string;
    filename: string;
    pageCount: number | null;
    pages: { from: number; to: number } | null;
    otherBills: Array<{ paymentOrderId: string; invoiceNumber: string | null; vendorName: string; state: string }>;
  } | null;
  /** Nothing could be read off the document: the fields are placeholders until a person types them. */
  unreadable: boolean;
  /** How many lines the reading found. A line added since doesn't count. */
  readLines?: number;
  fields: BillDraftField[];
  remitFields: BillDraftField[];
  /** A reference to offer when the document prints no invoice number. */
  suggestedReference?: string | null;
  lines: BillDraftLine[];
  categoryOptions: CategoryOption[];
  // Why the bill-level category was suggested: what the document says it is for.
  codingSuggestionSource: { kind: 'ocr'; detail: string } | null;
  totalsSources: { lineItems: DocSource; tax: DocSource; total: DocSource };
  taxAmount: number | null;
  totalUsd: number;
  paymentBlock: { method: string | null; bankName: string | null; accountLast4: string | null; sendToLabel: string; sourceTreasuryWalletId: string | null; matchesVerified: boolean };
  organizationName: string;
  route: Array<{ name: string; stepIndex: number; state: RouteStepState }>;
  workLog: BillWorkLogEntry[];
  /** Every field a question may point at — the server's closed vocabulary. */
  highlightableFields: string[];
  /** Who confirmed each field, by its key ("invoiceDate", "vendor.name", "remitTo.city"). */
  confirmedBy?: Record<string, { name: string; avatarUrl: string | null }>;
  marks?: Record<string, BillFieldMark>;
  /** Names recorded as the organisation's own off this bill ("This is us"), and who recorded them. */
  tradingNamesFromHere?: Array<{ name: string; byName: string | null; at: string | null; removed?: boolean }>;
  comments: Array<{
    billCommentId: string;
    body: string;
    authorUserId: string;
    authorName: string;
    inReplyToQuestionId: string | null;
    inReplyToCommentId: string | null;
    at: string;
  }>;
  questions: Array<{
    billQuestionId: string; question: string; aboutFlag: string | null;
    askedByUserId: string; askedByName: string;
    askedOfUserId: string; askedOfName: string;
    answer: string | null; answeredAt: string | null; askedAt: string;
    outcome: 'answered' | 'partial' | 'handed_back' | 'forwarded' | 'closed' | null;
    /** Who answered: anyone who works on bills may, not only the person asked. */
    answeredByName: string | null;
    stillOpen: boolean; resolvedFields: string[]; openFields: string[];
    /** This viewer may answer it (they work on bills and did not ask it). */
    canAnswer: boolean;
    /** This viewer asked it and it is still open, so they may close it. */
    canClose: boolean;
    forwardedFromQuestionId: string | null;
    youWereAsked: boolean; youAsked: boolean;
    /** Draft-screen field keys this question is about. */
    highlightFields: string[];
    /**
     * How it was answered: 'message' in the conversation (answerCommentId is
     * that message, already in the thread), 'deed' by doing what it asked,
     * 'words' in the old answer box. Null before 2026-10-21.
     */
    answerVia: 'message' | 'deed' | 'words' | null;
    answerCommentId: string | null;
  }>;
  flags: Array<{
    kind: string;
    severity: 'danger' | 'warning' | 'info';
    message: string;
    blocking: boolean;
    short: string;
    /** What can be done about it — rendered on the flag, never in a footer. */
    resolutions: Array<{
      action: 'this_is_us' | 'not_ours' | 'ask_someone' | 'clear_duplicate' | 'fix_fields' | 'raise_ceiling' | 'release_vendor' | 'pay_the_lines'
        | 'allow_over_ceiling'
        | 'same_vendor' | 'different_vendor'
        | 'same_bill' | 'different_bill'
        | 'post_in_open_period' | 'keep_date';
      /** The answer is a determination, so the composer asks for no reason. */
      noReason?: boolean;
      /** The other record the answer is about. */
      targetId?: string;
      label: string;
      requires: 'anyone' | 'admin' | 'primary_admin';
      detail: string;
    }>;
    /** The exception agent's investigation of this flag, when it has one. */
    brief?: ExceptionBrief;
    /** What the exception agent found about a flag on this bill alone (statement, credit note, figures, bill-to name). */
    finding?: FlagFinding;
  }>;
  /** Looking in QuickBooks for this bill already there: `running` until the look is done. */
  booksCheck?: { status: BooksCheckStatus } | null;
  verification: { confirmedAt: string | null; confirmedByUserId: string | null; noteForApprovers: string | null } | null;
}

/**
 * What the exception agent found about a flag, from THIS bill's point of view.
 * Advisory only: the flag still blocks, and a person still confirms.
 */
export interface ExceptionBrief {
  briefId: string;
  status: 'running' | 'ready' | 'failed';
  verdict: 'duplicate' | 'replacement' | 'not_duplicate' | 'unsure' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  headline: string | null;
  /** Prefilled as the reason when the person takes the recommended action. */
  reason: string | null;
  /**
   * What the verdict means for this bill: one of the flag's own resolutions,
   * or `close_other` on the bill to keep (nothing to do here; close the other).
   */
  recommendedAction: 'clear_duplicate' | 'not_ours' | 'ask_someone' | 'close_other' | null;
  side: 'older' | 'newer';
  otherBill: { paymentOrderId: string; invoiceNumber: string | null };
  findings: Array<{
    claim: string;
    /** `bill` is null for evidence about neither bill alone (the comparison, the vendor's history). */
    evidence: Array<{ bill: 'this' | 'other' | null; key: string }>;
  }>;
  checked: string[];
  couldNotCheck: string[];
  generatedAt: string | null;
  /** The two bills side by side, computed from their current values. The evidence a person reads. */
  comparison: {
    identical: boolean;
    otherUploadedAt: string;
    rows: Array<{ key: string; label: string; here: string | null; there: string | null; same: boolean | null }>;
  } | null;
}

export interface BillDetailStepNode {
  stepIndex: number;
  person: { personId: string; name: string; avatarUrl: string | null } | null;
  purpose: string | null;
  mode: string;
  /** Approvals this STEP needs. An 'any' step of two people needs one. */
  required: number;
  /** People invited to the step — `required` of them have to say yes. */
  candidates: number;
  state: 'done' | 'current' | 'upcoming' | 'declined' | 'stopped' | 'delegated' | 'skipped';
  actedAt: string | null;
  declineReason: string | null;
  thread: {
    open: boolean;
    waitingOn: string | null;
    messages: Array<{ person: { personId: string; name: string; avatarUrl: string | null } | null; body: string; at: string }>;
  } | null;
}

/**
 * A request to pull a bill out of approval. Raising one freezes the bill; an
 * primary admin or admin then grants it (approvals invalidated, bill back to draft) or
 * denies it (bill resumes exactly where it stood).
 */
export interface BillRecall {
  recallRequestId: string;
  reason: string;
  state: 'pending' | 'granted' | 'denied' | 'withdrawn';
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The asker decided it themselves — shown as such, never passed off as review. */
  selfDecided: boolean;
}

/**
 * The parts of a bill's life that sit outside the approval plan: who brought
 * it in and who submitted it, and who releases the money afterwards.
 */
export interface BillHistoryEntry {
  kind: 'uploaded' | 'forwarded' | 'submitted'
    // How a bill came back out of approval — without these, two trips
    // through the flow render as two identical 'submitted' rows.
    | 'sent_back' | 'recalled' | 'cancelled'
    | 'release_pending' | 'released' | 'paid';
  /** Null when it has not happened yet. */
  at: string | null;
  person: { name: string; avatarUrl: string | null } | null;
}

export interface BillDetail {
  draft: BillDraft;
  history: { before: BillHistoryEntry[]; after: BillHistoryEntry[] };
  corrections: Array<{ field: string; from: string; to: string; by: string | null }>;
  // Advisory: routine vs worth-a-look, same classifier as the approvals inbox.
  signal?: InboxSignal;
  recall: { open: BillRecall | null; history: BillRecall[] };
  status: { macroState: string | null; subStatus: WorkbenchBill['subStatus'] };
  /** A closed bill: why, the note, who closed it and when. */
  closed: {
    reason: BillCloseReason | null;
    note: string | null;
    by: { name: string; avatarUrl: string | null } | null;
    at: string | null;
  } | null;
  /** How far the books got with an approved bill; `books` says which, QuickBooks or Xero. */
  /** `retrying`: a failed post the sweep will still try again by itself. */
  /** `held`: the books may have it already, and nothing goes until someone says. `linked`: it was there, and Decimal linked to it. */
  posting: { status: 'posted' | 'failed' | 'pending' | 'held'; books: string; at: string; error: string | null; retrying: boolean; linked?: boolean } | null;
  /** The books this bill posts to, by name: where it went, else where the team's bills go now. Null when they go nowhere. */
  books: string | null;
  approval: {
    approvableId: string;
    macroState: string;
    steps: BillDetailStepNode[];
    flowVersion: number | null;
    protectionNote: string | null;
    release: { macroState: string } | null;
  } | null;
  viewer: {
    personId: string | null;
    name: string | null;
    isRequester: boolean;
    openTaskId: string | null;
    /**
     * Set when the viewer holds the open task but the engine would refuse their
     * approval anyway — they submitted or entered this bill and the org
     * separates those jobs. Present so the screen never offers a button it
     * already knows will 409.
     */
    cannotApprove: { rule: string; why: string; remedy: string } | null;
    viewerHasOpenAsk?: boolean;
    openAskTaskId?: string | null;
    anyTaskId: string | null;
  };
  requester: { personId: string; userId: string | null; name: string; avatarUrl: string | null } | null;
}

export interface InboxSignal { clean: boolean; label: string; detail: string | null }

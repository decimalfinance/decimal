// Briefs: when the agent runs, where its answer is kept, and how a bill reads it.
//
// Two triggers and no others: right after intake, and when the draft screen is
// read. Never from flagsForOrder or the workbench — those run for every row on
// the board, at confirm, and around every override, and a trigger there would
// start an investigation per flagged bill each time anyone opened the list.
//
// A read can start work, which is new in this codebase, so the claim is atomic:
// one upsert that only succeeds when nothing is running (or the last run's lease
// has lapsed) and the evidence has changed since the last answer. Two tabs, a
// polling screen and queue navigation all race here; exactly one run starts.
import { prisma } from '../infra/prisma.js';
import { trackBackgroundWork } from '../infra/background.js';
import { logger } from '../infra/logger.js';
import { describeDuplicate, findDuplicateBills, readDuplicateOverride, type DuplicateMatch } from '../payments/duplicate-check.js';
import { logSuggestion, logSuggestionOutcome } from '../payments/suggestion-log.js';
import { isExceptionAgentConfigured } from './agent.js';
import { investigateDuplicatePair, DUPLICATE_PRODUCER } from './duplicate.js';
import {
  pairFingerprint, pairKey, recommendationFor, sideOf,
  type Confidence, type FingerprintSide, type RecommendedAction, type Verdict,
} from './duplicate-logic.js';

const FLAG_KIND = 'possible_duplicate';
const LEASE_MS = 2 * 60_000;
/** A failed run is not retried on every read, but not given up on forever. */
const FAILED_RETRY_MS = 10 * 60_000;
const CONFIDENCE_SCORE: Record<Confidence, number> = { high: 0.9, medium: 0.6, low: 0.3 };

type PairBill = {
  paymentOrderId: string;
  invoiceNumber: string | null;
  amountRaw: bigint;
  counterpartyId: string | null;
  state: string;
  createdAt: Date;
  metadataJson: unknown;
};

export type BriefEvidence = { bill: 'this' | 'other' | null; key: string };

/** What a bill's draft screen shows, from that bill's point of view. */
export type DuplicateBriefView = {
  briefId: string;
  status: 'running' | 'ready' | 'failed';
  verdict: Verdict | null;
  confidence: Confidence | null;
  headline: string | null;
  reason: string | null;
  /** What this verdict means for THIS bill. Decided in code, never by the model. */
  recommendedAction: RecommendedAction | null;
  side: 'older' | 'newer';
  otherBill: { paymentOrderId: string; invoiceNumber: string | null };
  findings: Array<{ claim: string; evidence: BriefEvidence[] }>;
  checked: string[];
  couldNotCheck: string[];
  generatedAt: string | null;
};

const sideFrom = (b: PairBill): FingerprintSide => ({
  id: b.paymentOrderId,
  invoiceNumber: b.invoiceNumber,
  amountRaw: b.amountRaw,
  counterpartyId: b.counterpartyId,
  state: b.state,
  hasOverride: Boolean(readDuplicateOverride(b.metadataJson)),
});

const PAIR_BILL_SELECT = {
  paymentOrderId: true, invoiceNumber: true, amountRaw: true, counterpartyId: true, state: true, createdAt: true, metadataJson: true,
} as const;

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Refs are stored against bill ids, not "this" and "other": the brief belongs
 * to the pair and is read from both sides, so "this" would point at the wrong
 * bill half the time. They are turned back into this/other for whoever reads.
 */
function toStoredRef(ref: string, thisId: string, otherId: string): string {
  if (ref.startsWith('this.')) return `${thisId}.${ref.slice(5)}`;
  if (ref.startsWith('other.')) return `${otherId}.${ref.slice(6)}`;
  return ref;
}

function toViewerRef(ref: string, viewerId: string, otherId: string): BriefEvidence {
  const dot = ref.indexOf('.');
  const head = dot === -1 ? ref : ref.slice(0, dot);
  if (head === viewerId) return { bill: 'this', key: ref.slice(dot + 1) };
  if (head === otherId) return { bill: 'other', key: ref.slice(dot + 1) };
  return { bill: null, key: ref };
}

type BriefRow = NonNullable<Awaited<ReturnType<typeof prisma.billExceptionBrief.findUnique>>>;

function view(row: BriefRow | null, args: {
  briefId: string; status: DuplicateBriefView['status']; viewer: PairBill; other: PairBill;
}): DuplicateBriefView {
  const side = sideOf({ id: args.viewer.paymentOrderId, createdAt: args.viewer.createdAt }, { id: args.other.paymentOrderId, createdAt: args.other.createdAt });
  const ready = args.status === 'ready' && row;
  const verdict = ready ? (row.verdict as Verdict | null) : null;
  const findings = ready && Array.isArray(row.findings) ? (row.findings as Array<{ claim?: unknown; refs?: unknown }>) : [];
  return {
    briefId: args.briefId,
    status: args.status,
    verdict,
    confidence: ready ? (row.confidence as Confidence | null) : null,
    headline: ready ? row.headline : null,
    reason: ready ? row.reason : null,
    recommendedAction: verdict ? recommendationFor(verdict, side) : null,
    side,
    otherBill: { paymentOrderId: args.other.paymentOrderId, invoiceNumber: args.other.invoiceNumber },
    findings: findings
      .filter((f) => typeof f.claim === 'string')
      .map((f) => ({
        claim: f.claim as string,
        evidence: asStrings(f.refs).map((r) => toViewerRef(r, args.viewer.paymentOrderId, args.other.paymentOrderId)),
      })),
    checked: ready ? asStrings(row.checked) : [],
    couldNotCheck: ready ? asStrings(row.couldNotCheck) : [],
    generatedAt: ready ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Claim the pair for a run. Returns the brief id if THIS caller won, null if
 * someone else is already on it or the answer is still current.
 */
async function claimRun(args: { organizationId: string; key: string; firstId: string; secondId: string; fingerprint: string }): Promise<string | null> {
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ brief_id: string }>>`
    INSERT INTO bill_exception_briefs
      (organization_id, flag_kind, pair_key, first_payment_order_id, second_payment_order_id, status, fingerprint, lease_until, updated_at)
    VALUES
      (${args.organizationId}::uuid, ${FLAG_KIND}, ${args.key}, ${args.firstId}::uuid, ${args.secondId}::uuid, 'running', ${args.fingerprint}, ${leaseUntil}, NOW())
    ON CONFLICT (pair_key, flag_kind) DO UPDATE
      SET status = 'running', fingerprint = EXCLUDED.fingerprint, lease_until = EXCLUDED.lease_until, error = NULL, updated_at = NOW()
      WHERE (bill_exception_briefs.status = 'running' AND bill_exception_briefs.lease_until < NOW())
         OR (bill_exception_briefs.status <> 'running'
             AND (bill_exception_briefs.fingerprint <> EXCLUDED.fingerprint OR bill_exception_briefs.status = 'failed'))
    RETURNING brief_id`;
  return rows[0]?.brief_id ?? null;
}

async function runInvestigation(args: {
  briefId: string; organizationId: string; key: string; fingerprint: string;
  thisId: string; otherId: string; match: DuplicateMatch;
}): Promise<void> {
  const fail = (error: string, metrics: Partial<{ model: string; latencyMs: number; promptTokens: number; completionTokens: number; turns: number }> = {}) =>
    prisma.billExceptionBrief.updateMany({
      where: { briefId: args.briefId, fingerprint: args.fingerprint },
      data: { status: 'failed', error: error.slice(0, 500), leaseUntil: null, updatedAt: new Date(), ...metrics },
    });
  try {
    const inv = await investigateDuplicatePair({
      organizationId: args.organizationId,
      thisId: args.thisId,
      otherId: args.otherId,
      matchKind: args.match.matchKind,
      fallbackHeadline: describeDuplicate(args.match),
    });
    const metrics = {
      model: inv.run.model, latencyMs: inv.run.latencyMs, turns: inv.run.turns,
      promptTokens: inv.run.promptTokens, completionTokens: inv.run.completionTokens,
    };
    if (!inv.run.ok || !inv.finding) {
      await fail(inv.run.ok ? 'no finding' : inv.run.error, metrics);
      return;
    }
    const f = inv.finding;
    const suggestionId = await logSuggestion({
      organizationId: args.organizationId,
      stage: 'exception_brief',
      subjectType: 'bill_pair',
      subjectId: args.briefId,
      suggested: { flagKind: FLAG_KIND, verdict: f.verdict, confidence: f.confidence, headline: f.headline, reason: f.reason },
      confidence: CONFIDENCE_SCORE[f.confidence],
      producer: `${DUPLICATE_PRODUCER}@${inv.run.model}`,
      inputs: {
        pairKey: args.key,
        fingerprint: args.fingerprint,
        bills: [args.thisId, args.otherId],
        matchKind: args.match.matchKind,
        identical: inv.comparison.identical,
        totalsDelta: inv.comparison.totals.delta,
        explainedBy: inv.comparison.totalDifferenceExplainedBy,
        adjustments: f.adjustments,
      },
    });
    await prisma.billExceptionBrief.updateMany({
      where: { briefId: args.briefId, fingerprint: args.fingerprint },
      data: {
        status: 'ready',
        verdict: f.verdict,
        confidence: f.confidence,
        headline: f.headline,
        reason: f.reason,
        findings: f.findings.map((x) => ({ claim: x.claim, refs: x.refs.map((r) => toStoredRef(r, args.thisId, args.otherId)) })),
        checked: f.checked,
        couldNotCheck: f.couldNotCheck,
        aiSuggestionId: suggestionId,
        error: null,
        leaseUntil: null,
        updatedAt: new Date(),
        ...metrics,
      },
    });
    logger.info('exception_agent.completed', {
      flagKind: FLAG_KIND, verdict: f.verdict, confidence: f.confidence, adjustments: f.adjustments.length, ...metrics,
    });
  } catch (error) {
    logger.warn('exception_agent.run_failed', { briefId: args.briefId, ...(error instanceof Error ? { message: error.message } : {}) });
    await fail(error instanceof Error ? error.message : 'the investigation failed').catch(() => {});
  }
}

/**
 * The brief for a bill's duplicate flag, starting an investigation if there is
 * no current one. `duplicates` is what the caller already computed, so this
 * never repeats the duplicate query.
 *
 * Returns null — and the screen behaves exactly as before the agent existed —
 * when there is no blocking duplicate, the bill was already cleared, there is
 * no model configured, or a recent run failed.
 */
export async function duplicateBriefFor(args: {
  organizationId: string;
  bill: PairBill;
  duplicates: DuplicateMatch[];
}): Promise<DuplicateBriefView | null> {
  const match = args.duplicates[0];
  if (!match || readDuplicateOverride(args.bill.metadataJson)) return null;
  const other = await prisma.paymentOrder.findFirst({
    where: { organizationId: args.organizationId, paymentOrderId: match.paymentOrderId },
    select: PAIR_BILL_SELECT,
  });
  if (!other) return null;

  const key = pairKey(args.bill.paymentOrderId, other.paymentOrderId);
  const fingerprint = pairFingerprint(sideFrom(args.bill), sideFrom(other));
  const brief = await prisma.billExceptionBrief.findUnique({ where: { pairKey_flagKind: { pairKey: key, flagKind: FLAG_KIND } } });
  const current = brief?.fingerprint === fingerprint;
  const base = { viewer: args.bill, other };

  if (brief && current && brief.status === 'ready') return view(brief, { ...base, briefId: brief.briefId, status: 'ready' });
  if (brief?.status === 'running' && brief.leaseUntil && brief.leaseUntil > new Date()) {
    return view(brief, { ...base, briefId: brief.briefId, status: 'running' });
  }
  if (brief && current && brief.status === 'failed' && Date.now() - brief.updatedAt.getTime() < FAILED_RETRY_MS) return null;
  // Investigate only a draft: once a bill is submitted its review is over, and
  // a brief about a pair nobody can act on here is spend with no reader.
  if (!isExceptionAgentConfigured() || args.bill.state !== 'draft') return null;

  const [firstId, secondId] = [args.bill.paymentOrderId, other.paymentOrderId].sort() as [string, string];
  const briefId = await claimRun({ organizationId: args.organizationId, key, firstId, secondId, fingerprint });
  if (briefId) {
    trackBackgroundWork(runInvestigation({
      briefId, organizationId: args.organizationId, key, fingerprint,
      thisId: args.bill.paymentOrderId, otherId: other.paymentOrderId, match,
    }));
  }
  // Won or lost, a run is underway (or has just finished, in which case the
  // next read shows it).
  return view(null, { ...base, briefId: briefId ?? brief?.briefId ?? '', status: 'running' });
}

/**
 * The post-intake trigger: investigate a new bill's duplicate before anyone
 * opens it. Does its own duplicate lookup because intake has not computed one.
 * Never throws — an investigation must not be the reason intake fails.
 */
export async function startDuplicateBriefForBill(organizationId: string, paymentOrderId: string): Promise<void> {
  try {
    if (!isExceptionAgentConfigured()) return;
    const bill = await prisma.paymentOrder.findFirst({
      where: { organizationId, paymentOrderId },
      select: { ...PAIR_BILL_SELECT, counterpartyWalletId: true },
    });
    if (!bill || bill.state !== 'draft') return;
    const duplicates = await findDuplicateBills(organizationId, {
      excludePaymentOrderId: bill.paymentOrderId,
      counterpartyId: bill.counterpartyId,
      counterpartyWalletId: bill.counterpartyWalletId,
      invoiceNumber: bill.invoiceNumber,
      amountRaw: bill.amountRaw,
      createdAt: bill.createdAt,
    });
    await duplicateBriefFor({ organizationId, bill, duplicates });
  } catch (error) {
    logger.warn('exception_agent.intake_trigger_failed', { paymentOrderId, ...(error instanceof Error ? { message: error.message } : {}) });
  }
}

/**
 * What the person did about a recommendation, logged against it.
 *
 * Called from the three ways a duplicate flag is answered: cleared, closed, or
 * asked about. Compared with what the brief recommended for THIS bill's side of
 * the pair: the same action is accepted (edited, if the reason was reworded),
 * any other is rejected. That is the agreement rate, per flag kind, from the
 * first day — the number that says whether the agent is worth trusting.
 *
 * Best-effort and silent: instrumentation must never be why a bill cannot be
 * resolved. No ready brief means nothing was recommended, so nothing is logged.
 */
export async function recordBriefOutcome(args: {
  organizationId: string;
  paymentOrderId: string;
  action: RecommendedAction;
  reason: string | null;
  actorUserId: string;
}): Promise<void> {
  try {
    const brief = await prisma.billExceptionBrief.findFirst({
      where: {
        organizationId: args.organizationId,
        flagKind: FLAG_KIND,
        status: 'ready',
        aiSuggestionId: { not: null },
        OR: [{ firstPaymentOrderId: args.paymentOrderId }, { secondPaymentOrderId: args.paymentOrderId }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!brief?.verdict || !brief.aiSuggestionId) return;
    const otherId = brief.firstPaymentOrderId === args.paymentOrderId ? brief.secondPaymentOrderId : brief.firstPaymentOrderId;
    const bills = await prisma.paymentOrder.findMany({
      where: { organizationId: args.organizationId, paymentOrderId: { in: [args.paymentOrderId, otherId] } },
      select: { paymentOrderId: true, createdAt: true },
    });
    const self = bills.find((b) => b.paymentOrderId === args.paymentOrderId);
    const other = bills.find((b) => b.paymentOrderId === otherId);
    if (!self || !other) return;
    const recommended = recommendationFor(brief.verdict as Verdict, sideOf(
      { id: self.paymentOrderId, createdAt: self.createdAt },
      { id: other.paymentOrderId, createdAt: other.createdAt },
    ));
    // A question is not a reworded reason, so asking when asking was advised
    // counts as agreement whatever it says.
    const sameReason = args.action === 'ask_someone' || (args.reason ?? '').trim() === (brief.reason ?? '').trim();
    const outcome = args.action !== recommended ? 'rejected' : sameReason ? 'accepted' : 'edited';
    await logSuggestionOutcome({
      aiSuggestionId: brief.aiSuggestionId,
      outcome,
      finalValue: { billId: args.paymentOrderId, action: args.action, recommended, reason: args.reason },
      decidedByUserId: args.actorUserId,
    });
  } catch (error) {
    logger.warn('exception_agent.outcome_failed', { paymentOrderId: args.paymentOrderId, ...(error instanceof Error ? { message: error.message } : {}) });
  }
}

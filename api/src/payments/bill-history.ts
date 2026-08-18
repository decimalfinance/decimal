/**
 * The whole life of a bill, not just the part with approvers in it.
 *
 * The bill screen showed the compiled approval plan and nothing else, so a
 * settled bill read as though one person had touched it. On JOS-1147 that
 * meant Ines, who approved — while Zara, who brought the invoice in, and Omar,
 * the clerk who checked the figures and put it into approval four hours later,
 * appeared nowhere. Those two did most of the work on it.
 *
 * The approval plan cannot answer for them: the engine's story starts at
 * submission. Preparation lives in payment_order_events, and payment lives
 * past the invoice approvable in its own release run. This assembles the ends
 * so the screen can tell one continuous story — prepared, approved, paid.
 *
 * Entries are data, never sentences. What each one is called belongs to the
 * screen, which is where the reader is.
 */
import { prisma } from '../infra/prisma.js';

export type BillHistoryKind =
  | 'uploaded'
  | 'forwarded'
  | 'submitted'
  | 'release_pending'
  | 'released'
  | 'paid';

export interface BillHistoryEntry {
  kind: BillHistoryKind;
  /** Null while it has not happened yet — a pending step still has a person. */
  at: string | null;
  person: { name: string; avatarUrl: string | null } | null;
}

export interface BillHistory {
  /** Before the engine knew about it: brought in, checked, submitted. */
  before: BillHistoryEntry[];
  /** After approval: the release ceremony and the money. */
  after: BillHistoryEntry[];
}

const EMPTY: BillHistory = { before: [], after: [] };

export async function billHistory(input: {
  organizationId: string;
  paymentOrderId: string;
  /** The invoice approvable, when there is one — its release run hangs off it. */
  approvableId: string | null;
  /** Emailed bills say "forwarded", uploads say "uploaded". */
  source: 'email' | 'upload';
}): Promise<BillHistory> {
  const orderEvents = await prisma.$queryRaw<Array<{
    event_type: string;
    after_state: string | null;
    created_at: Date;
    display_name: string | null;
    avatar_url: string | null;
  }>>`
    SELECT e.event_type, e.after_state, e.created_at, u.display_name, u.avatar_url
    FROM payment_order_events e
    LEFT JOIN users u ON u.user_id::text = e.actor_id AND e.actor_type = 'user'
    WHERE e.payment_order_id = ${input.paymentOrderId}::uuid
    ORDER BY e.created_at`;

  const person = (row: { display_name: string | null; avatar_url: string | null }) =>
    row.display_name ? { name: row.display_name, avatarUrl: row.avatar_url } : null;

  const before: BillHistoryEntry[] = [];
  const after: BillHistoryEntry[] = [];

  for (const e of orderEvents) {
    if (e.event_type === 'payment_order_created') {
      before.push({
        kind: input.source === 'email' ? 'forwarded' : 'uploaded',
        at: e.created_at.toISOString(),
        person: person(e),
      });
    } else if (e.event_type === 'payment_order_submitted') {
      // The missing one. Whoever confirmed the figures is the person who put
      // this bill in front of the approvers, and until now the screen never
      // said their name.
      before.push({ kind: 'submitted', at: e.created_at.toISOString(), person: person(e) });
    } else if (e.after_state === 'executed' || e.after_state === 'settled') {
      after.push({ kind: 'paid', at: e.created_at.toISOString(), person: person(e) });
    }
  }

  if (!input.approvableId) return { before, after };

  // The release run: a separate approvable, so none of it reaches the invoice's
  // own plan. Who is holding it, or who let it go.
  const release = await prisma.$queryRaw<Array<{
    macro_state: string;
    task_state: string | null;
    name: string | null;
    avatar_url: string | null;
    acted_at: Date | null;
  }>>`
    SELECT a.macro_state,
           t.state AS task_state,
           p.name,
           u.avatar_url,
           (SELECT max(ev.at) FROM approval.approval_events ev
             WHERE ev.task_id = t.id
               AND ev.payload->>'kind' = 'command'
               AND ev.payload->'command'->>'kind' = 'approve') AS acted_at
    FROM approval.approvables a
    LEFT JOIN approval.approval_plans pl
      ON pl.approvable_id = a.id AND pl.superseded_by IS NULL
    LEFT JOIN approval.tasks t ON t.plan_id = pl.id
    LEFT JOIN approval.people p ON p.id = t.person_id
    LEFT JOIN users u ON u.user_id = p.user_id
    WHERE a.organization_id = ${input.organizationId}::uuid
      AND a.type = 'payment_run'
      AND a.attributes->>'sourceApprovableId' = ${input.approvableId}
      AND (t.state IS NULL OR t.state NOT IN ('obsolete', 'vetoed', 'delegated'))`;

  for (const r of release) {
    if (!r.name) continue;
    const who = { name: r.name, avatarUrl: r.avatar_url };
    if (r.task_state === 'approved') {
      after.unshift({ kind: 'released', at: r.acted_at ? r.acted_at.toISOString() : null, person: who });
    } else if (r.task_state === 'open' || r.task_state === 'info_requested') {
      after.unshift({ kind: 'release_pending', at: null, person: who });
    }
  }

  return { before, after };
}

export const EMPTY_BILL_HISTORY = EMPTY;

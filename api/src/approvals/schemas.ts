// Zod schemas mirroring domain.ts for everything stored as jsonb (policy bodies,
// selector rules, plan steps, command/event payloads). Validation happens at the
// write boundary so nothing malformed ever reaches the log.
import { z } from 'zod';

export const moneySchema = z.object({
  minorUnits: z.string().regex(/^\d+$/), // bigint as string in jsonb — never floats
  currency: z.string().length(3),
});

export const predicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('amount_gte'), value: moneySchema }),
    z.object({ op: z.literal('amount_lt'), value: moneySchema }),
    z.object({ op: z.literal('dimension_in_subtree'), dimension: z.string(), node: z.string().uuid() }),
    z.object({ op: z.literal('attr_eq'), key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ op: z.literal('vendor_in'), vendorIds: z.array(z.string().uuid()).min(1).max(30) }),
    z.object({ op: z.literal('category_in'), categories: z.array(z.string().min(1)).min(1).max(30) }),
    z.object({ op: z.literal('vendor_is_first_invoice') }),
    z.object({ op: z.literal('po_matched_within_tolerance') }),
    z.object({ op: z.literal('and'), all: z.array(predicateSchema) }),
    z.object({ op: z.literal('or'), any: z.array(predicateSchema) }),
    z.object({ op: z.literal('not'), p: predicateSchema }),
  ]),
);

export const approverTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('seat'), seatId: z.string().uuid() }),
  z.object({ kind: z.literal('walk'), hierarchy: z.string().uuid(), authority: z.string() }),
  z.object({ kind: z.literal('holders'), authority: z.string(), scope: z.string().uuid() }),
  z.object({ kind: z.literal('person'), personId: z.string().uuid() }),
  // v1 deviation (recorded in HANDOFF): of the design's `relative` refs only
  // dimension_owner is implemented; requester_manager needs org-chart membership mapping.
  z.object({ kind: z.literal('relative'), ref: z.string().regex(/^dimension_owner:.+$/) }),
]);

export const stepModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('any') }),
  z.object({ mode: z.literal('quorum'), m: z.number().int().min(1) }),
]);

export type PolicyNodeInput = z.infer<typeof policyNodeSchema>;
export const policyNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('condition'),
      if: predicateSchema,
      // Builder display metadata (e.g. vendor names) — carried, never evaluated.
      meta: z.record(z.unknown()).optional(),
      then: z.array(policyNodeSchema),
      else: z.array(policyNodeSchema).optional(),
    }),
    z.object({
      type: z.literal('step'),
      targets: z.array(approverTargetSchema).min(1),
      step: stepModeSchema,
      onUnresolvable: approverTargetSchema,
      slaHours: z.number().int().positive().optional(),
      purpose: z.string().optional(),
    }),
    z.object({ type: z.literal('terminal'), outcome: z.enum(['auto_approve', 'force_reject']), reason: z.string() }),
    // Builder-only path terminator ("this path ends here, forward onward").
    // Compiles to NOTHING — steps above it stand; it exists so the published
    // body round-trips the builder's explicit forwards. NOT 'terminal': that
    // discards all resolved steps and decides the whole approvable.
    z.object({ type: z.literal('marker'), kind: z.literal('forward') }),
    z.object({ type: z.literal('notify'), targets: z.array(approverTargetSchema) }),
  ]),
);

export const policyBodySchema = z.array(policyNodeSchema);

export const selectorRuleSchema = z.object({
  when: predicateSchema,
  usePolicy: z.string().uuid(),
  usePolicyVersion: z.number().int().min(1),
});
export const selectorRulesSchema = z.array(selectorRuleSchema);

export const approverCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('reject'), reason: z.string().min(1) }), // reason mandatory — by schema
  z.object({ kind: z.literal('request_info'), question: z.string().min(1), from: z.string().uuid() }),
  z.object({ kind: z.literal('provide_info'), answer: z.string().min(1) }),
  z.object({ kind: z.literal('delegate'), to: z.string().uuid() }),
  z.object({ kind: z.literal('push_back') }),
  z.object({ kind: z.literal('add_approver'), target: approverTargetSchema }),
  z.object({ kind: z.literal('hold') }),
  z.object({ kind: z.literal('resume') }),
  z.object({ kind: z.literal('recall') }),
  z.object({ kind: z.literal('resubmit') }),
]);
export type ApproverCommandInput = z.infer<typeof approverCommandSchema>;

// ---------------------------------------------------------------------------

export type PlannedApprover = { seatId: string | null; personId: string; viaDelegation: boolean };
export type PlannedStep = {
  index: number;
  step: z.infer<typeof stepModeSchema>;
  approvers: PlannedApprover[];
  purpose: string | null;
  slaHours: number | null;
};

export const engineErrorCodes = [
  'step_already_closed',
  'forbidden_role',
  'stale_version',
  'missing_reason',
  'sod_violation',
  'unresolvable_target',
  'unknown_task',
  'invalid_state',
] as const;
export type EngineErrorCode = (typeof engineErrorCodes)[number];

export class ApprovalEngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message?: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'ApprovalEngineError';
  }
}

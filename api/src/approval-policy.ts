import type { ApprovalPolicy, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';

const approvalPolicyRuleSchema = z.object({
  requireTrustedDestination: z.boolean().default(true),
  requireApprovalForExternal: z.boolean().default(false),
  requireApprovalForInternal: z.boolean().default(false),
  externalApprovalThresholdRaw: z.string().regex(/^\d+$/).default('50000000'),
  internalApprovalThresholdRaw: z.string().regex(/^\d+$/).default('250000000'),
});

export type ApprovalPolicyRule = z.infer<typeof approvalPolicyRuleSchema>;

export type ApprovalReason = {
  code: string;
  message: string;
};

export const DEFAULT_APPROVAL_POLICY_NAME = 'Default workspace policy';

export const DEFAULT_APPROVAL_POLICY_RULE: ApprovalPolicyRule = approvalPolicyRuleSchema.parse({});

type PolicyClient = Prisma.TransactionClient | typeof prisma;

export function normalizeApprovalPolicyRule(ruleJson: unknown): ApprovalPolicyRule {
  return approvalPolicyRuleSchema.parse(ruleJson ?? {});
}

export function serializeApprovalPolicy(policy: ApprovalPolicy) {
  return {
    approvalPolicyId: policy.approvalPolicyId,
    workspaceId: policy.workspaceId,
    policyName: policy.policyName,
    isActive: policy.isActive,
    ruleJson: normalizeApprovalPolicyRule(policy.ruleJson),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

export async function getOrCreateWorkspaceApprovalPolicy(workspaceId: string, client: PolicyClient = prisma) {
  const policy = await client.approvalPolicy.upsert({
    where: { workspaceId },
    update: {},
    create: {
      workspaceId,
      policyName: DEFAULT_APPROVAL_POLICY_NAME,
      isActive: true,
      ruleJson: DEFAULT_APPROVAL_POLICY_RULE as Prisma.InputJsonValue,
    },
  });

  const normalizedRule = normalizeApprovalPolicyRule(policy.ruleJson);
  if (JSON.stringify(policy.ruleJson) === JSON.stringify(normalizedRule)) {
    return policy;
  }

  return client.approvalPolicy.update({
    where: { approvalPolicyId: policy.approvalPolicyId },
    data: {
      ruleJson: normalizedRule as Prisma.InputJsonValue,
    },
  });
}

export function evaluateApprovalPolicy(args: {
  policy: ApprovalPolicy | { isActive: boolean; ruleJson: unknown };
  amountRaw: bigint | string;
  destination: {
    label: string;
    trustState: string;
    isInternal: boolean;
  } | null;
}) {
  const rules = normalizeApprovalPolicyRule(args.policy.ruleJson);
  const amountRaw = typeof args.amountRaw === 'bigint' ? args.amountRaw : BigInt(args.amountRaw);
  const destination = args.destination;
  const trustState = destination?.trustState ?? 'unreviewed';
  const isInternal = destination?.isInternal ?? false;
  const threshold = BigInt(isInternal ? rules.internalApprovalThresholdRaw : rules.externalApprovalThresholdRaw);
  const reasons: ApprovalReason[] = [];

  if (!args.policy.isActive) {
    return {
      requiresApproval: false,
      reasons,
      rules,
    };
  }

  if (rules.requireTrustedDestination && trustState !== 'trusted') {
    reasons.push({
      code: 'destination_not_trusted',
      message: `Destination "${destination?.label ?? 'unnamed destination'}" is ${trustState} and cannot skip approval`,
    });
  }

  if (!isInternal && rules.requireApprovalForExternal) {
    reasons.push({
      code: 'external_transfer_requires_approval',
      message: 'External destinations require approval under the active workspace policy',
    });
  }

  if (isInternal && rules.requireApprovalForInternal) {
    reasons.push({
      code: 'internal_transfer_requires_approval',
      message: 'Internal destinations require approval under the active workspace policy',
    });
  }

  if (threshold > 0n && amountRaw >= threshold) {
    reasons.push({
      code: isInternal ? 'internal_amount_threshold_exceeded' : 'external_amount_threshold_exceeded',
      message: `${isInternal ? 'Internal' : 'External'} transfer amount ${amountRaw.toString()} meets or exceeds policy threshold ${threshold.toString()}`,
    });
  }

  return {
    requiresApproval: reasons.length > 0,
    reasons,
    rules,
  };
}

export function buildApprovalEvaluationSummary(args: {
  policy: ApprovalPolicy | { isActive: boolean; ruleJson: unknown; approvalPolicyId?: string | null; policyName?: string };
  amountRaw: bigint | string;
  destination: {
    label: string;
    trustState: string;
    isInternal: boolean;
  } | null;
}) {
  const evaluation = evaluateApprovalPolicy(args);
  return {
    approvalPolicyId: 'approvalPolicyId' in args.policy ? (args.policy.approvalPolicyId ?? null) : null,
    policyName: 'policyName' in args.policy ? (args.policy.policyName ?? DEFAULT_APPROVAL_POLICY_NAME) : DEFAULT_APPROVAL_POLICY_NAME,
    isActive: args.policy.isActive,
    requiresApproval: evaluation.requiresApproval,
    rules: evaluation.rules,
    reasons: evaluation.reasons,
  };
}

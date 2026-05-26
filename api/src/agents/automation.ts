import type { Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { badRequest, notFound } from '../infra/api-errors.js';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { SOLANA_CHAIN } from '../solana.js';
import { fundNewDevnetWalletIfConfigured } from '../wallets/devnet-funding.js';
import { createPrivySolanaWallet } from '../wallets/personal.js';

const automationAgentInclude = {
  wallets: {
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.AutomationAgentInclude;

const agentWalletInclude = {
  automationAgent: {
    select: {
      automationAgentId: true,
      name: true,
      agentType: true,
      status: true,
    },
  },
} satisfies Prisma.AgentWalletInclude;

type AutomationAgentWithRelations = Prisma.AutomationAgentGetPayload<{ include: typeof automationAgentInclude }>;
type AgentWalletWithRelations = Prisma.AgentWalletGetPayload<{ include: typeof agentWalletInclude }>;

export async function createAutomationAgent(organizationId: string, input: {
  name: string;
  agentType?: string;
  metadataJson?: Prisma.InputJsonValue;
}) {
  const name = normalizeRequiredText(input.name, 'name');
  const agent = await prisma.automationAgent.create({
    data: {
      organizationId,
      name,
      agentType: input.agentType?.trim() || 'automation',
      metadataJson: input.metadataJson ?? {},
    },
    include: automationAgentInclude,
  });
  return serializeAutomationAgent(agent);
}

export async function ensureDefaultAutomationAgentWithWallet(
  organizationId: string,
  input: {
    force?: boolean;
    failOnError?: boolean;
  } = {},
) {
  if (!input.force && !config.autoProvisionWallets) {
    return {
      status: 'skipped',
      reason: 'auto_provisioning_disabled',
      agent: null,
      wallet: null,
    };
  }

  if (!config.privyAppId || !config.privyAppSecret) {
    if (input.failOnError) {
      throw badRequest('Privy wallet provisioning is not configured.');
    }
    return {
      status: 'skipped',
      reason: 'privy_not_configured',
      agent: null,
      wallet: null,
    };
  }

  try {
    const agent = await prisma.automationAgent.upsert({
      where: {
        organizationId_name: {
          organizationId,
          name: 'Decimal operations agent',
        },
      },
      update: {
        status: 'active',
        agentType: 'decimal_operations',
      },
      create: {
        organizationId,
        name: 'Decimal operations agent',
        agentType: 'decimal_operations',
        metadataJson: {
          systemManaged: true,
          createdBy: 'organization_onboarding',
        },
      },
      include: automationAgentInclude,
    });
    const existingWallet = agent.wallets.find((wallet) =>
      wallet.status === 'active'
      && wallet.provider === 'privy'
      && wallet.providerWalletId,
    );
    if (existingWallet) {
      return {
        status: 'existing',
        reason: null,
        agent: serializeAutomationAgent(agent),
        wallet: serializeAgentWallet({
          ...existingWallet,
          automationAgent: {
            automationAgentId: agent.automationAgentId,
            name: agent.name,
            agentType: agent.agentType,
            status: agent.status,
          },
        }),
      };
    }

    const wallet = await createManagedAgentWallet(organizationId, agent.automationAgentId, {
      label: 'Decimal operations agent wallet',
      provider: 'privy',
    });
    const refreshedAgent = await prisma.automationAgent.findUniqueOrThrow({
      where: { automationAgentId: agent.automationAgentId },
      include: automationAgentInclude,
    });

    return {
      status: 'created',
      reason: null,
      agent: serializeAutomationAgent(refreshedAgent),
      wallet,
    };
  } catch (error) {
    if (input.failOnError) {
      throw error;
    }
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Agent wallet provisioning failed',
      agent: null,
      wallet: null,
    };
  }
}

export async function listAutomationAgents(organizationId: string, input: { status?: string; limit?: number } = {}) {
  const agents = await prisma.automationAgent.findMany({
    where: {
      organizationId,
      ...(input.status ? { status: input.status } : {}),
    },
    include: automationAgentInclude,
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 100,
  });
  return { items: agents.map(serializeAutomationAgent) };
}

export async function createManagedAgentWallet(organizationId: string, automationAgentId: string, input: {
  label?: string | null;
  provider?: 'privy';
}) {
  const agent = await prisma.automationAgent.findFirst({
    where: {
      organizationId,
      automationAgentId,
      status: 'active',
    },
  });
  if (!agent) {
    throw notFound('Automation agent not found');
  }

  const existingWallet = await prisma.agentWallet.findFirst({
    where: {
      organizationId,
      automationAgentId,
      provider: 'privy',
      status: 'active',
    },
    include: agentWalletInclude,
    orderBy: { createdAt: 'asc' },
  });
  if (existingWallet) {
    return serializeAgentWallet(existingWallet);
  }

  const label = input.label?.trim() || `${agent.name} wallet`;
  const wallet = await createPrivySolanaWallet({
    ownerType: 'agent',
    ownerId: automationAgentId,
    label,
    idempotencyKey: `agent-wallet-${automationAgentId}`,
  });
  const walletAddress = normalizeSolanaAddress(wallet.address);
  const row = await prisma.agentWallet.upsert({
    where: {
      organizationId_chain_walletAddress: {
        organizationId,
        chain: SOLANA_CHAIN,
        walletAddress,
      },
    },
    create: {
      organizationId,
      automationAgentId,
      chain: SOLANA_CHAIN,
      walletAddress,
      walletType: 'privy_embedded',
      provider: input.provider ?? 'privy',
      providerWalletId: wallet.providerWalletId,
      label,
      status: 'active',
      verifiedAt: new Date(),
      metadataJson: wallet.metadata,
    },
    update: {
      automationAgentId,
      provider: input.provider ?? 'privy',
      providerWalletId: wallet.providerWalletId,
      label,
      status: 'active',
      verifiedAt: new Date(),
      metadataJson: wallet.metadata,
    },
    include: agentWalletInclude,
  });
  const funding = await fundNewDevnetWalletIfConfigured(row.walletAddress)
    .catch((error) => {
      const reason = error instanceof Error ? error.message : 'devnet_funding_failed';
      logger.warn('devnet_funding.agent_wallet_failed', {
        organizationId,
        automationAgentId,
        agentWalletId: row.agentWalletId,
        walletAddress: row.walletAddress,
        reason,
      });
      return { status: 'skipped' as const, reason };
    });
  if (funding.status !== 'skipped') {
    const updated = await prisma.agentWallet.update({
      where: { agentWalletId: row.agentWalletId },
      data: {
        metadataJson: {
          ...(isRecordLike(row.metadataJson) ? row.metadataJson : {}),
          devnetFunding: funding,
        },
      },
      include: agentWalletInclude,
    });
    return serializeAgentWallet(updated);
  }
  return serializeAgentWallet(row);
}

export async function listAgentWallets(organizationId: string, input: {
  automationAgentId?: string;
  status?: string;
  limit?: number;
} = {}) {
  const wallets = await prisma.agentWallet.findMany({
    where: {
      organizationId,
      ...(input.automationAgentId ? { automationAgentId: input.automationAgentId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    include: agentWalletInclude,
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 100,
  });
  return { items: wallets.map(serializeAgentWallet) };
}

function serializeAutomationAgent(agent: AutomationAgentWithRelations) {
  return {
    automationAgentId: agent.automationAgentId,
    organizationId: agent.organizationId,
    name: agent.name,
    agentType: agent.agentType,
    status: agent.status,
    metadataJson: agent.metadataJson,
    wallets: agent.wallets.map((wallet) => ({
      agentWalletId: wallet.agentWalletId,
      walletAddress: wallet.walletAddress,
      walletType: wallet.walletType,
      provider: wallet.provider,
      label: wallet.label,
      status: wallet.status,
      verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
      lastUsedAt: wallet.lastUsedAt?.toISOString() ?? null,
      metadataJson: wallet.metadataJson,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    })),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function serializeAgentWallet(wallet: AgentWalletWithRelations) {
  return {
    agentWalletId: wallet.agentWalletId,
    organizationId: wallet.organizationId,
    automationAgentId: wallet.automationAgentId,
    chain: wallet.chain,
    walletAddress: wallet.walletAddress,
    walletType: wallet.walletType,
    provider: wallet.provider,
    providerWalletId: wallet.providerWalletId,
    label: wallet.label,
    status: wallet.status,
    verifiedAt: wallet.verifiedAt?.toISOString() ?? null,
    lastUsedAt: wallet.lastUsedAt?.toISOString() ?? null,
    metadataJson: wallet.metadataJson,
    automationAgent: wallet.automationAgent,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function normalizeSolanaAddress(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw badRequest('Invalid Solana wallet address.');
  }
}

function normalizeRequiredText(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw badRequest(`${fieldName} is required.`);
  }
  return normalized;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

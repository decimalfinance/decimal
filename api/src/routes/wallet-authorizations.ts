import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, notFound } from '../infra/api-errors.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { prisma } from '../infra/prisma.js';
import { asyncRoute, sendCreated, sendJson, sendList } from '../infra/route-helpers.js';

export const walletAuthorizationsRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const authorizationParamsSchema = organizationParamsSchema.extend({
  walletAuthorizationId: z.string().uuid(),
});

const listAuthorizationsQuerySchema = z.object({
  treasuryWalletId: z.string().uuid().optional(),
  userWalletId: z.string().uuid().optional(),
  status: z.enum(['active', 'revoked']).optional(),
});

const createAuthorizationSchema = z.object({
  userWalletId: z.string().uuid(),
  treasuryWalletId: z.string().uuid().nullable().optional(),
  membershipId: z.string().uuid().optional(),
  role: z.enum(['owner', 'admin', 'signer', 'approver']).default('signer'),
  scope: z.enum(['organization', 'treasury_wallet']).optional(),
  metadataJson: z.record(z.any()).default({}),
});

walletAuthorizationsRouter.get(
  '/organizations/:organizationId/wallet-authorizations',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const query = listAuthorizationsQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);

    const items = await prisma.organizationWalletAuthorization.findMany({
      where: {
        organizationId,
        status: query.status,
        treasuryWalletId: query.treasuryWalletId,
        userWalletId: query.userWalletId,
      },
      include: walletAuthorizationInclude,
      orderBy: { createdAt: 'desc' },
      take: 250,
    });

    sendList(res, items.map(serializeWalletAuthorization), {
      treasuryWalletId: query.treasuryWalletId ?? null,
      userWalletId: query.userWalletId ?? null,
      status: query.status ?? null,
    });
  }),
);

walletAuthorizationsRouter.post(
  '/organizations/:organizationId/wallet-authorizations',
  asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createAuthorizationSchema.parse(req.body);
    const authorization = await createWalletAuthorization({
      organizationId,
      ...input,
      treasuryWalletId: input.treasuryWalletId ?? null,
      scope: input.scope ?? (input.treasuryWalletId ? 'treasury_wallet' : 'organization'),
    });

    sendCreated(res, serializeWalletAuthorization(authorization));
  }),
);

walletAuthorizationsRouter.post(
  '/organizations/:organizationId/wallet-authorizations/:walletAuthorizationId/revoke',
  asyncRoute(async (req, res) => {
    const { organizationId, walletAuthorizationId } = authorizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const existing = await prisma.organizationWalletAuthorization.findFirst({
      where: { organizationId, walletAuthorizationId },
      select: { walletAuthorizationId: true },
    });
    if (!existing) {
      throw notFound('Wallet authorization not found');
    }

    const authorization = await prisma.organizationWalletAuthorization.update({
      where: { walletAuthorizationId },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
      },
      include: walletAuthorizationInclude,
    });

    sendJson(res, serializeWalletAuthorization(authorization));
  }),
);

async function createWalletAuthorization(input: {
  organizationId: string;
  userWalletId: string;
  treasuryWalletId: string | null;
  membershipId?: string;
  role: string;
  scope: string;
  metadataJson: Record<string, unknown>;
}) {
  if (input.scope === 'treasury_wallet' && !input.treasuryWalletId) {
    throw badRequest('treasuryWalletId is required for treasury wallet authorizations.');
  }
  if (input.scope === 'organization' && input.treasuryWalletId) {
    throw badRequest('organization-scoped authorizations cannot target a treasury wallet.');
  }

  const personalWallet = await prisma.personalWallet.findFirst({
    where: {
      userWalletId: input.userWalletId,
      status: 'active',
    },
  });
  if (!personalWallet) {
    throw notFound('Personal wallet not found');
  }

  const membership = input.membershipId
    ? await prisma.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        status: 'active',
      },
    })
    : await prisma.organizationMembership.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: personalWallet.userId,
        status: 'active',
      },
    });

  if (!membership) {
    throw badRequest('Personal wallet owner is not an active member of this organization.');
  }
  if (membership.userId !== personalWallet.userId) {
    throw badRequest('membershipId must belong to the personal wallet owner.');
  }

  if (input.treasuryWalletId) {
    const treasuryWallet = await prisma.treasuryWallet.findFirst({
      where: {
        organizationId: input.organizationId,
        treasuryWalletId: input.treasuryWalletId,
        isActive: true,
      },
      select: { treasuryWalletId: true },
    });
    if (!treasuryWallet) {
      throw notFound('Treasury wallet not found');
    }
  }

  const existing = await prisma.organizationWalletAuthorization.findFirst({
    where: {
      organizationId: input.organizationId,
      treasuryWalletId: input.treasuryWalletId,
      userWalletId: input.userWalletId,
      role: input.role,
    },
  });

  if (existing) {
    return prisma.organizationWalletAuthorization.update({
      where: { walletAuthorizationId: existing.walletAuthorizationId },
      data: {
        membershipId: membership.membershipId,
        scope: input.scope,
        status: 'active',
        revokedAt: null,
        metadataJson: input.metadataJson as Prisma.InputJsonObject,
      },
      include: walletAuthorizationInclude,
    });
  }

  return prisma.organizationWalletAuthorization.create({
    data: {
      organizationId: input.organizationId,
      treasuryWalletId: input.treasuryWalletId,
      userWalletId: input.userWalletId,
      membershipId: membership.membershipId,
      role: input.role,
      scope: input.scope,
      metadataJson: input.metadataJson as Prisma.InputJsonObject,
    },
    include: walletAuthorizationInclude,
  });
}

const walletAuthorizationInclude = {
  personalWallet: {
    select: {
      userWalletId: true,
      userId: true,
      chain: true,
      walletAddress: true,
      walletType: true,
      provider: true,
      providerWalletId: true,
      label: true,
      status: true,
    },
  },
  membership: {
    select: {
      membershipId: true,
      userId: true,
      role: true,
      status: true,
      user: {
        select: {
          userId: true,
          email: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  },
  treasuryWallet: {
    select: {
      treasuryWalletId: true,
      chain: true,
      address: true,
      usdcAtaAddress: true,
      displayName: true,
      isActive: true,
    },
  },
} as const;

function serializeWalletAuthorization(authorization: {
  walletAuthorizationId: string;
  organizationId: string;
  treasuryWalletId: string | null;
  userWalletId: string;
  membershipId: string;
  role: string;
  status: string;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  metadataJson: unknown;
  personalWallet?: unknown;
  membership?: unknown;
  treasuryWallet?: unknown;
}) {
  return {
    walletAuthorizationId: authorization.walletAuthorizationId,
    organizationId: authorization.organizationId,
    treasuryWalletId: authorization.treasuryWalletId,
    userWalletId: authorization.userWalletId,
    membershipId: authorization.membershipId,
    role: authorization.role,
    status: authorization.status,
    scope: authorization.scope,
    createdAt: authorization.createdAt.toISOString(),
    updatedAt: authorization.updatedAt.toISOString(),
    revokedAt: authorization.revokedAt?.toISOString() ?? null,
    metadataJson: authorization.metadataJson,
    personalWallet: authorization.personalWallet,
    membership: authorization.membership,
    treasuryWallet: authorization.treasuryWallet,
  };
}

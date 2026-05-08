import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../infra/api-errors.js';
import { config } from '../config.js';
import { assertOrganizationAdmin } from '../auth/organization-access.js';
import { prisma } from '../infra/prisma.js';
import { asyncRoute, sendCreated, sendJson, sendList } from '../infra/route-helpers.js';

export const publicOrganizationInvitesRouter = Router();
export const organizationInvitesRouter = Router();

const INVITE_TTL_DAYS = 14;
const INVITE_ROLES = ['admin', 'member'] as const;

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const inviteParamsSchema = organizationParamsSchema.extend({
  organizationInviteId: z.string().uuid(),
});

const publicInviteParamsSchema = z.object({
  inviteToken: z.string().trim().min(24).max(256),
});

const listInvitesQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']).optional(),
});

const createInviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(INVITE_ROLES).default('member'),
});

publicOrganizationInvitesRouter.get('/invites/:inviteToken', asyncRoute(async (req, res) => {
  const { inviteToken } = publicInviteParamsSchema.parse(req.params);
  const invite = await findInviteByToken(inviteToken);
  if (!invite) {
    throw notFound('Invite not found');
  }

  sendJson(res, serializePublicInvite(invite));
}));

organizationInvitesRouter.get('/organizations/:organizationId/invites', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  const query = listInvitesQuerySchema.parse(req.query);
  await assertOrganizationAdmin(organizationId, req.auth!);

  const items = await prisma.organizationInvite.findMany({
    where: {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
    },
    include: inviteInclude,
    orderBy: { createdAt: 'desc' },
    take: 250,
  });

  sendList(res, items.map(serializeInvite), { status: query.status ?? null });
}));

organizationInvitesRouter.post('/organizations/:organizationId/invites', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  assertVerifiedEmail(req.auth!.userEmailVerifiedAt);
  const input = createInviteSchema.parse(req.body);
  const invitedEmail = normalizeEmail(input.email);

  const existingUser = await prisma.user.findUnique({
    where: { email: invitedEmail },
    select: {
      userId: true,
      memberships: {
        where: { organizationId, status: 'active' },
        select: { membershipId: true },
        take: 1,
      },
    },
  });
  if (existingUser?.memberships.length) {
    throw conflict('This user is already an active organization member.');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const invite = await prisma.$transaction(async (tx) => {
    await tx.organizationInvite.updateMany({
      where: {
        organizationId,
        invitedEmail,
        status: 'pending',
      },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
      },
    });

    return tx.organizationInvite.create({
      data: {
        organizationId,
        invitedEmail,
        role: input.role,
        inviteTokenHash: tokenHash,
        invitedByUserId: req.auth!.userId,
        expiresAt,
      },
      include: inviteInclude,
    });
  });

  sendCreated(res, {
    ...serializeInvite(invite),
    inviteToken: token,
    inviteLink: buildInviteLink(token, req.headers.origin),
  });
}));

organizationInvitesRouter.post('/organizations/:organizationId/invites/:organizationInviteId/revoke', asyncRoute(async (req, res) => {
  const { organizationId, organizationInviteId } = inviteParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const existing = await prisma.organizationInvite.findFirst({
    where: { organizationId, organizationInviteId },
    include: inviteInclude,
  });
  if (!existing) {
    throw notFound('Invite not found');
  }
  if (existing.status !== 'pending') {
    throw badRequest('Only pending invites can be revoked.');
  }

  const invite = await prisma.organizationInvite.update({
    where: { organizationInviteId },
    data: {
      status: 'revoked',
      revokedAt: new Date(),
    },
    include: inviteInclude,
  });

  sendJson(res, serializeInvite(invite));
}));

organizationInvitesRouter.post('/invites/:inviteToken/accept', asyncRoute(async (req, res) => {
  assertVerifiedEmail(req.auth!.userEmailVerifiedAt);
  const { inviteToken } = publicInviteParamsSchema.parse(req.params);
  const invite = await findInviteByToken(inviteToken);
  if (!invite) {
    throw notFound('Invite not found');
  }
  if (invite.status !== 'pending') {
    throw badRequest(`Invite is ${invite.status}.`);
  }
  if (invite.expiresAt <= new Date()) {
    const expired = await prisma.organizationInvite.update({
      where: { organizationInviteId: invite.organizationInviteId },
      data: { status: 'expired' },
      include: inviteInclude,
    });
    throw badRequest(`Invite is ${expired.status}.`);
  }
  if (normalizeEmail(req.auth!.userEmail) !== invite.invitedEmail) {
    throw forbidden('This invite belongs to a different email address.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const membership = await tx.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: invite.organizationId,
          userId: req.auth!.userId,
        },
      },
      update: {
        role: invite.role,
        status: 'active',
      },
      create: {
        organizationId: invite.organizationId,
        userId: req.auth!.userId,
        role: invite.role,
        status: 'active',
      },
    });

    const accepted = await tx.organizationInvite.update({
      where: { organizationInviteId: invite.organizationInviteId },
      data: {
        status: 'accepted',
        acceptedByUserId: req.auth!.userId,
        acceptedAt: new Date(),
      },
      include: inviteInclude,
    });

    return { membership, invite: accepted };
  });

  sendCreated(res, {
    organizationId: result.invite.organizationId,
    organizationName: result.invite.organization.organizationName,
    membershipId: result.membership.membershipId,
    role: result.membership.role,
    invite: serializeInvite(result.invite),
  });
}));

const inviteInclude = {
  organization: {
    select: {
      organizationId: true,
      organizationName: true,
      status: true,
    },
  },
  invitedByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
      avatarUrl: true,
    },
  },
  acceptedByUser: {
    select: {
      userId: true,
      email: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} as const;

function serializeInvite(invite: {
  organizationInviteId: string;
  organizationId: string;
  invitedEmail: string;
  role: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  organization: { organizationId: string; organizationName: string; status: string };
  invitedByUser: { userId: string; email: string; displayName: string; avatarUrl: string | null };
  acceptedByUser: { userId: string; email: string; displayName: string; avatarUrl: string | null } | null;
}) {
  return {
    organizationInviteId: invite.organizationInviteId,
    organizationId: invite.organizationId,
    invitedEmail: invite.invitedEmail,
    role: invite.role,
    status: deriveInviteStatus(invite),
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
    organization: invite.organization,
    invitedByUser: invite.invitedByUser,
    acceptedByUser: invite.acceptedByUser,
  };
}

function serializePublicInvite(invite: Parameters<typeof serializeInvite>[0]) {
  return {
    organizationInviteId: invite.organizationInviteId,
    invitedEmail: invite.invitedEmail,
    role: invite.role,
    status: deriveInviteStatus(invite),
    expiresAt: invite.expiresAt.toISOString(),
    organization: invite.organization,
    invitedByUser: invite.invitedByUser,
  };
}

async function findInviteByToken(token: string) {
  return prisma.organizationInvite.findUnique({
    where: { inviteTokenHash: hashInviteToken(token) },
    include: inviteInclude,
  });
}

function deriveInviteStatus(invite: { status: string; expiresAt: Date }) {
  if (invite.status === 'pending' && invite.expiresAt <= new Date()) {
    return 'expired';
  }
  return invite.status;
}

function buildInviteLink(token: string, requestOrigin: string | string[] | undefined) {
  const base = pickInviteLinkBase(requestOrigin);
  return `${base.replace(/\/$/, '')}/invites/${token}`;
}

function pickInviteLinkBase(requestOrigin: string | string[] | undefined) {
  const origin = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin;
  if (origin && config.corsOrigins.includes(origin)) {
    return origin;
  }
  return config.publicFrontendUrl ?? config.publicApiUrl ?? 'http://localhost:5174';
}

function hashInviteToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function assertVerifiedEmail(emailVerifiedAt: string | null) {
  if (!emailVerifiedAt) {
    throw forbidden('Email verification is required before creating or accepting organization invites.');
  }
}

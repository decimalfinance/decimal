import { Router } from 'express';
import { z } from 'zod';
import { createSession, requireAuth } from '../auth.js';
import { prisma } from '../prisma.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).optional(),
});

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);

    const user = await prisma.user.upsert({
      where: { email: input.email },
      update: {
        displayName: input.displayName ?? undefined,
      },
      create: {
        email: input.email,
        displayName: input.displayName ?? input.email.split('@')[0],
      },
    });

    const session = await createSession(user.userId);
    const organizations = await listUserOrganizations(user.userId);

    res.json({
      status: 'authenticated',
      sessionToken: session.sessionToken,
      user: serializeUser(user),
      organizations,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/auth/session', requireAuth(), async (req, res, next) => {
  try {
    const auth = req.auth!;
    const organizations = await listUserOrganizations(auth.userId);

    res.json({
      authenticated: true,
      user: {
        userId: auth.userId,
        email: auth.userEmail,
        displayName: auth.userDisplayName,
      },
      organizations,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/auth/logout', requireAuth(), async (req, res, next) => {
  try {
    await prisma.authSession.deleteMany({
      where: { sessionToken: req.auth!.sessionToken },
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

async function listUserOrganizations(userId: string) {
  const memberships = await prisma.organizationMembership.findMany({
    where: {
      userId,
      status: 'active',
    },
    include: {
      organization: {
        include: {
          workspaces: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((membership) => ({
    organizationId: membership.organization.organizationId,
    organizationName: membership.organization.organizationName,
    organizationSlug: membership.organization.organizationSlug,
    role: membership.role,
    status: membership.organization.status,
    workspaces: membership.organization.workspaces,
  }));
}

function serializeUser(user: { userId: string; email: string; displayName: string }) {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
  };
}

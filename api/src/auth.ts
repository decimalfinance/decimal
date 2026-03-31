import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from './prisma.js';

export type AuthContext = {
  sessionToken: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const SESSION_TTL_DAYS = 30;

export async function authenticateRequest(authorizationHeader?: string | null) {
  const token = extractBearerToken(authorizationHeader);

  if (!token) {
    return null;
  }

  const session = await prisma.authSession.findUnique({
    where: { sessionToken: token },
    include: {
      user: true,
    },
  });

  if (!session || session.expiresAt <= new Date()) {
    return null;
  }

  await prisma.authSession.update({
    where: { authSessionId: session.authSessionId },
    data: { lastSeenAt: new Date() },
  });

  return {
    sessionToken: session.sessionToken,
    userId: session.userId,
    userEmail: session.user.email,
    userDisplayName: session.user.displayName,
  } satisfies AuthContext;
}

export async function createSession(userId: string, organizationId?: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  return prisma.authSession.create({
    data: {
      sessionToken,
      userId,
      ...(organizationId ? { organizationId } : {}),
      expiresAt,
    },
  });
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = await authenticateRequest(req.header('authorization'));

      if (!auth) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
        return;
      }

      req.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function extractBearerToken(header?: string | null) {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

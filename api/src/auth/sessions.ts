import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../infra/prisma.js';

export type UserSessionAuthContext = {
  authType: 'user_session';
  sessionToken: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userEmailVerifiedAt: string | null;
  actorType: 'user';
  actorId: string;
};

export type AuthContext = UserSessionAuthContext;

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

  const sessionTokenHash = hashSessionToken(token);
  const session = await prisma.authSession.findFirst({
    where: {
      OR: [
        { sessionToken: sessionTokenHash },
        { sessionToken: token },
      ],
    },
    include: {
      user: true,
    },
  });

  if (session && session.expiresAt > new Date()) {
    await prisma.authSession.update({
      where: { authSessionId: session.authSessionId },
      data: { lastSeenAt: new Date() },
    });

    return {
      authType: 'user_session',
      sessionToken: session.sessionToken,
      userId: session.userId,
      userEmail: session.user.email,
      userDisplayName: session.user.displayName,
      userEmailVerifiedAt: session.user.emailVerifiedAt?.toISOString() ?? null,
      actorType: 'user',
      actorId: session.userId,
    } satisfies AuthContext;
  }

  return null;
}

export async function createSession(userId: string, organizationId?: string) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashSessionToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.authSession.create({
    data: {
      sessionToken: sessionTokenHash,
      userId,
      ...(organizationId ? { organizationId } : {}),
      expiresAt,
    },
  });

  return {
    sessionToken,
    expiresAt,
  };
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = await authenticateRequest(req.header('authorization'));

      if (!auth) {
        res.status(401).json({
          error: 'Unauthorized',
          code: 'unauthorized',
          message: 'Authentication required',
          requestId: req.requestId,
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

function hashSessionToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

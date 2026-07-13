import { Router } from 'express';
import type { Request, Response } from 'express';
import type { JsonWebKey } from 'node:crypto';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ApiError, badRequest, conflict } from '../infra/api-errors.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createSession, requireAuth } from '../auth/sessions.js';
import { isEmailDeliveryConfigured, sendVerificationEmail } from '../auth/email.js';
import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const verifyEmailSchema = z.object({
  code: z.string().trim().min(6).max(12),
});

const googleStartQuerySchema = z.object({
  returnTo: z.string().trim().max(240).optional(),
  frontendOrigin: z.string().trim().url().max(240).optional(),
});

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type OAuthStatePayload = {
  provider: 'google';
  nonce: string;
  returnTo: string;
  frontendOrigin: string | null;
  redirectUri: string;
  expiresAt: number;
};

type GoogleTokenResponse = {
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenInfo = {
  iss?: string;
  sub?: string;
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  error?: string;
  error_description?: string;
};

type GoogleJwksResponse = {
  keys?: GoogleJwk[];
};

type GoogleJwk = JsonWebKey & {
  kid?: string;
};

type CachedGoogleJwks = {
  keys: Map<string, GoogleJwk>;
  expiresAt: number;
};

let googleJwksCache: CachedGoogleJwks | null = null;

authRouter.post('/auth/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const displayName = normalizeOptionalDisplayName(input.displayName) ?? defaultDisplayName(email);

    const existing = await prisma.user.findUnique({
      where: { email },
    });

    let user;
    let plaintextCode: string | null = null;

    if (existing) {
      if (existing.passwordHash) {
        throw conflict('An account with this email already exists.', { field: 'email' });
      }

      user = await prisma.user.update({
        where: { userId: existing.userId },
        data: {
          passwordHash,
          displayName,
        },
      });
    } else {
      plaintextCode = generateVerificationCode();
      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName,
          ...emailVerificationFieldsForCode(plaintextCode),
        },
      });
    }

    const session = await createSession(user.userId);
    const organizations = await listUserOrganizations(user.userId);

    const delivery = await deliverVerificationCode({
      toEmail: user.email,
      displayName: user.displayName,
      code: plaintextCode,
    });

    res.status(201).json({
      status: 'authenticated',
      sessionToken: session.sessionToken,
      user: serializeUser(user),
      organizations,
      emailDelivered: delivery.emailDelivered,
      devEmailVerificationCode: delivery.devEmailVerificationCode,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/auth/google/start', async (req, res, next) => {
  try {
    assertGoogleOAuthConfigured();
    const query = googleStartQuerySchema.parse(req.query);
    const frontendOrigin = normalizeFrontendOrigin(query.frontendOrigin);
    const redirectUri = googleRedirectUri(req);
    const state = signOAuthState({
      provider: 'google',
      nonce: crypto.randomBytes(24).toString('hex'),
      returnTo: normalizeReturnTo(query.returnTo),
      frontendOrigin,
      redirectUri,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    });
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', config.googleOAuthClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

authRouter.get('/auth/google/callback', async (req, res, next) => {
  try {
    assertGoogleOAuthConfigured();
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const rawState = typeof req.query.state === 'string' ? req.query.state : null;
    const oauthError = typeof req.query.error === 'string' ? req.query.error : null;

    if (!rawState) {
      throw badRequest('OAuth state is missing.');
    }
    const state = verifyOAuthState(rawState);
    const frontendBaseUrl = state.frontendOrigin ?? config.publicFrontendUrl;
    if (!frontendBaseUrl) {
      throw new ApiError(501, 'frontend_url_not_configured', 'Frontend redirect URL is not configured.');
    }

    if (oauthError) {
      redirectOAuthResult(res, frontendBaseUrl, state.returnTo, null, oauthError);
      return;
    }
    if (!code) {
      throw badRequest('OAuth code is missing.');
    }

    const profile = await fetchGoogleProfile(code, state.redirectUri);
    const user = await upsertGoogleUser(profile);
    const session = await createSession(user.userId);
    redirectOAuthResult(res, frontendBaseUrl, state.returnTo, session.sessionToken, null);
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
      authType: auth.authType,
      user: {
        userId: auth.userId,
        email: auth.userEmail,
        displayName: auth.userDisplayName,
        emailVerifiedAt: auth.userEmailVerifiedAt,
      },
      organizations,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const email = normalizeEmail(input.email);

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user?.passwordHash) {
      throw invalidCredentialsError();
    }

    const passwordValid = await verifyPassword(input.password, user.passwordHash);

    if (!passwordValid) {
      throw invalidCredentialsError();
    }

    const session = await createSession(user.userId);
    const organizations = await listUserOrganizations(user.userId);

    res.json({
      status: 'authenticated',
      sessionToken: session.sessionToken,
      user: serializeUser(user),
      organizations,
      emailDelivered: false,
      devEmailVerificationCode: null,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Developer sign-in (automated testing) ─────────────────────────────────
// Mints a pre-verified session for a synthetic persona so an agent (or a dev)
// can drive the product end to end — multi-user orgs, invite flows, approval
// chains — without real inboxes. Two hard gates keep this safe even though
// the API is publicly reachable:
//   1. DEV_AUTH_SECRET must be configured AND presented (constant-time check).
//   2. Emails are confined to the reserved @dev.decimal.test domain, so this
//      endpoint can never mint a session for a real person's account.
const DEV_EMAIL_DOMAIN = '@dev.decimal.test';

const devLoginSchema = z.object({
  secret: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(80).optional(),
  // Land in a specific org by name — seeded personas often belong to several
  // near-identically named test orgs, and defaulting to the oldest one is a trap.
  organizationName: z.string().trim().min(1).max(80).optional(),
});

function requireDevSecret(secret: string) {
  if (!config.devAuthSecret) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  const provided = Buffer.from(secret);
  const expected = Buffer.from(config.devAuthSecret);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new ApiError(401, 'invalid_credentials', 'Invalid developer secret.');
  }
}

function requireDevEmail(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  if (!email.endsWith(DEV_EMAIL_DOMAIN)) {
    throw badRequest(`Developer sign-in only accepts ${DEV_EMAIL_DOMAIN} emails.`);
  }
  return email;
}

async function upsertDevUser(rawEmail: string, rawDisplayName?: string) {
  const email = requireDevEmail(rawEmail);
  const providedName = normalizeOptionalDisplayName(rawDisplayName);
  const displayName = providedName ?? defaultDisplayName(email);
  let user = await prisma.user.upsert({
    where: { email },
    // An explicitly provided name wins on re-seed — stale names from prior
    // runs made personas hard to tell apart.
    update: providedName ? { displayName: providedName } : {},
    create: {
      email,
      displayName,
      emailVerifiedAt: new Date(),
    },
  });
  if (!user.emailVerifiedAt) {
    // A dev-domain account that came in through normal register: verify it —
    // the domain restriction is the trust boundary here, not the inbox.
    user = await prisma.user.update({ where: { userId: user.userId }, data: { emailVerifiedAt: new Date() } });
  }
  return user;
}

authRouter.post('/auth/dev/login', async (req, res, next) => {
  try {
    const input = devLoginSchema.parse(req.body);
    requireDevSecret(input.secret);
    const user = await upsertDevUser(input.email, input.displayName);

    const session = await createSession(user.userId);
    const organizations = await listUserOrganizations(user.userId);

    let landingOrganizationId: string | null = null;
    if (input.organizationName) {
      const wanted = input.organizationName.trim().toLowerCase();
      const match = organizations.find((o) => o.organizationName.toLowerCase() === wanted);
      if (!match) {
        throw badRequest(`${user.email} isn't a member of an organization named "${input.organizationName}". Their orgs: ${organizations.map((o) => o.organizationName).join(', ') || 'none'}.`);
      }
      landingOrganizationId = match.organizationId;
    }

    logger.info('auth.dev_login', { email: user.email, userId: user.userId });
    res.json({
      status: 'authenticated',
      sessionToken: session.sessionToken,
      user: serializeUser(user),
      organizations,
      landingOrganizationId,
      emailDelivered: false,
      devEmailVerificationCode: null,
    });
  } catch (error) {
    next(error);
  }
});

// One-call test-world builder: users + organization + memberships + role
// bundles, returning a session token for EVERY persona so an agent can act as
// each of them immediately. Same gates as dev/login (secret + dev domain).
// Wallet provisioning is deliberately skipped — this exists for workflow,
// role, and approval testing, not for moving money.
const devSeedSchema = z.object({
  secret: z.string().min(1),
  organizationName: z.string().trim().min(3).max(80),
  owner: z.object({
    email: z.string().email(),
    displayName: z.string().trim().min(1).max(80).optional(),
  }),
  members: z.array(z.object({
    email: z.string().email(),
    displayName: z.string().trim().min(1).max(80).optional(),
    access: z.enum(['admin', 'member']).default('member'),
    roles: z.array(z.string()).max(8).default([]),
  })).max(50).default([]),
});

authRouter.post('/auth/dev/seed', async (req, res, next) => {
  try {
    const input = devSeedSchema.parse(req.body);
    requireDevSecret(input.secret);

    const emails = [input.owner.email, ...input.members.map((m) => m.email)].map(requireDevEmail);
    if (new Set(emails).size !== emails.length) {
      throw badRequest('Each persona needs a distinct email.');
    }
    const { isRoleKey, assignRole } = await import('../approvals/roles.js');
    // Role keys are lowercase ('reviewer'); accept any casing from callers.
    const normalizedRoles = input.members.map((m) => m.roles.map((r) => r.trim().toLowerCase()));
    for (const roles of normalizedRoles) {
      for (const role of roles) {
        if (!isRoleKey(role)) throw badRequest(`Unknown role "${role}". Valid: reviewer, approver, payer, viewer.`);
      }
    }

    const organizationName = input.organizationName.trim();
    const nameTaken = await prisma.organization.findFirst({ where: { organizationName } });
    if (nameTaken) {
      throw conflict('An organization with this name already exists — use a unique name per seed.');
    }

    const ownerUser = await upsertDevUser(input.owner.email, input.owner.displayName);
    const organization = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { organizationName } });
      await tx.organizationMembership.create({
        data: { organizationId: org.organizationId, userId: ownerUser.userId, role: 'owner' },
      });
      return org;
    });
    const personas = [{ user: ownerUser, access: 'owner', roles: [] as string[] }];
    for (const [index, member] of input.members.entries()) {
      const user = await upsertDevUser(member.email, member.displayName);
      await prisma.organizationMembership.create({
        data: { organizationId: organization.organizationId, userId: user.userId, role: member.access },
      });
      const applied: string[] = [];
      if (member.access === 'member') {
        // Admins hold every capability; roles are for members only.
        for (const role of normalizedRoles[index]!) {
          if (!isRoleKey(role)) continue;
          await assignRole(organization.organizationId, role, user.userId);
          applied.push(role);
        }
      }
      personas.push({ user, access: member.access, roles: applied });
    }

    // Engine setup runs AFTER the members exist — seeding it first gave the
    // default approval seat only the owner, which deadlocked every bill
    // (BUG-default-flow-deadlock, found by testbench brief 005).
    const { ensureEngineSetup } = await import('../approvals/wiring.js');
    await ensureEngineSetup(organization.organizationId);

    const users = await Promise.all(personas.map(async (p) => {
      const session = await createSession(p.user.userId, organization.organizationId);
      return {
        userId: p.user.userId,
        email: p.user.email,
        displayName: p.user.displayName,
        access: p.access,
        roles: p.roles,
        sessionToken: session.sessionToken,
      };
    }));

    logger.info('auth.dev_seed', { organizationId: organization.organizationId, users: users.length });
    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      users,
      note: 'Wallet provisioning skipped — seeded for workflow/approval testing.',
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/auth/verify-email', requireAuth(), async (req, res, next) => {
  try {
    const input = verifyEmailSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { userId: req.auth!.userId },
    });

    if (user.emailVerifiedAt) {
      res.json({ user: serializeUser(user) });
      return;
    }

    if (!user.emailVerificationCodeHash || !user.emailVerificationExpiresAt) {
      throw badRequest('Verification code is not active. Request a new code.');
    }

    if (user.emailVerificationExpiresAt <= new Date()) {
      throw badRequest('Verification code expired. Request a new code.');
    }

    if (hashCode(input.code) !== user.emailVerificationCodeHash) {
      throw badRequest('Verification code is incorrect.');
    }

    const verified = await prisma.user.update({
      where: { userId: user.userId },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationCodeHash: null,
        emailVerificationExpiresAt: null,
      },
    });

    res.json({ user: serializeUser(verified) });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/auth/resend-verification', requireAuth(), async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { userId: req.auth!.userId },
    });
    if (user.emailVerifiedAt) {
      res.json({ user: serializeUser(user), emailDelivered: false, devEmailVerificationCode: null });
      return;
    }

    const code = generateVerificationCode();
    const updated = await prisma.user.update({
      where: { userId: user.userId },
      data: emailVerificationFieldsForCode(code),
    });

    const delivery = await deliverVerificationCode({
      toEmail: updated.email,
      displayName: updated.displayName,
      code,
    });

    res.json({
      user: serializeUser(updated),
      emailDelivered: delivery.emailDelivered,
      devEmailVerificationCode: delivery.devEmailVerificationCode,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/auth/logout', requireAuth(), async (req, res, next) => {
  try {
    const sessionTokenHash = crypto.createHash('sha256').update(req.auth!.sessionToken).digest('hex');
    await prisma.authSession.deleteMany({
      where: {
        OR: [
          { sessionToken: req.auth!.sessionToken },
          { sessionToken: sessionTokenHash },
        ],
      },
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
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((membership) => ({
    organizationId: membership.organization.organizationId,
    organizationName: membership.organization.organizationName,
    role: membership.role,
    status: membership.organization.status,
  }));
}

function serializeUser(user: {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  emailVerifiedAt?: Date | null;
}) {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOptionalDisplayName(displayName?: string) {
  const trimmed = displayName?.trim();
  return trimmed?.length ? trimmed : null;
}

function defaultDisplayName(email: string) {
  return email.split('@')[0] ?? email;
}

function invalidCredentialsError() {
  return new ApiError(401, 'invalid_credentials', 'Invalid email or password.');
}

async function deliverVerificationCode({
  toEmail,
  displayName,
  code,
}: {
  toEmail: string;
  displayName: string | null;
  code: string | null;
}): Promise<{ emailDelivered: boolean; devEmailVerificationCode: string | null }> {
  if (!code) {
    return { emailDelivered: false, devEmailVerificationCode: null };
  }

  if (config.nodeEnv === 'test' || !isEmailDeliveryConfigured()) {
    return { emailDelivered: false, devEmailVerificationCode: code };
  }

  try {
    await sendVerificationEmail({ toEmail, displayName, code });
    return { emailDelivered: true, devEmailVerificationCode: null };
  } catch (error) {
    logger.error('auth.verification_email_failed', {
      toEmail,
      ...errorToLogFields(error),
    });
    return { emailDelivered: false, devEmailVerificationCode: null };
  }
}

function emailVerificationFieldsForCode(code: string) {
  return {
    emailVerificationCodeHash: hashCode(code),
    emailVerificationExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
}

function generateVerificationCode() {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function hashCode(code: string) {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

function assertGoogleOAuthConfigured() {
  if (!config.googleOAuthClientId || !config.googleOAuthClientSecret) {
    throw new ApiError(501, 'google_oauth_not_configured', 'Google OAuth is not configured.');
  }
  if (!config.oauthStateSecret) {
    throw new ApiError(501, 'oauth_state_not_configured', 'OAuth state signing is not configured.');
  }
}

function googleRedirectUri(req: Request) {
  if (config.googleOAuthRedirectUri) {
    return config.googleOAuthRedirectUri;
  }
  const host = req.get('host') ?? '';
  if (!config.isProduction && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return 'http://127.0.0.1:3100/auth/google/callback';
  }
  if (!config.publicApiUrl) {
    throw new ApiError(501, 'public_api_url_not_configured', 'Public API URL is required for Google OAuth.');
  }
  return `${config.publicApiUrl}/auth/google/callback`;
}

function normalizeReturnTo(returnTo?: string) {
  const fallback = '/setup';
  const trimmed = returnTo?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  return trimmed;
}

function normalizeFrontendOrigin(frontendOrigin?: string | null) {
  const normalized = frontendOrigin?.trim().replace(/\/+$/, '');
  if (!normalized) {
    return null;
  }
  return config.corsOrigins.includes(normalized) ? normalized : null;
}

function signOAuthState(payload: OAuthStatePayload) {
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = crypto
    .createHmac('sha256', config.oauthStateSecret)
    .update(encodedPayload)
    .digest();
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

function verifyOAuthState(rawState: string): OAuthStatePayload {
  const [encodedPayload, encodedSignature] = rawState.split('.');
  if (!encodedPayload || !encodedSignature) {
    throw badRequest('OAuth state is invalid.');
  }
  const expectedSignature = crypto
    .createHmac('sha256', config.oauthStateSecret)
    .update(encodedPayload)
    .digest();
  const actualSignature = base64UrlDecode(encodedSignature);
  if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    throw badRequest('OAuth state signature is invalid.');
  }
  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as OAuthStatePayload;
  if (payload.provider !== 'google' || payload.expiresAt <= Date.now()) {
    throw badRequest('OAuth state expired. Try signing in again.');
  }
  if (!payload.redirectUri) {
    throw badRequest('OAuth state is missing redirect context.');
  }
  return {
    provider: 'google',
    nonce: payload.nonce,
    returnTo: normalizeReturnTo(payload.returnTo),
    frontendOrigin: normalizeFrontendOrigin(payload.frontendOrigin),
    redirectUri: payload.redirectUri,
    expiresAt: payload.expiresAt,
  };
}

async function fetchGoogleProfile(code: string, redirectUri: string) {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleOAuthClientId,
      client_secret: config.googleOAuthClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenBody = (await tokenResponse.json()) as GoogleTokenResponse;
  if (!tokenResponse.ok || !tokenBody.id_token) {
    throw new ApiError(400, 'google_oauth_exchange_failed', tokenBody.error_description ?? tokenBody.error ?? 'Google OAuth exchange failed.');
  }

  const tokenInfo = await verifyGoogleIdToken(tokenBody.id_token);
  if (tokenInfo.error) {
    throw new ApiError(400, 'google_oauth_profile_failed', tokenInfo.error_description ?? tokenInfo.error ?? 'Google profile verification failed.');
  }
  if (tokenInfo.aud !== config.googleOAuthClientId) {
    throw badRequest('Google OAuth audience does not match this application.');
  }
  if (tokenInfo.iss !== 'accounts.google.com' && tokenInfo.iss !== 'https://accounts.google.com') {
    throw badRequest('Google OAuth issuer is invalid.');
  }
  if (!tokenInfo.sub || !tokenInfo.email) {
    throw badRequest('Google account did not return a usable identity.');
  }
  if (tokenInfo.email_verified !== true && tokenInfo.email_verified !== 'true') {
    throw badRequest('Google email address is not verified.');
  }

  return {
    googleSubject: tokenInfo.sub,
    email: normalizeEmail(tokenInfo.email),
    displayName: normalizeOptionalDisplayName(tokenInfo.name) ?? defaultDisplayName(tokenInfo.email),
    avatarUrl: tokenInfo.picture?.trim() || null,
  };
}

async function verifyGoogleIdToken(idToken: string): Promise<GoogleTokenInfo> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw badRequest('Google ID token is malformed.');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) {
    throw badRequest('Google ID token uses an unsupported signature.');
  }

  const jwk = await getGoogleJwk(header.kid);
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    base64UrlDecode(encodedSignature),
  );
  if (!verified) {
    throw badRequest('Google ID token signature is invalid.');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as GoogleTokenInfo & {
    exp?: number | string;
  };
  const expiresAtSeconds = typeof payload.exp === 'string' ? Number(payload.exp) : payload.exp;
  if (!expiresAtSeconds || expiresAtSeconds * 1000 <= Date.now()) {
    throw badRequest('Google ID token is expired.');
  }

  return payload;
}

async function getGoogleJwk(kid: string) {
  const cache = await getGoogleJwks();
  const jwk = cache.keys.get(kid);
  if (!jwk) {
    googleJwksCache = null;
    const refreshed = await getGoogleJwks();
    const refreshedJwk = refreshed.keys.get(kid);
    if (!refreshedJwk) {
      throw badRequest('Google signing key is unavailable.');
    }
    return refreshedJwk;
  }
  return jwk;
}

async function getGoogleJwks() {
  if (googleJwksCache && googleJwksCache.expiresAt > Date.now()) {
    return googleJwksCache;
  }

  const response = await fetch(GOOGLE_JWKS_URL);
  const body = (await response.json()) as GoogleJwksResponse;
  if (!response.ok || !Array.isArray(body.keys)) {
    throw new ApiError(400, 'google_jwks_fetch_failed', 'Unable to fetch Google signing keys.');
  }
  const maxAgeMs = parseCacheControlMaxAge(response.headers.get('cache-control')) ?? 60 * 60 * 1000;
  googleJwksCache = {
    keys: new Map(body.keys.filter((key) => typeof key.kid === 'string').map((key) => [key.kid!, key])),
    expiresAt: Date.now() + maxAgeMs,
  };
  return googleJwksCache;
}

async function upsertGoogleUser(profile: {
  googleSubject: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const existingByGoogle = await tx.user.findUnique({
      where: { googleSubject: profile.googleSubject },
    });
    if (existingByGoogle) {
      return tx.user.update({
        where: { userId: existingByGoogle.userId },
        data: {
          email: profile.email,
          displayName: existingByGoogle.displayName || profile.displayName,
          avatarUrl: profile.avatarUrl,
          emailVerifiedAt: existingByGoogle.emailVerifiedAt ?? new Date(),
          emailVerificationCodeHash: null,
          emailVerificationExpiresAt: null,
        },
      });
    }

    const existingByEmail = await tx.user.findUnique({
      where: { email: profile.email },
    });
    if (existingByEmail) {
      return tx.user.update({
        where: { userId: existingByEmail.userId },
        data: {
          googleSubject: profile.googleSubject,
          avatarUrl: profile.avatarUrl,
          emailVerifiedAt: existingByEmail.emailVerifiedAt ?? new Date(),
          emailVerificationCodeHash: null,
          emailVerificationExpiresAt: null,
        },
      });
    }

    return tx.user.create({
      data: {
        email: profile.email,
        displayName: profile.displayName,
        googleSubject: profile.googleSubject,
        avatarUrl: profile.avatarUrl,
        emailVerifiedAt: new Date(),
      },
    });
  });
}

function redirectOAuthResult(
  res: Response,
  frontendBaseUrl: string,
  returnTo: string,
  sessionToken: string | null,
  error: string | null,
) {
  const redirect = new URL('/oauth/callback', frontendBaseUrl);
  const fragment = new URLSearchParams({ return_to: normalizeReturnTo(returnTo) });
  if (sessionToken) {
    fragment.set('session_token', sessionToken);
  }
  if (error) {
    fragment.set('error', error);
  }
  redirect.hash = fragment.toString();
  res.redirect(redirect.toString());
}

function base64UrlEncode(value: Buffer) {
  return value.toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url');
}

function parseCacheControlMaxAge(value: string | null) {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 1000;
}

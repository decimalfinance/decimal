import crypto from 'node:crypto';
import type { ApiKey } from '@prisma/client';
import { prisma } from './prisma.js';

export const DEFAULT_AGENT_SCOPES = [
  'workspace:read',
  'workspace:write',
  'approvals:write',
  'execution:write',
  'payments:write',
  'reconciliation:read',
  'exceptions:write',
  'proofs:read',
];

const API_KEY_TOKEN_PREFIX = 'axoria_live_';

export function generateApiKeyToken() {
  const tokenId = crypto.randomBytes(10).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return `${API_KEY_TOKEN_PREFIX}${tokenId}.${secret}`;
}

export function hashApiKeyToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getApiKeyPrefix(token: string) {
  return token.slice(0, 24);
}

export async function createWorkspaceApiKey(args: {
  workspaceId: string;
  createdByUserId: string;
  label: string;
  role?: string;
  scopes?: string[];
  expiresAt?: Date | null;
}) {
  const workspace = await prisma.workspace.findUnique({
    where: { workspaceId: args.workspaceId },
    select: { workspaceId: true, organizationId: true },
  });

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const token = generateApiKeyToken();
  const apiKey = await prisma.apiKey.create({
    data: {
      workspaceId: workspace.workspaceId,
      organizationId: workspace.organizationId,
      createdByUserId: args.createdByUserId,
      label: args.label.trim(),
      keyPrefix: getApiKeyPrefix(token),
      keyHash: hashApiKeyToken(token),
      role: args.role ?? 'agent_operator',
      scopes: args.scopes ?? DEFAULT_AGENT_SCOPES,
      expiresAt: args.expiresAt ?? null,
    },
  });

  return {
    apiKey: serializeApiKey(apiKey),
    token,
  };
}

export async function authenticateApiKey(token: string) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKeyToken(token) },
    include: {
      createdByUser: true,
      workspace: {
        select: {
          workspaceId: true,
          organizationId: true,
          status: true,
        },
      },
    },
  });

  if (!apiKey || apiKey.status !== 'active' || apiKey.revokedAt) {
    return null;
  }

  if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
    return null;
  }

  if (apiKey.workspace.status !== 'active') {
    return null;
  }

  await prisma.apiKey.update({
    where: { apiKeyId: apiKey.apiKeyId },
    data: { lastUsedAt: new Date() },
  });

  return apiKey;
}

export async function listWorkspaceApiKeys(workspaceId: string) {
  const items = await prisma.apiKey.findMany({
    where: { workspaceId },
    include: {
      createdByUser: {
        select: {
          userId: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    items: items.map(serializeApiKey),
  };
}

export async function revokeWorkspaceApiKey(args: {
  workspaceId: string;
  apiKeyId: string;
}) {
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      workspaceId: args.workspaceId,
      apiKeyId: args.apiKeyId,
    },
  });

  if (!apiKey) {
    throw new Error('API key not found');
  }

  const revoked = await prisma.apiKey.update({
    where: { apiKeyId: args.apiKeyId },
    data: {
      status: 'revoked',
      revokedAt: new Date(),
    },
  });

  return serializeApiKey(revoked);
}

export function serializeApiKey(apiKey: ApiKey & { createdByUser?: { userId: string; email: string; displayName: string } | null }) {
  return {
    apiKeyId: apiKey.apiKeyId,
    workspaceId: apiKey.workspaceId,
    organizationId: apiKey.organizationId,
    createdByUserId: apiKey.createdByUserId,
    label: apiKey.label,
    keyPrefix: apiKey.keyPrefix,
    status: apiKey.status,
    role: apiKey.role,
    scopes: Array.isArray(apiKey.scopes) ? apiKey.scopes : [],
    lastUsedAt: apiKey.lastUsedAt,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
    createdByUser: apiKey.createdByUser ?? null,
  };
}

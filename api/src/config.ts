import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type FileConfig = {
  host?: string;
  port?: number;
  publicApiUrl?: string | null;
  publicFrontendUrl?: string | null;
  clickhouseUrl?: string;
  clickhouseDatabase?: string;
  corsOrigins?: string[];
  trustProxy?: boolean;
  rateLimitEnabled?: boolean;
  publicRateLimitWindowMs?: number;
  publicRateLimitMax?: number;
};

type DecimalConfig = {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  publicApiUrl: string | null;
  publicFrontendUrl: string | null;
  solanaRpcUrl: string;
  clickhouseUrl: string;
  clickhouseDatabase: string;
  corsOrigins: string[];
  trustProxy: boolean;
  controlPlaneServiceToken: string;
  rateLimitEnabled: boolean;
  publicRateLimitWindowMs: number;
  publicRateLimitMax: number;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOAuthRedirectUri: string | null;
  oauthStateSecret: string;
  privyAppId: string;
  privyAppSecret: string;
  privyApiBaseUrl: string;
};

export const config: DecimalConfig = buildConfig();

function buildConfig(): DecimalConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const fileConfig = loadApiFileConfig();
  const controlPlaneServiceToken = (process.env.CONTROL_PLANE_SERVICE_TOKEN ?? '').trim();

  const nextConfig: DecimalConfig = {
    nodeEnv,
    isProduction,
    host: fileConfig.host ?? '0.0.0.0',
    port: fileConfig.port ?? 3100,
    publicApiUrl: normalizeOptionalUrl(fileConfig.publicApiUrl),
    publicFrontendUrl: normalizeOptionalUrl(fileConfig.publicFrontendUrl),
    solanaRpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    clickhouseUrl: fileConfig.clickhouseUrl ?? 'http://127.0.0.1:8123',
    clickhouseDatabase: fileConfig.clickhouseDatabase ?? 'usdc_ops',
    corsOrigins: normalizeStringArray(fileConfig.corsOrigins),
    trustProxy: fileConfig.trustProxy ?? false,
    controlPlaneServiceToken,
    rateLimitEnabled:
      fileConfig.rateLimitEnabled ?? (nodeEnv === 'test' ? false : true),
    publicRateLimitWindowMs: fileConfig.publicRateLimitWindowMs ?? 60_000,
    publicRateLimitMax: fileConfig.publicRateLimitMax ?? 120,
    googleOAuthClientId: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    googleOAuthClientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim(),
    googleOAuthRedirectUri: normalizeOptionalUrl(process.env.GOOGLE_OAUTH_REDIRECT_URI),
    oauthStateSecret: (process.env.OAUTH_STATE_SECRET ?? controlPlaneServiceToken).trim(),
    privyAppId: (process.env.PRIVY_APP_ID ?? '').trim(),
    privyAppSecret: (process.env.PRIVY_APP_SECRET ?? '').trim(),
    privyApiBaseUrl: normalizeOptionalUrl(process.env.PRIVY_API_BASE_URL) ?? 'https://api.privy.io',
  };

  validateConfig(nextConfig);
  return nextConfig;
}

function loadApiFileConfig(): FileConfig {
  const explicitPath = process.env.DECIMAL_API_CONFIG_PATH?.trim();
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), 'config/api.config.json'),
    path.resolve(process.cwd(), '../config/api.config.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/api.config.json'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const raw = fs.readFileSync(candidate, 'utf8');
    return JSON.parse(raw) as FileConfig;
  }

  return {};
}

function normalizeStringArray(values: string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizeOptionalUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
}

function validateConfig(nextConfig: DecimalConfig) {
  const hasPartialGoogleOAuthConfig =
    Boolean(nextConfig.googleOAuthClientId) !== Boolean(nextConfig.googleOAuthClientSecret);
  if (hasPartialGoogleOAuthConfig) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be configured together.');
  }

  if (nextConfig.googleOAuthClientId && !nextConfig.oauthStateSecret) {
    throw new Error('OAUTH_STATE_SECRET is required when Google OAuth is enabled.');
  }

  const hasPartialPrivyConfig = Boolean(nextConfig.privyAppId) !== Boolean(nextConfig.privyAppSecret);
  if (hasPartialPrivyConfig) {
    throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together.');
  }

  if (nextConfig.privyApiBaseUrl.includes('/jwks') || nextConfig.privyApiBaseUrl.includes('/apps/')) {
    throw new Error('PRIVY_API_BASE_URL must be the Privy REST API base URL, usually https://api.privy.io, not a JWKS endpoint.');
  }

  if (!nextConfig.isProduction) {
    return;
  }

  if (nextConfig.corsOrigins.length === 0) {
    throw new Error('config/api.config.json must define at least one CORS origin in production.');
  }

  if (!nextConfig.controlPlaneServiceToken) {
    throw new Error('CONTROL_PLANE_SERVICE_TOKEN is required in production.');
  }

  if (!nextConfig.publicApiUrl) {
    throw new Error('config/api.config.json must define publicApiUrl in production.');
  }

  if (!nextConfig.publicFrontendUrl) {
    throw new Error('config/api.config.json must define publicFrontendUrl in production.');
  }

}

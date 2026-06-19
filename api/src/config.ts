import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type FileConfig = {
  host?: string;
  port?: number;
  publicApiUrl?: string | null;
  publicFrontendUrl?: string | null;
  corsOrigins?: string[];
  trustProxy?: boolean;
  rateLimitEnabled?: boolean;
  publicRateLimitWindowMs?: number;
  publicRateLimitMax?: number;
  logLevel?: LogLevel;
  squadsProgramId?: string;
  squadsDefaultVaultIndex?: number;
  squadsDefaultTimelockSeconds?: number;
  squadsProgramTreasury?: string | null;
  autoProvisionWallets?: boolean;
  devnetAutoFundWallets?: boolean;
  openAiModel?: string;
};

type DecimalConfig = {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  publicApiUrl: string | null;
  publicFrontendUrl: string | null;
  solanaNetwork: SolanaNetwork;
  /**
   * Commitment required before a payment is asserted `settled` (the terminal,
   * proof-backing state). `finalized` is the irreversible money-truth bar;
   * `confirmed` is faster but theoretically reversible. Defaults to `finalized`
   * on mainnet (real money) and `confirmed` on devnet (snappy demos); override
   * with SETTLEMENT_COMMITMENT. The fast "executed" signal still uses confirmed.
   */
  settlementCommitment: 'confirmed' | 'finalized';
  solanaRpcUrl: string;
  /**
   * Frontend-safe RPC URL advertised to browsers (via /capabilities) for
   * client-side signing/submission. Must NOT be a paid keyed endpoint —
   * it is exposed in every browser. Defaults to the network's public RPC;
   * override with SOLANA_PUBLIC_RPC_URL (e.g. a domain-restricted key).
   */
  solanaPublicRpcUrl: string;
  /**
   * Always-devnet RPC URL. Used for devnet reads (balances, signature
   * status) regardless of which network the rest of the app is
   * configured for. Typically a paid provider (Alchemy / Helius) for
   * better rate limits — premium providers disable requestAirdrop, so
   * see solanaAirdropRpcUrl below for the airdrop-specific path.
   */
  solanaDevnetRpcUrl: string;
  /**
   * RPC URL used specifically for `requestAirdrop` calls. Must be a
   * node that allows the airdrop method (Solana's public devnet
   * endpoint always does; most premium providers do not). Override
   * with SOLANA_AIRDROP_RPC_URL if a different faucet-allowing
   * endpoint is preferred. Defaults to https://api.devnet.solana.com.
   */
  solanaAirdropRpcUrl: string;
  corsOrigins: string[];
  trustProxy: boolean;
  rateLimitEnabled: boolean;
  publicRateLimitWindowMs: number;
  publicRateLimitMax: number;
  logLevel: LogLevel;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOAuthRedirectUri: string | null;
  oauthStateSecret: string;
  privyAppId: string;
  privyAppSecret: string;
  privyApiBaseUrl: string;
  resendApiKey: string;
  resendFromEmail: string;
  resendFromName: string;
  /**
   * OpenAI configuration for the doc-to-proposal pipeline (invoice PDFs/
   * images → structured payment rows). If the key is unset, document
   * intake returns a clear configuration error instead of failing later.
   */
  openAiApiKey: string;
  openAiModel: string;
  squadsProgramId: string;
  squadsDefaultVaultIndex: number;
  squadsDefaultTimelockSeconds: number;
  squadsProgramTreasury: string | null;
  autoProvisionWallets: boolean;
  devnetAutoFundWallets: boolean;
  devnetFunderKeypairPath: string;
  devnetAutoFundLamports: number;
  settlementReconcilerEnabled: boolean;
  settlementReconcilerIntervalMs: number;
  /**
   * QuickBooks Online (GL sync) — same Intuit app, two key sets. `sandbox`
   * uses the development keys + sandbox API host; `production` connects real
   * customer companies. Defaults to sandbox; flip with QUICKBOOKS_ENVIRONMENT.
   */
  quickbooksClientId: string;
  quickbooksClientSecret: string;
  quickbooksRedirectUri: string | null;
  quickbooksEnvironment: 'sandbox' | 'production';
  accountingSyncEnabled: boolean;
  accountingSyncIntervalMs: number;
};

export type SolanaNetwork = 'devnet' | 'mainnet';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const config: DecimalConfig = buildConfig();

function buildConfig(): DecimalConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const fileConfig = loadApiFileConfig();
  const solanaNetwork = getSolanaNetwork();
  const solanaRpcUrl = (process.env.SOLANA_RPC_URL?.trim() || defaultSolanaRpcUrl(solanaNetwork));
  // Frontend-safe RPC: never the paid keyed endpoint. Public RPC by default.
  const solanaPublicRpcUrl = (process.env.SOLANA_PUBLIC_RPC_URL?.trim() || defaultSolanaRpcUrl(solanaNetwork));
  const solanaDevnetRpcUrl = (process.env.SOLANA_DEVNET_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  const solanaAirdropRpcUrl = (process.env.SOLANA_AIRDROP_RPC_URL?.trim() || 'https://api.devnet.solana.com');
  const settlementCommitmentEnv = process.env.SETTLEMENT_COMMITMENT?.trim();
  const settlementCommitment: 'confirmed' | 'finalized' =
    settlementCommitmentEnv === 'finalized' || settlementCommitmentEnv === 'confirmed'
      ? settlementCommitmentEnv
      : solanaNetwork === 'mainnet' ? 'finalized' : 'confirmed';

  const nextConfig: DecimalConfig = {
    nodeEnv,
    isProduction,
    host: fileConfig.host ?? '0.0.0.0',
    port: fileConfig.port ?? 3100,
    publicApiUrl: normalizeOptionalUrl(fileConfig.publicApiUrl),
    publicFrontendUrl: normalizeOptionalUrl(fileConfig.publicFrontendUrl),
    solanaNetwork,
    settlementCommitment,
    solanaRpcUrl,
    solanaPublicRpcUrl,
    solanaDevnetRpcUrl,
    solanaAirdropRpcUrl,
    corsOrigins: normalizeStringArray(fileConfig.corsOrigins),
    trustProxy: fileConfig.trustProxy ?? false,
    rateLimitEnabled:
      fileConfig.rateLimitEnabled ?? (nodeEnv === 'test' ? false : true),
    publicRateLimitWindowMs: fileConfig.publicRateLimitWindowMs ?? 60_000,
    publicRateLimitMax: fileConfig.publicRateLimitMax ?? 120,
    logLevel: getLogLevel(process.env.LOG_LEVEL ?? process.env.DECIMAL_LOG_LEVEL ?? fileConfig.logLevel ?? (nodeEnv === 'test' ? 'silent' : 'info')),
    googleOAuthClientId: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    googleOAuthClientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim(),
    googleOAuthRedirectUri: normalizeOptionalUrl(process.env.GOOGLE_OAUTH_REDIRECT_URI),
    oauthStateSecret: (process.env.OAUTH_STATE_SECRET ?? '').trim(),
    privyAppId: (process.env.PRIVY_APP_ID ?? '').trim(),
    privyAppSecret: (process.env.PRIVY_APP_SECRET ?? '').trim(),
    privyApiBaseUrl: normalizeOptionalUrl(process.env.PRIVY_API_BASE_URL) ?? 'https://api.privy.io',
    resendApiKey: (process.env.RESEND_API_KEY ?? '').trim(),
    resendFromEmail: (process.env.RESEND_FROM_EMAIL ?? '').trim(),
    resendFromName: (process.env.RESEND_FROM_NAME ?? 'Decimal').trim(),
    openAiApiKey: (process.env.OPENAI_API_KEY ?? '').trim(),
    openAiModel: (process.env.OPENAI_MODEL ?? fileConfig.openAiModel ?? 'gpt-4o-mini').trim(),
    squadsProgramId:
      (process.env.SQUADS_V4_PROGRAM_ID ?? fileConfig.squadsProgramId ?? 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf').trim(),
    squadsDefaultVaultIndex: Number(process.env.SQUADS_DEFAULT_VAULT_INDEX ?? fileConfig.squadsDefaultVaultIndex ?? 0),
    squadsDefaultTimelockSeconds: Number(
      process.env.SQUADS_DEFAULT_TIMELOCK_SECONDS ?? fileConfig.squadsDefaultTimelockSeconds ?? 0,
    ),
    squadsProgramTreasury: normalizeOptionalText(process.env.SQUADS_PROGRAM_TREASURY ?? fileConfig.squadsProgramTreasury),
    autoProvisionWallets: getBooleanConfig(
      process.env.AUTO_PROVISION_WALLETS,
      fileConfig.autoProvisionWallets ?? (nodeEnv !== 'test' && Boolean(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET)),
    ),
    devnetAutoFundWallets: nodeEnv === 'test'
      ? false
      : getBooleanConfig(
          process.env.DEVNET_AUTO_FUND_WALLETS,
          fileConfig.devnetAutoFundWallets ?? false,
        ),
    devnetFunderKeypairPath: (process.env.DEVNET_FUNDER_KEYPAIR_PATH ?? '').trim(),
    devnetAutoFundLamports: Number(process.env.DEVNET_AUTO_FUND_LAMPORTS ?? 5_000_000),
    settlementReconcilerEnabled: getBooleanConfig(
      process.env.SETTLEMENT_RECONCILER_ENABLED,
      nodeEnv !== 'test',
    ),
    settlementReconcilerIntervalMs: Number(
      process.env.SETTLEMENT_RECONCILER_INTERVAL_MS ?? 30_000,
    ),
    quickbooksClientId: (process.env.QUICKBOOKS_CLIENT_ID ?? '').trim(),
    quickbooksClientSecret: (process.env.QUICKBOOKS_CLIENT_SECRET ?? '').trim(),
    quickbooksRedirectUri: normalizeOptionalUrl(process.env.QUICKBOOKS_REDIRECT_URI),
    quickbooksEnvironment:
      process.env.QUICKBOOKS_ENVIRONMENT?.trim() === 'production' ? 'production' : 'sandbox',
    accountingSyncEnabled: getBooleanConfig(
      process.env.ACCOUNTING_SYNC_ENABLED,
      nodeEnv !== 'test' && Boolean((process.env.QUICKBOOKS_CLIENT_ID ?? '').trim()),
    ),
    accountingSyncIntervalMs: Number(process.env.ACCOUNTING_SYNC_INTERVAL_MS ?? 30_000),
  };

  validateConfig(nextConfig);
  return nextConfig;
}

export function getSolanaNetwork(): SolanaNetwork {
  const raw = (process.env.SOLANA_NETWORK ?? 'mainnet').trim().toLowerCase();
  if (raw !== 'devnet' && raw !== 'mainnet') {
    throw new Error(`Invalid SOLANA_NETWORK="${raw}". Use 'devnet' or 'mainnet'.`);
  }
  return raw;
}

function defaultSolanaRpcUrl(network: SolanaNetwork) {
  return network === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
}

function getLogLevel(value: string): LogLevel {
  const normalized = value.trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error', 'silent'].includes(normalized)) {
    return normalized as LogLevel;
  }
  throw new Error(`Invalid LOG_LEVEL="${value}". Use debug, info, warn, error, or silent.`);
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

  const hasPartialQuickbooksConfig =
    Boolean(nextConfig.quickbooksClientId) !== Boolean(nextConfig.quickbooksClientSecret);
  if (hasPartialQuickbooksConfig) {
    throw new Error('QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be configured together.');
  }

  if (nextConfig.autoProvisionWallets && (!nextConfig.privyAppId || !nextConfig.privyAppSecret)) {
    throw new Error('AUTO_PROVISION_WALLETS requires PRIVY_APP_ID and PRIVY_APP_SECRET.');
  }

  if (nextConfig.devnetAutoFundWallets) {
    if (nextConfig.solanaNetwork !== 'devnet') {
      throw new Error('DEVNET_AUTO_FUND_WALLETS can only be enabled when SOLANA_NETWORK=devnet.');
    }
    if (!nextConfig.devnetFunderKeypairPath) {
      throw new Error('DEVNET_AUTO_FUND_WALLETS requires DEVNET_FUNDER_KEYPAIR_PATH.');
    }
    if (!Number.isInteger(nextConfig.devnetAutoFundLamports) || nextConfig.devnetAutoFundLamports < 0) {
      throw new Error('DEVNET_AUTO_FUND_LAMPORTS must be a non-negative integer.');
    }
  }

  const hasPartialResendConfig = Boolean(nextConfig.resendApiKey) !== Boolean(nextConfig.resendFromEmail);
  if (hasPartialResendConfig) {
    throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL must be configured together.');
  }

  if (nextConfig.openAiApiKey && !nextConfig.openAiModel) {
    throw new Error('OPENAI_MODEL is required when OPENAI_API_KEY is configured.');
  }

  if (nextConfig.privyApiBaseUrl.includes('/jwks') || nextConfig.privyApiBaseUrl.includes('/apps/')) {
    throw new Error('PRIVY_API_BASE_URL must be the Privy REST API base URL, usually https://api.privy.io, not a JWKS endpoint.');
  }

  if (!Number.isInteger(nextConfig.squadsDefaultVaultIndex) || nextConfig.squadsDefaultVaultIndex < 0 || nextConfig.squadsDefaultVaultIndex > 255) {
    throw new Error('SQUADS_DEFAULT_VAULT_INDEX must be an integer between 0 and 255.');
  }

  if (
    !Number.isInteger(nextConfig.squadsDefaultTimelockSeconds)
    || nextConfig.squadsDefaultTimelockSeconds < 0
    || nextConfig.squadsDefaultTimelockSeconds > 7_776_000
  ) {
    throw new Error('SQUADS_DEFAULT_TIMELOCK_SECONDS must be an integer between 0 and 7776000.');
  }

  if (!nextConfig.isProduction) {
    return;
  }

  if (nextConfig.corsOrigins.length === 0) {
    throw new Error('config/api.config.json must define at least one CORS origin in production.');
  }

  if (!nextConfig.publicApiUrl) {
    throw new Error('config/api.config.json must define publicApiUrl in production.');
  }

  if (!nextConfig.publicFrontendUrl) {
    throw new Error('config/api.config.json must define publicFrontendUrl in production.');
  }

}

function getBooleanConfig(raw: string | undefined, fallback: boolean) {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean config value "${raw}". Use true or false.`);
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

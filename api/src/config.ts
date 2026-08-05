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
  inboundEmailDomain?: string;
};

type DecimalConfig = {
  nodeEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  publicApiUrl: string | null;
  publicFrontendUrl: string | null;
  /**
   * The backend's Solana node. Devnet — there is no other cluster in this
   * product. May be a paid provider (Alchemy / Helius) for rate limits; a
   * mainnet URL is refused at boot (see validateConfig).
   */
  solanaRpcUrl: string;
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
  /**
   * Developer testing switch. When set, two things become possible, both
   * confined to the reserved @dev.decimal.test domain so a real account can
   * never be touched:
   *   - /auth/register creates accounts already verified (no inbox exists to
   *     read a code from) — this is what /dev-login relies on, and it is the
   *     ONLY way developer sign-in differs from a customer's;
   *   - /auth/dev/seed builds a whole test org in one call, for automated runs.
   * Leave unset in production: the reserved domain is then just a domain.
   */
  devAuthSecret: string;
  /**
   * Bench-only fake Squads chain: the whole treasury/release ceremony runs
   * against an in-memory runtime (squads/fake-chain.ts) with no real RPC and
   * no real USDC. Validation refuses it in production.
   */
  squadsFakeChain: boolean;
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
  feePayerKeypairPath: string;
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
  /**
   * Inbound invoice email. The receiving domain is a CATCH-ALL: it accepts any
   * local part with no per-address setup, and that local part (the org's
   * intakeSlug) is the only thing identifying the customer. Must be a dedicated
   * subdomain — never the domain we send from, or our own bounces and
   * auto-replies would land back in invoice intake.
   */
  inboundEmailDomain: string;
  /** Svix signing secret (whsec_…) for the Resend inbound webhook. */
  inboundEmailWebhookSecret: string;
  inboundEmailIntakeEnabled: boolean;
  inboundEmailIntakeIntervalMs: number;
  /**
   * Separate, higher bucket than the public auth limiter: a legitimate
   * Monday-morning batch of forwarded invoices must not be throttled.
   */
  inboundWebhookRateLimitMax: number;
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * The only cluster this product runs on. There is no mainnet path: no network
 * type, no env var to choose one, and a mainnet RPC URL is refused at boot.
 * Bringing mainnet back is a deliberate act, not a forgotten variable.
 */
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export const config: DecimalConfig = buildConfig();

function buildConfig(): DecimalConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const fileConfig = loadApiFileConfig();
  const solanaRpcUrl = (process.env.SOLANA_RPC_URL?.trim() || DEVNET_RPC_URL);
  const solanaAirdropRpcUrl = (process.env.SOLANA_AIRDROP_RPC_URL?.trim() || DEVNET_RPC_URL);
  const inboundEmailDomain = (process.env.INBOUND_EMAIL_DOMAIN ?? fileConfig.inboundEmailDomain ?? '')
    .trim()
    .toLowerCase();
  const nextConfig: DecimalConfig = {
    nodeEnv,
    isProduction,
    host: fileConfig.host ?? '0.0.0.0',
    port: Number(process.env.PORT) || fileConfig.port || 3100,
    publicApiUrl: normalizeOptionalUrl(fileConfig.publicApiUrl),
    publicFrontendUrl: normalizeOptionalUrl(fileConfig.publicFrontendUrl),
    solanaRpcUrl,
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
    devAuthSecret: (process.env.DEV_AUTH_SECRET ?? '').trim(),
    squadsFakeChain: (process.env.SQUADS_FAKE_CHAIN ?? '').trim().toLowerCase() === 'true',
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
    feePayerKeypairPath: (process.env.FEE_PAYER_KEYPAIR_PATH ?? process.env.DEVNET_FUNDER_KEYPAIR_PATH ?? '').trim(),
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
    inboundEmailDomain,
    inboundEmailWebhookSecret: (process.env.RESEND_INBOUND_WEBHOOK_SECRET ?? '').trim(),
    inboundEmailIntakeEnabled: getBooleanConfig(
      process.env.INBOUND_EMAIL_INTAKE_ENABLED,
      nodeEnv !== 'test' && Boolean(inboundEmailDomain),
    ),
    inboundEmailIntakeIntervalMs: Number(process.env.INBOUND_EMAIL_INTAKE_INTERVAL_MS ?? 30_000),
    inboundWebhookRateLimitMax: Number(process.env.INBOUND_WEBHOOK_RATE_LIMIT_MAX ?? 600),
  };

  validateConfig(nextConfig);
  return nextConfig;
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

  if (nextConfig.squadsFakeChain && nextConfig.isProduction) {
    throw new Error('SQUADS_FAKE_CHAIN is a test-bench flag and can never be enabled in production.');
  }

  // Devnet-only, enforced rather than assumed. Every RPC URL is checked, so a
  // stray mainnet endpoint in a .env or a deploy env stops the process instead
  // of quietly pointing real-money infrastructure at the product. A paid devnet
  // URL (solana-devnet.g.alchemy.com/…) passes; api.mainnet-beta does not.
  for (const [name, url] of [
    ['SOLANA_RPC_URL', nextConfig.solanaRpcUrl],
    ['SOLANA_AIRDROP_RPC_URL', nextConfig.solanaAirdropRpcUrl],
  ] as const) {
    if (/mainnet/i.test(url)) {
      throw new Error(`${name} points at mainnet ("${url}"). Decimal is devnet-only.`);
    }
  }

  if (nextConfig.devnetAutoFundWallets) {
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

  const hasPartialInboundEmailConfig =
    Boolean(nextConfig.inboundEmailDomain) !== Boolean(nextConfig.inboundEmailWebhookSecret);
  if (hasPartialInboundEmailConfig) {
    throw new Error('INBOUND_EMAIL_DOMAIN and RESEND_INBOUND_WEBHOOK_SECRET must be configured together.');
  }

  if (nextConfig.inboundEmailWebhookSecret && !nextConfig.inboundEmailWebhookSecret.startsWith('whsec_')) {
    throw new Error('RESEND_INBOUND_WEBHOOK_SECRET must be the Svix signing secret, starting with whsec_.');
  }

  if (nextConfig.inboundEmailDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(nextConfig.inboundEmailDomain)) {
    throw new Error('INBOUND_EMAIL_DOMAIN must be a bare hostname, e.g. bills.decimal.finance.');
  }

  // A catch-all receiving domain must never be the sending identity domain:
  // every bounce and auto-reply we send would land straight back in invoice
  // intake. Inbound belongs on its own subdomain.
  if (
    nextConfig.inboundEmailDomain
    && nextConfig.resendFromEmail.toLowerCase().endsWith(`@${nextConfig.inboundEmailDomain}`)
  ) {
    throw new Error('INBOUND_EMAIL_DOMAIN must be a dedicated receiving subdomain, not the RESEND_FROM_EMAIL domain.');
  }

  if (nextConfig.inboundEmailIntakeEnabled && !nextConfig.resendApiKey) {
    throw new Error('Inbound email intake requires RESEND_API_KEY to fetch attachment bytes.');
  }

  if (!Number.isInteger(nextConfig.inboundWebhookRateLimitMax) || nextConfig.inboundWebhookRateLimitMax < 1) {
    throw new Error('INBOUND_WEBHOOK_RATE_LIMIT_MAX must be a positive integer.');
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

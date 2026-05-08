import { ApiError } from '../infra/api-errors.js';
import { config } from '../config.js';

type PrivyWalletRuntime = {
  fetch: typeof fetch;
};

const defaultRuntime: PrivyWalletRuntime = {
  fetch: (...args) => fetch(...args),
};

let runtime: PrivyWalletRuntime = defaultRuntime;

export function setPrivyWalletRuntimeForTests(nextRuntime: Partial<PrivyWalletRuntime> | null) {
  runtime = nextRuntime ? { ...defaultRuntime, ...nextRuntime } : defaultRuntime;
}

export async function createPrivySolanaWallet(input: { userId: string; label: string }) {
  assertPrivyConfigured('Privy wallet creation is not configured. Add PRIVY_APP_ID and PRIVY_APP_SECRET to api/.env.');

  const externalId = `decimal-user-${input.userId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  const response = await runtime.fetch(`${config.privyApiBaseUrl}/v1/wallets`, {
    method: 'POST',
    headers: privyHeaders({
      'privy-idempotency-key': `user-wallet-${input.userId}`,
    }),
    body: JSON.stringify({
      chain_type: 'solana',
      external_id: externalId,
      display_name: input.label,
    }),
  });

  const payload = await response.json().catch(() => null) as PrivyWalletResponse | null;
  if (!response.ok || !payload?.id || !payload.address) {
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? 400 : 502,
      'privy_wallet_create_failed',
      extractPrivyErrorMessage(payload) ?? 'Privy could not create the wallet.',
      payload,
    );
  }

  return {
    providerWalletId: payload.id,
    address: payload.address,
    displayName: payload.display_name ?? null,
    metadata: {
      externalId: payload.external_id ?? externalId,
      chainType: payload.chain_type ?? 'solana',
      ownerId: payload.owner_id ?? null,
      createdAt: payload.created_at ?? null,
    },
  };
}

export async function signPrivySolanaTransaction(input: {
  providerWalletId: string;
  serializedTransactionBase64: string;
}) {
  assertPrivyConfigured('Privy transaction signing is not configured. Add PRIVY_APP_ID and PRIVY_APP_SECRET to api/.env.');

  const response = await runtime.fetch(`${config.privyApiBaseUrl}/v1/wallets/${encodeURIComponent(input.providerWalletId)}/rpc`, {
    method: 'POST',
    headers: privyHeaders(),
    body: JSON.stringify({
      method: 'signTransaction',
      params: {
        transaction: input.serializedTransactionBase64,
        encoding: 'base64',
      },
    }),
  });

  const payload = await response.json().catch(() => null) as PrivySignTransactionResponse | null;
  const signedTransaction = payload?.data?.signed_transaction;
  if (!response.ok || !signedTransaction) {
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? 400 : 502,
      'privy_wallet_sign_failed',
      extractPrivyErrorMessage(payload) ?? 'Privy could not sign the transaction.',
      payload,
    );
  }

  return {
    signedTransactionBase64: signedTransaction,
    encoding: payload.data?.encoding ?? 'base64',
  };
}

export async function deletePrivyWallet(input: { providerWalletId: string }) {
  assertPrivyConfigured('Privy wallet deletion is not configured. Add PRIVY_APP_ID and PRIVY_APP_SECRET to api/.env.');

  const response = await runtime.fetch(`${config.privyApiBaseUrl}/v1/wallets/${encodeURIComponent(input.providerWalletId)}`, {
    method: 'DELETE',
    headers: privyHeaders(),
  });

  if (response.ok || response.status === 404) {
    return {
      providerWalletId: input.providerWalletId,
      remoteDeleted: response.ok,
      remoteAlreadyMissing: response.status === 404,
    };
  }

  const payload = await response.json().catch(() => null) as PrivyWalletResponse | null;
  throw new ApiError(
    response.status >= 400 && response.status < 500 ? 400 : 502,
    'privy_wallet_delete_failed',
    extractPrivyErrorMessage(payload) ?? 'Privy could not delete the wallet.',
    payload,
  );
}

function assertPrivyConfigured(message: string) {
  if (!config.privyAppId || !config.privyAppSecret) {
    throw new ApiError(501, 'provider_not_configured', message);
  }
}

function privyHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Basic ${Buffer.from(`${config.privyAppId}:${config.privyAppSecret}`).toString('base64')}`,
    'content-type': 'application/json',
    'privy-app-id': config.privyAppId,
    ...extra,
  };
}

type PrivyWalletResponse = {
  id?: string;
  address?: string;
  display_name?: string | null;
  external_id?: string | null;
  chain_type?: string;
  owner_id?: string | null;
  created_at?: number;
  error?: string;
  message?: string;
};

type PrivySignTransactionResponse = {
  method?: string;
  data?: {
    signed_transaction?: string;
    encoding?: 'base64';
  };
  error?: string;
  message?: string;
};

function extractPrivyErrorMessage(payload: (PrivyWalletResponse | PrivySignTransactionResponse) | null) {
  return payload?.message ?? payload?.error ?? null;
}

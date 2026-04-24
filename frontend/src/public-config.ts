import frontendPublicConfig from '../../config/frontend.public.json';

type PublicConfig = {
  apiBaseUrl: string;
  solanaRpcUrl: string;
};

const config = frontendPublicConfig as PublicConfig;

export function getPublicApiBaseUrl() {
  const value = String(config.apiBaseUrl ?? '').trim();
  if (!value) {
    throw new Error('config/frontend.public.json must define apiBaseUrl.');
  }
  return value.replace(/\/+$/, '');
}

export function getPublicSolanaRpcUrl() {
  const value = String(config.solanaRpcUrl ?? '').trim();
  if (!value) {
    return 'https://api.mainnet-beta.solana.com';
  }
  return value;
}

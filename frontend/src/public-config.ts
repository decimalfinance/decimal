// Lives inside frontend/src/ so Vercel (project root = frontend/) can
// resolve it during build. Keep this in sync with the repo-root
// config/frontend.public.json that other entry points read.
import frontendPublicConfig from './public-config.json';
import { getRuntimeSolanaRpcUrl } from './solana-network';

type PublicConfig = {
  apiBaseUrl: string;
  localApiBaseUrl?: string;
  solanaRpcUrl: string;
};

const config = frontendPublicConfig as PublicConfig;

export function getPublicApiBaseUrl() {
  const value = shouldUseLocalApiBaseUrl()
    ? String(config.localApiBaseUrl ?? '').trim()
    : String(config.apiBaseUrl ?? '').trim();
  if (!value) {
    throw new Error('config/frontend.public.json must define apiBaseUrl.');
  }
  return value.replace(/\/+$/, '');
}

export function getPublicSolanaRpcUrl() {
  const runtimeValue = getRuntimeSolanaRpcUrl().trim();
  if (runtimeValue) {
    return runtimeValue;
  }

  const value = String(config.solanaRpcUrl ?? '').trim();
  if (!value) {
    return 'https://api.mainnet-beta.solana.com';
  }
  return value;
}

function shouldUseLocalApiBaseUrl() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

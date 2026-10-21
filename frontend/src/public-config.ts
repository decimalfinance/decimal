// Lives inside frontend/src/ so Vercel (project root = frontend/) can resolve
// it during build.
//
// No RPC URL here: every client-side Solana call goes through the backend
// proxy (POST /solana/rpc, see lib/solana-wallet.ts), which is what keeps the
// backend's RPC key out of the browser.
import frontendPublicConfig from './public-config.json';

type PublicConfig = {
  apiBaseUrl: string;
  localApiBaseUrl?: string;
};

const config = frontendPublicConfig as PublicConfig;

export function getPublicApiBaseUrl() {
  // The bench (scripts/bench.sh) sets this so its own frontend on :5274 talks
  // to its own API on :3200. Without it the bench UI would call :3100 — your
  // stack, your data.
  const override = String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
  if (override) {
    return override.replace(/\/+$/, '');
  }

  const value = shouldUseLocalApiBaseUrl()
    ? String(config.localApiBaseUrl ?? '').trim()
    : String(config.apiBaseUrl ?? '').trim();
  if (!value) {
    throw new Error('frontend/src/public-config.json must define apiBaseUrl.');
  }
  return value.replace(/\/+$/, '');
}

function shouldUseLocalApiBaseUrl() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

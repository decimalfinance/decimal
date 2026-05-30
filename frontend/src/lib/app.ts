import type { SolanaNetwork } from '../solana-network';
import { getRuntimeSolanaNetwork } from '../solana-network';
import type { TreasuryWallet } from '../types';

export function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// USD display. Rounds to cents and uses grouped thousands. Return without a
// currency symbol so callers compose (e.g. `$${formatUsd(v)}`).
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// USDC-only USD value (SOL pricing was dropped — backend no longer publishes
// a price, so we'd be multiplying by zero). USDC is 6 decimals.
export function computeWalletUsdValue(args: { usdcRaw: string | null }): number {
  return args.usdcRaw === null ? 0 : Number(BigInt(args.usdcRaw)) / 1_000_000;
}

export function formatRawUsdcCompact(amountRaw: string) {
  const normalized = formatRawUsdc(amountRaw);
  if (!normalized.includes('.')) {
    return normalized;
  }

  const [whole, fraction] = normalized.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction.length ? `${whole}.${trimmedFraction}` : whole;
}

export function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimestampCompact(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absMs < minute) {
    return formatter.format(Math.round(diffMs / 1000), 'second');
  }
  if (absMs < hour) {
    return formatter.format(Math.round(diffMs / minute), 'minute');
  }
  if (absMs < day) {
    return formatter.format(Math.round(diffMs / hour), 'hour');
  }

  return formatter.format(Math.round(diffMs / day), 'day');
}

export function shortenAddress(value: string | null | undefined, prefix = 6, suffix = 6) {
  if (!value) {
    return 'Unknown';
  }

  if (value.length <= prefix + suffix + 1) {
    return value;
  }

  // Use the single ellipsis glyph (U+2026) rather than three literal
  // periods — three dots crowd next to mono characters at small sizes
  // (Geist Mono renders the trailing "." as if it joined the next
  // letter, making "B1E4...jbUA" read as "B1E4. jbUA"). Matches the
  // copy-chip + design's xxxx…yyyy convention.
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

export function orbTransactionUrl(signature: string) {
  return explorerTransactionUrl(signature, getRuntimeSolanaNetwork());
}

export function orbAccountUrl(address: string) {
  return explorerAccountUrl(address, getRuntimeSolanaNetwork());
}

export function solanaAccountUrl(address: string) {
  return explorerAccountUrl(address, getRuntimeSolanaNetwork());
}

// Solscan supports both mainnet and devnet via the `?cluster=devnet` query
// param. Orb (orbmarkets.io) was nicer for mainnet but doesn't render devnet
// state, which made every link broken in dev. Single explorer for both
// clusters now.
export function explorerTransactionUrl(signature: string, network: SolanaNetwork) {
  const cluster = network === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${signature}${cluster}`;
}

export function explorerAccountUrl(address: string, network: SolanaNetwork) {
  const cluster = network === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/account/${address}${cluster}`;
}

// Page-level helpers. App.tsx has its own variants with different fallback
// semantics (no "USDC" default, nullable address inputs). Keeping these
// separate so we don't change App.tsx behaviour by mistake.

export function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

export function walletLabel(address: TreasuryWallet): string {
  if (address.displayName && address.displayName.trim().length) {
    return `${address.displayName} · ${shortenAddress(address.address, 4, 4)}`;
  }
  return shortenAddress(address.address, 4, 4);
}

// Trigger a download of `data` as `${filename}` in the user's browser.
// Used by proof-export buttons across detail pages.
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

import type { SolanaNetwork } from '../solana-network';
import { getRuntimeSolanaNetwork } from '../solana-network';

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

// Total USD value of one wallet: USDC (6 decimals) + SOL (9 decimals) × price.
// If the SOL price is null we only count USDC — callers may separately show
// "SOL price unavailable" context.
export function computeWalletUsdValue(args: {
  usdcRaw: string | null;
  solLamports: string;
  solUsdPrice: number | null;
}): number {
  const usdc = args.usdcRaw === null ? 0 : Number(BigInt(args.usdcRaw)) / 1_000_000;
  let solLamportsNum = 0;
  try {
    solLamportsNum = Number(BigInt(args.solLamports));
  } catch {
    solLamportsNum = 0;
  }
  const sol = solLamportsNum / 1_000_000_000;
  const solUsd = args.solUsdPrice === null ? 0 : sol * args.solUsdPrice;
  return usdc + solUsd;
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

  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
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

export function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
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
  return `https://orbmarkets.io/tx/${signature}?tab=summary`;
}

export function solanaAccountUrl(address: string) {
  return `https://explorer.solana.com/address/${address}`;
}

export function formatIsoDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

export function formatUsdcAmount(amountRaw: bigint | string | number | null | undefined) {
  if (amountRaw === null || amountRaw === undefined) {
    return null;
  }
  const raw = typeof amountRaw === 'bigint' ? amountRaw.toString() : String(amountRaw);
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

export function formatRawUsdcDecimal(amountRaw: bigint | string | number | null | undefined) {
  const formatted = formatUsdcAmount(amountRaw);
  return formatted ? formatted.replace(/ USDC$/, '') : null;
}

export function shortenAddress(value: string | null | undefined, head = 8, tail = 8) {
  if (!value) {
    return '';
  }
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function normalizeLimit(value: unknown, options: { defaultLimit: number; maxLimit: number }) {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return options.defaultLimit;
  }
  return Math.min(parsed, options.maxLimit);
}

export function listResponse<T>(items: T[], meta?: Record<string, unknown>) {
  return {
    servedAt: new Date().toISOString(),
    count: items.length,
    items,
    ...(meta ?? {}),
  };
}

// Svix webhook signature verification (Resend signs inbound events with it).
//
// Hand-rolled rather than pulling in the `svix` package: the API has six
// runtime dependencies, and this repo already hand-rolls the same HMAC-SHA256 +
// timingSafeEqual primitive twice (routes/accounting.ts signState/verifyState,
// routes/auth.ts requireDevSecret). Adding a dependency for ~40 lines of
// standard-library crypto is the wrong trade. If Svix ever changes the scheme,
// swapping the package in behind `verifySvixSignature` is a one-file change.
//
// The scheme (Standard Webhooks): HMAC-SHA256 over `${id}.${timestamp}.${body}`
// keyed by the base64 secret, compared against any `v1,<base64>` entry in the
// signature header. Signed over the RAW request bytes — a re-serialized JSON
// body will not verify, which is why the route mounts express.raw().
import crypto from 'node:crypto';

export type SvixVerificationFailure =
  | 'missing_headers'
  | 'bad_secret'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'no_match';

export type SvixVerificationResult = { ok: true } | { ok: false; reason: SvixVerificationFailure };

/**
 * How far the signed timestamp may drift from now. Bounds the window in which a
 * captured request can be replayed; 5 minutes is Svix's own default and leaves
 * room for ordinary clock skew.
 */
const DEFAULT_TOLERANCE_SECONDS = 300;

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, ...names: string[]): string | null {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single.length > 0) return single;
  }
  return null;
}

export function verifySvixSignature(args: {
  rawBody: Buffer;
  headers: HeaderBag;
  /** The endpoint's signing secret, `whsec_<base64>`. */
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): SvixVerificationResult {
  // Svix sends `svix-*`; the Standard Webhooks spec it seeded uses `webhook-*`.
  // Which one arrives depends on the integration, so accept either.
  const id = header(args.headers, 'svix-id', 'webhook-id');
  const timestamp = header(args.headers, 'svix-timestamp', 'webhook-timestamp');
  const signature = header(args.headers, 'svix-signature', 'webhook-signature');
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - sentAt) > tolerance) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  let key: Buffer;
  try {
    key = Buffer.from(args.secret.replace(/^whsec_/, ''), 'base64');
    if (key.length === 0) return { ok: false, reason: 'bad_secret' };
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }

  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, 'utf8'),
    args.rawBody,
  ]);
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest();

  // The header carries a space-separated list so a secret can be rotated with
  // both signatures live; any one matching is a pass.
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    const version = entry.slice(0, comma);
    if (version !== 'v1') continue;

    let candidate: Buffer;
    try {
      candidate = Buffer.from(entry.slice(comma + 1), 'base64');
    } catch {
      continue;
    }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'no_match' };
}

/**
 * Produce a valid signature header set for a payload. Exists so tests can sign
 * a request the way Resend would; it is not used by the running server.
 */
export function signSvixPayloadForTests(args: {
  rawBody: Buffer;
  secret: string;
  id: string;
  timestampSeconds: number;
}): Record<string, string> {
  const key = Buffer.from(args.secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = Buffer.concat([
    Buffer.from(`${args.id}.${args.timestampSeconds}.`, 'utf8'),
    args.rawBody,
  ]);
  const signature = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
  return {
    'svix-id': args.id,
    'svix-timestamp': String(args.timestampSeconds),
    'svix-signature': `v1,${signature}`,
  };
}

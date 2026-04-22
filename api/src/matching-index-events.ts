import type { Response } from 'express';

type MatchingIndexEvent = {
  version: number;
  reason: string;
  changedAt: string;
};

let matchingIndexVersion = 1;
const subscribers = new Set<Response>();

export function getMatchingIndexVersion() {
  return matchingIndexVersion;
}

export function notifyMatchingIndexChanged(reason: string) {
  matchingIndexVersion += 1;
  const event: MatchingIndexEvent = {
    version: matchingIndexVersion,
    reason,
    changedAt: new Date().toISOString(),
  };

  for (const subscriber of subscribers) {
    subscriber.write(`event: matching_index_changed\n`);
    subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  return event;
}

export function subscribeToMatchingIndexChanges(res: Response) {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  subscribers.add(res);
  res.write(`event: matching_index_snapshot\n`);
  res.write(
    `data: ${JSON.stringify({
      version: matchingIndexVersion,
      reason: 'initial_snapshot',
      changedAt: new Date().toISOString(),
    } satisfies MatchingIndexEvent)}\n\n`,
  );

  const heartbeat = setInterval(() => {
    res.write(`: keepalive ${new Date().toISOString()}\n\n`);
  }, 25_000);

  return () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  };
}

export function shouldInvalidateMatchingIndex(method: string, path: string) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    return false;
  }

  if (path.startsWith('/internal/')) {
    return false;
  }

  return [
    /\/organizations(?:\/|$)/,
    /\/workspaces\/[^/]+\/treasury-wallets(?:\/|$)/,
    /\/workspaces\/[^/]+\/destinations(?:\/|$)/,
    /\/workspaces\/[^/]+\/collection-sources(?:\/|$)/,
    /\/workspaces\/[^/]+\/payment-orders(?:\/|$)/,
    /\/workspaces\/[^/]+\/payment-requests(?:\/|$)/,
    /\/workspaces\/[^/]+\/payment-runs(?:\/|$)/,
    /\/workspaces\/[^/]+\/collections(?:\/|$)/,
    /\/workspaces\/[^/]+\/collection-runs(?:\/|$)/,
    /\/workspaces\/[^/]+\/transfer-requests(?:\/|$)/,
    /\/workspaces\/[^/]+\/executions(?:\/|$)/,
    /\/workspaces\/[^/]+\/approvals(?:\/|$)/,
  ].some((pattern) => pattern.test(path));
}

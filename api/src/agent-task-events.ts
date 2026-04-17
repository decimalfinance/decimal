import type { Response } from 'express';

type AgentTaskEvent = {
  version: number;
  workspaceId: string | null;
  reason: string;
  changedAt: string;
};

let agentTaskVersion = 1;
const subscribers = new Map<string, Set<Response>>();

export function notifyAgentTasksChanged(reason: string, workspaceId: string | null) {
  agentTaskVersion += 1;
  const event: AgentTaskEvent = {
    version: agentTaskVersion,
    workspaceId,
    reason,
    changedAt: new Date().toISOString(),
  };

  const targets = workspaceId
    ? [subscribers.get(workspaceId)]
    : [...subscribers.values()];

  for (const bucket of targets) {
    for (const subscriber of bucket ?? []) {
      writeAgentTaskEvent(subscriber, 'agent_tasks_changed', event);
    }
  }

  return event;
}

export function subscribeToAgentTaskChanges(workspaceId: string, res: Response) {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const bucket = subscribers.get(workspaceId) ?? new Set<Response>();
  bucket.add(res);
  subscribers.set(workspaceId, bucket);

  writeAgentTaskEvent(res, 'agent_tasks_snapshot', {
    version: agentTaskVersion,
    workspaceId,
    reason: 'initial_snapshot',
    changedAt: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    res.write(`: keepalive ${new Date().toISOString()}\n\n`);
  }, 25_000);

  return () => {
    clearInterval(heartbeat);
    bucket.delete(res);
    if (!bucket.size) {
      subscribers.delete(workspaceId);
    }
  };
}

function writeAgentTaskEvent(res: Response, eventName: string, event: AgentTaskEvent) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

import { EventEmitter } from 'node:events';

// Live change notifications, broadcast to any SSE client streaming an org's
// events. The API runs as a single process, so an in-process EventEmitter is
// all we need — no Redis/Postgres NOTIFY. If the API ever scales to multiple
// instances, swap the emitter for Postgres LISTEN/NOTIFY behind this same API.

export type OrgEvent = {
  type: 'proposal.updated';
  decimalProposalId: string;
};

const emitter = new EventEmitter();
// Each connected client adds a listener; a busy org can have many open tabs.
// Lift the default 10-listener cap so Node doesn't log a false "leak" warning.
emitter.setMaxListeners(0);

function channelFor(organizationId: string): string {
  return `org:${organizationId}`;
}

/** Broadcast a change to every client streaming this organization's events. */
export function publishOrgEvent(organizationId: string, event: OrgEvent): void {
  emitter.emit(channelFor(organizationId), event);
}

/** Subscribe to an organization's events. Returns an unsubscribe function. */
export function subscribeOrgEvents(
  organizationId: string,
  listener: (event: OrgEvent) => void,
): () => void {
  const channel = channelFor(organizationId);
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { getPublicApiBaseUrl } from '../public-config';

// Subscribe to the API's Server-Sent Events stream for one organization and
// invalidate the affected TanStack queries the instant something changes, so a
// co-signer's screen reflects a new approval/execution without polling or a
// manual refresh.
//
// We read the stream with fetch (not native EventSource) so we can send the
// Bearer token in a header and keep it out of the URL. The connection
// auto-reconnects with a short backoff if it drops.

type LiveOrgEvent = { type: string; decimalProposalId?: string };

const RECONNECT_DELAY_MS = 3_000;

export function useLiveOrgEvents(organizationId: string | null | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!organizationId) return;
    const token = api.getSessionToken();
    if (!token) return;

    const baseUrl = getPublicApiBaseUrl();
    const controller = new AbortController();
    let stopped = false;

    const handle = (event: LiveOrgEvent) => {
      if (event.type === 'proposal.updated') {
        // Prefix invalidation: covers the open proposal detail, the proposals
        // list, the inbox "needs approval" column, and treasury balances.
        queryClient.invalidateQueries({ queryKey: ['organization-proposal', organizationId] });
        queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
        queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
        queryClient.invalidateQueries({ queryKey: ['treasury-wallet-detail', organizationId] });
      }
    };

    const run = async () => {
      while (!stopped) {
        try {
          const response = await fetch(`${baseUrl}/organizations/${organizationId}/events`, {
            headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`events ${response.status}`);

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');
              if (!data) continue; // heartbeat or comment frame
              try {
                handle(JSON.parse(data) as LiveOrgEvent);
              } catch {
                /* ignore a malformed frame */
              }
            }
          }
        } catch {
          if (stopped || controller.signal.aborted) return;
        }
        if (stopped) return;
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      }
    };

    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [organizationId, queryClient]);
}

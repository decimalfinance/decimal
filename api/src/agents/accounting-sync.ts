// Background GL-sync agent. The counterpart to the settlement reconciler: once a
// payment is `settled` on-chain, this sweep posts it to the org's connected
// accounting system (QuickBooks). Decoupled from the many places that set
// `settled`, naturally idempotent, and retries failures — the same self-healing
// pattern as the settlement reconciler.

import { config } from '../config.js';
import { errorToLogFields, logger } from '../infra/logger.js';
import { sweepUnsyncedSettledOrders } from '../accounting/account-sync.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the GL-sync loop. Returns a stop function. No-op when disabled by config
 * (e.g. no QuickBooks keys configured, or in tests). Ticks never overlap.
 */
export function startAccountingSync(): () => void {
  if (!config.accountingSyncEnabled) {
    logger.info('accounting_sync.disabled');
    return () => {};
  }
  const intervalMs = Math.max(5_000, config.accountingSyncIntervalMs);
  logger.info('accounting_sync.started', { intervalMs, environment: config.quickbooksEnvironment });

  timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void sweepUnsyncedSettledOrders()
      .then((summary) => {
        if (summary.synced || summary.error) {
          logger.info('accounting_sync.tick', summary);
        }
      })
      .catch((error) => {
        logger.warn('accounting_sync.tick_failed', errorToLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

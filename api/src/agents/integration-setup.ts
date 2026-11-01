// Setup turns run in the background of whichever process took the message. This
// sweep is the guarantee behind that: a setup left owing a turn by a restart, with
// nobody holding it, gets woken. Ticks never overlap.

import { errorToLogFields, logger } from '../infra/logger.js';
import { sweepSetups } from '../integrations/setup/harness.js';

const INTERVAL_MS = 30_000;

export function startIntegrationSetupSweep(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepSetups()
      .catch((error) => logger.warn('integration_setup.sweep_failed', errorToLogFields(error)))
      .finally(() => { running = false; });
  }, INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

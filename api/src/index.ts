import { config } from './config.js';
import { prisma } from './infra/prisma.js';
import { createApp } from './app.js';
import { USDC_MINT } from './solana.js';
import { startSettlementReconciler } from './agents/settlement-reconciler.js';
import { startAccountingSync } from './agents/accounting-sync.js';
import { registerPaymentApprovalBridge } from './payments/approval-bridge.js';
import { sweepTimers } from './approvals/lifecycle.js';
import { errorToLogFields, logger } from './infra/logger.js';

// Overdue approval tasks escalate to the primary admin (never auto-deny).
const APPROVAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
function startApprovalTimerSweep(): () => void {
  const tick = async () => {
    try {
      const { escalated } = await sweepTimers();
      if (escalated > 0) logger.info('approval_sweep.escalated', { escalated });
    } catch (error) {
      logger.warn('approval_sweep.failed', errorToLogFields(error));
    }
  };
  void tick();
  const interval = setInterval(tick, APPROVAL_SWEEP_INTERVAL_MS);
  return () => clearInterval(interval);
}

async function main() {
  await prisma.$connect();
  // Bench-only: simulate the Squads chain in memory (config validation
  // refuses this flag in production).
  if (config.squadsFakeChain) {
    const { installFakeSquadsChain } = await import('./squads/fake-chain.js');
    installFakeSquadsChain();
  }
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    logger.info('api.started', {
      host: config.host,
      port: config.port,
      solanaNetwork: config.solanaNetwork,
      solanaRpcUrl: config.solanaRpcUrl,
      usdcMint: USDC_MINT.toBase58(),
      logLevel: config.logLevel,
    });
  });

  registerPaymentApprovalBridge();
  const stopSettlementReconciler = startSettlementReconciler();
  const stopAccountingSync = startAccountingSync();
  const stopApprovalSweep = startApprovalTimerSweep();

  const shutdown = async () => {
    logger.info('api.shutdown.started');
    stopSettlementReconciler();
    stopAccountingSync();
    stopApprovalSweep();
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('api.shutdown.completed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  logger.error('api.startup.failed', errorToLogFields(error));
  await prisma.$disconnect();
  process.exit(1);
});

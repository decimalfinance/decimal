import { config } from './config.js';
import { prisma } from './infra/prisma.js';
import { createApp } from './app.js';
import { USDC_MINT } from './solana.js';
import { startSettlementReconciler } from './agents/settlement-reconciler.js';
import { errorToLogFields, logger } from './infra/logger.js';

async function main() {
  await prisma.$connect();
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

  const stopSettlementReconciler = startSettlementReconciler();

  const shutdown = async () => {
    logger.info('api.shutdown.started');
    stopSettlementReconciler();
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
